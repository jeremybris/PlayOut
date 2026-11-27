import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createMusicHandler,
  isInside,
  MUSIC_SCHEME,
  musicContentType,
  musicRelativePath,
  musicTrackUrl,
  parseRange,
  registerMusicProtocol
} from './music-protocol'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let base: string
let root: string
let folder: string | null
const handler = createMusicHandler({ folder: () => folder, log })
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'playout-musicproto-'))
  root = path.join(base, 'Music')
  folder = root
  mkdirSync(path.join(root, 'Art #1'), { recursive: true })
  writeFileSync(path.join(root, 'Art #1', 'Song 100%.mp3'), bytes)
  writeFileSync(path.join(root, 'empty.ogg'), '')
  writeFileSync(path.join(root, 'cover.jpg'), 'x')
  mkdirSync(path.join(base, 'Outside'))
  writeFileSync(path.join(base, 'Outside', 'secret.mp3'), 'secret')
  writeFileSync(path.join(base, 'next.mp3'), 'sibling')
  symlinkSync(path.join(base, 'Outside'), path.join(root, 'Escape'), 'junction')
  mkdirSync(path.join(root, 'Inner'))
  writeFileSync(path.join(root, 'Inner', 'in.flac'), 'inner')
  symlinkSync(path.join(root, 'Inner'), path.join(root, 'Alias'), 'junction')
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
  return handler(new Request(url, { headers, method }))
}

async function body(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer())
}

describe('music path checks', () => {
  it('accepts plain relative paths, encoded either way', () => {
    expect(musicRelativePath('/a/b%20c.mp3')).toBe('a/b c.mp3')
    expect(musicRelativePath('/a%2Fb.mp3')).toBe('a/b.mp3')
    expect(musicRelativePath('/a%5Cb.mp3')).toBe('a/b.mp3')
  })

  it('refuses traversal, absolute paths, drives, streams and bad encoding', () => {
    for (const p of [
      '/',
      '/..%2Fx.mp3',
      '/a/%2E%2E/%2E%2E/x.mp3',
      '/%2Fetc%2Fx.mp3',
      '/C%3A%5Cx.mp3',
      '/c:/x.mp3',
      '/%5C%5Cserver%5Cshare%5Cx.mp3',
      '/a.mp3:secret',
      '/a%00.mp3',
      '/a//b.mp3',
      '/%E0%A4%A.mp3',
      '/./a.mp3'
    ]) {
      expect(musicRelativePath(p), p).toBeNull()
    }
  })

  it('tells inside from outside', () => {
    expect(isInside(path.resolve('/m'), path.resolve('/m/a.mp3'))).toBe(true)
    expect(isInside(path.resolve('/m'), path.resolve('/m'))).toBe(false)
    expect(isInside(path.resolve('/m'), path.resolve('/m2/a.mp3'))).toBe(false)
    expect(isInside(path.resolve('/m'), path.resolve('/a.mp3'))).toBe(false)
    // A name that merely starts with two dots is still inside.
    expect(isInside(path.resolve('/m'), path.resolve('/m/..intro.mp3'))).toBe(true)
    expect(isInside(path.resolve('/m'), path.resolve('/m/../x.mp3'))).toBe(false)
  })

  it('maps content types', () => {
    expect(musicContentType('a.MP3')).toBe('audio/mpeg')
    expect(musicContentType('a.m4a')).toBe('audio/mp4')
    expect(musicContentType('a.flac')).toBe('audio/flac')
    expect(musicContentType('a.opus')).toBe('audio/ogg')
    expect(musicContentType('a.wav')).toBe('audio/wav')
    expect(musicContentType('a.jpg')).toBeNull()
  })

  it('builds track URLs that round-trip', () => {
    const url = musicTrackUrl('Art #1/Song 100%.mp3')
    expect(url).toBe('playout-music://track/Art%20%231/Song%20100%25.mp3')
    expect(musicRelativePath(new URL(url).pathname)).toBe('Art #1/Song 100%.mp3')
  })
})

describe('parseRange', () => {
  it('parses the forms <audio> sends', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('ignores what it does not understand and refuses what cannot be served', () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
    expect(parseRange('bytes=20-10', 100)).toBeNull()
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })
})

describe('playout-music:// handler', () => {
  const song = musicTrackUrl('Art #1/Song 100%.mp3')

  it('serves the whole file', async () => {
    const res = await get(song)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('1000')
    expect((await body(res)).equals(bytes)).toBe(true)
  })

  it('serves byte ranges', async () => {
    const res = await get(song, { Range: 'bytes=100-199' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(res.headers.get('content-length')).toBe('100')
    expect((await body(res)).equals(bytes.subarray(100, 200))).toBe(true)

    const tail = await get(song, { Range: 'bytes=-10' })
    expect(tail.status).toBe(206)
    expect((await body(tail)).equals(bytes.subarray(990))).toBe(true)

    const open = await get(song, { Range: 'bytes=995-' })
    expect(open.headers.get('content-range')).toBe('bytes 995-999/1000')
    expect((await body(open)).length).toBe(5)
  })

  it('answers 416 past the end', async () => {
    const res = await get(song, { Range: 'bytes=1000-' })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */1000')
  })

  it('answers HEAD without a body', async () => {
    const res = await get(song, {}, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('1000')
  })

  it('serves an empty file', async () => {
    const res = await get(musicTrackUrl('empty.ogg'))
    expect(res.status).toBe(200)
    expect((await body(res)).length).toBe(0)
  })

  it('follows a link that stays inside the folder', async () => {
    const res = await get(musicTrackUrl('Alias/in.flac'))
    expect(res.status).toBe(200)
    expect((await body(res)).toString()).toBe('inner')
  })

  it('refuses everything else with 404', async () => {
    for (const url of [
      musicTrackUrl('Escape/secret.mp3'), // junction out of the folder
      'playout-music://track/..%2Fnext.mp3',
      'playout-music://track/%2E%2E/next.mp3',
      `playout-music://track/${encodeURIComponent(path.join(base, 'next.mp3'))}`,
      musicTrackUrl('cover.jpg'), // not audio
      musicTrackUrl('missing.mp3'),
      musicTrackUrl('Art #1'), // a folder
      'playout-music://other/Art%20%231/Song%20100%25.mp3'
    ]) {
      expect((await get(url)).status, url).toBe(404)
    }
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('outside the folder'))
  })

  it('refuses when no folder is chosen, and follows a new choice at once', async () => {
    folder = null
    expect((await get(song)).status).toBe(404)
    folder = path.join(base, 'Outside')
    expect((await get(musicTrackUrl('secret.mp3'))).status).toBe(200)
    folder = root
  })

  it('refuses other methods', async () => {
    expect((await get(song, {}, 'POST')).status).toBe(405)
  })
})

describe('registration', () => {
  it('declares the privileges <audio> streaming needs', () => {
    expect(MUSIC_SCHEME.scheme).toBe('playout-music')
    expect(MUSIC_SCHEME.privileges).toMatchObject({
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true
    })
  })

  it('hands the handler to protocol.handle', async () => {
    const handle = vi.fn()
    registerMusicProtocol({ handle }, { folder: () => root, log })
    expect(handle).toHaveBeenCalledWith('playout-music', expect.any(Function))
    const fn = handle.mock.calls[0][1] as (r: Request) => Promise<Response>
    expect((await fn(new Request(musicTrackUrl('empty.ogg')))).status).toBe(200)
  })
})
