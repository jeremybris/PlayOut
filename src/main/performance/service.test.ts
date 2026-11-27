import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PerformanceStatus, PowerProfileId, WindowsPowerMode } from '../../shared/overlay'
import { defaultSettings } from '../../shared/defaults'
import type { Game, GameUserPatch, Settings } from '../../shared/types'
import { EventBus } from '../events'
import type { HelperClient } from './helper-client'
import type { HelperInfo } from './helper/protocol'
import type { HelperInstallState, HelperModule, InstallResult } from './install'
import type { NativeRead } from './native'
import { PERFBOOSTMODE } from './powercfg'
import {
  createPerformanceService,
  profileConfig,
  RTSS_HELPER_RECHECK_MS,
  HELPER_RECHECK_MAX_EVERY,
  FPS_RESTART_BACKOFF_MS,
  HELPER_START_MS,
  HELPER_LOSS_READS,
  HELPER_RECHECK_MS,
  WATTS_REAPPLY_MS,
  type PerformanceIo,
  type PerformanceService
} from './service'

const quiet: Record<'debug' | 'info' | 'warn' | 'error', (msg: string) => void> = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
const SID = 'S-1-5-21-1-2-3-1001'
const PLAN = '381b4222-f694-41f0-9685-ff5bb260df2e'
const MODE_GUID: Record<WindowsPowerMode, string> = {
  efficiency: '961cc777-2547-4f9d-8174-7d86181b8a7a',
  balanced: '00000000-0000-0000-0000-000000000000',
  performance: 'ded574b5-45a0-4f42-8737-46345c09c238'
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await flush()
}

interface World {
  mode: WindowsPowerMode
  cpu: { maxAc: number; maxDc: number; boostAc: number; boostDc: number }
  caption: string
  asus: NativeRead['asus']
  atk: [number, number][]
  powercfg: string[][]
  helper: HelperInstallState
  helperCalls: string[]
  helperInfo: Partial<HelperInfo>
  installs: [HelperModule, string][]
  removes: number
  timers: Map<number, () => void>
  /** Each timer's interval, ms. */
  intervals: Map<number, number>
  /** The next N native reads time out. */
  failReads: number
  /** Dynamic TDP: the clock, the sustained watts in force, the frame rate at those watts, the game's processes. */
  now: number
  watts: number | null
  fps: (watts: number | null) => number | null
  pids: number[]
  /** The helper's PresentMon: still running after a reading; the next N fpsStart and set calls fail. */
  fpsRunning: boolean
  fpsStartFails: number
  setFails: number
  /** The helper's next N info (status) reads time out. */
  infoFails: number
}

function makeWorld(): World {
  return {
    mode: 'balanced',
    cpu: { maxAc: 100, maxDc: 100, boostAc: 2, boostDc: 2 },
    caption: 'Intel64 Family 6 Model 204 Stepping 2',
    asus: null,
    atk: [],
    powercfg: [],
    helper: 'installed',
    helperCalls: [],
    helperInfo: {
      method: 'intel-msr',
      cpu: 'Test Intel',
      minWatts: 5,
      maxWatts: 45,
      currentWatts: 9
    },
    installs: [],
    removes: 0,
    timers: new Map(),
    intervals: new Map(),
    failReads: 0,
    now: 1_000_000,
    watts: null,
    fps: (w) => (w === null ? null : w * 4),
    pids: [4242, 4343],
    fpsRunning: true,
    fpsStartFails: 0,
    setFails: 0,
    infoFails: 0
  }
}

function fakeIo(w: World): PerformanceIo {
  let nextTimer = 1
  const client: HelperClient = {
    async waitUntilRunning(ms) {
      w.helperCalls.push(`wait ${ms}`)
    },
    async request() {
      throw new Error('unused')
    },
    async info() {
      w.helperCalls.push('info')
      if (w.infoFails > 0) {
        w.infoFails--
        throw new Error('the helper did not answer in time')
      }
      return { ok: true, method: null, cpu: '', version: 1, ...w.helperInfo } as HelperInfo
    },
    async set(watts, boostWatts) {
      w.helperCalls.push(`set ${watts} ${boostWatts}`)
      if (w.setFails > 0) {
        w.setFails--
        throw new Error('the helper did not answer')
      }
      w.watts = watts
      return { watts: watts ?? undefined, boostWatts: boostWatts ?? undefined }
    },
    async restore() {
      w.helperCalls.push('restore')
      w.watts = null
    },
    async fpsStart(pids) {
      w.helperCalls.push(`fpsStart ${pids.join(',')}`)
      if (w.fpsStartFails > 0) {
        w.fpsStartFails--
        throw new Error('PresentMon is missing; reinstall the power helper.')
      }
    },
    async fps() {
      w.helperCalls.push('fps')
      const fps = w.fps(w.watts)
      if (!w.fpsRunning) return { fps: null, running: false }
      return { fps, frameTimeMs: fps ? 1000 / fps : undefined, pid: 4242, running: true }
    },
    async fpsStop() {
      w.helperCalls.push('fpsStop')
    },
    async rtssLimit(exe, fps) {
      w.helperCalls.push(`rtssLimit ${exe} ${fps}`)
      return { exe, fps, created: true }
    },
    async rtssSelf(exe) {
      w.helperCalls.push(`rtssSelf ${exe}`)
      return { changed: true }
    },
    async rtssRestore() {
      w.helperCalls.push('rtssRestore')
      return { restored: 1 }
    },
    async memoryTrim(pids, options) {
      w.helperCalls.push(`memoryTrim ${pids.join(',')} ${options.shell} ${options.purgeBelowMb}`)
      return {
        counts: { trimmed: pids.length, denied: 0, skipped: 0, gone: 0 },
        steps: { workingSets: { state: 'done' } }
      }
    },
    close() {
      w.helperCalls.push('close')
    }
  }
  return {
    native: {
      async read() {
        if (w.failReads > 0) {
          w.failReads--
          throw new Error('timed out')
        }
        const g = MODE_GUID[w.mode]
        return { asus: w.asus, scheme: PLAN, cpu: { ...w.cpu }, overlay: { ac: g, dc: g } }
      },
      async activeScheme() {
        return PLAN
      },
      async overlayApi() {
        return { api: true, onBattery: false }
      },
      async setOverlay(_source, guid) {
        const mode = (Object.keys(MODE_GUID) as WindowsPowerMode[]).find(
          (m) => MODE_GUID[m] === guid
        )
        if (!mode) throw new Error(`unknown overlay ${guid}`)
        w.mode = mode
      },
      async cpu() {
        const m = /Family (\d+) Model (\d+)/.exec(w.caption)!
        return {
          name: 'Test CPU',
          id: {
            vendor: w.caption.startsWith('AMD') ? 'amd' : 'intel',
            family: Number(m[1]),
            model: Number(m[2])
          }
        }
      },
      async atkSet(devid, value) {
        w.atk.push([devid, value])
        return 1
      }
    },
    run: async (_file, args) => {
      w.powercfg.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
    userSid: async () => SID,
    helperState: async () => w.helper,
    helperClient: () => client,
    install: async (module, sid): Promise<InstallResult> => {
      w.installs.push([module, sid])
      w.helper = 'installed'
      return { ok: true }
    },
    remove: async (): Promise<InstallResult> => {
      w.removes++
      w.helper = 'missing'
      return { ok: true }
    },
    setInterval: (fn, ms) => {
      const id = nextTimer++
      w.timers.set(id, fn)
      w.intervals.set(id, ms)
      return id
    },
    clearInterval: (h) => {
      w.timers.delete(h as number)
      w.intervals.delete(h as number)
    },
    now: () => w.now
  }
}

/** Runs Dynamic TDP's 1 s tick `n` times (the clock moves a second each time). */
async function tick(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    world.now += 1_000
    for (const [id, ms] of world.intervals) if (ms === 1_000) world.timers.get(id)?.()
    // The fakes answer at once: a few turns of the event loop finish a tick.
    for (let j = 0; j < 3; j++) await flush()
  }
}

