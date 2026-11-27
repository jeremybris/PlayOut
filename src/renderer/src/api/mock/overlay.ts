// The home button, the in-game overlay and what it controls, in the mock (docs/home-overlay.md): one Xbox pad, Steam's
// and Game Bar's overrides following the settings, a combo capture that records View + Menu, power profiles with a
// ready power helper (Dynamic TDP the default, with made-up frame rates and watts during a game; removing it brings
// back the fallback profiles and installing it again takes a moment), a 1080p 120 Hz built-in screen, a media session that plays three made-up
// tracks and a small music folder. `?overlay=1` opens the overlay at start (the browser preview of the overlay window).
// The overlay extras (shared/overlay-extras.ts): RivaTuner 7.3.7 running, a per-game frame limit applied to
// '<game title>.exe', "Sync FPS + refresh" following the mock display, the performance overlay level in the settings,
// Auto HDR on (with Windows HDR on), the CPU boost of the profile in effect and Intel's Endurance Gaming as the probed
// Arc driver offers it (Off or Auto with a mode; On is not listed).
import type { PlayOutApi } from '@shared/api'
import type {
  ComboCaptureEvent,
  DisplayMode,
  DisplayStatus,
  HomeButtonStatus,
  MediaSession,
  MusicTrack,
  OverlayState,
  OverrideStatus,
  DynamicTdpStatus,
  PerformanceStatus,
  PowerChoice,
  WattsBackendStatus
} from '@shared/overlay'
import { DYNAMIC_FPS } from '@shared/overlay'
import {
  FRAME_LIMIT_MAX,
  PERF_OVERLAY_LEVELS,
  frameLimitOptions,
  type BoostPresetId,
  type CpuBoostStatus,
  type IntelGraphicsStatus,
  type LiveStats,
  type OverlayExtrasStatus
} from '@shared/overlay-extras'
import type { MemoryPassResult, MemoryStatus } from '@shared/memory'
import type { Game, Settings, SettingsPatch } from '@shared/types'
import type { MockEmitter } from './emitter'

/** The options the probed Arc B390 driver lists for Endurance Gaming (main/intel/intel-graphics.ts). */
export const MOCK_ENDURANCE_OPTIONS: { key: string; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'auto:performance', label: 'Auto, better performance' },
  { key: 'auto:balanced', label: 'Auto, balanced' },
  { key: 'auto:battery', label: 'Auto, maximum battery' }
]

export type OverlayApi = Pick<
  PlayOutApi,
  | 'getHomeButtonStatus'
  | 'startComboCapture'
  | 'stopComboCapture'
  | 'openOverlay'
  | 'closeOverlay'
  | 'getOverlayState'
  | 'showPlayOut'
  | 'quitRunningGame'
  | 'getPerformanceStatus'
  | 'applyPowerProfile'
  | 'installPowerHelper'
  | 'removePowerHelper'
  | 'getMemoryStatus'
  | 'getControllerWakeStatus'
  | 'freeMemoryNow'
  | 'getDisplayStatus'
  | 'setDisplayMode'
  | 'getOverlayExtras'
  | 'getLiveStats'
  | 'setFrameLimit'
  | 'setFrameLimitSync'
  | 'setPerfOverlayLevel'
  | 'setAutoHdr'
  | 'setCpuBoost'
  | 'getIntelGraphics'
  | 'setEnduranceGaming'
  | 'getMediaSession'
  | 'mediaControl'
  | 'getMusicLibrary'
  | 'chooseMusicFolder'
>

export interface OverlayMock {
  api: OverlayApi
  /**
   * The mock's updateSettings calls this: the home button's state follows settings.input, the extra tiles follow
   * settings.performance. Without `patch` both are refreshed.
   */
  settingsChanged: (next: Settings, patch?: SettingsPatch) => void
}

export interface OverlayMockDeps {
  emitter: MockEmitter
  settings: () => Settings
  /** Save a settings change (the mock's own updateSettings: it persists and emits settings:changed). */
  updateSettings: (patch: SettingsPatch) => void
  games: Map<string, Game>
  /** The running game's id, or null. */
  runningGameId: () => string | null
  /** End the running session (Quit game). */
  endSession: () => void
  /** `?overlay=1`: the overlay starts open. */
  openAtStart: boolean
}

