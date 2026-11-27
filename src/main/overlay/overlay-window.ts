import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import type { OverlayState } from '../../shared/overlay'
import type { Logger } from '../logger'
import type { NativeOps } from '../native-host/native-ops'
import { isAppUrl } from '../util/app-origin'
import {
  antiCheatRunning,
  CLOSED_STATE,
  openedState,
  overlayBounds,
  overlayTarget,
  pausable,
  resumeSettled,
  sameState,
  type ForegroundWindow,
  type OverlayScreen,
  type OverlayTarget,
  type Rect
} from './overlay-logic'

/**
 * The overlay window (docs/home-overlay.md, "Overlay window behaviour"): a second, transparent, always-on-top
 * BrowserWindow that loads the same index.html with ?overlay=1. It is created hidden so the home button opens it
 * without delay, covers the foreground game's monitor and takes the foreground; on close the game gets it back.
 */

/**
 * The native host calls the overlay uses (src/main/native-host/native-ops.ts). Type-only, so this module does not
 * load the host; the lead passes the real functions.
 */
export interface OverlayNative extends Pick<
  NativeOps,
  'foreground' | 'focus' | 'restore' | 'pauseProcess'
> {
  /** A BrowserWindow's native handle in the same string form as `foreground().hwnd` (native-ops' hwndOf). */
  hwndOf(buffer: Buffer): string
}

/** The part of a BrowserWindow the overlay drives (a fake in tests). */
export interface OverlayWin {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  hide(): void
  focus(): void
  destroy(): void
  setBounds(bounds: Partial<Rect>): void
  getBounds(): Rect
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void
  /** Show without activating (the game keeps the foreground). */
  showInactive(): void
  /** False: clicks never activate the window (WS_EX_NOACTIVATE). */
  setFocusable(focusable: boolean): void
  setSkipTaskbar(skip: boolean): void
  getNativeWindowHandle(): Buffer
  on(event: 'closed', listener: () => void): unknown
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
    on(
      event: 'will-navigate' | 'will-redirect',
      listener: (event: { preventDefault(): void }, url: string) => void
    ): unknown
  }
}

/**
 * Electron's `screen` as the overlay window uses it: the bounds lookups, and the display change events that re-fit an
 * open overlay (a resolution change, a monitor unplugged). The events are optional so a bare fake still works.
 */
export interface OverlayWindowScreen extends OverlayScreen {
  on?(event: 'display-metrics-changed', listener: () => void): unknown
  on?(event: 'display-removed', listener: () => void): unknown
  removeListener?(event: 'display-metrics-changed', listener: () => void): unknown
  removeListener?(event: 'display-removed', listener: () => void): unknown
}

/**
 * How long after an open over an exclusive full-screen game the bounds are read again, when the game minimized anyway
 * (see EXCLUSIVE_PAUSE_DELAY_MS): Windows then switches the monitor back to the desktop mode.
 */
export const EXCLUSIVE_REFIT_MS = 600

/**
 * The overlay opens over an exclusive full-screen game without taking the foreground (shown inactive), so a game that
 * Windows composes (fullscreen optimizations) keeps it and does not minimize. A game in true exclusive mode (Spelunky 2
 * set to Fullscreen: any window over it, active or not, makes it drop out) still loses the foreground and minimizes:
 * this long after opening, the overlay looks whether the game still has it. If not, the overlay takes the foreground (so it can be used) and the game is paused only
 * then, or it would stay frozen over the screen; it is restored on close.
 */
export const EXCLUSIVE_PAUSE_DELAY_MS = 500
/**
 * How long opening waits for the list of running programs (the anti-cheat check) before giving up on the pause. Open
 * and close run one at a time, so a list that hangs must not keep the overlay from being closed.
 */
export const PAUSE_CHECK_MS = 2000
/** A resume the native host did not answer is retried this often, this many times. */
const RESUME_RETRY_MS = 3000
const RESUME_RETRIES = 10

/** A paused program, kept on disk so a crash or a forced quit never leaves it frozen (resumed at the next start). */
export interface PausedRecord {
  pid: number
  /** Its start time (ms since 1601), so a PID reused since is never resumed by mistake. */
  created: number
  program: string
}

