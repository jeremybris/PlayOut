import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { OverlayExtrasStatus } from '../../shared/overlay-extras'
import type { DisplayStatus, OverlayState, PerformanceStatus } from '../../shared/overlay'
import type { Settings, SettingsPatch } from '../../shared/types'
import { EventBus } from '../events'
import type { RtssHelper, RtssService } from '../rtss/service'
import type { RtssStatus } from '../../shared/overlay-extras'
import { deepMerge } from '../util/object'
import type { GameExtras, GameExtrasStore } from './game-extras-store'
import {
  autoHdrNote,
  clashText,
  createOverlayExtras,
  HOOK_RETRY_MS,
  HOOK_WAIT_MS,
  HOOK_WATCH_MS,
  notOnThisPc,
  notVerified,
  OSD_RELEASE_RETRY_MS,
  OSD_TICK_MS,
  playoutGamesOnly,
  rtssTilesOffered,
  winhancedRunning,
  type OverlayExtras
} from './extras'

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await flush()
}

interface World {
  settings: Settings
  listeners: ((s: Settings) => void)[]
  running: { gameId: string; pid?: number } | null
  procs: { pid: number; name?: string }[]
  overlay: OverlayState
  perf: PerformanceStatus
  helper: RtssHelper | null
  refreshes: number
  rtss: RtssStatus
  hooked: string | null
  gameFps: { fps: number; frameTimeMs?: number; pid: number; exe: string } | null
  limits: [string, number][]
  limitFails: boolean
  selfExcluded: string[]
  osd: string[]
  osdReleases: number
  /** What osdRelease answers (false: the slot is still held). */
  osdReleaseOk: boolean
  restores: number
  synced: Map<string, string>
  hz: number
  hdr: { supported: boolean; enabled: boolean } | null
  autoHdr: boolean | null
  autoHdrWrites: boolean[]
  store: Map<string, GameExtras>
  tasklist: string
  timers: Map<number, { fn: () => void; ms: number }>
  now: number
  emitted: OverlayExtrasStatus[]
}

let w: World
let events: EventBus
let extras: OverlayExtras

function perfStatus(p: Partial<PerformanceStatus> = {}): PerformanceStatus {
  return {
    active: 'balanced',
    source: 'default',
    watts: { state: 'ready', method: 'intel-msr', currentWatts: 14.6, helperVersion: 3 },
    helper: 'ready',
    ...p
  }
}

function makeWorld(): World {
  return {
    settings: defaultSettings(),
    listeners: [],
    running: null,
    procs: [],
    overlay: { open: false },
    perf: perfStatus(),
    helper: {
      rtssLimit: async () => ({ exe: '', fps: 0, created: false }),
      rtssSelf: async () => ({ changed: true }),
      rtssRestore: async () => ({ restored: 0 })
    },
    refreshes: 0,
    rtss: { state: 'running', version: '7.3.7' },
    hooked: null,
    gameFps: null,
    limits: [],
    limitFails: false,
    selfExcluded: [],
    osd: [],
    osdReleases: 0,
    osdReleaseOk: true,
    restores: 0,
    synced: new Map(),
    hz: 120,
    hdr: { supported: true, enabled: true },
    autoHdr: true,
    autoHdrWrites: [],
    store: new Map(),
    tasklist: '"explorer.exe","1234","Console","1","100 K"\r\n',
    timers: new Map(),
    now: 1_000_000,
    emitted: []
  }
}

function fakeRtss(): RtssService {
  return {
    status: async () => ({ ...w.rtss }),
    gameFps: async () => w.gameFps,
    hookedExe: async () => w.hooked,
    async setFrameLimit(exe, fps) {
      if (w.limitFails) throw new Error('helper said no')
      w.limits.push([exe, fps])
    },
    async excludeSelf(exe) {
      w.selfExcluded.push(exe)
    },
    async osdWrite(text) {
      w.osd.push(text)
      return w.rtss.state === 'running'
    },
    async osdRelease() {
      w.osdReleases++
      return w.osdReleaseOk
    },
    async restoreAll() {
      if (w.limitFails) throw new Error('helper said no')
      w.restores++
      return 2
    },
    dispose: async () => undefined
  }
}

