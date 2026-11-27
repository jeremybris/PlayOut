import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../../shared/defaults'
import type { MemoryPassResult, MemoryStatus, MemorySystemTier } from '../../../shared/memory'
import type { Game, PlayOutEvents, Settings } from '../../../shared/types'
import type { ProcessInfo } from '../../launcher/process-monitor'
import type { ForegroundWindow } from '../../native-host/native-ops'
import { HelperMemoryBusyError, type HelperMemoryResult } from '../helper/protocol'
import type { MemoryHelper } from '../service'
import {
  COOLDOWN_MS,
  PASS_TIMEOUT_MS,
  SAMPLE_MS,
  SESSION_DELAY_MS,
  SKIP_BACKOFF_MS
} from './planner'
import {
  createMemoryService,
  foregroundUnknownMessage,
  gameUnknownMessage,
  helperBusyMessage,
  HELPER_FALLBACK_WITHIN_MS,
  notRunningMessage,
  stillFinishingMessage,
  passLogLine,
  SETTLE_MS,
  stepsText,
  type MemoryService
} from './service'

const OWN = 9000
const GAME = 5000
const DISCORD = 6000
const CHROME = 6004
const GB = 1024

const proc = (pid: number, name: string, path: string | null, parentPid = 700): ProcessInfo => ({
  pid,
  parentPid,
  name,
  path,
  sessionId: 1
})

const LIST: ProcessInfo[] = [
  proc(4, 'System', null, 0),
  proc(OWN, 'PlayOut.exe', 'C:\\Program Files\\PlayOut\\PlayOut.exe'),
  proc(OWN + 4, 'PlayOut.exe', 'C:\\Program Files\\PlayOut\\PlayOut.exe', OWN),
  proc(GAME, 'halo.exe', 'D:\\Games\\Halo\\halo.exe'),
  proc(DISCORD, 'Discord.exe', 'C:\\Users\\p\\AppData\\Local\\Discord\\Discord.exe'),
  proc(CHROME, 'chrome.exe', 'C:\\Program Files\\Google\\Chrome\\chrome.exe'),
  proc(700, 'explorer.exe', 'C:\\Windows\\explorer.exe', 600),
  proc(800, 'MsMpEng.exe', null, 600)
]

interface World {
  now: number
  availableMb: number
  totalMb: number
  /** Available memory after a trim (what the pass "frees"). */
  afterTrimMb: number
  list: ProcessInfo[]
  running: { gameId: string } | null
  gameProcs: { pid: number }[]
  /** The process of the window in front; null: the native worker could not read it. */
  foregroundPid: number | null
  /** native.foreground() rejects instead of answering null. */
  foregroundThrows: boolean
  /** How often the process list and the window in front were read. */
  listReads: number
  foregroundReads: number
  /** The createdBefore each trim (either tier) was given. */
  cutoffs: number[]
  helper: MemoryHelper | null
  /** Set to hold the question "is the helper ready?" open until released. */
  helperGate: Promise<void> | null
  tier: MemorySystemTier
  trims: { pids: number[]; shell: boolean }[]
  helperCalls: { pids: number[]; shell: boolean; purgeBelowMb: number }[]
  /** Set to hold a trim open until released. */
  gate: Promise<void> | null
  /** How long PlayOut's own trim says it took; undefined: it does not say. */
  trimMs?: number
  intervals: { fn: () => void; ms: number; cleared: boolean }[]
  timeouts: { fn: () => void; at: number; cleared: boolean }[]
  events: { name: string; payload: unknown }[]
  listeners: Map<string, ((payload: never) => void)[]>
  settingsListeners: ((s: Settings) => void)[]
}

let world: World
let settings: Settings
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const SYSTEM_RESULT: HelperMemoryResult = {
  counts: { trimmed: 40, denied: 3, skipped: 1, gone: 1 },
  steps: {
    workingSets: { state: 'done' },
    modifiedList: { state: 'done' },
    lowPriorityStandby: { state: 'done' },
    standby: { state: 'skipped', detail: 'enough memory is free' },
    combine: { state: 'failed', detail: 'this Windows version does not support it' }
  }
}

function helper(result: HelperMemoryResult | Error = SYSTEM_RESULT): MemoryHelper {
  return {
    async memoryTrim(pids, options) {
      world.helperCalls.push({
        pids: [...pids],
        shell: options.shell,
        purgeBelowMb: options.purgeBelowMb
      })
      world.cutoffs.push(options.createdBefore)
      if (world.gate) await world.gate
      if (result instanceof Error) throw result
      world.availableMb = world.afterTrimMb
      return result
    }
  }
}

function emitEvent<K extends keyof PlayOutEvents>(name: K, payload: PlayOutEvents[K]): void {
  for (const l of world.listeners.get(name) ?? []) l(payload as never)
}

