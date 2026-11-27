import { describe, expect, it, vi } from 'vitest'
import type { Game, GameMetadata, HltbProgress } from '../../shared/types'
import { hltbTimeHours } from '../../shared/hltb-time'
import { createHltbTimes, hltbTimesDue, type HltbTimesDeps } from './hltb-times'

const DAY = 24 * 60 * 60 * 1000
const RETRY = 30 * DAY
const NOW = Date.parse('2026-11-26T12:00:00.000Z')

function game(id: string, patch: Partial<Game> = {}): Game {
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId: 'steam',
    title: patch.title ?? id,
    sortTitle: id,
    installed: false,
    launch: { kind: 'uri', uri: `steam://rungameid/${id}` },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...patch
  }
}

const iso = (at: number): string => new Date(at).toISOString()

function fakeLibrary(games: Game[]): HltbTimesDeps['library'] & {
  writes: { id: string; metadata: Partial<GameMetadata>; quiet?: boolean }[]
} {
  const byId = new Map(games.map((g) => [g.id, g]))
  const writes: { id: string; metadata: Partial<GameMetadata>; quiet?: boolean }[] = []
  return {
    writes,
    games: () => [...byId.values()],
    getGame: (id) => byId.get(id),
    applyMetadata(id, update, options) {
      const g = byId.get(id)
      if (!g) return
      byId.set(id, { ...g, metadata: { ...g.metadata, ...update.metadata } })
      writes.push({ id, metadata: update.metadata ?? {}, quiet: options?.quiet })
    }
  }
}

function setup(
  games: Game[],
  overrides: Partial<HltbTimesDeps> = {}
): {
  service: ReturnType<typeof createHltbTimes>
  library: ReturnType<typeof fakeLibrary>
  asked: string[]
  changed: string[][]
  progress: HltbProgress[]
} {
  const library = fakeLibrary(games)
  const asked: string[] = []
  const changed: string[][] = []
  const progress: HltbProgress[] = []
  const service = createHltbTimes({
    library,
    enabled: () => true,
    paused: () => false,
    lookup: async (title) => {
      asked.push(title)
      return { times: { main: 10 }, failed: false }
    },
    queryOf: (g) => ({ title: g.title }),
    matchRules: 5,
    missRetryMs: RETRY,
    onChanged: (ids) => changed.push(ids),
    onProgress: (p) => progress.push(p),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => NOW,
    batchIntervalMs: 60_000,
    progressIntervalMs: 0,
    ...overrides
  })
  return { service, library, asked, changed, progress }
}

describe('hltbTimesDue', () => {
  it('selects games without times never looked up, or whose miss is over a month old', () => {
    expect(hltbTimesDue(game('new'), NOW, RETRY)).toBe(true)
    expect(hltbTimesDue(game('none', { metadataStatus: 'none' }), NOW, RETRY)).toBe(true)
    expect(
      hltbTimesDue(
        game('old', { metadata: { hltb: { missedAt: iso(NOW - 31 * DAY) } } }),
        NOW,
        RETRY
      )
    ).toBe(true)
    expect(
      hltbTimesDue(game('bad', { metadata: { hltb: { missedAt: 'nope' } } }), NOW, RETRY)
    ).toBe(true)
  })

  it('skips games with times, recent misses, hosts’ games and imports still pending', () => {
    expect(hltbTimesDue(game('t', { metadata: { hltb: { main: 3 } } }), NOW, RETRY)).toBe(false)
    expect(hltbTimesDue(game('s', { metadata: { hltb: { solo: 3 } } }), NOW, RETRY)).toBe(false)
    expect(
      hltbTimesDue(game('m', { metadata: { hltb: { missedAt: iso(NOW - 2 * DAY) } } }), NOW, RETRY)
    ).toBe(false)
    expect(hltbTimesDue(game('remote:h:1'), NOW, RETRY)).toBe(false)
    expect(hltbTimesDue(game('r', { remote: {} as NonNullable<Game['remote']> }), NOW, RETRY)).toBe(
      false
    )
    expect(hltbTimesDue(game('p', { metadataStatus: 'pending' }), NOW, RETRY)).toBe(false)
  })
})