let dir = ''
let world: World
let settings: Settings
let settingsListeners: ((s: Settings) => void)[]
let games: Map<string, Game>
let updates: [string, GameUserPatch][]
let running: { gameId: string } | null
let events: EventBus
let emitted: PerformanceStatus[]

function setSettings(change: (p: Settings['performance']) => void): void {
  settings = structuredClone(settings)
  change(settings.performance)
  for (const l of settingsListeners) l(settings)
}

function game(id: string, profile?: PowerProfileId): Game {
  return { id, user: profile ? { performance: { profile } } : {} } as unknown as Game
}

function service(): PerformanceService {
  return createPerformanceService({
    settings: {
      get: () => settings,
      onChange: (l) => {
        settingsListeners.push(l)
        return () => (settingsListeners = settingsListeners.filter((x) => x !== l))
      }
    },
    library: {
      getGame: (id) => games.get(id),
      updateGame: (id, patch) => {
        updates.push([id, patch])
        const g = games.get(id)
        if (g) {
          const p = patch.user?.performance
          g.user = { ...g.user, performance: p ?? undefined }
        }
        return g
      }
    },
    launcher: {
      running: () => running,
      gameProcesses: async () =>
        running ? world.pids.map((pid) => ({ pid, name: 'game.exe' })) : []
    },
    events,
    log: quiet,
    dataDir: dir,
    io: fakeIo(world)
  })
}

const startSession = (id: string): void => {
  running = { gameId: id }
  events.emit('session:started', { gameId: id, startedAt: '2026-11-12T10:00:00Z' })
}
const endSession = (id: string): void => {
  running = null
  events.emit('session:ended', {
    gameId: id,
    startedAt: '2026-11-12T10:00:00Z',
    endedAt: '2026-11-12T11:00:00Z',
    minutes: 60
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playout-perfsvc-'))
  world = makeWorld()
  settings = defaultSettings()
  settingsListeners = []
  games = new Map([
    ['g1', game('g1', 'performance')],
    ['g2', game('g2')]
  ])
  updates = []
  running = null
  events = new EventBus()
  emitted = []
  events.on('performance:status', (s) => emitted.push(s))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('performance service: profiles', () => {
  it('leaves Windows alone with the default "none"', async () => {
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: null, source: null })
    expect(world.powercfg).toEqual([])
    expect(emitted.length).toBeGreaterThan(0)
    expect(s.status().watts).toMatchObject({ state: 'ready', method: 'intel-msr', maxWatts: 45 })
  })

  it('applies the default profile at start', async () => {
    settings.performance.defaultProfile = 'silent'
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'silent', source: 'default' })
    expect(world.mode).toBe('efficiency')
    expect(world.cpu).toEqual({ maxAc: 100, maxDc: 100, boostAc: 2, boostDc: 2 }) // the fake does not store
    expect(world.powercfg.find((a) => a[0] === '/setacvalueindex' && a[4] === '60')).toBeTruthy()
    // On the plan that was read, by GUID.
    expect(world.powercfg.every((a) => a[1] === PLAN)).toBe(true)
  })

  it("says so and changes nothing when Windows' settings could not be read first, then retries", async () => {
    settings.performance.defaultProfile = 'silent'
    // The first read is the watts detection (is the power helper ready?); the second is the profile's.
    world.failReads = 2
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({
      active: 'silent',
      error: "Could not read Windows' power settings first, so they were left as they are."
    })
    expect(world.mode).toBe('balanced')
    expect(world.powercfg).toEqual([])
    const st = await s.apply('silent')
    expect(st.error).toBeUndefined()
    expect(world.mode).toBe('efficiency')
    await s.apply('none')
    expect(world.mode).toBe('balanced')
  })

  it("applies the game's own profile at session start and goes back at session end", async () => {
    settings.performance.defaultProfile = 'balanced'
    const s = service()
    s.start()
    await settle()
    startSession('g1')
    await settle()
    expect(s.status()).toMatchObject({
      active: 'performance',
      source: 'game',
      gameId: 'g1',
      gameProfile: 'performance'
    })
    expect(world.mode).toBe('performance')
    endSession('g1')
    await settle()
    expect(s.status()).toMatchObject({ active: 'balanced', source: 'default' })
    expect(s.status().gameId).toBeUndefined()
    expect(world.mode).toBe('balanced')
  })

  it('uses the default for games without a profile, or when per-game profiles are off', async () => {
    settings.performance.defaultProfile = 'silent'
    settings.performance.perGame = false
    const s = service()
    s.start()
    await settle()
    startSession('g1')
    await settle()
    expect(s.status()).toMatchObject({ active: 'silent', source: 'default', gameId: 'g1' })
  })

  it('puts a manual choice back after the game', async () => {
    const s = service()
    s.start()
    await settle()
    await s.apply('custom')
    expect(s.status()).toMatchObject({ active: 'custom', source: 'manual' })
    startSession('g2')
    await settle()
    // No game profile and default 'none': Windows as it was during the game.
    expect(s.status()).toMatchObject({ active: null, source: null })
    expect(world.mode).toBe('balanced')
    endSession('g2')
    await settle()
    expect(s.status()).toMatchObject({ active: 'custom', source: 'manual' })
  })

  it("saves a profile as the running game's own, and clears it", async () => {
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    const st = await s.apply('silent', 'g2')
    expect(updates).toEqual([['g2', { user: { performance: { profile: 'silent' } } }]])
    expect(st).toMatchObject({ active: 'silent', source: 'game', gameProfile: 'silent' })
    const cleared = await s.apply('none', null)
    expect(updates[1]).toEqual(['g2', { user: { performance: null } }])
    expect(cleared).toMatchObject({ active: null, source: null })
    expect(cleared.gameProfile).toBeUndefined()
    expect(world.mode).toBe('balanced')
  })

  it("null clears the running game's profile whatever profile is applied now", async () => {
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    await s.apply('silent', 'g2')
    const st = await s.apply('performance', null)
    expect(updates[1]).toEqual(['g2', { user: { performance: null } }])
    expect(st).toMatchObject({ active: 'performance', source: 'manual' })
  })

  it('saves for a game that is not running and applies it now as a manual choice', async () => {
    const s = service()
    s.start()
    await settle()
    const st = await s.apply('performance', 'g2')
    expect(updates).toEqual([['g2', { user: { performance: { profile: 'performance' } } }]])
    expect(st).toMatchObject({ active: 'performance', source: 'manual' })
  })

  it('re-applies when the default or the active profile changes in Settings', async () => {
    const s = service()
    s.start()
    await settle()
    setSettings((p) => (p.defaultProfile = 'performance'))
    await settle()
    expect(s.status()).toMatchObject({ active: 'performance', source: 'default' })
    const before = world.powercfg.length
    setSettings((p) => (p.profiles.performance.cpuMaxPercent = 90))
    await settle()
    expect(world.powercfg.slice(before).find((a) => a[4] === '90')).toBeTruthy()
  })

  it('puts Windows back on dispose', async () => {
    settings.performance.defaultProfile = 'silent'
    const s = service()
    s.start()
    await settle()
    expect(world.mode).toBe('efficiency')
    await s.dispose()
    expect(world.mode).toBe('balanced')
  })

  it('restores at start what a crash left on when the default is "none"', async () => {
    settings.performance.defaultProfile = 'silent'
    const first = service()
    first.start()
    await settle()
    expect(world.mode).toBe('efficiency')
    // PlayOut died without dispose; the user meanwhile set the default to none.
    settings = defaultSettings()
    const second = service()
    second.start()
    await settle()
    expect(world.mode).toBe('balanced')
    expect(second.status().active).toBeNull()
  })
})

