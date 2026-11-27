import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game } from '../../shared/types'
import type { CompressState, UpgradeAction, UpgradeStatus } from '../../shared/upgrades'
import { tMain } from '../i18n'
import {
  createAutoCompressService,
  type AutoCompressDeps,
  type FolderActivity
} from './auto-compress'
import { DEFAULT_COMPRESS_ALGORITHM } from './compress'

/**
 * Compress games automatically: a PC game that just finished installing goes through the Upgrade menu's Compress game
 * (the upgrades service's 'compress' action), one at a time, never as a sweep of the games installed before.
 */

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'pc',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: false,
    owned: true,
    launch: { kind: 'uri', uri: 'steam://run/620' },
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
  } as Game
}

function statusOf(
  gameId: string,
  compress: Partial<CompressState> = {},
  blocked: string | null = null,
  risk: UpgradeStatus['risk'] = { tags: [], antiCheat: [] }
): UpgradeStatus {
  return {
    gameId,
    gpu: null,
    risk,
    blocked,
    dlls: { found: [], kinds: [], latest: {}, updatable: false, restorable: false },
    dlss5: { unavailable: null, appReady: false },
    shaders: { unavailable: null, compiledAt: null, note: null },
    optiscaler: { installed: null, latest: null, hasInputs: false },
    compress: {
      state: 'none',
      size: null,
      onDisk: null,
      estimatedSaving: null,
      unavailable: null,
      ...compress
    },
    busy: null,
    scanning: false
  }
}

interface Harness {
  games: Map<string, Game>
  setGame(g: Game): void
  enabled: { on: boolean }
  /** busyReason (every game) and gameWaitReason / stopReason (per game). */
  wait: { busy: string | null; game: string | null; stop: string | null }
  busyCalls: { n: number }
  runs: Array<{ gameId: string; action: UpgradeAction }>
  cancels: string[]
  statusOpts: Array<{ freshMeasure?: boolean } | undefined>
  busy: Set<string>
  statuses: Map<string, UpgradeStatus>
  runError: { message: string | null }
  /** Per install folder: its files now, and when it was made (default: made just now, files old). */
  activity: Map<string, FolderActivity>
  created: Map<string, number>
  service: ReturnType<typeof createAutoCompressService>
  maxConcurrent: { n: number }
}

function harness(initial: Game[], opts: Partial<AutoCompressDeps> = {}): Harness {
  const games = new Map(initial.map((g) => [g.id, g]))
  const enabled = { on: true }
  const wait: Harness['wait'] = { busy: null, game: null, stop: null }
  const busyCalls = { n: 0 }
  const runs: Harness['runs'] = []
  const cancels: string[] = []
  const statusOpts: Harness['statusOpts'] = []
  const busy = new Set<string>()
  const statuses = new Map<string, UpgradeStatus>()
  const runError = { message: null as string | null }
  const activity = new Map<string, FolderActivity>()
  const created = new Map<string, number>()
  const maxConcurrent = { n: 0 }
  const service = createAutoCompressService({
    enabled: () => enabled.on,
    library: { getGame: (id) => games.get(id), games: () => [...games.values()] },
    upgrades: {
      upgradeStatus: async (id, o) => {
        statusOpts.push(o)
        return statuses.get(id) ?? statusOf(id)
      },
      runUpgrade: async (id, action) => {
        if (runError.message) throw new Error(runError.message)
        runs.push({ gameId: id, action })
        busy.add(id)
        maxConcurrent.n = Math.max(maxConcurrent.n, busy.size)
        // The compress takes 10 s.
        setTimeout(() => busy.delete(id), 10_000)
        return statusOf(id)
      },
      busyFor: (id) => (busy.has(id) ? 'compress' : null),
      cancelUpgrade: async (id) => {
        cancels.push(id)
        busy.delete(id)
      }
    },
    busyReason: async () => {
      busyCalls.n++
      return wait.busy
    },
    gameWaitReason: async () => wait.game,
    stopReason: async () => wait.stop,
    folderActivity: async (dir) => activity.get(dir) ?? { files: 10, bytes: 1000, newest: 0 },
    folderCreatedAt: async (dir) => created.get(dir) ?? Date.now(),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    retryMs: 60_000,
    pollMs: 1_000,
    settleMs: 0,
    ...opts
  })
  return {
    games,
    setGame: (g) => games.set(g.id, g),
    enabled,
    wait,
    busyCalls,
    runs,
    cancels,
    statusOpts,
    busy,
    statuses,
    runError,
    activity,
    created,
    service,
    maxConcurrent
  }
}

