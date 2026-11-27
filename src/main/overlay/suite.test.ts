import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  touch: { set: vi.fn(), dispose: vi.fn(), running: vi.fn(() => false) },
  touchDeps: null as null | { onSwipe: () => void },
  intelDispose: vi.fn(),
  pads: {
    start: vi.fn(),
    stop: vi.fn(),
    list: [] as { id: string; name: string; buttons: number }[],
    listeners: new Set<(p: unknown[]) => void>(),
    pads: vi.fn((): unknown[] => mocks.pads.list),
    onPads: vi.fn((l: (p: unknown[]) => void) => {
      mocks.pads.listeners.add(l)
      return () => mocks.pads.listeners.delete(l)
    })
  },
  ingameDeps: null as unknown as {
    load: (w: unknown) => Promise<void>
    notify: (g: { id: string; title: string }, m: string) => void
  },
  overlayDeps: null as unknown as {
    ingame?: {
      tryOpen: (...a: unknown[]) => Promise<boolean>
      close: () => Promise<void>
      active: () => boolean
    }
  },
  ingame: {
    shown: false,
    ended: null as null | ((why: string) => void),
    tryOpen: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    active: vi.fn(() => mocks.ingame.shown),
    activePid: vi.fn(() => 7),
    onEnded: vi.fn((l: (why: string) => void) => {
      mocks.ingame.ended = l
      return () => {}
    }),
    prewarm: vi.fn(),
    window: vi.fn(() => null),
    dispose: vi.fn()
  },
  order: [] as string[],
  nativeDispose: vi.fn(),
  setDisplayMode: vi.fn(async () => ({ ok: true, code: 0 })),
  displayModes: vi.fn(async () => ({ current: { width: 1920, height: 1200, hz: 60 }, modes: [] })),
  rtssDeps: null as unknown,
  extrasDeps: null as unknown,
  homeDeps: null as unknown as { onHome: () => void },
  memoryDeps: null as unknown,
  memory: {
    start: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn(async () => {}),
    status: vi.fn(),
    freeNow: vi.fn()
  },
  extras: {
    start: vi.fn(),
    dispose: vi.fn(async () => {}),
    displayChanged: vi.fn(async () => {})
  },
  pauseProcess: vi.fn(async () => ({ ok: true })),
  overlay: {
    create: vi.fn(),
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    toggle: vi.fn(async () => {}),
    state: vi.fn(() => ({ open: false })),
    window: vi.fn(() => null),
    hwnd: vi.fn(() => null),
    monitor: vi.fn(() => null),
    releasePause: vi.fn(async () => {}),
    adoptPaused: vi.fn(async () => {}),
    whileRunning: vi.fn(async <T>(work: () => Promise<T>) => work()),
    dispose: vi.fn()
  }
}))

vi.mock('electron', () => ({}))
vi.mock('../native-host/pad-reader', () => ({ createPadReader: () => mocks.pads }))
vi.mock('../native-host/native-ops', () => ({
  createNativeOps: () => ({
    foreground: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    pauseProcess: mocks.pauseProcess,
    setDisplayMode: mocks.setDisplayMode,
    displayModes: mocks.displayModes,
    hdrState: vi.fn(async () => null),
    rtssSnapshot: vi.fn(async () => null),
    rtssOsd: vi.fn(async () => ({ ok: false, error: 'missing' })),
    rtssRequestProfileUpdate: vi.fn(async () => 0),
    dispose: mocks.nativeDispose
  }),
  hwndOf: vi.fn()
}))
vi.mock('../touch-swipe/watcher', () => ({
  createTouchSwipeWatcher: (deps: { onSwipe: () => void }) => ((mocks.touchDeps = deps), mocks.touch)
}))
vi.mock('../native-host/sdl', () => ({ sdlDirFor: () => null }))
vi.mock('./overlay-window', () => ({
  createOverlayWindow: (deps: unknown) => {
    mocks.overlayDeps = deps as typeof mocks.overlayDeps
    return mocks.overlay
  }
}))
vi.mock('./ingame/service', () => ({
  createIngameOverlay: (deps: unknown) => {
    mocks.ingameDeps = deps as typeof mocks.ingameDeps
    return mocks.ingame
  }
}))
vi.mock('../home-button/service', () => ({
  createHomeButtonService: (deps: { onHome: () => void }) => (
    (mocks.homeDeps = deps),
    {
      start: vi.fn(),
      dispose: vi.fn(),
      idle: vi.fn(async () => {}),
      status: vi.fn(),
      startCapture: vi.fn(),
      stopCapture: vi.fn()
    }
  )
}))
vi.mock('../performance/service', () => ({
  createPerformanceService: () => ({
    start: vi.fn(),
    resume: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    apply: vi.fn()
  })
}))
vi.mock('../performance/memory/service', () => ({
  createMemoryService: (deps: unknown) => {
    mocks.memoryDeps = deps
    return mocks.memory
  }
}))
vi.mock('../media/media-service', () => ({ createMediaService: () => ({}) }))
vi.mock('../rtss', () => ({
  createRtssService: (deps: unknown) => {
    mocks.rtssDeps = deps
    return {}
  }
}))
vi.mock('./extras', () => ({
  createOverlayExtras: (deps: unknown) => {
    mocks.extrasDeps = deps
    return mocks.extras
  }
}))