describe('performance service: watts', () => {
  const withWatts = (watts: number | null, boost: number | null): void => {
    settings.performance.profiles.custom = {
      ...settings.performance.profiles.custom,
      watts,
      boostWatts: boost
    }
  }

  it('sets clamped watts through the helper and re-applies them every 30 s', async () => {
    withWatts(80, 10)
    const s = service()
    s.start()
    await settle()
    await s.apply('custom')
    expect(world.helperCalls).toContain('set 44 45') // clamped to 45; boost must stay 1 W above, so PL1 44
    expect(world.helperCalls.filter((c) => c.startsWith('set'))).toHaveLength(1)
    expect(world.timers.size).toBe(1)
    world.timers.forEach((fn) => fn())
    await settle()
    expect(world.helperCalls.filter((c) => c.startsWith('set'))).toHaveLength(2)
    await s.resume()
    expect(world.helperCalls.filter((c) => c.startsWith('set'))).toHaveLength(3)
    expect(WATTS_REAPPLY_MS).toBe(30_000)
  })

  it('puts the watts back when the next profile has none, and stops the timer', async () => {
    withWatts(15, 25)
    const s = service()
    s.start()
    await settle()
    await s.apply('custom')
    expect(world.helperCalls).toContain('set 15 25')
    await s.apply('balanced')
    expect(world.helperCalls.at(-1)).toBe('restore')
    expect(world.timers.size).toBe(0)
  })

  it('does not touch watts when they are off in Settings, nor start the helper', async () => {
    withWatts(15, 25)
    settings.performance.useWatts = false
    const s = service()
    s.start()
    await settle()
    expect(world.helperCalls).toEqual([])
    expect(s.status().watts).toMatchObject({ state: 'ready', method: 'intel-msr' })
    await s.apply('custom')
    expect(world.helperCalls.filter((c) => c.startsWith('set'))).toEqual([])
  })

  it('reports a locked MSR as unsupported, with the reason, and sets nothing', async () => {
    withWatts(15, 25)
    world.helperInfo = { ...world.helperInfo, locked: true, message: 'locked by the firmware' }
    const s = service()
    s.start()
    await settle()
    const st = await s.apply('custom')
    expect(st.watts).toMatchObject({ state: 'unsupported', message: 'locked by the firmware' })
    expect(world.helperCalls.filter((c) => c.startsWith('set'))).toEqual([])
  })

  it('does not keep asking a helper that can never be ready (a locked CPU): no recheck timer', async () => {
    withWatts(15, 25)
    world.helperInfo = { ...world.helperInfo, locked: true, message: 'locked by the firmware' }
    const s = service()
    s.start()
    await settle()
    // The factory default 'auto' depends on the helper; a locked CPU is 'unsupported', not 'not answering'.
    await s.refresh()
    expect(s.status().watts).toMatchObject({ state: 'unsupported' })
    expect([...world.intervals].some(([, m]) => m === HELPER_RECHECK_MS)).toBe(false)
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })

  it('uses the ASUS firmware without the helper when it has PL1/PL2', async () => {
    withWatts(20, null)
    world.asus = { vivo: -1, rog: 0x10000, pl1: 0x10000, pl2: 0x10000 }
    const s = service()
    s.start()
    await settle()
    expect(s.status().watts).toMatchObject({
      state: 'ready',
      method: 'asus-wmi',
      minWatts: 5,
      maxWatts: 150
    })
    await s.apply('custom')
    expect(world.atk).toContainEqual([0x001200a3, 20])
    expect(world.atk).toContainEqual([0x001200a0, 21])
    expect(world.helperCalls).toEqual([])
  })

  it('is unsupported on an AMD CPU it does not know', async () => {
    world.caption = 'AMD64 Family 25 Model 33 Stepping 0'
    const s = service()
    s.start()
    await settle()
    expect(s.status().watts.state).toBe('unsupported')
  })

  it('installs the helper for this CPU, then applies the active profile’s watts', async () => {
    world.helper = 'missing'
    world.caption = 'AMD64 Family 25 Model 116 Stepping 1'
    world.helperInfo = { method: 'ryzen-smu', cpu: 'Ryzen Z1', minWatts: 5, maxWatts: 65 }
    withWatts(15, 25)
    const s = service()
    s.start()
    await settle()
    expect(s.status().watts).toMatchObject({ state: 'not-installed', method: 'ryzen-smu' })
    await s.apply('custom')
    expect(world.helperCalls).toEqual([])
    const st = await s.installHelper()
    expect(world.installs).toEqual([['RyzenSMU.bin', SID]])
    // The install started the SYSTEM task: PlayOut waits for its pipe, it never starts the helper itself.
    expect(world.helperCalls[0]).toBe(`wait ${HELPER_START_MS}`)
    expect(st.watts).toMatchObject({ state: 'ready', method: 'ryzen-smu' })
    expect(world.helperCalls).toContain('set 15 25')
  })

  it('removes the helper after putting the watts back', async () => {
    withWatts(15, 25)
    const s = service()
    s.start()
    await settle()
    await s.apply('custom')
    const st = await s.removeHelper()
    expect(world.helperCalls.slice(-2)).toEqual(['restore', 'close'])
    expect(world.removes).toBe(1)
    expect(st.watts.state).toBe('not-installed')
    expect(world.timers.size).toBe(0)
  })

  it('puts the watts back on dispose', async () => {
    withWatts(15, 25)
    settings.performance.defaultProfile = 'custom'
    const s = service()
    s.start()
    await settle()
    await s.dispose()
    expect(world.helperCalls).toContain('restore')
    expect(world.timers.size).toBe(0)
  })
})

