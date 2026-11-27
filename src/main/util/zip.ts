import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { dirname, join, normalize, sep } from 'path'
import { Transform, type TransformCallback } from 'stream'
import { pipeline } from 'stream/promises'
import { createInflateRaw, inflateRawSync } from 'zlib'

/**
 * A minimal zip reader (no dependency): the central directory, one entry read into memory, entries extracted to disk.
 * Stored and deflated entries, optionally with traditional PKWARE encryption (ZipCrypto: the Nucleus Co-op release is
 * password-protected); no zip64, AES or spanning (Nucleus handler packages and the Nucleus release are under 4 GB).
 */

export interface ZipEntry {
  /** The entry's path in the zip, '/'-separated as stored. Folders end with '/'. */
  name: string
  /** 0 = stored, 8 = deflate. */
  method: number
  compressedSize: number
  size: number
  /** Where the entry's local header starts. */
  localOffset: number
  /** General purpose flags (bit 0: encrypted; bit 3: sizes and CRC after the data). */
  flags: number
  crc: number
  /** DOS modification time (ZipCrypto's check byte when bit 3 is set). */
  modTime: number
}

/** Extraction options: the zip's password when its entries are encrypted. */
export interface ZipOptions {
  password?: string
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/** Every entry of the zip at `path`, in directory order. Throws when it is not a usable zip. */
export async function listZip(path: string): Promise<ZipEntry[]> {
  const handle = await fs.open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const tailSize = Math.min(size, 0xffff + 22)
    const tail = Buffer.alloc(tailSize)
    await handle.read(tail, 0, tailSize, size - tailSize)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i
        break
      }
    if (eocd < 0) throw new Error('not a zip file')
    const count = tail.readUInt16LE(eocd + 10)
    const dirSize = tail.readUInt32LE(eocd + 12)
    const dirOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || dirOffset === 0xffffffff || dirOffset + dirSize > size)
      throw new Error('zip64 or damaged zip directory')
    const dir = Buffer.alloc(dirSize)
    await handle.read(dir, 0, dirSize, dirOffset)
    const out: ZipEntry[] = []
    let at = 0
    for (let n = 0; n < count && at + 46 <= dir.length; n++) {
      if (dir.readUInt32LE(at) !== CENTRAL) throw new Error('bad zip directory')
      const flags = dir.readUInt16LE(at + 8)
      const nameLength = dir.readUInt16LE(at + 28)
      const extraLength = dir.readUInt16LE(at + 30)
      const commentLength = dir.readUInt16LE(at + 32)
      const raw = dir.subarray(at + 46, at + 46 + nameLength)
      // Bit 11: UTF-8 names; otherwise CP437, whose ASCII range is all handler packages use.
      const name = (flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')).replace(
        /\\/g,
        '/'
      )
      out.push({
        name,
        flags,
        crc: dir.readUInt32LE(at + 16),
        modTime: dir.readUInt16LE(at + 12),
        method: dir.readUInt16LE(at + 10),
        compressedSize: dir.readUInt32LE(at + 20),
        size: dir.readUInt32LE(at + 24),
        localOffset: dir.readUInt32LE(at + 42)
      })
      at += 46 + nameLength + extraLength + commentLength
    }
    return out
  } finally {
    await handle.close()
  }
}

/** Where an entry's data starts (after its local header). */
async function dataOffset(path: string, entry: ZipEntry): Promise<number> {
  const handle = await fs.open(path, 'r')
  try {
    const local = Buffer.alloc(30)
    await handle.read(local, 0, 30, entry.localOffset)
    if (local.readUInt32LE(0) !== LOCAL) throw new Error(`bad zip entry ${entry.name}`)
    return entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  } finally {
    await handle.close()
  }
}

function checkMethod(entry: ZipEntry, options: ZipOptions): void {
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`unsupported zip method ${entry.method} (${entry.name})`)
  if (entry.flags & 1 && options.password === undefined)
    throw new Error(`${entry.name} is encrypted and no password was given`)
}

// ---- ZipCrypto (APPNOTE.TXT 6.1) -----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crcByte = (crc: number, byte: number): number =>
  (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0

/** The three ZipCrypto keys, initialised from a password; decrypts byte by byte. */
class ZipCryptoKeys {
  private k0 = 0x12345678
  private k1 = 0x23456789
  private k2 = 0x34567890

  constructor(password: string) {
    for (const byte of Buffer.from(password, 'latin1')) this.update(byte)
  }

  private update(byte: number): void {
    this.k0 = crcByte(this.k0, byte)
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0
    this.k2 = crcByte(this.k2, this.k1 >>> 24)
  }

  decrypt(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length)
    for (let i = 0; i < data.length; i++) {
      const temp = (this.k2 | 2) & 0xffff
      const plain = data[i]! ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff)
      out[i] = plain
      this.update(plain)
    }
    return out
  }
}

