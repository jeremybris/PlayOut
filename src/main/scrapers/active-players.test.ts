import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Game, GameMetadata } from '../../shared/types'
import type { ChartPlayers } from './steamcharts'

// Never the network: the module's default reader is replaced, and every test injects its own anyway.
vi.mock('./steamcharts', () => ({
  steamChartsPlayers: vi.fn(async () => {
    throw new Error('network in a test')
  })
}))

const {
  ACTIVE_PLAYERS_MAX_FAILURES,
  ACTIVE_PLAYERS_STALE_MS,
  ACTIVE_PLAYERS_TTL_MS,
  ACTIVE_PLAYERS_UNTRACKED_TTL_MS,
  createActivePlayers
} = await import('./active-players')

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

function steamGame(id: string, appId: number, metadata: Partial<GameMetadata> = {}): Game {
  return {
    id,
    source: 'steam',
    externalId: String(appId),
    platformId: 'steam',
    title: id,
    installed: true,
    metadata: { ...metadata },
    media: {},
    user: {}
  } as unknown as Game
}

type FetchChart = (appId: number) => Promise<ChartPlayers | 'untracked' | null>
type ApplyMetadata = (
  id: string,
  update: { metadata?: Partial<GameMetadata> },
  options?: { overwrite?: boolean; quiet?: boolean }
) => void

interface Setup {
  service: ReturnType<typeof createActivePlayers>
  library: { applyMetadata: Mock<ApplyMetadata> }
  onChanged: Mock<(gameIds: string[]) => void>
  log: { debug: Mock; info: Mock; warn: Mock; error: Mock }
  fetch: Mock<FetchChart>
  byId: Map<string, Game>
}

function setup(games: Game[], fetchChart: FetchChart): Setup {
  const byId = new Map(games.map((g) => [g.id, g]))
  const library = {
    games: () => [...byId.values()],
    getGame: (id: string) => byId.get(id),
    applyMetadata: vi.fn<ApplyMetadata>((id, update) => {
      const game = byId.get(id)!
      game.metadata = { ...game.metadata, ...update.metadata }
    })
  }
  const onChanged = vi.fn<(gameIds: string[]) => void>()
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const fetch = vi.fn<FetchChart>(fetchChart)
  const service = createActivePlayers({
    library,
    onChanged,
    log,
    fetchChart: fetch,
    now: () => Date.now(),
    batchIntervalMs: 1000
  })
  return { service, library, onChanged, log, fetch, byId }
}