/** Lets the pass's promise chain run (its awaits resolve at once in this world). */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

/** Runs the timers that are due at world.now (a session pass, the pass timeout). */
function fireTimeouts(): void {
  for (const t of world.timeouts)
    if (!t.cleared && t.at <= world.now) {
      t.cleared = true
      t.fn()
    }
}

/** One memory sample, as the 30 s sampler takes it. */
function sample(): void {
  for (const i of world.intervals) if (!i.cleared) i.fn()
}

function service(): MemoryService {
  return createMemoryService({
    settings: {
      get: () => settings,
      onChange: (l) => {
        world.settingsListeners.push(l)
        return () => {
          world.settingsListeners = world.settingsListeners.filter((x) => x !== l)
        }
      }
    },
    events: {
      emit: (name, payload) => void world.events.push({ name, payload }),
      on: (name, listener) => {
        const of = world.listeners.get(name) ?? []
        of.push(listener as (payload: never) => void)
        world.listeners.set(name, of)
        return () => {
          world.listeners.set(
            name,
            (world.listeners.get(name) ?? []).filter((x) => x !== listener)
          )
        }
      }
    },
    log,
    launcher: {
      running: () => world.running,
      gameProcesses: async () => world.gameProcs,
      processes: async () => {
        world.listReads++
        return world.list
      }
    },
    library: {
      getGame: (id) => (id === 'g1' ? ({ id, installDir: 'D:\\Games\\Halo' } as Game) : undefined)
    },
    native: {
      foreground: async () => {
        world.foregroundReads++
        if (world.foregroundThrows) throw new Error('the worker timed out')
        return world.foregroundPid === null
          ? null
          : ({ pid: world.foregroundPid } as ForegroundWindow)
      },
      trimWorkingSets: async (pids, shell, createdBefore) => {
        world.trims.push({ pids: [...pids], shell })
        world.cutoffs.push(createdBefore)
        if (world.gate) await world.gate
        world.availableMb = world.afterTrimMb
        return {
          trimmed: pids.length,
          denied: 2,
          skipped: 1,
          gone: 0,
          ...(world.trimMs !== undefined ? { ms: world.trimMs } : {})
        }
      }
    },
    helper: async () => {
      if (world.helperGate) await world.helperGate
      return world.helper
    },
    systemTier: () => world.tier,
    io: {
      memory: () => ({
        totalMb: world.totalMb,
        availableMb: world.availableMb,
        usedMb: world.totalMb - world.availableMb
      }),
      now: () => world.now,
      sleep: async (ms) => {
        world.now += ms
      },
      setInterval: (fn, ms) => {
        const h = { fn, ms, cleared: false }
        world.intervals.push(h)
        return h
      },
      clearInterval: (h) => {
        ;(h as { cleared: boolean }).cleared = true
      },
      setTimeout: (fn, ms) => {
        const h = { fn, at: world.now + ms, cleared: false }
        world.timeouts.push(h)
        return h
      },
      clearTimeout: (h) => {
        ;(h as { cleared: boolean }).cleared = true
      },
      pid: OWN,
      parentPid: 8000,
      windowsDir: 'C:\\Windows'
    }
  })
}

function setEnabled(on: boolean): void {
  settings.performance.memory = { enabled: on }
  for (const l of [...world.settingsListeners]) l(settings)
}

const statuses = (): MemoryStatus[] =>
  world.events.filter((e) => e.name === 'memory:status').map((e) => e.payload as MemoryStatus)

beforeEach(() => {
  vi.clearAllMocks()
  settings = defaultSettings()
  settings.performance.memory = { enabled: true }
  world = {
    now: 1_700_000_000_000,
    availableMb: 8 * GB,
    totalMb: 16 * GB,
    afterTrimMb: 9 * GB,
    list: LIST,
    running: null,
    gameProcs: [],
    // PlayOut's own window is in front unless a test says otherwise.
    foregroundPid: OWN,
    foregroundThrows: false,
    listReads: 0,
    foregroundReads: 0,
    cutoffs: [],
    helper: null,
    helperGate: null,
    tier: 'missing',
    trims: [],
    helperCalls: [],
    gate: null,
    intervals: [],
    timeouts: [],
    events: [],
    listeners: new Map(),
    settingsListeners: []
  }
})