function fakeStore(): GameExtrasStore {
  return {
    get: (k) => (w.store.has(k) ? { ...w.store.get(k)! } : null),
    async set(k, v) {
      if (v) w.store.set(k, { ...v })
      else w.store.delete(k)
    },
    getSynced: (k) => w.synced.get(k) ?? null,
    async setSynced(k, exe) {
      if (exe) w.synced.set(k, exe)
      else w.synced.delete(k)
    },
    allSynced: () => [...w.synced],
    async clear() {
      w.store.clear()
      w.synced.clear()
    }
  }
}

function create(
  selfExe: string | null = 'PlayOut.exe',
  rtssTiles = true,
  osdTile = rtssTiles
): OverlayExtras {
  let nextTimer = 1
  return createOverlayExtras({
    settings: {
      get: () => w.settings,
      update(patch: SettingsPatch) {
        w.settings = deepMerge(structuredClone(w.settings), patch)
        for (const l of w.listeners) l(w.settings)
        return w.settings
      },
      mutate(fn) {
        const next = structuredClone(w.settings)
        fn(next)
        w.settings = next
        for (const l of w.listeners) l(w.settings)
        return w.settings
      },
      onChange(l) {
        w.listeners.push(l)
        return () => (w.listeners = w.listeners.filter((x) => x !== l))
      }
    },
    events,
    log: quiet,
    launcher: { running: () => w.running, gameProcesses: async () => w.procs },
    overlay: { state: () => w.overlay },
    performance: {
      status: () => w.perf,
      rtssHelper: async () => w.helper,
      async refresh() {
        w.refreshes++
        return w.perf
      }
    },
    rtss: fakeRtss(),
    display: async (): Promise<DisplayStatus> => ({
      name: '\\\\.\\DISPLAY1',
      current: { width: 1920, height: 1200, hz: w.hz },
      modes: []
    }),
    hdrState: async () => w.hdr,
    autoHdr: {
      read: async () => w.autoHdr,
      async write(on) {
        w.autoHdrWrites.push(on)
        w.autoHdr = on
      }
    },
    store: fakeStore(),
    system: {
      perf: async () => ({
        cpuPercent: 35,
        gpuPercent: 80,
        memoryUsedMb: 6200,
        memoryTotalMb: 10000,
        updatedAt: ''
      }),
      status: async () => ({
        battery: { present: true, percent: 80, charging: false },
        network: { connected: true, kind: 'wifi' },
        bluetooth: { available: true, on: true },
        volume: null,
        brightness: null,
        powerMode: null,
        updatedAt: ''
      })
    },
    selfExe,
    rtssTiles,
    osdTile,
    run: async () => ({ code: 0, stdout: w.tasklist, stderr: '' }),
    setInterval: (fn, ms) => {
      const id = nextTimer++
      w.timers.set(id, { fn, ms })
      return id
    },
    clearInterval: (h) => void w.timers.delete(h as number),
    now: () => w.now
  })
}

/** Runs the timers of one interval `n` times (the clock moves on by it each time). */
async function fire(ms: number, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    w.now += ms
    for (const t of [...w.timers.values()]) if (t.ms === ms) t.fn()
    await settle()
  }
}

function startGame(gameId = 'g1', pid = 4242, name = 'Game.exe'): void {
  w.running = { gameId, pid }
  w.procs = [{ pid, name }]
  events.emit('session:started', { gameId, startedAt: '2026-11-14T10:00:00Z' })
}
function endGame(gameId = 'g1'): void {
  w.running = null
  w.procs = []
  events.emit('session:ended', {
    gameId,
    startedAt: '2026-11-14T10:00:00Z',
    endedAt: '2026-11-14T11:00:00Z',
    minutes: 60
  })
}

beforeEach(() => {
  w = makeWorld()
  events = new EventBus()
  events.on('overlay:extras', (s) => w.emitted.push(s))
})
afterEach(async () => {
  await extras?.dispose()
})

