import type { Game, Platform } from '@shared/types'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../i18n'
import { gamesByPlatform } from './library'
import {
  MAX_FILTER_CHOICES,
  filterChoiceCount,
  limitedChoiceCount,
  toggleChoice,
  LIBRARY_ALL_TAB,
  LIBRARY_OTHER_TAB,
  LIBRARY_SETTINGS_TAB,
  LIBRARY_SORT_OPTIONS,
  MAX_PLATFORM_TABS,
  activePlayersOf,
  filterLibrary,
  gridColumns,
  isPlayable,
  libraryGenres,
  libraryTabs,
  playableFirstOrder,
  sortLibrary,
  stepTab,
  tabLabel,
  gameReviewOf,
  gameDifficultyOf,
  librarySortOptions
} from './libraryView'

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
  {
    id: 'snes',
    name: 'Nintendo SNES (Super Nintendo)',
    kind: 'system',
    icon: 'nintendo',
    sortOrder: 120
  },
  { id: 'steam', name: 'Steam', kind: 'store', icon: 'steam', sortOrder: 10 },
  {
    id: 'epic',
    name: 'Epic Games',
    shortName: 'Epic',
    kind: 'store',
    icon: 'epicgames',
    sortOrder: 20
  }
]

const GB = 1024 ** 3

const GAMES: Game[] = [
  game('hades', {
    title: 'Hades',
    metadata: { genres: ['Roguelike', 'Action'], developers: ['Supergiant Games'] },
    lastPlayed: '2026-03-01T00:00:00.000Z',
    playtimeMinutes: 600
  }),
  game('elden', {
    title: 'Elden Ring',
    metadata: {
      genres: ['RPG'],
      developers: ['FromSoftware'],
      steamTags: { tags: ['Souls-like', 'Open World'] }
    },
    lastPlayed: '2026-04-01T00:00:00.000Z',
    playtimeMinutes: 100,
    storePlaytimeMinutes: 2000,
    addedAt: '2026-02-01T00:00:00.000Z'
  }),
  game('alan', {
    title: 'Alan Wake 2',
    platformId: 'epic',
    installed: false,
    metadata: { genres: ['Horror', 'action'], developers: ['Remedy'] },
    lastPlayed: '2026-05-01T00:00:00.000Z',
    addedAt: '2026-03-01T00:00:00.000Z'
  }),
  game('mario', {
    title: 'Super Mario World',
    platformId: 'snes',
    metadata: { genres: ['Platformer'] },
    addedAt: '2026-04-01T00:00:00.000Z'
  })
]

