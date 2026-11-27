import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, shell: { openExternal: vi.fn() } }))
vi.mock('../util/app-origin', () => ({ isAppUrl: (url: string) => url.startsWith('file:///app/') }))

import type { OverlayState } from '../../shared/overlay'
import type { ForegroundWindow, Rect } from './overlay-logic'
import {
  createOverlayWindow,
  overlayWindowOptions,
  type OverlayNative,
  EXCLUSIVE_REFIT_MS,
  PAUSE_CHECK_MS,
  type OverlayWin,
  type OverlayWindowDeps,
  type OverlayWindowScreen
} from './overlay-window'

type Fn = Mock<(...args: never[]) => unknown>

interface FakeWin extends OverlayWin {
  visible: boolean
  destroyed: boolean
  calls: string[]
  bounds: Rect
  fire(event: string): void
  navigate(event: string, url: string): boolean
  show: Fn
  showInactive: Fn
  setFocusable: Fn
  setSkipTaskbar: Fn
  focusable: boolean
  hide: Fn
  focus: Fn
  setBounds: Fn
  setAlwaysOnTop: Fn
}

function fakeWin(): FakeWin {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  const add = (e: string, l: (...a: unknown[]) => void): void => {
    listeners.set(e, [...(listeners.get(e) ?? []), l])
  }
  const w: FakeWin = {
    visible: false,
    destroyed: false,
    calls: [],
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    show: vi.fn(() => {
      w.visible = true
      w.calls.push('show')
    }),
    showInactive: vi.fn(() => {
      w.visible = true
      w.calls.push('showInactive')
    }),
    focusable: true,
    setFocusable: vi.fn((flag: boolean) => {
      w.focusable = flag
      w.calls.push(flag ? 'focusable' : 'not-focusable')
    }),
    setSkipTaskbar: vi.fn(() => w.calls.push('skip-taskbar')),
    hide: vi.fn(() => {
      w.visible = false
      w.calls.push('hide')
    }),
    focus: vi.fn(() => w.calls.push('focus')),
    destroy: () => {
      w.destroyed = true
      w.fire('closed')
    },
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    setBounds: vi.fn((b: Partial<Rect>) => {
      w.bounds = { ...w.bounds, ...b }
      w.calls.push('bounds')
    }),
    getBounds: () => ({ ...w.bounds }),
    setAlwaysOnTop: vi.fn(() => w.calls.push('top')),
    getNativeWindowHandle: () => Buffer.from([1]),
    on: (e: string, l: () => void) => add(e, l),
    webContents: {
      setWindowOpenHandler: () => {},
      on: (e: string, l: (event: { preventDefault(): void }, url: string) => void) =>
        add(e, l as never)
    },
    fire: (e) => {
      for (const l of listeners.get(e) ?? []) l()
    },
    navigate: (e, url) => {
      let prevented = false
      for (const l of listeners.get(e) ?? []) l({ preventDefault: () => (prevented = true) }, url)
      return prevented
    }
  }
  return w
}

const monitor2 = { x: 1920, y: 0, width: 1920, height: 1080 }

function game(over: Partial<ForegroundWindow> = {}): ForegroundWindow {
  return {
    hwnd: '500',
    pid: 7,
    exe: 'D:\\Games\\Game.exe',
    title: 'Game',
    rect: monitor2,
    monitor: { device: '\\\\.\\DISPLAY2', rect: monitor2, workArea: monitor2 },
    fullscreen: true,
    exclusive: false,
    ...over
  }
}

function setup(fg: ForegroundWindow | null = game()): {
  overlay: ReturnType<typeof createOverlayWindow>
  wins: FakeWin[]
  native: { [K in keyof OverlayNative]: Fn }
  emitted: OverlayState[]
  deps: OverlayWindowDeps
  running: { value: { gameId: string } | null }
  screen: FakeScreen
} {
  const wins: FakeWin[] = []
  const emitted: OverlayState[] = []
  const running = { value: null as { gameId: string } | null }
  const screen = fakeScreen()
  const native = {
    foreground: vi.fn(async () => fg),
    focus: vi.fn(async () => true),
    restore: vi.fn(async () => {}),
    pauseProcess: vi.fn(async (_pid: number, pause: boolean) =>
      pause ? { ok: true, created: 1234 } : { ok: true, created: 1234 }
    ),
    hwndOf: vi.fn(() => '100')
  }
  const deps: OverlayWindowDeps = {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    preload: 'preload.js',
    load: vi.fn(async () => {}),
    native,
    screen,
    events: { emit: (_e, p) => emitted.push(p) },
    running: () => running.value,
    isPlayOutWindow: (h) => h === '100' || h === '101',
    ownPid: 1,
    runningImages: async () => new Set(['game.exe', 'explorer.exe']),
    sleep: async () => {},
    createWindow: () => {
      const w = fakeWin()
      wins.push(w)
      return w
    }
  }
  return { overlay: createOverlayWindow(deps), wins, native, emitted, deps, running, screen }
}