describe('performance service: Dynamic TDP', () => {
  const dynamicHelper = (): void => {
    world.helperInfo = { ...world.helperInfo, version: 2 }
  }
  const sets = (): string[] => world.helperCalls.filter((c) => c.startsWith('set'))

  it('is the default with a ready helper: idle outside games, Windows keeps its watts', async () => {
    dynamicHelper()
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({
      active: 'dynamic',
      source: 'default',
      helper: 'ready',
      dynamic: { targetFps: 60, state: 'idle' }
    })
    expect(sets()).toEqual([])
    expect(world.mode).toBe('balanced')
  })

  it("auto with no game changes none of Windows' settings; neutral only during a game, then put back", async () => {
    dynamicHelper()
    world.mode = 'performance'
    expect(settings.performance.defaultProfile).toBe('auto')
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default' })
    expect(world.powercfg).toEqual([])
    expect(world.mode).toBe('performance')
    expect(sets()).toEqual([])
    // In a game the no-driver part goes neutral (balanced power mode, CPU 100 %, boost on)...
    startSession('g2')
    await settle()
    expect(world.mode).toBe('balanced')
    expect(world.powercfg.length).toBeGreaterThan(0)
    // ...and Windows' own comes back after it.
    endSession('g2')
    await settle()
    expect(world.mode).toBe('performance')
    expect(s.status()).toMatchObject({ active: 'dynamic', dynamic: { state: 'idle' } })
  })

  it('needs protocol 2: an older helper is outdated and the default stays Windows as it is', async () => {
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: null, helper: 'outdated' })
    expect(s.status().dynamic).toBeUndefined()
  })

  it('is not offered with ASUS firmware watts, or with watts off', async () => {
    world.asus = { vivo: -1, rog: 0x10000, pl1: 0x10000, pl2: 0x10000 }
    dynamicHelper()
    const s = service()
    s.start()
    await settle()
    expect(s.status().helper).toBe('none')

    const t = service()
    world.asus = null
    settings.performance.useWatts = false
    t.start()
    await settle()
    expect(t.status()).toMatchObject({ active: null, helper: 'none' })
  })

  it('measures the game, moves the watts toward the target, and puts them back after the game', async () => {
    dynamicHelper()
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    expect(world.helperCalls).toContain('fpsStart 4242,4343')
    // Starts in the middle of 5-45 W, with boost 5 W above.
    expect(sets()[0]).toBe('set 25 30')
    expect(s.status()).toMatchObject({ active: 'dynamic', gameId: 'g2' })
    // 4 fps per watt: 25 W gives 100 fps, more than 60: it lowers, 1 W at a time.
    await tick(30)
    const last = sets().at(-1)!
    const w = Number(last.split(' ')[1])
    expect(w).toBeLessThan(25)
    expect(s.status().dynamic).toMatchObject({ targetFps: 60, watts: w })
    expect(s.status().dynamic!.fps).toBeGreaterThan(60)
    expect(world.mode).toBe('balanced')
    // The 30 s re-apply writes the value Dynamic TDP set last.
    for (const [id, ms] of world.intervals) if (ms === WATTS_REAPPLY_MS) world.timers.get(id)?.()
    await settle()
    expect(sets().at(-1)).toBe(last)
    endSession('g2')
    await settle()
    expect(world.helperCalls).toContain('fpsStop')
    expect(world.helperCalls.at(-1)).toBe('restore')
    expect(s.status()).toMatchObject({ active: 'dynamic', dynamic: { state: 'idle' } })
    const before = world.helperCalls.length
    await tick(3)
    expect(world.helperCalls.length).toBe(before)
  })

  it("keeps a game's own target and uses it while that game runs", async () => {
    dynamicHelper()
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    const st = await s.apply('dynamic', 'g2', { targetFps: 45 })
    expect(updates.at(-1)).toEqual([
      'g2',
      { user: { performance: { profile: 'dynamic', targetFps: 45 } } }
    ])
    expect(st).toMatchObject({
      active: 'dynamic',
      source: 'game',
      gameProfile: 'dynamic',
      gameTargetFps: 45
    })
    expect(st.dynamic?.targetFps).toBe(45)
    // Picking it again for the game keeps the target it had.
    await s.apply('dynamic', 'g2')
    expect(updates.at(-1)).toEqual([
      'g2',
      { user: { performance: { profile: 'dynamic', targetFps: 45 } } }
    ])
    // A target out of range is clamped.
    expect((await s.apply('dynamic', undefined, { targetFps: 1000 })).dynamic?.targetFps).toBe(240)
  })

  it('a manual target lasts until Settings change the target', async () => {
    dynamicHelper()
    const s = service()
    s.start()
    await settle()
    expect((await s.apply('dynamic', undefined, { targetFps: 40 })).dynamic?.targetFps).toBe(40)
    setSettings((p) => (p.dynamic = { ...p.dynamic, targetFps: 90 }))
    await settle()
    expect(s.status().dynamic?.targetFps).toBe(90)
  })

  it('waits for the game processes and starts measuring once they appear', async () => {
    dynamicHelper()
    world.pids = []
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    expect(world.helperCalls.filter((c) => c.startsWith('fpsStart'))).toEqual([])
    expect(s.status().dynamic?.state).toBe('measuring')
    world.pids = [5555]
    await tick(6)
    expect(world.helperCalls).toContain('fpsStart 5555')
  })

  it('falls back to Balanced for a game whose own profile is Dynamic TDP when the helper is not ready', async () => {
    games.set('g3', {
      id: 'g3',
      user: { performance: { profile: 'dynamic', targetFps: 30 } }
    } as unknown as Game)
    const s = service()
    s.start()
    await settle()
    startSession('g3')
    await settle()
    expect(s.status()).toMatchObject({ active: 'balanced', helper: 'outdated' })
    expect(world.helperCalls.filter((c) => c.startsWith('fps'))).toEqual([])
  })

  it('turns the auto default on once the helper answers, but never over a manual Off', async () => {
    dynamicHelper()
    world.helper = 'missing'
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: null, helper: 'missing' })
    // The helper is there now (it was still starting, or was installed): the next refresh picks it up.
    world.helper = 'installed'
    expect(await s.refresh()).toMatchObject({
      active: 'dynamic',
      source: 'default',
      helper: 'ready'
    })
    await s.apply('none')
    expect(await s.refresh()).toMatchObject({ active: null, helper: 'ready' })
  })

  it("keeps Windows' own picked by hand when watts are turned off and on again", async () => {
    dynamicHelper()
    const s = service()
    s.start()
    await settle()
    expect(s.status().active).toBe('dynamic')
    await s.apply('none')
    setSettings((p) => (p.useWatts = false))
    await settle()
    setSettings((p) => (p.useWatts = true))
    await settle()
    expect(s.status()).toMatchObject({ active: null, source: null })
    expect(sets()).toEqual([])
  })

  it('re-applies the default when watts are turned back on and the default is in effect', async () => {
    dynamicHelper()
    settings.performance.useWatts = false
    const s = service()
    s.start()
    await settle()
    expect(s.status().active).toBeNull()
    setSettings((p) => (p.useWatts = true))
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default' })
  })

  it('backs off restarting a PresentMon that keeps stopping (5 s, 15 s, 60 s), logs once, and starts over with frames', async () => {
    dynamicHelper()
    const warns: string[] = []
    const warn = quiet.warn
    quiet.warn = (m: string): void => void warns.push(m)
    try {
      const s = service()
      s.start()
      await settle()
      startSession('g2')
      await settle()
      const starts = (): number => world.helperCalls.filter((c) => c.startsWith('fpsStart')).length
      expect(starts()).toBe(1)
      world.fpsRunning = false
      const at: number[] = []
      const t0 = world.now
      for (let i = 0; i < 120; i++) {
        const before = starts()
        await tick(1)
        if (starts() > before) at.push(world.now - t0)
      }
      // Restarts 5 s, then 15 s, then 60 s after each stop (the pid rescan runs every 5 s, so up to 5 s later).
      expect(at.length).toBe(3)
      const gaps = [at[0]!, at[1]! - at[0]!, at[2]! - at[1]!]
      gaps.forEach((g, i) => {
        expect(g).toBeGreaterThanOrEqual(FPS_RESTART_BACKOFF_MS[i]!)
        expect(g).toBeLessThanOrEqual(FPS_RESTART_BACKOFF_MS[i]! + 6_000)
      })
      expect(warns.filter((m) => m.includes('measuring frames stopped'))).toHaveLength(1)
      // Other processes to measure: started at once.
      world.pids = [7777]
      const before = starts()
      await tick(6)
      expect(starts()).toBe(before + 1)
      expect(world.helperCalls.filter((c) => c.startsWith('fpsStart')).at(-1)).toBe('fpsStart 7777')
    } finally {
      quiet.warn = warn
    }
  })

  it('a failed Dynamic TDP start drops the Custom watts it replaced (no stale re-apply)', async () => {
    dynamicHelper()
    settings.performance.profiles.custom = {
      ...settings.performance.profiles.custom,
      watts: 20,
      boostWatts: 25
    }
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    await s.apply('custom')
    expect(sets().at(-1)).toBe('set 20 25')
    // The helper is gone now: Dynamic TDP cannot start, and 'dynamic' goes on as Balanced (no watts) instead.
    world.helper = 'missing'
    const st = await s.apply('dynamic')
    expect(st).toMatchObject({ active: 'balanced', source: 'manual', helper: 'missing' })
    const count = sets().length
    for (const [id, ms] of world.intervals) if (ms === WATTS_REAPPLY_MS) world.timers.get(id)?.()
    await settle()
    expect(sets().length).toBe(count)
    expect([...world.intervals.values()]).not.toContain(WATTS_REAPPLY_MS)
  })

  it('a failed Dynamic TDP start in a game still makes the no-driver part neutral (no profile left over)', async () => {
    dynamicHelper()
    settings.performance.profiles.custom = {
      ...settings.performance.profiles.custom,
      powerMode: 'efficiency',
      cpuMaxPercent: 60
    }
    const s = service()
    s.start()
    await settle()
    // Custom by hand outside games: efficiency mode, CPU at 60 %.
    await s.apply('custom')
    expect(world.mode).toBe('efficiency')
    // The helper is gone by the time a game starts: 'auto' still resolves to Dynamic TDP from the cached state.
    world.helper = 'missing'
    world.powercfg = []
    startSession('g2')
    await settle()
    // Dynamic TDP found no helper: 'auto' goes on as it is without one (Windows' own settings, as before Custom).
    expect(s.status()).toMatchObject({ active: null, gameId: 'g2', helper: 'missing' })
    expect(world.mode).toBe('balanced')
    expect(world.powercfg.find((a) => a[0] === '/setacvalueindex' && a[4] === '100')).toBeTruthy()
  })

  it('writes the watts again on the next tick when the helper failed to set them', async () => {
    dynamicHelper()
    world.setFails = 1
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    expect(sets()).toEqual(['set 25 30'])
    expect(world.watts).toBeNull()
    await tick(1)
    expect(sets()).toEqual(['set 25 30', 'set 25 30'])
    expect(world.watts).toBe(25)
  })

  it('stops measuring and puts the watts back on dispose', async () => {
    dynamicHelper()
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    await s.dispose()
    expect(world.helperCalls).toContain('fpsStop')
    expect(world.helperCalls).toContain('restore')
    expect(world.timers.size).toBe(0)
  })
})