describe('libraryTabs', () => {
  it('starts with Settings and All Games, then follows the platform groups in sortOrder', () => {
    const tabs = libraryTabs(gamesByPlatform(GAMES, PLATFORMS))
    expect(tabs.map((t) => t.id)).toEqual([
      LIBRARY_SETTINGS_TAB,
      LIBRARY_ALL_TAB,
      'steam',
      'epic',
      'snes'
    ])
    expect(tabs.map((t) => t.label)).toEqual([
      'Settings',
      'All Games',
      'Steam',
      'Epic',
      'Nintendo SNES'
    ])
    expect(tabs[0]?.platform).toBeUndefined()
    expect(tabs[2]?.platform?.id).toBe('steam')
    // An empty library still has the two fixed tabs.
    expect(libraryTabs([]).map((t) => t.id)).toEqual([LIBRARY_SETTINGS_TAB, LIBRARY_ALL_TAB])
  })

  it('folds the smallest platforms into Other once more than six groups have games', () => {
    // Eight platforms, platform `pN` holding N games, in sortOrder p1..p8: p8..p4 keep a tab, p1..p3 fold.
    const platforms: Platform[] = []
    const games: Game[] = []
    for (let n = 1; n <= MAX_PLATFORM_TABS + 3; n++) {
      platforms.push({ id: `p${n}`, name: `P${n}`, kind: 'system', icon: 'x', sortOrder: n })
      for (let i = 0; i < n; i++) games.push(game(`g${n}-${i}`, { platformId: `p${n}` }))
    }
    const tabs = libraryTabs(gamesByPlatform(games, platforms))
    expect(tabs.map((t) => t.id)).toEqual([
      LIBRARY_SETTINGS_TAB,
      LIBRARY_ALL_TAB,
      'p4',
      'p5',
      'p6',
      'p7',
      'p8',
      LIBRARY_OTHER_TAB
    ])
    expect(tabs.at(-1)).toEqual({ id: 'other', label: 'Other', platformIds: ['p1', 'p2', 'p3'] })
    // Exactly MAX + 1 groups: every platform keeps its tab (an Other tab holding one platform is pointless);
    // the Settings tab never counts as a platform tab.
    const six = libraryTabs(gamesByPlatform(games, platforms).slice(0, MAX_PLATFORM_TABS + 1))
    expect(six).toHaveLength(MAX_PLATFORM_TABS + 3)
    expect(six.some((t) => t.id === LIBRARY_OTHER_TAB)).toBe(false)
  })

  it('breaks game-count ties in favour of the earlier (sortOrder) group', () => {
    const platforms: Platform[] = []
    const games: Game[] = []
    for (let n = 1; n <= MAX_PLATFORM_TABS + 2; n++) {
      platforms.push({ id: `p${n}`, name: `P${n}`, kind: 'store', icon: 'x', sortOrder: n })
      games.push(game(`g${n}`, { platformId: `p${n}` }))
    }
    const tabs = libraryTabs(gamesByPlatform(games, platforms))
    expect(tabs.map((t) => t.id)).toEqual([
      LIBRARY_SETTINGS_TAB,
      LIBRARY_ALL_TAB,
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
      LIBRARY_OTHER_TAB
    ])
    expect(tabs.at(-1)?.platformIds).toEqual(['p6', 'p7'])
  })

  it('strips only a trailing parenthetical from system names', () => {
    expect(tabLabel({ ...PLATFORMS[0]!, name: 'Sony PlayStation' })).toBe('Sony PlayStation')
    expect(tabLabel({ ...PLATFORMS[0]!, name: '(odd)' })).toBe('(odd)')
  })

  it('prefers the platform short name and ignores a blank one', () => {
    expect(tabLabel({ ...PLATFORMS[0]!, shortName: 'SNES' })).toBe('SNES')
    expect(tabLabel({ ...PLATFORMS[0]!, shortName: '  ' })).toBe('Nintendo SNES')
    expect(tabLabel(PLATFORMS[2]!)).toBe('Epic')
  })

  it('steps between tabs, wrapping around the ends; LB from All Games lands on Settings', () => {
    const tabs = libraryTabs(gamesByPlatform(GAMES, PLATFORMS))
    expect(stepTab(tabs, LIBRARY_ALL_TAB, 1)).toBe('steam')
    expect(stepTab(tabs, LIBRARY_ALL_TAB, -1)).toBe(LIBRARY_SETTINGS_TAB)
    // LB on Settings (the first tab) goes to the last; RB on the last goes to Settings.
    expect(stepTab(tabs, LIBRARY_SETTINGS_TAB, -1)).toBe('snes')
    expect(stepTab(tabs, LIBRARY_SETTINGS_TAB, 1)).toBe(LIBRARY_ALL_TAB)
    expect(stepTab(tabs, 'snes', 1)).toBe(LIBRARY_SETTINGS_TAB)
    expect(stepTab(tabs, 'unknown', 1)).toBe(LIBRARY_ALL_TAB)
    expect(stepTab([], 'x', 1)).toBe('x')
  })
})

describe('libraryGenres', () => {
  it('lists every genre once, case-insensitively, sorted', () => {
    expect(libraryGenres(GAMES)).toEqual(['Action', 'Horror', 'Platformer', 'Roguelike', 'RPG'])
  })
})

describe('filterLibrary', () => {
  const all = { tab: LIBRARY_ALL_TAB, query: '', genres: [] as string[] }

  it('keeps everything with the default filters, in the given order', () => {
    expect(filterLibrary(GAMES, all).map((g) => g.id)).toEqual(['hades', 'elden', 'alan', 'mario'])
  })

  it('filters by tab (platform id)', () => {
    expect(filterLibrary(GAMES, { ...all, tab: 'epic' }).map((g) => g.id)).toEqual(['alan'])
  })

  it('shows the folded platforms, and nothing else, on the Other tab', () => {
    const other = { ...all, tab: LIBRARY_OTHER_TAB }
    expect(filterLibrary(GAMES, { ...other, folded: ['snes', 'epic'] }).map((g) => g.id)).toEqual([
      'alan',
      'mario'
    ])
    expect(filterLibrary(GAMES, { ...other, folded: [] })).toEqual([])
    expect(filterLibrary(GAMES, other)).toEqual([])
  })

  it('matches every query word against title, genre or developer', () => {
    expect(filterLibrary(GAMES, { ...all, query: 'rogue' }).map((g) => g.id)).toEqual(['hades'])
    expect(filterLibrary(GAMES, { ...all, query: 'FROM' }).map((g) => g.id)).toEqual(['elden'])
    expect(filterLibrary(GAMES, { ...all, query: 'action wake' }).map((g) => g.id)).toEqual([
      'alan'
    ])
    expect(filterLibrary(GAMES, { ...all, query: 'nothing here' })).toEqual([])
  })

  it('keeps games with any of the Filters > Genre choices, by Steam tag or by genre', () => {
    expect(filterLibrary(GAMES, { ...all, tags: ['open world'] }).map((g) => g.id)).toEqual([
      'elden'
    ])
    // Alan Wake 2 has no Steam tags, but its genre is Horror.
    expect(filterLibrary(GAMES, { ...all, tags: ['horror'] }).map((g) => g.id)).toEqual(['alan'])
    expect(filterLibrary(GAMES, { ...all, tags: ['stealth'] })).toEqual([])
  })

  it('keeps games from any of the Filters > PC stores', () => {
    const epic = { ...GAMES[2]!, source: 'epic' as const }
    const games = [GAMES[0]!, epic]
    expect(filterLibrary(games, { ...all, stores: ['epic'] }).map((g) => g.id)).toEqual(['alan'])
    expect(filterLibrary(games, { ...all, stores: ['epic', 'steam'] }).map((g) => g.id)).toEqual([
      'hades',
      'alan'
    ])
    expect(filterLibrary(games, { ...all, stores: ['gog'] })).toEqual([])
  })

  it('finds games by their Steam tags', () => {
    expect(filterLibrary(GAMES, { ...all, query: 'souls' }).map((g) => g.id)).toEqual(['elden'])
    expect(filterLibrary(GAMES, { ...all, query: 'open world' }).map((g) => g.id)).toEqual([
      'elden'
    ])
  })

  it('filters by genre case-insensitively and combines with the tab', () => {
    expect(filterLibrary(GAMES, { ...all, genres: ['action'] }).map((g) => g.id)).toEqual([
      'hades',
      'alan'
    ])
    expect(
      filterLibrary(GAMES, { ...all, tab: 'steam', genres: ['Action'] }).map((g) => g.id)
    ).toEqual(['hades'])
  })

  it('keeps a game with any of several genres picked', () => {
    expect(
      filterLibrary(GAMES, { ...all, genres: ['RPG', 'platformer'] }).map((g) => g.id)
    ).toEqual(['elden', 'mario'])
  })
})