const chart = (current: number, at: number, peak: number): ChartPlayers => ({
  current,
  at: iso(at),
  peak
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('createActivePlayers', () => {
  it('reads each Steam app id once and writes the count, its time and the peak to every game of it', async () => {
    const pointAt = NOW - HOUR
    const games = [
      steamGame('steam:730', 730),
      // Another store's copy of the same Steam game.
      {
        ...steamGame('epic:cs', 0),
        source: 'epic',
        externalId: 'cs',
        extra: { steamAppId: '730' }
      } as unknown as Game,
      steamGame('steam:620', 620, {
        peakPlayers: { count: 9000, updatedAt: iso(NOW - 48 * HOUR) }
      }),
      { ...steamGame('rom:1', 0), source: 'rom', externalId: 'x' } as unknown as Game
    ]
    const { service, fetch, byId, library } = setup(games, async (appId) =>
      appId === 730 ? chart(500_000, pointAt, 1_800_000) : chart(40, pointAt, 6000)
    )
    await service.refresh()
    expect(fetch.mock.calls.map((c) => c[0]).sort()).toEqual([620, 730])
    expect(byId.get('steam:730')!.metadata.currentPlayers).toEqual({
      count: 500_000,
      updatedAt: iso(pointAt)
    })
    expect(byId.get('epic:cs')!.metadata.currentPlayers?.count).toBe(500_000)
    expect(byId.get('steam:730')!.metadata.peakPlayers).toEqual({
      count: 1_800_000,
      updatedAt: iso(NOW)
    })
    // The stored peak is higher than SteamCharts' history: kept.
    expect(byId.get('steam:620')!.metadata.peakPlayers?.count).toBe(9000)
    expect(byId.get('rom:1')!.metadata.currentPlayers).toBeUndefined()
    // Written quietly: announced in batches.
    for (const call of library.applyMetadata.mock.calls)
      expect(call[2]).toEqual({ overwrite: true, quiet: true })
  })

  it('skips counts younger than six hours and asks again after', async () => {
    const games = [
      steamGame('steam:1', 1, {
        currentPlayers: { count: 5, updatedAt: iso(NOW - ACTIVE_PLAYERS_TTL_MS + HOUR) }
      }),
      steamGame('steam:2', 2, {
        currentPlayers: { count: 5, updatedAt: iso(NOW - ACTIVE_PLAYERS_TTL_MS - 1) }
      })
    ]
    const { service, fetch } = setup(games, async () => chart(7, NOW, 7))
    await service.refresh()
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([2])
  })

  it('keeps a newer count from Steam over an older SteamCharts point', async () => {
    const steamAt = NOW - 7 * HOUR
    const games = [
      steamGame('steam:1', 1, { currentPlayers: { count: 99, updatedAt: iso(steamAt) } })
    ]
    const { service, byId } = setup(games, async () => chart(7, steamAt - HOUR, 120))
    await service.refresh()
    expect(byId.get('steam:1')!.metadata.currentPlayers).toEqual({
      count: 99,
      updatedAt: iso(steamAt)
    })
    expect(byId.get('steam:1')!.metadata.peakPlayers?.count).toBe(120)
  })

  it('does not ask about untracked games again within the day', async () => {
    const games = [
      steamGame('steam:1', 1),
      steamGame('steam:2', 2, { peakPlayers: { count: 0, updatedAt: iso(NOW - HOUR) } }),
      steamGame('steam:3', 3, { peakPlayers: { count: 0, updatedAt: iso(NOW - 25 * HOUR) } })
    ]
    const { service, fetch, byId } = setup(games, async () => 'untracked')
    await service.refresh()
    // steam:2 was marked within the day (here or by the game page's SteamCharts 404).
    expect(fetch.mock.calls.map((c) => c[0]).sort()).toEqual([1, 3])
    expect(byId.get('steam:1')!.metadata.peakPlayers).toEqual({ count: 0, updatedAt: iso(NOW) })
    expect(byId.get('steam:1')!.metadata.currentPlayers).toBeUndefined()
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.setSystemTime(NOW + ACTIVE_PLAYERS_UNTRACKED_TTL_MS + 1)
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('remembers an untracked game with a recorded peak in memory', async () => {
    const games = [
      steamGame('steam:1', 1, { peakPlayers: { count: 50, updatedAt: iso(NOW - 48 * HOUR) } })
    ]
    const { service, fetch, byId } = setup(games, async () => 'untracked')
    await service.refresh()
    expect(byId.get('steam:1')!.metadata.peakPlayers?.count).toBe(50)
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not ask about an app id again within six hours even when nothing was written', async () => {
    // Steam's own count is newer than SteamCharts' point: nothing new for the players online now.
    const steamAt = NOW - 7 * HOUR
    const games = [
      steamGame('steam:1', 1, { currentPlayers: { count: 99, updatedAt: iso(steamAt) } })
    ]
    const { service, fetch } = setup(games, async () => chart(7, steamAt - HOUR, 120))
    await service.refresh()
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.setSystemTime(NOW + ACTIVE_PLAYERS_TTL_MS + 1)
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not write a stale last point as the players online now, and waits a day to ask again', async () => {
    const pointAt = NOW - ACTIVE_PLAYERS_STALE_MS - HOUR
    const games = [steamGame('steam:1', 1)]
    const { service, fetch, byId } = setup(games, async () => chart(1234, pointAt, 5000))
    await service.refresh()
    expect(byId.get('steam:1')!.metadata.currentPlayers).toBeUndefined()
    expect(byId.get('steam:1')!.metadata.peakPlayers?.count).toBe(5000)
    vi.setSystemTime(NOW + ACTIVE_PLAYERS_TTL_MS + 1)
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.setSystemTime(NOW + ACTIVE_PLAYERS_UNTRACKED_TTL_MS + 1)
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the six-hour refresh of a tracked game whose whole history is 0', async () => {
    const games = [
      steamGame('steam:1', 1, {
        currentPlayers: { count: 0, updatedAt: iso(NOW - 7 * HOUR) },
        peakPlayers: { count: 0, updatedAt: iso(NOW - HOUR) }
      })
    ]
    const { service, fetch, byId } = setup(games, async () => chart(0, NOW - HOUR, 0))
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(byId.get('steam:1')!.metadata.currentPlayers).toEqual({
      count: 0,
      updatedAt: iso(NOW - HOUR)
    })
  })

  it('runs once at a time', async () => {
    const games = [steamGame('steam:1', 1), steamGame('steam:2', 2)]
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { service, fetch } = setup(games, async () => {
      await gate
      return chart(1, NOW, 1)
    })
    const first = service.refresh()
    const second = service.refresh()
    expect(second).toBe(first)
    release()
    await first
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after repeated failures and logs once', async () => {
    const games = Array.from({ length: 6 }, (_, i) => steamGame(`steam:${i + 1}`, i + 1))
    const { service, fetch, log, library } = setup(games, async () => null)
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(ACTIVE_PLAYERS_MAX_FAILURES)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(library.applyMetadata).not.toHaveBeenCalled()
    // A later request tries again.
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(2 * ACTIVE_PLAYERS_MAX_FAILURES)
  })

  it('announces the written games in batches, and the rest when the run ends', async () => {
    const games = Array.from({ length: 4 }, (_, i) => steamGame(`steam:${i + 1}`, i + 1))
    const { service, onChanged } = setup(games, async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      return chart(3, NOW, 3)
    })
    const run = service.refresh()
    await vi.advanceTimersByTimeAsync(600)
    expect(onChanged).not.toHaveBeenCalled()
    // The first write's batch goes out a second later, with every game written by then.
    await vi.advanceTimersByTimeAsync(1000)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onChanged.mock.calls[0]![0]).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000)
    await run
    const announced = onChanged.mock.calls.flatMap((c) => c[0] as string[])
    expect(announced.sort()).toEqual(['steam:1', 'steam:2', 'steam:3', 'steam:4'])
    expect(onChanged.mock.calls.length).toBeLessThan(4)
  })

  it('stops cleanly when disposed', async () => {
    const games = [steamGame('steam:1', 1), steamGame('steam:2', 2)]
    const { service, fetch, library } = setup(games, async () => {
      service.dispose()
      return chart(1, NOW, 1)
    })
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(library.applyMetadata).not.toHaveBeenCalled()
    await service.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