/**
 * A decrypting stream for an encrypted entry's data: the 12-byte encryption header is checked against the entry
 * (a wrong password fails at once) and dropped.
 */
function decryptStream(entry: ZipEntry, password: string): Transform {
  const keys = new ZipCryptoKeys(password)
  let header: Buffer | null = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      let data = keys.decrypt(chunk)
      if (header) {
        header = Buffer.concat([header, data])
        if (header.length < 12) return done()
        const check = entry.flags & 8 ? (entry.modTime >>> 8) & 0xff : entry.crc >>> 24
        if (header[11] !== check) return done(new Error(`wrong password for ${entry.name}`))
        data = header.subarray(12)
        header = null
      }
      done(null, data)
    }
  })
}

/** One entry's bytes, in memory (for small entries: a handler script). */
export async function readZipEntry(
  path: string,
  entry: ZipEntry,
  options: ZipOptions = {}
): Promise<Buffer> {
  checkMethod(entry, options)
  const start = await dataOffset(path, entry)
  const handle = await fs.open(path, 'r')
  try {
    const data = Buffer.alloc(entry.compressedSize)
    await handle.read(data, 0, entry.compressedSize, start)
    let plain: Buffer = data
    if (entry.flags & 1) {
      const decrypted = new ZipCryptoKeys(options.password!).decrypt(data)
      const check = entry.flags & 8 ? (entry.modTime >>> 8) & 0xff : entry.crc >>> 24
      if (decrypted[11] !== check) throw new Error(`wrong password for ${entry.name}`)
      plain = decrypted.subarray(12)
    }
    return entry.method === 8
      ? inflateRawSync(plain, { maxOutputLength: entry.size + 1024 })
      : plain
  } finally {
    await handle.close()
  }
}

/**
 * Whether `relative` (a zip entry path) stays inside its destination: no absolute paths, drive letters or '..'
 * (a "zip slip" entry would write anywhere on the disk).
 */
export function safeEntryPath(relative: string): string | null {
  const clean = relative.replace(/\\/g, '/')
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return null
  const parts = clean.split('/').filter((p) => p && p !== '.')
  if (
    parts.some((p) => p === '..' || /[<>:"|?*]/.test(p) || [...p].some((c) => c.charCodeAt(0) < 32))
  )
    return null
  return parts.length ? parts.join(sep) : null
}

/**
 * Write one entry to `target` (its folders created), streaming. Entries whose stored size does not match are
 * rejected after writing (a damaged download).
 */
export async function extractZipEntry(
  path: string,
  entry: ZipEntry,
  target: string,
  options: ZipOptions = {}
): Promise<void> {
  checkMethod(entry, options)
  const start = await dataOffset(path, entry)
  await fs.mkdir(dirname(target), { recursive: true })
  if (entry.compressedSize === 0) {
    await fs.writeFile(target, '')
    return
  }
  const source = createReadStream(path, { start, end: start + entry.compressedSize - 1 })
  const sink = createWriteStream(target)
  const steps: (NodeJS.ReadableStream | NodeJS.WritableStream | Transform)[] = [source]
  if (entry.flags & 1) steps.push(decryptStream(entry, options.password!))
  if (entry.method === 8) steps.push(createInflateRaw())
  steps.push(sink)
  await (pipeline as (...streams: unknown[]) => Promise<void>)(...steps)
  const written = (await fs.stat(target)).size
  if (written !== entry.size)
    throw new Error(`${entry.name}: wrote ${written} bytes, expected ${entry.size}`)
}

/**
 * Extract the entries `map` keeps into `destDir`: `map` returns the path (relative to `destDir`) to write an entry
 * to, or null to leave it out. Folder entries are skipped (their files create them). Returns the files written.
 */
export async function extractZip(
  path: string,
  destDir: string,
  map: (entry: ZipEntry) => string | null = (e) => e.name,
  options: ZipOptions = {}
): Promise<string[]> {
  const written: string[] = []
  const root = normalize(destDir)
  for (const entry of await listZip(path)) {
    if (entry.name.endsWith('/')) continue
    const relative = map(entry)
    if (relative === null) continue
    const safe = safeEntryPath(relative)
    if (!safe) throw new Error(`unsafe path in zip: ${entry.name}`)
    const target = join(root, safe)
    await extractZipEntry(path, entry, target, options)
    written.push(target)
  }
  return written
}