import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Settings } from '../../shared/types'
import type { EventBus } from '../events'
import { createOverlaySuite, type OverlaySuiteDeps } from './suite'

interface TestSettings {
  input: {
    homeButtonEnabled: boolean
    homeOverrideGameBar: boolean
    keyboardCombo?: string[]
    touchSwipeOverlay?: boolean
  }
  music: { folder: string | null }
  ui: { volume: number }
}

function setup(
  initial: Partial<{
    home: boolean
    folder: string | null
    userData: string
    running: boolean
    outOfSight: boolean
    ingame: boolean
    touch: boolean
  }> = {}
): {
  suite: ReturnType<typeof createOverlaySuite>
  deps: OverlaySuiteDeps
  change(
    patch: Partial<{
      home: boolean
      gameBar: boolean
      folder: string | null
      volume: number
      keyboard: string[]
    }>
  ): void
} {
  let current: TestSettings = {
    input: {
      homeButtonEnabled: initial.home ?? true,
      homeOverrideGameBar: true,
      touchSwipeOverlay: initial.touch ?? false
    },
    music: { folder: initial.folder ?? null },
    ui: { volume: 1 }
  }
  const listeners = new Set<(s: Settings) => void>()
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: OverlaySuiteDeps = {
    settings: {
      get: () => current as unknown as Settings,
      update: vi.fn(() => current as unknown as Settings),
      onChange: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      }
    },
    library: { getGame: vi.fn(), updateGame: vi.fn() },
    launcher: {
      running: () => (initial.running ? { gameId: 'steam:1' } : null),
      stop: vi.fn(async () => true)
    },
    events: { emit: vi.fn(), on: vi.fn() } as unknown as EventBus,
    log: () => log,
    userData: initial.userData ?? 'C:\\data',
    sdlCandidates: () => [],
    preload: 'preload.js',
    loadOverlay: vi.fn(async () => {}),
    screen: {} as Electron.Screen,
    mainWindow: { hwnd: () => null, show: vi.fn(), outOfSight: () => initial.outOfSight ?? false },
    setPowerMode: vi.fn(async () => {}),
    system: { perf: vi.fn(), status: vi.fn() },
    selfExe: 'PlayOut.exe',
    runningImages: async () => new Set<string>(),
    ...(initial.ingame ? { ingameDir: 'C:/res/ingame' } : {}),
    intel: { status: vi.fn(), set: vi.fn(), dispose: mocks.intelDispose }
  }
  const suite = createOverlaySuite(deps)
  return {
    suite,
    deps,
    change(patch) {
      current = {
        input: {
          homeButtonEnabled: patch.home ?? current.input.homeButtonEnabled,
          homeOverrideGameBar: patch.gameBar ?? current.input.homeOverrideGameBar,
          keyboardCombo: patch.keyboard ?? current.input.keyboardCombo ?? []
        },
        music: { folder: patch.folder !== undefined ? patch.folder : current.music.folder },
        ui: { volume: patch.volume ?? current.ui.volume }
      }
      for (const l of listeners) l(current as unknown as Settings)
    }
  }
}