describe('memory service: when a pass runs', () => {
  it('is off by default and does nothing then: no sampler, no pass for low memory or a game', async () => {
    settings = defaultSettings()
    expect(settings.performance.memory).toEqual({ enabled: false })
    const s = service()
    s.start()
    expect(world.intervals).toHaveLength(0)
    world.availableMb = 500
    emitEvent('session:started', { gameId: 'g1', startedAt: '' })
    world.now += SESSION_DELAY_MS + 100
    fireTimeouts()
    await settle()
    expect(world.trims).toHaveLength(0)
    expect(s.status()).toMatchObject({ enabled: false, running: false, last: null })
  })

  it('does nothing before start(): a --mock run never starts it', async () => {
    const s = service()
    expect(world.intervals).toHaveLength(0)
    expect(world.listeners.size).toBe(0)
    await expect(s.freeNow()).rejects.toThrow(notRunningMessage())
    expect(world.trims).toHaveLength(0)
  })

  it('samples every 30 s and runs a pass only when available memory is low', async () => {
    const s = service()
    s.start()
    expect(world.intervals.map((i) => i.ms)).toEqual([SAMPLE_MS])
    sample()
    await settle()
    expect(world.trims).toHaveLength(0)

    world.availableMb = 1500
    world.afterTrimMb = 3400
    sample()
    await settle()
    // No game session: halo.exe is just another background program here.
    expect(world.trims).toEqual([{ pids: [GAME, DISCORD, CHROME], shell: false }])
    expect(s.status().last).toMatchObject({
      reason: 'pressure',
      tier: 'user',
      beforeAvailableMb: 1500,
      afterAvailableMb: 3400,
      freedMb: 1900,
      trimmed: 3,
      denied: 2,
      // System, PlayOut twice, explorer, MsMpEng, and the one the C# left alone.
      skipped: 6,
      steps: { workingSets: { state: 'done' } }
    })
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info.mock.calls[0]![0]).toBe(
      'memory: pressure pass (user) freed 1900 MB (1500 -> 3400 MB available), trimmed 3, skipped 6, denied 2; workingSets done'
    )
  })

  it('waits for the cooldown before the next pass, however low memory stays', async () => {
    const s = service()
    s.start()
    world.availableMb = 1500
    world.afterTrimMb = 2000
    sample()
    await settle()
    expect(world.trims).toHaveLength(1)
    world.availableMb = 1500
    for (let t = SAMPLE_MS; t < COOLDOWN_MS - SETTLE_MS; t += SAMPLE_MS) {
      world.now += SAMPLE_MS
      sample()
      await settle()
    }
    expect(world.trims).toHaveLength(1)
    world.now += SAMPLE_MS
    sample()
    await settle()
    expect(world.trims).toHaveLength(2)
  })

  it('runs one pass a short while after a game starts, never touching the game', async () => {
    const s = service()
    s.start()
    world.running = { gameId: 'g1' }
    world.gameProcs = [{ pid: GAME }]
    emitEvent('session:started', { gameId: 'g1', startedAt: '' })
    await settle()
    expect(world.trims).toHaveLength(0)
    world.now += SESSION_DELAY_MS - 1_000
    fireTimeouts()
    await settle()
    expect(world.trims).toHaveLength(0)
    world.now += 1_100
    fireTimeouts()
    await settle()
    expect(world.trims).toEqual([{ pids: [DISCORD, CHROME], shell: false }])
    expect(s.status().last?.reason).toBe('session')
    // One pass: later samples with enough memory do nothing.
    world.now += SAMPLE_MS
    sample()
    await settle()
    expect(world.trims).toHaveLength(1)
  })

  it('forgets the game start pass when the game ends first', async () => {
    const s = service()
    s.start()
    world.running = { gameId: 'g1' }
    world.gameProcs = [{ pid: GAME }]
    emitEvent('session:started', { gameId: 'g1', startedAt: '' })
    world.running = null
    emitEvent('session:ended', { gameId: 'g1', startedAt: '', endedAt: '', minutes: 0 })
    world.now += SESSION_DELAY_MS + 100
    fireTimeouts()
    sample()
    await settle()
    expect(world.trims).toHaveLength(0)
  })

  it("trims nothing while the running game's processes are not known, and tries the game pass again", async () => {
    const s = service()
    s.start()
    world.running = { gameId: 'g1' }
    world.gameProcs = []
    emitEvent('session:started', { gameId: 'g1', startedAt: '' })
    world.now += SESSION_DELAY_MS + 100
    fireTimeouts()
    await settle()
    expect(world.trims).toHaveLength(0)
    // Not a pass: no result, no cooldown.
    expect(s.status().last).toBeNull()
    // The game's process is there now: the pass that waited for it runs.
    world.gameProcs = [{ pid: GAME }]
    world.now += SESSION_DELAY_MS + 100
    fireTimeouts()
    await settle()
    expect(world.trims).toEqual([{ pids: [DISCORD, CHROME], shell: false }])

    // The button says why when it could not do anything.
    world.gameProcs = []
    const status = await s.freeNow()
    expect(status.last).toMatchObject({ error: gameUnknownMessage(), freedMb: 0, trimmed: 0 })
    expect(world.trims).toHaveLength(1)
  })

  it('trims nothing when the window in front cannot be read, and does not ask again at every sample', async () => {
    for (const how of ['null', 'throws', 'pid 0', 'pid 4'] as const) {
      world.trims = []
      world.events = []
      world.foregroundReads = 0
      world.now += 60 * 60_000
      world.foregroundPid = how === 'pid 0' ? 0 : how === 'pid 4' ? 4 : null
      world.foregroundThrows = how === 'throws'
      world.helper = helper()
      world.helperCalls = []
      const s = service()
      s.start()
      world.availableMb = 1500
      sample()
      await settle()
      // Chrome could be the program in use, or a game PlayOut does not track: nobody is trimmed, by either tier.
      expect(world.trims, how).toHaveLength(0)
      expect(world.helperCalls, how).toHaveLength(0)
      expect(world.foregroundReads, how).toBe(1)
      // Not a pass: no result, and the UI is told nothing (no "running" flicker).
      expect(s.status().last, how).toBeNull()
      expect(statuses(), how).toHaveLength(0)
      for (let t = SAMPLE_MS; t < SKIP_BACKOFF_MS; t += SAMPLE_MS) {
        world.now += SAMPLE_MS
        sample()
        await settle()
      }
      expect(world.foregroundReads, how).toBe(1)
      expect(statuses(), how).toHaveLength(0)
      // The button says why it could do nothing.
      const status = await s.freeNow()
      expect(status.last, how).toMatchObject({
        error: foregroundUnknownMessage(),
        freedMb: 0,
        trimmed: 0,
        steps: { workingSets: { state: 'skipped' } }
      })
      expect(world.trims, how).toHaveLength(0)
      expect(world.helperCalls, how).toHaveLength(0)
      // Readable again: the pass runs, leaving the program in front alone.
      world.foregroundThrows = false
      world.foregroundPid = CHROME
      world.helper = null
      world.availableMb = 1500
      await s.freeNow()
      expect(world.trims, how).toEqual([{ pids: [GAME, DISCORD], shell: false }])
      await s.dispose()
    }
  })

  it('backs off a pass for low memory that cannot tell the game apart, without telling the UI', async () => {
    const s = service()
    s.start()
    world.running = { gameId: 'g1' }
    world.gameProcs = []
    world.availableMb = 1500
    sample()
    await settle()
    expect(world.listReads).toBe(1)
    for (let t = SAMPLE_MS; t < SKIP_BACKOFF_MS; t += SAMPLE_MS) {
      world.now += SAMPLE_MS
      sample()
      await settle()
    }
    // Not a full process list read every 30 s for as long as memory stays low.
    expect(world.listReads).toBe(1)
    expect(world.trims).toHaveLength(0)
    expect(statuses()).toHaveLength(0)
    expect(s.status()).toMatchObject({ running: false, last: null })
    world.now += SAMPLE_MS
    sample()
    await settle()
    expect(world.listReads).toBe(2)
    // The game's processes are known now: the next try is a real pass, shown as one.
    world.gameProcs = [{ pid: GAME }]
    world.now += SKIP_BACKOFF_MS
    sample()
    await settle()
    expect(world.trims).toEqual([{ pids: [DISCORD, CHROME], shell: false }])
    expect(statuses().map((x) => x.running)).toEqual([true, false])
  })

  it('tells both tiers when the process list was read, so a reused process id is never trimmed', async () => {
    const s = service()
    s.start()
    const asked = world.now
    await s.freeNow()
    // The list may be up to 2 s old: nothing created after that moment is touched.
    expect(world.cutoffs).toEqual([asked - 2_000])
    world.helper = helper()
    const again = world.now
    await s.freeNow()
    expect(world.cutoffs).toEqual([asked - 2_000, again - 2_000])
  })

  it('lets explorer through only with the game in front', async () => {
    const s = service()
    s.start()
    world.running = { gameId: 'g1' }
    world.gameProcs = [{ pid: GAME }]
    world.foregroundPid = GAME
    await s.freeNow()
    expect(world.trims.at(-1)).toEqual({ pids: [DISCORD, CHROME, 700], shell: true })
    world.foregroundPid = CHROME
    await s.freeNow()
    expect(world.trims.at(-1)).toEqual({ pids: [DISCORD], shell: false })
  })

  it('runs a pass at once from the button, also with the setting off, with every exclusion', async () => {
    setEnabled(false)
    const s = service()
    s.start()
    world.afterTrimMb = 8 * GB + 640
    const status = await s.freeNow()
    expect(world.trims).toEqual([{ pids: [GAME, DISCORD, CHROME], shell: false }])
    expect(status).toMatchObject({
      enabled: false,
      running: false,
      last: { reason: 'manual', freedMb: 640, tier: 'user' }
    })
    expect(status.last!.at).toBe(new Date(world.now).toISOString())
    // 'memory:status' told the UI: running, then the result.
    expect(statuses().map((x) => x.running)).toEqual([true, false])
  })

  it('trims nothing when the setting is turned off while the helper is still being asked', async () => {
    for (const tier of ['user', 'system'] as const) {
      let release!: () => void
      world.helperGate = new Promise((r) => (release = r))
      world.helper = tier === 'system' ? helper() : null
      world.trims = []
      world.helperCalls = []
      world.events = []
      world.listReads = 0
      setEnabled(true)
      const s = service()
      s.start()
      world.availableMb = 1500
      sample()
      await settle()
      // Nothing is read to decide from before the helper has answered.
      expect(world.listReads, tier).toBe(0)
      setEnabled(false)
      release()
      await settle()
      expect(world.listReads, tier).toBe(0)
      expect(world.trims, tier).toHaveLength(0)
      expect(world.helperCalls, tier).toHaveLength(0)
      // Not a pass: no result, never shown as running.
      expect(s.status(), tier).toMatchObject({ enabled: false, running: false, last: null })
      expect(
        statuses().some((x) => x.running),
        tier
      ).toBe(false)
      expect(log.warn, tier).not.toHaveBeenCalled()
      // The button is the one thing that runs with the setting off.
      world.helperGate = null
      await s.freeNow()
      expect(world.trims.length + world.helperCalls.length, tier).toBe(1)
      await s.dispose()
    }
  })

  it('reads the window in front after the helper has answered, not before', async () => {
    let release!: () => void
    world.helperGate = new Promise((r) => (release = r))
    const s = service()
    s.start()
    const pressed = s.freeNow()
    await settle()
    // The user switches to the browser while the helper is still being found.
    world.foregroundPid = CHROME
    world.now += 4_000
    const asked = world.now
    release()
    await pressed
    expect(world.trims).toEqual([{ pids: [GAME, DISCORD], shell: false }])
    expect(world.cutoffs).toEqual([asked - 2_000])
  })

  it('trims nothing when the window in front belongs to a process the list does not have', async () => {
    // Started after the (reused) list was read: its image name, and so its other processes, are not known.
    world.foregroundPid = 7777
    world.helper = helper()
    const s = service()
    s.start()
    world.availableMb = 1500
    sample()
    await settle()
    expect(world.trims).toHaveLength(0)
    expect(world.helperCalls).toHaveLength(0)
    expect(s.status().last).toBeNull()
    const status = await s.freeNow()
    expect(status.last).toMatchObject({
      error: foregroundUnknownMessage(),
      trimmed: 0,
      steps: { workingSets: { state: 'skipped' } }
    })
    expect(world.trims).toHaveLength(0)
    expect(world.helperCalls).toHaveLength(0)
  })

  it('does not count a press of the button that did nothing as a pass', async () => {
    const s = service()
    s.start()
    world.running = { gameId: 'g1' }
    world.gameProcs = []
    emitEvent('session:started', { gameId: 'g1', startedAt: '' })
    world.now += 5_000
    const status = await s.freeNow()
    expect(status.last).toMatchObject({ reason: 'manual', error: gameUnknownMessage(), trimmed: 0 })
    expect(world.trims).toHaveLength(0)
    // The game's own pass still runs when it is due (the press is not "a pass a moment ago").
    world.gameProcs = [{ pid: GAME }]
    world.now += SESSION_DELAY_MS - 5_000 + 100
    fireTimeouts()
    await settle()
    expect(world.trims).toEqual([{ pids: [DISCORD, CHROME], shell: false }])
    expect(s.status().last?.reason).toBe('session')
    await s.dispose()

    // Nor does it hold back a pass for low memory (no cooldown for a pass that never started).
    world.trims = []
    world.gameProcs = []
    world.foregroundPid = null
    world.running = null
    const again = service()
    again.start()
    expect((await again.freeNow()).last).toMatchObject({ error: foregroundUnknownMessage() })
    world.list = []
    expect((await again.freeNow()).last?.error).toBe('The running programs could not be read.')
    world.list = LIST
    world.foregroundPid = OWN
    world.availableMb = 1500
    world.now += SAMPLE_MS
    sample()
    await settle()
    expect(world.trims).toHaveLength(1)
    expect(again.status().last?.reason).toBe('pressure')
  })

  it('never reports a negative amount freed', async () => {
    const s = service()
    s.start()
    world.afterTrimMb = 7 * GB
    expect((await s.freeNow()).last).toMatchObject({ freedMb: 0, afterAvailableMb: 7 * GB })
  })
})

