import type { Game, Platform } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { heroMetaParts } from './heroMeta'

const steam: Platform = { id: 'steam', name: 'Steam', kind: 'store', icon: 'steam', sortOrder: 1 }

function game(overrides: Partial<Game>): Game {
  return {
    id: 'steam:1',
    source: 'steam',
    externalId: '1',
    platformId: 'steam',
    title: 'Game',
    sortTitle: 'game',
    installed: true,
    launch: { kind: 'uri', uri: 'steam://rungameid/1' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...overrides
  }
}

describe('heroMetaParts', () => {
  it('builds the full line from play time, first genre, release year and platform', () => {
    const parts = heroMetaParts(
      game({
        playtimeMinutes: 1000,
        storePlaytimeMinutes: 176,
        metadata: { genres: ['RPG', 'Action'], releaseDate: '2026-03-12' }
      }),
      [steam]
    )
    expect(parts).toEqual(['Played 19.6 hours', 'RPG', '2026', 'Steam'])
  })

  it('leaves out unknown parts and falls back to a capitalised platform id', () => {
    expect(heroMetaParts(game({ platformId: 'snes' }), [])).toEqual(['Snes'])
  })

  it('skips blank genres and a zero play time', () => {
    const parts = heroMetaParts(
      game({ metadata: { genres: ['  ', 'Puzzle'], releaseDate: '2019' } }),
      [steam]
    )
    expect(parts).toEqual(['Puzzle', '2019', 'Steam'])
  })
})
