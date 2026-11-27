/**
 * The in-game overlay's pipe protocol (ingame-helper/PROTOCOL.md): message types, framing, and the codecs PlayOut's
 * main process uses on its side of the pipe. ingame-helper/hook/protocol.h holds the same constants for the DLL;
 * protocol.test.ts keeps both in sync.
 */

export const PROTOCOL_VERSION = 1
/** Every message starts with an 8-byte header: u32 type, u32 payload length (little-endian). */
export const HEADER_BYTES = 8
/** A payload longer than this is a protocol error. */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
/** FRAME's fixed fields before the pixels: x, y, w, h, fullWidth, fullHeight (u32 each). */
export const FRAME_HEADER_BYTES = 24
/** The config mapping's magic, 'POIC'. */
export const CONFIG_MAGIC = 0x43494f50
/** Prefix of the config mapping's name; the game's pid follows. */
export const CONFIG_MAPPING_PREFIX = 'Local\\PlayOutIngame-'
/** Prefix of the pipe's name; 32 random hex characters follow. */
export const PIPE_PREFIX = '\\\\.\\pipe\\PlayOut-ingame-'

/** DLL -> PlayOut. */
export const FromDll = {
  HELLO: 1,
  RESIZE: 2,
  PRESENTING: 3,
  FAULT: 4,
  LOG: 5,
  PONG: 6,
  UNSUPPORTED: 7,
  HIDDEN: 8
} as const

/** PlayOut -> DLL. */
export const ToDll = {
  SHOW: 101,
  HIDE: 102,
  FRAME: 103,
  PING: 104,
  INPUT_RELEASE: 105,
  DETACH: 106
} as const

export type FromDllType = (typeof FromDll)[keyof typeof FromDll]
export type ToDllType = (typeof ToDll)[keyof typeof ToDll]

export interface HelloPayload {
  proto: number
  dll: string
  pid: number
  token: string
  api: string
  width: number
  height: number
  /** DXGI_FORMAT of the back buffer (0: none presented yet). */
  format: number
  exclusive: boolean
  hwnd: string
}

export interface ResizePayload {
  width: number
  height: number
  format: number
  exclusive: boolean
}

export interface PresentingPayload {
  held: boolean
}

export interface FaultPayload {
  where: string
  code: number
}

export interface LogPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

export type UnsupportedReason = 'format' | 'not-exclusive' | 'no-swapchain' | 'device'

export interface UnsupportedPayload {
  reason: UnsupportedReason | string
}

export interface ShowPayload {
  hold: boolean
}

/** A message read from the DLL, its JSON payload parsed (null when it was not a JSON object). */
export interface DllMessage {
  type: number
  json: Record<string, unknown> | null
}

/** One message: the header and the payload. */
export function encodeMessage(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_PAYLOAD_BYTES)
    throw new Error(`payload too large (${payload.length} bytes)`)
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32LE(type >>> 0, 0)
  header.writeUInt32LE(payload.length, 4)
  return payload.length ? Buffer.concat([header, payload]) : header
}

/** A control message with a JSON payload ({} encodes as an empty payload). */
export function encodeJson(type: number, value: object = {}): Buffer {
  const text = Object.keys(value).length ? JSON.stringify(value) : ''
  return encodeMessage(type, Buffer.from(text, 'utf8'))
}

export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A FRAME carrying the rectangle `rect` of a `fullWidth` x `fullHeight` BGRA image `bitmap` (rows of fullWidth * 4
 * bytes, as NativeImage.toBitmap gives). Only the rectangle's rows are copied, tightly packed. The rectangle is clamped
 * to the image; an empty one gives null.
 */
export function encodeFrame(
  bitmap: Buffer,
  fullWidth: number,
  fullHeight: number,
  rect: FrameRect
): Buffer | null {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(fullWidth, Math.ceil(rect.x + rect.w))
  const bottom = Math.min(fullHeight, Math.ceil(rect.y + rect.h))
  const w = right - x
  const h = bottom - y
  if (w <= 0 || h <= 0) return null
  if (bitmap.length < fullWidth * fullHeight * 4) throw new Error('bitmap smaller than its size')
  const rowBytes = w * 4
  const payload = Buffer.alloc(FRAME_HEADER_BYTES + rowBytes * h)
  payload.writeUInt32LE(x, 0)
  payload.writeUInt32LE(y, 4)
  payload.writeUInt32LE(w, 8)
  payload.writeUInt32LE(h, 12)
  payload.writeUInt32LE(fullWidth, 16)
  payload.writeUInt32LE(fullHeight, 20)
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * fullWidth + x) * 4
    bitmap.copy(payload, FRAME_HEADER_BYTES + row * rowBytes, from, from + rowBytes)
  }
  return encodeMessage(ToDll.FRAME, payload)
}

/**
 * Reads messages from a byte stream (the pipe) as they complete. Throws on a protocol error (a payload over the
 * limit); the caller then drops the connection.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0)

  /** Feed bytes; returns the messages they completed, in order. */
  push(chunk: Buffer): { type: number; payload: Buffer }[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const out: { type: number; payload: Buffer }[] = []
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break
      const type = this.buffer.readUInt32LE(0)
      const length = this.buffer.readUInt32LE(4)
      if (length > MAX_PAYLOAD_BYTES) throw new Error(`payload too large (${length} bytes)`)
      if (this.buffer.length < HEADER_BYTES + length) break
      out.push({ type, payload: this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length) })
      this.buffer = this.buffer.subarray(HEADER_BYTES + length)
    }
    if (this.buffer.length === 0) this.buffer = Buffer.alloc(0)
    return out
  }
}

/** A message's JSON object payload, or null (empty payload = {}). */
export function parseJsonPayload(payload: Buffer): Record<string, unknown> | null {
  if (payload.length === 0) return {}
  try {
    const value: unknown = JSON.parse(payload.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A HELLO payload when it has every field with the right type, else null. */
export function parseHello(json: Record<string, unknown> | null): HelloPayload | null {
  if (!json) return null
  const n = (k: string): boolean => typeof json[k] === 'number' && Number.isFinite(json[k])
  const s = (k: string): boolean => typeof json[k] === 'string'
  if (
    !n('proto') ||
    !s('dll') ||
    !n('pid') ||
    !s('token') ||
    !s('api') ||
    !n('width') ||
    !n('height') ||
    !n('format') ||
    typeof json.exclusive !== 'boolean' ||
    !s('hwnd')
  )
    return null
  return json as unknown as HelloPayload
}

/** DXGI formats the DLL draws on (8-bit RGBA / BGRA, UNORM or SRGB). */
export const DRAWABLE_FORMATS: readonly number[] = [
  28, // R8G8B8A8_UNORM
  29, // R8G8B8A8_UNORM_SRGB
  87, // B8G8R8A8_UNORM
  91 // B8G8R8A8_UNORM_SRGB
]