describe('createHltbTimes', () => {
  it('looks up only the due games, most recently played first, and records times and misses', async () => {
    const { service, library, asked, progress } = setup(
      [
        game('a', { title: 'A' }),
        game('b', { title: 'B', lastPlayed: iso(NOW - DAY) }),
        game('timed', { title: 'Timed', metadata: { hltb: { main: 4 } } }),
        game('recent-miss', { title: 'Recent', metadata: { hltb: { missedAt: iso(NOW - DAY) } } }),
        game('old-miss', { title: 'Old', metadata: { hltb: { missedAt: iso(NOW - 40 * DAY) } } }),
        game('remote:h:1', { title: 'Remote' })
      ],
      {
        lookup: async (title) => {
          asked.push(title)
          return { times: title === 'Old' ? null : { main: 10 }, failed: false }
        }
      }
    )
    await service.refresh()
    expect(asked).toEqual(['B', 'A', 'Old'])
    expect(library.getGame('a')?.metadata.hltb).toEqual({
      main: 10,
      rules: 5,
      updatedAt: iso(NOW)
    })
    expect(library.getGame('old-miss')?.metadata.hltb).toEqual({ missedAt: iso(NOW), rules: 5 })
    expect(library.writes.every((w) => w.quiet)).toBe(true)
    expect(progress[0]).toEqual({ done: 0, total: 3, source: 'sort' })
    expect(progress).toContainEqual({ done: 2, total: 3, current: 'Old', source: 'sort' })
    expect(progress.at(-1)).toEqual({ done: 0, total: 0, source: 'sort' })
  })

  it('announces the games given times in batches, not one event per game', async () => {
    const { service, changed } = setup([game('a'), game('b'), game('c')])
    await service.refresh()
    // One batch at the end of the run (the 60 s window never elapsed).
    expect(changed).toEqual([['a', 'b', 'c']])
  })

  it('runs one pass at a time: a call during a run gets that run', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const asked: string[] = []
    const { service } = setup([game('a'), game('b')], {
      lookup: async (title) => {
        asked.push(title)
        await gate
        return { times: { main: 1 }, failed: false }
      }
    })
    const first = service.refresh()
    const second = service.refresh()
    expect(second).toBe(first)
    expect(service.running()).toBe(first)
    release()
    await first
    expect(asked).toEqual(['a', 'b'])
    expect(service.running()).toBeNull()
  })

  it('stops when HLTB pauses its lookups, and does not start while paused', async () => {
    let paused = false
    const { service, asked, progress } = setup([game('a'), game('b'), game('c')], {
      paused: () => paused,
      lookup: async (title) => {
        asked.push(title)
        paused = true
        return { times: null, failed: true }
      }
    })
    await service.refresh()
    expect(asked).toEqual(['a'])
    expect(progress.at(-1)).toEqual({ done: 0, total: 0, source: 'sort' })
    await service.refresh()
    expect(asked).toEqual(['a'])
  })

  it('stops after repeated failures without recording them as misses', async () => {
    const { service, asked, library } = setup([game('a'), game('b'), game('c')], {
      maxFailures: 2,
      lookup: async (title) => {
        asked.push(title)
        return { times: null, failed: true }
      }
    })
    await service.refresh()
    expect(asked).toEqual(['a', 'b'])
    expect(library.writes).toEqual([])
  })

  it('does nothing with HowLongToBeat turned off', async () => {
    const { service, asked, progress } = setup([game('a')], { enabled: () => false })
    await service.refresh()
    expect(asked).toEqual([])
    expect(progress).toEqual([])
  })

  it('waits for another HLTB pass first, then skips what it gave times', async () => {
    const games = [game('a'), game('b')]
    let finish!: () => void
    const other = new Promise<void>((r) => (finish = r))
    const { service, library, asked } = setup(games, { busy: () => other })
    const run = service.refresh()
    await Promise.resolve()
    expect(asked).toEqual([])
    library.applyMetadata('a', { metadata: { hltb: { main: 2 } } })
    finish()
    await run
    expect(asked).toEqual(['b'])
  })
})