export const MOCK_MUSIC_FOLDER = 'C:\\Users\\Player\\Music'
export const MOCK_RTSS_VERSION = '7.3.7'
export const MOCK_CLASH =
  'Winhanced also controls RivaTuner; PlayOut changes only each game’s own profile, never the global one. (mock)'
const AUTO_HDR_NOTE = 'Applies to games started next'
/** Without a frame limit the made-up game runs at about this rate. */
const UNLIMITED_FPS = 90

/** RivaTuner's profile name for a game: its title as a file name, '.exe' added ('Halo: Reach' -> 'Halo Reach.exe'). */
export function mockGameExe(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${name || 'Game'}.exe`
}
const HELPER_INSTALL_MS = 1_200
/** How long the made-up memory cleanup takes. */
export const MOCK_MEMORY_PASS_MS = 900
const CAPTURE_STEPS: { atMs: number; event: ComboCaptureEvent }[] = [
  { atMs: 500, event: { held: ['view'] } },
  { atMs: 900, event: { held: ['view', 'menu'] } },
  { atMs: 1_800, event: { held: [], done: ['view', 'menu'] } }
]

const MODES: DisplayMode[] = [1920, 1600, 1280].flatMap((width) =>
  [120, 60].map((hz) => ({ width, height: (width * 9) / 16, hz }))
)

const MEDIA_TRACKS: Pick<MediaSession, 'title' | 'artist' | 'album'>[] = [
  { title: 'Night Drive', artist: 'The Mock Ensemble', album: 'Sample Sessions' },
  { title: 'Low Orbit', artist: 'The Mock Ensemble', album: 'Sample Sessions' },
  { title: 'Paper Lanterns', artist: 'Placeholder Trio', album: 'Test Pressing' }
]

/** Album art as a data: URL (a gradient square), as SMTC hands it over. */
const MEDIA_ART = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7b2ff7"/><stop offset="1" stop-color="#f107a3"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/></svg>'
)}`

const MUSIC_FILES = [
  'Placeholder Trio/Test Pressing/01 Opening.mp3',
  'Placeholder Trio/Test Pressing/02 Paper Lanterns.mp3',
  'Placeholder Trio/Test Pressing/03 Second Wind.flac',
  'The Mock Ensemble/Sample Sessions/01 Night Drive.mp3',
  'The Mock Ensemble/Sample Sessions/02 Low Orbit.mp3',
  'The Mock Ensemble/Sample Sessions/03 Long Way Home.m4a',
  'Game Soundtracks/Boss Theme.ogg',
  'Game Soundtracks/Menu Loop.opus',
  'Rain on the Window.wav'
]

function musicTracks(): MusicTrack[] {
  return MUSIC_FILES.map((path) => {
    const parts = path.split('/')
    const name = parts[parts.length - 1]!.replace(/\.[^.]+$/, '').replace(/^\d+\s+/, '')
    return { path, title: name, folder: parts.length > 1 ? parts[parts.length - 2]! : '' }
  })
}

export function createOverlayMock(deps: OverlayMockDeps): OverlayMock {
  const { emitter } = deps
  const log = (...args: unknown[]): void => console.info('[mock overlay]', ...args)

  // --- home button --------------------------------------------------------------
  const captureTimers: ReturnType<typeof setTimeout>[] = []
  let steamApplied: boolean
  const homeStatus = (): HomeButtonStatus => {
    const { input } = deps.settings()
    const guide = input.homeButtonEnabled && input.homeCombo.includes('guide')
    const override = (wanted: boolean): OverrideStatus => ({ state: wanted ? 'applied' : 'off' })
    const viewMenu =
      input.homeCombo.length === 2 &&
      input.homeCombo.includes('view') &&
      input.homeCombo.includes('menu')
    return {
      enabled: input.homeButtonEnabled,
      reader: { state: 'running' },
      pads: [{ id: 'xinput:0', name: 'Xbox Wireless Controller', buttons: 0 }],
      steam: override(guide && input.homeOverrideSteam),
      gameBar: override(input.homeButtonEnabled && input.homeOverrideGameBar),
      clash: viewMenu
        ? 'Winhanced also opens its overlay on View + Menu: both would open. (mock)'
        : undefined
    }
  }
  steamApplied = homeStatus().steam.state === 'applied'

  // --- overlay --------------------------------------------------------------------
  let overlay: OverlayState = { open: false }
  const setOverlay = (open: boolean): void => {
    const gameId = deps.runningGameId() ?? undefined
    overlay = open ? { open, gameId, program: gameId ? undefined : 'explorer.exe' } : { open }
    emitter.emit('overlay:state', { ...overlay })
  }
  if (deps.openAtStart) overlay = { open: true, gameId: deps.runningGameId() ?? undefined }

  // --- performance ----------------------------------------------------------------
  let watts: WattsBackendStatus = {
    state: 'ready',
    method: 'ryzen-smu',
    cpu: 'AMD Ryzen Z1 Extreme (mock)',
    minWatts: 5,
    maxWatts: 30,
    helperVersion: 2
  }
  const helperReady = (): boolean => watts.state === 'ready'
  // As the main process: with the helper 'auto' and the fallback profiles are Dynamic TDP; without, 'auto' is Off
  // and 'dynamic' Balanced.
  const resolveChoice = (c: Settings['performance']['defaultProfile']): PowerChoice | null => {
    if (c === 'auto') return helperReady() ? 'dynamic' : null
    if (c === 'dynamic' && !helperReady()) return 'balanced'
    if ((c === 'silent' || c === 'balanced' || c === 'performance') && helperReady())
      return 'dynamic'
    return c === 'none' ? null : c
  }
  let active: PowerChoice | null = resolveChoice(deps.settings().performance.defaultProfile)
  let source: PerformanceStatus['source'] = active ? 'default' : null
  /** The choice in effect as it was saved (main's `chosen`): it applies again when the helper comes or goes. */
  let chosen: Settings['performance']['defaultProfile'] = deps.settings().performance.defaultProfile
  /** The helper came or went: the default (or the saved pick) goes on as it applies now. */
  const reEffect = (): void => {
    if (source === 'default' || (source === null && chosen !== 'none')) {
      chosen = deps.settings().performance.defaultProfile
      active = resolveChoice(chosen)
      source = active ? 'default' : null
    } else if (source !== null) active = resolveChoice(chosen)
  }
  let manualTarget: number | null = null
  const runningGame = (): Game | undefined => {
    const id = deps.runningGameId()
    return id ? deps.games.get(id) : undefined
  }
  const targetFps = (): number => {
    const own = runningGame()?.user.performance?.targetFps
    if (source === 'game' && own) return own
    return manualTarget ?? deps.settings().performance.dynamic?.targetFps ?? DYNAMIC_FPS.default
  }

  // Dynamic TDP, simulated: a game that runs at ~4.2 fps per watt up to 75 fps; the watts move 1 W a second toward
  // the target, the frame rate wobbles a little.
  let sim = { watts: 18, fps: 0 }
  let simTimer: ReturnType<typeof setInterval> | null = null
  const dynamicStatus = (): DynamicTdpStatus | undefined => {
    if (active !== 'dynamic') return undefined
    if (!runningGame()) return { targetFps: targetFps(), state: 'idle' }
    if (!sim.fps) return { targetFps: targetFps(), state: 'measuring', watts: sim.watts }
    const target = targetFps()
    const band = Math.max(2, target * 0.05)
    const state: DynamicTdpStatus['state'] =
      sim.fps < target - band
        ? sim.watts >= 30
          ? 'max'
          : sim.fps >= 74
            ? 'plateau'
            : 'raising'
        : sim.fps > target + band
          ? 'lowering'
          : 'holding'
    return {
      targetFps: target,
      state,
      fps: Math.round(sim.fps * 10) / 10,
      frameTimeMs: Math.round((1000 / sim.fps) * 100) / 100,
      watts: sim.watts
    }
  }
  const simTick = (): void => {
    if (active !== 'dynamic' || !runningGame() || !helperReady()) {
      if (simTimer) clearInterval(simTimer)
      simTimer = null
      sim = { watts: 18, fps: 0 }
      pushPerformance()
      return
    }
    const target = targetFps()
    const band = Math.max(2, target * 0.05)
    if (sim.fps && sim.fps < target - band && sim.fps < 74) sim.watts = Math.min(30, sim.watts + 1)
    else if (sim.fps > target + band) sim.watts = Math.max(5, sim.watts - 1)
    sim.fps = Math.min(75, sim.watts * 4.2) * (0.97 + Math.random() * 0.06)
    pushPerformance()
  }
  const syncSim = (): void => {
    const wanted = active === 'dynamic' && !!runningGame() && helperReady()
    if (wanted && !simTimer) simTimer = setInterval(simTick, 1_000)
    if (!wanted && simTimer) {
      clearInterval(simTimer)
      simTimer = null
      sim = { watts: 18, fps: 0 }
    }
  }

  const performanceStatus = (): PerformanceStatus => {
    syncSim()
    const game = runningGame()
    const profile =
      active && active !== 'dynamic' ? deps.settings().performance.profiles[active] : undefined
    const dynamic = dynamicStatus()
    const gameTargetFps = game?.user.performance?.targetFps
    // As the main process: a fallback profile saved before the helper runs, and shows, as Dynamic TDP with it.
    const saved = game?.user.performance?.profile
    const gameProfile =
      saved &&
      helperReady() &&
      (saved === 'silent' || saved === 'balanced' || saved === 'performance')
        ? 'dynamic'
        : saved
    return {
      active,
      source,
      gameId: game?.id,
      gameProfile,
      ...(gameProfile === 'dynamic' && gameTargetFps ? { gameTargetFps } : {}),
      watts:
        watts.state === 'ready'
          ? { ...watts, currentWatts: dynamic?.watts ?? profile?.watts ?? 15 }
          : { ...watts },
      helper: helperReady() ? 'ready' : 'missing',
      ...(dynamic ? { dynamic } : {})
    }
  }
  const pushPerformance = (): PerformanceStatus => {
    const status = performanceStatus()
    emitter.emit('performance:status', status)
    // The CPU boost tile follows the profile in effect.
    pushExtras()
    return status
  }

  // --- display --------------------------------------------------------------------
  let current: DisplayMode = { width: 1920, height: 1080, hz: 120 }
  const displayStatus = (): DisplayStatus => ({
    name: 'Built-in display (mock)',
    current: { ...current },
    modes: MODES.map((m) => ({ ...m }))
  })

  // --- overlay extras -------------------------------------------------------------------
  /** Each game's remembered frame limit (0 = unlimited is not kept), by game id or 'exe:<name>' (main's store). */
  const frameLimits = new Map<string, number>()
  let autoHdr = true
  const hdrOn = true
  let lastExtras = ''

  /** What the frame limit applies to: the running game, else the program the overlay is open over. */
  const extrasTarget = (): { key: string; exe: string; gameId?: string } | null => {
    const game = runningGame()
    if (game) return { key: game.id, exe: mockGameExe(game.title), gameId: game.id }
    if (overlay.open && overlay.program)
      return { key: `exe:${overlay.program.toLowerCase()}`, exe: overlay.program }
    return null
  }
  const limitReason = (): string | undefined =>
    !helperReady()
      ? 'Needs the power helper (Settings › System)'
      : !extrasTarget()
        ? 'Start a game first'
        : undefined

  const cpuBoostStatus = (): CpuBoostStatus => {
    const { profiles, boostOverrides } = deps.settings().performance
    if (!active)
      return {
        enabled: false,
        available: false,
        reason: 'Choose a power profile first',
        profile: null,
        overridden: false
      }
    if (active === 'dynamic')
      return {
        enabled: false,
        available: false,
        reason: 'Managed by Dynamic TDP',
        profile: 'dynamic',
        overridden: false
      }
    if (active === 'custom')
      return {
        enabled: profiles.custom.cpuBoost,
        available: true,
        profile: 'custom',
        overridden: false
      }
    const own = boostOverrides?.[active]
    return {
      enabled: own ?? profiles[active].cpuBoost,
      available: true,
      profile: active,
      overridden: own !== undefined
    }
  }

  const extrasStatus = (): OverlayExtrasStatus => {
    const { syncFpsToRefresh, perfOverlay } = deps.settings().performance
    const hz = Math.round(current.hz)
    const target = extrasTarget()
    const reason = limitReason()
    const chosen = target ? (frameLimits.get(target.key) ?? 0) : 0
    return {
      rtss: { state: 'running', version: MOCK_RTSS_VERSION },
      // The browser preview shows every tile (the app offers these only after the in-game check).
      rtssTiles: true,
      osdTile: true,
      frameLimit: {
        available: !reason,
        ...(reason ? { reason } : {}),
        fps: syncFpsToRefresh && target ? hz : chosen,
        chosen,
        options: frameLimitOptions(current.hz),
        ...(target ? { exe: target.exe } : {}),
        ...(target?.gameId ? { gameId: target.gameId } : {})
      },
      sync: { enabled: syncFpsToRefresh, available: !reason, ...(reason ? { reason } : {}), hz },
      perfOverlay: {
        level: perfOverlay,
        available: true,
        drawing: perfOverlay > 0 && !!runningGame()
      },
      autoHdr: { enabled: autoHdr, hdrOn, available: hdrOn, note: AUTO_HDR_NOTE },
      cpuBoost: cpuBoostStatus(),
      clash: MOCK_CLASH
    }
  }
  /** Emit 'overlay:extras' when the status changed (like main, which compares before emitting). */
  const pushExtras = (): OverlayExtrasStatus => {
    const status = extrasStatus()
    const json = JSON.stringify(status)
    if (json !== lastExtras) {
      lastExtras = json
      emitter.emit('overlay:extras', status)
    }
    return status
  }
  const requireTarget = (): void => {
    const reason = limitReason()
    if (reason) throw new Error(reason)
  }
  /** The game's frame rate: near the limit in effect (or about 90 without one), with a little jitter. */
  const liveStats = (): LiveStats => {
    if (!runningGame()) return { fps: null, fpsSource: null, watts: null }
    const limit = extrasStatus().frameLimit.fps
    const base = limit > 0 ? limit : UNLIMITED_FPS
    const fps = Math.max(1, Math.round(base * (0.95 + Math.random() * 0.05)))
    const perf = performanceStatus()
    const watts =
      perf.watts.state === 'ready' ? (perf.dynamic?.watts ?? perf.watts.currentWatts) : undefined
    return {
      fps,
      frameTimeMs: Math.round(10_000 / fps) / 10,
      fpsSource: 'rtss',
      watts: typeof watts === 'number' ? Math.round(watts) : null
    }
  }
  // A game starting or ending changes the target (and whether the performance overlay draws).
  emitter.on('session:started', () => void pushExtras())
  emitter.on('session:ended', () => void pushExtras())

  // --- memory (Settings › System, "Free up memory while PlayOut is running") ---------
  // A made-up pass: system-wide while the mock power helper is installed, this user's programs only without it.
  let memoryLast: MemoryPassResult | null = null
  let memoryRun: Promise<MemoryStatus> | null = null
  const memoryStatus = (): MemoryStatus => ({
    enabled: deps.settings().performance.memory?.enabled === true,
    running: memoryRun !== null,
    systemWide: helperReady() ? 'ready' : 'missing',
    last: memoryLast
  })
  const pushMemory = (): MemoryStatus => {
    const status = memoryStatus()
    emitter.emit('memory:status', status)
    return status
  }
  const mockMemoryPass = (): MemoryPassResult => {
    const system = helperReady()
    const before = 2_140
    const freed = system ? 1_843 : 640
    const done = { state: 'done' as const }
    return {
      at: new Date().toISOString(),
      reason: 'manual',
      tier: system ? 'system' : 'user',
      beforeAvailableMb: before,
      afterAvailableMb: before + freed,
      freedMb: freed,
      trimmed: system ? 96 : 41,
      skipped: 118,
      denied: system ? 7 : 62,
      steps: system
        ? {
            workingSets: done,
            modifiedList: done,
            lowPriorityStandby: done,
            standby: { state: 'skipped', detail: 'enough memory is free' },
            combine: done
          }
        : { workingSets: done }
    }
  }

  // --- media -------------------------------------------------------------------------
  let mediaIndex = 0
  let mediaStatus: MediaSession['status'] = 'playing'
  const mediaSession = (): MediaSession => ({
    app: 'Spotify.exe',
    ...MEDIA_TRACKS[mediaIndex]!,
    status: mediaStatus,
    art: MEDIA_ART,
    canNext: true,
    canPrevious: true
  })

  let endurance = 'off'
  const intelStatus = (): IntelGraphicsStatus => ({
    enduranceGaming: { supported: true, value: endurance, options: MOCK_ENDURANCE_OPTIONS }
  })

  const api: OverlayApi = {
    async getHomeButtonStatus() {
      return homeStatus()
    },
    async startComboCapture() {
      for (const timer of captureTimers.splice(0)) clearTimeout(timer)
      for (const step of CAPTURE_STEPS)
        captureTimers.push(
          setTimeout(() => emitter.emit('home:capture', structuredClone(step.event)), step.atMs)
        )
    },
    async stopComboCapture() {
      for (const timer of captureTimers.splice(0)) clearTimeout(timer)
    },
    async openOverlay() {
      setOverlay(true)
    },
    async closeOverlay() {
      setOverlay(false)
    },
    async getOverlayState() {
      return { ...overlay }
    },
    async showPlayOut() {
      log('showPlayOut(): PlayOut would come to the front')
      if (overlay.open) setOverlay(false)
    },
    async quitRunningGame() {
      const running = deps.runningGameId() !== null
      if (running) deps.endSession()
      if (overlay.open) setOverlay(false)
      return running
    },

    async getPerformanceStatus() {
      return performanceStatus()
    },
    async applyPowerProfile(profile, forGame, options) {
      active = resolveChoice(profile)
      chosen = profile
      source = active ? 'manual' : null
      const game = runningGame()
      const wanted = options?.targetFps
      if (forGame && deps.games.get(forGame) && profile !== 'none') {
        const target = deps.games.get(forGame)!
        const had = target.user.performance?.targetFps
        // With the helper a fallback profile is kept as Dynamic TDP (what it runs as).
        const saved =
          helperReady() &&
          (profile === 'silent' || profile === 'balanced' || profile === 'performance')
            ? 'dynamic'
            : profile
        const fps = saved === 'dynamic' ? (wanted ?? had) : undefined
        target.user = {
          ...target.user,
          performance: {
            profile: saved,
            ...(fps !== undefined ? { targetFps: fps } : {})
          }
        }
        source = 'game'
      } else if (forGame === undefined && profile === 'dynamic' && wanted !== undefined) {
        manualTarget = wanted
      } else if (forGame === null && game) {
        const user = { ...game.user }
        delete user.performance
        game.user = user
      }
      log(`applyPowerProfile(${profile}, ${String(forGame)})`)
      return pushPerformance()
    },
    async installPowerHelper() {
      await new Promise((resolve) => setTimeout(resolve, HELPER_INSTALL_MS))
      watts = { ...watts, state: 'ready', helperVersion: 2 }
      // 'auto', 'dynamic' and a fallback profile run as Dynamic TDP once the helper is ready.
      reEffect()
      pushMemory()
      return pushPerformance()
    },
    async removePowerHelper() {
      watts = { ...watts, state: 'not-installed', helperVersion: undefined }
      // What ran as Dynamic TDP goes back to what it is without the helper (a fallback profile as itself).
      reEffect()
      pushMemory()
      return pushPerformance()
    },
    async getMemoryStatus() {
      return memoryStatus()
    },
    // A PC with an Xbox Wireless Adapter and a controller paired to it; on when the setting is.
    async getControllerWakeStatus() {
      const adapter = 'Xbox Wireless Adapter for Windows'
      return {
        enabled: deps.settings().system.controllerWake,
        capable: [adapter],
        armed: deps.settings().system.controllerWake ? [adapter] : [],
        programmable: [adapter],
        readable: true,
        adapter: true,
        step: 'idle' as const
      }
    },
    async freeMemoryNow() {
      // A second press joins the pass that is running, as in main.
      memoryRun ??= new Promise<MemoryStatus>((resolve) => {
        setTimeout(() => {
          memoryLast = mockMemoryPass()
          memoryRun = null
          log('freeMemoryNow()', memoryLast.tier, memoryLast.freedMb)
          resolve(pushMemory())
        }, MOCK_MEMORY_PASS_MS)
      })
      const run = memoryRun
      pushMemory()
      return run
    },

    async getDisplayStatus() {
      return displayStatus()
    },
    async setDisplayMode(mode) {
      const known = MODES.find(
        (m) => m.width === mode.width && m.height === mode.height && m.hz === mode.hz
      )
      if (known) current = { ...known }
      // Sync FPS + refresh: the limit follows the new rate.
      pushExtras()
      return displayStatus()
    },

    async getOverlayExtras() {
      return extrasStatus()
    },
    async getLiveStats() {
      return liveStats()
    },
    async setFrameLimit(fps) {
      if (!Number.isInteger(fps) || fps < 0 || fps > FRAME_LIMIT_MAX)
        throw new Error('Not a frame rate limit')
      requireTarget()
      const target = extrasTarget()!
      // An explicit pick turns sync off, so the pick sticks.
      if (deps.settings().performance.syncFpsToRefresh)
        deps.updateSettings({ performance: { syncFpsToRefresh: false } })
      if (fps) frameLimits.set(target.key, fps)
      else frameLimits.delete(target.key)
      log(`setFrameLimit(${fps}) for ${target.exe}`)
      return pushExtras()
    },
    async setFrameLimitSync(enabled) {
      if (enabled) requireTarget()
      deps.updateSettings({ performance: { syncFpsToRefresh: enabled } })
      return pushExtras()
    },
    async setPerfOverlayLevel(level) {
      if (!PERF_OVERLAY_LEVELS.includes(level)) throw new Error('Not a performance overlay level')
      deps.updateSettings({ performance: { perfOverlay: level } })
      return pushExtras()
    },
    async setAutoHdr(enabled) {
      if (!hdrOn) throw new Error('Turn on HDR in Windows display settings first')
      autoHdr = enabled
      return pushExtras()
    },
    async setCpuBoost(enabled) {
      const boost = cpuBoostStatus()
      if (!boost.available) throw new Error(boost.reason)
      const { profiles, boostOverrides } = deps.settings().performance
      if (active === 'custom') {
        deps.updateSettings({
          performance: {
            profiles: { ...profiles, custom: { ...profiles.custom, cpuBoost: enabled } }
          }
        })
      } else if (active && active !== 'dynamic') {
        const preset: BoostPresetId = active
        const next = { ...boostOverrides }
        // The preset's own value needs no override.
        if (enabled === profiles[preset].cpuBoost) delete next[preset]
        else next[preset] = enabled
        deps.updateSettings({ performance: { boostOverrides: next } })
      }
      return pushExtras()
    },
    async getIntelGraphics() {
      return intelStatus()
    },
    async setEnduranceGaming(value) {
      if (!MOCK_ENDURANCE_OPTIONS.some((o) => o.key === value))
        throw new Error(`This driver does not offer Endurance Gaming "${value}"`)
      endurance = value
      log(`setEnduranceGaming(${value})`)
      return intelStatus()
    },

    async getMediaSession() {
      return mediaSession()
    },
    async mediaControl(action) {
      if (action === 'next') mediaIndex = (mediaIndex + 1) % MEDIA_TRACKS.length
      else if (action === 'previous')
        mediaIndex = (mediaIndex - 1 + MEDIA_TRACKS.length) % MEDIA_TRACKS.length
      else if (action === 'play') mediaStatus = 'playing'
      else if (action === 'pause') mediaStatus = 'paused'
      else mediaStatus = mediaStatus === 'playing' ? 'paused' : 'playing'
      return mediaSession()
    },
    async getMusicLibrary() {
      const folder = deps.settings().music.folder
      return { folder, tracks: folder ? musicTracks() : [] }
    },
    async chooseMusicFolder() {
      return MOCK_MUSIC_FOLDER
    }
  }

  return {
    api,
    settingsChanged(_next, patch) {
      if (!patch || patch.performance) pushExtras()
      if (!patch || patch.performance?.memory) pushMemory()
      if (patch && !patch.input) return
      const status = homeStatus()
      // Steam's restart, as the real override does it: pending first, then applied.
      if (status.steam.state === 'applied' && !steamApplied) {
        emitter.emit('home:status', { ...status, steam: { state: 'pending' } })
        setTimeout(() => emitter.emit('home:status', homeStatus()), 1_500)
      } else {
        emitter.emit('home:status', status)
      }
      steamApplied = status.steam.state === 'applied'
    }
  }
}