describe('createOverlaySuite: home button and overlay window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('brings PlayOut back on Home when it is minimized or in the tray and no game runs, else opens the overlay', () => {
    const away = setup({ outOfSight: true })
    mocks.homeDeps.onHome()
    expect(away.deps.mainWindow.show).toHaveBeenCalledTimes(1)
    expect(mocks.overlay.toggle).not.toHaveBeenCalled()

    // In a game PlayOut minimizes itself: Home opens the overlay.
    const inGame = setup({ outOfSight: true, running: true })
    mocks.homeDeps.onHome()
    expect(inGame.deps.mainWindow.show).not.toHaveBeenCalled()
    expect(mocks.overlay.toggle).toHaveBeenCalledTimes(1)

    // PlayOut on screen: the overlay as before.
    const shown = setup({ outOfSight: false })
    mocks.homeDeps.onHome()
    expect(shown.deps.mainWindow.show).not.toHaveBeenCalled()
    expect(mocks.overlay.toggle).toHaveBeenCalledTimes(2)
  })

  it("runs the reader for the on-screen keyboard's buttons with the home button off", () => {
    const { suite, change } = setup({ home: false })
    suite.start()
    expect(mocks.pads.start).not.toHaveBeenCalled()
    change({ keyboard: ['ls', 'rs'] })
    expect(mocks.pads.start).toHaveBeenCalledTimes(1)
  })

  it('starts the reader and creates the window when the home button is on', () => {
    const { suite } = setup({ home: true })
    suite.start()
    expect(mocks.pads.start).toHaveBeenCalledTimes(1)
    expect(mocks.overlay.create).toHaveBeenCalledTimes(1)
  })

  it('does not restart a reader that gave up on unrelated settings changes', () => {
    const { suite, change } = setup({ home: true })
    suite.start()
    change({ volume: 0.5 })
    change({ volume: 0.4 })
    change({ folder: 'D:\\Music' })
    expect(mocks.pads.start).toHaveBeenCalledTimes(1)
    expect(mocks.pads.stop).not.toHaveBeenCalled()
  })

  it('starts and stops the reader only when the home button setting changes', () => {
    const { suite, change } = setup({ home: true })
    suite.start()
    change({ home: false })
    expect(mocks.pads.stop).toHaveBeenCalledTimes(1)
    change({ volume: 0.2 })
    expect(mocks.pads.stop).toHaveBeenCalledTimes(1)
    change({ home: true })
    expect(mocks.pads.start).toHaveBeenCalledTimes(2)
  })

  it('creates the overlay window for the music player while the home button is off', () => {
    const { suite, change } = setup({ home: false, folder: null })
    suite.start()
    expect(mocks.overlay.create).not.toHaveBeenCalled()
    expect(mocks.pads.start).not.toHaveBeenCalled()
    change({ folder: 'D:\\Music' })
    expect(mocks.overlay.create).toHaveBeenCalledTimes(1)
    expect(mocks.pads.start).not.toHaveBeenCalled()
  })

  it('creates the window at start when only a music folder is set', () => {
    const { suite } = setup({ home: false, folder: 'D:\\Music' })
    suite.start()
    expect(mocks.overlay.create).toHaveBeenCalledTimes(1)
    expect(mocks.pads.start).not.toHaveBeenCalled()
    expect(mocks.pads.stop).toHaveBeenCalledTimes(1)
  })

  it('restarts the reader on resume after sleep, even with unchanged settings', () => {
    const { suite } = setup({ home: true })
    suite.start()
    suite.suspend()
    expect(mocks.pads.stop).toHaveBeenCalledTimes(1)
    suite.resume()
    expect(mocks.pads.start).toHaveBeenCalledTimes(2)
  })

  it('stops following settings after dispose', async () => {
    const { suite, change } = setup({ home: true })
    suite.start()
    await suite.dispose()
    change({ home: false })
    change({ home: true })
    expect(mocks.pads.start).toHaveBeenCalledTimes(1)
  })

  it('starts the reader again when Turn off Xbox Game Bar changes, so it knows whether to close Game Bar', () => {
    const { suite, change } = setup({ home: true })
    suite.start()
    change({ gameBar: false })
    expect(mocks.pads.stop).toHaveBeenCalledTimes(1)
    expect(mocks.pads.start).toHaveBeenCalledTimes(2)
    change({ volume: 0.3 })
    expect(mocks.pads.start).toHaveBeenCalledTimes(2)
  })

  it('hands a program the last run left paused to the overlay to resume', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'playout-suite-'))
    try {
      await fs.mkdir(join(dir, 'overlay'), { recursive: true })
      const file = join(dir, 'overlay', 'paused.json')
      await fs.writeFile(file, JSON.stringify({ pid: 4242, created: 99, program: 'Game.exe' }))
      const { suite } = setup({ userData: dir })
      suite.start()
      await vi.waitFor(() =>
        expect(mocks.overlay.adoptPaused).toHaveBeenCalledWith({
          pid: 4242,
          created: 99,
          program: 'Game.exe'
        })
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('forgets a pause record it cannot read', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'playout-suite-'))
    try {
      await fs.mkdir(join(dir, 'overlay'), { recursive: true })
      const file = join(dir, 'overlay', 'paused.json')
      await fs.writeFile(file, JSON.stringify({ pid: 'x', program: 'Game.exe' }))
      const { suite } = setup({ userData: dir })
      suite.start()
      await vi.waitFor(async () =>
        expect(
          await fs.access(file).then(
            () => true,
            () => false
          )
        ).toBe(false)
      )
      expect(mocks.overlay.adoptPaused).not.toHaveBeenCalled()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('createOverlaySuite: overlay extras', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
  })

  it('wires the extras to the native host, the power helper and the settings', () => {
    const { suite } = setup()
    expect(suite.extras).toBe(mocks.extras)
    const deps = mocks.extrasDeps as { selfExe: string; store: unknown; autoHdr: unknown }
    expect(deps.selfExe).toBe('PlayOut.exe')
    expect(deps.store).toBeTruthy()
    expect(deps.autoHdr).toBeTruthy()
    const rtss = mocks.rtssDeps as { native: unknown; helper: unknown }
    expect(typeof rtss.helper).toBe('function')
    expect(rtss.native).toBeTruthy()
    suite.start()
    expect(mocks.extras.start).toHaveBeenCalledTimes(1)
  })

  it('tells the extras about a display change (sync re-applies)', async () => {
    mocks.overlay.monitor.mockReturnValueOnce('DISPLAY1' as never)
    mocks.overlay.monitor.mockReturnValueOnce('DISPLAY1' as never)
    const { suite } = setup()
    await suite.setDisplayMode({ width: 1920, height: 1200, hz: 120 })
    expect(mocks.setDisplayMode).toHaveBeenCalled()
    expect(mocks.extras.displayChanged).toHaveBeenCalledTimes(1)
  })

  it('releases the performance overlay before the native host stops', async () => {
    mocks.extras.dispose.mockImplementationOnce(async () => void mocks.order.push('extras'))
    mocks.nativeDispose.mockImplementationOnce(() => void mocks.order.push('native'))
    const { suite } = setup()
    suite.start()
    await suite.dispose()
    expect(mocks.order).toEqual(['extras', 'native'])
    expect(mocks.intelDispose).toHaveBeenCalledTimes(1)
  })

  it('runs the memory cleanup only once started, pauses it for sleep and stops it before the native host', async () => {
    mocks.memory.dispose.mockImplementationOnce(async () => void mocks.order.push('memory'))
    mocks.nativeDispose.mockImplementationOnce(() => void mocks.order.push('native'))
    const { suite } = setup()
    expect(suite.memory).toBe(mocks.memory)
    const deps = mocks.memoryDeps as {
      native: { foreground: unknown; trimWorkingSets?: unknown }
      helper: unknown
      systemTier: unknown
      ownNames: string[]
    }
    expect(deps.native.foreground).toBeTruthy()
    expect(typeof deps.helper).toBe('function')
    expect(typeof deps.systemTier).toBe('function')
    // PlayOut's own exe is never trimmed, whatever it is called.
    expect(deps.ownNames).toEqual(['PlayOut.exe'])
    // A --mock run never calls start(): nothing is sampled or trimmed.
    expect(mocks.memory.start).not.toHaveBeenCalled()
    suite.start()
    expect(mocks.memory.start).toHaveBeenCalledTimes(1)
    suite.suspend()
    expect(mocks.memory.suspend).toHaveBeenCalledTimes(1)
    suite.resume()
    expect(mocks.memory.resume).toHaveBeenCalledTimes(1)
    await suite.dispose()
    expect(mocks.order).toEqual(['memory', 'native'])
  })

  it('exposes the Intel graphics settings it was given', () => {
    const { suite } = setup()
    expect(suite.intel.dispose).toBe(mocks.intelDispose)
  })
})

