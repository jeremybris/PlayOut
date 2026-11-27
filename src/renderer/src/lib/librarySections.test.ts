import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { setLanguage } from '../i18n'
import { sortLibrary } from './libraryView'
import {
  NOT_INSTALLED_RAIL,
  OTHER_SCRIPTS,
  PLAYABLE_RAIL,
  librarySections,
  railEntries,
  sectionIndexAt,
  type LibrarySection
} from './librarySections'

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

/** Tuesday 3 Nov 2026, 15:00 local. */
const NOW = new Date(2026, 10, 3, 15, 0)

/** An ISO timestamp `days` local days before NOW, at `hour` local. */
function daysAgo(days: number, hour = 12): string {
  return new Date(2026, 10, 3 - days, hour, 0).toISOString()
}

function labels(sections: readonly LibrarySection[]): string[] {
  return sections.map((s) => s.label)
}

function covers(sections: readonly LibrarySection[], length: number): void {
  let next = 0
  for (const section of sections) {
    expect(section.start).toBe(next)
    expect(section.size).toBeGreaterThan(0)
    next += section.size
  }
  expect(next).toBe(length)
  expect(new Set(sections.map((s) => s.key)).size).toBe(sections.length)
}

describe('librarySections', () => {
  it('sections the Release Date sort by year, games without a date last', () => {
    const games = sortLibrary(
      [
        game('a', { metadata: { releaseDate: '2024-06-13' } }),
        game('b', { metadata: { releaseDate: '2024-01-02' } }),
        game('c', { metadata: { releaseDate: '1998' } }),
        game('d')
      ],
      'release'
    )
    expect(librarySections(games, 'release', NOW).map((s) => [s.label, s.size])).toEqual([
      ['2024', 2],
      ['1998', 1],
      ['Unknown date', 1]
    ])
  })

  it('returns nothing for an empty library', () => {
    expect(librarySections([], 'title-asc', NOW)).toEqual([])
    expect(librarySections([], 'recent', NOW)).toEqual([])
  })

  it('buckets title sorts by first letter, digits and symbols under #', () => {
    const games = sortLibrary(
      [
        game('a1', { title: 'Alan Wake' }),
        game('a2', { title: 'Abzu' }),
        game('b', { title: 'Braid' }),
        game('n', { title: '1080 Snowboarding' }),
        game('s', { title: '!Symbol' }),
        game('the', { title: 'The Witcher' }),
        game('z', { title: 'Zelda' })
      ],
      'title-asc'
    )
    const sections = librarySections(games, 'title-asc', NOW)
    expect(labels(sections)).toEqual(['#', 'A', 'B', 'W', 'Z'])
    expect(sections.map((s) => s.size)).toEqual([2, 2, 1, 1, 1])
    expect(sections[0]).toMatchObject({ short: '#', start: 0 })
    covers(sections, games.length)

    const desc = sortLibrary(games, 'title-asc', true)
    const descSections = librarySections(desc, 'title-asc', NOW)
    expect(labels(descSections)).toEqual(['Z', 'W', 'B', 'A', '#'])
    covers(descSections, desc.length)
  })

  it('strips accents and puts an empty title under #', () => {
    const games = sortLibrary(
      [
        game('e1', { title: 'Éclair' }),
        game('e2', { title: 'Elden Ring' }),
        game('o', { title: 'Ōkami' }),
        game('empty', { title: '', sortTitle: '' })
      ],
      'title-asc'
    )
    const sections = librarySections(games, 'title-asc', NOW)
    expect(labels(sections)).toEqual(['#', 'E', 'O'])
    expect(sections[1]!.size).toBe(2)
  })

  it('uses the user title override when there is no sortTitle', () => {
    const games = [
      game('x', { title: 'Zork', sortTitle: '', user: { titleOverride: 'Adventure' } })
    ]
    expect(labels(librarySections(games, 'title-asc', NOW))).toEqual(['A'])
  })

  it('buckets recent by local day of lastPlayed, never played last', () => {
    const games = sortLibrary(
      [
        game('t1', { lastPlayed: daysAgo(0, 14) }),
        game('t2', { lastPlayed: daysAgo(0, 0) }),
        game('y', { lastPlayed: daysAgo(1, 23) }),
        game('d3', { lastPlayed: daysAgo(3) }),
        game('jan', { lastPlayed: new Date(2026, 0, 5, 10).toISOString() }),
        game('old', { lastPlayed: new Date(2024, 10, 3, 10).toISOString() }),
        game('never1'),
        game('never2', { lastPlayed: 'not a date' })
      ],
      'recent'
    )
    const sections = librarySections(games, 'recent', NOW)
    expect(sections.map((s) => [s.label, s.short, s.size])).toEqual([
      ['Today', 'Today', 2],
      ['Yesterday', 'Yday', 1],
      ['31 Oct', '31 Oct', 1],
      ['5 Jan', '5 Jan', 1],
      ['3 Nov 2024', 'Nov 24', 1],
      ['Never played', 'Never', 2]
    ])
    covers(sections, games.length)
  })

  it('treats yesterday across a month boundary', () => {
    const now = new Date(2026, 11, 1, 9)
    const games = [game('y', { lastPlayed: new Date(2026, 10, 30, 22).toISOString() })]
    expect(labels(librarySections(games, 'recent', now))).toEqual(['Yesterday'])
  })

  it('defaults now to the current date', () => {
    const games = [game('t', { lastPlayed: new Date().toISOString() })]
    expect(labels(librarySections(games, 'recent'))).toEqual(['Today'])
  })

  it('buckets added by day of addedAt, a missing one under Unknown', () => {
    const games = sortLibrary(
      [
        game('a', { addedAt: daysAgo(0) }),
        game('b', { addedAt: daysAgo(10) }),
        game('c', { addedAt: '' })
      ],
      'added'
    )
    const sections = librarySections(games, 'added', NOW)
    expect(sections.map((s) => [s.label, s.short])).toEqual([
      ['Today', 'Today'],
      ['24 Oct', '24 Oct'],
      ['Unknown', '?']
    ])
  })

  it('buckets older added dates by month this year and by year before that', () => {
    // A store's own dates (Steam's "Date Added to Library") reach back years: not one section a day.
    const games = sortLibrary(
      [
        game('a', { addedAt: daysAgo(29) }),
        game('b', { addedAt: new Date(2026, 8, 20, 12).toISOString() }),
        game('c', { addedAt: new Date(2026, 8, 2, 12).toISOString() }),
        game('d', { addedAt: new Date(2026, 0, 5, 12).toISOString() }),
        game('e', { addedAt: new Date(2025, 11, 30, 12).toISOString() }),
        game('f', { addedAt: new Date(2025, 2, 1, 12).toISOString() }),
        game('g', { addedAt: new Date(2011, 3, 27, 12).toISOString() })
      ],
      'added'
    )
    const sections = librarySections(games, 'added', NOW)
    expect(sections.map((s) => [s.label, s.short, s.size])).toEqual([
      ['5 Oct', '5 Oct', 1],
      ['Sep', 'Sep', 2],
      ['Jan', 'Jan', 1],
      ['2025', '2025', 2],
      ['2011', '2011', 1]
    ])
    covers(sections, games.length)
  })

  it('sections each part of a playable-first list by the sort, playable part first', () => {
    const games = sortLibrary(
      [
        game('i1', { lastPlayed: daysAgo(0) }),
        game('i2', { lastPlayed: daysAgo(1) }),
        game('i3'),
        game('u1', { installed: false, lastPlayed: daysAgo(0) }),
        game('u2', { installed: false, lastPlayed: daysAgo(40) }),
        game('u3', { installed: false })
      ],
      'recent',
      false,
      undefined,
      undefined,
      true
    )
    const sections = librarySections(games, 'recent', NOW, undefined, undefined, true)
    expect(sections.map((s) => [s.label, s.size, s.group])).toEqual([
      ['Today', 1, 'playable'],
      ['Yesterday', 1, 'playable'],
      ['Never played', 1, 'playable'],
      ['Today', 1, 'not-installed'],
      ['24 Sep', 1, 'not-installed'],
      ['Never played', 1, 'not-installed']
    ])
    expect(sections[3]!.key).toBe(`uninstalled/${sections[0]!.key}`)
    covers(sections, games.length)
    // Off: plain sections, no group.
    const plain = librarySections(games, 'recent', NOW)
    expect(plain.every((s) => s.group === undefined)).toBe(true)
  })

  it('splits title letters per part, keeping keys unique', () => {
    const games = sortLibrary(
      [
        game('a-in', { title: 'Alpha' }),
        game('b-out', { title: 'Beta', installed: false }),
        game('a-out', { title: 'Abzu', installed: false }),
        game('z-in', { title: 'Zed' })
      ],
      'title-asc',
      false,
      undefined,
      undefined,
      true
    )
    expect(games.map((g) => g.id)).toEqual(['a-in', 'z-in', 'a-out', 'b-out'])
    const sections = librarySections(games, 'title-asc', NOW, undefined, undefined, true)
    expect(sections.map((s) => [s.label, s.start, s.group])).toEqual([
      ['A', 0, 'playable'],
      ['Z', 1, 'playable'],
      ['A', 2, 'not-installed'],
      ['B', 3, 'not-installed']
    ])
    covers(sections, games.length)
  })

  it('has only one part when every game is (or none is) playable', () => {
    const installed = [game('a', { title: 'Alpha' }), game('b', { title: 'Beta' })]
    expect(
      librarySections(installed, 'title-asc', NOW, undefined, undefined, true).map((s) => s.group)
    ).toEqual(['playable', 'playable'])
    const none = installed.map((g) => ({ ...g, installed: false }))
    expect(
      librarySections(none, 'title-asc', NOW, undefined, undefined, true).map((s) => s.group)
    ).toEqual(['not-installed', 'not-installed'])
    // No boundary entry on the rail with one part.
    expect(
      railEntries(librarySections(none, 'title-asc', NOW, undefined, undefined, true), 'title-asc')
    ).toHaveLength(27)
  })

  it('buckets most-played by total playtime bands', () => {
    const h = 60
    const games = sortLibrary(
      [
        game('a', { playtimeMinutes: 150 * h }),
        game('b', { playtimeMinutes: 40 * h, storePlaytimeMinutes: 20 * h }),
        game('c', { storePlaytimeMinutes: 20 * h }),
        game('d', { playtimeMinutes: 10 * h }),
        game('e', { playtimeMinutes: 5 * h }),
        game('f', { playtimeMinutes: 59 }),
        game('g', { playtimeMinutes: h }),
        game('z')
      ],
      'most-played'
    )
    const sections = librarySections(games, 'most-played', NOW)
    expect(sections.map((s) => [s.label, s.short, s.size])).toEqual([
      ['100+ h', '100h+', 1],
      ['50–100 h', '50h', 1],
      ['20–50 h', '20h', 1],
      ['10–20 h', '10h', 1],
      ['5–10 h', '5h', 1],
      ['1–5 h', '1h', 1],
      ['Under 1 h', '<1h', 1],
      ['Not played', '0h', 1]
    ])
  })

  it('keeps runs contiguous when the input is not sorted', () => {
    const games = [
      game('a', { title: 'Alpha' }),
      game('b', { title: 'Beta' }),
      game('a2', { title: 'Another' }),
      game('a3', { title: 'Avalon' })
    ]
    const sections = librarySections(games, 'title-asc', NOW)
    expect(sections.map((s) => [s.label, s.start, s.size])).toEqual([
      ['A', 0, 1],
      ['B', 1, 1],
      ['A', 2, 2]
    ])
    covers(sections, games.length)
  })
})