describe('what counts as a time (shared with the H.L.T.B. sort)', () => {
  it('looks up a game matched with only Extra or Completionist times once its answer is a month old', () => {
    const extraOnly = (updatedAt?: string): Game =>
      game('x', { metadata: { hltb: { extra: 12, completionist: 30, rules: 5, updatedAt } } })
    // The sort shows it under "No time yet" (the renderer's hltbHours: Main Story, else Solo)...
    expect(hltbTimeHours(extraOnly(iso(NOW)).metadata.hltb)).toBeUndefined()
    // ...so main looks it up again, respecting HLTB's answer like a miss.
    expect(hltbTimesDue(extraOnly(iso(NOW - 2 * DAY)), NOW, RETRY)).toBe(false)
    expect(hltbTimesDue(extraOnly(iso(NOW - 31 * DAY)), NOW, RETRY)).toBe(true)
    expect(hltbTimesDue(extraOnly(undefined), NOW, RETRY)).toBe(true)
    // A zero Main Story with a Solo time has no time either (main ?? solo is 0).
    const zero = game('z', {
      metadata: { hltb: { main: 0, solo: 5, updatedAt: iso(NOW - 40 * DAY) } }
    })
    expect(hltbTimeHours(zero.metadata.hltb)).toBeUndefined()
    expect(hltbTimesDue(zero, NOW, RETRY)).toBe(true)
  })

  it('records an Extra-only answer and does not ask about it again within the month', async () => {
    const { service, library, asked } = setup([game('a', { title: 'A' })], {
      lookup: async (title) => {
        asked.push(title)
        return { times: { extra: 7 }, failed: false }
      }
    })
    await service.refresh()
    expect(library.getGame('a')?.metadata.hltb).toEqual({ extra: 7, rules: 5, updatedAt: iso(NOW) })
    await service.refresh()
    expect(asked).toEqual(['A'])
  })
})

describe('stop', () => {
  it('stops the run after the lookup in progress, writes its answer, flushes and reports total 0', async () => {
    let release!: () => void
    const asked: string[] = []
    const { service, library, changed, progress } = setup([game('a'), game('b'), game('c')], {
      lookup: async (title) => {
        asked.push(title)
        await new Promise<void>((r) => (release = r))
        return { times: { main: 3 }, failed: false }
      }
    })
    const run = service.refresh()
    await vi.waitFor(() => expect(asked).toEqual(['a']))
    service.stop()
    release()
    await run
    expect(asked).toEqual(['a'])
    expect(library.getGame('a')?.metadata.hltb?.main).toBe(3)
    expect(library.getGame('b')?.metadata.hltb).toBeUndefined()
    expect(changed).toEqual([['a']])
    expect(progress.at(-1)).toEqual({ done: 0, total: 0, source: 'sort' })
    expect(service.running()).toBeNull()
  })

  it('a refresh after a stop starts a new run once the stopped one is through', async () => {
    const gates: (() => void)[] = []
    const asked: string[] = []
    const { service } = setup([game('a'), game('b')], {
      lookup: async (title) => {
        asked.push(title)
        await new Promise<void>((r) => gates.push(r))
        return { times: { main: 3 }, failed: false }
      }
    })
    const first = service.refresh()
    await vi.waitFor(() => expect(asked).toEqual(['a']))
    service.stop()
    const second = service.refresh()
    expect(second).not.toBe(first)
    expect(service.running()).toBe(second)
    gates.shift()?.()
    await first
    await vi.waitFor(() => expect(asked).toEqual(['a', 'b']))
    gates.shift()?.()
    await second
    expect(service.running()).toBeNull()
  })

  it('a stop before the run starts its lookups means none are made', async () => {
    let finish!: () => void
    const other = new Promise<void>((r) => (finish = r))
    const { service, asked } = setup([game('a')], { busy: () => other })
    const run = service.refresh()
    service.stop()
    finish()
    await run
    expect(asked).toEqual([])
  })
})