/**
 * The in-game overlay (ingame/session.ts): over a game in true exclusive full screen the overlay is drawn inside the
 * game instead of as a window, which would make the game minimize.
 */
export interface OverlayIngame {
  /** True when the overlay is now shown inside the game; false: the window overlay opens as before. */
  tryOpen(target: OverlayTarget, fg: ForegroundWindow, options: { hold: boolean }): Promise<boolean>
  close(): Promise<void>
  active(): boolean
}

export interface OverlayWindowDeps {
  log: Logger
  /** The preload script (the same one the main window uses). */
  preload: string
  /** Load index.html?overlay=1 into the window (the same file as the main window: isAppUrl ignores the query). */
  load: (win: BrowserWindow) => Promise<void>
  native: OverlayNative
  /** Electron's screen (injectable for tests). */
  screen: OverlayWindowScreen
  events: { emit(event: 'overlay:state', payload: OverlayState): void }
  /** Pause the program the overlay opens over (Settings › Controls). */
  pauseGame?: () => boolean
  /**
   * Lower-case image names of the running processes, or null when unknown. A program is paused only when they are
   * known and no anti-cheat service is among them (as Enhanced Sleep/Wake: a suspended game could be flagged).
   */
  runningImages: () => Promise<Set<string> | null>
  /**
   * Why the program under the overlay must not be paused even without an anti-cheat service running (a competitive
   * online game: Filters > Online Multiplayer > All Competitive), or null.
   */
  pauseBlockedBy?: (target: { program: string; exe: string | null }) => string | null
  /** Where the paused program is recorded (null: none paused). */
  pausedStore?: {
    save(record: PausedRecord | null): Promise<void>
  }
  /** Tests. */
  sleep?: (ms: number) => Promise<void>
  /** This process's PID (tests). */
  ownPid?: number
  /** The PlayOut game running now, if any. */
  running: () => { gameId: string } | null
  /** Is this handle one of PlayOut's own windows (main or overlay)? */
  isPlayOutWindow: (hwnd: string) => boolean
  /** Window factory (tests pass a fake). Defaults to `new BrowserWindow(options)`. */
  createWindow?: (options: BrowserWindowConstructorOptions) => OverlayWin
  /** The in-game overlay, tried first over an exclusive full-screen game. */
  ingame?: OverlayIngame
}

export interface CloseOptions {
  /**
   * Give the foreground back to the window the overlay opened over (default true). "PlayOut" and "Quit game" pass
   * false: the main window is brought up instead, or the game is gone.
   */
  refocus?: boolean
}

export interface OverlayWindow {
  /** Create the hidden window (and start loading it) if it does not exist. */
  create(): void
  open(): Promise<void>
  close(options?: CloseOptions): Promise<void>
  toggle(): Promise<void>
  state(): OverlayState
  window(): BrowserWindow | null
  /** Resume a program the overlay paused (quitting PlayOut), leaving the overlay as it is. */
  releasePause(): Promise<void>
  /** Take over a pause the last run left behind (paused.json) and resume it, retrying like its own pauses. */
  adoptPaused(record: PausedRecord): Promise<void>
  /**
   * Run `work` with the program the overlay paused running again, then pause it again if the overlay is still open
   * (the overlay's PeerParty invite: the game's own thread must answer it). Without a pause it just runs `work`.
   * Queued with open and close; `work` must not throw.
   */
  whileRunning<T>(work: () => Promise<T>): Promise<T>
  /** The overlay's own native handle, or null before it exists (for isPlayOutWindow). */
  hwnd(): string | null
  /** The monitor (`\\.\DISPLAYn`) the overlay last opened on, for the display controls; null before the first open. */
  monitor(): string | null
  dispose(): void
}

export function overlayWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    autoHideMenuBar: true,
    title: 'PlayOut overlay',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The music player lives in this renderer and must keep playing while the overlay is hidden.
      backgroundThrottling: false
    }
  }
}

