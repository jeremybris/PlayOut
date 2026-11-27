import { describe, expect, it } from 'vitest'
import {
  addToPlaylist,
  audioVolume,
  gameStartAction,
  nextIndex,
  previousIndex,
  removeFromPlaylist,
  titleFromPath,
  trackFor,
  trackUrl
} from './music'

describe('overlay music helpers', () => {
  it('encodes the whole relative path into the track URL', () => {
    expect(trackUrl('Artist/Album/01 Song #1.mp3')).toBe(
      'playout-music://track/Artist%2FAlbum%2F01%20Song%20%231.mp3'
    )
  })

  it('makes a track from a path the library does not have', () => {
    expect(titleFromPath('Artist/Album/01 Song.flac')).toBe('01 Song')
    expect(trackFor('Artist/Album/01 Song.flac', new Map())).toEqual({
      path: 'Artist/Album/01 Song.flac',
      title: '01 Song',
      folder: 'Album'
    })
    const known = { path: 'a.mp3', title: 'Known', folder: '' }
    expect(trackFor('a.mp3', new Map([['a.mp3', known]]))).toBe(known)
  })

  it('steps through the queue, wrapping round', () => {
    expect(nextIndex(3, 0, false)).toBe(1)
    expect(nextIndex(3, 2, false)).toBe(0)
    expect(previousIndex(3, 0)).toBe(2)
    expect(nextIndex(0, -1, false)).toBe(-1)
    expect(previousIndex(0, -1)).toBe(-1)
    expect(nextIndex(1, 0, true)).toBe(0)
  })

  it('never shuffles onto the same track', () => {
    for (const r of [0, 0.2, 0.49, 0.5, 0.99]) {
      const next = nextIndex(3, 1, true, () => r)
      expect(next).not.toBe(1)
      expect(next).toBeGreaterThanOrEqual(0)
      expect(next).toBeLessThan(3)
    }
  })

  it('adds a track to the playlist once and removes it', () => {
    expect(addToPlaylist(undefined, 'a')).toEqual(['a'])
    expect(addToPlaylist(['a'], 'a')).toEqual(['a'])
    expect(addToPlaylist(['a'], 'b')).toEqual(['a', 'b'])
    expect(removeFromPlaylist(['a', 'b'], 'a')).toEqual(['b'])
    expect(removeFromPlaylist(undefined, 'a')).toEqual([])
  })

  it('follows settings.music.gameStart only when the game has a playlist', () => {
    expect(gameStartAction('keep', ['a'])).toBe('none')
    expect(gameStartAction('play', [])).toBe('none')
    expect(gameStartAction('play', undefined)).toBe('none')
    expect(gameStartAction('play', ['a'])).toBe('play')
    expect(gameStartAction('load', ['a'])).toBe('load')
  })

  it('clamps the volume', () => {
    expect(audioVolume(2)).toBe(1)
    expect(audioVolume(-1)).toBe(0)
    expect(audioVolume(Number.NaN)).toBe(0.6)
  })
})
