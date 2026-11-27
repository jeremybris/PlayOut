import type { Game, Platform, Settings } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { describe, expect, it } from 'vitest'
import {
  displayTitle,
  hiddenGames,
  favoriteGames,
  gamesByPlatform,
  recentGames,
  searchGames,
  visibleGames
} from './library'

function game(id: string, patch: Partial<Game> = {}): Game {
  const title = patch.title ?? id
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId: 'steam',
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
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...patch
  }
}

const PLATFORMS: Platform[] = [
  { id: 'snes', name: 'Super Nintendo', kind: 'system', icon: 'nintendo', sortOrder: 120 },
  { id: 'steam', name: 'Steam', kind: 'store', icon: 'steam', sortOrder: 10 },
  { id: 'epic', name: 'Epic Games', kind: 'store', icon: 'epicgames', sortOrder: 20 }
]

function settings(patch: Partial<Settings['library']> = {}): Settings {
  const s = defaultSettings()
  s.library = { ...s.library, ...patch }
  return s
}

describe('displayTitle', () => {
  it('prefers a non-blank user override', () => {
    expect(displayTitle(game('a', { title: 'Scanned', user: { titleOverride: 'Mine' } }))).toBe(
      'Mine'
    )
    expect(displayTitle(game('a', { title: 'Scanned', user: { titleOverride: '   ' } }))).toBe(
      'Scanned'
    )
    expect(displayTitle(game('a', { title: 'Scanned' }))).toBe('Scanned')
  })
})

describe('hiddenGames', () => {
  const games = [
    game('shown'),
    game('hidden', { hidden: true }),
    game('hidden-uninstalled', { hidden: true, installed: false })
  ]
  it('lists hidden games whatever showHidden says, and follows showUninstalled', () => {
    expect(hiddenGames(games, settings()).map((g) => g.id)).toEqual([
      'hidden',
      'hidden-uninstalled'
    ])
    expect(hiddenGames(games, settings({ showUninstalled: false })).map((g) => g.id)).toEqual([
      'hidden'
    ])
  })
})

describe('visibleGames', () => {
  const games = [
    game('installed'),
    game('uninstalled', { installed: false }),
    game('hidden', { hidden: true }),
    game('hidden-uninstalled', { hidden: true, installed: false })
  ]
  it('shows installed and uninstalled, non-hidden games by default (greyed owned games)', () => {
    expect(visibleGames(games, settings()).map((g) => g.id)).toEqual(['installed', 'uninstalled'])
    expect(visibleGames(games, null).map((g) => g.id)).toEqual(['installed', 'uninstalled'])
  })
  it('honours showUninstalled and showHidden', () => {
    expect(visibleGames(games, settings({ showUninstalled: false })).map((g) => g.id)).toEqual([
      'installed'
    ])
    expect(visibleGames(games, settings({ showHidden: true })).map((g) => g.id)).toEqual([
      'installed',
      'uninstalled',
      'hidden',
      'hidden-uninstalled'
    ])
    expect(
      visibleGames(games, settings({ showHidden: true, showUninstalled: false })).map((g) => g.id)
    ).toEqual(['installed', 'hidden'])
  })
})

describe('recentGames', () => {
  const games = [
    game('never-old', { addedAt: '2026-01-01T00:00:00.000Z' }),
    game('played-early', { lastPlayed: '2026-03-01T00:00:00.000Z' }),
    game('never-new', { addedAt: '2026-02-01T00:00:00.000Z' }),
    game('played-late', { lastPlayed: '2026-04-01T00:00:00.000Z' })
  ]
  it('orders by lastPlayed desc, then addedAt desc', () => {
    expect(recentGames(games, 10).map((g) => g.id)).toEqual([
      'played-late',
      'played-early',
      'never-new',
      'never-old'
    ])
  })
  it('limits to count and does not mutate the input', () => {
    const copy = [...games]
    expect(recentGames(games, 2).map((g) => g.id)).toEqual(['played-late', 'played-early'])
    expect(games).toEqual(copy)
    expect(recentGames(games, 0)).toEqual([])
  })
})

describe('gamesByPlatform', () => {
  it('groups in platform sortOrder, alphabetical by sortTitle, only platforms with games', () => {
    const games = [
      game('z', { platformId: 'snes', title: 'Zelda', sortTitle: 'zelda' }),
      game('t', { platformId: 'steam', title: 'The Witcher', sortTitle: 'witcher' }),
      game('a', { platformId: 'steam', title: 'Alan Wake', sortTitle: 'alan wake' }),
      game('c', { platformId: 'snes', title: 'Chrono Trigger', sortTitle: 'chrono trigger' })
    ]
    const groups = gamesByPlatform(games, PLATFORMS)
    expect(groups.map((g) => g.platform.id)).toEqual(['steam', 'snes'])
    expect(groups[0]!.games.map((g) => g.id)).toEqual(['a', 't'])
    expect(groups[1]!.games.map((g) => g.id)).toEqual(['c', 'z'])
  })
  it('makes a synthetic platform for unknown ids and appends it', () => {
    const groups = gamesByPlatform(
      [game('x', { platformId: 'mystery' }), game('s', { platformId: 'steam' })],
      PLATFORMS
    )
    expect(groups.map((g) => g.platform.id)).toEqual(['steam', 'mystery'])
    expect(groups[1]!.platform.name).toBe('Mystery')
  })
  it('returns no groups for an empty library', () => {
    expect(gamesByPlatform([], PLATFORMS)).toEqual([])
  })
})

describe('searchGames', () => {
  const games = [
    game('hades', { title: 'Hades' }),
    game('hd2', { title: 'Helldivers 2' }),
    game('pokemon', { title: 'Pokémon Rouge', sortTitle: 'pokémon rouge' }),
    game('override', { title: 'Scanned name', user: { titleOverride: 'Override Name' } })
  ]
  it('returns nothing for an empty query', () => {
    expect(searchGames(games, '')).toEqual([])
    expect(searchGames(games, '   ')).toEqual([])
  })
  it('matches case- and accent-insensitively and ranks prefix matches first', () => {
    expect(searchGames(games, 'pokemon').map((g) => g.id)).toEqual(['pokemon'])
    expect(searchGames(games, 'H').map((g) => g.id)).toEqual(['hades', 'hd2'])
    expect(searchGames(games, 'divers').map((g) => g.id)).toEqual(['hd2'])
  })
  it('requires every word and searches the override title', () => {
    expect(searchGames(games, 'hell 2').map((g) => g.id)).toEqual(['hd2'])
    expect(searchGames(games, 'hell 3')).toEqual([])
    expect(searchGames(games, 'override').map((g) => g.id)).toEqual(['override'])
    expect(searchGames(games, 'scanned').map((g) => g.id)).toEqual(['override'])
  })
})

describe('favoriteGames', () => {
  it('keeps favourites, alphabetical', () => {
    const games = [
      game('b', { title: 'Beta', favorite: true }),
      game('n', { title: 'Nope' }),
      game('a', { title: 'Alpha', favorite: true })
    ]
    expect(favoriteGames(games).map((g) => g.id)).toEqual(['a', 'b'])
  })
})