describe('performance service: a helper that misses a read', () => {
  const sets = (): string[] => world.helperCalls.filter((c) => c.startsWith('set'))
  const timerFor = (ms: number): number | undefined =>
    [...world.intervals].find(([, m]) => m === ms)?.[0]
  /** Fires the HELPER_RECHECK_MS timer (which must be running). */
  const recheck = async (): Promise<void> => {
    const id = timerFor(HELPER_RECHECK_MS)
    expect(id).toBeDefined()
    world.timers.get(id!)?.()
    await settle()
  }
  async function inGame(): Promise<PerformanceService> {
    world.helperInfo = { ...world.helperInfo, version: 2 }
    const s = service()
    s.start()
    await settle()
    startSession('g2')
    await settle()
    await tick(5)
    expect(s.status()).toMatchObject({ active: 'dynamic', gameId: 'g2', helper: 'ready' })
    return s
  }

  it('one or two failed reads mid-game leave Dynamic TDP running untouched', async () => {
    const s = await inGame()
    const controller = timerFor(1_000)
    const writes = sets().length
    world.infoFails = HELPER_LOSS_READS - 1
    for (let i = 0; i < HELPER_LOSS_READS - 1; i++) {
      expect(await s.refresh()).toMatchObject({
        active: 'dynamic',
        helper: 'ready',
        watts: { state: 'error' }
      })
    }
    expect(world.helperCalls).not.toContain('fpsStop')
    expect(world.helperCalls).not.toContain('restore')
    expect(timerFor(1_000)).toBe(controller)
    await tick(5)
    // Not restarted from the middle of the range: the controller goes on from where it was.
    expect(sets().slice(writes)).not.toContain('set 25 30')
    expect(s.status().dynamic?.state).not.toBe('idle')
    // The overlay stops refreshing (watts not ready): PlayOut asks again on its own, and the helper answers.
    await recheck()
    expect(s.status()).toMatchObject({
      active: 'dynamic',
      helper: 'ready',
      watts: { state: 'ready' }
    })
    expect(timerFor(1_000)).toBe(controller)
    expect(timerFor(HELPER_RECHECK_MS)).toBeUndefined()
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })

  it('counts misses in a row only: one answer starts over', async () => {
    const s = await inGame()
    const controller = timerFor(1_000)
    world.infoFails = HELPER_LOSS_READS - 1
    for (let i = 0; i < HELPER_LOSS_READS - 1; i++) await s.refresh()
    await s.refresh()
    world.infoFails = HELPER_LOSS_READS - 1
    for (let i = 0; i < HELPER_LOSS_READS - 1; i++) await s.refresh()
    expect(s.status()).toMatchObject({ active: 'dynamic', helper: 'ready' })
    expect(timerFor(1_000)).toBe(controller)
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })

  it('a helper gone for HELPER_LOSS_READS reads switches; Dynamic TDP comes back once it answers (no overlay)', async () => {
    const s = await inGame()
    world.infoFails = 99
    await s.refresh()
    // Watts are no longer ready, so the overlay stops refreshing: the recheck timer carries on.
    for (let i = 1; i < HELPER_LOSS_READS; i++) await recheck()
    expect(s.status()).toMatchObject({ active: null, helper: 'none' })
    expect(world.helperCalls).toContain('fpsStop')
    expect(timerFor(1_000)).toBeUndefined()
    // Still waiting for the helper: asked again every HELPER_RECHECK_MS.
    await recheck()
    expect(s.status()).toMatchObject({ active: null, helper: 'none' })
    world.infoFails = 0
    const before = sets().length
    // The recheck backs off while nothing changes (every 1, 2, 4, then 8 ticks): the helper is asked within that.
    for (let i = 0; i < HELPER_RECHECK_MAX_EVERY && s.status().active !== 'dynamic'; i++)
      await recheck()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default', helper: 'ready' })
    expect(timerFor(1_000)).toBeDefined()
    expect(sets().length).toBeGreaterThan(before)
    expect(timerFor(HELPER_RECHECK_MS)).toBeUndefined()
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })

  it('a game’s own fallback profile goes on as itself after a confirmed loss, and Dynamic TDP once the helper answers', async () => {
    games.set('g2', game('g2', 'silent'))
    const s = await inGame()
    world.infoFails = 99
    for (let i = 0; i < HELPER_LOSS_READS; i++) await s.refresh()
    expect(s.status()).toMatchObject({ active: 'silent', source: 'game', helper: 'none' })
    expect(world.mode).toBe('efficiency')
    world.infoFails = 0
    await recheck()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'game', helper: 'ready' })
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })

  it("'outdated' or 'missing' switch at once, and do not keep asking", async () => {
    let s = await inGame()
    world.helperInfo = { ...world.helperInfo, version: 1 }
    expect(await s.refresh()).toMatchObject({ active: null, helper: 'outdated' })
    expect(timerFor(1_000)).toBeUndefined()
    expect(timerFor(HELPER_RECHECK_MS)).toBeUndefined()
    await s.dispose()
    expect(world.timers.size).toBe(0)
    running = null
    world = makeWorld()
    events = new EventBus()
    s = await inGame()
    world.helper = 'missing'
    expect(await s.refresh()).toMatchObject({ active: null, helper: 'missing' })
    expect(timerFor(HELPER_RECHECK_MS)).toBeUndefined()
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })

  it('a game that starts while a read missed gets Dynamic TDP once the helper answers', async () => {
    world.helperInfo = { ...world.helperInfo, version: 2 }
    const s = service()
    s.start()
    await settle()
    world.infoFails = 1
    startSession('g2')
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', helper: 'ready' })
    expect(timerFor(1_000)).toBeUndefined()
    await recheck()
    expect(timerFor(1_000)).toBeDefined()
    expect(s.status().dynamic?.state).not.toBe('idle')
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })

  it('turning watts off or removing the helper counts at once, and stops asking', async () => {
    const s = await inGame()
    world.infoFails = 1
    await s.refresh()
    expect(timerFor(HELPER_RECHECK_MS)).toBeDefined()
    setSettings((p) => (p.useWatts = false))
    await settle()
    expect(s.status()).toMatchObject({ active: null, helper: 'none' })
    expect(timerFor(1_000)).toBeUndefined()
    expect(timerFor(HELPER_RECHECK_MS)).toBeUndefined()
    setSettings((p) => (p.useWatts = true))
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', helper: 'ready' })
    world.infoFails = 1
    await s.refresh()
    await s.removeHelper()
    expect(s.status()).toMatchObject({ active: null, helper: 'missing' })
    expect(timerFor(HELPER_RECHECK_MS)).toBeUndefined()
    await s.dispose()
    expect(world.timers.size).toBe(0)
  })
})