describe('Filters menu choices', () => {
  it('turns a choice off when it is picked again', () => {
    expect(toggleChoice([], 'gb-1-5')).toEqual(['gb-1-5'])
    expect(toggleChoice(['gb-1-5', 'gb-5-15'], 'gb-1-5')).toEqual(['gb-5-15'])
    expect(toggleChoice(['RPG'], 'Action')).toEqual(['RPG', 'Action'])
  })

  it('counts every choice, Hidden and Favorites included, against the limit of 3', () => {
    expect(MAX_FILTER_CHOICES).toBe(3)
    const none = {
      genres: [],
      tags: [],
      stores: [],
      sizes: [],
      hltb: [],
      hidden: false,
      favorites: false
    }
    expect(filterChoiceCount(none)).toBe(0)
    expect(filterChoiceCount({ ...none, genres: ['RPG', 'Action'], sizes: ['gb-1-5'] })).toBe(3)
    expect(filterChoiceCount({ ...none, hltb: ['h-3-10'], hidden: true, favorites: true })).toBe(3)
    expect(
      filterChoiceCount({ ...none, eras: ['y-1990-2000', 'y-2020-2025'], favorites: true })
    ).toBe(3)
    expect(filterChoiceCount({ ...none, coop: true, favorites: true })).toBe(2)
    expect(filterChoiceCount({ ...none, coop: true, recomp: true, favorites: true })).toBe(3)
    // Platform and PC count once each, however many are picked.
    expect(
      filterChoiceCount({
        ...none,
        platforms: ['snes', 'n64', 'gba', 'psx'],
        stores: ['epic', 'gog', 'xbox']
      })
    ).toBe(2)
  })

  it("counts a game page's developers and publishers in the number, but not against the limit", () => {
    const none = {
      tags: [],
      stores: [],
      sizes: [],
      hltb: [],
      hidden: false,
      favorites: false
    }
    const creators = { ...none, developers: ['Atlus', 'Sega'], publishers: ['Sega'] }
    // The pill's number and Clear filters (a developer-only tab has one choice on).
    expect(filterChoiceCount(creators)).toBe(3)
    expect(filterChoiceCount({ ...none, developers: ['Atlus'] })).toBe(1)
    // Not toward MAX_FILTER_CHOICES: the menu is not full.
    expect(limitedChoiceCount(creators)).toBe(0)
    const two = { ...creators, tags: ['rpg'], favorites: true }
    expect(filterChoiceCount(two)).toBe(5)
    expect(limitedChoiceCount(two)).toBe(2)
    expect(limitedChoiceCount(two) >= MAX_FILTER_CHOICES).toBe(false)
  })
})

