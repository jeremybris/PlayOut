import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { icoBytes, jpegBytes, pngBytes, webpBytes } from './test-helpers'
import { acceptsKind, sniffBuffer, sniffForKind, sniffImage, type ImageInfo } from './image-sniff'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-sniff-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('sniffBuffer', () => {
  it('reads JPEG SOF dimensions behind an APP0 segment', () => {
    expect(sniffBuffer(jpegBytes(300, 450))).toEqual({
      format: 'jpg',
      width: 300,
      height: 450,
      alpha: false
    })
  })

  it('reads PNG IHDR and the alpha colour types', () => {
    expect(sniffBuffer(pngBytes(640, 360, true))).toMatchObject({
      format: 'png',
      width: 640,
      height: 360,
      alpha: true
    })
    expect(sniffBuffer(pngBytes(640, 360, false))).toMatchObject({ format: 'png', alpha: false })
  })

  it('reads WebP VP8X dimensions and the alpha flag', () => {
    expect(sniffBuffer(webpBytes(342, 482, true))).toEqual({
      format: 'webp',
      width: 342,
      height: 482,
      alpha: true
    })
  })

  it('reads ICO and GIF headers', () => {
    expect(sniffBuffer(icoBytes(32))).toMatchObject({ format: 'ico', width: 32, height: 32 })
    expect(sniffBuffer(icoBytes(256))).toMatchObject({ width: 256, height: 256 })
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1')
    expect(sniffBuffer(gif)).toMatchObject({ format: 'gif', width: 320, height: 240 })
  })

  it('returns null for unknown or truncated data', () => {
    expect(sniffBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffBuffer(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull()
    expect(sniffBuffer(Buffer.alloc(0))).toBeNull()
  })
})

describe('acceptsKind', () => {
  const info = (
    width: number,
    height: number,
    format: 'jpg' | 'png' | 'webp' = 'jpg',
    alpha = false
  ): ImageInfo => ({
    format,
    width,
    height,
    alpha
  })

  it('classifies covers by ratio, with 300x450 as small and headers rejected', () => {
    expect(acceptsKind('cover', info(600, 900))).toBe('good')
    expect(acceptsKind('cover', info(300, 450))).toBe('small')
    expect(acceptsKind('cover', info(342, 482, 'webp'))).toBe('small')
    expect(acceptsKind('cover', info(1200, 1600))).toBe('good')
    expect(acceptsKind('cover', info(460, 215))).toBeNull()
    expect(acceptsKind('cover', info(171, 241))).toBeNull()
  })

  it('accepts heroes at 2.4:1 and wider, 16:9 only as a fallback', () => {
    expect(acceptsKind('hero', info(1920, 620))).toBe('good')
    expect(acceptsKind('hero', info(1600, 650, 'webp'))).toBe('good')
    expect(acceptsKind('hero', info(1920, 1080))).toBe('fallback')
    expect(acceptsKind('hero', info(1280, 720))).toBe('fallback')
    expect(acceptsKind('hero', info(192, 62))).toBeNull()
    expect(acceptsKind('hero', info(1024, 768))).toBeNull()
  })

  it('accepts logos that are PNGs with alpha at any shape from 128 px, opaque ones only wide, never the 7f jpg', () => {
    expect(acceptsKind('logo', info(640, 360, 'png', true))).toBe('good')
    expect(acceptsKind('logo', info(640, 200, 'png', false))).toBe('good')
    // Real Steam logo.png files narrower than the 640x360 norm (appids 15320, 219740, 238960, 242920, ...).
    for (const [w, h] of [
      [360, 360],
      [392, 360],
      [354, 140],
      [391, 132],
      [259, 360],
      [167, 360]
    ])
      expect(acceptsKind('logo', info(w, h, 'png', true))).toBe('good')
    expect(acceptsKind('logo', info(300, 100, 'webp', true))).toBe('good')
    // Icon-sized transparent PNGs and opaque narrow / tall files are not logos; nor is the square 7f jpg.
    expect(acceptsKind('logo', info(64, 64, 'png', true))).toBeNull()
    expect(acceptsKind('logo', info(300, 100, 'png', false))).toBeNull()
    expect(acceptsKind('logo', info(400, 600, 'png', false))).toBeNull()
    expect(acceptsKind('logo', info(1000, 1000))).toBeNull()
    expect(acceptsKind('logo', info(640, 360, 'jpg', false))).toBeNull()
  })

  it('accepts square icons up to 256 px', () => {
    expect(acceptsKind('icon', info(32, 32))).toBe('good')
    expect(acceptsKind('icon', info(112, 112, 'webp'))).toBe('good')
    expect(acceptsKind('icon', info(329, 329))).toBeNull()
    expect(acceptsKind('icon', info(32, 48))).toBeNull()
  })

  it('accepts landscape screenshots', () => {
    expect(acceptsKind('screenshot', info(1920, 1080))).toBe('good')
    expect(acceptsKind('screenshot', info(600, 900))).toBeNull()
  })
})

describe('sniffImage / sniffForKind', () => {
  it('sniffs a file by its header regardless of the extension', async () => {
    const file = join(dir, 'library_600x900.jpg')
    await fs.writeFile(file, pngBytes(600, 900))
    expect(await sniffImage(file)).toMatchObject({ format: 'png', width: 600, height: 900 })
    expect(await sniffForKind(file, 'cover')).toMatchObject({ quality: 'good' })
    expect(await sniffForKind(file, 'hero')).toBeNull()
  })

  it('returns null for a missing file', async () => {
    expect(await sniffImage(join(dir, 'missing.jpg'))).toBeNull()
  })
})
