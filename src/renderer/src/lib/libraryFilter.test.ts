import type { Game, Platform } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  filterTabGroups,
  tabShowsGame,
  type LibrarySources,
  type TabCardFilters
} from './libraryFilter'

/** Whether a Library tab shows a game's card: the grid's filtering, asked by a game page's buttons. */

function game(id: string, patch: Partial<Game> = {}): Game {
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId: 'steam',
    title: id,
    sortTitle: id,
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
  { id: 'steam', name: 'Steam', kind: 'store', icon: 'steam', sortOrder: 10 },
  { id: 'ps2', name: 'PlayStation 2', kind: 'system', icon: 'playstation', sortOrder: 200 }
]

const NONE: TabCardFilters = {
  query: '',
  platforms: [],
  stores: [],
  genres: [],
  tags: [],
  eras: [],
  sizes: [],
  hltb: [],
  controls: [],
  players: [],
  online: [],
  hidden: false,
  favorites: false,
  coop: false,
  recomp: false,
  customFilters: []
}

function sources(games: Game[], patch: Partial<LibrarySources> = {}): LibrarySources {
  return {
    games,
    remote: null,
    platformsById: new Map(PLATFORMS.map((p) => [p.id, p])),
    showUninstalled: true,
    showHidden: false,
    showHostGames: true,
    showDuplicates: false,
    ...patch
  }
}

describe('tabShowsGame', () => {
  const portal = game('portal', { metadata: { developers: ['Valve'], publishers: ['Valve'] } })
  const okami = game('okami', {
    source: 'rom',
    platformId: 'ps2',
    metadata: { developers: ['Clover Studio'], publishers: ['Capcom'] }
  })

  it("shows a game matching the tab's filters, developers included", () => {
    expect(tabShowsGame('portal', sources([portal, okami]), NONE)).toBe(true)
    expect(
      tabShowsGame('portal', sources([portal, okami]), { ...NONE, developers: ['valve'] })
    ).toBe(true)
    expect(
      tabShowsGame('okami', sources([portal, okami]), { ...NONE, developers: ['Valve'] })
    ).toBe(false)
  })

  it('shows only the games of the custom filters picked (any of them), ignoring ids with no filter', () => {
    const customFilters = [
      { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: ['okami'] },
      { id: 'cf2', name: 'Valve', icon: 'star', gameIds: ['portal', 'gone'] }
    ]
    const all = sources([portal, okami])
    const tab = (custom: string[]): TabCardFilters => ({ ...NONE, custom, customFilters })
    expect(tabShowsGame('portal', all, tab(['cf1']))).toBe(false)
    expect(tabShowsGame('okami', all, tab(['cf1']))).toBe(true)
    expect(tabShowsGame('portal', all, tab(['cf1', 'cf2']))).toBe(true)
    // A tab naming a filter this PC does not have (deleted, another PC's) does not narrow.
    expect(tabShowsGame('portal', all, tab(['cf-other']))).toBe(true)
    // Without the filters themselves the picked ids cannot narrow: callers must pass them (the bug this guards).
    expect(tabShowsGame('portal', all, { ...NONE, custom: ['cf1'] })).toBe(true)
  })

  it("does not show a PC game's card on a PS2 tab given its developer", () => {
    const ps2Tab = { ...NONE, platforms: ['ps2'], developers: ['Valve'] }
    expect(tabShowsGame('portal', sources([portal, okami]), ps2Tab)).toBe(false)
    expect(
      tabShowsGame('okami', sources([portal, okami]), {
        ...NONE,
        platforms: ['ps2'],
        developers: ['Clover Studio']
      })
    ).toBe(true)
  })

  it('does not show a hidden game with Show hidden off, unless the tab is Filters > Hidden', () => {
    const hidden = { ...portal, hidden: true }
    const tab = { ...NONE, developers: ['Valve'] }
    expect(tabShowsGame('portal', sources([hidden]), tab)).toBe(false)
    expect(tabShowsGame('portal', sources([hidden], { showHidden: true }), tab)).toBe(true)
    expect(tabShowsGame('portal', sources([hidden]), { ...tab, hidden: true })).toBe(true)
    // Filters > Hidden shows only hidden games.
    expect(tabShowsGame('portal', sources([portal]), { ...tab, hidden: true })).toBe(false)
  })

  it("takes the tab's other filters and search into account", () => {
    const tab = { ...NONE, developers: ['Valve'] }
    expect(tabShowsGame('portal', sources([portal]), { ...tab, favorites: true })).toBe(false)
    expect(tabShowsGame('portal', sources([portal]), { ...tab, query: 'zelda' })).toBe(false)
    expect(tabShowsGame('portal', sources([portal]), { ...tab, query: 'port' })).toBe(true)
    expect(tabShowsGame('missing', sources([portal]), tab)).toBe(false)
  })

  it('L.A.N. Party shows the games main lists as offered PeerParty, beside the other Local Multiplayer choices', () => {
    const tab = { ...NONE, players: ['lan-party'] }
    expect(tabShowsGame('portal', sources([portal]), tab)).toBe(false)
    expect(
      tabShowsGame('portal', sources([portal]), { ...tab, lanParty: new Set(['other']) })
    ).toBe(false)
    expect(
      tabShowsGame('portal', sources([portal]), { ...tab, lanParty: new Set(['portal']) })
    ).toBe(true)
    // Any choice picked keeps the card (L.A.N. Party or All Local Multiplayer).
    const both = { ...NONE, players: ['lan-party', 'local-all'], lanParty: new Set<string>() }
    expect(tabShowsGame('portal', sources([portal]), both)).toBe(false)
  })
})

