import type { BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type {
  DisplayMode,
  DisplayStatus,
  HomeButtonStatus,
  MediaAction,
  MediaSession,
  MusicLibrary,
  OverlayState,
  PadInfo,
  PerformanceStatus,
  PowerChoice
} from '../../shared/overlay'
import type {
  Game,
  GameUserPatch,
  PerfSample,
  PowerMode,
  Settings,
  SettingsPatch,
  SystemStatus
} from '../../shared/types'
import { competitiveUnder } from './competitive'
import type { EventBus } from '../events'
import { createHomeButtonService, type HomeButtonService } from '../home-button/service'
import { createIntelGraphics, type IntelGraphics } from '../intel/intel-graphics'
import type { Logger } from '../logger'
import { createMediaService, type MediaService } from '../media/media-service'
import { createNativeOps, hwndOf, type NativeOps } from '../native-host/native-ops'
import { createPadReader, type PadReader } from '../native-host/pad-reader'
import { sdlDirFor } from '../native-host/sdl'
import { createTouchSwipeWatcher } from '../touch-swipe/watcher'
import { createMemoryService, type MemoryService } from '../performance/memory/service'
import { createPerformanceService, type PerformanceService } from '../performance/service'
import { createRtssService } from '../rtss'
import { createAutoHdr, regCommand } from './auto-hdr'
import { createOverlayExtras, type OverlayExtras } from './extras'
import { createGameExtrasStore } from './game-extras-store'
import { createIngameOverlay, type IngameOverlay } from './ingame/service'
import type { ForegroundWindow } from './overlay-logic'
import {
  createOverlayWindow,
  type OverlayIngame,
  type OverlayWindow,
  type PausedRecord
} from './overlay-window'
import { createPauseOwners } from './pause-owners'
import { tMain } from '../i18n'

/**
 * The home button and everything the overlay controls, put together (docs/home-overlay.md): the controller reader
 * and the native helpers, the home button (with its Steam and Game Bar overrides), the overlay window, power
 * profiles, the display controls and media. index.ts creates it once; the IPC handlers call it.
 */

/** How often the foreground is checked while the in-game overlay is shown. */
export const INGAME_FOREGROUND_POLL_MS = 1000

export interface OverlaySuiteDeps {
  settings: {
    get(): Settings
    /** Deep-merge a patch (the overlay's extra tiles: sync, performance overlay, CPU boost). */
    update(patch: SettingsPatch): Settings
    /** Replace semantics (removing a preset's CPU boost override). */
    mutate?(mutator: (settings: Settings) => void): Settings
    onChange(listener: (settings: Settings) => void): () => void
  }
  library: {
    getGame(id: string): Game | undefined
    /** A game and every game as shown (tag edits applied): the overlay finds a competitive game under it. */
    getGameView?(id: string): Game | undefined
    viewGames?(): Game[]
    games?(): Game[]
    updateGame(id: string, patch: GameUserPatch): unknown
  }
  launcher: {
    running(): { gameId: string; pid?: number } | null
    stop(gameId: string): Promise<boolean>
    /** The running game's live processes (Dynamic TDP measures their frame rate). */
    gameProcesses?(): Promise<{ pid: number; name?: string }[]>
    /** Every running process (the memory cleanup decides from it what it may trim). */
    processes?(): Promise<import('../launcher/process-monitor').ProcessInfo[]>
  }
  events: EventBus
  log: (name: string) => Logger
  userData: string
  /** Folders that may hold an x64 SDL2.dll (PlayOut's Ryujinx), for PlayStation and Switch controllers. */
  sdlCandidates: () => string[]
  preload: string
  /**
   * Load index.html?overlay=1 into the overlay window; `extraQuery` adds to the query (the in-game overlay's offscreen
   * window: ingame=1).
   */
  loadOverlay: (win: BrowserWindow, extraQuery?: Record<string, string>) => Promise<void>
  /**
   * resources\ingame (unpacked), holding PlayOutIngame64.exe and PlayOutOverlay64.dll: the in-game overlay over games
   * in true exclusive full screen. Absent: the window overlay only.
   */
  ingameDir?: string
  screen: Electron.Screen
  /** Open the on-screen keyboard (Settings › Controls › On-screen keyboard's buttons). */
  showKeyboard?(): void
  /**
   * PlayOut's main window: its native handle, bringing it forward, and whether it is out of sight (minimized, or
   * hidden to the tray by Minimize to tray).
   */
  mainWindow: { hwnd(): string | null; show(): void; outOfSight?(): boolean }
  setPowerMode(mode: PowerMode): Promise<void>
  /** CPU, GPU and memory use and the battery, for the performance overlay drawn by RivaTuner. */
  system: { perf(): Promise<PerfSample>; status(): Promise<SystemStatus> }
  /** PlayOut's own exe name (RivaTuner is told not to hook it); null in development. */
  selfExe: string | null
  /**
   * Lower-case image names of the running processes, or null when unknown: the overlay never pauses a game while an
   * anti-cheat service runs (the same check as Enhanced Sleep/Wake).
   */
  runningImages(): Promise<Set<string> | null>
  /** Tests: the Intel graphics driver settings (default: main/intel, a lazily started PowerShell worker). */
  intel?: IntelGraphics
}

export interface OverlaySuite {
  start(): void
  homeStatus(): HomeButtonStatus
  startCapture(): void
  stopCapture(): void
  open(): Promise<void>
  close(): Promise<void>
  overlayState(): OverlayState
  overlayWindow(): BrowserWindow | null
  /** The in-game overlay's offscreen window (it gets the app's events too), or null before its first use. */
  ingameWindow(): BrowserWindow | null
  showPlayOut(): Promise<void>
  /**
   * Close the overlay before another program's window opens (Steam's chat from the Friends tab): the game is resumed
   * and the foreground is not handed back to it, so the program opening next can come to the front.
   */
  closeForOutsideWindow(): Promise<void>
  /**
   * Run `work` with the game the overlay paused running for that moment, paused again after it while the overlay
   * stays open (the PeerParty tab's invite: the game's own thread answers it). `work` must not throw.
   */
  whileGameRuns<T>(work: () => Promise<T>): Promise<T>
  quitRunningGame(): Promise<boolean>
  performance: PerformanceService
  /** "Free up memory while PlayOut is running" (Settings › System; performance/memory). */
  memory: MemoryService
  /** Remove the power helper, putting every RivaTuner profile PlayOut changed back through it first. */
  removePowerHelper(): Promise<PerformanceStatus>
  display(): Promise<DisplayStatus | null>
  setDisplayMode(mode: DisplayMode): Promise<DisplayStatus | null>
  media: MediaService
  /** The extra tiles: frame limit, sync, performance overlay, Auto HDR, CPU boost, live stats (extras.ts). */
  extras: OverlayExtras
  /** The Intel graphics driver's Endurance Gaming (main/intel; the tile hides on PCs without the driver). */
  intel: IntelGraphics
  mediaSession(): Promise<MediaSession | null>
  mediaControl(action: MediaAction): Promise<MediaSession | null>
  musicLibrary(): Promise<MusicLibrary>
  applyPowerProfile(
    profile: PowerChoice | 'none',
    forGame?: string | null,
    options?: { targetFps?: number }
  ): Promise<PerformanceStatus>
  suspend(): void
  resume(): void
  /** Bring a window to the foreground past Windows' foreground lock (the native host's focus helper). */
  forceForeground(hwnd: string): Promise<boolean>
  /**
   * The window in front, and freezing a process (Enhanced Sleep/Wake). Its freeze and the overlay's pause share one
   * suspend per process (pause-owners.ts).
   */
  native: Pick<NativeOps, 'foreground' | 'pauseProcess'>
  /** One of PlayOut's own windows (the main window, the overlay). */
  isPlayOutWindow(hwnd: string): boolean
  dispose(): Promise<void>
}

export function createOverlaySuite(deps: OverlaySuiteDeps): OverlaySuite {
  const log = deps.log('overlay')
  const native: NativeOps = createNativeOps({ log: deps.log('native') })
  /** Game Bar is closed whenever it starts while the home button keeps it off (Settings › Controls). */
  const closeGameBar = (settings: Settings = deps.settings.get()): boolean =>
    settings.input.homeButtonEnabled && settings.input.homeOverrideGameBar
  const pads: PadReader = createPadReader({
    log: deps.log('pads'),
    sdlDir: () => sdlDirFor(deps.sdlCandidates()),
    closeGameBar: () => closeGameBar()
  })
  // The overlay's pause and Enhanced Sleep/Wake's freeze can want the same game suspended at once.
  const pauses = createPauseOwners(native.pauseProcess)
  const pausedFile = join(deps.userData, 'overlay', 'paused.json')
  const pausedStore = {
    async save(record: PausedRecord | null): Promise<void> {
      if (!record) {
        await fs.rm(pausedFile, { force: true })
        return
      }
      await fs.mkdir(dirname(pausedFile), { recursive: true })
      await fs.writeFile(pausedFile, JSON.stringify(record))
    }
  }

  /**
   * A program left paused by a crash or a forced quit runs again (only that very process: its start time matches).
   * The overlay takes the record over, so it keeps it until the resume settles and never pauses anything over it.
   */
  async function resumeLeftPaused(): Promise<void> {
    let record: PausedRecord | null
    try {
      record = JSON.parse(await fs.readFile(pausedFile, 'utf8')) as PausedRecord
    } catch {
      return
    }
    if (record && Number.isSafeInteger(record.pid) && Number.isSafeInteger(record.created)) {
      log.info(`resuming ${record.program} (${record.pid}), left paused by the last run`)
      await overlay.adoptPaused({
        pid: record.pid,
        created: record.created,
        program: String(record.program ?? '')
      })
      return
    }
    await pausedStore.save(null).catch(() => undefined)
  }

  // Games as the library shows them (tag edits applied), as Filters > Online Multiplayer sees them.
  const shownGame = (id: string): Game | undefined =>
    deps.library.getGameView ? deps.library.getGameView(id) : deps.library.getGame(id)
  const shownGames = (): Game[] => deps.library.viewGames?.() ?? deps.library.games?.() ?? []

  // The in-game overlay (ingame/): over a game in true exclusive full screen the overlay is drawn inside the game.
  const ingame: IngameOverlay | null = deps.ingameDir
    ? createIngameOverlay({
        log: deps.log,
        settings: deps.settings,
        running: () => deps.launcher.running(),
        game: shownGame,
        games: shownGames,
        runningImages: () => deps.runningImages(),
        helperDir: deps.ingameDir,
        preload: deps.preload,
        load: (win) => deps.loadOverlay(win, { ingame: '1' }),
        scaleFactor: (fg) => displayScale(fg),
        pads: { pads: () => pads.pads() },
        // Shown as a toast in the main window (state/ingameNotice.ts).
        notify: (game, message) =>
          deps.events.emit('overlay:ingame-notice', {
            gameId: game.id,
            title: game.title,
            message
          })
      })
    : null

  /** The display scale factor of the monitor the game is on (the in-game overlay renders at it). */
  function displayScale(fg: ForegroundWindow): number {
    try {
      const rect = fg.monitor?.rect ?? fg.rect
      const dip = deps.screen.screenToDipRect ? deps.screen.screenToDipRect(null, rect) : rect
      return deps.screen.getDisplayMatching(dip).scaleFactor || 1
    } catch {
      return 1
    }
  }

  /** While the in-game overlay is shown: it closes when the game loses the foreground (Alt+Tab) or ends. */
  let foregroundTimer: ReturnType<typeof setInterval> | null = null
  const stopForegroundWatch = (): void => {
    if (foregroundTimer) clearInterval(foregroundTimer)
    foregroundTimer = null
  }
  const startForegroundWatch = (): void => {
    stopForegroundWatch()
    foregroundTimer = setInterval(() => {
      if (!ingame?.active()) return stopForegroundWatch()
      const pid = ingame.activePid()
      void native
        .foreground()
        .catch(() => null)
        .then((fg) => {
          if (!fg || !ingame.active() || ingame.activePid() !== pid || fg.pid === pid) return
          log.info(`in-game overlay: the game lost the foreground to ${fg.exe || fg.hwnd}; closing`)
          stopForegroundWatch()
          void overlay.close({ refocus: false })
        })
    }, INGAME_FOREGROUND_POLL_MS)
    foregroundTimer.unref?.()
  }
  const emitPads = (list: PadInfo[]): void => {
    try {
      deps.events.emit('overlay:pad', { pads: list })
    } catch (err) {
      log.warn('overlay: pad broadcast failed', err)
    }
  }
  const ingameForWindow: OverlayIngame | undefined = ingame
    ? {
        async tryOpen(target, fg, options) {
          const ok = await ingame.tryOpen(target, fg, options)
          if (ok) {
            // The in-game page has no focus and cannot read the pads itself: they are sent while it is shown. The
            // first snapshot goes after the 'overlay:state' the open sends (the page forgets its pads on that event).
            setImmediate(() => {
              if (ingame.active()) emitPads(pads.pads())
            })
            startForegroundWatch()
          }
          return ok
        },
        close() {
          stopForegroundWatch()
          return ingame.close()
        },
        active: () => ingame.active()
      }
    : undefined
  ingame?.onEnded(() => {
    stopForegroundWatch()
    void overlay.close({ refocus: false })
  })

  const overlay: OverlayWindow = createOverlayWindow({
    ingame: ingameForWindow,
    log,
    preload: deps.preload,
    load: deps.loadOverlay,
    native: {
      foreground: native.foreground,
      focus: native.focus,
      restore: native.restore,
      pauseProcess: pauses.owner('overlay'),
      hwndOf
    },
    pauseGame: () => deps.settings.get().input.homePauseGame,
    runningImages: () => deps.runningImages(),
    // An All Competitive game is never paused (as one under anti-cheat).
    pauseBlockedBy: (target) => {
      const running = deps.launcher.running()
      return competitiveUnder(target, running ? shownGame(running.gameId) : undefined, shownGames)
    },
    pausedStore,
    screen: deps.screen,
    events: deps.events,
    running: () => deps.launcher.running(),
    isPlayOutWindow: (hwnd) => hwnd === deps.mainWindow.hwnd() || hwnd === overlay.hwnd()
  })

  const home: HomeButtonService = createHomeButtonService({
    settings: deps.settings,
    padReader: pads,
    events: deps.events,
    log: deps.log('home-button'),
    dataDir: join(deps.userData, 'home-button'),
    onHome: () => {
      // No game running and PlayOut minimized or hidden in the tray: the Home button brings PlayOut back instead of
      // opening the overlay. In a game (PlayOut minimizes itself when one starts) it opens the overlay as before.
      if (
        !overlay.state().open &&
        deps.launcher.running() === null &&
        deps.mainWindow.outOfSight?.()
      ) {
        deps.mainWindow.show()
        return
      }
      void overlay.toggle()
    },
    onKeyboard: () => deps.showKeyboard?.(),
    gameRunning: () => deps.launcher.running() !== null
  })

  // A swipe from the left edge of a touchscreen opens the overlay while a game runs (Settings › Controls).
  const touchSwipe = createTouchSwipeWatcher({
    log: deps.log('touch-swipe'),
    onSwipe: () => {
      if (!overlay.state().open) void overlay.open()
    }
  })
  /** A game runs: from the session events, else (before the first one) the launcher. */
  let gameRunning: boolean | null = null
  const syncTouchSwipe = (settings: Settings = deps.settings.get()): void =>
    touchSwipe.set(
      settings.input.touchSwipeOverlay && (gameRunning ?? deps.launcher.running() !== null)
    )

  const performance = createPerformanceService({
    settings: deps.settings,
    library: deps.library,
    launcher: deps.launcher,
    events: deps.events,
    log: deps.log('performance'),
    dataDir: deps.userData,
    setPowerMode: deps.setPowerMode
  })

  const memory = createMemoryService({
    settings: deps.settings,
    events: deps.events,
    log: deps.log('memory'),
    launcher: deps.launcher,
    library: deps.library,
    native,
    helper: () => performance.memoryHelper(),
    systemTier: () => performance.memoryTier(),
    ownNames: deps.selfExe ? [deps.selfExe] : []
  })

  const media = createMediaService({ native, settings: deps.settings, log: deps.log('media') })

  /**
   * The controller reader runs only while the home button is on. The hidden overlay window also hosts the local music
   * player, so it exists while the home button is on or a music folder is chosen. Only a change of those settings acts
   * (the last applied values are kept): any other settings change must not restart a reader that gave up (it would
   * respawn PowerShell on every save). `force` re-applies them anyway (start, and resume after sleep stopped the
   * reader).
   */
  let applied: { home: boolean; window: boolean; gameBar: boolean } | null = null
  const syncEnabled = (settings: Settings = deps.settings.get(), force = false): void => {
    // The reader also runs for the on-screen keyboard's buttons, with the home button off.
    const home = settings.input.homeButtonEnabled || (settings.input.keyboardCombo ?? []).length > 0
    const window = settings.input.homeButtonEnabled || !!settings.music.folder
    const gameBar = closeGameBar(settings)
    const prev = applied
    if (!force && prev && prev.home === home && prev.window === window && prev.gameBar === gameBar)
      return
    applied = { home, window, gameBar }
    if (force || prev?.home !== home || prev?.gameBar !== gameBar) {
      if (!home) pads.stop()
      else {
        // A running reader is started again to pick up whether to close Game Bar.
        if (prev?.home && prev.gameBar !== gameBar) pads.stop()
        pads.start()
      }
    }
    if (window) overlay.create()
  }

  /** The overlay's monitor, or the one the foreground window is on before the overlay first opened. */
  const monitorDevice = async (): Promise<string | null> => {
    const known = overlay.monitor()
    if (known) return known
    const fg = await native.foreground().catch(() => null)
    return fg?.monitor?.device ?? null
  }

  const display = async (): Promise<DisplayStatus | null> => {
    const device = await monitorDevice()
    if (!device) return null
    const modes = await native.displayModes(device).catch((err) => {
      log.warn('display modes could not be read', err)
      return null
    })
    return modes ? { name: device, current: modes.current, modes: modes.modes } : null
  }

  const rtss = createRtssService({
    native,
    helper: () => performance.rtssHelper(),
    log: deps.log('rtss')
  })
  const extras: OverlayExtras = createOverlayExtras({
    settings: deps.settings,
    events: deps.events,
    log: deps.log('overlay-extras'),
    launcher: deps.launcher,
    overlay: { state: () => overlay.state() },
    performance,
    rtss,
    display,
    hdrState: (device) => native.hdrState(device),
    autoHdr: createAutoHdr({ run: regCommand }),
    store: createGameExtrasStore(join(deps.userData, 'overlay', 'game-extras.json')),
    system: deps.system,
    selfExe: deps.selfExe
  })

  const intel: IntelGraphics = deps.intel ?? createIntelGraphics({ log: deps.log('intel') })

  let off: (() => void) | null = null
  const offs: (() => void)[] = []

  return {
    start() {
      void resumeLeftPaused()
      home.start()
      performance.start()
      memory.start()
      extras.start()
      syncEnabled(deps.settings.get(), true)
      off = deps.settings.onChange((next) => {
        syncEnabled(next)
        syncTouchSwipe(next)
      })
      syncTouchSwipe()
      // The sessions say when a game starts and ends (the launcher may not have caught up when they fire).
      const offTouchStart = deps.events.on?.('session:started', () => {
        gameRunning = true
        syncTouchSwipe()
      })
      const offTouchEnd = deps.events.on?.('session:ended', () => {
        gameRunning = false
        syncTouchSwipe()
      })
      for (const o of [offTouchStart, offTouchEnd]) if (typeof o === 'function') offs.push(o)
      if (ingame) {
        // The pads go to the in-game overlay's page while it is shown (it has no focus to read them itself).
        const offPads = pads.onPads?.((list) => {
          if (ingame.active()) emitPads(list)
        })
        if (offPads) offs.push(offPads)
        // A game's folder is scanned for anti-cheat when it starts, so the first Home press can already pass the gate.
        const offStarted = deps.events.on?.('session:started', ({ gameId }) =>
          ingame.prewarm(gameId)
        )
        if (typeof offStarted === 'function') offs.push(offStarted)
      }
    },
    homeStatus: () => home.status(),
    startCapture: () => home.startCapture(),
    stopCapture: () => home.stopCapture(),
    open: () => overlay.open(),
    close: () => overlay.close(),
    overlayState: () => overlay.state(),
    overlayWindow: () => overlay.window(),
    ingameWindow: () => ingame?.window() ?? null,
    async showPlayOut() {
      await overlay.close({ refocus: false })
      deps.mainWindow.show()
    },
    closeForOutsideWindow: () => overlay.close({ refocus: false }),
    whileGameRuns: (work) => overlay.whileRunning(work),
    async quitRunningGame() {
      const running = deps.launcher.running()
      if (!running) return false
      await overlay.close({ refocus: false })
      return deps.launcher.stop(running.gameId)
    },
    performance,
    memory,
    async removePowerHelper() {
      await extras.beforeHelperRemoved()
      return performance.removeHelper()
    },
    display,
    async setDisplayMode(mode) {
      const device = await monitorDevice()
      if (!device) return null
      const result = await native.setDisplayMode(device, mode)
      if (!result.ok) throw new Error(tMain('mainOverlay.display.refused', { code: result.code }))
      // Sync FPS + refresh follows the new rate.
      await extras
        .displayChanged()
        .catch((err) => log.warn('overlay: frame limit after a display change failed', err))
      return display()
    },
    media,
    extras,
    intel,
    mediaSession: () => media.session(),
    mediaControl: (action) => media.control(action),
    musicLibrary: () => media.library(),
    applyPowerProfile: (profile, forGame, options) => performance.apply(profile, forGame, options),
    forceForeground: (hwnd) => native.focus(hwnd),
    native: { foreground: native.foreground, pauseProcess: pauses.owner('sleep') },
    isPlayOutWindow: (hwnd) => hwnd === deps.mainWindow.hwnd() || hwnd === overlay.hwnd(),
    suspend() {
      pads.stop()
      touchSwipe.set(false)
      memory.suspend()
    },
    resume() {
      memory.resume()
      syncEnabled(deps.settings.get(), true)
      syncTouchSwipe()
      void performance.resume()
    },
    async dispose() {
      off?.()
      for (const o of offs.splice(0)) o()
      stopForegroundWatch()
      home.dispose()
      pads.stop()
      touchSwipe.dispose()
      // Never leave a program paused behind PlayOut.
      await overlay.releasePause().catch((err) => log.warn('overlay: resume on quit failed', err))
      overlay.dispose()
      // The DLL in a game goes dormant (DETACH): any hold ends and the controller is the game's again.
      ingame?.dispose()
      await Promise.race([
        // The performance overlay's RivaTuner slot is released while the native host still runs.
        // A memory cleanup still running is given up on (its helper request fails when the pipe closes).
        Promise.all([home.idle(), memory.dispose(), performance.dispose(), extras.dispose()]),
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())
      ]).catch((err) => log.warn('overlay suite dispose', err))
      native.dispose()
      intel.dispose()
    }
  }
}