describe('sectionIndexAt', () => {
  const sections = librarySections(
    sortLibrary(
      ['Alpha', 'Apex', 'Beta', 'Cobalt', 'Crow', 'Cat'].map((t) => game(t, { title: t })),
      'title-asc'
    ),
    'title-asc',
    NOW
  )

  it('finds the section containing an index', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => sectionIndexAt(sections, i))).toEqual([0, 0, 1, 2, 2, 2])
  })

  it('clamps out-of-range indexes and returns -1 without sections', () => {
    expect(sectionIndexAt(sections, -3)).toBe(0)
    expect(sectionIndexAt(sections, 99)).toBe(2)
    expect(sectionIndexAt([], 0)).toBe(-1)
  })

  it('works with a single section', () => {
    const one = librarySections([game('a', { title: 'A' })], 'title-asc', NOW)
    expect(sectionIndexAt(one, 0)).toBe(0)
  })
})

describe('railEntries', () => {
  const games = sortLibrary(
    ['42', 'Alpha', 'Beta', 'Zed'].map((t) => game(t, { title: t })),
    'title-asc'
  )

  it('lists # then A..Z for title-asc, missing letters null', () => {
    const entries = railEntries(librarySections(games, 'title-asc', NOW), 'title-asc')
    expect(entries).toHaveLength(27)
    expect(entries[0]).toEqual({ label: '#', target: 0 })
    expect(entries[1]).toEqual({ label: 'A', target: 1 })
    expect(entries[2]).toEqual({ label: 'B', target: 2 })
    expect(entries[3]).toEqual({ label: 'C', target: null })
    expect(entries[26]).toEqual({ label: 'Z', target: 3 })
  })

  it('lists Z..A then # for a reversed title sort', () => {
    const desc = sortLibrary(games, 'title-asc', true)
    expect(desc.map((g) => g.title)).toEqual(['Zed', 'Beta', 'Alpha', '42'])
    const entries = railEntries(librarySections(desc, 'title-asc', NOW), 'title-asc', 27, true)
    expect(entries).toHaveLength(27)
    expect(entries.map((e) => e.label)).toEqual([...'ZYXWVUTSRQPONMLKJIHGFEDCBA'.split(''), '#'])
    expect(entries[0]).toEqual({ label: 'Z', target: 0 })
    expect(entries[1]).toEqual({ label: 'Y', target: null })
    expect(entries[24]).toEqual({ label: 'B', target: 1 })
    expect(entries[25]).toEqual({ label: 'A', target: 2 })
    expect(entries.at(-1)).toEqual({ label: '#', target: 3 })
  })

  it('ignores reversed for sorts other than title', () => {
    const recent = sortLibrary(
      [game('a', { lastPlayed: daysAgo(0) }), game('b', { lastPlayed: daysAgo(1) })],
      'recent',
      true
    )
    expect(railEntries(librarySections(recent, 'recent', NOW), 'recent', 27, true)).toEqual([
      { label: 'Yday', target: 0 },
      { label: 'Today', target: 1 }
    ])
  })

  it('shows every title letter null for an empty library', () => {
    const entries = railEntries([], 'title-asc')
    expect(entries).toHaveLength(27)
    expect(entries.every((e) => e.target === null)).toBe(true)
  })

  it('lists short labels and starts for other sorts', () => {
    const recent = sortLibrary(
      [game('a', { lastPlayed: daysAgo(0) }), game('b', { lastPlayed: daysAgo(1) }), game('c')],
      'recent'
    )
    expect(railEntries(librarySections(recent, 'recent', NOW), 'recent')).toEqual([
      { label: 'Today', target: 0 },
      { label: 'Yday', target: 1 },
      { label: 'Never', target: 2 }
    ])
  })

  it('down-samples a long day list to max, keeping first and last', () => {
    const many = sortLibrary(
      Array.from({ length: 100 }, (_, i) => game(`g${i}`, { lastPlayed: daysAgo(i) })),
      'recent'
    )
    const sections = librarySections(many, 'recent', NOW)
    expect(sections).toHaveLength(100)
    const entries = railEntries(sections, 'recent', 10)
    expect(entries).toHaveLength(10)
    expect(entries[0]).toEqual({ label: 'Today', target: 0 })
    expect(entries[9]!.target).toBe(99)
    const targets = entries.map((e) => e.target!)
    expect([...targets].sort((a, b) => a - b)).toEqual(targets)
    expect(new Set(targets).size).toBe(10)
    expect(railEntries(sections, 'recent')).toHaveLength(27)
    expect(railEntries(sections, 'recent', 1)).toEqual([{ label: 'Today', target: 0 }])
  })
})