describe('overlay extras: availability', () => {
  it('says why the frame limit cannot be set, in order', async () => {
    extras = create()
    w.rtss = { state: 'missing' }
    expect((await extras.status()).frameLimit).toMatchObject({
      available: false,
      reason: 'Needs RivaTuner Statistics Server'
    })
    w.rtss = { state: 'stopped' }
    expect((await extras.status()).frameLimit.reason).toBe(
      'RivaTuner Statistics Server is not running'
    )
    w.rtss = { state: 'running' }
    w.helper = null
    w.perf = perfStatus({ helper: 'outdated', watts: { state: 'not-installed' } })
    expect((await extras.status()).frameLimit.reason).toBe(
      'Update the power helper in Settings › System'
    )
    w.perf = perfStatus({ helper: 'missing', watts: { state: 'not-installed' } })
    expect((await extras.status()).frameLimit.reason).toBe(
      'Needs the power helper (Settings › System)'
    )
    // No helper method, or ASUS firmware watts: Settings offers no helper to install.
    w.perf = perfStatus({ helper: 'none', watts: { state: 'unsupported' } })
    expect((await extras.status()).frameLimit.reason).toBe(notOnThisPc())
    w.perf = perfStatus({ helper: 'none', watts: { state: 'ready', method: 'asus-wmi' } })
    expect((await extras.status()).sync.reason).toBe(notOnThisPc())
    w.perf = perfStatus()
    w.helper = makeWorld().helper
    expect((await extras.status()).frameLimit.reason).toBe('Start a game first')
    // A game whose exe is not known yet.
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'launcher' }]
    expect((await extras.status()).frameLimit.reason).toBe('Waiting for the game to start')
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    w.now += 5_000 // the processes are listed again after 5 s
    const s = await extras.status()
    expect(s.frameLimit).toMatchObject({ available: true, exe: 'Game.exe', gameId: 'g1', fps: 0 })
    expect(s.frameLimit.options).toEqual([0, 30, 40, 45, 60, 72, 90, 120])
    expect(s.rtss).toEqual({ state: 'running' })
  })

  it('lets sync be turned on before a game runs, and the overlay needs RTSS only', async () => {
    extras = create()
    const s = await extras.status()
    expect(s.sync).toEqual({ enabled: false, available: true, hz: 120 })
    expect(s.perfOverlay).toEqual({ level: 0, available: true, drawing: false })
    w.rtss = { state: 'stopped' }
    expect((await extras.status()).perfOverlay).toMatchObject({
      available: false,
      reason: 'RivaTuner Statistics Server is not running'
    })
  })

  it('notes Winhanced', async () => {
    expect(winhancedRunning('"Winhanced.exe","1","Console","1","1 K"\r\n')).toBe(true)
    expect(winhancedRunning('"WHService.exe","1","Services","0","1 K"\r\n')).toBe(true)
    expect(winhancedRunning('"explorer.exe","1","Console","1","1 K"\r\n')).toBe(false)
    w.tasklist += '"WHService.exe","77","Services","0","9 K"\r\n'
    extras = create()
    expect((await extras.status()).clash).toBe(clashText())
  })
})

describe('overlay extras: frame limit', () => {
  it('writes the hooked exe’s profile and remembers the pick for the game', async () => {
    extras = create()
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [
      { pid: 10, name: 'Launcher.exe' },
      { pid: 11, name: 'Game-Win64.exe' }
    ]
    w.hooked = 'Game-Win64.exe'
    const s = await extras.setFrameLimit(60)
    expect(w.limits).toEqual([['Game-Win64.exe', 60]])
    expect(w.store.get('g1')).toEqual({ frameLimit: 60, exe: 'Game-Win64.exe' })
    expect(s.frameLimit).toMatchObject({ fps: 60, chosen: 60, exe: 'Game-Win64.exe' })
    expect(w.emitted.at(-1)?.frameLimit.fps).toBe(60)
    // ∞ puts back what was there and forgets the pick.
    await extras.setFrameLimit(0)
    expect(w.limits.at(-1)).toEqual(['Game-Win64.exe', 0])
    expect(w.store.has('g1')).toBe(false)
  })

  it('uses the stored exe before the hook, the process name last, and the program without a game', async () => {
    extras = create()
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    w.store.set('g1', { frameLimit: 45, exe: 'Real.exe' })
    expect((await extras.status()).frameLimit).toMatchObject({ exe: 'Real.exe', fps: 45 })
    w.store.clear()
    expect((await extras.status()).frameLimit.exe).toBe('Game.exe')
    w.running = null
    w.overlay = { open: true, program: 'Other.exe' }
    await extras.setFrameLimit(30)
    expect(w.limits).toEqual([['Other.exe', 30]])
    expect(w.store.get('exe:other.exe')).toEqual({ frameLimit: 30, exe: 'Other.exe' })
  })

  it('takes the limit off the old exe when the game’s exe changed', async () => {
    extras = create()
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    w.store.set('g1', { frameLimit: 45, exe: 'Old.exe' })
    w.hooked = 'New.exe'
    await extras.setFrameLimit(72)
    expect(w.limits).toEqual([
      ['Old.exe', 0],
      ['New.exe', 72]
    ])
    expect(w.store.get('g1')).toEqual({ frameLimit: 72, exe: 'New.exe' })
  })

  it('rejects bad values and an unavailable limit without writing', async () => {
    extras = create()
    await expect(extras.setFrameLimit(60.5)).rejects.toThrow()
    await expect(extras.setFrameLimit(1001)).rejects.toThrow()
    await expect(extras.setFrameLimit(60)).rejects.toThrow('Start a game first')
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    w.rtss = { state: 'stopped' }
    await expect(extras.setFrameLimit(60)).rejects.toThrow('not running')
    expect(w.limits).toEqual([])
    w.rtss = { state: 'running' }
    w.limitFails = true
    await expect(extras.setFrameLimit(60)).rejects.toThrow('helper said no')
    expect(w.store.has('g1')).toBe(false)
  })
})

