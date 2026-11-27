import type { LibraryTabDef, Platform } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  ALL_GAMES_NAME,
  DEFAULT_TAB_SORT,
  RECOMMENDED_TABS,
  clearableChoices,
  emptyTabFilters,
  hasRecommendedTab,
  hasTabChoice,
  matchesCreators,
  migrateTabDef,
  migrateTabs,
  moveTab,
  neighbourAfterRemoval,
  newTabDef,
  newTabId,
  platformLabelOf,
  sameTabFilters,
  savableTabDef,
  savableTabs,
  stripTabs,
  tabFiltersOf,
  tabName,
  toggledChoice,
  withoutChoice
} from './libraryTabs'
import {
  LIBRARY_ALL_TAB,
  LIBRARY_OTHER_TAB,
  LIBRARY_SETTINGS_TAB,
  type LibraryTab
} from './libraryView'

const platform = (id: string, name: string, kind: Platform['kind']): Platform =>
  ({ id, name, shortName: name, kind }) as unknown as Platform

describe('newTabDef', () => {
  it('is All Games on Title A–Z with playable first by default', () => {
    const def = newTabDef()
    expect(def.filters).toEqual(emptyTabFilters())
    expect(def.sort).toBe(DEFAULT_TAB_SORT)
    expect(DEFAULT_TAB_SORT).toBe('title-asc')
    expect(def.playableFirst).toBe(true)
    expect(newTabDef({ playableFirst: false }).playableFirst).toBe(false)
    expect(def.sortReversed).toBe(false)
    expect(def.query).toBeUndefined()
  })

  it('gives every tab its own id, never a fixed one', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTabId(1_700_000_000_000)))
    expect(ids.size).toBe(50)
    expect(ids.has(LIBRARY_SETTINGS_TAB)).toBe(false)
  })
})

describe('tabFiltersOf / sameTabFilters', () => {
  it('copies every list', () => {
    const source = { ...emptyTabFilters(), tags: ['rpg'] }
    const copy = tabFiltersOf(source)
    copy.tags.push('action')
    expect(source.tags).toEqual(['rpg'])
  })

  it('turns genres picked before Genre and Tags merged into the Genre choices (one no choice any more goes)', () => {
    const f = tabFiltersOf({ genres: ['Role-playing (RPG)', 'Indie', 'Action'], tags: ['action'] })
    expect(f.genres).toEqual([])
    expect(f.tags).toEqual(['action', 'rpg'])
  })

  it('ignores the order inside a list', () => {
    const a = tabFiltersOf({ stores: ['epic', 'gog'] })
    expect(sameTabFilters(a, tabFiltersOf({ stores: ['gog', 'epic'] }))).toBe(true)
    expect(sameTabFilters(a, tabFiltersOf({ stores: ['epic'] }))).toBe(false)
    expect(sameTabFilters(a, tabFiltersOf({ stores: ['epic', 'gog'], favorites: true }))).toBe(
      false
    )
  })
})

describe('a saved tab with the Touch controls choice', () => {
  it('loads with Touch still picked and names the tab by it', () => {
    const f = tabFiltersOf({ controls: ['touch', 'controller'] })
    expect(f.controls).toEqual(['touch', 'controller'])
    expect(tabName(tabFiltersOf({ controls: ['touch'] }))).toBe('Touch')
  })
})

describe('tabName', () => {
  it('is All Games with no filter', () => {
    expect(tabName(emptyTabFilters())).toBe(ALL_GAMES_NAME)
  })

  it('joins the filters with · and the choices of one filter with +', () => {
    const name = tabName(tabFiltersOf({ stores: ['epic'], genres: ['RPG'], eras: ['y-2020-2025'] }))
    expect(name.split(' · ')).toHaveLength(3)
    expect(name).toContain('RPG')
    expect(tabName(tabFiltersOf({ genres: ['RPG', 'Action'] }))).toBe('RPG + Action')
  })

  it('puts the platform first and Favorites and Hidden last', () => {
    const label = (id: string): string => (id === 'snes' ? 'SNES' : id)
    expect(
      tabName(tabFiltersOf({ platforms: ['snes'], genres: ['RPG'], favorites: true }), label)
    ).toBe('SNES · RPG · Favorites')
    expect(tabName(tabFiltersOf({ hidden: true, favorites: true }))).toBe('Favorites · Hidden')
  })
})