describe('railEntries with playable first', () => {
  const pf = (games: Game[], sort: 'title-asc' | 'recent', reversed = false): Game[] =>
    sortLibrary(games, sort, reversed, undefined, undefined, true)
  const sectionsOf = (games: Game[], sort: 'title-asc' | 'recent'): LibrarySection[] =>
    librarySections(games, sort, NOW, undefined, undefined, true)
  const titled = pf(
    [
      game('alpha', { title: 'Alpha' }),
      game('zed', { title: 'Zed' }),
      game('abzu', { title: 'Abzu', installed: false }),
      game('beta', { title: 'Beta', installed: false })
    ],
    'title-asc'
  )

  it('jumps to letters of the part in view, else the other part, then to the other part', () => {
    const sections = sectionsOf(titled, 'title-asc')
    // In the playable part (section 0): A is Alpha (0), B only exists below (Beta, 3).
    const top = railEntries(sections, 'title-asc', 27, false, 0)
    expect(top).toHaveLength(28)
    expect(top.find((e) => e.label === 'A')).toEqual({ label: 'A', target: 0 })
    expect(top.find((e) => e.label === 'B')).toEqual({ label: 'B', target: 3 })
    expect(top.find((e) => e.label === 'Z')).toEqual({ label: 'Z', target: 1 })
    expect(top.at(-1)).toEqual({ label: NOT_INSTALLED_RAIL, target: 2 })
    // Scrolled into the not-installed part (section 2): A is Abzu (2), Z only exists above.
    const below = railEntries(sections, 'title-asc', 27, false, 2)
    expect(below.find((e) => e.label === 'A')).toEqual({ label: 'A', target: 2 })
    expect(below.find((e) => e.label === 'Z')).toEqual({ label: 'Z', target: 1 })
    expect(below.at(-1)).toEqual({ label: PLAYABLE_RAIL, target: 0 })
  })

  it('keeps the reversed letter order and the jump entry last', () => {
    const desc = pf(titled, 'title-asc', true)
    expect(desc.map((g) => g.id)).toEqual(['zed', 'alpha', 'beta', 'abzu'])
    const rail = railEntries(sectionsOf(desc, 'title-asc'), 'title-asc', 27, true, 0)
    expect(rail[0]).toEqual({ label: 'Z', target: 0 })
    expect(rail.at(-2)).toEqual({ label: '#', target: null })
    expect(rail.at(-1)).toEqual({ label: NOT_INSTALLED_RAIL, target: 2 })
  })

  it('labels the first not-installed section on other sorts and always keeps it', () => {
    const recent = pf(
      [
        game('i1', { lastPlayed: daysAgo(0) }),
        game('i2', { lastPlayed: daysAgo(1) }),
        game('u1', { installed: false, lastPlayed: daysAgo(0) }),
        game('u2', { installed: false })
      ],
      'recent'
    )
    expect(railEntries(sectionsOf(recent, 'recent'), 'recent')).toEqual([
      { label: 'Today', target: 0 },
      { label: 'Yday', target: 1 },
      { label: NOT_INSTALLED_RAIL, target: 2 },
      { label: 'Never', target: 3 }
    ])
    const many = pf(
      Array.from({ length: 100 }, (_, i) =>
        game(`g${i}`, { lastPlayed: daysAgo(i), installed: i % 4 === 0 })
      ),
      'recent'
    )
    const sections = sectionsOf(many, 'recent')
    const entries = railEntries(sections, 'recent', 10)
    expect(entries).toHaveLength(10)
    const boundary = sections.findIndex((s) => s.group === 'not-installed')
    expect(entries).toContainEqual({ label: NOT_INSTALLED_RAIL, target: sections[boundary]!.start })
    expect(entries[0]!.target).toBe(0)
    expect(entries.at(-1)!.target).toBe(sections.at(-1)!.start)
    const targets = entries.map((e) => e.target!)
    expect([...targets].sort((a, b) => a - b)).toEqual(targets)
  })
})