describe('memory service: one pass at a time', () => {
  it('joins a running pass instead of starting a second one', async () => {
    let release!: () => void
    world.gate = new Promise((r) => (release = r))
    const s = service()
    s.start()
    const first = s.freeNow()
    await settle()
    expect(s.status().running).toBe(true)
    const second = s.freeNow()
    // The sampler finds memory low meanwhile: still one pass.
    world.availableMb = 1000
    sample()
    await settle()
    expect(world.trims).toHaveLength(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.last).toEqual(b.last)
    expect(world.trims).toHaveLength(1)
    expect(s.status().running).toBe(false)
  })

  it('gives up on a pass that does not end, and can run again afterwards', async () => {
    let release!: () => void
    world.gate = new Promise((r) => (release = r))
    const s = service()
    s.start()
    const stuck = s.freeNow()
    await settle()
    world.now += PASS_TIMEOUT_MS
    fireTimeouts()
    const status = await stuck
    expect(status.running).toBe(false)
    expect(status.last).toMatchObject({
      error: 'The memory cleanup did not finish in time.',
      freedMb: 0,
      steps: { workingSets: { state: 'failed' } }
    })
    expect(log.warn).toHaveBeenCalled()
    // The trim it gave up on is still going: no second one starts on top of it, from the button or the sampler.
    expect((await s.freeNow()).last).toMatchObject({ error: stillFinishingMessage(), trimmed: 0 })
    world.availableMb = 1000
    world.now += 60 * 60_000
    sample()
    await settle()
    expect(world.trims).toHaveLength(1)
    // The stuck trim ending late changes nothing and is not an unhandled rejection.
    release()
    await settle()
    world.gate = null
    world.now += COOLDOWN_MS
    expect((await s.freeNow()).last?.error).toBeUndefined()
  })

  it('starts no trim of its own for a pass it gave up on while the helper was still at it', async () => {
    let release!: () => void
    world.gate = new Promise((r) => (release = r))
    // The helper ends after the pass timed out, with an ordinary failure that would otherwise mean "trim yourself".
    world.helper = helper(new Error('Unknown request.'))
    const s = service()
    s.start()
    const stuck = s.freeNow()
    await settle()
    world.now += PASS_TIMEOUT_MS
    fireTimeouts()
    expect((await stuck).last?.error).toBe('The memory cleanup did not finish in time.')
    release()
    await settle()
    expect(world.helperCalls).toHaveLength(1)
    expect(world.trims).toHaveLength(0)
    // It has really ended now: the next pass runs.
    world.gate = null
    world.helper = null
    expect((await s.freeNow()).last?.error).toBeUndefined()
    expect(world.trims).toHaveLength(1)
  })

  it('reports a process list that could not be read instead of trimming blindly', async () => {
    world.list = []
    const s = service()
    s.start()
    const status = await s.freeNow()
    expect(status.last?.error).toBe('The running programs could not be read.')
    expect(world.trims).toHaveLength(0)
  })

  it('runs nothing while the PC sleeps, and stops for good on dispose', async () => {
    const s = service()
    s.start()
    s.suspend()
    world.availableMb = 1000
    sample()
    await settle()
    expect(world.trims).toHaveLength(0)
    await expect(s.freeNow()).rejects.toThrow(notRunningMessage())
    s.resume()
    sample()
    await settle()
    expect(world.trims).toHaveLength(1)

    await s.dispose()
    expect(world.intervals.every((i) => i.cleared)).toBe(true)
    expect([...world.listeners.values()].every((l) => l.length === 0)).toBe(true)
    expect(world.settingsListeners).toHaveLength(0)
    await expect(s.freeNow()).rejects.toThrow(notRunningMessage())
    s.start()
    expect(world.intervals.filter((i) => !i.cleared)).toHaveLength(0)
  })

  it('does not wait on a stuck pass for longer than a moment when disposed', async () => {
    world.gate = new Promise(() => undefined)
    const s = service()
    s.start()
    const stuck = s.freeNow()
    await settle()
    await s.dispose()
    // No status is sent after dispose.
    const sent = statuses().length
    world.now += PASS_TIMEOUT_MS
    fireTimeouts()
    await stuck
    expect(statuses()).toHaveLength(sent)
  })

  it('starts and stops the sampler with the setting', () => {
    setEnabled(false)
    const s = service()
    s.start()
    expect(world.intervals).toHaveLength(0)
    setEnabled(true)
    expect(world.intervals.filter((i) => !i.cleared)).toHaveLength(1)
    expect(statuses().at(-1)).toMatchObject({ enabled: true })
    setEnabled(false)
    expect(world.intervals.filter((i) => !i.cleared)).toHaveLength(0)
    expect(statuses().at(-1)).toMatchObject({ enabled: false })
  })
})