describe('stripTabs', () => {
  it('is Settings, then the tabs in their order, each named by its filters', () => {
    const defs = [newTabDef({}, 'a'), newTabDef({ filters: { genres: ['RPG'] } }, 'b')]
    expect(stripTabs(defs, (id) => id)).toEqual([
      { id: LIBRARY_SETTINGS_TAB, label: 'Settings' },
      { id: 'a', label: ALL_GAMES_NAME, groups: [] },
      // Its choices kept for "Icons for tabs".
      { id: 'b', label: 'RPG', groups: [[{ kind: 'genreName', id: 'RPG', label: 'RPG' }]] }
    ])
  })
})

describe('platformLabelOf', () => {
  it('falls back to the id for an unknown platform', () => {
    const label = platformLabelOf(new Map())
    expect(label('ps2')).toBe('ps2')
  })
})

describe('migrateTabs', () => {
  const tabs: LibraryTab[] = [
    { id: LIBRARY_SETTINGS_TAB, label: 'Settings' },
    { id: LIBRARY_ALL_TAB, label: 'All Games' },
    { id: 'epic', label: 'Epic', platform: platform('epic', 'Epic', 'store') },
    { id: 'snes', label: 'SNES', platform: platform('snes', 'SNES', 'system') },
    { id: LIBRARY_OTHER_TAB, label: 'Other', platformIds: ['n64', 'gba'] }
  ]

  it('turns each platform tab into the matching filter tab, all on Title A–Z with playable first', () => {
    const defs = migrateTabs(tabs)
    expect(defs.map((d) => d.id)).toEqual([LIBRARY_ALL_TAB, 'epic', 'snes', LIBRARY_OTHER_TAB])
    expect(defs[0]!.filters).toEqual(emptyTabFilters())
    expect(defs[1]!.filters.stores).toEqual(['epic'])
    expect(defs[2]!.filters.platforms).toEqual(['snes'])
    expect(defs[3]!.filters.platforms).toEqual(['n64', 'gba'])
    expect(defs.every((d) => d.sort === 'title-asc' && !d.sortReversed && d.playableFirst)).toBe(
      true
    )
  })

  it('splits an Other tab of stores and systems into a PC tab and a Platform tab', () => {
    const defs = migrateTabs([
      { id: LIBRARY_OTHER_TAB, label: 'Other', platformIds: ['ubisoft', 'ps2', 'xbox'] }
    ])
    expect(defs.map((d) => [d.id, d.filters.stores, d.filters.platforms])).toEqual([
      [LIBRARY_ALL_TAB, [], []],
      [LIBRARY_OTHER_TAB + '-stores', ['ubisoft', 'xbox'], []],
      [LIBRARY_OTHER_TAB, [], ['ps2']]
    ])
    expect(
      migrateTabs([{ id: LIBRARY_OTHER_TAB, label: 'Other', platformIds: ['ea'] }])[1]
    ).toMatchObject({
      id: LIBRARY_OTHER_TAB,
      filters: { stores: ['ea'], platforms: [] }
    })
  })

  it('always has an All Games tab', () => {
    expect(migrateTabs([]).map((d) => d.id)).toEqual([LIBRARY_ALL_TAB])
  })
})

describe('migrateTabDef', () => {
  it('turns the removed Playable First sort into Recently played with playable first on', () => {
    const old = {
      ...newTabDef({ sortReversed: true }, 'a'),
      sort: 'playable'
    } as unknown as LibraryTabDef
    // reversed Playable First (not-installed first) has no match: it loads unreversed
    expect(migrateTabDef(old)).toEqual({
      ...old,
      sort: 'recent',
      sortReversed: false,
      playableFirst: true
    })
    const plain = { ...newTabDef({}, 'b'), sort: 'playable' } as unknown as LibraryTabDef
    expect(migrateTabDef(plain)).toEqual({
      ...plain,
      sort: 'recent',
      sortReversed: false,
      playableFirst: true
    })
  })

  it('turns playable first on for a tab saved before the button, and keeps a chosen sort', () => {
    const { playableFirst: _gone, ...rest } = newTabDef({ sort: 'size' }, 'b')
    void _gone
    expect(migrateTabDef(rest as LibraryTabDef)).toEqual({ ...rest, playableFirst: true })
    const off = newTabDef({ sort: 'release', playableFirst: false }, 'c')
    expect(migrateTabDef(off)).toBe(off)
  })
})

