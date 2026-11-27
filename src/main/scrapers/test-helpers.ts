// Fixture builders shared by the art pipeline tests: synthetic image headers with real dimensions (the sniffer
// reads only headers, so a 600x900 "JPEG" is a few dozen bytes), a binary KeyValues encoder for a fake
// `assetcache.vdf`, and a fetch stub that routes by URL prefix. Not imported by production code.
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Game, Settings, SourceId } from '../../shared/types'
import { clone } from '../util/object'
import type { BinaryVdfObject } from './local-art/steam-cache'

/** JPEG: SOI, an APP0 segment, then SOF0 with the height / width. */
export function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0
  ])
  const sof = Buffer.alloc(2 + 17)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

/** PNG: signature + IHDR (colour type 6 with alpha, 2 without). */
export function pngBytes(width: number, height: number, alpha = true): Buffer {
  const header = Buffer.alloc(8 + 4 + 4 + 13 + 4)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  header[24] = 8
  header[25] = alpha ? 6 : 2
  return header
}

/** WebP with a VP8X chunk (extended format, as Galaxy's files are). */
export function webpBytes(width: number, height: number, alpha = false): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  buf.writeUInt32LE(10, 16)
  buf[20] = alpha ? 0x10 : 0
  buf.writeUIntLE(width - 1, 24, 3)
  buf.writeUIntLE(height - 1, 27, 3)
  return buf
}

export function icoBytes(size: number): Buffer {
  const buf = Buffer.alloc(22)
  buf.writeUInt16LE(1, 2)
  buf.writeUInt16LE(1, 4)
  buf[6] = size === 256 ? 0 : size
  buf[7] = size === 256 ? 0 : size
  return buf
}

/** Encode an object as Valve's binary KeyValues (strings and int32 only; nested objects). */
export function binaryVdfBytes(value: BinaryVdfObject): Buffer {
  const parts: Buffer[] = []
  const encode = (obj: BinaryVdfObject): void => {
    for (const [key, v] of Object.entries(obj)) {
      if (typeof v === 'object') {
        parts.push(Buffer.from([0x00]), Buffer.from(`${key}\0`, 'utf8'))
        encode(v)
      } else if (typeof v === 'number') {
        const n = Buffer.alloc(4)
        n.writeInt32LE(v)
        parts.push(Buffer.from([0x02]), Buffer.from(`${key}\0`, 'utf8'), n)
      } else {
        parts.push(Buffer.from([0x01]), Buffer.from(`${key}\0${v}\0`, 'utf8'))
      }
    }
    parts.push(Buffer.from([0x08]))
  }
  encode(value)
  return Buffer.concat(parts)
}

/** Write files into a fixture tree, creating folders as needed. */
export async function writeTree(
  root: string,
  files: Record<string, Buffer | string>
): Promise<void> {
  for (const [rel, data] of Object.entries(files)) {
    const path = `${root}/${rel}`
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, data)
  }
}

export type FetchRoute = (url: string, init?: RequestInit) => Response | Promise<Response>

/**
 * Stub `fetch` with routes keyed by URL prefix (longest match wins); unmatched URLs answer 404. Returns the list
 * of requested URLs so tests can assert request counts and shapes.
 */
export function stubFetch(routes: Record<string, FetchRoute | unknown>): string[] {
  const calls: string[] = []
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length)
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    const key = keys.find((k) => url.startsWith(k))
    if (key === undefined) return new Response('not found', { status: 404 })
    const route = routes[key]
    if (typeof route === 'function') return (route as FetchRoute)(url, init)
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  return calls
}

export const testLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

/** A minimal library game; the art sources read only `id`, `source`, `externalId` and `extra`. */
export function fakeGame(
  source: SourceId,
  externalId: string,
  extra: Record<string, string | number | boolean> = {}
): Game {
  return {
    id: `${source}:${externalId}`,
    source,
    externalId,
    platformId: source,
    title: externalId,
    sortTitle: externalId,
    installed: false,
    owned: true,
    launch: { kind: 'uri', uri: 'about:blank' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-11-02T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    extra
  }
}

/** Settings with `scrapers.localArt` on and optional credentials. */
export function testSettings(patch: Partial<Settings['scrapers']> = {}): Settings {
  const settings = clone(defaultSettings())
  Object.assign(settings.scrapers, patch)
  return settings
}