describe('overlay extras: sync FPS + refresh', () => {
  it('follows the display, turns off on an explicit pick, and puts the game’s choice back when off', async () => {
    extras = create()
    extras.start()
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    w.hooked = 'Game.exe'
    w.store.set('g1', { frameLimit: 45, exe: 'Game.exe' })
    let s = await extras.setSync(true)
    expect(w.settings.performance.syncFpsToRefresh).toBe(true)
    expect(w.limits).toEqual([['Game.exe', 120]])
    expect(s.frameLimit).toMatchObject({ fps: 120, chosen: 45 })
    expect(s.sync).toMatchObject({ enabled: true, hz: 120 })
    // The refresh rate changed from the overlay.
    w.hz = 60
    await extras.displayChanged()
    expect(w.limits.at(-1)).toEqual(['Game.exe', 60])
    // The game's own choice was never overwritten; turning sync off puts it back.
    expect(w.store.get('g1')?.frameLimit).toBe(45)
    expect((await extras.setSync(false)).sync.enabled).toBe(false)
    expect(w.limits.at(-1)).toEqual(['Game.exe', 45])
    // An explicit pick turns sync off and sticks.
    await extras.setSync(true)
    s = await extras.setFrameLimit(90)
    expect(w.settings.performance.syncFpsToRefresh).toBe(false)
    expect(w.limits.at(-1)).toEqual(['Game.exe', 90])
    await settle()
    expect(w.limits.at(-1)).toEqual(['Game.exe', 90])
    expect(s.frameLimit).toMatchObject({ fps: 90, chosen: 90 })
  })

  it('does not re-apply after a display change while off', async () => {
    extras = create()
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    await extras.displayChanged()
    expect(w.limits).toEqual([])
  })
})

