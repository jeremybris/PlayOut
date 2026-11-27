import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Game, PlayOutEvents, Settings } from '../../shared/types'
import { EventBus } from '../events'
import type { ActiveSession } from '../services/library-service'
import type { ProcessInfo, ProcessMonitor } from './process-monitor'
import { createSessionTracker, type SessionTiming, type SessionTracker } from './session-tracker'

const timing: SessionTiming = {
  pollMs: 40,
  graceMs: 300,
  lingerMs: 150,
  stubWindowMs: 10_000,
  maxPollErrors: 3,
  windowWaitMs: 300
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: true,
    installDir: 'C:\\Games\\Portal 2',
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'installDir', installDir: 'C:\\Games\\Portal 2' },
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
  }
}

function proc(overrides: Partial<ProcessInfo> & { pid: number }): ProcessInfo {
  return { parentPid: 4, name: 'game.exe', path: null, sessionId: 1, ...overrides }
}

interface Harness {
  tracker: SessionTracker
  events: EventBus
  started: PlayOutEvents['session:started'][]
  ended: PlayOutEvents['session:ended'][]
  windowCalls: string[]
  window: { minimized: boolean; visible: boolean; focused: boolean }
  state: {
    list: ProcessInfo[]
    names: ProcessInfo[]
    alive: Set<number>
    fail: boolean
    /** Date.now() of the last list() poll that returned a process. */
    lastHitAt: number
  }
  logs: string[]
}

function harness(
  options: { settings?: Partial<Settings['ui']>; timing?: Partial<SessionTiming> } = {}
): Harness {
  const events = new EventBus()
  const started: PlayOutEvents['session:started'][] = []
  const ended: PlayOutEvents['session:ended'][] = []
  events.on('session:started', (p) => started.push(p))
  events.on('session:ended', (p) => ended.push(p))
  let counter = 0
  const library = {
    beginSession(gameId: string): ActiveSession {
      const startedAt = new Date().toISOString()
      events.emit('session:started', { gameId, startedAt })
      return { sessionId: `s${++counter}`, gameId, startedAt }
    },
    endSession(active: ActiveSession, measuredMinutes?: number): void {
      const endedAt = new Date().toISOString()
      // The tracker passes the measured active time; the wall-clock figure is only the fallback.
      const minutes =
        measuredMinutes ??
        Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(active.startedAt)) / 60_000))
      events.emit('session:ended', {
        gameId: active.gameId,
        startedAt: active.startedAt,
        endedAt,
        minutes
      })
    }
  }
  const settings = defaultSettings()
  Object.assign(settings.ui, options.settings)
  const windowCalls: string[] = []
  const window = { minimized: false, visible: true, focused: false }
  const state = {
    list: [] as ProcessInfo[],
    names: [] as ProcessInfo[],
    alive: new Set<number>(),
    fail: false,
    lastHitAt: 0
  }
  const monitor: ProcessMonitor = {
    async list() {
      if (state.fail) throw new Error('boom')
      if (state.list.length) state.lastHitAt = Date.now()
      return state.list
    },
    async listNames() {
      if (state.fail) throw new Error('boom')
      return state.names
    },
    isPidAlive: (pid) => state.alive.has(pid),
    dispose: vi.fn()
  }
  const logs: string[] = []
  const log = {
    debug: () => {},
    info: (...a: unknown[]) => logs.push(a.join(' ')),
    warn: (...a: unknown[]) => logs.push(a.join(' ')),
    error: (...a: unknown[]) => logs.push(a.join(' '))
  }
  const tracker = createSessionTracker({
    library,
    settings: { get: () => settings },
    window: {
      minimize() {
        windowCalls.push('minimize')
        window.minimized = true
      },
      restore() {
        windowCalls.push('restore')
        window.minimized = false
      },
      isMinimized: () => window.minimized,
      isVisible: () => window.visible,
      isFocused: () => window.focused,
      focus() {
        windowCalls.push('focus')
      }
    },
    monitor,
    log,
    timing: { ...timing, ...options.timing }
  })
  return { tracker, events, started, ended, windowCalls, window, state, logs }
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid, exitCode: null, signalCode: null, unref: vi.fn() })
  return child
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await sleep(10)
  }
}