describe('title sections follow the sort collation', () => {
  const titled = (title: string): Game =>
    ({
      id: `t:${title}`,
      title,
      sortTitle: title.toLowerCase(),
      playtimeMinutes: 0
    }) as unknown as Game

  it('gives every letter one contiguous section, whatever the script', () => {
    const titles = [
      '2048',
      'aether',
      'ætherborn',
      'afar',
      'øresund',
      'oz',
      'zelda',
      'þórr',
      'ƒable',
      'окко'
    ]
    for (const reversed of [false, true]) {
      const games = sortLibrary(titles.map(titled), 'title-asc', reversed)
      const sections = librarySections(games, 'title-asc')
      const labels = sections.map((s) => s.label)
      expect(new Set(labels).size).toBe(labels.length)
      expect(sections.every((s) => !s.key.includes('~'))).toBe(true)
    }
    const asc = librarySections(sortLibrary(titles.map(titled), 'title-asc'), 'title-asc')
    expect(asc[0]?.label).toBe('#')
    const rail = railEntries(asc, 'title-asc')
    expect(rail[0]).toEqual({ label: '#', target: 0 })
    expect(rail.at(-1)?.label).toBe('…')
  })
})

describe('reversed title rail with other scripts', () => {
  it('puts the other-scripts entry first and # last', () => {
    const titles = ['2048', 'alpha', 'zelda', '\u043e\u043a\u043a\u043e']
    const games = sortLibrary(
      titles.map((t) => game(t, { title: t })),
      'title-asc',
      true
    )
    const rail = railEntries(librarySections(games, 'title-asc', NOW), 'title-asc', 27, true)
    expect(rail).toHaveLength(28)
    expect(rail[0]).toEqual({ label: OTHER_SCRIPTS, target: 0 })
    expect(rail[1]).toEqual({ label: 'Z', target: 1 })
    expect(rail.at(-2)).toEqual({ label: 'A', target: 2 })
    expect(rail.at(-1)).toEqual({ label: '#', target: 3 })
  })
})