describe('overlay extras: sync records', () => {
  it('never limits a program the overlay opened over, nor the desktop or a launcher', async () => {
    extras = create()
    extras.start()
    w.overlay = { open: true, program: 'chrome.exe' }
    await extras.setSync(true)
    w.hz = 60
    await extras.displayChanged()
    expect(w.limits).toEqual([])
    expect(w.synced.size).toBe(0)
    // The tile shows the program's own choice, not the display's rate.
    expect((await extras.status()).frameLimit).toMatchObject({ fps: 0, exe: 'chrome.exe' })
    for (const shell of ['explorer.exe', 'steamwebhelper.exe', 'PlayOut.exe']) {
      w.overlay = { open: true, program: shell }
      const st = await extras.status()
      expect(st.frameLimit).toMatchObject({ available: false, reason: 'Start a game first' })
      await expect(extras.setFrameLimit(60)).rejects.toThrow('Start a game first')
    }
    expect(w.limits).toEqual([])
  })

  it('takes every sync limit off when sync turns off with no game running, and remembers them across restarts', async () => {
    extras = create()
    extras.start()
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    w.hooked = 'Game.exe'
    await extras.setSync(true)
    expect(w.limits).toEqual([['Game.exe', 120]])
    expect(w.synced.get('g1')).toBe('Game.exe')
    // The game exits; sync is turned off from Settings with nothing running.
    w.running = null
    w.procs = []
    w.settings = deepMerge(structuredClone(w.settings), {
      performance: { syncFpsToRefresh: false }
    })
    for (const l of w.listeners) l(w.settings)
    await settle()
    expect(w.limits.at(-1)).toEqual(['Game.exe', 0])
    expect(w.synced.size).toBe(0)

    // A restart: the record in game-extras.json still knows the exe (here a launcher's, with the game's own choice
    // on another exe), and the start takes it off.
    await extras.dispose()
    w.limits = []
    w.store.set('g2', { frameLimit: 45, exe: 'Game2.exe' })
    w.synced.set('g2', 'Launcher.exe')
    w.synced.set('g3', 'Game3.exe')
    w.store.set('g3', { frameLimit: 30, exe: 'Game3.exe' })
    extras = create()
    extras.start()
    await settle()
    expect(w.limits).toEqual([
      ['Launcher.exe', 0],
      ['Game3.exe', 30]
    ])
    expect(w.synced.size).toBe(0)
  })

  it('keeps a sync record when it could not be taken off, and retries when the helper is back', async () => {
    w.synced.set('g1', 'Game.exe')
    w.helper = null
    w.perf = perfStatus({ helper: 'missing', watts: { state: 'not-installed' } })
    extras = create()
    extras.start()
    await settle()
    expect(w.limits).toEqual([])
    expect(w.synced.get('g1')).toBe('Game.exe')
    w.helper = makeWorld().helper
    w.perf = perfStatus()
    events.emit('performance:status', w.perf)
    await settle()
    expect(w.limits).toEqual([['Game.exe', 0]])
    expect(w.synced.size).toBe(0)
  })

  it('an explicit pick also takes sync limits off other games', async () => {
    w.settings.performance.syncFpsToRefresh = true
    w.synced.set('g9', 'Other.exe')
    extras = create()
    w.running = { gameId: 'g1', pid: 10 }
    w.procs = [{ pid: 10, name: 'Game.exe' }]
    w.hooked = 'Game.exe'
    await extras.setFrameLimit(50)
    expect(w.limits).toEqual([
      ['Other.exe', 0],
      ['Game.exe', 50]
    ])
    expect(w.synced.size).toBe(0)
  })
})

describe('overlay extras: before the power helper is removed', () => {
  it('puts every profile back and forgets the limits; keeps them when that failed', async () => {
    w.store.set('g1', { frameLimit: 60, exe: 'Game.exe' })
    w.synced.set('g2', 'B.exe')
    extras = create()
    w.limitFails = true
    await extras.beforeHelperRemoved()
    expect(w.store.size).toBe(1)
    w.limitFails = false
    await extras.beforeHelperRemoved()
    expect(w.restores).toBe(1)
    expect(w.store.size).toBe(0)
    expect(w.synced.size).toBe(0)
    w.helper = null
    await extras.beforeHelperRemoved()
    expect(w.restores).toBe(1)
  })
})

describe('overlay extras: before the in-game check', () => {
  it('hides the RivaTuner tiles and never limits or draws', async () => {
    // Checked in a game (RTSS_TILES_VERIFIED): offered without the check's switch too.
    expect(rtssTilesOffered({})).toBe(true)
    expect(rtssTilesOffered({ PLAYOUT_RTSS_TILES: '1' })).toBe(true)
    w.store.set('g1', { frameLimit: 60, exe: 'Game.exe' })
    w.settings.performance.perfOverlay = 2
    w.settings.performance.syncFpsToRefresh = true
    extras = create('PlayOut.exe', false)
    extras.start()
    w.hooked = 'Game.exe'
    startGame()
    await settle()
    await fire(HOOK_RETRY_MS, 2)
    await fire(OSD_TICK_MS, 2)
    expect(w.limits).toEqual([])
    expect(w.osd).toEqual([])
    const st = await extras.status()
    expect(st.rtssTiles).toBe(false)
    expect(st.frameLimit).toMatchObject({ available: false, reason: notVerified(), fps: 60 })
    expect(st.sync).toMatchObject({ enabled: false, available: false, reason: notVerified() })
    expect(st.perfOverlay).toMatchObject({ available: false, reason: notVerified() })
    await expect(extras.setFrameLimit(30)).rejects.toThrow(notVerified())
    await expect(extras.setSync(true)).rejects.toThrow(notVerified())
    await expect(extras.setPerfOverlay(1)).rejects.toThrow(notVerified())
    // Turning them off still works (and Auto HDR, CPU boost and the chips are unaffected).
    await extras.setPerfOverlay(0)
    expect(st.autoHdr.available).toBe(true)
  })
})

