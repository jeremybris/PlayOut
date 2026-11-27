// Image header sniffing for the art pipeline (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §13.6): reads the
// first 64 KiB of a file and classifies it by its real dimensions, never by its name (Steam's `library_600x900.jpg`
// is 300x450 on disk and 444 of them are PNGs). No native module: JPEG SOF, PNG IHDR, WebP VP8/VP8L/VP8X, ICO, GIF.
import { promises as fs } from 'fs'
import type { ArtKind } from '../../shared/types'

export type ImageFormat = 'jpg' | 'png' | 'webp' | 'ico' | 'gif'

export interface ImageInfo {
  format: ImageFormat
  width: number
  height: number
  /** PNG colour type 4 / 6, WebP VP8X alpha flag or VP8L alpha bit, ICO always. */
  alpha: boolean
}

/**
 * How well a sniffed image fits a kind: `good` passes the kind's rules, `small` is a cover under 600 px tall (Steam's
 * local 300x450; the full lane upgrades it), `fallback` is a 16:9 screenshot standing in for a hero. `null` = rejected.
 */
export type ArtQuality = 'good' | 'small' | 'fallback'

/** Bytes read per sniff: enough for any JPEG SOF behind an EXIF block and for every PNG / WebP / ICO header. */
export const SNIFF_BYTES = 64 * 1024

/** The largest side of an icon; Steam's 32x32 and Galaxy's 112x112 qualify, the Xbox app's 329x329 tiles do not. */
const ICON_MAX = 256

function sniffJpeg(buf: Buffer): ImageInfo | null {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    // Padding, SOI, RST0-7 and TEM markers carry no length field.
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    const length = buf.readUInt16BE(i + 2)
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return {
        format: 'jpg',
        width: buf.readUInt16BE(i + 7),
        height: buf.readUInt16BE(i + 5),
        alpha: false
      }
    }
    i += 2 + length
  }
  return null
}

function sniffWebp(buf: Buffer): ImageInfo | null {
  if (buf.length < 30) return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return {
      format: 'webp',
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
      alpha: (buf[20] & 0x10) !== 0
    }
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return {
      format: 'webp',
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff),
      alpha: ((bits >>> 28) & 1) === 1
    }
  }
  if (chunk === 'VP8 ') {
    return {
      format: 'webp',
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
      alpha: false
    }
  }
  return null
}

/** Classify an image from its leading bytes (at most the first 64 KiB). Returns null for anything unrecognised. */
export function sniffBuffer(buf: Buffer): ImageInfo | null {
  if (buf.length < 10) return null
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    if (buf.length < 26) return null
    const colourType = buf[25]
    return {
      format: 'png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      alpha: colourType === 4 || colourType === 6
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return sniffJpeg(buf)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return sniffWebp(buf)
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf.length >= 8) {
    // ICO directory entry: a 0 byte means 256.
    return { format: 'ico', width: buf[6] || 256, height: buf[7] || 256, alpha: true }
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), alpha: false }
  }
  return null
}

/** First read per sniff: every PNG / WebP / ICO / GIF header and most JPEG SOFs sit inside it. */
const FIRST_READ_BYTES = 4 * 1024

/**
 * Sniff a file on disk. Reads the first 4 KiB and, only for a JPEG whose SOF sits behind a large EXIF / ICC
 * block, up to 64 KiB (a 9,750-file run reads ~40 MB instead of ~1 GB). Returns null when the file is missing,
 * unreadable or not an image, so callers can treat "missing" and "not usable" alike.
 */
export async function sniffImage(path: string): Promise<ImageInfo | null> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(path, 'r')
    const buf = Buffer.alloc(SNIFF_BYTES)
    const first = await handle.read(buf, 0, FIRST_READ_BYTES, 0)
    const info = sniffBuffer(buf.subarray(0, first.bytesRead))
    if (info || first.bytesRead < FIRST_READ_BYTES || !(buf[0] === 0xff && buf[1] === 0xd8))
      return info
    const rest = await handle.read(
      buf,
      FIRST_READ_BYTES,
      SNIFF_BYTES - FIRST_READ_BYTES,
      FIRST_READ_BYTES
    )
    return sniffBuffer(buf.subarray(0, FIRST_READ_BYTES + rest.bytesRead))
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Quality rules of research §13.6, by ratio rather than exact pixels:
 * - cover: portrait, w/h in 0.60-0.75, h >= 400 (`small` under 600); a 460x215 header is never a cover
 * - hero: w >= 1200 and w/h >= 2.4; 16:9 at 1280+ wide is a `fallback` only
 * - logo: PNG / WebP with alpha at w >= 128 and h >= 32 (Steam's slot holds 360x360, 354x140 and 167x360
 *   logos next to the 640x360 norm: 76 of the 4,687 on this PC are narrower than 400); an opaque `logo.png`
 *   still passes at w >= 400, h <= w (94 Steam cases), which keeps the square 1000x1000 `7f` jpg out
 * - icon: square, side <= 256
 * - screenshot: landscape, w >= 640
 */
export function acceptsKind(kind: ArtKind, info: ImageInfo): ArtQuality | null {
  const { width: w, height: h } = info
  if (!(w > 0 && h > 0)) return null
  const ratio = w / h
  switch (kind) {
    case 'cover':
      if (ratio < 0.6 || ratio > 0.75 || h < 400) return null
      return h < 600 ? 'small' : 'good'
    case 'hero':
      if (w < 1200) return null
      if (ratio >= 2.4) return 'good'
      return ratio >= 1.7 && ratio <= 1.8 && w >= 1280 ? 'fallback' : null
    case 'logo': {
      const transparent = (info.format === 'png' || info.format === 'webp') && info.alpha
      if (transparent) return w >= 128 && h >= 32 ? 'good' : null
      if (w < 400 || h > w) return null
      return info.format === 'png' || info.format === 'webp' ? 'good' : null
    }
    case 'icon':
      return w === h && w <= ICON_MAX ? 'good' : null
    case 'screenshot':
      return ratio > 1 && w >= 640 ? 'good' : null
  }
}

/** Sniff a file and apply the kind's rules in one go: the per-candidate check every local source makes. */
export async function sniffForKind(
  path: string,
  kind: ArtKind
): Promise<{ info: ImageInfo; quality: ArtQuality } | null> {
  const info = await sniffImage(path)
  if (!info) return null
  const quality = acceptsKind(kind, info)
  return quality ? { info, quality } : null
}