describe('performance service: no fallback profiles with the power helper', () => {
  const readyHelper = (): void => {
    world.helperInfo = { ...world.helperInfo, version: 2 }
  }

  it("runs a fallback profile saved before the helper as Dynamic TDP (default, a game's own, a pick), logged once", async () => {
    readyHelper()
    settings.performance.defaultProfile = 'silent'
    const infos: string[] = []
    const info = quiet.info
    quiet.info = (m: string): void => void infos.push(m)
    try {
      const s = service()
      s.start()
      await settle()
      expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default' })
      expect(world.mode).not.toBe('efficiency')
      // g1's own profile is Performance: it runs, and shows, as Dynamic TDP.
      startSession('g1')
      await settle()
      expect(s.status()).toMatchObject({
        active: 'dynamic',
        source: 'game',
        gameProfile: 'dynamic'
      })
      endSession('g1')
      await settle()
      startSession('g1')
      await settle()
      expect(infos.filter((m) => m.includes('performance is not offered'))).toHaveLength(1)
      expect(infos.filter((m) => m.includes('silent is not offered'))).toHaveLength(1)
      // A pick of a fallback profile (an old client) is Dynamic TDP too, and kept as Dynamic TDP for the game.
      expect(await s.apply('balanced', 'g1')).toMatchObject({ active: 'dynamic' })
      expect(updates.at(-1)?.[0]).toBe('g1')
      expect(updates.at(-1)?.[1]).toMatchObject({ user: { performance: { profile: 'dynamic' } } })
      await s.dispose()
    } finally {
      quiet.info = info
    }
  })

  it('keeps the fallback profiles without the helper, and switches to Dynamic TDP once it is ready', async () => {
    readyHelper()
    world.helper = 'missing'
    settings.performance.defaultProfile = 'balanced'
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'balanced', helper: 'missing' })
    await s.apply('silent')
    expect(s.status()).toMatchObject({ active: 'silent', source: 'manual' })
    world.helper = 'installed'
    expect(await s.refresh()).toMatchObject({
      active: 'dynamic',
      source: 'manual',
      helper: 'ready'
    })
  })

  it('turning watts off puts a saved fallback profile in effect as itself, and on again as Dynamic TDP', async () => {
    readyHelper()
    settings.performance.defaultProfile = 'performance'
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default', helper: 'ready' })
    setSettings((p) => (p.useWatts = false))
    await settle()
    expect(s.status()).toMatchObject({ active: 'performance', source: 'default', helper: 'none' })
    expect(world.mode).toBe('performance')
    setSettings((p) => (p.useWatts = true))
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default', helper: 'ready' })
    // A game's own (Performance, saved before the helper) and a pick by hand: the same, both ways.
    startSession('g1')
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'game', gameProfile: 'dynamic' })
    setSettings((p) => (p.useWatts = false))
    await settle()
    expect(s.status()).toMatchObject({
      active: 'performance',
      source: 'game',
      gameProfile: 'performance'
    })
    endSession('g1')
    await settle()
    setSettings((p) => (p.useWatts = true))
    await settle()
    await s.apply('silent')
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'manual' })
    setSettings((p) => (p.useWatts = false))
    await settle()
    expect(s.status()).toMatchObject({ active: 'silent', source: 'manual' })
    expect(world.mode).toBe('efficiency')
    setSettings((p) => (p.useWatts = true))
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'manual' })
  })

  it('removing the helper puts a fallback profile that ran as Dynamic TDP back as itself; installing it again, Dynamic', async () => {
    readyHelper()
    settings.performance.defaultProfile = 'balanced'
    world.mode = 'performance'
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default' })
    expect(await s.removeHelper()).toMatchObject({
      active: 'balanced',
      source: 'default',
      helper: 'missing'
    })
    expect(world.mode).toBe('balanced')
    expect(await s.installHelper()).toMatchObject({
      active: 'dynamic',
      source: 'default',
      helper: 'ready'
    })
    // A game's own Silent: back as Silent in the game when the helper goes.
    games.set('g2', game('g2', 'silent'))
    startSession('g2')
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'game', gameProfile: 'dynamic' })
    expect(await s.removeHelper()).toMatchObject({
      active: 'silent',
      source: 'game',
      gameProfile: 'silent'
    })
    expect(world.mode).toBe('efficiency')
  })

  it('a helper found outdated (or gone) by a refresh puts the saved profile back as itself, and Dynamic once ready', async () => {
    readyHelper()
    const s = service()
    s.start()
    await settle()
    await s.apply('performance')
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'manual' })
    world.helperInfo = { ...world.helperInfo, version: 1 }
    expect(await s.refresh()).toMatchObject({
      active: 'performance',
      source: 'manual',
      helper: 'outdated'
    })
    expect(world.mode).toBe('performance')
    readyHelper()
    expect(await s.refresh()).toMatchObject({
      active: 'dynamic',
      source: 'manual',
      helper: 'ready'
    })
    // 'dynamic' by hand without the helper is Balanced.
    await s.apply('dynamic')
    world.helper = 'missing'
    expect(await s.refresh()).toMatchObject({ active: 'balanced', source: 'manual' })
  })

  it("a helper that died before a game starts: the game's own fallback profile goes on as itself", async () => {
    readyHelper()
    games.set('g2', game('g2', 'silent'))
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', helper: 'ready' })
    world.helper = 'missing'
    startSession('g2')
    await settle()
    expect(s.status()).toMatchObject({ active: 'silent', source: 'game', helper: 'missing' })
    expect(world.mode).toBe('efficiency')
  })

  it('turning watts on switches a fallback profile to Dynamic TDP at once (no refresh needed)', async () => {
    readyHelper()
    settings.performance.useWatts = false
    settings.performance.defaultProfile = 'performance'
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'performance', helper: 'none' })
    const before = emitted.length
    setSettings((p) => (p.useWatts = true))
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default', helper: 'ready' })
    expect(emitted.slice(before).some((e) => e.active === 'performance')).toBe(false)
  })

  it('a fallback profile put in effect again reads the helper first: one started since runs it as Dynamic TDP', async () => {
    readyHelper()
    settings.performance.defaultProfile = 'performance'
    settings.performance.profiles.performance = {
      ...settings.performance.profiles.performance,
      watts: 30,
      boostWatts: 35
    }
    world.helper = 'missing'
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'performance', helper: 'missing' })
    // The helper starts behind PlayOut's back; a game's start applies the default again.
    world.helper = 'installed'
    startSession('g2')
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default', helper: 'ready' })
  })

  it('keeps Custom watts and Off when they are picked', async () => {
    readyHelper()
    const s = service()
    s.start()
    await settle()
    expect(s.status()).toMatchObject({ active: 'dynamic', source: 'default' })
    expect(await s.apply('custom')).toMatchObject({ active: 'custom', source: 'manual' })
    expect(await s.apply('none')).toMatchObject({ active: null })
  })
})