const DIR = 'D:\\Games\\Portal 2'
const installedDir = { installed: true, installDir: DIR }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('auto compress', () => {
  it('compresses a game that just finished installing, with the existing Compress action', async () => {
    const h = harness([makeGame()])
    h.setGame(makeGame(installedDir))
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs).toEqual([
      { gameId: 'steam:620', action: { kind: 'compress', algorithm: DEFAULT_COMPRESS_ALGORITHM } }
    ])
    expect(DEFAULT_COMPRESS_ALGORITHM).toBe('xpress8k')
    // The compression state comes from a measure of the folder now, never a kept one (a reinstall).
    expect(h.statusOpts).toEqual([{ freshMeasure: true }])
  })

  it('compresses a library game that goes from not installed to installed in a store scanned before', async () => {
    const h = harness([makeGame()])
    h.service.sourceScanned('steam')
    await vi.advanceTimersByTimeAsync(60_000)
    h.setGame(makeGame(installedDir))
    h.service.libraryChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:620'])
  })

  it("a store's first scan of the run is not an install (owned import, then the scan finds it installed)", async () => {
    const h = harness([])
    // The owned list arrives first: a record that is not installed.
    h.setGame(makeGame())
    h.service.libraryChanged()
    // The store's first installed scan of the run marks it installed (installed long ago).
    h.setGame(makeGame(installedDir))
    h.service.libraryChanged()
    h.service.sourceScanned('steam')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.runs).toEqual([])
    expect(h.service.pending()).toEqual([])
  })

  it('a game that only briefly looked uninstalled is not a new install; a reinstall is', async () => {
    const h = harness([makeGame(installedDir)])
    h.service.sourceScanned('steam')
    // Its folder was made long ago.
    h.created.set(DIR, Date.parse('2025-01-01T00:00:00Z'))
    await vi.advanceTimersByTimeAsync(60_000)
    h.service.libraryChanged()
    // A repair hides it for a moment.
    h.setGame(makeGame({ installDir: DIR }))
    h.service.libraryChanged()
    h.setGame(makeGame(installedDir))
    h.service.libraryChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs).toEqual([])
    // Uninstalled and installed again: a new folder.
    h.setGame(makeGame({ installDir: DIR }))
    h.service.libraryChanged()
    await vi.advanceTimersByTimeAsync(60_000)
    h.created.set(DIR, Date.now())
    h.setGame(makeGame(installedDir))
    h.service.libraryChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:620'])
  })

  it('never sweeps the games already installed, also when switched on later', async () => {
    const h = harness([makeGame({ ...installedDir })])
    h.service.sourceScanned('steam')
    h.enabled.on = false
    h.service.libraryChanged()
    h.enabled.on = true
    h.service.libraryChanged()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.runs).toEqual([])
  })

  it('does nothing while it is off (an install finished then is not compressed later)', async () => {
    const h = harness([makeGame()])
    h.service.sourceScanned('steam')
    h.enabled.on = false
    h.setGame(makeGame(installedDir))
    h.service.installFinished('steam:620')
    h.service.libraryChanged()
    h.enabled.on = true
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.runs).toEqual([])
  })

  it('new installed games count only after the store was scanned once in this run', async () => {
    const h = harness([])
    const a = makeGame({ id: 'epic:a', source: 'epic', installed: true, installDir: 'D:\\A' })
    h.setGame(a)
    h.service.libraryChanged()
    h.service.newGames('epic', ['epic:a'])
    h.service.sourceScanned('epic')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runs).toEqual([])
    const b = makeGame({ id: 'epic:b', source: 'epic', installed: true, installDir: 'D:\\B' })
    h.setGame(b)
    h.service.libraryChanged()
    h.service.newGames('epic', ['epic:b'])
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs.map((r) => r.gameId)).toEqual(['epic:b'])
  })

  it('old games found on a drive plugged in later are not new installs', async () => {
    const h = harness([])
    h.service.sourceScanned('steam')
    await vi.advanceTimersByTimeAsync(60_000)
    const old = makeGame({ id: 'steam:old', installed: true, installDir: 'E:\\SteamLibrary\\Old' })
    h.created.set('E:\\SteamLibrary\\Old', Date.parse('2024-05-01T00:00:00Z'))
    h.setGame(old)
    h.service.libraryChanged()
    h.service.newGames('steam', ['steam:old'])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.runs).toEqual([])
    expect(h.service.pending()).toEqual([])
  })

  it('skips ROM games, games of another PC, and what Compress refuses or already did', async () => {
    const rom = makeGame({ id: 'rom:ps2:1', source: 'rom', installed: false })
    const remote = makeGame({ id: 'steam:1', installed: false, remote: { hostId: 'h' } as never })
    const blocked = makeGame({ id: 'steam:2', installed: false })
    const ntfs = makeGame({ id: 'steam:3', installed: false })
    const done = makeGame({ id: 'steam:4', installed: false })
    const partial = makeGame({ id: 'steam:5', installed: false })
    const h = harness([rom, remote, blocked, ntfs, done, partial])
    h.service.sourceScanned('steam')
    h.service.sourceScanned('rom')
    for (const g of [rom, remote, blocked, ntfs, done, partial])
      h.setGame({ ...g, ...installedDir })
    h.statuses.set('steam:2', statusOf('steam:2', {}, tMain('mainUpgrades.blocked.notPcGame')))
    h.statuses.set('steam:3', statusOf('steam:3', { unavailable: 'Not an NTFS drive' }))
    h.statuses.set('steam:4', statusOf('steam:4', { state: 'compressed' }))
    h.statuses.set('steam:5', statusOf('steam:5', { state: 'partial' }))
    h.service.libraryChanged()
    for (const g of [rom, remote]) h.service.installFinished(g.id)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.runs).toEqual([])
    expect(h.service.pending()).toEqual([])
  })

  it('leaves games with anti-cheat (tags or files) alone: the Upgrade menu warns first', async () => {
    const a = makeGame({ id: 'steam:a' })
    const b = makeGame({ id: 'steam:b' })
    const h = harness([a, b])
    h.statuses.set('steam:a', statusOf('steam:a', {}, null, { tags: ['PvP'], antiCheat: [] }))
    h.statuses.set(
      'steam:b',
      statusOf('steam:b', {}, null, { tags: [], antiCheat: ['EasyAntiCheat'] })
    )
    h.setGame({ ...a, ...installedDir })
    h.setGame({ ...b, ...installedDir })
    h.service.installFinished('steam:a')
    h.service.installFinished('steam:b')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.runs).toEqual([])
    expect(h.service.pending()).toEqual([])
  })

  it('waits while a game runs or the store still updates it, then compresses', async () => {
    const h = harness([makeGame()])
    h.wait.busy = 'a game is running'
    h.setGame(makeGame(installedDir))
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs).toEqual([])
    h.wait.busy = null
    h.wait.game = 'Steam is downloading or updating it'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runs).toEqual([])
    expect(h.service.pending()).toEqual(['steam:620'])
    h.wait.game = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:620'])
  })

  it('a game started between the checks and the compress waits instead of being dropped', async () => {
    const h = harness([makeGame()])
    h.setGame(makeGame(installedDir))
    // The status already sees the game running.
    h.statuses.set('steam:620', statusOf('steam:620', {}, tMain('mainUpgrades.blocked.closeGame')))
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.service.pending()).toEqual(['steam:620'])
    // Then runUpgrade itself sees it running.
    h.statuses.delete('steam:620')
    h.runError.message = tMain('mainUpgrades.blocked.closeGame')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.service.pending()).toEqual(['steam:620'])
    h.runError.message = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:620'])
  })

  it('waits until the folder has stopped changing (stores with no "still writing" signal)', async () => {
    const h = harness([makeGame()], { settleMs: 5 * 60_000 })
    h.setGame(makeGame({ ...installedDir, source: 'battlenet', id: 'steam:620' }))
    h.activity.set(DIR, { files: 10, bytes: 1000, newest: Date.now() })
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    // Still writing.
    h.activity.set(DIR, { files: 12, bytes: 5000, newest: Date.now() })
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(h.runs).toEqual([])
    // Five minutes without a change.
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:620'])
  })

  it('gives a waiting game up after the longest wait (bounded)', async () => {
    const h = harness([makeGame()], { maxWaitMs: 5 * 60_000 })
    h.wait.busy = 'a game is running'
    h.setGame(makeGame(installedDir))
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(h.service.pending()).toEqual([])
    h.wait.busy = null
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.runs).toEqual([])
  })

  it('asks what holds every game back once per look, not once per game', async () => {
    const games = ['a', 'b', 'c'].map((id) => makeGame({ id: `steam:${id}` }))
    const h = harness(games)
    h.wait.busy = 'a Convert run is under way'
    for (const g of games) {
      h.setGame({ ...g, ...installedDir })
      h.service.installFinished(g.id)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(h.busyCalls.n).toBe(1)
  })

  it('compresses one game at a time; a game queued meanwhile goes right after', async () => {
    const a = makeGame({ id: 'steam:a' })
    const b = makeGame({ id: 'steam:b' })
    const h = harness([a, b])
    h.setGame({ ...a, ...installedDir })
    h.service.installFinished('steam:a')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:a'])
    expect(h.service.compressing('steam:a')).toBe(true)
    h.setGame({ ...b, ...installedDir })
    h.service.installFinished('steam:b')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:a'])
    // a ends at 10 s; b starts then, not a retry period later.
    await vi.advanceTimersByTimeAsync(7_000)
    expect(h.runs.map((r) => r.gameId)).toEqual(['steam:a', 'steam:b'])
    expect(h.service.compressing('steam:a')).toBe(false)
    expect(h.maxConcurrent.n).toBe(1)
  })

  it('stops a running compress when a game starts or Steam writes into it, and goes on later', async () => {
    const h = harness([makeGame()])
    h.setGame(makeGame(installedDir))
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runs).toHaveLength(1)
    h.wait.stop = 'a game is running'
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.cancels).toEqual(['steam:620'])
    expect(h.service.pending()).toEqual(['steam:620'])
    // The stopped compress left it partly compressed: this run's own, so it goes on.
    h.statuses.set('steam:620', statusOf('steam:620', { state: 'partial' }))
    h.wait.stop = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runs).toHaveLength(2)
  })

  it('a game queued twice is compressed once', async () => {
    const h = harness([makeGame()])
    h.service.sourceScanned('steam')
    await vi.advanceTimersByTimeAsync(1_000)
    h.setGame(makeGame(installedDir))
    h.service.libraryChanged()
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(30_000)
    h.service.libraryChanged()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.runs).toHaveLength(1)
  })

  it('switching it off drops the games still waiting', async () => {
    const h = harness([makeGame()])
    h.wait.busy = 'a game is running'
    h.setGame(makeGame(installedDir))
    h.service.installFinished('steam:620')
    await vi.advanceTimersByTimeAsync(0)
    h.enabled.on = false
    h.wait.busy = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.runs).toEqual([])
    expect(h.service.pending()).toEqual([])
  })
})