describe('memory service: the two tiers', () => {
  it('has the power helper do the whole pass when it is ready', async () => {
    world.helper = helper()
    world.tier = 'ready'
    world.afterTrimMb = 8 * GB + 1843
    const s = service()
    s.start()
    const status = await s.freeNow()
    expect(world.trims).toHaveLength(0)
    expect(world.helperCalls).toEqual([
      { pids: [GAME, DISCORD, CHROME], shell: false, purgeBelowMb: 1229 }
    ])
    expect(status.systemWide).toBe('ready')
    expect(status.last).toMatchObject({
      tier: 'system',
      freedMb: 1843,
      trimmed: 40,
      denied: 3,
      // Five left alone here, one by the helper's own check, one gone since the list.
      skipped: 7,
      steps: SYSTEM_RESULT.steps
    })
    expect(log.info.mock.calls.at(-1)![0]).toContain(
      'workingSets done, modifiedList done, lowPriorityStandby done, standby skipped (enough memory is free), combine failed (this Windows version does not support it)'
    )
  })

  it('reports how long each step and the whole cleanup took, as the helper measured it', async () => {
    world.helper = helper({
      counts: { trimmed: 131, denied: 2, skipped: 0, gone: 0 },
      steps: {
        workingSets: { state: 'done', ms: 412 },
        modifiedList: { state: 'done', ms: 1830 },
        lowPriorityStandby: { state: 'done', ms: 95 },
        standby: { state: 'skipped', detail: 'enough memory is free' },
        combine: { state: 'failed', detail: 'not supported', ms: 3 }
      },
      totalMs: 4547
    })
    world.tier = 'ready'
    const s = service()
    s.start()
    const status = await s.freeNow()
    // The helper's own time: the wait before memory is read again is not in it.
    expect(status.last).toMatchObject({ tier: 'system', durationMs: 4547 })
    expect(status.last!.steps.workingSets).toEqual({ state: 'done', ms: 412 })
    expect(status.last!.steps.standby).toEqual({
      state: 'skipped',
      detail: 'enough memory is free'
    })
    expect(log.info.mock.calls.at(-1)![0]).toMatch(
      /; workingSets done \(412 ms\), modifiedList done \(1830 ms\), lowPriorityStandby done \(95 ms\), standby skipped \(enough memory is free\), combine failed \(not supported, 3 ms\); took 4547 ms$/
    )
  })

  it('leaves the times out when the helper did not report them', async () => {
    world.helper = helper()
    world.tier = 'ready'
    const s = service()
    s.start()
    const status = await s.freeNow()
    expect(status.last).not.toHaveProperty('durationMs')
    expect(status.last!.steps).toEqual(SYSTEM_RESULT.steps)
    expect(log.info.mock.calls.at(-1)![0]).not.toMatch(/\d ms\)|took/)
  })

  it("times PlayOut's own trim when it does the pass, and says nothing when the time is unknown", async () => {
    world.trimMs = 87
    const s = service()
    s.start()
    const timed = await s.freeNow()
    expect(timed.last).toMatchObject({
      tier: 'user',
      durationMs: 87,
      steps: { workingSets: { state: 'done', ms: 87 } }
    })
    expect(log.info.mock.calls.at(-1)![0]).toMatch(/; workingSets done \(87 ms\); took 87 ms$/)
    world.trimMs = undefined
    const untimed = await s.freeNow()
    expect(untimed.last).not.toHaveProperty('durationMs')
    expect(untimed.last!.steps).toEqual({ workingSets: { state: 'done' } })
    expect(log.info.mock.calls.at(-1)![0]).toMatch(/; workingSets done$/)
  })

  it('does not trim on top of a helper that is, or may still be, running a cleanup', async () => {
    // Busy with an earlier cleanup, or the one just started was lost or did not end in time (helper-client.ts).
    world.helper = helper(new HelperMemoryBusyError('The memory cleanup did not finish in time'))
    const s = service()
    s.start()
    const status = await s.freeNow()
    expect(world.helperCalls).toHaveLength(1)
    expect(world.trims).toHaveLength(0)
    expect(status.last).toMatchObject({
      error: helperBusyMessage(),
      freedMb: 0,
      trimmed: 0,
      steps: { workingSets: { state: 'failed' } }
    })
    // A failed pass counts for the cooldown: the helper is not asked again at the next sample.
    world.availableMb = 1500
    world.now += SAMPLE_MS
    sample()
    await settle()
    expect(world.helperCalls).toHaveLength(1)
  })

  it('does not trim by itself either when the helper fails late: it may have started, and the list is old', async () => {
    world.helper = {
      async memoryTrim() {
        world.helperCalls.push({ pids: [], shell: false, purgeBelowMb: 0 })
        world.now += HELPER_FALLBACK_WITHIN_MS + 1
        throw new Error('The power helper did not answer')
      }
    }
    const s = service()
    s.start()
    const status = await s.freeNow()
    expect(world.trims).toHaveLength(0)
    expect(status.last).toMatchObject({ error: 'The power helper did not answer', trimmed: 0 })
  })

  it('drops the whole standby cache at most once while memory stays low', async () => {
    world.helper = helper({
      ...SYSTEM_RESULT,
      steps: { ...SYSTEM_RESULT.steps, standby: { state: 'done' } }
    })
    const s = service()
    s.start()
    const purges = (): number[] => world.helperCalls.map((c) => c.purgeBelowMb)
    world.availableMb = 1000
    world.afterTrimMb = 1300
    sample()
    await settle()
    expect(purges()).toEqual([1229])
    // Still low after the cooldown: another pass, but the game's file cache is not thrown away again.
    world.availableMb = 1000
    world.now += COOLDOWN_MS
    sample()
    await settle()
    expect(purges()).toEqual([1229, 0])
    // The button is the user's own decision: it may.
    await s.freeNow()
    expect(purges()).toEqual([1229, 0, 1229])
  })

  it("never asks for the whole standby cache to be dropped at a game's start", async () => {
    world.helper = helper()
    const s = service()
    s.start()
    world.running = { gameId: 'g1' }
    world.gameProcs = [{ pid: GAME }]
    emitEvent('session:started', { gameId: 'g1', startedAt: '' })
    world.now += SESSION_DELAY_MS + 100
    fireTimeouts()
    await settle()
    // The game has just filled the cache with its own files, and dropping it frees no available memory.
    expect(world.helperCalls).toEqual([{ pids: [DISCORD, CHROME], shell: false, purgeBelowMb: 0 }])
  })

  it("trims this user's programs itself when the helper refuses at once or is not there", async () => {
    world.helper = helper(new Error('Unknown request.'))
    const s = service()
    s.start()
    const status = await s.freeNow()
    expect(world.helperCalls).toHaveLength(1)
    expect(world.trims).toEqual([{ pids: [GAME, DISCORD, CHROME], shell: false }])
    expect(status.last).toMatchObject({ tier: 'user', steps: { workingSets: { state: 'done' } } })
    expect(status.last?.error).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      "memory: the power helper's cleanup failed: Unknown request."
    )
  })

  it('tells the UI when the helper appears or goes', async () => {
    const s = service()
    s.start()
    await settle()
    const before = statuses().length
    emitEvent('performance:status', {} as PlayOutEvents['performance:status'])
    expect(statuses()).toHaveLength(before)
    world.tier = 'ready'
    emitEvent('performance:status', {} as PlayOutEvents['performance:status'])
    expect(statuses().at(-1)).toMatchObject({ systemWide: 'ready' })
    world.tier = 'outdated'
    emitEvent('performance:status', {} as PlayOutEvents['performance:status'])
    expect(statuses().at(-1)).toMatchObject({ systemWide: 'outdated' })
  })
})

