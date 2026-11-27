// A reader for Xbox 360 executables (XEX2, the format of a game's default.xex), written for PlayOut from the format's
// public description: the headers, the title id, and the image (decrypted with the publicly known retail key, as the
// Xenia emulator publishes it, and unpacked from its basic or LZX compression), so the game's own achievement table
// (its XDBF resource) can be read. Only aes-128-cbc is used: Electron's BoringSSL has it.
import { createDecipheriv } from 'node:crypto'
import { lzxSteps, runAsync, runSync, type Steps } from './lzx'

/** The publicly known XEX2 retail key (docs/LICENSES.md "Xbox 360 executable key"). */
export const XEX_RETAIL_KEY = Buffer.from('20B185A59D28FDC340583FBB0896BF91', 'hex')
/** Development kit executables use an all-zero key. */
const XEX_DEVKIT_KEY = Buffer.alloc(16)

const MAGIC_XEX2 = 0x58455832
export const XEX_HEADER = {
  fileFormat: 0x000003ff,
  resourceInfo: 0x000002ff,
  executionInfo: 0x00040006,
  imageBase: 0x00010201
} as const
/** Images bigger than this are not unpacked (a game's executable is tens of megabytes at most). */
const MAX_IMAGE = 128 * 1024 * 1024
/**
 * An LZX image may be at most this many times its compressed stream (plus a megabyte): executables shrink to a third or
 * so; a stream claiming far more is a decompression bomb.
 */
const MAX_LZX_RATIO = 64

export class XexError extends Error {}

export interface XexResource {
  name: string
  address: number
  size: number
}

export interface XexHeaders {
  /** Offset of the image data in the file. */
  dataOffset: number
  securityOffset: number
  /** Optional header key -> its inline value, or the offset of its data. */
  headers: Map<number, number>
  titleId: string | null
  imageBase: number
  imageSize: number
  /** 0 none, 1 encrypted. */
  encryption: number
  /** 0 none, 1 basic (zero runs), 2 LZX, 3 delta patch. */
  compression: number
  resources: XexResource[]
}

/** The headers of an XEX2 file; throws XexError when it is not one. */
export function readXexHeaders(buf: Buffer): XexHeaders {
  if (buf.length < 0x18 || buf.readUInt32BE(0) !== MAGIC_XEX2)
    throw new XexError('not an XEX2 file')
  const dataOffset = buf.readUInt32BE(0x08)
  const securityOffset = buf.readUInt32BE(0x10)
  const count = buf.readUInt32BE(0x14)
  if (count > 1024 || 0x18 + count * 8 > buf.length) throw new XexError('bad header count')
  if (securityOffset + 0x180 > buf.length || dataOffset > buf.length)
    throw new XexError('truncated header')
  const headers = new Map<number, number>()
  for (let i = 0; i < count; i++) {
    const at = 0x18 + i * 8
    headers.set(buf.readUInt32BE(at), buf.readUInt32BE(at + 4))
  }
  const dataAt = (key: number, size: number): number | null => {
    const v = headers.get(key)
    return v !== undefined && v + size <= buf.length ? v : null
  }
  const exec = dataAt(XEX_HEADER.executionInfo, 0x18)
  const titleNum = exec !== null ? buf.readUInt32BE(exec + 0x0c) : 0
  const imageBase = headers.get(XEX_HEADER.imageBase) ?? buf.readUInt32BE(securityOffset + 0x110)
  const imageSize = buf.readUInt32BE(securityOffset + 0x04)
  const format = dataAt(XEX_HEADER.fileFormat, 8)
  const resources: XexResource[] = []
  const res = dataAt(XEX_HEADER.resourceInfo, 4)
  if (res !== null) {
    const size = buf.readUInt32BE(res)
    for (let at = res + 4; at + 16 <= res + size && at + 16 <= buf.length; at += 16) {
      resources.push({
        name: buf.toString('latin1', at, at + 8).replace(/\0+$/, ''),
        address: buf.readUInt32BE(at + 8),
        size: buf.readUInt32BE(at + 12)
      })
    }
  }
  return {
    dataOffset,
    securityOffset,
    headers,
    titleId: titleNum ? titleNum.toString(16).toUpperCase().padStart(8, '0') : null,
    imageBase,
    imageSize,
    encryption: format !== null ? buf.readUInt16BE(format + 4) : 0,
    compression: format !== null ? buf.readUInt16BE(format + 6) : 0,
    resources
  }
}

/** Bytes decrypted per step. */
const AES_STEP = 4 * 1024 * 1024

/** AES-128-CBC with a zero IV, no padding (whole 16-byte blocks only), a few megabytes per step. */
function* aesCbcDecrypt(key: Buffer, data: Buffer): Steps<Buffer> {
  const whole = data.length - (data.length % 16)
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16))
  decipher.setAutoPadding(false)
  const parts: Buffer[] = []
  for (let at = 0; at < whole; at += AES_STEP) {
    parts.push(decipher.update(data.subarray(at, Math.min(at + AES_STEP, whole))))
    yield
  }
  parts.push(decipher.final())
  if (whole !== data.length) parts.push(data.subarray(whole))
  return Buffer.concat(parts)
}