describe('Filters > Difficulty', () => {
  // The user's picks, laid over the games as they leave main.
  const cuphead = game('cuphead', { metadata: { difficulty: 'impossible' } })
  const stardew = game('stardew', { metadata: { difficulty: 'story' } })
  const unknown = game('unknown')
  const picked = game('picked', { metadata: { difficulty: 'easy' } })
  const all = sources([cuphead, stardew, unknown, picked])
  const shows = (id: string, difficulty: string[]): boolean =>
    tabShowsGame(id, all, { ...NONE, difficulty })

  it('keeps the games whose level is among the levels picked', () => {
    expect(shows('cuphead', ['impossible'])).toBe(true)
    expect(shows('cuphead', ['hard'])).toBe(false)
    expect(shows('stardew', ['story', 'hard'])).toBe(true)
    expect(shows('picked', ['easy'])).toBe(true)
    expect(shows('picked', ['impossible'])).toBe(false)
  })

  it('counts a game without a pick as Medium', () => {
    expect(shows('unknown', ['medium'])).toBe(true)
    expect(shows('unknown', ['easy', 'hard'])).toBe(false)
  })

  it("gives a game without a pick its Steam tag's level, and a pick beats the tag", () => {
    const novel = game('novel', { metadata: { steamTags: { tags: ['Visual Novel'] } } })
    const casual = game('casual', { metadata: { steamTags: { tags: ['Casual'] } } })
    const souls = game('souls', { metadata: { steamTags: { tags: ['Souls-like', 'Casual'] } } })
    const overridden = game('overridden', {
      metadata: { difficulty: 'impossible', steamTags: { tags: ['Casual'] } }
    })
    const tagged = sources([novel, casual, souls, overridden])
    const level = (id: string, d: string): boolean =>
      tabShowsGame(id, tagged, { ...NONE, difficulty: [d] })
    expect(level('novel', 'story')).toBe(true)
    expect(level('casual', 'easy')).toBe(true)
    expect(level('souls', 'hard')).toBe(true)
    expect(level('souls', 'easy')).toBe(false)
    expect(level('overridden', 'impossible')).toBe(true)
    expect(level('overridden', 'easy')).toBe(false)
  })

  it('keeps every game while no level is picked', () => {
    for (const id of ['cuphead', 'stardew', 'unknown', 'picked']) {
      expect(shows(id, [])).toBe(true)
      expect(tabShowsGame(id, all, NONE)).toBe(true)
    }
  })

  it('shows a Utilities game (N/A (Tools)) under no level, only with none picked; a pick puts it on a level', () => {
    const tool = game('tool', { metadata: { steamTags: { tags: ['Utilities', 'Casual'] } } })
    const fixed = game('fixed', {
      metadata: { difficulty: 'hard', steamTags: { tags: ['Utilities'] } }
    })
    const lib = sources([tool, fixed])
    const level = (id: string, d: string[]): boolean =>
      tabShowsGame(id, lib, { ...NONE, difficulty: d })
    for (const d of ['story', 'easy', 'medium', 'hard', 'impossible'])
      expect(level('tool', [d])).toBe(false)
    expect(level('tool', ['story', 'easy', 'medium', 'hard', 'impossible'])).toBe(false)
    // Not even a stray 'tools' in a saved filter shows it.
    expect(level('tool', ['tools'])).toBe(false)
    expect(level('tool', [])).toBe(true)
    expect(tabShowsGame('tool', lib, NONE)).toBe(true)
    // The user's pick beats the tag.
    expect(level('fixed', ['hard'])).toBe(true)
  })
})