describe('overlay extras: performance overlay checked, frame limit not yet', () => {
  it('offers and draws the performance overlay while the limit and sync stay hidden', async () => {
    w.store.set('g1', { frameLimit: 60, exe: 'Game.exe' })
    w.settings.performance.perfOverlay = 1
    w.settings.performance.syncFpsToRefresh = true
    extras = create('PlayOut.exe', false, true)
    extras.start()
    w.hooked = 'Game.exe'
    startGame()
    await settle()
    await fire(HOOK_RETRY_MS, 2)
    await fire(OSD_TICK_MS, 2)
    expect(w.limits).toEqual([])
    expect(w.osd.length).toBeGreaterThan(0)
    const st = await extras.status()
    expect(st).toMatchObject({ rtssTiles: false, osdTile: true })
    expect(st.frameLimit).toMatchObject({ available: false, reason: notVerified() })
    expect(st.sync).toMatchObject({ enabled: false, available: false, reason: notVerified() })
    expect(st.perfOverlay.available).toBe(true)
    await expect(extras.setFrameLimit(30)).rejects.toThrow(notVerified())
    await extras.setPerfOverlay(2)
  })
})

describe('overlay extras: game start', () => {
  it('keeps watching after it settled: a game hooked after its launcher gets the limit', async () => {
    w.store.set('g1', { frameLimit: 60, exe: 'Launcher.exe' })
    extras = create()
    extras.start()
    w.hooked = 'Launcher.exe'
    startGame('g1', 10, 'Launcher.exe')
    await settle()
    expect(w.limits).toEqual([['Launcher.exe', 60]])
    // Settled on the launcher: the fast retries stop, the slow watch goes on.
    await fire(HOOK_RETRY_MS, 2)
    expect(w.limits.length).toBe(1)
    w.hooked = 'Game-Win64.exe'
    await fire(HOOK_WATCH_MS)
    expect(w.limits.slice(1)).toEqual([
      ['Launcher.exe', 0],
      ['Game-Win64.exe', 60]
    ])
    expect(w.store.get('g1')).toEqual({ frameLimit: 60, exe: 'Game-Win64.exe' })
    // The hook gone (the game's entry left): never back to a fallback.
    w.hooked = null
    await fire(HOOK_WATCH_MS, 2)
    expect(w.limits.length).toBe(3)
    // The session ends: the watch stops.
    endGame()
    await settle()
    w.hooked = 'Other.exe'
    await fire(HOOK_WATCH_MS)
    expect(w.limits.length).toBe(3)
  })

  it('after the 60 s fallback, a game hooked later still gets the limit', async () => {
    w.settings.performance.syncFpsToRefresh = true
    extras = create()
    extras.start()
    startGame('g2', 20, 'Game2Launcher.exe')
    await settle()
    await fire(HOOK_RETRY_MS, HOOK_WAIT_MS / HOOK_RETRY_MS)
    expect(w.limits).toEqual([['Game2Launcher.exe', 120]])
    w.hooked = 'Game2.exe'
    await fire(HOOK_WATCH_MS)
    expect(w.limits.slice(1)).toEqual([
      ['Game2Launcher.exe', 0],
      ['Game2.exe', 120]
    ])
    expect(w.synced.get('g2')).toBe('Game2.exe')
  })

  it('puts the stored choice on again at once, and moves it to the exe RTSS hooks', async () => {
    w.store.set('g1', { frameLimit: 60, exe: 'Game.exe' })
    extras = create()
    extras.start()
    await settle()
    startGame('g1', 10, 'Launcher.exe')
    await settle()
    expect(w.limits).toEqual([['Game.exe', 60]])
    w.hooked = 'Game-Shipping.exe'
    await fire(HOOK_RETRY_MS)
    expect(w.limits.slice(1)).toEqual([
      ['Game.exe', 0],
      ['Game-Shipping.exe', 60]
    ])
    expect(w.store.get('g1')).toEqual({ frameLimit: 60, exe: 'Game-Shipping.exe' })
    // Done: the wait stops.
    const n = w.limits.length
    await fire(HOOK_RETRY_MS, 3)
    expect(w.limits.length).toBe(n)
  })

  it('with sync on waits for the hook, then falls back to the process name', async () => {
    w.settings.performance.syncFpsToRefresh = true
    extras = create()
    extras.start()
    startGame('g2', 20, 'Game2.exe')
    await settle()
    expect(w.limits).toEqual([])
    await fire(HOOK_RETRY_MS, HOOK_WAIT_MS / HOOK_RETRY_MS)
    expect(w.limits).toEqual([['Game2.exe', 120]])
  })

  it('puts back an earlier limit for a game without a choice once hooked (repairs drift)', async () => {
    extras = create()
    extras.start()
    w.hooked = 'Game.exe'
    startGame()
    await settle()
    expect(w.limits).toEqual([['Game.exe', 0]])
  })

  it('writes nothing at game end and excludes PlayOut itself once', async () => {
    extras = create()
    extras.start()
    await settle()
    expect(w.selfExcluded).toEqual(['PlayOut.exe'])
    events.emit('performance:status', perfStatus({ active: 'silent' }))
    await settle()
    expect(w.selfExcluded).toEqual(['PlayOut.exe'])
    startGame()
    await settle()
    const n = w.limits.length
    endGame()
    await settle()
    expect(w.limits.length).toBe(n)
  })

  it('does not exclude itself in development or without the helper', async () => {
    extras = create(null)
    extras.start()
    await settle()
    expect(w.selfExcluded).toEqual([])
    await extras.dispose()
    w.helper = null
    extras = create()
    extras.start()
    await settle()
    expect(w.selfExcluded).toEqual([])
  })
})

