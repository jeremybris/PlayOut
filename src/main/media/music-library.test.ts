import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CACHE_MS,
  clearMusicCache,
  listMusic,
  musicExtension,
  scanMusic,
  trackFor
} from './music-library'

let root: string
let outside: string

function touch(rel: string): void {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'x')
}

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'playout-music-'))
  root = path.join(base, 'Music')
  outside = path.join(base, 'Elsewhere')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.mp3'), 'x')
  touch('Root Song.MP3')
  touch('Artist B/10 Ten.flac')
  touch('Artist B/2 Two.ogg')
  touch('Artist A/Album/a.b.c.opus')
  touch('Artist A/cover.jpg')
  touch('Artist A/notes.txt')
  touch('1/2/3/4/5/6/deep6.wav')
  touch('1/2/3/4/5/6/7/deep7.wav')
  for (const ext of ['m4a', 'aac', 'mp3']) touch(`Formats/f.${ext}`)
  // A junction out of the folder (no admin needed, unlike a symlink): never followed.
  symlinkSync(outside, path.join(root, 'Link'), 'junction')
})

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true })
  clearMusicCache()
})

describe('music library', () => {
  it('knows the formats', () => {
    expect(musicExtension('a.FLAC')).toBe('flac')
    expect(musicExtension('a.opus')).toBe('opus')
    expect(musicExtension('a.jpg')).toBeNull()
    expect(musicExtension('mp3')).toBeNull()
  })

  it('names a track from its file and parent folder', () => {
    expect(trackFor('x/y/Song.name.mp3', 'Music')).toEqual({
      path: 'x/y/Song.name.mp3',
      title: 'Song.name',
      folder: 'y'
    })
    expect(trackFor('Song.mp3', 'Music').folder).toBe('Music')
  })

  it('lists audio files sorted by folder then title, to depth 6, skipping links', async () => {
    const tracks = await scanMusic(root)
    // Folders '6' < 'Album' < 'Artist B' < 'Formats' < 'Music' (the root's own files); numbers sort naturally.
    expect(tracks.map((t) => t.path)).toEqual([
      '1/2/3/4/5/6/deep6.wav',
      'Artist A/Album/a.b.c.opus',
      'Artist B/2 Two.ogg',
      'Artist B/10 Ten.flac',
      'Formats/f.aac',
      'Formats/f.m4a',
      'Formats/f.mp3',
      'Root Song.MP3'
    ])
    expect(tracks[0]).toEqual({ path: '1/2/3/4/5/6/deep6.wav', title: 'deep6', folder: '6' })
    expect(tracks[7]).toEqual({ path: 'Root Song.MP3', title: 'Root Song', folder: 'Music' })
  })

  it('stops at the track cap', async () => {
    expect(await scanMusic(root, { maxTracks: 3 })).toHaveLength(3)
  })

  it('gives no tracks for a missing folder', async () => {
    expect(await scanMusic(path.join(root, 'nope'))).toEqual([])
  })

  it('caches per folder for a minute', async () => {
    clearMusicCache()
    const t0 = 1_000_000
    const first = await listMusic(root, t0)
    touch('New.mp3')
    // Windows paths are one entry whatever their case.
    const same = process.platform === 'win32' ? root.toUpperCase() : root
    expect(await listMusic(same, t0 + 1000)).toBe(first)
    const later = await listMusic(root, t0 + CACHE_MS + 1)
    expect(later).not.toBe(first)
    expect(later.map((t) => t.path)).toContain('New.mp3')
    clearMusicCache(root)
    expect(await listMusic(root, t0 + CACHE_MS + 2)).not.toBe(later)
  })
})