describe('Sort > Active Players of a card with copies', () => {
  it("uses another copy's count when the card's own copy has none", () => {
    const epic = game('epic:cs', { source: 'epic', platformId: 'epic' })
    const steam = game('steam:730', {
      metadata: { currentPlayers: { count: 500, updatedAt: '2026-11-25T11:00:00.000Z' } }
    })
    const own = game('own', {
      metadata: { currentPlayers: { count: 7, updatedAt: '2026-11-25T11:00:00.000Z' } }
    })
    const { playersOfGroup } = filterTabGroups(
      [
        { game: epic, copies: [epic, steam] },
        { game: own, copies: [own, steam] }
      ],
      [epic, steam, own],
      NONE
    )
    expect(playersOfGroup.get('epic:cs')).toBe(500)
    // The card's own copy's count first.
    expect(playersOfGroup.get('own')).toBe(7)
  })
})

describe('Sort > Difficulty of a card with copies', () => {
  it("uses the level Filters > Difficulty uses: own pick, another copy's pick, a tag, else Medium", () => {
    const epic = game('epic:x', { source: 'epic', platformId: 'epic' })
    const steam = game('steam:x', { metadata: { difficulty: 'impossible' } })
    const tagged = game('tagged', { metadata: { steamTags: { tags: ['Casual'] } } })
    const own = game('own', { metadata: { difficulty: 'story' } })
    const { difficultyOfGroup } = filterTabGroups(
      [
        { game: epic, copies: [epic, steam] },
        { game: own, copies: [own, steam] },
        { game: tagged, copies: [tagged] },
        { game: game('plain'), copies: [] }
      ],
      [epic, steam, own, tagged],
      NONE
    )
    expect(difficultyOfGroup.get('epic:x')).toBe('impossible')
    expect(difficultyOfGroup.get('own')).toBe('story')
    expect(difficultyOfGroup.get('tagged')).toBe('easy')
    expect(difficultyOfGroup.get('plain')).toBe('medium')
  })

  it("labels a card N/A (Tools) from any copy's Utilities tag, unless a copy has a pick", () => {
    const epic = game('epic:t', { source: 'epic', platformId: 'epic' })
    const steam = game('steam:t', { metadata: { steamTags: { tags: ['Utilities'] } } })
    const picked = game('picked', { metadata: { difficulty: 'easy' } })
    const { difficultyOfGroup } = filterTabGroups(
      [
        { game: epic, copies: [epic, steam] },
        { game: picked, copies: [picked, steam] }
      ],
      [epic, steam, picked],
      NONE
    )
    expect(difficultyOfGroup.get('epic:t')).toBe('tools')
    expect(difficultyOfGroup.get('picked')).toBe('easy')
  })
})

describe('Sort > H.L.T.B. of a card with copies', () => {
  it("uses the time Filters > H.L.T.B. uses: own copy's, else another copy's", () => {
    const hltb = (main?: number, solo?: number): Game['metadata'] =>
      ({ hltb: { main, solo } }) as Game['metadata']
    const epic = game('epic:x', { source: 'epic', platformId: 'epic' })
    const steam = game('steam:x', { metadata: hltb(30) })
    const own = game('own', { metadata: hltb(undefined, 7) })
    const { hltbOfGroup, kept } = filterTabGroups(
      [
        { game: epic, copies: [epic, steam] },
        { game: own, copies: [own, steam] },
        { game: game('plain'), copies: [] }
      ],
      [epic, steam, own],
      { ...NONE, hltb: ['h-20-50'] }
    )
    expect(hltbOfGroup.get('epic:x')).toBe(30)
    expect(hltbOfGroup.get('own')).toBe(7)
    expect(hltbOfGroup.get('plain')).toBeUndefined()
    // The filter goes by the same time.
    expect(kept.map((g) => g.game.id)).toEqual(['epic:x'])
  })
})

describe('Sort > Reviews of a card with copies', () => {
  it("uses another copy's score (and that copy's count) when the card's own copy has none", () => {
    const epic = game('epic:cs', { source: 'epic', platformId: 'epic' })
    const steam = game('steam:730', {
      metadata: { reviewScore: { source: 'steam', score: 88, count: 9000 } }
    })
    const own = game('own', { metadata: { reviewScore: { source: 'igdb', score: 71 } } })
    const { reviewsOfGroup } = filterTabGroups(
      [
        { game: epic, copies: [epic, steam] },
        { game: own, copies: [own, steam] },
        { game: game('alone'), copies: [] }
      ],
      [epic, steam, own],
      NONE
    )
    expect(reviewsOfGroup.get('epic:cs')).toEqual({ score: 88, count: 9000 })
    // The card's own copy's score first (no count: 0).
    expect(reviewsOfGroup.get('own')).toEqual({ score: 71, count: 0 })
    expect(reviewsOfGroup.get('alone')).toBeUndefined()
  })
})