/**
 * Electron's screen with two displays side by side: the primary at 0,0 and the second right of it. `second` can be
 * changed (a mode change) or removed, and `fire` sends a display event to the listeners.
 */
interface FakeScreen extends OverlayWindowScreen {
  primary: Rect
  second: Rect | null
  listeners: Map<string, Set<() => void>>
  fire(event: 'display-metrics-changed' | 'display-removed'): void
}

function fakeScreen(): FakeScreen {
  const s: FakeScreen = {
    primary: { x: 0, y: 0, width: 1920, height: 1080 },
    second: { ...monitor2 },
    listeners: new Map(),
    getPrimaryDisplay: () => ({ bounds: s.primary }),
    getDisplayMatching: (r) => ({
      bounds: s.second && r.x >= s.primary.x + s.primary.width ? s.second : s.primary
    }),
    screenToDipRect: (_w, r) => r,
    on: (event: string, listener: () => void) => {
      const set = s.listeners.get(event) ?? new Set()
      set.add(listener)
      s.listeners.set(event, set)
    },
    removeListener: (event: string, listener: () => void) => {
      s.listeners.get(event)?.delete(listener)
    },
    fire: (event) => {
      for (const l of s.listeners.get(event) ?? []) l()
    }
  }
  return s
}

describe('overlayWindowOptions', () => {
  it('is a transparent, frameless, fixed window with the app preload', () => {
    const o = overlayWindowOptions('p.js')
    expect(o).toMatchObject({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: true,
      hasShadow: false
    })
    expect(o.webPreferences).toMatchObject({
      preload: 'p.js',
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    })
  })
})

