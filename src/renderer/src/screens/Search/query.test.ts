import type { Game, Platform } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { searchLibrary } from './query'

function game(
  id: string,
  title: string,
  platformId: string,
  metadata: Game['metadata'] = {}
): Game {
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId,
    title,
    sortTitle: title.toLowerCase().replace(/^the /, ''),
    installed: true,
    launch: { kind: 'uri', uri: `steam://rungameid/${id}` },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata,
    media: {},
    metadataStatus: 'none',
    user: {}
  }
}

const platforms: Platform[] = [
  { id: 'steam', name: 'Steam', kind: 'store', icon: 'steam', sortOrder: 1 },
  {
    id: 'snes',
    name: 'Super Nintendo',
    shortName: 'SNES',
    kind: 'system',
    icon: 'nintendo',
    sortOrder: 2,
    manufacturer: 'Nintendo'
  }
]

const games: Game[] = [
  game('1', 'Hades', 'steam', { genres: ['Roguelike'], developers: ['Supergiant Games'] }),
  game('2', 'Elden Ring', 'steam', { genres: ['Action RPG'], developers: ['FromSoftware'] }),
  game('3', 'Chrono Trigger', 'snes', { genres: ['RPG'], developers: ['Square'] }),
  game('4', 'Super Metroid', 'snes', { genres: ['Action'], publishers: ['Nintendo'] })
]

describe('searchLibrary', () => {
  it('returns nothing for an empty query', () => {
    expect(searchLibrary(games, platforms, '   ')).toEqual([])
  })

  it('puts title matches before field matches', () => {
    const ids = searchLibrary(games, platforms, 'super').map((g) => g.id)
    // 'Super Metroid' by title first, then Hades (Supergiant) and Chrono Trigger (Super Nintendo).
    expect(ids[0]).toBe('4')
    expect(ids.slice(1).sort()).toEqual(['1', '3'])
  })

  it('matches platform name, short name and manufacturer', () => {
    expect(
      searchLibrary(games, platforms, 'snes')
        .map((g) => g.id)
        .sort()
    ).toEqual(['3', '4'])
    expect(
      searchLibrary(games, platforms, 'nintendo')
        .map((g) => g.id)
        .sort()
    ).toEqual(['3', '4'])
  })

  it('matches genre and developer', () => {
    expect(searchLibrary(games, platforms, 'roguelike').map((g) => g.id)).toEqual(['1'])
    expect(searchLibrary(games, platforms, 'fromsoftware').map((g) => g.id)).toEqual(['2'])
  })

  it('requires every word to match', () => {
    expect(searchLibrary(games, platforms, 'rpg snes').map((g) => g.id)).toEqual(['3'])
    expect(searchLibrary(games, platforms, 'rpg steam').map((g) => g.id)).toEqual(['2'])
  })

  it('never lists a game twice', () => {
    const ids = searchLibrary(games, platforms, 'super nintendo').map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