describe('size sections', () => {
  const GB = 1024 ** 3
  const sized = (id: string, bytes?: number): Game =>
    game(id, { title: id, installed: false, user: bytes ? { installSize: bytes } : {} })
  const games = [
    sized('huge', 150 * GB),
    sized('hundred', 100 * GB),
    sized('ninety', 99.9 * GB),
    sized('forty', 40 * GB),
    sized('twenty', 20 * GB),
    sized('ten', 10 * GB),
    sized('two', 2 * GB),
    sized('one', 1 * GB),
    sized('tiny', 0.5 * GB),
    sized('unknown-a'),
    sized('unknown-b')
  ]

  it('buckets the size sort by size band, unknown sizes last', () => {
    const sorted = sortLibrary(games, 'size')
    expect(sorted.map((g) => g.id)).toEqual(games.map((g) => g.id))
    const sections = librarySections(sorted, 'size', NOW)
    expect(labels(sections)).toEqual([
      '100+ GB',
      '60-99 GB',
      '30-60 GB',
      '15-30 GB',
      '5-15 GB',
      '1-5 GB',
      '0-1 GB',
      'Unknown size'
    ])
    expect(sections.map((s) => s.size)).toEqual([2, 1, 1, 1, 1, 2, 1, 2])
    expect(sections.at(-1)).toMatchObject({ key: 'size:unknown', short: '?', start: 9 })
    covers(sections, sorted.length)
  })

  it('keeps Unknown size last when reversed', () => {
    const sorted = sortLibrary(games, 'size', true)
    const sections = librarySections(sorted, 'size', NOW)
    expect(labels(sections)).toEqual([
      '0-1 GB',
      '1-5 GB',
      '5-15 GB',
      '15-30 GB',
      '30-60 GB',
      '60-99 GB',
      '100+ GB',
      'Unknown size'
    ])
    covers(sections, sorted.length)
    expect(railEntries(sections, 'size', 27, true).map((e) => e.label)).toEqual(
      sections.map((s) => s.short)
    )
  })
})

