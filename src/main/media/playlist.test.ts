import { describe, expect, it } from 'vitest'
import type { MusicTrack } from '@shared/overlay'
import {
  addTrack,
  dedupePlaylist,
  moveTrack,
  normalizeTrackPath,
  playlistTracks,
  prunePlaylist,
  removeTrack,
  samePlaylist,
  shiftTrack
} from './playlist'

const t = (p: string): MusicTrack => ({ path: p, title: p, folder: '' })

describe('playlists', () => {
  it('normalizes paths', () => {
    expect(normalizeTrackPath('.\\A\\\\b.mp3')).toBe('A/b.mp3')
    expect(normalizeTrackPath('/a/./b.mp3/')).toBe('a/b.mp3')
    expect(normalizeTrackPath('')).toBe('')
  })

  it('dedupes without case, keeping the first', () => {
    expect(dedupePlaylist(['A/x.mp3', 'a\\X.mp3', '', 'b.mp3', 'B.MP3'])).toEqual([
      'A/x.mp3',
      'b.mp3'
    ])
  })

  it('adds once, at the end or at an index', () => {
    expect(addTrack(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(addTrack(['a', 'b'], 'B')).toEqual(['a', 'b'])
    expect(addTrack(['a', 'b'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(addTrack(['a', 'b'], 'c', 99)).toEqual(['a', 'b', 'c'])
    expect(addTrack(['a'], '')).toEqual(['a'])
    const list = ['a']
    addTrack(list, 'b')
    expect(list).toEqual(['a'])
  })

  it('removes without case', () => {
    expect(removeTrack(['a/x', 'b', 'A/X'], 'a\\x')).toEqual(['b'])
    expect(removeTrack(['a'], 'z')).toEqual(['a'])
  })

  it('moves to a position or by a step, clamped', () => {
    expect(moveTrack(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveTrack(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveTrack(['a', 'b', 'c'], 'b', -5)).toEqual(['b', 'a', 'c'])
    expect(moveTrack(['a', 'b', 'c'], 'z', 0)).toEqual(['a', 'b', 'c'])
    expect(shiftTrack(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(shiftTrack(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(shiftTrack(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })

  it('drops paths the library lost, taking its spelling', () => {
    const lib = [t('Artist/Song.mp3'), t('b.mp3')]
    expect(prunePlaylist(['artist/song.mp3', 'gone.mp3', 'b.mp3'], lib)).toEqual([
      'Artist/Song.mp3',
      'b.mp3'
    ])
    expect(playlistTracks(['b.mp3', 'gone.mp3', 'ARTIST/song.mp3'], lib)).toEqual([lib[1], lib[0]])
  })

  it('compares playlists', () => {
    expect(samePlaylist(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(samePlaylist(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(samePlaylist(['a'], ['a', 'b'])).toBe(false)
  })
})