describe('createOverlayWindow', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => {
    s = setup()
  })

  it('creates the window once and loads it', () => {
    s.overlay.create()
    s.overlay.create()
    expect(s.wins).toHaveLength(1)
    expect(s.deps.load).toHaveBeenCalledTimes(1)
    expect(s.overlay.state()).toEqual({ open: false })
    expect(s.overlay.hwnd()).toBe('100')
  })

  it('opens on the game monitor, on top, focused natively', async () => {
    await s.overlay.open()
    const w = s.wins[0]!
    expect(w.setBounds).toHaveBeenCalledWith(monitor2)
    expect(w.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(w.calls.indexOf('top')).toBeLessThan(w.calls.indexOf('show'))
    expect(s.native.focus).toHaveBeenCalledWith('100')
    expect(w.focus).not.toHaveBeenCalled()
    expect(s.overlay.state()).toEqual({ open: true, program: 'Game.exe' })
    expect(s.emitted).toEqual([{ open: true, program: 'Game.exe' }])
  })

  it('names the running game', async () => {
    s.running.value = { gameId: 'g1' }
    await s.overlay.open()
    expect(s.overlay.state()).toEqual({ open: true, gameId: 'g1' })
  })

  it('falls back to win.focus when native focus fails', async () => {
    s.native.focus.mockResolvedValueOnce(false)
    await s.overlay.open()
    expect(s.wins[0]!.focus).toHaveBeenCalled()
  })

  it('still opens on the primary display without a foreground window', async () => {
    s = setup(null)
    await s.overlay.open()
    expect(s.wins[0]!.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(s.overlay.state()).toEqual({ open: true })
    await s.overlay.close()
    expect(s.native.focus).toHaveBeenCalledTimes(1) // only the overlay's own focus
  })

  it('gives the foreground back on close', async () => {
    await s.overlay.open()
    await s.overlay.close()
    expect(s.wins[0]!.visible).toBe(false)
    expect(s.native.restore).not.toHaveBeenCalled()
    expect(s.native.focus).toHaveBeenLastCalledWith('500')
    expect(s.emitted.at(-1)).toEqual({ open: false })
  })

  it('takes the foreground over a windowed game, staying off the taskbar', async () => {
    await s.overlay.open()
    const w = s.wins[0]!
    expect(w.focusable).toBe(true)
    expect(w.show).toHaveBeenCalled()
    expect(w.showInactive).not.toHaveBeenCalled()
    expect(w.calls.indexOf('focusable')).toBeLessThan(w.calls.indexOf('skip-taskbar'))
  })

  it('never takes the foreground from an exclusive full-screen game that keeps it', async () => {
    s = setup(game({ exclusive: true }))
    await s.overlay.open()
    const w = s.wins[0]!
    expect(w.calls.indexOf('not-focusable')).toBeLessThan(w.calls.indexOf('showInactive'))
    expect(w.setSkipTaskbar).toHaveBeenCalledWith(true)
    expect(w.show).not.toHaveBeenCalled()
    expect(s.native.focus).not.toHaveBeenCalled()
    expect(w.focus).not.toHaveBeenCalled()
    await s.overlay.close()
    expect(s.native.focus).not.toHaveBeenCalled()
    expect(s.native.restore).not.toHaveBeenCalled()
  })

  it('takes the foreground once an exclusive game lost it anyway, and restores the game on close', async () => {
    s = setup(game({ exclusive: true }))
    // On open the game is in front; it then minimizes (true exclusive mode) and another window is.
    s.native.foreground.mockResolvedValueOnce(game({ exclusive: true }))
    s.native.foreground.mockResolvedValue(game({ hwnd: '900' }))
    await s.overlay.open()
    const w = s.wins[0]!
    expect(w.setFocusable).toHaveBeenLastCalledWith(true)
    expect(w.calls.lastIndexOf('focusable')).toBeLessThan(w.calls.lastIndexOf('skip-taskbar'))
    expect(s.native.focus).toHaveBeenCalledWith('100')
    await s.overlay.close()
    expect(s.native.restore).toHaveBeenCalledWith('500')
    expect(s.native.focus).toHaveBeenLastCalledWith('500')
  })

  it('restores an exclusive game that lost the foreground only after the open', async () => {
    s = setup(game({ exclusive: true }))
    await s.overlay.open()
    s.native.foreground.mockResolvedValue(game({ hwnd: '900' }))
    await s.overlay.close()
    expect(s.native.restore).toHaveBeenCalledWith('500')
  })

  it('pauses an exclusive game it keeps the foreground for at once', async () => {
    s = setup(game({ exclusive: true }))
    s.deps.pauseGame = () => true
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    expect(s.native.pauseProcess).toHaveBeenCalledWith(7, true)
    expect(s.native.focus).not.toHaveBeenCalled()
  })

  it('does not refocus when asked not to', async () => {
    await s.overlay.open()
    await s.overlay.close({ refocus: false })
    expect(s.native.focus).toHaveBeenCalledTimes(1)
  })

  it('does not keep a PlayOut window as the target', async () => {
    s = setup(game({ hwnd: '101' }))
    await s.overlay.open()
    expect(s.overlay.state()).toEqual({ open: true })
    await s.overlay.close()
    expect(s.native.focus).toHaveBeenCalledTimes(1)
  })

  it('serializes double opens and toggles', async () => {
    await Promise.all([s.overlay.open(), s.overlay.open(), s.overlay.toggle(), s.overlay.toggle()])
    // open, (open: no-op), toggle -> close, toggle -> open
    expect(s.native.foreground).toHaveBeenCalledTimes(2)
    expect(s.overlay.state().open).toBe(true)
    expect(s.emitted.map((e) => e.open)).toEqual([true, false, true])
  })

  it('ignores a close when already closed', async () => {
    await s.overlay.close()
    expect(s.emitted).toEqual([])
    expect(s.native.focus).not.toHaveBeenCalled()
  })

  it('keeps working after a failing native call', async () => {
    s.native.foreground.mockRejectedValueOnce(new Error('host down'))
    await s.overlay.open()
    expect(s.overlay.state()).toEqual({ open: true })
    s.native.focus.mockRejectedValueOnce(new Error('x'))
    await s.overlay.close()
    await s.overlay.open()
    expect(s.overlay.state()).toEqual({ open: true, program: 'Game.exe' })
  })

  it('recreates the window after it was closed from outside', async () => {
    await s.overlay.open()
    s.wins[0]!.destroy()
    expect(s.overlay.state()).toEqual({ open: false })
    expect(s.overlay.window()).toBeNull()
    await s.overlay.open()
    expect(s.wins).toHaveLength(2)
    expect(s.overlay.state().open).toBe(true)
  })

  it('blocks navigation away from the app', () => {
    s.overlay.create()
    expect(s.wins[0]!.navigate('will-navigate', 'https://evil.example/')).toBe(true)
    expect(s.wins[0]!.navigate('will-navigate', 'file:///app/index.html?overlay=1')).toBe(false)
  })

  it('re-fits the open overlay when its display changes mode', async () => {
    await s.overlay.open()
    const w = s.wins[0]!
    expect(w.bounds).toEqual(monitor2)
    s.screen.second = { x: 1920, y: 0, width: 2560, height: 1440 }
    s.screen.fire('display-metrics-changed')
    expect(w.setBounds).toHaveBeenLastCalledWith({ x: 1920, y: 0, width: 2560, height: 1440 })
    expect(w.bounds).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 })
  })

  it('moves the open overlay to the remaining display when its monitor is removed', async () => {
    await s.overlay.open()
    const w = s.wins[0]!
    s.screen.second = null
    s.screen.fire('display-removed')
    expect(w.bounds).toEqual(s.screen.primary)
  })

  it('leaves the bounds alone when nothing changed, and while closed', async () => {
    await s.overlay.open()
    const w = s.wins[0]!
    const before = w.setBounds.mock.calls.length
    s.screen.fire('display-metrics-changed')
    expect(w.setBounds).toHaveBeenCalledTimes(before)
    await s.overlay.close()
    s.screen.second = { x: 1920, y: 0, width: 2560, height: 1440 }
    s.screen.fire('display-metrics-changed')
    expect(w.setBounds).toHaveBeenCalledTimes(before)
  })

  it('re-fits once after opening over an exclusive game whose mode goes away', async () => {
    vi.useFakeTimers()
    try {
      // The game holds 1280x720 on the second monitor while the overlay reads the bounds.
      const gameMode = { x: 1920, y: 0, width: 1280, height: 720 }
      s = setup(
        game({
          exclusive: true,
          rect: gameMode,
          monitor: { device: '\\\\.\\DISPLAY2', rect: gameMode, workArea: gameMode }
        })
      )
      s.screen.second = { ...gameMode }
      // It loses the foreground anyway (true exclusive mode) and minimizes.
      s.native.foreground.mockResolvedValueOnce(
        game({
          exclusive: true,
          rect: gameMode,
          monitor: { device: '\\\\.\\DISPLAY2', rect: gameMode, workArea: gameMode }
        })
      )
      s.native.foreground.mockResolvedValue(game({ hwnd: '900' }))
      await s.overlay.open()
      const w = s.wins[0]!
      expect(w.bounds).toEqual(gameMode)
      // The game minimizes and the monitor goes back to its desktop mode; no display event reaches us.
      s.screen.second = { ...monitor2 }
      vi.advanceTimersByTime(EXCLUSIVE_REFIT_MS - 1)
      expect(w.bounds).toEqual(gameMode)
      vi.advanceTimersByTime(1)
      expect(w.bounds).toEqual(monitor2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the pending exclusive re-fit when the overlay closes first', async () => {
    vi.useFakeTimers()
    try {
      s = setup(game({ exclusive: true }))
      await s.overlay.open()
      await s.overlay.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule a re-fit over a windowed game', async () => {
    vi.useFakeTimers()
    try {
      await s.overlay.open()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops listening to display events on dispose', () => {
    expect(s.screen.listeners.get('display-metrics-changed')?.size).toBe(1)
    expect(s.screen.listeners.get('display-removed')?.size).toBe(1)
    s.overlay.dispose()
    expect(s.screen.listeners.get('display-metrics-changed')?.size).toBe(0)
    expect(s.screen.listeners.get('display-removed')?.size).toBe(0)
  })

  it('does nothing after dispose', async () => {
    s.overlay.create()
    s.overlay.dispose()
    expect(s.wins[0]!.destroyed).toBe(true)
    await s.overlay.open()
    expect(s.wins).toHaveLength(1)
    expect(s.overlay.state()).toEqual({ open: false })
  })

  it('pauses the program it opens over and resumes it before giving the foreground back', async () => {
    const s = setup()
    const saved: unknown[] = []
    s.deps.pauseGame = () => true
    s.deps.pausedStore = { save: async (r) => void saved.push(r) }
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    expect(s.native.pauseProcess).toHaveBeenCalledWith(7, true)
    expect(overlay.state()).toMatchObject({ open: true, paused: true })
    expect(saved).toEqual([{ pid: 7, created: 1234, program: 'Game.exe' }])
    await overlay.close()
    expect(s.native.pauseProcess).toHaveBeenLastCalledWith(7, false, 1234)
    expect(saved.at(-1)).toBeNull()
    const order = [
      s.native.pauseProcess.mock.invocationCallOrder.at(-1)!,
      s.native.focus.mock.invocationCallOrder.at(-1)!
    ]
    expect(order[0]).toBeLessThan(order[1])
  })

  it('does not pause when the setting is off, or over PlayOut or the shell', async () => {
    const off = setup()
    off.deps.pauseGame = () => false
    await createOverlayWindow(off.deps).open()
    expect(off.native.pauseProcess).not.toHaveBeenCalled()

    const shell = setup(game({ exe: 'C:\\Windows\\explorer.exe' }))
    shell.deps.pauseGame = () => true
    await createOverlayWindow(shell.deps).open()
    expect(shell.native.pauseProcess).not.toHaveBeenCalled()
  })

  it('opens over a game under anti-cheat without pausing it, and when the running programs are unknown', async () => {
    const lists: (() => Promise<Set<string> | null>)[] = [
      async () => new Set(['game.exe', 'easyanticheat.exe']),
      async () => null,
      async () => {
        throw new Error('tasklist failed')
      }
    ]
    for (const runningImages of lists) {
      const s = setup()
      const saved: unknown[] = []
      s.deps.pauseGame = () => true
      s.deps.pausedStore = { save: async (r) => void saved.push(r) }
      s.deps.runningImages = runningImages
      const overlay = createOverlayWindow(s.deps)
      await overlay.open()
      expect(overlay.state()).toEqual({ open: true, program: 'Game.exe' })
      expect(s.wins[0]!.visible).toBe(true)
      expect(s.native.pauseProcess).not.toHaveBeenCalled()
      expect(saved).toEqual([])
      await overlay.close()
      expect(s.native.pauseProcess).not.toHaveBeenCalled()
      expect(s.native.focus).toHaveBeenLastCalledWith('500')
    }
  })

  it('never pauses a competitive online game, nor when that check fails; pauses any other game', async () => {
    const checks: NonNullable<OverlayWindowDeps['pauseBlockedBy']>[] = [
      ({ program, exe }) =>
        program === 'Game.exe' && !!exe ? 'Arena is a competitive online game' : null,
      () => {
        throw new Error('library unreadable')
      }
    ]
    for (const pauseBlockedBy of checks) {
      const s = setup()
      s.deps.pauseGame = () => true
      s.deps.runningImages = async () => new Set(['game.exe'])
      s.deps.pauseBlockedBy = pauseBlockedBy
      const overlay = createOverlayWindow(s.deps)
      await overlay.open()
      expect(overlay.state()).toEqual({ open: true, program: 'Game.exe' })
      expect(s.native.pauseProcess).not.toHaveBeenCalled()
      await overlay.close()
    }
    const other = setup()
    other.deps.pauseGame = () => true
    other.deps.runningImages = async () => new Set(['game.exe'])
    other.deps.pauseBlockedBy = () => null
    await createOverlayWindow(other.deps).open()
    expect(other.native.pauseProcess).toHaveBeenCalledWith(expect.any(Number), true)
  })

  it('gives up on the pause, and still closes, when the running programs are never read', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      s.deps.pauseGame = () => true
      let asked = 0
      s.deps.runningImages = () => {
        asked++
        return new Promise(() => {})
      }
      const overlay = createOverlayWindow(s.deps)
      const opened = overlay.open()
      const closed = overlay.close()
      let done = false
      void closed.then(() => (done = true))
      await vi.advanceTimersByTimeAsync(PAUSE_CHECK_MS - 1)
      // The overlay is up and the list was asked for before the pause step; the close waits behind the open.
      expect(s.wins[0]!.visible).toBe(true)
      expect(asked).toBe(1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await opened
      await closed
      expect(done).toBe(true)
      expect(s.native.pauseProcess).not.toHaveBeenCalled()
      expect(overlay.state()).toEqual({ open: false })
      expect(s.wins[0]!.visible).toBe(false)
      expect(s.native.focus).toHaveBeenLastCalledWith('500')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the running programs while the overlay takes the foreground', async () => {
    const s = setup()
    s.deps.pauseGame = () => true
    const order: string[] = []
    s.deps.runningImages = async () => {
      order.push('list')
      return new Set(['game.exe'])
    }
    s.native.focus.mockImplementation(async () => {
      order.push('focus')
      return true
    })
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    expect(order).toEqual(['list', 'focus'])
    expect(s.native.pauseProcess).toHaveBeenCalledWith(7, true)
    await overlay.close()
  })

  it('resumes a paused program on quit (releasePause) and keeps the state when pausing is refused', async () => {
    const s = setup()
    s.deps.pauseGame = () => true
    s.native.pauseProcess.mockImplementationOnce(async () => ({ ok: false, error: 'access' }))
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    expect(overlay.state().paused).toBeUndefined()
    await overlay.close()

    const t = setup()
    t.deps.pauseGame = () => true
    const o2 = createOverlayWindow(t.deps)
    await o2.open()
    await o2.releasePause()
    expect(t.native.pauseProcess).toHaveBeenLastCalledWith(7, false, 1234)
  })

  it('resumes the game when the overlay window is closed from outside (Alt+F4)', async () => {
    const s = setup()
    const saved: unknown[] = []
    s.deps.pauseGame = () => true
    s.deps.pausedStore = { save: async (r) => void saved.push(r) }
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    s.wins[0]!.destroy()
    await overlay.releasePause() // queued after the resume the close started
    const resumes = s.native.pauseProcess.mock.calls.filter((c) => c[1] === false)
    expect(resumes).toEqual([[7, false, 1234]])
    expect(saved.at(-1)).toBeNull()
  })

  it('keeps the record when a resume is not answered, and tries again before pausing anything else', async () => {
    const s = setup()
    const saved: unknown[] = []
    s.deps.pauseGame = () => true
    s.deps.pausedStore = { save: async (r) => void saved.push(r) }
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    const timeout = async (): Promise<{ ok: boolean; error: string }> => ({
      ok: false,
      error: 'timeout'
    })
    s.native.pauseProcess.mockImplementationOnce(timeout).mockImplementationOnce(timeout)
    await overlay.close()
    expect(saved.at(-1)).toEqual({ pid: 7, created: 1234, program: 'Game.exe' })

    // The next open resumes it first, then pauses again: never suspended twice.
    await overlay.open()
    const calls = s.native.pauseProcess.mock.calls.map((c) => c[1])
    expect(calls).toEqual([true, false, false, false, true])
    await overlay.close()
    expect(saved.at(-1)).toBeNull()
  })

  it('takes over a pause left by the last run and never pauses another over it', async () => {
    const s = setup()
    const saved: unknown[] = []
    s.deps.pauseGame = () => true
    s.deps.pausedStore = { save: async (r) => void saved.push(r) }
    const overlay = createOverlayWindow(s.deps)
    s.native.pauseProcess.mockImplementation(async (_pid: number, pause: boolean) =>
      pause ? { ok: true, created: 1234 } : { ok: false, error: 'timeout' }
    )
    await overlay.adoptPaused({ pid: 99, created: 5, program: 'Old.exe' })
    await overlay.open()
    // The leftover is tried again first, still unanswered: nothing new is paused over it.
    expect(s.native.pauseProcess.mock.calls).toEqual([
      [99, false, 5],
      [99, false, 5]
    ])
    expect(saved).toEqual([])
    s.native.pauseProcess.mockImplementation(async () => ({ ok: true, created: 5 }))
    await overlay.close()
    expect(s.native.pauseProcess).toHaveBeenLastCalledWith(99, false, 5)
    expect(saved.at(-1)).toBeNull()
    overlay.dispose()
  })

  it('tries a resume once more on close when the first try was not answered', async () => {
    const s = setup()
    s.deps.pauseGame = () => true
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    s.native.pauseProcess.mockImplementationOnce(async () => ({ ok: false, error: 'timeout' }))
    await overlay.close()
    expect(s.native.pauseProcess.mock.calls.map((c) => c[1])).toEqual([true, false, false])
    expect(overlay.state()).toEqual({ open: false })
  })

  it('drops the record when the paused process is gone', async () => {
    const s = setup()
    const saved: unknown[] = []
    s.deps.pauseGame = () => true
    s.deps.pausedStore = { save: async (r) => void saved.push(r) }
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    s.native.pauseProcess.mockImplementationOnce(async () => ({ ok: false, error: 'gone' }))
    await overlay.close()
    expect(saved.at(-1)).toBeNull()
    await overlay.releasePause()
    expect(s.native.pauseProcess.mock.calls.filter((c) => c[1] === false)).toHaveLength(1)
  })
})

describe('createOverlayWindow with the in-game overlay', () => {
  function withIngame(
    fg: ForegroundWindow,
    inside: boolean
  ): ReturnType<typeof setup> & {
    ingame: { tryOpen: Fn; close: Fn; active: Fn; shown: boolean }
    overlay: ReturnType<typeof createOverlayWindow>
  } {
    const s = setup(fg)
    const ingame = {
      shown: false,
      tryOpen: vi.fn(async () => {
        ingame.shown = inside
        return inside
      }),
      close: vi.fn(async () => {
        ingame.shown = false
      }),
      active: vi.fn(() => ingame.shown)
    }
    s.deps.ingame = ingame as never
    return { ...s, ingame, overlay: createOverlayWindow(s.deps) }
  }

  it('opens inside an exclusive game: no window shown, no focus, no pause', async () => {
    const s = withIngame(game({ exclusive: true }), true)
    s.deps.pauseGame = () => true
    await s.overlay.open()
    expect(s.ingame.tryOpen).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 7, hwnd: '500', exclusive: true }),
      expect.objectContaining({ exe: game().exe }),
      { hold: true }
    )
    const w = s.wins[0]!
    expect(w.show).not.toHaveBeenCalled()
    expect(w.showInactive).not.toHaveBeenCalled()
    expect(w.setBounds).not.toHaveBeenCalled()
    expect(s.native.focus).not.toHaveBeenCalled()
    expect(s.native.pauseProcess).not.toHaveBeenCalled()
    expect(s.overlay.state()).toEqual({
      open: true,
      program: 'Game.exe',
      ingame: true,
      paused: true
    })
    expect(s.emitted.at(-1)).toEqual({
      open: true,
      program: 'Game.exe',
      ingame: true,
      paused: true
    })

    // A second open while shown inside does nothing; toggle closes.
    await s.overlay.open()
    expect(s.ingame.tryOpen).toHaveBeenCalledTimes(1)
    await s.overlay.toggle()
    expect(s.ingame.close).toHaveBeenCalledTimes(1)
    expect(s.overlay.state()).toEqual({ open: false })
    expect(s.native.restore).not.toHaveBeenCalled()
    expect(s.native.focus).not.toHaveBeenCalled()
    expect(s.native.pauseProcess).not.toHaveBeenCalled()
  })

  it('asks for no hold when Pause the game is off, or the game runs under anti-cheat', async () => {
    const off = withIngame(game({ exclusive: true }), true)
    off.deps.pauseGame = () => false
    await off.overlay.open()
    expect(off.ingame.tryOpen).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
      hold: false
    })
    expect(off.overlay.state()).toEqual({ open: true, program: 'Game.exe', ingame: true })

    const guarded = withIngame(game({ exclusive: true }), true)
    guarded.deps.pauseGame = () => true
    guarded.deps.runningImages = async () => new Set(['easyanticheat.exe'])
    await guarded.overlay.open()
    expect(guarded.ingame.tryOpen).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
      hold: false
    })
  })

  it('opens the window overlay exactly as before when the in-game overlay says no', async () => {
    const s = withIngame(game({ exclusive: true }), false)
    s.deps.pauseGame = () => true
    await s.overlay.open()
    expect(s.ingame.tryOpen).toHaveBeenCalledTimes(1)
    const w = s.wins[0]!
    expect(w.showInactive).toHaveBeenCalled()
    expect(s.native.pauseProcess).toHaveBeenCalledWith(7, true)
    await s.overlay.close()
    expect(s.ingame.close).not.toHaveBeenCalled()
    expect(s.native.pauseProcess).toHaveBeenLastCalledWith(7, false, 1234)
  })

  it('opens the window overlay when the in-game overlay throws', async () => {
    const s = withIngame(game({ exclusive: true }), false)
    s.ingame.tryOpen.mockImplementation(async () => {
      throw new Error('boom')
    })
    await s.overlay.open()
    expect(s.wins[0]!.showInactive).toHaveBeenCalled()
    expect(s.overlay.state().open).toBe(true)
  })

  it('is never tried over a windowed game or nothing', async () => {
    const s = withIngame(game({ exclusive: false }), true)
    await s.overlay.open()
    expect(s.ingame.tryOpen).not.toHaveBeenCalled()
    expect(s.wins[0]!.show).toHaveBeenCalled()
    const none = withIngame(null as unknown as ForegroundWindow, true)
    await none.overlay.open()
    expect(none.ingame.tryOpen).not.toHaveBeenCalled()
  })

  it('closes cleanly when the in-game overlay already ended by itself', async () => {
    const s = withIngame(game({ exclusive: true }), true)
    await s.overlay.open()
    s.ingame.shown = false
    await s.overlay.close({ refocus: true })
    expect(s.ingame.close).not.toHaveBeenCalled()
    expect(s.overlay.state()).toEqual({ open: false })
    expect(s.native.focus).not.toHaveBeenCalled()
  })
})