describe('createOverlaySuite: in-game overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ingame.shown = false
    mocks.ingameDeps = null as unknown as typeof mocks.ingameDeps
    mocks.pads.listeners.clear()
    mocks.pads.list = []
  })

  const fg = {
    hwnd: '500',
    pid: 7,
    exe: 'D:/Games/Game.exe',
    title: 'Game',
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    monitor: null,
    fullscreen: true,
    exclusive: true
  }
  const target = { hwnd: '500', pid: 7, exclusive: true, program: 'Game.exe' }

  it('is left out without its folder', () => {
    setup()
    expect(mocks.ingameDeps).toBeNull()
    expect(mocks.overlayDeps.ingame).toBeUndefined()
  })

  it('loads the offscreen page with ingame=1 and toasts through overlay:ingame-notice', async () => {
    const { deps } = setup({ ingame: true })
    expect(mocks.overlayDeps.ingame).toBeDefined()
    await mocks.ingameDeps.load('win')
    expect(deps.loadOverlay).toHaveBeenCalledWith('win', { ingame: '1' })
    mocks.ingameDeps.notify({ id: 'steam:1', title: 'Spelunky 2' }, 'crashed')
    expect(deps.events.emit).toHaveBeenCalledWith('overlay:ingame-notice', {
      gameId: 'steam:1',
      title: 'Spelunky 2',
      message: 'crashed'
    })
  })

  it('sends the pads while the in-game overlay is shown, and only then', async () => {
    const { suite, deps } = setup({ ingame: true })
    suite.start()
    const pad = { id: 'p1', name: 'Pad', buttons: 1 }
    for (const l of mocks.pads.listeners) l([pad])
    expect(deps.events.emit).not.toHaveBeenCalledWith('overlay:pad', expect.anything())

    mocks.pads.list = [pad]
    mocks.ingame.tryOpen.mockImplementationOnce(async () => (mocks.ingame.shown = true))
    expect(await mocks.overlayDeps.ingame!.tryOpen(target, fg, { hold: false })).toBe(true)
    // The first snapshot follows the open's 'overlay:state' (sent once tryOpen has returned).
    expect(deps.events.emit).not.toHaveBeenCalledWith('overlay:pad', expect.anything())
    await new Promise((r) => setImmediate(r))
    expect(deps.events.emit).toHaveBeenCalledWith('overlay:pad', { pads: [pad] })
    for (const l of mocks.pads.listeners) l([{ ...pad, buttons: 0 }])
    expect(deps.events.emit).toHaveBeenLastCalledWith('overlay:pad', {
      pads: [{ ...pad, buttons: 0 }]
    })

    await mocks.overlayDeps.ingame!.close()
    expect(mocks.ingame.close).toHaveBeenCalled()
    await suite.dispose()
    expect(mocks.ingame.dispose).toHaveBeenCalled()
    expect(mocks.pads.listeners.size).toBe(0)
  })

  it('closes the overlay when the in-game overlay ends by itself', () => {
    setup({ ingame: true })
    mocks.ingame.ended!('the game exited')
    expect(mocks.overlay.close).toHaveBeenCalledWith({ refocus: false })
  })

  it('scans a game for anti-cheat when its session starts', () => {
    const { suite, deps } = setup({ ingame: true })
    suite.start()
    const on = deps.events.on as unknown as ReturnType<typeof vi.fn>
    for (const call of on.mock.calls.filter((c) => c[0] === 'session:started'))
      (call[1] as (p: { gameId: string }) => void)({ gameId: 'steam:1' })
    expect(mocks.ingame.prewarm).toHaveBeenCalledWith('steam:1')
  })
})