describe('recommended tabs', () => {
  it('recommends All Games on Title A–Z with playable first', () => {
    const all = RECOMMENDED_TABS.find((t) => t.key === 'all-games')!
    expect(all.name).toBe('All')
    expect(all.sort).toBe('title-asc')
    expect(all.playableFirst).toBe(true)
    expect(hasRecommendedTab([newTabDef()], all)).toBe(true)
    // the same games on another sort or with the button off still count as added
    expect(hasRecommendedTab([newTabDef({ sort: 'recent' })], all)).toBe(true)
    expect(hasRecommendedTab([newTabDef({ playableFirst: false })], all)).toBe(true)
    const migrated = migrateTabDef({
      ...newTabDef({}, 'all'),
      sort: 'playable'
    } as unknown as LibraryTabDef)
    expect(hasRecommendedTab([migrated], all)).toBe(true)
    expect(hasRecommendedTab([], all)).toBe(false)
    expect(hasRecommendedTab([newTabDef({ filters: { genres: ['RPG'] } })], all)).toBe(false)
  })
})

describe('moveTab / neighbourAfterRemoval', () => {
  const defs: LibraryTabDef[] = ['a', 'b', 'c'].map((id) => newTabDef({}, id))

  it('moves a tab, clamped to the ends', () => {
    expect(moveTab(defs, 'a', 1).map((d) => d.id)).toEqual(['b', 'a', 'c'])
    expect(moveTab(defs, 'c', -1).map((d) => d.id)).toEqual(['a', 'c', 'b'])
    expect(moveTab(defs, 'a', -1).map((d) => d.id)).toEqual(['a', 'b', 'c'])
    expect(moveTab(defs, 'x', 1).map((d) => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('hands over to the right, else the left', () => {
    expect(neighbourAfterRemoval(defs, 'b')).toBe('c')
    expect(neighbourAfterRemoval(defs, 'c')).toBe('b')
    expect(neighbourAfterRemoval([defs[0]!], 'a')).toBeUndefined()
  })
})

describe('Recompilations filter', () => {
  it('names the tab, compares by it and defaults to off', () => {
    expect(tabName(tabFiltersOf({ recomp: true }))).toBe('Recompilations')
    expect(tabName(tabFiltersOf({ coop: true, recomp: true }))).toMatch(/Co-Op · Recompilations$/)
    expect(sameTabFilters(tabFiltersOf({ recomp: true }), tabFiltersOf({}))).toBe(false)
    expect(tabFiltersOf({}).recomp).toBe(false)
  })
})

describe('Nucleus Co-Op filter', () => {
  it('names the tab and compares by it', () => {
    expect(tabName(tabFiltersOf({ coop: true }))).toBe('Co-Op')
    expect(tabName(tabFiltersOf({ stores: ['steam'], coop: true }), (id) => id)).toMatch(/· Co-Op$/)
    expect(sameTabFilters(tabFiltersOf({ coop: true }), tabFiltersOf({}))).toBe(false)
  })
})

describe('developer / publisher filters (a game page button)', () => {
  it('are none by default and on tabs saved before them (absent: left out while empty)', () => {
    expect(emptyTabFilters()).not.toHaveProperty('developers')
    expect(emptyTabFilters()).not.toHaveProperty('publishers')
    const old = tabFiltersOf({ genres: ['RPG'] })
    expect(old).not.toHaveProperty('developers')
    expect(old).not.toHaveProperty('publishers')
  })

  it('leave empty lists out of a saved tab, so an older PlayOut takes it; names are kept', () => {
    const plain = newTabDef({ filters: { tags: ['rpg'] } }, 'p')
    // Byte-for-byte as before developers / publishers: no such keys at all.
    const json = JSON.stringify(savableTabDef(plain))
    expect(json).not.toContain('developers')
    expect(json).not.toContain('publishers')
    const emptied = { ...plain, filters: { ...plain.filters, developers: [], publishers: [] } }
    expect(JSON.stringify(savableTabDef(emptied))).toBe(json)
    expect(JSON.stringify(savableTabs([emptied]))).toBe(JSON.stringify([plain]))
    expect(tabFiltersOf({ developers: [], publishers: [''] })).not.toHaveProperty('developers')
    expect(tabFiltersOf({ developers: [], publishers: [''] })).not.toHaveProperty('publishers')
    // A tab saved with an empty list is migrated to none.
    expect(migrateTabDef(emptied).filters).not.toHaveProperty('developers')
    // A tab with them keeps them, the same object.
    const named = newTabDef({ filters: { developers: ['Atlus'], publishers: ['Sega'] } }, 'n')
    expect(savableTabDef(named)).toBe(named)
    expect(JSON.parse(JSON.stringify(savableTabDef(named))).filters).toMatchObject({
      developers: ['Atlus'],
      publishers: ['Sega']
    })
    expect(tabFiltersOf(named.filters)).toMatchObject({
      developers: ['Atlus'],
      publishers: ['Sega']
    })
  })

  it('turn a tab saved with one developer / publisher name into lists of one', () => {
    const old = tabFiltersOf({ developer: ' EA Redwood Shores ', publisher: '' } as never)
    expect(old.developers).toEqual(['EA Redwood Shores'])
    expect(old).not.toHaveProperty('publishers')
    expect(old).not.toHaveProperty('developer')
    expect(old).not.toHaveProperty('publisher')
    const def = {
      ...newTabDef({}, 'ea'),
      filters: { ...emptyTabFilters(), developers: undefined, developer: 'EA Redwood Shores' }
    } as unknown as LibraryTabDef
    const migrated = migrateTabDef(def)
    expect(migrated.filters.developers).toEqual(['EA Redwood Shores'])
    expect(migrated.filters).not.toHaveProperty('developer')
    // A tab of this version is the same object.
    const now = newTabDef({ filters: { developers: ['Atlus'] } }, 'a')
    expect(migrateTabDef(now)).toBe(now)
  })

  it('keep each name once (case-insensitive), trimmed, none empty', () => {
    expect(tabFiltersOf({ developers: ['Atlus', ' atlus', '', 'Sega '] }).developers).toEqual([
      'Atlus',
      'Sega'
    ])
  })

  it('compare names case-insensitively in any order, and a set one differs from none', () => {
    const a = tabFiltersOf({ developers: ['Atlus', 'Sega'] })
    expect(sameTabFilters(a, tabFiltersOf({ developers: ['sega ', 'atlus'] }))).toBe(true)
    expect(sameTabFilters(a, tabFiltersOf({}))).toBe(false)
    expect(sameTabFilters(a, tabFiltersOf({ developers: ['Atlus'] }))).toBe(false)
    expect(
      sameTabFilters(a, tabFiltersOf({ developers: ['Atlus', 'Sega'], publishers: ['Sega'] }))
    ).toBe(false)
  })

  it('name the tab after its other filters', () => {
    expect(tabName(tabFiltersOf({ genres: ['RPG'], developers: ['Atlus'], favorites: true }))).toBe(
      'RPG · Atlus · Favorites'
    )
    expect(tabName(tabFiltersOf({ developers: ['Atlus'], publishers: ['Sega'] }))).toBe(
      'Atlus · Sega'
    )
    expect(tabName(tabFiltersOf({ developers: ['Atlus', 'P-Studio'] }))).toBe('Atlus + P-Studio')
    expect(tabName(tabFiltersOf({ publishers: ['Sega'] }))).toBe('Sega')
    // A publisher that is also a developer picked is named once.
    expect(tabName(tabFiltersOf({ developers: ['Sega'], publishers: ['sega'] }))).toBe('Sega')
  })
})

describe('matchesCreators (the Library grid)', () => {
  const copy = (
    developers?: string[],
    publishers?: string[]
  ): { metadata: { developers?: string[]; publishers?: string[] } } => ({
    metadata: { developers, publishers }
  })

  it('keeps every game with no developer or publisher picked', () => {
    expect(matchesCreators([copy()], [], [])).toBe(true)
  })

  it('keeps a game by any of the developers picked (case-insensitive)', () => {
    const devs = ['Atlus', 'FromSoftware']
    expect(matchesCreators([copy(['fromsoftware, inc.'])], devs, [])).toBe(false)
    expect(matchesCreators([copy(['FROMSOFTWARE'])], devs, [])).toBe(true)
    expect(matchesCreators([copy(['Atlus'])], devs, [])).toBe(true)
    expect(matchesCreators([copy(['Sega'])], devs, [])).toBe(false)
    expect(matchesCreators([copy()], devs, [])).toBe(false)
  })

  it('needs a developer and a publisher picked when both lists have names, any copy counting', () => {
    expect(matchesCreators([copy(['Atlus'], ['Sega'])], ['Atlus'], ['Sega'])).toBe(true)
    expect(matchesCreators([copy(['Atlus'], ['Deep Silver'])], ['Atlus'], ['Sega'])).toBe(false)
    expect(
      matchesCreators(
        [copy(['Atlus'], ['Deep Silver']), copy(['Atlus'], ['SEGA'])],
        ['Atlus'],
        ['Sega']
      )
    ).toBe(true)
  })
})

describe('tab choices (game page buttons, Filters > Clear filters)', () => {
  const filters = tabFiltersOf({
    developers: ['Atlus'],
    publishers: ['Sega'],
    tags: ['rpg', 'action']
  })

  it('adds a choice, and removes it when it is on', () => {
    expect(toggledChoice(filters, { kind: 'developer', name: 'P-Studio' })).toEqual({
      developers: ['Atlus', 'P-Studio']
    })
    expect(toggledChoice(filters, { kind: 'developer', name: 'atlus' })).toEqual({
      developers: []
    })
    expect(toggledChoice(filters, { kind: 'genre', id: 'strategy' })).toEqual({
      tags: ['rpg', 'action', 'strategy']
    })
    expect(toggledChoice(filters, { kind: 'genre', id: 'rpg' })).toEqual({ tags: ['action'] })
    expect(toggledChoice(filters, { kind: 'publisher', name: 'Sega' })).toEqual({ publishers: [] })
  })

  it('withoutChoice only removes', () => {
    expect(withoutChoice(filters, { kind: 'developer', name: 'Sega' })).toEqual({})
    expect(withoutChoice(filters, { kind: 'publisher', name: 'SEGA' })).toEqual({ publishers: [] })
  })

  it('lists the developers, publishers and genres to clear, with what each is', () => {
    expect(
      clearableChoices(filters, (id) => id.toUpperCase()).map((c) => [c.label, c.hint, c.key])
    ).toEqual([
      ['Atlus', 'Developer', 'developer:atlus'],
      ['Sega', 'Publisher', 'publisher:sega'],
      ['RPG', 'Genre', 'genre:rpg'],
      ['ACTION', 'Genre', 'genre:action']
    ])
    expect(clearableChoices(emptyTabFilters(), (id) => id)).toEqual([])
  })

  it('says whether a choice is on', () => {
    expect(hasTabChoice(filters, { kind: 'developer', name: 'ATLUS' })).toBe(true)
    expect(hasTabChoice(filters, { kind: 'publisher', name: 'Atlus' })).toBe(false)
    expect(hasTabChoice(filters, { kind: 'genre', id: 'action' })).toBe(true)
    expect(hasTabChoice(null, { kind: 'genre', id: 'action' })).toBe(false)
  })
})

describe('Controls filter in tabs', () => {
  it('is none by default and on tabs saved before it, compared and named like the others', () => {
    expect(emptyTabFilters().controls).toEqual([])
    expect(tabFiltersOf({ genres: ['RPG'] }).controls).toEqual([])
    const a = tabFiltersOf({ controls: ['vr', 'keyboard'] })
    expect(sameTabFilters(a, tabFiltersOf({ controls: ['keyboard', 'vr'] }))).toBe(true)
    expect(sameTabFilters(a, tabFiltersOf({ controls: ['vr'] }))).toBe(false)
    expect(tabName(tabFiltersOf({ genres: ['RPG'], controls: ['vr', 'controller'] }))).toBe(
      'RPG · VR + Controller'
    )
  })
})

describe('Local Multiplayer filter in tabs', () => {
  it('is none by default and on older tabs, compared and named like the others', () => {
    expect(emptyTabFilters().players).toEqual([])
    expect(tabFiltersOf({ genres: ['RPG'] }).players).toEqual([])
    const a = tabFiltersOf({ players: ['2', 'local-all'] })
    expect(sameTabFilters(a, tabFiltersOf({ players: ['local-all', '2'] }))).toBe(true)
    expect(sameTabFilters(a, tabFiltersOf({ players: ['2'] }))).toBe(false)
    expect(tabName(tabFiltersOf({ players: ['5+'], coop: true }))).toBe('5+ Players · Co-Op')
    // A tab saved before 0.9.88 with the old bands gets the bands that replaced them.
    expect(tabFiltersOf({ players: ['2-4', '4+'] }).players).toEqual(['3-4', '5+'])
  })
})

describe('Online Multiplayer filter in tabs', () => {
  it('is none by default and on older tabs, compared and named like the others', () => {
    expect(emptyTabFilters().online).toEqual([])
    expect(tabFiltersOf({ genres: ['RPG'] }).online).toEqual([])
    const a = tabFiltersOf({ online: ['pvp', 'coop'] })
    expect(sameTabFilters(a, tabFiltersOf({ online: ['coop', 'pvp'] }))).toBe(true)
    expect(sameTabFilters(a, tabFiltersOf({ online: ['pvp'] }))).toBe(false)
    expect(tabName(tabFiltersOf({ online: ['coop', 'pvp'] }))).toBe(
      'All Cooperative + All Competitive'
    )
  })
})

describe("another PC's tab filters (the Library tabs sync)", () => {
  it('names a tab whose platform, store or tag only the other PC knows by its id', () => {
    const filters = tabFiltersOf({
      platforms: ['other-pc-system'],
      stores: ['other-pc-store'],
      tags: ['other-pc-tag']
    })
    const name = tabName(filters, platformLabelOf(new Map()))
    expect(name).toContain('other-pc-system')
    expect(name).toContain('other-pc-store')
    expect(name).toContain('other-pc-tag')
  })
})

describe('Reviews filter in tabs', () => {
  it('is absent by default and on tabs saved before it, compared and named like Difficulty', () => {
    expect(emptyTabFilters()).not.toHaveProperty('reviews')
    expect(tabFiltersOf({ genres: ['RPG'] })).not.toHaveProperty('reviews')
    const a = tabFiltersOf({ reviews: ['r95', 'r0'] })
    expect(a.reviews).toEqual(['r95', 'r0'])
    expect(sameTabFilters(a, tabFiltersOf({ reviews: ['r0', 'r95'] }))).toBe(true)
    expect(sameTabFilters(a, tabFiltersOf({ reviews: ['r95'] }))).toBe(false)
    expect(sameTabFilters(tabFiltersOf({}), tabFiltersOf({ reviews: [] }))).toBe(true)
    expect(tabName(tabFiltersOf({ reviews: ['r90', 'r85'] }))).toBe('90-95 + 85-90')
  })

  it('keeps known bands once, drops unknown ids, and leaves an empty list out of a saved tab', () => {
    expect(tabFiltersOf({ reviews: ['r95', 'r95', 'nope', 'r40'] }).reviews).toEqual(['r95', 'r40'])
    expect(tabFiltersOf({ reviews: ['nope'] })).not.toHaveProperty('reviews')
    const def: LibraryTabDef = {
      id: 't',
      filters: { ...emptyTabFilters(), reviews: [] },
      sort: DEFAULT_TAB_SORT,
      sortReversed: false,
      playableFirst: true
    }
    expect(savableTabDef(def).filters).not.toHaveProperty('reviews')
    expect(migrateTabDef(def).filters).not.toHaveProperty('reviews')
    const kept = { ...def, filters: { ...def.filters, reviews: ['r70'] } }
    expect(savableTabDef(kept)).toBe(kept)
    expect(migrateTabDef(kept)).toBe(kept)
  })
})

describe('Custom filter in tabs', () => {
  it('keeps the picked filters (each once), compares them and leaves an empty list out', () => {
    const filters = tabFiltersOf({ custom: ['cf1', 'cf1', 'cf2'] })
    expect(filters.custom).toEqual(['cf1', 'cf2'])
    expect(tabFiltersOf({ custom: [] })).not.toHaveProperty('custom')
    expect(sameTabFilters(filters, tabFiltersOf({ custom: ['cf2', 'cf1'] }))).toBe(true)
    expect(sameTabFilters(filters, emptyTabFilters())).toBe(false)
    const def = newTabDef({ filters: { custom: [] } }, 'x')
    expect(savableTabDef(def).filters).not.toHaveProperty('custom')
  })

  it('names a tab by its filters’ names, leaving out one with no filter here', () => {
    const names = (id: string): string | undefined => ({ cf1: 'Hard', cf2: 'Cozy' })[id]
    const filters = tabFiltersOf({ custom: ['cf1', 'cf2', 'elsewhere'] })
    expect(tabName(filters, undefined, names)).toBe('Hard + Cozy')
    expect(tabName(tabFiltersOf({ custom: ['elsewhere'] }), undefined, names)).toBe(ALL_GAMES_NAME)
    expect(stripTabs([newTabDef({ filters }, 'x')], (id) => id, names)[1]!.label).toBe(
      'Hard + Cozy'
    )
  })
})