describe('overlay extras: performance overlay', () => {
  it('draws once a second while a game runs and releases the slot at Off, game end and dispose', async () => {
    extras = create()
    extras.start()
    await settle()
    // At start: a slot a crashed PlayOut left behind is released.
    expect(w.osdReleases).toBe(1)
    let s = await extras.setPerfOverlay(2)
    expect(w.settings.performance.perfOverlay).toBe(2)
    expect(w.osd).toEqual([]) // no game
    expect(s.perfOverlay).toMatchObject({ level: 2, drawing: false })
    w.gameFps = { fps: 119.6, frameTimeMs: 8.4, pid: 4242, exe: 'Game.exe' }
    startGame()
    await settle()
    expect(w.osd.length).toBe(1)
    expect(w.osd[0]).toContain('120 FPS')
    expect(w.osd[0]).toContain('CPU 35%')
    expect(w.osd[0]).toContain('15 W')
    await fire(OSD_TICK_MS, 2)
    expect(w.osd.length).toBe(3)
    expect((await extras.status()).perfOverlay.drawing).toBe(true)
    await extras.setPerfOverlay(3)
    await fire(OSD_TICK_MS)
    expect(w.osd.at(-1)).toContain('RAM 62%')
    expect(w.osd.at(-1)).toContain('80%')
    s = await extras.setPerfOverlay(0)
    expect(w.osdReleases).toBe(2)
    expect(s.perfOverlay).toMatchObject({ level: 0, drawing: false })
    const n = w.osd.length
    await fire(OSD_TICK_MS, 2)
    expect(w.osd.length).toBe(n)
    await extras.setPerfOverlay(1)
    expect(w.osd.at(-1)).toMatch(/^120 FPS/)
    endGame()
    await settle()
    expect(w.osdReleases).toBe(3)
    await extras.dispose()
    expect(w.osdReleases).toBe(4)
  })

  it('tries a release that did not go through again, and stops once it went through', async () => {
    w.osdReleaseOk = false
    extras = create()
    extras.start()
    await settle()
    expect(w.osdReleases).toBe(1)
    await fire(OSD_RELEASE_RETRY_MS, 2)
    expect(w.osdReleases).toBe(3)
    w.osdReleaseOk = true
    await fire(OSD_RELEASE_RETRY_MS)
    expect(w.osdReleases).toBe(4)
    await fire(OSD_RELEASE_RETRY_MS, 3)
    expect(w.osdReleases).toBe(4)
  })

  it('says it draws only for PlayOut games over a game started elsewhere', async () => {
    extras = create()
    w.overlay = { open: true, program: 'SteamGame.exe' }
    expect((await extras.status()).perfOverlay).toMatchObject({
      available: false,
      reason: playoutGamesOnly()
    })
    // Over the desktop it can be set ahead of a game.
    w.overlay = { open: true, program: 'explorer.exe' }
    expect((await extras.status()).perfOverlay.available).toBe(true)
  })

  it('falls back to Dynamic TDP’s frame rate', async () => {
    w.settings.performance.perfOverlay = 1
    w.perf = perfStatus({
      active: 'dynamic',
      dynamic: { targetFps: 60, state: 'holding', fps: 58.7, watts: 12 }
    })
    w.running = { gameId: 'g1', pid: 1 }
    extras = create()
    extras.start()
    await settle()
    expect(w.osd[0]).toMatch(/^59 FPS/)
  })
})