/** The image from the file's data (already decrypted). */
function* unpack(buf: Buffer, h: XexHeaders, data: Buffer): Steps<Buffer> {
  if (h.imageSize <= 0 || h.imageSize > MAX_IMAGE) throw new XexError('bad image size')
  const format = h.headers.get(XEX_HEADER.fileFormat)!
  if (h.compression === 0) {
    const image = Buffer.alloc(h.imageSize)
    data.copy(image, 0, 0, Math.min(data.length, h.imageSize))
    return image
  }
  if (h.compression === 1) {
    // Basic: runs of data, each followed by a run of zeros.
    const infoSize = buf.readUInt32BE(format)
    const image = Buffer.alloc(h.imageSize)
    let src = 0
    let dst = 0
    for (let at = format + 8; at + 8 <= format + infoSize; at += 8) {
      const dataSize = buf.readUInt32BE(at)
      const zeroSize = buf.readUInt32BE(at + 4)
      if (src + dataSize > data.length || dst + dataSize + zeroSize > h.imageSize)
        throw new XexError('bad basic block')
      data.copy(image, dst, src, src + dataSize)
      src += dataSize
      dst += dataSize + zeroSize
    }
    return image
  }
  if (h.compression === 2) {
    // LZX: a chain of blocks (each names the next one's size), each a list of length-prefixed chunks of one stream.
    const windowSize = buf.readUInt32BE(format + 8)
    const windowBits = Math.log2(windowSize)
    if (!Number.isInteger(windowBits)) throw new XexError('bad LZX window')
    let blockSize = buf.readUInt32BE(format + 12)
    const chunks: Buffer[] = []
    let p = 0
    while (blockSize) {
      if (p + blockSize > data.length || blockSize < 24) throw new XexError('bad LZX block')
      const next = p + blockSize
      const nextSize = data.readUInt32BE(p)
      let q = p + 24
      for (;;) {
        if (q + 2 > next) throw new XexError('bad LZX chunk')
        const size = data.readUInt16BE(q)
        q += 2
        if (!size) break
        if (q + size > next) throw new XexError('bad LZX chunk')
        chunks.push(data.subarray(q, q + size))
        q += size
      }
      p = next
      blockSize = nextSize
    }
    const stream = Buffer.concat(chunks)
    // A stream that claims far more than real executables unpack to is refused before anything is decoded.
    if (h.imageSize > stream.length * MAX_LZX_RATIO + 1024 * 1024)
      throw new XexError('image too big for its compressed data')
    return yield* lzxSteps(stream, h.imageSize, windowBits)
  }
  throw new XexError('delta-compressed executables are not supported')
}

/** The decrypted, unpacked image (a PE file: it starts with "MZ"), in steps. */
function* imageSteps(buf: Buffer, h: XexHeaders): Steps<Buffer> {
  const raw = buf.subarray(h.dataOffset)
  if (h.encryption === 0) return yield* unpack(buf, h, raw)
  if (h.encryption !== 1) throw new XexError('unknown encryption')
  const fileKey = buf.subarray(h.securityOffset + 0x150, h.securityOffset + 0x160)
  let last: unknown = null
  for (const key of [XEX_RETAIL_KEY, XEX_DEVKIT_KEY]) {
    try {
      const session = runSync(aesCbcDecrypt(key, fileKey))
      const plain = yield* aesCbcDecrypt(session, raw)
      const image = yield* unpack(buf, h, plain)
      if (image.length >= 2 && image[0] === 0x4d && image[1] === 0x5a) return image
    } catch (err) {
      last = err
    }
  }
  throw last instanceof XexError ? last : new XexError('the image could not be decrypted')
}

/** The decrypted, unpacked image (a PE file: it starts with "MZ"). Throws XexError when it cannot be read. */
export function xexImage(buf: Buffer, h: XexHeaders = readXexHeaders(buf)): Buffer {
  return runSync(imageSteps(buf, h))
}

/** The game's title id and its XDBF block (achievements), from its executable. */
export interface XexTitleData {
  titleId: string | null
  xdbf: Buffer | null
}

function* titleDataSteps(buf: Buffer): Steps<XexTitleData> {
  const h = readXexHeaders(buf)
  // The title's XDBF resource is named after its title id; any resource that is an XDBF block will do.
  const candidates = [...h.resources].sort(
    (a, b) =>
      Number(b.name.toUpperCase() === h.titleId) - Number(a.name.toUpperCase() === h.titleId)
  )
  if (!candidates.length) return { titleId: h.titleId, xdbf: null }
  const image = yield* imageSteps(buf, h)
  for (const r of candidates) {
    const start = r.address - h.imageBase
    if (start < 0 || start + r.size > image.length || r.size < 4) continue
    const data = image.subarray(start, start + r.size)
    if (data.readUInt32BE(0) === 0x58444246) return { titleId: h.titleId, xdbf: Buffer.from(data) }
  }
  return { titleId: h.titleId, xdbf: null }
}

/** The game's title id and its XDBF block (achievements), from its executable, at once. */
export function readXexTitleData(buf: Buffer): XexTitleData {
  return runSync(titleDataSteps(buf))
}

/**
 * readXexTitleData for the main process: the decryption and decompression give the event loop a turn every few
 * megabytes, so reading a game's executable never holds up the windows, the overlay or IPC.
 */
export function readXexTitleDataAsync(buf: Buffer): Promise<XexTitleData> {
  return runAsync(titleDataSteps(buf))
}