describe('performance service: CPU boost overrides and the RivaTuner helper', () => {
  /** The PERFBOOSTMODE values written on AC, in order. */
  const boostWrites = (): string[] =>
    world.powercfg
      .filter((a) => a[0] === '/setacvalueindex' && a[3] === PERFBOOSTMODE)
      .map((a) => a[4]!)

  it('applies a preset with its boost override on top', () => {
    const p = defaultSettings().performance
    expect(profileConfig(p, 'balanced').cpuBoost).toBe(true)
    expect(profileConfig({ ...p, boostOverrides: { balanced: false } }, 'balanced')).toEqual({
      ...p.profiles.balanced,
      cpuBoost: false
    })
    // An override equal to the preset's own changes nothing; Custom ignores overrides.
    expect(profileConfig({ ...p, boostOverrides: { silent: false } }, 'silent')).toBe(
      p.profiles.silent
    )
    expect(profileConfig({ ...p, boostOverrides: {} }, 'custom')).toBe(p.profiles.custom)
  })

  it('re-applies the profile in effect when its boost override changes, and only then', async () => {
    settings.performance.defaultProfile = 'balanced'
    const s = service()
    s.start()
    await settle()
    expect(boostWrites()).toEqual(['2'])
    setSettings((p) => (p.boostOverrides = { balanced: false }))
    await settle()
    expect(boostWrites()).toEqual(['2', '0'])
    // Another preset's override leaves the one in effect alone.
    setSettings((p) => (p.boostOverrides = { balanced: false, silent: true }))
    await settle()
    expect(boostWrites()).toEqual(['2', '0'])
    setSettings((p) => (p.boostOverrides = {}))
    await settle()
    expect(boostWrites()).toEqual(['2', '0', '2'])
  })

  it('offers the RivaTuner operations only from a ready helper at protocol 3', async () => {
    world.helperInfo = { ...world.helperInfo, version: 2 }
    const s = service()
    s.start()
    await settle()
    expect(await s.rtssHelper()).toBeNull()
    // Asked again only after a while.
    world.helperInfo = { ...world.helperInfo, version: 3 }
    const infos = world.helperCalls.filter((c) => c === 'info').length
    expect(await s.rtssHelper()).toBeNull()
    expect(world.helperCalls.filter((c) => c === 'info').length).toBe(infos)
    world.now += RTSS_HELPER_RECHECK_MS
    const h = await s.rtssHelper()
    expect(h).not.toBeNull()
    await h!.rtssLimit('Game.exe', 60)
    await h!.rtssSelf('PlayOut.exe')
    await h!.rtssRestore()
    expect(world.helperCalls).toEqual(
      expect.arrayContaining(['rtssLimit Game.exe 60', 'rtssSelf PlayOut.exe', 'rtssRestore'])
    )
  })

  it('keeps the RivaTuner operations with watts off, when a profile change reads the helper without asking it', async () => {
    settings.performance.useWatts = false
    world.helperInfo = { ...world.helperInfo, version: 3 }
    const s = service()
    s.start()
    await settle()
    expect(await s.rtssHelper()).not.toBeNull()
    // A game starts: its profile goes on, and with watts off the helper is only checked for being installed.
    const infos = world.helperCalls.filter((c) => c === 'info').length
    startSession('g1')
    await settle()
    expect(world.helperCalls.filter((c) => c === 'info').length).toBe(infos)
    expect(await s.rtssHelper()).not.toBeNull()
    // A helper that is removed is no longer offered.
    world.helper = 'missing'
    endSession('g1')
    await settle()
    expect(await s.rtssHelper()).toBeNull()
  })

  it('has no RivaTuner operations without a helper method', async () => {
    world.caption = 'AMD64 Family 25 Model 33 Stepping 0'
    world.helperInfo = { ...world.helperInfo, version: 3 }
    const s = service()
    s.start()
    await settle()
    expect(await s.rtssHelper()).toBeNull()
    expect(await s.memoryHelper()).toBeNull()
    expect(s.memoryTier()).toBe('unavailable')
  })

  it('offers the memory cleanup only from a ready helper at protocol 4', async () => {
    world.helperInfo = { ...world.helperInfo, version: 3 }
    const s = service()
    // Before the PC is read: nothing to offer yet, and nothing claimed about the PC either.
    expect(s.memoryTier()).toBe('unknown')
    s.start()
    await settle()
    // An older helper still does the RivaTuner work, but not the memory cleanup.
    expect(await s.rtssHelper()).not.toBeNull()
    expect(await s.memoryHelper()).toBeNull()
    expect(s.memoryTier()).toBe('outdated')
    world.helperInfo = { ...world.helperInfo, version: 4 }
    world.now += RTSS_HELPER_RECHECK_MS
    const h = await s.memoryHelper()
    expect(h).not.toBeNull()
    expect(s.memoryTier()).toBe('ready')
    await h!.memoryTrim([1234, 5678], { shell: true, purgeBelowMb: 2048, createdBefore: 1 })
    expect(world.helperCalls).toContain('memoryTrim 1234,5678 true 2048')
  })

  it('says whether the helper is missing or needs an update for the memory cleanup', async () => {
    world.helper = 'missing'
    const s = service()
    s.start()
    await settle()
    expect(await s.memoryHelper()).toBeNull()
    expect(s.memoryTier()).toBe('missing')
    world.helper = 'outdated'
    await s.refresh()
    expect(s.memoryTier()).toBe('outdated')
  })

  it('tells an installed helper that does not answer from a missing one', async () => {
    world.infoFails = 1000
    const s = service()
    s.start()
    await settle()
    expect(s.status().watts?.state).toBe('error')
    expect(await s.memoryHelper()).toBeNull()
    // Settings then offers Remove, not Install: the hint must not say "install it".
    expect(s.memoryTier()).toBe('not-answering')
  })
})