describe('active players sections', () => {
  const counted = (id: string, count?: number): Game =>
    game(id, {
      metadata:
        count === undefined
          ? {}
          : { currentPlayers: { count, updatedAt: '2026-11-03T12:00:00.000Z' } }
    })
  const games = [
    counted('huge', 800_000),
    counted('big', 100_000),
    counted('large', 25_000),
    counted('mid', 1_000),
    counted('small', 450),
    counted('tiny', 99),
    counted('one', 1),
    counted('empty', 0),
    counted('unknown-a'),
    counted('unknown-b')
  ]

  it('buckets the Active Players sort by player band, unknown counts last', () => {
    const sorted = sortLibrary(games, 'players')
    expect(sorted.map((g) => g.id)).toEqual(games.map((g) => g.id))
    const sections = librarySections(sorted, 'players', NOW)
    expect(labels(sections)).toEqual([
      '100K+ players',
      '10K–100K',
      '1K–10K',
      '100–1K',
      'Under 100',
      'No one playing',
      'Unknown'
    ])
    expect(sections.map((s) => s.size)).toEqual([2, 1, 1, 1, 2, 1, 2])
    expect(sections.map((s) => s.short)).toEqual(['100K+', '10K', '1K', '100', '<100', '0', '?'])
    expect(sections.at(-1)).toMatchObject({ key: 'players:unknown', start: 8 })
    covers(sections, sorted.length)
  })

  it('keeps Unknown last when reversed', () => {
    const sorted = sortLibrary(games, 'players', true)
    const sections = librarySections(sorted, 'players', NOW)
    expect(labels(sections)).toEqual([
      'No one playing',
      'Under 100',
      '100–1K',
      '1K–10K',
      '10K–100K',
      '100K+ players',
      'Unknown'
    ])
    covers(sections, sorted.length)
    expect(railEntries(sections, 'players', 27, true).map((e) => e.label)).toEqual(
      sections.map((s) => s.short)
    )
  })
})