describe('log text', () => {
  it('names each step with its state and why', () => {
    expect(stepsText(SYSTEM_RESULT.steps)).toBe(
      'workingSets done, modifiedList done, lowPriorityStandby done, standby skipped (enough memory is free), combine failed (this Windows version does not support it)'
    )
    expect(
      passLogLine({
        at: '2026-11-22T10:00:00.000Z',
        reason: 'manual',
        tier: 'user',
        beforeAvailableMb: 100,
        afterAvailableMb: 100,
        freedMb: 0,
        trimmed: 0,
        skipped: 0,
        denied: 0,
        steps: { workingSets: { state: 'failed', detail: 'x' } },
        error: 'x'
      })
    ).toBe(
      'memory: manual pass (user) freed 0 MB (100 -> 100 MB available), trimmed 0, skipped 0, denied 0; workingSets failed (x); x'
    )
  })

  it('adds how long each step and the whole cleanup took when that is known', () => {
    const result: MemoryPassResult = {
      at: '2026-11-22T10:00:00.000Z',
      reason: 'manual',
      tier: 'system',
      beforeAvailableMb: 13120,
      afterAvailableMb: 21331,
      freedMb: 8211,
      trimmed: 131,
      skipped: 210,
      denied: 2,
      steps: {
        workingSets: { state: 'done', ms: 412 },
        modifiedList: { state: 'done', ms: 1830 },
        lowPriorityStandby: { state: 'done', ms: 0 },
        standby: { state: 'skipped', detail: 'enough memory is free' },
        combine: { state: 'failed', detail: 'access denied', ms: 2210 }
      },
      durationMs: 4547
    }
    expect(passLogLine(result)).toBe(
      'memory: manual pass (system) freed 8211 MB (13120 -> 21331 MB available), trimmed 131, skipped 210, denied 2; workingSets done (412 ms), modifiedList done (1830 ms), lowPriorityStandby done (0 ms), standby skipped (enough memory is free), combine failed (access denied, 2210 ms); took 4547 ms'
    )
    // A failure still comes last.
    expect(passLogLine({ ...result, durationMs: 0, error: 'x' })).toMatch(/; took 0 ms; x$/)
  })
})