describe('whileRunning (the PeerParty invite)', () => {
  it('lets the paused game run for the work, then pauses it again while the overlay stays open', async () => {
    const s = setup()
    const saved: unknown[] = []
    s.deps.pauseGame = () => true
    s.deps.pausedStore = { save: async (r) => void saved.push(r) }
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    s.native.pauseProcess.mockClear()
    const order: string[] = []
    s.native.pauseProcess.mockImplementation(async (_pid: number, pause: boolean) => {
      order.push(pause ? 'pause' : 'resume')
      return { ok: true, created: 1234 }
    })
    const answer = await overlay.whileRunning(async () => {
      order.push('work')
      return 'sent'
    })
    expect(answer).toBe('sent')
    expect(order).toEqual(['resume', 'work', 'pause'])
    expect(s.native.pauseProcess).toHaveBeenNthCalledWith(1, 7, false, 1234)
    expect(overlay.state()).toMatchObject({ open: true, paused: true })
    // Closing resumes it as before.
    await overlay.close()
    expect(s.native.pauseProcess).toHaveBeenLastCalledWith(7, false, 1234)
    expect(saved.at(-1)).toBeNull()
  })

  it('leaves the game running when it cannot be paused again', async () => {
    const s = setup()
    const saved: unknown[] = []
    s.deps.pauseGame = () => true
    s.deps.pausedStore = { save: async (r) => void saved.push(r) }
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    s.native.pauseProcess.mockImplementation(async (_pid: number, pause: boolean) =>
      pause ? { ok: false, error: 'gone' } : { ok: true, created: 1234 }
    )
    expect(await overlay.whileRunning(async () => 1)).toBe(1)
    expect(overlay.state()).toMatchObject({ open: true, paused: false })
    expect(saved.at(-1)).toBeNull()
    s.native.pauseProcess.mockClear()
    await overlay.close()
    // Nothing left to resume.
    expect(s.native.pauseProcess).not.toHaveBeenCalled()
  })

  it('just runs the work when nothing is paused', async () => {
    const s = setup()
    const overlay = createOverlayWindow(s.deps)
    await overlay.open()
    expect(await overlay.whileRunning(async () => 'x')).toBe('x')
    expect(s.native.pauseProcess).not.toHaveBeenCalled()
  })
})