describe('Filters > Reviews', () => {
  const score = (id: string, s: number | undefined, source: 'steam' | 'igdb' = 'steam'): Game =>
    game(id, { metadata: s === undefined ? {} : { reviewScore: { source, score: s } } })
  const top = score('top', 100)
  const great = score('great', 95)
  const good = score('good', 94.9, 'igdb')
  const mixed = score('mixed', 59.9)
  const poor = score('poor', 12)
  const none = score('none', undefined)
  // The scrapers' rating is not the page's score: no band.
  const rated = game('rated', { metadata: { rating: 90 } })
  const all = sources([top, great, good, mixed, poor, none, rated])
  const shows = (id: string, reviews: string[]): boolean =>
    tabShowsGame(id, all, { ...NONE, reviews })

  it('keeps the games whose score is in a band picked', () => {
    expect(shows('top', ['r95'])).toBe(true)
    expect(shows('great', ['r95'])).toBe(true)
    expect(shows('good', ['r95'])).toBe(false)
    expect(shows('good', ['r90'])).toBe(true)
    expect(shows('mixed', ['r40'])).toBe(true)
    expect(shows('mixed', ['r60'])).toBe(false)
    expect(shows('poor', ['r0'])).toBe(true)
  })

  it('keeps a game in any of several bands picked', () => {
    const picked = ['r95', 'r0']
    expect(['top', 'great', 'poor'].every((id) => shows(id, picked))).toBe(true)
    expect(['good', 'mixed'].some((id) => shows(id, picked))).toBe(false)
  })

  it('hides a game without a score while any band is picked', () => {
    for (const band of ['r95', 'r90', 'r85', 'r80', 'r75', 'r70', 'r60', 'r40', 'r0']) {
      expect(shows('none', [band])).toBe(false)
      expect(shows('rated', [band])).toBe(false)
    }
  })

  it('keeps every game while no band is picked', () => {
    for (const id of ['top', 'great', 'good', 'mixed', 'poor', 'none', 'rated']) {
      expect(shows(id, [])).toBe(true)
      expect(tabShowsGame(id, all, NONE)).toBe(true)
    }
  })

  it("uses another copy's score when the card's own copy has none, its own first", () => {
    const epic = game('epic:x', { source: 'epic', platformId: 'epic' })
    const steam = score('steam:x', 91)
    const own = score('own', 72)
    const { kept } = filterTabGroups(
      [
        { game: epic, copies: [epic, steam] },
        { game: own, copies: [own, steam] }
      ],
      [epic, steam, own],
      { ...NONE, reviews: ['r90'] }
    )
    expect(kept.map((g) => g.game.id)).toEqual(['epic:x'])
  })
})

describe('Filters > Custom', () => {
  const hades = game('hades')
  const celeste = game('celeste')
  const portal = game('portal')
  const customFilters = [
    { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: ['celeste', 'gone-from-library'] },
    { id: 'cf2', name: 'Story', icon: 'book', gameIds: ['hades'] }
  ]
  const kept = (custom: string[]): string[] =>
    filterTabGroups(
      [hades, celeste, portal].map((g) => ({ game: g, copies: [g] })),
      [hades, celeste, portal],
      { ...NONE, custom, customFilters }
    ).kept.map((g) => g.game.id)

  it('keeps a game in any of the filters picked', () => {
    expect(kept(['cf1'])).toEqual(['celeste'])
    expect(kept(['cf1', 'cf2'])).toEqual(['hades', 'celeste'])
  })

  it('keeps every game with none picked, or only ids with no filter here', () => {
    expect(kept([])).toEqual(['hades', 'celeste', 'portal'])
    expect(kept(['another-pc'])).toEqual(['hades', 'celeste', 'portal'])
    expect(kept(['another-pc', 'cf2'])).toEqual(['hades'])
  })

  it('keeps a card when any of its copies is in the filter', () => {
    const steam = game('steam-copy')
    const epic = game('epic-copy', { source: 'epic' })
    const filters = [{ id: 'cf', name: 'X', icon: 'star', gameIds: ['epic-copy'] }]
    const result = filterTabGroups([{ game: steam, copies: [steam, epic] }], [steam, epic], {
      ...NONE,
      custom: ['cf'],
      customFilters: filters
    })
    expect(result.kept.map((g) => g.game.id)).toEqual(['steam-copy'])
  })
})