describe('overlay extras: live stats', () => {
  it('reads RTSS first, then PresentMon, and asks for watts at most every 5 s', async () => {
    extras = create()
    w.gameFps = { fps: 87.4, frameTimeMs: 11.4, pid: 1, exe: 'Game.exe' }
    expect(await extras.liveStats()).toEqual({
      fps: 87,
      frameTimeMs: 11.4,
      fpsSource: 'rtss',
      watts: 15
    })
    expect(w.refreshes).toBe(1)
    await extras.liveStats()
    expect(w.refreshes).toBe(1)
    w.now += 5_000
    w.gameFps = null
    w.perf = perfStatus({
      active: 'dynamic',
      dynamic: { targetFps: 60, state: 'holding', fps: 59.6, frameTimeMs: 16.8, watts: 11 }
    })
    expect(await extras.liveStats()).toEqual({
      fps: 60,
      frameTimeMs: 16.8,
      fpsSource: 'presentmon',
      watts: 11
    })
    expect(w.refreshes).toBe(2)
    w.perf = perfStatus({ watts: { state: 'not-installed' } })
    expect(await extras.liveStats()).toEqual({ fps: null, fpsSource: null, watts: null })
  })
})

describe('overlay extras: CPU boost', () => {
  it('edits Custom’s own boost', async () => {
    w.perf = perfStatus({ active: 'custom' })
    extras = create()
    const s = await extras.setCpuBoost(false)
    expect(w.settings.performance.profiles.custom.cpuBoost).toBe(false)
    expect(s.cpuBoost).toEqual({
      enabled: false,
      available: true,
      profile: 'custom',
      overridden: false
    })
  })

  it('overrides a preset, and removes the override when set back to its own value', async () => {
    w.perf = perfStatus({ active: 'balanced' })
    extras = create()
    let s = await extras.setCpuBoost(false)
    expect(w.settings.performance.boostOverrides).toEqual({ balanced: false })
    expect(w.settings.performance.profiles.balanced.cpuBoost).toBe(true)
    expect(s.cpuBoost).toEqual({
      enabled: false,
      available: true,
      profile: 'balanced',
      overridden: true
    })
    s = await extras.setCpuBoost(true)
    expect(w.settings.performance.boostOverrides).toEqual({})
    expect(s.cpuBoost).toMatchObject({ enabled: true, overridden: false })
  })

  it('is managed by Dynamic TDP, and needs a profile', async () => {
    w.perf = perfStatus({ active: 'dynamic' })
    extras = create()
    expect((await extras.status()).cpuBoost).toMatchObject({
      available: false,
      reason: 'Managed by Dynamic TDP'
    })
    await expect(extras.setCpuBoost(false)).rejects.toThrow('Managed by Dynamic TDP')
    w.perf = perfStatus({ active: null })
    expect((await extras.status()).cpuBoost).toMatchObject({
      available: false,
      reason: 'Choose a power profile first'
    })
    expect(w.settings.performance.boostOverrides).toEqual({})
  })
})

describe('overlay extras: Auto HDR', () => {
  it('writes the switch while Windows HDR is on', async () => {
    extras = create()
    let s = await extras.status()
    expect(s.autoHdr).toEqual({ enabled: true, hdrOn: true, available: true, note: autoHdrNote() })
    s = await extras.setAutoHdr(false)
    expect(w.autoHdrWrites).toEqual([false])
    expect(s.autoHdr.enabled).toBe(false)
  })

  it('is unavailable while Windows HDR is off', async () => {
    w.hdr = { supported: true, enabled: false }
    extras = create()
    expect((await extras.status()).autoHdr).toMatchObject({
      available: false,
      hdrOn: false,
      reason: 'Turn on HDR in Windows display settings first'
    })
    await expect(extras.setAutoHdr(true)).rejects.toThrow('Turn on HDR')
    expect(w.autoHdrWrites).toEqual([])
  })

  it('stays available when the HDR state cannot be read', async () => {
    w.hdr = null
    extras = create()
    expect((await extras.status()).autoHdr).toMatchObject({ available: true, hdrOn: null })
  })
})