describe('createOverlaySuite: touch swipe', () => {
  function fire(deps: OverlaySuiteDeps, event: string): void {
    const on = deps.events.on as unknown as ReturnType<typeof vi.fn>
    for (const call of on.mock.calls.filter((c) => c[0] === event))
      (call[1] as (p: unknown) => void)({ gameId: 'steam:1', startedAt: '', endedAt: '', minutes: 0 })
  }

  it('watches touches only while a game runs and the setting is on', () => {
    mocks.touch.set.mockClear()
    const { suite, deps } = setup({ touch: true })
    suite.start()
    expect(mocks.touch.set).toHaveBeenLastCalledWith(false)
    fire(deps, 'session:started')
    expect(mocks.touch.set).toHaveBeenLastCalledWith(true)
    fire(deps, 'session:ended')
    expect(mocks.touch.set).toHaveBeenLastCalledWith(false)
    void suite.dispose()
    expect(mocks.touch.dispose).toHaveBeenCalled()
  })

  it('stays off when the setting is off, and a swipe opens the overlay', () => {
    mocks.touch.set.mockClear()
    mocks.overlay.open.mockClear()
    const { suite, deps } = setup({ touch: false, running: true })
    suite.start()
    fire(deps, 'session:started')
    expect(mocks.touch.set).not.toHaveBeenCalledWith(true)
    mocks.touchDeps!.onSwipe()
    expect(mocks.overlay.open).toHaveBeenCalledTimes(1)
    mocks.overlay.state.mockReturnValueOnce({ open: true })
    mocks.touchDeps!.onSwipe()
    expect(mocks.overlay.open).toHaveBeenCalledTimes(1)
  })
})
