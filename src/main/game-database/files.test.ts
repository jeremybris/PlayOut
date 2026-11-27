import { describe, expect, it } from 'vitest'
import { GAME_DB_RELEASE_DATE_RE } from '../../shared/game-database'
import { RELEASE_DATE_RE } from '../metadata-edits/schema'
import {
  enqueueGame,
  isShardPath,
  MAX_QUEUED_GAMES,
  normalizeIndex,
  normalizeQueue,
  normalizeSent
} from './files'

const AT = '2026-11-24T12:00:00.000Z'

describe('game database files', () => {
  // Here rather than in shared/game-database.test.ts: the renderer's project, which includes shared/, cannot import
  // main/.
  it('uses the same release date rule as the metadata editor', () => {
    expect(GAME_DB_RELEASE_DATE_RE.source).toBe(RELEASE_DATE_RE.source)
  })

  it('accepts only shard paths inside data/', () => {
    expect(isShardPath('data/steam/03.csv')).toBe(true)
    expect(isShardPath('data/rom/15.csv')).toBe(true)
    expect(isShardPath('data/../x/03.csv')).toBe(false)
    expect(isShardPath('data/steam/3.csv')).toBe(false)
    expect(isShardPath('../data/steam/03.csv')).toBe(false)
    expect(isShardPath('data/Steam/03.csv')).toBe(false)
  })

  it('drops damaged index entries, never throws', () => {
    expect(normalizeIndex(null)).toBeNull()
    expect(normalizeIndex([])).toBeNull()
    expect(
      normalizeIndex({
        shards: {
          'data/steam/03.csv': { etag: '"a"', fetchedAt: AT },
          'data/gog/01.csv': { fetchedAt: AT, etag: 5 },
          'data/../evil/01.csv': { fetchedAt: AT },
          'data/ps2/02.csv': { fetchedAt: 'yesterday' },
          'data/psx/04.csv': 'x'
        }
      })
    ).toEqual({
      version: 1,
      shards: {
        'data/steam/03.csv': { etag: '"a"', fetchedAt: AT },
        'data/gog/01.csv': { fetchedAt: AT }
      }
    })
    expect(normalizeIndex({ shards: 'x' })).toEqual({ version: 1, shards: {} })
  })

  it('keeps valid queued games once per key, the newest within the cap', () => {
    expect(
      normalizeQueue({
        items: [
          { gameId: 'steam:620', key: 'steam-620', queuedAt: AT },
          { gameId: 'steam:620', key: 'steam-620', queuedAt: AT },
          { gameId: 'gog:1', key: 'GOG 1', queuedAt: AT },
          { gameId: '', key: 'gog-1' },
          { gameId: 'gog:2', key: 'gog-2' },
          7
        ]
      })
    ).toEqual({
      version: 1,
      items: [
        { gameId: 'steam:620', key: 'steam-620', queuedAt: AT },
        { gameId: 'gog:2', key: 'gog-2', queuedAt: new Date(0).toISOString() }
      ]
    })
    let items = enqueueGame([], { gameId: 'a', key: 'steam-1', queuedAt: AT })
    items = enqueueGame(items, { gameId: 'a', key: 'steam-1', queuedAt: AT })
    expect(items).toHaveLength(1)
    for (let i = 2; i <= MAX_QUEUED_GAMES + 1; i++)
      items = enqueueGame(items, { gameId: `g${i}`, key: `steam-${i}`, queuedAt: AT })
    expect(items).toHaveLength(MAX_QUEUED_GAMES)
    expect(items[0]!.key).toBe('steam-2')
  })

  it('keeps the sent keys with a known result', () => {
    expect(
      normalizeSent({
        keys: {
          'steam-620': { at: AT, result: 'added' },
          'gog-1': { at: AT, result: 'present' },
          'ps2-x': { at: AT, result: 'refused' },
          'ps2-y': { at: AT, result: 'maybe' },
          'Bad Key': { at: AT, result: 'added' },
          'ps2-z': { result: 'added' }
        }
      })
    ).toEqual({
      version: 1,
      keys: {
        'steam-620': { at: AT, result: 'added' },
        'gog-1': { at: AT, result: 'present' },
        'ps2-x': { at: AT, result: 'refused' }
      }
    })
  })
})