export function createOverlayWindow(deps: OverlayWindowDeps): OverlayWindow {
  const { log, native } = deps
  const makeWindow =
    deps.createWindow ?? ((options) => new BrowserWindow(options) as unknown as OverlayWin)

  let win: OverlayWin | null = null
  let loaded: Promise<void> = Promise.resolve()
  let current: OverlayState = CLOSED_STATE
  let target: OverlayTarget | null = null
  /** The overlay took the foreground on this open (no game under it, or a game that lost it anyway). */
  let tookForeground = false
  let lastMonitor: string | null = null
  /** This open is drawn inside the game (the window stays hidden). */
  let ingameOpen = false
  /** The program paused while the overlay is open (resumed on close, or at the next start after a crash). */
  let paused: PausedRecord | null = null
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const ownPid = deps.ownPid ?? process.pid
  let disposed = false
  // Open and close run one at a time: a double press of the home button (or a press while the renderer asks to
  // close) must not interleave two focus dances.
  let chain: Promise<void> = Promise.resolve()
  let refitTimer: ReturnType<typeof setTimeout> | null = null

  const alive = (): OverlayWin | null => (win && !win.isDestroyed() ? win : null)

  /**
   * While the overlay is open, cover the whole of the display it is on now. The display's mode may have changed under
   * it (an exclusive game's mode going away when the game minimizes, a resolution change, a monitor unplugged:
   * getDisplayMatching then picks the nearest remaining display).
   */
  const refit = (): void => {
    const w = alive()
    if (disposed || !w || !current.open || !w.isVisible()) return
    try {
      const now = w.getBounds()
      const bounds = deps.screen.getDisplayMatching(now).bounds
      if (
        bounds.x === now.x &&
        bounds.y === now.y &&
        bounds.width === now.width &&
        bounds.height === now.height
      ) {
        return
      }
      w.setBounds(bounds)
      log.info(`overlay re-fitted to ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}`)
    } catch (err) {
      log.warn('overlay: re-fit failed', err)
    }
  }

  const clearRefit = (): void => {
    if (refitTimer) clearTimeout(refitTimer)
    refitTimer = null
  }

  const onDisplayChange = (): void => refit()
  try {
    deps.screen.on?.('display-metrics-changed', onDisplayChange)
    deps.screen.on?.('display-removed', onDisplayChange)
  } catch (err) {
    log.warn('overlay: display events unavailable', err)
  }

  const setState = (next: OverlayState): void => {
    if (sameState(current, next)) return
    current = next
    try {
      deps.events.emit('overlay:state', next)
    } catch (err) {
      log.warn('overlay state broadcast failed', err)
    }
  }

  const ownHwnd = (): string | null => {
    const w = alive()
    if (!w) return null
    try {
      return native.hwndOf(w.getNativeWindowHandle())
    } catch {
      return null
    }
  }

  const create = (): void => {
    if (disposed || alive()) return
    const w = makeWindow(overlayWindowOptions(deps.preload))
    win = w
    w.on('closed', () => {
      // Closed from outside (Alt+F4 while it had focus): the next open creates a new one.
      if (win === w) win = null
      target = null
      clearRefit()
      setState(CLOSED_STATE)
      // The game paused under it runs again (queued after an open still in progress, which may have paused it).
      void serialize(async () => {
        await resumePaused()
        if (paused && !current.open) scheduleResumeRetry()
      })
    })
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // Same guard as the main window: this document may only ever be the app entry.
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (isAppUrl(url)) return
      event.preventDefault()
      log.warn(`overlay: blocked navigation to ${url}`)
    }
    w.webContents.on('will-navigate', guard)
    w.webContents.on('will-redirect', guard)
    loaded = deps.load(w as unknown as BrowserWindow).catch((err) => {
      log.error('overlay: load failed', err)
    })
    log.info('overlay window created')
  }

  const doOpen = async (): Promise<void> => {
    if (disposed || (current.open && (ingameOpen || alive()?.isVisible()))) return
    create()
    await loaded
    const w = alive()
    if (!w) return

    const fg = await native.foreground().catch((err) => {
      log.warn('overlay: foreground lookup failed', err)
      return null
    })
    const own = ownHwnd()
    if (fg?.monitor?.device) lastMonitor = fg.monitor.device
    target = overlayTarget(fg, own, deps.isPlayOutWindow)

    // Over a game in true exclusive full screen the overlay is drawn inside the game when it may be (ingame/gate.ts):
    // no window is shown, the game keeps the foreground and is never suspended ("Pause the game" holds it on its last
    // frame instead). Anything else, or any failure, opens the window overlay below.
    if (target?.exclusive && fg && deps.ingame) {
      const t = target
      const hold =
        !!deps.pauseGame?.() && pausable(t, ownPid) && (await pauseAllowed(t, fg.exe || null))
      const inside = await deps.ingame.tryOpen(t, fg, { hold }).catch((err) => {
        log.warn('overlay: in-game overlay failed', err)
        return false
      })
      if (inside) {
        ingameOpen = true
        tookForeground = false
        log.info(`overlay opened inside ${t.program} (${t.hwnd}${hold ? ', held' : ''})`)
        setState({
          ...openedState(t, deps.running()),
          ingame: true,
          ...(hold ? { paused: true } : {})
        })
        return
      }
    }

    const bounds = overlayBounds(deps.screen, fg)
    // The anti-cheat check starts now, so the list of running programs is read while the overlay takes the foreground.
    const mayPause =
      deps.pauseGame?.() && pausable(target, ownPid) && target
        ? pauseAllowed(target, fg?.exe || null)
        : null

    // Over an exclusive full-screen game the overlay never takes the foreground: the game would minimize. The overlay is
    // driven by the controller, which reaches it without focus (main reads the Home button, the renderer the pad).
    // Over anything else (a windowed or borderless game, the desktop, Steam, PlayOut) it takes the foreground as always:
    // the program under it then stops reading the pad and the keyboard reaches the overlay.
    const inactive = !!target?.exclusive
    tookForeground = false
    setFocusable(w, !inactive)
    w.setBounds(bounds)
    // Windows can drop the topmost flag while hidden, so it is set on every open.
    w.setAlwaysOnTop(true, 'screen-saver')
    if (inactive) w.showInactive()
    else w.show()
    // A move across monitors with different scaling can resize the window on show; set the bounds again.
    w.setBounds(bounds)
    if (!inactive) await takeForeground(own)

    log.info(
      `overlay opened over ${target ? `${target.program} (${target.hwnd}${target.exclusive ? ', exclusive' : ''})` : 'PlayOut/nothing'}`
    )
    setState(openedState(target, deps.running()))

    // A game in true exclusive mode may have minimized anyway: then the overlay takes the foreground (see
    // EXCLUSIVE_PAUSE_DELAY_MS). The anti-cheat check for the pause goes on meanwhile.
    if (target?.exclusive) {
      const t = target
      await sleep(EXCLUSIVE_PAUSE_DELAY_MS)
      const front = await native.foreground().catch(() => null)
      if (current.open && alive() && target === t && front && front.hwnd !== t.hwnd) {
        log.info(`overlay: ${t.program} lost the foreground anyway; the overlay takes it`)
        const now = alive()
        if (now) setFocusable(now, true)
        await takeForeground(ownHwnd())
      }
    }

    // Pause the program under the overlay, so it takes no input (the controller reaches every program).
    // A program still paused (an earlier resume failed) runs again first, so no process is ever suspended twice.
    await resumePaused()
    if (mayPause && target && !paused) {
      const t = target
      const allowed = await mayPause
      if (allowed && current.open && alive()) {
        const result = await native.pauseProcess(t.pid, true)
        if (result.ok && result.created) {
          paused = { pid: t.pid, created: result.created, program: t.program }
          await deps.pausedStore
            ?.save(paused)
            .catch((err) => log.warn('overlay: pause record not saved', err))
          setState({ ...current, paused: true })
          log.info(`overlay: paused ${t.program} (${t.pid})`)
        } else {
          log.info(`overlay: ${t.program} could not be paused (${result.error ?? 'unknown'})`)
        }
      }
    }

    clearRefit()
    if (target?.exclusive && tookForeground) {
      refitTimer = setTimeout(() => {
        refitTimer = null
        refit()
      }, EXCLUSIVE_REFIT_MS)
      refitTimer.unref?.()
    }
  }

  /**
   * Electron's setFocusable also shows the window on the taskbar again when it turns focusable (Windows), so the
   * overlay is taken off it each time.
   */
  function setFocusable(w: OverlayWin, focusable: boolean): void {
    w.setFocusable(focusable)
    w.setSkipTaskbar(true)
  }

  /** Bring the overlay to the foreground (natively, else Electron's focus). */
  async function takeForeground(own: string | null): Promise<void> {
    tookForeground = true
    let focused = false
    if (own) {
      focused = await native.focus(own).catch((err) => {
        log.warn('overlay: native focus failed', err)
        return false
      })
    }
    if (!focused) alive()?.focus()
  }

  const doClose = async (options: CloseOptions = {}): Promise<void> => {
    if (ingameOpen) {
      // The game never lost the foreground: nothing to hide, resume, restore or refocus.
      ingameOpen = false
      if (deps.ingame?.active()) {
        await deps.ingame.close().catch((err) => log.warn('overlay: in-game close failed', err))
      }
      target = null
      setState(CLOSED_STATE)
      return
    }
    const w = alive()
    if (!current.open && !w?.isVisible()) return
    clearRefit()
    // The game runs again before it gets the foreground back (once more if the host restarted on the first try).
    await resumePaused()
    if (paused) await resumePaused()
    if (paused) scheduleResumeRetry()
    w?.hide()
    const back = target
    const hadForeground = tookForeground
    target = null
    tookForeground = false
    setState(CLOSED_STATE)
    if (!back || options.refocus === false) return
    if (!hadForeground) {
      // The game kept the foreground while the overlay was open: nothing to give back, unless an exclusive game lost it
      // after the check on open (it then minimized): restored like below.
      if (!back.exclusive) return
      const fg = await native.foreground().catch(() => null)
      if (fg?.hwnd === back.hwnd) return
      log.info(
        `overlay: ${back.program} lost the foreground while the overlay was open; restoring it`
      )
    }
    // An exclusive game minimized when it lost the foreground: restore it first (the host only un-minimizes a
    // minimized window, so a maximized windowed game is never touched), then make sure it has the foreground.
    if (back.exclusive) {
      await native.restore(back.hwnd).catch((err) => log.warn('overlay: restore failed', err))
    }
    const ok = await native.focus(back.hwnd).catch((err) => {
      log.warn('overlay: refocus failed', err)
      return false
    })
    if (!ok) log.warn(`overlay: could not give the foreground back to ${back.program}`)
  }

  /**
   * A game running under an anti-cheat service is never suspended (it could be flagged or kicked): the overlay opens
   * over it without pausing it. Running programs that cannot be read count as one, as for Enhanced Sleep/Wake, and so
   * does a list that takes longer than PAUSE_CHECK_MS: the game then stays unpaused rather than the overlay waiting.
   * Never rejects.
   */
  /** `exe`: the full path of the program under the overlay, when known. */
  async function pauseAllowed(t: OverlayTarget, exe: string | null): Promise<boolean> {
    let blocked: string | null
    try {
      blocked = deps.pauseBlockedBy?.({ program: t.program, exe }) ?? null
    } catch (err) {
      // Unknown: not paused, as when the running programs cannot be read.
      log.warn('overlay: competitive check failed', err)
      return false
    }
    if (blocked) {
      log.info(`overlay: ${t.program} not paused (${blocked})`)
      return false
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), PAUSE_CHECK_MS)
    })
    // Asked for right away (a throw becomes a rejection).
    const list = (async () => deps.runningImages())().catch((err) => {
      log.warn('overlay: running programs could not be read', err)
      return null
    })
    const images = await Promise.race([list, late])
    if (timer) clearTimeout(timer)
    if (images === 'late') {
      log.warn(
        `overlay: running programs not read in ${PAUSE_CHECK_MS} ms; ${t.program} not paused`
      )
      return false
    }
    if (!images) {
      log.info(`overlay: running programs unknown; ${t.program} not paused`)
      return false
    }
    const guard = antiCheatRunning(images)
    if (guard) log.info(`overlay: ${t.program} runs with anti-cheat (${guard}); not paused`)
    return !guard
  }

  /** A resume the host did not answer is tried again in the background until it settles (or the next open). */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retries = 0
  function scheduleResumeRetry(): void {
    if (retryTimer || retries >= RESUME_RETRIES) return
    retries++
    retryTimer = setTimeout(() => {
      retryTimer = null
      void serialize(async () => {
        await resumePaused()
        if (paused && !current.open) scheduleResumeRetry()
      })
    }, RESUME_RETRY_MS)
    retryTimer.unref?.()
  }

  async function resumePaused(): Promise<void> {
    const p = paused
    if (!p) return
    const result = await native.pauseProcess(p.pid, false, p.created)
    if (!resumeSettled(result)) {
      // The host did not answer (timeout, restart): the record stays, so the next close, quit or start tries again.
      log.warn(
        `overlay: ${p.program} (${p.pid}) could not be resumed: ${result.error ?? 'unknown'}; will retry`
      )
      return
    }
    paused = null
    retries = 0
    log.info(
      `overlay: ${result.ok ? 'resumed' : `no longer needs resuming (${result.error})`} ${p.program} (${p.pid})`
    )
    await deps.pausedStore
      ?.save(null)
      .catch((err) => log.warn('overlay: pause record not cleared', err))
  }

  /**
   * After whileRunning: the program is paused again while the overlay stays open over it; otherwise (closed meanwhile,
   * or the pause refused) it is left running and its record cleared.
   */
  async function pauseAgain(p: PausedRecord): Promise<void> {
    const result =
      current.open && !disposed && paused === p
        ? await native.pauseProcess(p.pid, true)
        : { ok: false, error: 'the overlay is no longer open' }
    if (result.ok && result.created) {
      paused = { ...p, created: result.created }
      if (result.created !== p.created)
        await deps.pausedStore
          ?.save(paused)
          .catch((err) => log.warn('overlay: pause record not saved', err))
      return
    }
    log.info(`overlay: ${p.program} left running (${result.error ?? 'unknown'})`)
    if (paused === p) paused = null
    await deps.pausedStore
      ?.save(null)
      .catch((err) => log.warn('overlay: pause record not cleared', err))
    if (current.open) setState({ ...current, paused: false })
  }

  const serialize = (op: () => Promise<void>): Promise<void> => {
    const next = chain.then(op).catch((err) => log.error('overlay operation failed', err))
    chain = next
    return next
  }

  return {
    create,
    open: () => serialize(doOpen),
    close: (options) => serialize(() => doClose(options)),
    toggle: () => serialize(() => (current.open ? doClose() : doOpen())),
    releasePause: () => serialize(resumePaused),
    adoptPaused: (record) =>
      serialize(async () => {
        if (!paused) paused = record
        await resumePaused()
        if (paused && !current.open) scheduleResumeRetry()
      }),
    whileRunning<T>(work: () => Promise<T>): Promise<T> {
      let out: { value: T } | null = null
      return serialize(async () => {
        const p = paused
        if (!p || disposed) {
          out = { value: await work() }
          return
        }
        const resumed = await native.pauseProcess(p.pid, false, p.created)
        if (!resumed.ok)
          log.warn(`overlay: ${p.program} could not run for a moment: ${resumed.error}`)
        try {
          out = { value: await work() }
        } finally {
          if (resumed.ok) await pauseAgain(p)
        }
      }).then(() => {
        // serialize logs and swallows a throw; `work` does not throw, so this is only a guard.
        if (!out) throw new Error('overlay: the work did not finish')
        return out.value
      })
    },
    state: () => current,
    window: () => alive() as unknown as BrowserWindow | null,
    hwnd: ownHwnd,
    monitor: () => lastMonitor,
    dispose() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      clearRefit()
      try {
        deps.screen.removeListener?.('display-metrics-changed', onDisplayChange)
        deps.screen.removeListener?.('display-removed', onDisplayChange)
      } catch {
        /* the screen module is gone at quit */
      }
      const w = alive()
      win = null
      target = null
      ingameOpen = false
      current = CLOSED_STATE
      if (w) w.destroy()
    }
  }
}