describe('H.L.T.B. sort sections', () => {
  const hltb = (main: number): Partial<Game> => ({
    metadata: { hltb: { main } } as Game['metadata']
  })
  const games = [
    game('a', { title: 'A', ...hltb(1.5) }),
    game('b', { title: 'B', ...hltb(2) }),
    game('c', { title: 'C', ...hltb(15) }),
    game('d', { title: 'D', ...hltb(150) }),
    game('e', { title: 'E' }),
    game('f', {
      title: 'F',
      metadata: { hltb: { missedAt: '2026-01-01T00:00:00.000Z' } } as Game['metadata']
    })
  ]

  it("has the H.L.T.B. filter's bands, shortest first, then the games without a time", () => {
    const sorted = sortLibrary(games, 'hltb')
    expect(sorted.map((g) => g.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    const sections = librarySections(sorted, 'hltb', NOW)
    expect(labels(sections)).toEqual(['0-3 Hours', '10-20 Hours', '100+ Hours', 'No time yet'])
    expect(sections.map((s) => s.short)).toEqual(['0-3h', '10-20h', '100h+', '?'])
    expect(sections.map((s) => s.size)).toEqual([2, 1, 1, 2])
    expect(sections[3]).toMatchObject({ key: 'hltb:none', start: 4 })
    covers(sections, sorted.length)
  })

  it('runs longest first when reversed, the games without a time still last', () => {
    const sorted = sortLibrary(games, 'hltb', true)
    const sections = librarySections(sorted, 'hltb', NOW)
    expect(labels(sections)).toEqual(['100+ Hours', '10-20 Hours', '0-3 Hours', 'No time yet'])
    covers(sections, sorted.length)
  })

  it('names the sections in Spanish', () => {
    setLanguage('es')
    try {
      const sections = librarySections(sortLibrary(games, 'hltb'), 'hltb', NOW)
      expect(labels(sections)).toEqual([
        '0-3 horas',
        '10-20 horas',
        '100+ horas',
        'Sin tiempo todavía'
      ])
    } finally {
      setLanguage('en')
    }
  })

  it('sections by the time it is given (another copy of the card)', () => {
    const a = game('a', { title: 'A' })
    const sections = librarySections(
      [a],
      'hltb',
      NOW,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      () => 45
    )
    expect(labels(sections)).toEqual(['20-50 Hours'])
  })
})

describe('Difficulty sort sections', () => {
  const games = [
    game('cup', { title: 'Cup', metadata: { difficulty: 'impossible' } }),
    game('souls', { title: 'Souls', metadata: { steamTags: { tags: ['Difficult'] } } }),
    game('alpha', { title: 'Alpha' }),
    game('bravo', { title: 'Bravo' }),
    game('easy', { title: 'Easy', metadata: { difficulty: 'easy' } }),
    game('vn', { title: 'VN', metadata: { steamTags: { tags: ['Visual Novel'] } } })
  ]

  it('has one section per level, hardest first, first letter on the rail', () => {
    const sorted = sortLibrary(games, 'difficulty')
    expect(sorted.map((g) => g.id)).toEqual(games.map((g) => g.id))
    const sections = librarySections(sorted, 'difficulty', NOW)
    expect(labels(sections)).toEqual(['Impossible', 'Hard', 'Medium', 'Easy', 'Story'])
    expect(sections.map((s) => s.short)).toEqual(['I', 'H', 'M', 'E', 'S'])
    expect(sections.map((s) => s.size)).toEqual([1, 1, 2, 1, 1])
    expect(sections[2]).toMatchObject({ key: 'difficulty:medium', start: 2 })
    covers(sections, sorted.length)
  })

  it('runs easiest first when reversed', () => {
    const sorted = sortLibrary(games, 'difficulty', true)
    const sections = librarySections(sorted, 'difficulty', NOW)
    expect(labels(sections)).toEqual(['Story', 'Easy', 'Medium', 'Hard', 'Impossible'])
    covers(sections, sorted.length)
  })

  it('names the levels in Spanish', () => {
    setLanguage('es')
    try {
      const sections = librarySections(sortLibrary(games, 'difficulty'), 'difficulty', NOW)
      expect(labels(sections)).toEqual(['Imposible', 'Difícil', 'Media', 'Fácil', 'Historia'])
      expect(sections.map((s) => s.short)).toEqual(['I', 'D', 'M', 'F', 'H'])
    } finally {
      setLanguage('en')
    }
  })

  it('puts the N/A (Tools) games (Steam tag Utilities) in a last section of their own, both ways', () => {
    const withTools = [
      ...games,
      game('wall', { title: 'Wallpaper', metadata: { steamTags: { tags: ['Utilities'] } } }),
      game('aaa', { title: 'AAA Tool', metadata: { steamTags: { tags: ['Utilities', 'Casual'] } } })
    ]
    for (const reversed of [false, true]) {
      const sorted = sortLibrary(withTools, 'difficulty', reversed)
      expect(sorted.slice(-2).map((g) => g.id)).toEqual(['aaa', 'wall'])
      const sections = librarySections(sorted, 'difficulty', NOW)
      expect(sections.at(-1)).toMatchObject({
        key: 'difficulty:tools',
        label: 'N/A (Tools)',
        short: 'N/A',
        start: 6,
        size: 2
      })
      expect(sections).toHaveLength(6)
      covers(sections, sorted.length)
    }
    setLanguage('es')
    try {
      const sections = librarySections(sortLibrary(withTools, 'difficulty'), 'difficulty', NOW)
      expect(sections.at(-1)).toMatchObject({ label: 'N/D (Herramientas)', short: 'N/D' })
    } finally {
      setLanguage('en')
    }
  })

  it('sections by the level it is given (another copy of the card)', () => {
    const a = game('a', { title: 'A' })
    const of = (g: Game): 'impossible' | 'medium' => (g.id === 'a' ? 'impossible' : 'medium')
    const sections = librarySections(
      [a],
      'difficulty',
      NOW,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      of
    )
    expect(labels(sections)).toEqual(['Impossible'])
  })
})

describe('active players of a card with copies', () => {
  it('sorts and sections by the count it is given (another copy of the card)', () => {
    const a = game('a', { title: 'A' })
    const b = game('b', { title: 'B' })
    const counts = new Map([['b', 20_000]])
    const playersOf = (g: Game): number | undefined => counts.get(g.id)
    const sorted = sortLibrary([a, b], 'players', false, undefined, undefined, false, playersOf)
    expect(sorted.map((g) => g.id)).toEqual(['b', 'a'])
    const reversed = sortLibrary([a, b], 'players', true, undefined, undefined, false, playersOf)
    expect(reversed.map((g) => g.id)).toEqual(['b', 'a'])
    const sections = librarySections(sorted, 'players', NOW, undefined, undefined, false, playersOf)
    expect(labels(sections)).toEqual(['10K–100K', 'Unknown'])
  })
})

describe('Reviews sort sections', () => {
  const scored = (id: string, score?: number, count?: number): Game =>
    game(id, {
      title: id,
      metadata: score === undefined ? {} : { reviewScore: { source: 'steam', score, count } }
    })
  const games = [
    scored('perfect', 100),
    scored('great', 96),
    scored('ninety', 90),
    scored('eighty-seven', 87),
    scored('eighty', 80),
    scored('seventy-six', 76),
    scored('seventy', 70),
    scored('sixty', 65),
    scored('fifty', 50),
    scored('ten', 10),
    scored('none-a'),
    scored('none-b')
  ]

  it('buckets the Reviews sort by Filters > Reviews band, No score last', () => {
    const sorted = sortLibrary(games, 'reviews')
    expect(sorted.map((g) => g.id)).toEqual(games.map((g) => g.id))
    const sections = librarySections(sorted, 'reviews', NOW)
    expect(labels(sections)).toEqual([
      '95-100',
      '90-95',
      '85-90',
      '80-85',
      '75-80',
      '70-75',
      '60-70',
      '40-60',
      '0-40',
      'No score'
    ])
    expect(sections.map((s) => s.size)).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 2])
    expect(sections.map((s) => s.short)).toEqual([
      '95',
      '90',
      '85',
      '80',
      '75',
      '70',
      '60',
      '40',
      '0',
      '?'
    ])
    expect(sections.at(-1)).toMatchObject({ key: 'reviews:none', start: 10 })
    covers(sections, sorted.length)
  })

  it('keeps No score last when reversed', () => {
    const sorted = sortLibrary(games, 'reviews', true)
    const sections = librarySections(sorted, 'reviews', NOW)
    expect(labels(sections)).toEqual([
      '0-40',
      '40-60',
      '60-70',
      '70-75',
      '75-80',
      '80-85',
      '85-90',
      '90-95',
      '95-100',
      'No score'
    ])
    covers(sections, sorted.length)
  })

  it('sections by the score it is given (another copy of the card)', () => {
    const a = scored('a')
    const b = scored('b', 55)
    const reviews = new Map([['a', { score: 91, count: 3 }]])
    const reviewsOf = (g: Game): { score: number; count: number } | undefined => reviews.get(g.id)
    const args = [undefined, undefined, false, undefined, reviewsOf] as const
    const sorted = sortLibrary([b, a], 'reviews', false, ...args)
    expect(sorted.map((g) => g.id)).toEqual(['a', 'b'])
    // b's own score is not what the accessor gives: it has none here.
    expect(labels(librarySections(sorted, 'reviews', NOW, ...args))).toEqual(['90-95', 'No score'])
  })
})