let active: Harness[] = []
afterEach(() => {
  for (const h of active) h.tracker.dispose()
  active = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/**
 * For the tests that assert how long something took: under vi.useFakeTimers() the tracker's polls and Date.now()
 * run on the mocked clock, so the measured time is exact whatever the load on the machine. Steps 1 ms at a time
 * and returns with the clock at the moment the condition became true.
 */
async function advanceUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  for (let i = 0; !check(); i++) {
    if (i >= timeoutMs) throw new Error('timed out waiting for condition')
    await vi.advanceTimersByTimeAsync(1)
  }
}

/** Shift Date.now() forward without touching the real timers, the way a sleep looks to a resumed process. */
function clockSkew(): { advance(ms: number): void } {
  const realNow = Date.now
  let offset = 0
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
  return {
    advance(ms) {
      offset += ms
    }
  }
}

function setup(options?: Parameters<typeof harness>[0]): Harness {
  const h = harness(options)
  active.push(h)
  return h
}

describe('session tracker: directory, name and package tracking', () => {
  it('waits for a process under the install dir, minimizes, then ends 8 s (scaled) after it is gone', async () => {
    // Mocked clock: with real timers a loaded machine stretched the 60 ms below past the grace period, and the
    // linger measurement past its bounds.
    vi.useFakeTimers()
    const h = setup()
    const game = makeGame()
    const session = h.tracker.start({ game })
    expect(h.started).toEqual([{ gameId: 'steam:620', startedAt: session.startedAt }])
    expect(h.tracker.current()).toMatchObject({
      gameId: 'steam:620',
      startedAt: session.startedAt,
      seen: false
    })

    await vi.advanceTimersByTimeAsync(60)
    expect(h.windowCalls).toEqual([])
    h.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\bin\\portal2.exe' })]
    await advanceUntil(() => h.tracker.current()?.seen === true)
    expect(h.windowCalls).toEqual(['minimize'])

    // Gone between two polls: the linger counts from the last poll that still saw the process.
    await vi.advanceTimersByTimeAsync(10)
    h.state.list = []
    await advanceUntil(() => h.ended.length === 1)
    const lingered = Date.now() - h.state.lastHitAt
    // The whole linger, and ended by the first poll after it ran out.
    expect(lingered).toBeGreaterThanOrEqual(timing.lingerMs)
    expect(lingered).toBeLessThan(timing.lingerMs + timing.pollMs)
    expect(h.ended[0]).toMatchObject({
      gameId: 'steam:620',
      startedAt: session.startedAt,
      minutes: 0
    })
    expect(h.windowCalls).toEqual(['minimize', 'restore'])
    expect(h.tracker.current()).toBeNull()
  })

  it('ends the session when the game process never appears within the grace period', async () => {
    const h = setup()
    const t0 = Date.now()
    h.tracker.start({ game: makeGame() })
    await waitUntil(() => h.ended.length === 1)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(timing.graceMs - 10)
    expect(h.windowCalls).toEqual([])
    expect(h.logs.some((l) => /game process not seen/.test(l))).toBe(true)
  })

  it('matches process names through the cheaper names list', async () => {
    const h = setup()
    h.state.names = [proc({ pid: 9, name: 'Portal2.EXE' })]
    h.tracker.start({
      game: makeGame({ tracking: { mode: 'process', processNames: ['portal2', 'hl2.exe'] } })
    })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.state.names = [proc({ pid: 10, name: 'other.exe' })]
    await waitUntil(() => h.ended.length === 1)
  })

  it('matches packaged apps by package family name or install dir', async () => {
    const h = setup()
    const game = makeGame({
      id: 'xbox:pkg',
      installDir: 'C:\\XboxGames\\Conker\\Content',
      tracking: { mode: 'uwp', packageFamilyName: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe' }
    })
    h.state.list = [
      proc({
        pid: 7,
        name: 'Notepad.exe',
        path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe'
      })
    ]
    h.tracker.start({ game })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.state.list = [
      proc({ pid: 8, name: 'Game.exe', path: 'C:\\XboxGames\\Conker\\Content\\Game.exe' })
    ]
    await sleep(timing.lingerMs + 100)
    expect(h.ended).toEqual([])
    h.state.list = []
    await waitUntil(() => h.ended.length === 1)
  })

  it('records a launch only for untrackable games', () => {
    const h = setup()
    h.tracker.start({ game: makeGame({ tracking: { mode: 'none' } }) })
    expect(h.started).toHaveLength(1)
    expect(h.ended).toHaveLength(1)
    expect(h.tracker.current()).toBeNull()
    expect(h.windowCalls).toEqual([])
  })

  it("treats 'spawned' without a child as untrackable", () => {
    const h = setup()
    h.tracker.start({ game: makeGame({ tracking: { mode: 'spawned' } }) })
    expect(h.ended).toHaveLength(1)
    expect(h.logs.some((l) => /no process was spawned/.test(l))).toBe(true)
  })

  it('only brings the window back at the end when minimizeWhilePlaying is off, and never for a background command', async () => {
    const h = setup({ settings: { minimizeWhilePlaying: false } })
    h.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    h.tracker.start({ game: makeGame() })
    await waitUntil(() => h.tracker.current()?.seen === true)
    expect(h.windowCalls).toEqual([])
    h.state.list = []
    await waitUntil(() => h.ended.length === 1)
    // PlayOut takes the foreground back, so the controller drives it again.
    expect(h.windowCalls).toEqual(['restore'])

    const g = setup()
    g.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    g.tracker.start({ game: makeGame(), runInBackground: true })
    await waitUntil(() => g.tracker.current()?.seen === true)
    g.state.list = []
    await waitUntil(() => g.ended.length === 1)
    expect(g.windowCalls).toEqual([])

    // Closed to the tray during the game: it stays there.
    const t = setup({ settings: { minimizeWhilePlaying: false } })
    t.window.visible = false
    t.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    t.tracker.start({ game: makeGame() })
    await waitUntil(() => t.tracker.current()?.seen === true)
    t.state.list = []
    await waitUntil(() => t.ended.length === 1)
    expect(t.windowCalls).toEqual([])
  })

  it('ends a running session when another trackable game starts and restores the window once at the end', async () => {
    const h = setup()
    h.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    h.tracker.start({ game: makeGame() })
    await waitUntil(() => h.tracker.current()?.seen === true)
    expect(h.windowCalls).toEqual(['minimize'])

    h.state.list = [proc({ pid: 600, path: 'C:\\Games\\Half-Life\\hl.exe' })]
    const second = makeGame({
      id: 'steam:70',
      title: 'Half-Life',
      tracking: { mode: 'installDir', installDir: 'C:\\Games\\Half-Life' }
    })
    h.tracker.start({ game: second })
    expect(h.ended).toHaveLength(1)
    expect(h.ended[0].gameId).toBe('steam:620')
    expect(h.windowCalls).toEqual(['minimize'])
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.state.list = []
    await waitUntil(() => h.ended.length === 2)
    expect(h.ended[1].gameId).toBe('steam:70')
    expect(h.windowCalls).toEqual(['minimize', 'restore'])
  })

  it('restores the window when an untrackable launch replaces a running game', async () => {
    const h = setup()
    h.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    h.tracker.start({ game: makeGame() })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.tracker.start({ game: makeGame({ id: 'manual:x', tracking: { mode: 'none' } }) })
    expect(h.ended.map((e) => e.gameId)).toEqual(['steam:620', 'manual:x'])
    expect(h.windowCalls).toEqual(['minimize', 'restore'])
  })

  it('closes the session after repeated poll failures', async () => {
    const h = setup()
    h.state.fail = true
    h.tracker.start({ game: makeGame() })
    await waitUntil(() => h.ended.length === 1)
    expect(h.logs.some((l) => /process polling failed repeatedly/.test(l))).toBe(true)
  })

  it('end() and dispose() close the session; dispose leaves the window alone', async () => {
    const h = setup()
    h.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    h.tracker.start({ game: makeGame() })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.tracker.dispose()
    expect(h.ended).toHaveLength(1)
    expect(h.windowCalls).toEqual(['minimize'])
    expect(h.tracker.current()).toBeNull()

    const g = setup()
    g.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    g.tracker.start({ game: makeGame() })
    await waitUntil(() => g.tracker.current()?.seen === true)
    g.tracker.end({ reason: 'test' })
    expect(g.windowCalls).toEqual(['minimize', 'restore'])
    g.tracker.end()
    expect(g.ended).toHaveLength(1)
  })
})

describe('session tracker: spawned processes', () => {
  it('is running while the child lives, follows orphaned descendants after it exits, then ends', async () => {
    const h = setup()
    const child = fakeChild(4242)
    h.state.alive.add(4242)
    const game = makeGame({
      id: 'manual:a',
      launch: { kind: 'exec', file: 'C:\\Games\\A\\a.exe', args: [] },
      tracking: { mode: 'spawned' }
    })
    h.tracker.start({ game, child })
    await waitUntil(() => h.tracker.current()?.seen === true)
    expect(h.tracker.current()?.pid).toBe(4242)
    expect(h.windowCalls).toEqual(['minimize'])

    // The launcher exits but left the real game behind (parent pid = launcher).
    h.state.alive.clear()
    h.state.list = [
      proc({
        pid: 5000,
        parentPid: 4242,
        name: 'real-game.exe',
        path: 'C:\\Games\\A\\bin\\real-game.exe'
      })
    ]
    child.emit('exit', 0, null)
    await sleep(timing.lingerMs + 100)
    expect(h.ended).toEqual([])
    expect(h.logs.some((l) => /spawned process 4242 exited with code 0/.test(l))).toBe(true)

    h.state.list = []
    await waitUntil(() => h.ended.length === 1)
    expect(h.windowCalls).toEqual(['minimize', 'restore'])
  })

  it('minimizes for an emulator only once its window took the foreground, or after the wait', async () => {
    const emulatorGame = makeGame({
      id: 'rom:ps2:a',
      launch: { kind: 'emulator', systemId: 'ps2', romPath: 'C:\\roms\\ps2\\a.chd' },
      tracking: { mode: 'spawned' }
    })
    // A long wait for this part, which is about the focus: with the 300 ms wait a loaded machine stretched the
    // sleep below past it, and PlayOut had (correctly) minimized on the timeout before the check.
    const h = setup({ timing: { windowWaitMs: 60_000 } })
    h.window.focused = true
    h.state.alive.add(4300)
    h.tracker.start({ game: emulatorGame, child: fakeChild(4300), waitForWindow: true })
    await waitUntil(() => h.tracker.current()?.seen === true)
    // Running, but no window of its own yet: PlayOut stays in front so the emulator can take the foreground.
    await sleep(120)
    expect(h.windowCalls).toEqual([])
    // The emulator's window took the foreground (PlayOut lost the focus): now PlayOut minimizes.
    h.window.focused = false
    await waitUntil(() => h.windowCalls.length === 1)
    expect(h.windowCalls).toEqual(['minimize'])

    // A window that never comes up: minimized after windowWaitMs anyway.
    const late = setup()
    late.window.focused = true
    late.state.alive.add(4301)
    const started = Date.now()
    late.tracker.start({ game: emulatorGame, child: fakeChild(4301), waitForWindow: true })
    await waitUntil(() => late.windowCalls.length === 1, 3000)
    expect(Date.now() - started).toBeGreaterThanOrEqual(timing.windowWaitMs - 20)

    // A session that ends while waiting never minimizes afterwards.
    const gone = setup()
    gone.window.focused = true
    gone.state.alive.add(4302)
    gone.tracker.start({ game: emulatorGame, child: fakeChild(4302), waitForWindow: true })
    await waitUntil(() => gone.tracker.current()?.seen === true)
    gone.tracker.end({ restore: false })
    await sleep(timing.windowWaitMs + 100)
    expect(gone.windowCalls).toEqual([])

    // Without the flag (stores, Steam): minimized as soon as the game runs, focused or not.
    const store = setup()
    store.window.focused = true
    store.state.alive.add(4303)
    store.tracker.start({
      game: makeGame({ id: 'manual:b', tracking: { mode: 'spawned' } }),
      child: fakeChild(4303)
    })
    await waitUntil(() => store.tracker.current()?.seen === true)
    expect(store.windowCalls).toEqual(['minimize'])
  })

  it('watches the hand-off directory when a stub exits without descendants', async () => {
    const h = setup()
    const child = fakeChild(4243)
    h.state.alive.add(4243)
    const game = makeGame({
      id: 'manual:b',
      launch: { kind: 'exec', file: 'C:\\Games\\B\\b.exe', args: [] },
      tracking: { mode: 'spawned' }
    })
    h.tracker.start({ game, child, handoffDir: 'C:\\Games\\B' })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.state.alive.clear()
    h.state.list = [
      proc({ pid: 5100, parentPid: 1, name: 'b-real.exe', path: 'C:\\Games\\B\\b-real.exe' })
    ]
    child.emit('exit', 0, null)
    await sleep(timing.lingerMs + 100)
    expect(h.ended).toEqual([])
    h.state.list = []
    await waitUntil(() => h.ended.length === 1)
  })

  it('ends at once when a long-running child exits with no descendants', async () => {
    const h = setup({ timing: { stubWindowMs: 0, lingerMs: 2000 } })
    const child = fakeChild(4244)
    h.state.alive.add(4244)
    const game = makeGame({
      id: 'manual:c',
      launch: { kind: 'exec', file: 'C:\\Games\\C\\c.exe', args: [] },
      tracking: { mode: 'spawned' }
    })
    h.tracker.start({ game, child })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.state.alive.clear()
    const t0 = Date.now()
    child.emit('exit', 0, null)
    await waitUntil(() => h.ended.length === 1)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('notices a vanished pid without an exit event', async () => {
    const h = setup({ timing: { stubWindowMs: 0 } })
    const child = fakeChild(4245)
    h.state.alive.add(4245)
    const game = makeGame({
      id: 'manual:d',
      launch: { kind: 'exec', file: 'C:\\Games\\D\\d.exe', args: [] },
      tracking: { mode: 'spawned' }
    })
    h.tracker.start({ game, child })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.state.alive.clear()
    await waitUntil(() => h.ended.length === 1)
    expect(h.logs.some((l) => /pid no longer alive/.test(l))).toBe(true)
  })

  it('handles a child that already exited before tracking started', async () => {
    const h = setup({ timing: { stubWindowMs: 0 } })
    const child = fakeChild(4246)
    Object.assign(child, { exitCode: 1 })
    const game = makeGame({
      id: 'manual:e',
      launch: { kind: 'exec', file: 'C:\\Games\\E\\e.exe', args: [] },
      tracking: { mode: 'spawned' }
    })
    h.tracker.start({ game, child })
    await waitUntil(() => h.ended.length === 1)
    expect(h.logs.some((l) => /exited before tracking started/.test(l))).toBe(true)
  })
})

describe('session tracker: reused pids', () => {
  const spawnedGame = (id: string): Game =>
    makeGame({
      id,
      launch: { kind: 'exec', file: 'C:\\Games\\R\\r.exe', args: [] },
      tracking: { mode: 'spawned' }
    })

  it('does not mistake an unrelated process that was handed the stub pid for the game, nor adopt its children', async () => {
    // Mocked clock, so the linger is measured exactly whatever the load on the machine.
    vi.useFakeTimers()
    const h = setup()
    const child = fakeChild(4300)
    h.state.alive.add(4300)
    h.tracker.start({ game: spawnedGame('manual:r1'), child })
    await advanceUntil(() => h.tracker.current()?.seen === true)

    // The stub exits inside the stub window, most of a poll interval after the last poll saw it alive; before the
    // next poll Windows gives 4300 to RuntimeBroker, which has a child of its own. Both were created after the
    // stub died.
    await vi.advanceTimersByTimeAsync(timing.pollMs - 10)
    h.state.alive.clear()
    const future = Date.now() + 5_000
    h.state.list = [
      proc({ pid: 4300, parentPid: 1, name: 'RuntimeBroker.exe', createdAt: future }),
      proc({ pid: 4301, parentPid: 4300, name: 'backgroundTaskHost.exe', createdAt: future + 1 })
    ]
    const t0 = Date.now()
    child.emit('exit', 0, null)
    await advanceUntil(() => h.ended.length === 1, 3000)
    // Ended after the linger (nothing of the game was left), not kept open by the impostor: the whole linger,
    // counted from the exit and not from the last poll before it, and ended by the first poll after it ran out.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(timing.lingerMs)
    expect(Date.now() - t0).toBeLessThan(timing.lingerMs + timing.pollMs)
    expect(h.logs.some((l) => /pid 4300 now belongs to RuntimeBroker\.exe/.test(l))).toBe(true)
    expect(h.ended[0].minutes).toBe(0)
  })

  it('ends at once when a long-running child exits and its pid is reused before the next poll', async () => {
    const h = setup({ timing: { stubWindowMs: 0, lingerMs: 2000 } })
    const child = fakeChild(4310)
    h.state.alive.add(4310)
    h.tracker.start({ game: spawnedGame('manual:r2'), child })
    await waitUntil(() => h.tracker.current()?.seen === true)
    h.state.alive.clear()
    // No creation time (tasklist-style rows): the pid was observed dead, so it is never alive again regardless.
    h.state.list = [proc({ pid: 4310, parentPid: 1, name: 'svchost.exe' })]
    const t0 = Date.now()
    child.emit('exit', 0, null)
    await waitUntil(() => h.ended.length === 1)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('drops a tracked descendant whose pid now belongs to a different image', async () => {
    const h = setup({ timing: { stubWindowMs: 0, lingerMs: 150 } })
    const child = fakeChild(4320)
    h.state.alive.add(4320)
    h.tracker.start({ game: spawnedGame('manual:r3'), child })
    await waitUntil(() => h.tracker.current()?.seen === true)
    // The launcher hands off to the real game and exits.
    h.state.alive.clear()
    const birth = Date.now()
    h.state.list = [proc({ pid: 4321, parentPid: 4320, name: 'real-game.exe', createdAt: birth })]
    child.emit('exit', 0, null)
    await sleep(timing.pollMs * 3)
    expect(h.ended).toEqual([])
    // The game quits and a service claims 4321 (same parent link by chance, different image and birth time).
    const takeover = Date.now() + 60_000
    h.state.list = [
      proc({ pid: 4321, parentPid: 4320, name: 'conhost.exe', createdAt: takeover }),
      proc({ pid: 4322, parentPid: 4321, name: 'cmd.exe', createdAt: takeover + 1 })
    ]
    await waitUntil(() => h.ended.length === 1, 3000)
    expect(h.logs.some((l) => /pid 4321 now belongs to conhost\.exe/.test(l))).toBe(true)
  })
})

describe('session tracker: play time', () => {
  it('sums the poll gaps and discards a gap that spans a sleep or hibernate', async () => {
    const clock = clockSkew()
    const h = setup()
    h.state.list = [proc({ pid: 100, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    h.tracker.start({ game: makeGame() })
    await waitUntil(() => h.tracker.current()?.seen === true)

    // Three awake gaps of 25 s (below pollMs + 30 s) are play time: 75 s -> 1 min.
    for (let i = 0; i < 3; i++) {
      clock.advance(25_000)
      await sleep(timing.pollMs * 3)
    }
    // The lid was closed for eight hours: timers did not run, Date.now() jumped, the gap is not play time.
    clock.advance(8 * 60 * 60_000)
    await sleep(timing.pollMs * 3)
    expect(
      h.logs.some((l) => /ignoring a 288\d\d s gap between polls \(sleep or hibernate\)/.test(l))
    ).toBe(true)

    h.state.list = []
    await waitUntil(() => h.ended.length === 1)
    // 75 s of awake gaps, not the 8 h the wall clock would say.
    expect(h.ended[0].minutes).toBe(1)
  })

  it('counts time from the launch, including the grace phase before the process appears', async () => {
    const clock = clockSkew()
    const h = setup({ timing: { graceMs: 10 * 60_000 } })
    h.tracker.start({ game: makeGame() })
    await sleep(timing.pollMs * 2)
    clock.advance(20_000)
    await sleep(timing.pollMs * 2)
    clock.advance(20_000)
    await sleep(timing.pollMs * 2)
    h.state.list = [proc({ pid: 100, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    await waitUntil(() => h.tracker.current()?.seen === true)
    clock.advance(20_000)
    await sleep(timing.pollMs * 2)
    h.tracker.end()
    expect(h.ended[0].minutes).toBe(1)
  })
})

describe('session tracker: event order', () => {
  it('emits session:started before session:ended for a none session', () => {
    const order: string[] = []
    const h = setup()
    h.events.on('session:started', () => order.push('started'))
    h.events.on('session:ended', () => order.push('ended'))
    h.tracker.start({ game: makeGame({ tracking: { mode: 'none' } }) })
    expect(order).toEqual(['started', 'ended'])
    expect(vi.isMockFunction(h.tracker.start)).toBe(false)
  })
})

describe('session tracker: gameProcesses (what stop() closes)', () => {
  it('is empty without a session and for an untracked launch', async () => {
    const h = setup()
    expect(await h.tracker.gameProcesses()).toEqual([])
    h.state.list = [proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })]
    h.tracker.start({ game: makeGame({ tracking: { mode: 'none' } }) })
    expect(await h.tracker.gameProcesses()).toEqual([])
  })

  it('returns the install-dir matches of the running session', async () => {
    const h = setup()
    const inside = proc({ pid: 500, path: 'C:\\Games\\Portal 2\\portal2.exe' })
    h.state.list = [inside, proc({ pid: 501, path: 'C:\\Games\\Portal 2 Mods\\mod.exe' })]
    h.tracker.start({ game: makeGame() })
    expect(await h.tracker.gameProcesses()).toEqual([inside])
  })

  it('returns the spawned process, its descendants and the hand-off dir', async () => {
    const h = setup()
    const game = makeGame({ id: 'manual:a', tracking: { mode: 'spawned' } })
    const child = fakeChild(700)
    h.state.alive.add(700)
    const now = Date.now()
    const root = proc({ pid: 700, name: 'launcher.exe', createdAt: now })
    const kid = proc({ pid: 701, parentPid: 700, name: 'game.exe', createdAt: now })
    const handoff = proc({ pid: 900, parentPid: 4, path: 'C:\\Games\\B\\b.exe', createdAt: now })
    const stranger = proc({ pid: 800, parentPid: 4, name: 'other.exe', createdAt: now })
    h.state.list = [root, kid, handoff, stranger]
    h.tracker.start({ game, child, spawnedAt: now, handoffDir: 'C:\\Games\\B' })
    const found = await h.tracker.gameProcesses()
    expect(found.map((p) => p.pid).sort()).toEqual([700, 701, 900])
    await waitUntil(() => h.tracker.current()?.seen === true)
  })
})