describe('sortLibrary', () => {
  afterEach(() => setLanguage('en'))

  it('has a label for every sort order', () => {
    // A-Z (the default) first; Playable First is gone (the playable-first button took its place).
    expect(LIBRARY_SORT_OPTIONS.map((o) => o.value)).toEqual([
      'title-asc',
      'recent',
      'most-played',
      'players',
      'reviews',
      'added',
      'release',
      'size',
      'difficulty',
      'hltb'
    ])
    expect(LIBRARY_SORT_OPTIONS.find((o) => o.value === 'players')?.label).toBe('Popularity')
    expect(LIBRARY_SORT_OPTIONS.find((o) => o.value === 'reviews')?.label).toBe('Reviews')
    expect(LIBRARY_SORT_OPTIONS.find((o) => o.value === 'size')?.label).toBe('Size')
    expect(LIBRARY_SORT_OPTIONS.find((o) => o.value === 'release')?.label).toBe('Release')
    expect(LIBRARY_SORT_OPTIONS.find((o) => o.value === 'hltb')?.label).toBe('H.L.T.B.')
  })

  it('lists the Sort menu alphabetically in English', () => {
    expect(librarySortOptions().map((o) => [o.value, o.label])).toEqual([
      ['title-asc', 'A-Z'],
      ['difficulty', 'Difficulty'],
      ['hltb', 'H.L.T.B.'],
      ['most-played', 'Played - Most'],
      ['recent', 'Played - Recently'],
      ['players', 'Popularity'],
      ['added', 'Recently Added'],
      ['release', 'Release'],
      ['reviews', 'Reviews'],
      ['size', 'Size']
    ])
  })

  it('lists the Sort menu alphabetically in Spanish', () => {
    setLanguage('es')
    expect(librarySortOptions().map((o) => [o.value, o.label])).toEqual([
      ['title-asc', 'A-Z'],
      ['added', 'Añadidos recientemente'],
      ['difficulty', 'Dificultad'],
      ['hltb', 'H.L.T.B.'],
      ['most-played', 'Jugados - Más'],
      ['recent', 'Jugados - Recientes'],
      ['release', 'Lanzamiento'],
      ['players', 'Popularidad'],
      ['reviews', 'Reseñas'],
      ['size', 'Tamaño']
    ])
    // Every sort order once, whatever the language.
    expect(new Set(librarySortOptions().map((o) => o.value))).toEqual(
      new Set(LIBRARY_SORT_OPTIONS.map((o) => o.value))
    )
  })

  it('sorts by difficulty, hardest first, ties alphabetical; reversed easiest first', () => {
    const games = [
      game('medium-b', { title: 'Bravo' }),
      game('story', { title: 'Story', metadata: { difficulty: 'story' } }),
      game('medium-a', { title: 'Alpha' }),
      game('hard-tag', { title: 'Souls', metadata: { steamTags: { tags: ['Souls-like'] } } }),
      game('impossible', { title: 'Cup', metadata: { difficulty: 'impossible' } }),
      game('easy', { title: 'Easy', metadata: { difficulty: 'easy' } }),
      // A pick beats a tag.
      game('picked', {
        title: 'Picked',
        metadata: { difficulty: 'hard', steamTags: { tags: ['Casual'] } }
      })
    ]
    expect(sortLibrary(games, 'difficulty').map((g) => g.id)).toEqual([
      'impossible',
      'picked',
      'hard-tag',
      'medium-a',
      'medium-b',
      'easy',
      'story'
    ])
    expect(sortLibrary(games, 'difficulty', true).map((g) => g.id)).toEqual([
      'story',
      'easy',
      'medium-a',
      'medium-b',
      'picked',
      'hard-tag',
      'impossible'
    ])
    expect(gameDifficultyOf(games[0]!)).toBe('medium')
  })

  it('sorts the N/A (Tools) games (Steam tag Utilities) last both ways, alphabetical; a pick puts one on its level', () => {
    const games = [
      game('tool-z', { title: 'Zed Tool', metadata: { steamTags: { tags: ['Utilities'] } } }),
      game('story', { title: 'Story', metadata: { difficulty: 'story' } }),
      game('tool-a', {
        title: 'Alpha Tool',
        metadata: { steamTags: { tags: ['Utilities', 'Casual'] } }
      }),
      game('impossible', { title: 'Cup', metadata: { difficulty: 'impossible' } }),
      game('picked-tool', {
        title: 'Picked Tool',
        metadata: { difficulty: 'hard', steamTags: { tags: ['Utilities'] } }
      })
    ]
    expect(sortLibrary(games, 'difficulty').map((g) => g.id)).toEqual([
      'impossible',
      'picked-tool',
      'story',
      'tool-a',
      'tool-z'
    ])
    expect(sortLibrary(games, 'difficulty', true).map((g) => g.id)).toEqual([
      'story',
      'picked-tool',
      'impossible',
      'tool-a',
      'tool-z'
    ])
    expect(gameDifficultyOf(games[0]!)).toBe('tools')
    expect(gameDifficultyOf(games[4]!)).toBe('hard')
  })

  it('sorts by H.L.T.B. time, shortest first, ties alphabetical, games without a time last', () => {
    const hltb = (main?: number, solo?: number): Partial<Game> => ({
      metadata: { hltb: { main, solo } } as Game['metadata']
    })
    const games = [
      game('long', { title: 'Long', ...hltb(80) }),
      game('none-b', { title: 'Bravo' }),
      game('short-b', { title: 'Bee', ...hltb(2) }),
      game('missed', {
        title: 'Alpha',
        metadata: { hltb: { missedAt: '2026-01-01T00:00:00.000Z' } } as Game['metadata']
      }),
      game('short-a', { title: 'Ant', ...hltb(2) }),
      // No Main Story time: its Solo time, as the H.L.T.B. filter reads it.
      game('solo', { title: 'Solo', ...hltb(undefined, 12) })
    ]
    expect(sortLibrary(games, 'hltb').map((g) => g.id)).toEqual([
      'short-a',
      'short-b',
      'solo',
      'long',
      'missed',
      'none-b'
    ])
    // Picked again: longest first, ties still A to Z, games without a time still last (A to Z).
    expect(sortLibrary(games, 'hltb', true).map((g) => g.id)).toEqual([
      'long',
      'solo',
      'short-a',
      'short-b',
      'missed',
      'none-b'
    ])
  })

  it('sorts by the H.L.T.B. time it is given (a card looking at its other copies)', () => {
    const a = game('a', { title: 'A', installed: false })
    const b = game('b', { title: 'B', installed: false })
    const c = game('c', { title: 'C', installed: false })
    // b has no time of its own; its other copy has 5 hours.
    const of = (g: Game): number | undefined => (g.id === 'b' ? 5 : g.id === 'c' ? 9 : undefined)
    const args = [undefined, undefined, false, undefined, undefined, undefined, of] as const
    expect(sortLibrary([a, b, c], 'hltb', false, ...args).map((g) => g.id)).toEqual(['b', 'c', 'a'])
    expect(sortLibrary([a, b, c], 'hltb', true, ...args).map((g) => g.id)).toEqual(['c', 'b', 'a'])
    // Playable first: each part in the sort's order, unknown last within it.
    const installed = game('d', { title: 'D', installed: true })
    expect(
      sortLibrary(
        [a, b, c, installed],
        'hltb',
        false,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        of
      ).map((g) => g.id)
    ).toEqual(['d', 'b', 'c', 'a'])
  })

  it('sorts by the difficulty it is given (a card looking at its other copies)', () => {
    const a = game('a', { title: 'A' })
    const b = game('b', { title: 'B' })
    const of = (g: Game): 'hard' | 'medium' => (g.id === 'b' ? 'hard' : 'medium')
    const sorted = sortLibrary(
      [a, b],
      'difficulty',
      false,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      of
    )
    expect(sorted.map((g) => g.id)).toEqual(['b', 'a'])
    const reversed = sortLibrary(
      [a, b],
      'difficulty',
      true,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      of
    )
    expect(reversed.map((g) => g.id)).toEqual(['a', 'b'])
  })

  it('sorts by release date, newest first, games without one last either way', () => {
    const games = [
      game('old', { metadata: { releaseDate: '1998-03-31' } }),
      game('none'),
      game('new', { metadata: { releaseDate: '2024-06-13' } }),
      game('year', { metadata: { releaseDate: '2020' } }),
      game('later2020', { metadata: { releaseDate: '2020-09-17' } })
    ]
    expect(sortLibrary(games, 'release').map((g) => g.id)).toEqual([
      'new',
      'later2020',
      'year',
      'old',
      'none'
    ])
    expect(sortLibrary(games, 'release', true).map((g) => g.id)).toEqual([
      'old',
      'year',
      'later2020',
      'new',
      'none'
    ])
  })

  it("sorts a card by another copy's release date when its own has none", () => {
    const own = game('own')
    const other = game('other', { metadata: { releaseDate: '2010-01-01' } })
    const dates = new Map([['own', Date.UTC(2015, 0, 1)]])
    expect(
      sortLibrary(
        [other, own],
        'release',
        false,
        undefined,
        (g) => dates.get(g.id) ?? Date.UTC(2010, 0, 1)
      ).map((g) => g.id)
    ).toEqual(['own', 'other'])
  })

  it('reproduces the old Playable First order with Recently played and playable first on', () => {
    // Installed first by last played, then the rest (alan: not installed, played; mario: installed, never played).
    expect(
      sortLibrary(GAMES, 'recent', false, undefined, undefined, true).map((g) => g.id)
    ).toEqual(['elden', 'hades', 'mario', 'alan'])
  })

  it('sorts by last played, title, play time and date added', () => {
    expect(sortLibrary(GAMES, 'recent').map((g) => g.id)).toEqual([
      'alan',
      'elden',
      'hades',
      'mario'
    ])
    expect(sortLibrary(GAMES, 'title-asc').map((g) => g.id)).toEqual([
      'alan',
      'elden',
      'hades',
      'mario'
    ])
    expect(sortLibrary(GAMES, 'title-asc', true).map((g) => g.id)).toEqual([
      'mario',
      'hades',
      'elden',
      'alan'
    ])
    expect(sortLibrary(GAMES, 'most-played').map((g) => g.id)).toEqual([
      'elden',
      'hades',
      'alan',
      'mario'
    ])
    expect(sortLibrary(GAMES, 'added').map((g) => g.id)).toEqual([
      'mario',
      'alan',
      'elden',
      'hades'
    ])
  })

  it('does not mutate its input', () => {
    const copy = [...GAMES]
    for (const sort of LIBRARY_SORT_OPTIONS.map((o) => o.value)) {
      sortLibrary(GAMES, sort)
      sortLibrary(GAMES, sort, true)
    }
    expect(GAMES).toEqual(copy)
  })

  it('reverses every sort order exactly when reversed', () => {
    for (const sort of LIBRARY_SORT_OPTIONS.map((o) => o.value)) {
      const forward = sortLibrary(GAMES, sort).map((g) => g.id)
      expect(
        sortLibrary(GAMES, sort, false).map((g) => g.id),
        sort
      ).toEqual(forward)
      // No sizes, dates, player counts or review scores known here: covered below.
      // Difficulty keeps each level alphabetical either way (tested on its own); so does H.L.T.B. each time, and its
      // games without a time stay last (tested on its own).
      if (
        sort === 'size' ||
        sort === 'release' ||
        sort === 'players' ||
        sort === 'reviews' ||
        sort === 'difficulty' ||
        sort === 'hltb'
      )
        continue
      expect(
        sortLibrary(GAMES, sort, true).map((g) => g.id),
        sort
      ).toEqual([...forward].reverse())
    }
    // With every size known, the size sort reverses exactly too.
    const sized = GAMES.map((g, i) => ({ ...g, user: { installSize: (i + 1) * GB } }))
    const forward = sortLibrary(sized, 'size').map((g) => g.id)
    expect(forward).toEqual(['mario', 'alan', 'elden', 'hades'])
    expect(sortLibrary(sized, 'size', true).map((g) => g.id)).toEqual([...forward].reverse())
    // With every release date known, the Release Date sort reverses exactly too.
    const dated = GAMES.map((g, i) => ({
      ...g,
      metadata: { ...g.metadata, releaseDate: `${2000 + i}-01-01` }
    }))
    const newest = sortLibrary(dated, 'release').map((g) => g.id)
    expect(sortLibrary(dated, 'release', true).map((g) => g.id)).toEqual([...newest].reverse())
  })

  it('sorts by active players, most first, games without a count last either way', () => {
    const at = '2026-11-25T10:00:00.000Z'
    const players = (count: number): Partial<Game> => ({
      metadata: { currentPlayers: { count, updatedAt: at } }
    })
    const games = [
      game('few', players(12)),
      game('unknown-b', { title: 'B unknown' }),
      game('many', players(500_000)),
      game('none', players(0)),
      game('unknown-a', { title: 'A unknown' }),
      game('tie-z', { title: 'Z tie', ...players(300) }),
      game('tie-a', { title: 'A tie', ...players(300) })
    ]
    expect(sortLibrary(games, 'players').map((g) => g.id)).toEqual([
      'many',
      'tie-a',
      'tie-z',
      'few',
      'none',
      'unknown-a',
      'unknown-b'
    ])
    expect(sortLibrary(games, 'players', true).map((g) => g.id)).toEqual([
      'none',
      'few',
      'tie-z',
      'tie-a',
      'many',
      'unknown-a',
      'unknown-b'
    ])
    // A count that is not a number is no count.
    const bad = game('bad', { metadata: { currentPlayers: { count: Number.NaN, updatedAt: at } } })
    expect(activePlayersOf(bad)).toBeUndefined()
    expect(activePlayersOf(games[3]!)).toBe(0)
  })

  it('sorts by review score, highest first, more reviews then title on a tie, no score last either way', () => {
    const review = (score: number, count?: number): Partial<Game> => ({
      metadata: { reviewScore: { source: 'steam', score, count } }
    })
    const games = [
      game('low', review(41, 9000)),
      game('none-b', { title: 'B none' }),
      game('top', review(97, 10)),
      game('zero', { title: 'A zero', ...review(0, 50) }),
      game('few', { title: 'A few', ...review(85, 20) }),
      game('many', { title: 'Z many', ...review(85, 4000) }),
      game('nocount-z', { title: 'Z nocount', ...review(85) }),
      game('nocount-a', { title: 'A nocount', ...review(85) })
    ]
    expect(sortLibrary(games, 'reviews').map((g) => g.id)).toEqual([
      'top',
      'many',
      'few',
      'nocount-a',
      'nocount-z',
      'low',
      'zero',
      'none-b'
    ])
    expect(sortLibrary(games, 'reviews', true).map((g) => g.id)).toEqual([
      'low',
      'nocount-z',
      'nocount-a',
      'few',
      'many',
      'top',
      'zero',
      'none-b'
    ])
    expect(gameReviewOf(games[4]!)).toEqual({ score: 85, count: 20 })
    expect(gameReviewOf(games[6]!)).toEqual({ score: 85, count: 0 })
    expect(gameReviewOf(games[3]!)).toBeUndefined()
  })

  it('sorts by review score through the accessor it is given (a card using another copy)', () => {
    const a = game('a', { title: 'A' })
    const b = game('b', { title: 'B', metadata: { reviewScore: { score: 60, count: 5 } } })
    const fromCopy = new Map([['a', { score: 90, count: 1 }]])
    const reviewsOf = (g: Game): { score: number; count: number } | undefined =>
      fromCopy.get(g.id) ?? gameReviewOf(g)
    const args = [undefined, undefined, false, undefined, reviewsOf] as const
    expect(sortLibrary([b, a], 'reviews', false, ...args).map((g) => g.id)).toEqual(['a', 'b'])
    expect(sortLibrary([a, b], 'reviews', true, ...args).map((g) => g.id)).toEqual(['b', 'a'])
    expect(sortLibrary([b, a], 'reviews').map((g) => g.id)).toEqual(['b', 'a'])
  })

  it('reverses the title tie-break too', () => {
    const same = ['b', 'c', 'a'].map((id) => game(id, { title: id }))
    for (const sort of ['recent', 'most-played', 'added'] as const) {
      expect(
        sortLibrary(same, sort).map((g) => g.id),
        sort
      ).toEqual(['a', 'b', 'c'])
      expect(
        sortLibrary(same, sort, true).map((g) => g.id),
        sort
      ).toEqual(['c', 'b', 'a'])
    }
  })
})

describe('sortLibrary with playable first', () => {
  const sorted = (
    games: Game[],
    sort: Parameters<typeof sortLibrary>[1],
    reversed = false
  ): string[] => sortLibrary(games, sort, reversed, undefined, undefined, true).map((g) => g.id)

  it('is playable when installed on this PC, not a host game or an owned one to install', () => {
    expect(isPlayable(game('here'))).toBe(true)
    expect(isPlayable(game('owned', { installed: false }))).toBe(false)
    expect(isPlayable(game('remote:host:1', { installed: false }))).toBe(false)
  })

  it('moves the playable games first, each part keeping its order, and never drops one', () => {
    const input = [
      game('a', { installed: false }),
      game('b'),
      game('c', { installed: false }),
      game('d')
    ]
    expect(playableFirstOrder(input).map((g) => g.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(input.map((g) => g.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is the plain sort when off', () => {
    for (const sort of LIBRARY_SORT_OPTIONS.map((o) => o.value)) {
      expect(sortLibrary(GAMES, sort, false, undefined, undefined, false)).toEqual(
        sortLibrary(GAMES, sort)
      )
    }
  })

  it('applies the sort and its direction within each part', () => {
    // alan is the only game not installed.
    expect(sorted(GAMES, 'title-asc')).toEqual(['elden', 'hades', 'mario', 'alan'])
    expect(sorted(GAMES, 'title-asc', true)).toEqual(['mario', 'hades', 'elden', 'alan'])
    expect(sorted(GAMES, 'recent', true)).toEqual(['mario', 'hades', 'elden', 'alan'])
    expect(sorted(GAMES, 'most-played')).toEqual(['elden', 'hades', 'mario', 'alan'])
    expect(sorted(GAMES, 'added')).toEqual(['mario', 'elden', 'hades', 'alan'])
  })

  it('keeps unknown sizes and dates last within each part, reversed too', () => {
    const games = [
      game('un-mid', { title: 'Un Mid', installed: false, user: { installSize: 20 * GB } }),
      game('in-small', { title: 'In Small', user: { installSize: 5 * GB } }),
      game('un-unknown', { title: 'Un Unknown', installed: false }),
      game('in-unknown', { title: 'In Unknown' }),
      game('in-big', { title: 'In Big', user: { installSize: 50 * GB } })
    ]
    expect(sortLibrary(games, 'size').map((g) => g.id)).toEqual([
      'in-big',
      'un-mid',
      'in-small',
      'in-unknown',
      'un-unknown'
    ])
    expect(sorted(games, 'size')).toEqual([
      'in-big',
      'in-small',
      'in-unknown',
      'un-mid',
      'un-unknown'
    ])
    expect(sorted(games, 'size', true)).toEqual([
      'in-small',
      'in-big',
      'in-unknown',
      'un-mid',
      'un-unknown'
    ])
    const dated = [
      game('un-new', { installed: false, metadata: { releaseDate: '2024-01-01' } }),
      game('in-none'),
      game('in-old', { metadata: { releaseDate: '1999-01-01' } }),
      game('un-none', { installed: false }),
      game('in-new', { metadata: { releaseDate: '2020-01-01' } })
    ]
    expect(sorted(dated, 'release')).toEqual(['in-new', 'in-old', 'in-none', 'un-new', 'un-none'])
    expect(sorted(dated, 'release', true)).toEqual([
      'in-old',
      'in-new',
      'in-none',
      'un-new',
      'un-none'
    ])
  })
})

describe('sortLibrary by install size', () => {
  const measuredAt = '2026-11-01T00:00:00.000Z'
  const checkedAt = measuredAt
  const SIZED: Game[] = [
    game('small', { title: 'Small', user: { installSize: 2 * GB } }),
    game('unknown-b', { title: 'Unknown B', installed: false }),
    game('big', {
      title: 'Big',
      installSize: { bytes: 80 * GB, how: 'folder', path: 'C:\\Games\\Big', measuredAt }
    }),
    game('store', {
      title: 'Store',
      installed: false,
      metadata: { storage: { bytes: 20 * GB, how: 'steam', checkedAt } }
    }),
    game('unknown-a', { title: 'Unknown A', installed: false }),
    game('tie', { title: 'Tie', user: { installSize: 20 * GB } })
  ]

  it('puts the largest first, ties by title, unknown sizes last alphabetically', () => {
    expect(sortLibrary(SIZED, 'size').map((g) => g.id)).toEqual([
      'big',
      'store',
      'tie',
      'small',
      'unknown-a',
      'unknown-b'
    ])
  })

  it('puts the smallest first when reversed, unknown sizes still last alphabetically', () => {
    expect(sortLibrary(SIZED, 'size', true).map((g) => g.id)).toEqual([
      'small',
      'tie',
      'store',
      'big',
      'unknown-a',
      'unknown-b'
    ])
  })

  it('lets the size the user entered win over the measured and store sizes', () => {
    const games = [
      game('measured', {
        title: 'Measured',
        installSize: { bytes: 50 * GB, how: 'folder', path: 'C:\\Games\\M', measuredAt }
      }),
      game('user', {
        title: 'User',
        installSize: { bytes: 1 * GB, how: 'folder', path: 'C:\\Games\\U', measuredAt },
        metadata: { storage: { bytes: 2 * GB, how: 'steam', checkedAt } },
        user: { installSize: 90 * GB }
      })
    ]
    expect(sortLibrary(games, 'size').map((g) => g.id)).toEqual(['user', 'measured'])
    expect(sortLibrary(games, 'size', true).map((g) => g.id)).toEqual(['measured', 'user'])
  })

  it('falls back to the store size for an installed game that cannot be measured', () => {
    const games = [
      game('nothing', {
        title: 'Nothing',
        installSize: { bytes: 0, how: 'folder', measuredAt, unmeasurable: true }
      }),
      game('unmeasurable', {
        title: 'Unmeasurable',
        installSize: { bytes: 0, how: 'folder', measuredAt, unmeasurable: true },
        metadata: { storage: { bytes: 40 * GB, how: 'gog', checkedAt } }
      }),
      game('measured', {
        title: 'Measured',
        installSize: { bytes: 10 * GB, how: 'folder', path: 'C:\\Games\\M', measuredAt }
      })
    ]
    expect(sortLibrary(games, 'size').map((g) => g.id)).toEqual([
      'unmeasurable',
      'measured',
      'nothing'
    ])
    expect(sortLibrary(games, 'size', true).map((g) => g.id)).toEqual([
      'measured',
      'unmeasurable',
      'nothing'
    ])
  })
})

describe('gridColumns', () => {
  it('fits six columns at 1080p and five at 1280x800 (inside the 150u side insets)', () => {
    expect(gridColumns(1920 - 300, 240, 36)).toBe(6)
    expect(gridColumns(1280 - 222, 177.8, 26.7)).toBe(5)
  })

  it('never returns fewer than one column and falls back to the maximum when unmeasured', () => {
    expect(gridColumns(100, 240, 36)).toBe(1)
    expect(gridColumns(0, 240, 36)).toBe(6)
  })
})

describe('sortLibrary with a card size', () => {
  it('sorts by the size it is given (a card whose own copy has none uses another copy)', () => {
    const a = { ...GAMES[0]!, id: 'a', title: 'A' }
    const b = { ...GAMES[0]!, id: 'b', title: 'B' }
    const sizes = new Map([
      ['a', 1],
      ['b', 2]
    ])
    expect(sortLibrary([a, b], 'size', false, (g) => sizes.get(g.id)).map((g) => g.id)).toEqual([
      'b',
      'a'
    ])
    expect(sortLibrary([a, b], 'size', true, (g) => sizes.get(g.id)).map((g) => g.id)).toEqual([
      'a',
      'b'
    ])
  })
})
