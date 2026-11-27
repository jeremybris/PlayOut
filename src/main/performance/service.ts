import { join } from 'path'
import {
  DYNAMIC_FPS,
  type DynamicTdpStatus,
  type PerformanceStatus,
  type PowerChoice,
  type PowerHelperState,
  type PowerProfileConfig,
  type WattsBackendStatus,
  type WindowsPowerMode
} from '../../shared/overlay'
import type { Game, GameUserPatch, Settings } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { execCommand, type CommandRunner } from '../system/power'
import { createPsWorker } from '../system/ps-worker'
import {
  asusWattsBackend,
  chooseWattsMethod,
  helperWattsBackend,
  isHelperOutdatedMessage,
  unsupportedMessage,
  type WattsBackend
} from './backends'
import {
  ASUS_MIN_WRITE_MS,
  createDynamicState,
  DYNAMIC_DEFAULTS,
  DYNAMIC_TICK_MS,
  dynamicLimits,
  dynamicStep,
  type DynamicConfig,
  type DynamicState,
  type WattsLimits
} from './dynamic'
import type { MemorySystemTier } from '../../shared/memory'
import { HELPER_FPS_VERSION, HELPER_MEMORY_VERSION, HELPER_RTSS_VERSION } from './helper/protocol'
import type { RtssHelper } from '../rtss/service'
import { createHelperClient, type HelperClient } from './helper-client'
import {
  helperInstallState,
  installHelper as installHelperFiles,
  removeHelper as removeHelperFiles,
  resolveHelperDir,
  type HelperInstallState,
  type HelperModule,
  type InstallResult
} from './install'
import { resolveLimits } from './limits'
import { createPerfNative, PERF_NATIVE_INIT, type PerfNative } from './native'
import { createProfileApplier, type ProfileApplier } from './profiles'
import { asusCaps } from './asus'
import { tMain } from '../i18n'

/**
 * The overlay's Power section (docs/home-overlay.md, Power profiles). Applies a profile's no-driver settings
 * (profiles.ts) and, with settings.performance.useWatts and a ready backend, its watts (backends.ts). At
 * session:started the game's own profile (settings.performance.perGame) or else the default goes on; at
 * session:ended what was in effect before the game comes back. Watts are written again every 30 s while set and
 * after resume, because Intel DTT, OEM tools and sleep put their own limits back.
 *
 * Dynamic TDP ('dynamic', with a ready power helper of protocol 2): during a game the helper measures the game's frame
 * rate (its own PresentMon) and dynamic.ts moves the watts once a second to hold the target; the no-driver part stays
 * neutral (DYNAMIC_NEUTRAL). Outside games it leaves Windows' own settings and watts be (as 'none'). The default profile 'auto' (the factory
 * default) is Dynamic TDP when the helper is ready, else 'none'. With a ready helper the fallback profiles (Silent,
 * Balanced, Performance) are not offered: one saved before the helper (the default, a game's own, or the one in
 * effect) runs as Dynamic TDP, so nothing hidden applies.
 */

export const WATTS_REAPPLY_MS = 30_000
/** How long the helper gets to open its pipe after an install started its task. */
export const HELPER_START_MS = 20_000
/** How often the game's processes are looked up again while no frames come, ms. */
export const FPS_PID_RESCAN_MS = 5_000
/** ... and while frames come (a game may start more processes), ms. */
export const FPS_PID_REFRESH_MS = 15_000
/**
 * PresentMon that keeps stopping (or failing to start) for the same processes: the waits before the 1st, 2nd and
 * every later restart, ms. Frames arriving or other processes to measure start over.
 */
export const FPS_RESTART_BACKOFF_MS = [5_000, 15_000, 60_000] as const
/**
 * A ready helper that fails this many status reads in a row is taken as gone (one read can time out under a game's
 * load, and Dynamic TDP's own tick rides that out). Fewer leave the choice in effect as it is.
 */
export const HELPER_LOSS_READS = 3
/**
 * How often the helper is asked again on its own while the choice in effect waits for it (or a ready helper missed a
 * read), ms: Dynamic TDP comes back once it answers again, with the overlay open or not.
 */
export const HELPER_RECHECK_MS = 45_000
/** The longest the recheck backs off to, in HELPER_RECHECK_MS ticks (6 minutes). */
export const HELPER_RECHECK_MAX_EVERY = 8

/** The no-driver part while Dynamic TDP runs: neutral, so the watts alone decide. */
export const DYNAMIC_NEUTRAL: PowerProfileConfig = {
  powerMode: 'balanced',
  cpuMaxPercent: 100,
  cpuBoost: true,
  watts: null,
  boostWatts: null
}

/** What can be put in effect (a profile, Dynamic TDP, Windows' own, or 'auto'). */
type Choice = PowerChoice | 'none' | 'auto'

type Source = PerformanceStatus['source']

/** A saved choice whose effect depends on the helper, and whether the helper was ready when it went in effect. */
interface Chosen {
  choice: Choice
  why: Source
  ready: boolean
}

export interface PerformanceIo {
  native: PerfNative
  run: CommandRunner
  userSid(): Promise<string>
  helperState(module: HelperModule): Promise<HelperInstallState>
  helperClient(sid: string): HelperClient
  install(module: HelperModule, sid: string): Promise<InstallResult>
  remove(): Promise<InstallResult>
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** Tests: the clock Dynamic TDP runs on (default Date.now). */
  now?(): number
  /** Disposes what the default io started (the PowerShell worker). */
  dispose?(): void
}

export interface PerformanceServiceDeps {
  settings: { get(): Settings; onChange(listener: (settings: Settings) => void): () => void }
  library: {
    getGame(id: string): Game | undefined
    updateGame(id: string, patch: GameUserPatch): unknown
  }
  launcher: {
    running(): { gameId: string; pid?: number } | null
    /** The running game's live processes (spawned tree, or matched by image names): what Dynamic TDP measures. */
    gameProcesses?(): Promise<{ pid: number; name?: string }[]>
  }
  events: Pick<EventBus, 'emit' | 'on'>
  log: Logger
  /** PlayOut's data folder: performance\before.json and the helper downloads go under it. */
  dataDir: string
  /**
   * Not used any more: profiles set the power mode overlay of AC and DC by GUID themselves (profiles.ts), which
   * `powercfg /overlaysetactive` (current source only) cannot. Kept so existing callers still type-check.
   */
  setPowerMode?(mode: WindowsPowerMode): Promise<void>
  io?: Partial<PerformanceIo>
}

export interface PerformanceService {
  start(): void
  status(): PerformanceStatus
  /** Re-reads the watts backend (the helper's current watts) and emits. */
  refresh(): Promise<PerformanceStatus>
  apply(
    profile: PowerChoice | 'none',
    forGame?: string | null,
    options?: { targetFps?: number }
  ): Promise<PerformanceStatus>
  installHelper(): Promise<PerformanceStatus>
  removeHelper(): Promise<PerformanceStatus>
  /** After the PC wakes: write the watts again. */
  resume(): Promise<void>
  /** Stops the timers and puts Windows back as it was before PlayOut changed it. */
  dispose(): Promise<void>
  /**
   * The power helper's RivaTuner operations (per-game frame limits) when it is installed, answering and at protocol
   * HELPER_RTSS_VERSION or later; null otherwise (not on this PC, not installed, outdated or not answering). A helper
   * that is not ready is asked again at most every RTSS_HELPER_RECHECK_MS.
   */
  rtssHelper(): Promise<RtssHelper | null>
  /**
   * The power helper's system-wide memory cleanup, under the same conditions as rtssHelper() but from protocol
   * HELPER_MEMORY_VERSION; null otherwise (the cleanup then trims this user's own programs only).
   */
  memoryHelper(): Promise<MemoryHelper | null>
  /** Why memoryHelper() is or is not there, as last read (no helper is asked): what Settings › System says. */
  memoryTier(): MemorySystemTier
}

/** The helper operation the memory cleanup uses (performance/memory/service.ts). */
export interface MemoryHelper {
  memoryTrim: NonNullable<HelperClient['memoryTrim']>
}

/** How often rtssHelper() asks a helper that was not ready again, ms. */
export const RTSS_HELPER_RECHECK_MS = 30_000

/** A preset's config with the overlay's CPU boost override (settings.performance.boostOverrides); Custom as it is. */
export function profileConfig(
  p: Settings['performance'],
  profile: Exclude<PowerChoice, 'dynamic'>
): PowerProfileConfig {
  const config = p.profiles[profile]
  if (profile === 'custom') return config
  const boost = p.boostOverrides?.[profile]
  return typeof boost === 'boolean' && boost !== config.cpuBoost
    ? { ...config, cpuBoost: boost }
    : config
}

const SID_SCRIPT = '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'

function defaultIo(deps: PerformanceServiceDeps): PerformanceIo {
  const worker = createPsWorker({ log: deps.log, init: PERF_NATIVE_INIT })
  // Resolved like the elevated scripts do (the known folder), never from %ProgramData%; read-only use here.
  let helperDir: Promise<string> | null = null
  const getHelperDir = (): Promise<string> => {
    helperDir ??= resolveHelperDir(worker).catch((err) => {
      helperDir = null
      throw err
    })
    return helperDir
  }
  const cacheDir = join(deps.dataDir, 'performance', 'downloads')
  async function userSid(): Promise<string> {
    const sid = await worker.run<string>(SID_SCRIPT)
    if (typeof sid !== 'string' || !sid) throw new Error(tMain('mainPerformance.windowsUser'))
    return sid
  }
  return {
    native: createPerfNative(worker),
    run: execCommand,
    userSid,
    helperState: async (module) =>
      helperInstallState(await getHelperDir(), module, await userSid()),
    helperClient: (sid) => createHelperClient({ sid, log: deps.log }),
    install: (module, sid) =>
      installHelperFiles({ http: { log: deps.log }, cacheDir, userSid: sid }, module),
    remove: () => removeHelperFiles({ log: deps.log }),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    dispose: () => worker.dispose()
  }
}

/** Silent, Balanced, Performance: the profiles offered only without a ready power helper. */
function isFallback(
  choice: PowerChoice | 'none' | 'auto'
): choice is 'silent' | 'balanced' | 'performance' {
  return choice === 'silent' || choice === 'balanced' || choice === 'performance'
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const checking = (): WattsBackendStatus => ({
  state: 'unsupported',
  message: tMain('mainPerformance.watts.checking')
})

export function createPerformanceService(deps: PerformanceServiceDeps): PerformanceService {
  const { log } = deps
  let io: PerformanceIo | null = null
  const getIo = (): PerformanceIo => {
    io ??= { ...defaultIo(deps), ...deps.io } as PerformanceIo
    return io
  }
  // Only build the default io (a PowerShell worker) when something is missing from deps.io.
  const ioComplete = (p: Partial<PerformanceIo> | undefined): p is PerformanceIo =>
    !!p &&
    [
      'native',
      'run',
      'userSid',
      'helperState',
      'helperClient',
      'install',
      'remove',
      'setInterval',
      'clearInterval'
    ].every((k) => k in p)
  if (ioComplete(deps.io)) io = deps.io

  let profiles: ProfileApplier | null = null
  const getProfiles = (): ProfileApplier => {
    profiles ??= createProfileApplier({
      native: getIo().native,
      run: getIo().run,
      stateFile: join(deps.dataDir, 'performance', 'before.json'),
      log
    })
    return profiles
  }

  let active: PowerChoice | null = null
  let source: Source = null
  let gameId: string | undefined
  let beforeGame: { active: PowerChoice | null; source: Source; chosen: Chosen | null } | null =
    null
  let helper: PowerHelperState | undefined
  /** Dynamic TDP's target from an overlay pick without "Use for <game>" (until Settings change it). */
  let manualTarget: number | null = null
  /** Status reads in a row a ready helper did not answer (an error, not 'missing' or 'outdated'); see HELPER_LOSS_READS. */
  let helperMisses = 0
  /** The HELPER_RECHECK_MS timer, while it is needed. */
  let recheckTimer: unknown = null
  /** The recheck asks the helper every `recheckEvery` ticks (backing off while nothing changes). */
  let recheckEvery = 1
  let recheckTicks = 0
  /**
   * The choice last put in effect as it was saved, when what it does depends on the helper ('auto', 'dynamic', a
   * fallback profile), and whether the helper was ready then. Whenever that changes (installed, started, watts
   * turned on; removed, crashed, outdated, watts turned off) reEffect puts the choice in effect again.
   */
  let chosen: Chosen | null = null
  /** Fallback profiles already logged as running as Dynamic TDP (logged once each). */
  const loggedAsDynamic = new Set<Choice>()
  /** Windows' own settings ('none') were picked by hand: a watts on/off change in Settings leaves them be. */
  let manualNone = false
  /** Dynamic TDP while it runs (a game session with 'dynamic' in effect). */
  let dyn: {
    state: DynamicState
    device: WattsLimits
    timer: unknown
    pids: number[]
    measuring: boolean
    lastScan: number
    lastFrameAt: number | null
    status: DynamicTdpStatus
    lastEmitted: string
    failures: number
    /** PresentMon stops (or fails to start) in a row for the same pids, and when the next start may be. */
    fpsFails: number
    fpsRetryAt: number
  } | null = null
  let error: string | undefined
  let watts: WattsBackendStatus = checking()

  let backend: WattsBackend | null | undefined
  let backendPromise: Promise<WattsBackend | null> | null = null
  let client: HelperClient | null = null
  let sid: string | null = null
  /** The limits PlayOut wrote and keeps writing; null when PlayOut leaves watts alone. */
  let wattsSet: { watts: number | null; boostWatts: number | null } | null = null
  let timer: unknown = null
  let unsubs: (() => void)[] = []
  let lastPerf = ''
  let disposed = false
  let queue: Promise<unknown> = Promise.resolve()

  /** Every change goes through one queue: powercfg, the firmware and the helper never see two at once. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  function perf(): Settings['performance'] {
    return deps.settings.get().performance
  }

  const now = (): number => getIo().now?.() ?? Date.now()

  const clampFps = (n: number): number =>
    Math.min(DYNAMIC_FPS.max, Math.max(DYNAMIC_FPS.min, Math.round(n)))

  /** Dynamic TDP's target: the game's own (when its own profile is in effect), an overlay pick, else Settings. */
  function targetFps(): number {
    if (gameId && source === 'game') {
      const own = deps.library.getGame(gameId)?.user?.performance?.targetFps
      if (typeof own === 'number' && Number.isFinite(own)) return clampFps(own)
    }
    return clampFps(manualTarget ?? perf().dynamic?.targetFps ?? DYNAMIC_FPS.default)
  }

  function snapshot(): PerformanceStatus {
    const game = gameId ? deps.library.getGame(gameId) : undefined
    const saved = game?.user?.performance?.profile
    // A fallback profile saved before the helper runs as Dynamic TDP with it (resolve), and shows so.
    const gameProfile = saved && helper === 'ready' && isFallback(saved) ? 'dynamic' : saved
    const gameTargetFps = game?.user?.performance?.targetFps
    return {
      active,
      source,
      ...(gameId ? { gameId } : {}),
      ...(gameProfile ? { gameProfile } : {}),
      ...(gameProfile === 'dynamic' && typeof gameTargetFps === 'number' ? { gameTargetFps } : {}),
      watts,
      ...(helper ? { helper } : {}),
      ...(active === 'dynamic'
        ? { dynamic: dyn ? { ...dyn.status } : { targetFps: targetFps(), state: 'idle' as const } }
        : {}),
      ...(error ? { error } : {})
    }
  }

  function emit(): PerformanceStatus {
    const s = snapshot()
    deps.events.emit('performance:status', s)
    syncRecheck()
    return s
  }

  async function getSid(): Promise<string> {
    sid ??= await getIo().userSid()
    return sid
  }

  async function getClient(): Promise<HelperClient> {
    client ??= getIo().helperClient(await getSid())
    return client
  }

  async function detect(): Promise<WattsBackend | null> {
    const io = getIo()
    const read = await io.native.read().catch(() => null)
    const caps = asusCaps(read?.asus ?? null)
    const cpu = await io.native.cpu().catch(() => null)
    const plan = chooseWattsMethod(caps, cpu)
    if (!plan) return null
    if (plan.method === 'asus-wmi') return asusWattsBackend(io.native, cpu)
    const module = plan.module!
    return helperWattsBackend({
      plan: { method: plan.method, module },
      cpu,
      installState: () => io.helperState(module),
      client: () => {
        if (!client) throw new Error(tMain('mainPerformance.helper.notConnected'))
        return client
      }
    })
  }

  async function getBackend(): Promise<WattsBackend | null> {
    if (backend !== undefined) return backend
    backendPromise ??= detect().catch((err) => {
      log.warn(`performance: watts detection failed: ${errorText(err)}`)
      return null
    })
    backend = await backendPromise
    return backend
  }

  /**
   * Dynamic TDP needs the helper (not ASUS firmware watts: the frame rate comes from the helper), answering with a
   * watts method, protocol HELPER_FPS_VERSION or later, and watts on in Settings.
   */
  function helperStateOf(b: WattsBackend | null, w: WattsBackendStatus): PowerHelperState {
    if (!b || b.method === 'asus-wmi' || !perf().useWatts) return 'none'
    if (w.state === 'not-installed')
      return isHelperOutdatedMessage(w.message) ? 'outdated' : 'missing'
    if (w.state !== 'ready' || w.helperVersion === undefined) return 'none'
    return w.helperVersion >= HELPER_FPS_VERSION ? 'ready' : 'outdated'
  }

  /**
   * Re-read the backend's status; `probe` starts the helper when it is installed. A ready helper that does not answer
   * stays 'ready' until HELPER_LOSS_READS reads in a row missed (`confirm`: at once, as after removing it); 'missing',
   * 'outdated', locked or watts off count at once.
   */
  async function refreshWatts(probe = true, confirm = false): Promise<WattsBackendStatus> {
    const b = await getBackend()
    const read = await readWatts(b, probe)
    // A read that does not ask the helper (watts off) only says it is installed. The protocol version it answered
    // with before is kept: rtssHelper() needs it, and without it the frame limit would report no helper until
    // RTSS_HELPER_RECHECK_MS passed. A helper removed or outdated since is 'not-installed' and loses it.
    watts =
      !probe &&
      read.state === 'ready' &&
      read.helperVersion === undefined &&
      watts.state === 'ready' &&
      watts.helperVersion !== undefined
        ? { ...read, helperVersion: watts.helperVersion }
        : read
    const next = helperStateOf(b, watts)
    if (helper === 'ready' && next === 'none' && watts.state === 'error' && !confirm) {
      helperMisses++
      if (helperMisses < HELPER_LOSS_READS) {
        if (helperMisses === 1)
          log.warn(`performance: the power helper did not answer (${watts.message ?? 'no answer'})`)
        syncRecheck()
        return watts
      }
      log.warn(`performance: the power helper did not answer ${helperMisses} times in a row`)
    }
    helperMisses = 0
    helper = next
    syncRecheck()
    return watts
  }

  /** The helper is asked again on its own while the choice in effect depends on it and it is not answering. */
  function syncRecheck(): void {
    const wanted =
      !disposed &&
      perf().useWatts &&
      !!backend &&
      backend.method !== 'asus-wmi' &&
      // Only a helper that may come back: a miss in progress, or one that is installed but not answering ('error').
      // A locked CPU or a PC without a method ('unsupported') never becomes ready on its own: no polling for it.
      (helperMisses > 0 || (chosen !== null && helper === 'none' && watts?.state === 'error'))
    if (!wanted) {
      if (recheckTimer !== null) getIo().clearInterval(recheckTimer)
      recheckTimer = null
      recheckEvery = 1
      recheckTicks = 0
      return
    }
    if (recheckTimer !== null) return
    recheckTimer = getIo().setInterval(() => {
      // Backing off: a helper that keeps not answering is asked every 1, 2, 4 then 8 ticks (45 s up to 6 min).
      recheckTicks++
      if (recheckTicks % recheckEvery !== 0) return
      void serial(recheck).catch((err) =>
        log.warn(`performance: asking the power helper again failed: ${errorText(err)}`)
      )
    }, HELPER_RECHECK_MS)
  }

  async function recheck(): Promise<void> {
    if (disposed) return
    const before = JSON.stringify([watts, helper])
    await refreshWatts(true)
    const changed = JSON.stringify([watts, helper]) !== before
    recheckEvery =
      changed || helper === 'ready' ? 1 : Math.min(recheckEvery * 2, HELPER_RECHECK_MAX_EVERY)
    recheckTicks = 0
    if (!(await reEffect()) && changed) emit()
    syncRecheck()
  }

  async function readWatts(b: WattsBackend | null, probe: boolean): Promise<WattsBackendStatus> {
    if (!b) return { state: 'unsupported', message: unsupportedMessage() }
    if (!probe) return b.status(false)
    if (b.method !== 'asus-wmi') {
      try {
        await getClient()
      } catch (err) {
        return { state: 'error', method: b.method, message: errorText(err) }
      }
    }
    return b.status()
  }

  function stopTimer(): void {
    if (timer !== null) getIo().clearInterval(timer)
    timer = null
  }

  function startTimer(): void {
    if (timer !== null || disposed) return
    timer = getIo().setInterval(() => {
      void serial(reapplyWatts)
    }, WATTS_REAPPLY_MS)
  }

  async function reapplyWatts(): Promise<void> {
    if (!wattsSet || !backend) return
    try {
      await backend.set(wattsSet.watts, wattsSet.boostWatts)
    } catch (err) {
      log.warn(`performance: re-applying watts failed: ${errorText(err)}`)
    }
  }

  async function wattsOff(): Promise<string[]> {
    stopTimer()
    if (!wattsSet) return []
    wattsSet = null
    try {
      await backend?.restore()
      return []
    } catch (err) {
      return [tMain('mainPerformance.watts.restoreFailed', { error: errorText(err) })]
    }
  }

  async function applyWatts(config: PowerProfileConfig): Promise<string[]> {
    const wanted = perf().useWatts && (config.watts !== null || config.boostWatts !== null)
    if (!wanted) return wattsOff()
    const status = await refreshWatts()
    if (status.state !== 'ready' || !backend) {
      // Leave limits PlayOut set earlier (with a backend that has since failed) to the helper's own restore.
      stopTimer()
      wattsSet = null
      return []
    }
    const limits = resolveLimits(config.watts, config.boostWatts, {
      min: status.minWatts ?? 5,
      max: status.maxWatts ?? 150
    })
    try {
      await backend.set(limits.watts, limits.boostWatts)
      wattsSet = limits
      startTimer()
      return []
    } catch (err) {
      return [errorText(err)]
    }
  }

  // --- Dynamic TDP ---------------------------------------------------------------------------------------------

  /**
   * A choice as it applies on this PC now (the helper's state is read first when unknown). With a ready helper:
   * 'auto', 'dynamic' and the fallback profiles are Dynamic TDP. Without: 'auto' is 'none', 'dynamic' is
   * Balanced, the rest as they are.
   */
  async function resolve(choice: Choice): Promise<PowerChoice | 'none'> {
    if (choice === 'none' || choice === 'custom') return choice
    // Watts off: Dynamic TDP is not there, whatever was read before.
    if (helper === 'ready' && !perf().useWatts) {
      helper = 'none'
      helperMisses = 0
    }
    if (helper !== 'ready') await refreshWatts(perf().useWatts)
    if (helper === 'ready') {
      if (isFallback(choice) && !loggedAsDynamic.has(choice)) {
        loggedAsDynamic.add(choice)
        log.info(`performance: ${choice} is not offered with the power helper; using Dynamic TDP`)
      }
      return 'dynamic'
    }
    if (choice === 'auto') return 'none'
    if (choice === 'dynamic') {
      log.info('performance: Dynamic TDP needs the power helper; using Balanced')
      return 'balanced'
    }
    return choice
  }

  async function stopDynamic(): Promise<void> {
    const d = dyn
    if (!d) return
    dyn = null
    getIo().clearInterval(d.timer)
    if (d.measuring && client?.fpsStop) await client.fpsStop().catch(() => undefined)
  }

  /** The game's pids to measure: its process tree (or name matches), else the spawned pid. */
  async function gamePids(): Promise<number[]> {
    const list = await deps.launcher.gameProcesses?.().catch(() => [])
    const pids = (list ?? []).map((p) => p.pid)
    const own = deps.launcher.running()?.pid
    if (own && !pids.includes(own)) pids.push(own)
    return pids.filter((p) => Number.isInteger(p) && p > 4)
  }

  /**
   * (Re)start the helper's frame-rate measuring when the game's pids changed or it stopped. The pids are looked up
   * again every FPS_PID_RESCAN_MS while no frames come (a launcher that hands over to the game) and every
   * FPS_PID_REFRESH_MS while they do (a game that starts more processes).
   */
  async function ensureFps(force: boolean): Promise<void> {
    const d = dyn
    if (!d || !client?.fpsStart) return
    const t = now()
    const framesLately = d.lastFrameAt !== null && t - d.lastFrameAt < FPS_PID_RESCAN_MS
    const every = d.measuring && framesLately ? FPS_PID_REFRESH_MS : FPS_PID_RESCAN_MS
    if (!force && t - d.lastScan < every) return
    d.lastScan = t
    const pids = await gamePids()
    if (!pids.length) {
      d.measuring = false
      return
    }
    const samePids = pids.length === d.pids.length && pids.every((p) => d.pids.includes(p))
    if (d.measuring && samePids) return
    if (!samePids) {
      // Other processes to measure: whatever made PresentMon stop may not apply to them.
      d.fpsFails = 0
      d.fpsRetryAt = 0
    } else if (t < d.fpsRetryAt) return
    d.pids = pids
    try {
      await client.fpsStart(pids)
      d.measuring = true
    } catch (err) {
      d.measuring = false
      fpsFailed(d, t, `it did not start: ${errorText(err)}`)
    }
  }

  /** PresentMon stopped or did not start for the same pids: wait longer before each restart, and log it once. */
  function fpsFailed(d: NonNullable<typeof dyn>, t: number, why: string): void {
    d.fpsFails++
    const wait = FPS_RESTART_BACKOFF_MS[Math.min(d.fpsFails, FPS_RESTART_BACKOFF_MS.length) - 1]!
    d.fpsRetryAt = t + wait
    if (d.fpsFails === 1)
      log.warn(
        `performance: measuring frames stopped (${why}); retrying in ${wait / 1000} s, then less often`
      )
  }

  function dynamicConfig(d: NonNullable<typeof dyn>): DynamicConfig {
    return {
      ...DYNAMIC_DEFAULTS,
      targetFps: targetFps(),
      limits: dynamicLimits(d.device, perf().dynamic ?? { minWatts: null, maxWatts: null }),
      boostMax: d.device.max,
      minWriteMs: backend?.method === 'asus-wmi' ? ASUS_MIN_WRITE_MS : 0
    }
  }

  /** One second of Dynamic TDP: read the frame rate, step the controller, write what changed, emit the readout. */
  async function dynamicTick(): Promise<void> {
    const d = dyn
    if (!d || disposed || !backend) return
    let fps: number | null = null
    let frameTimeMs: number | undefined
    try {
      await ensureFps(false)
      if (d.measuring && client?.fps) {
        const r = await client.fps()
        fps = r.fps
        frameTimeMs = r.frameTimeMs
        if (fps !== null) {
          d.lastFrameAt = now()
          d.fpsFails = 0
          d.fpsRetryAt = 0
        }
        // PresentMon stopped: every measured process exited (a launcher handed over to the game; the pids looked up
        // again differ, so it starts at once) or PresentMon itself exited (the same pids: restarted after a wait).
        if (!r.running) {
          if (fps === null) fpsFailed(d, now(), 'PresentMon is not running')
          d.measuring = false
          d.lastScan = 0
        }
      }
      d.failures = 0
    } catch (err) {
      if (d.failures++ === 0)
        log.warn(`performance: reading the frame rate failed: ${errorText(err)}`)
      d.measuring = false
    }
    if (dyn !== d) return
    const { state, write } = dynamicStep(d.state, fps, now(), dynamicConfig(d))
    d.state = state
    if (write) {
      try {
        await backend.set(write.watts, write.boostWatts)
        wattsSet = write
      } catch (err) {
        log.warn(`performance: Dynamic TDP could not set ${write.watts} W: ${errorText(err)}`)
        // Not in force: the next tick writes it again.
        if (dyn === d) d.state = { ...d.state, written: false }
      }
    }
    d.status = {
      targetFps: targetFps(),
      state: state.phase,
      ...(state.ema !== null ? { fps: Math.round(state.ema * 10) / 10 } : {}),
      ...(fps !== null && frameTimeMs !== undefined ? { frameTimeMs } : {}),
      ...(state.written ? { watts: state.watts } : {})
    }
    // The readout: at most one event a tick, and only when it changed (fps rounded to whole frames).
    const key = JSON.stringify({
      ...d.status,
      fps: d.status.fps && Math.round(d.status.fps),
      frameTimeMs: 0
    })
    if (key !== d.lastEmitted) {
      d.lastEmitted = key
      emit()
    }
  }

  /** Dynamic TDP during a game: start the controller (from the middle of the range) and its 1 s tick. */
  async function startDynamic(): Promise<string[]> {
    await stopDynamic()
    // The no-driver part goes neutral only for the game (profiles.ts saves what was there; it comes back after it).
    // First, so an earlier profile's CPU cap and power mode (Silent by hand) are not left in force when Dynamic TDP
    // cannot start below.
    const problems = await getProfiles().apply(DYNAMIC_NEUTRAL)
    if (!perf().useWatts) {
      helper = 'none'
      helperMisses = 0
      return [...problems, ...(await wattsOff()), tMain('mainPerformance.dynamic.needsHelper')]
    }
    const status = await refreshWatts()
    if (status.state !== 'ready' || !backend || helper !== 'ready') {
      // Nothing of an earlier profile (Custom watts) is written again: the helper's own restore covers the rest.
      stopTimer()
      wattsSet = null
      return [...problems, tMain('mainPerformance.dynamic.needsHelper')]
    }
    // Until the controller's first write lands, the 30 s re-apply has nothing of an earlier profile to put back.
    wattsSet = null
    const device = { min: status.minWatts ?? 5, max: status.maxWatts ?? 150 }
    const d: NonNullable<typeof dyn> = {
      state: createDynamicState(
        dynamicLimits(device, perf().dynamic ?? { minWatts: null, maxWatts: null }),
        targetFps(),
        now()
      ),
      device,
      timer: null,
      pids: [],
      measuring: false,
      lastScan: 0,
      lastFrameAt: null,
      status: { targetFps: targetFps(), state: 'measuring' },
      lastEmitted: '',
      failures: 0,
      fpsFails: 0,
      fpsRetryAt: 0
    }
    dyn = d
    d.timer = getIo().setInterval(() => {
      void serial(dynamicTick).catch((err) => log.warn(`performance: ${errorText(err)}`))
    }, DYNAMIC_TICK_MS)
    await ensureFps(true)
    await dynamicTick()
    startTimer()
    return problems
  }

  /** A saved choice as it is now: the default (or the running game's own) is read again; the rest as they are. */
  function savedChoice(c: Chosen): Choice {
    if (c.why !== 'default') return c.choice
    return gameId ? (gameProfileOf(gameId) ?? perf().defaultProfile) : perf().defaultProfile
  }

  /**
   * The helper's readiness changed since the choice in effect went on (it compiles its C# for a while after boot,
   * was installed, removed, crashed or is outdated): the choice goes in effect again as it applies now (Dynamic TDP
   * for 'auto', 'dynamic' and the fallback profiles with the helper; without, 'auto' as 'none', 'dynamic' as
   * Balanced, a fallback profile as itself). Also when Dynamic TDP is in effect in a game without its controller (it
   * found the helper not answering when it went on, before that counted as gone). Null when nothing changed.
   */
  async function reEffect(): Promise<PerformanceStatus | null> {
    if (!chosen) return null
    const stalled =
      active === 'dynamic' && !!gameId && !dyn && helper === 'ready' && watts.state === 'ready'
    if ((helper === 'ready') === chosen.ready && !stalled) return null
    return effect(savedChoice(chosen), chosen.why)
  }

  /** Put a profile (or Windows' own settings) in effect; resolves with the status emitted. */
  async function effect(choice: Choice, why: Source, retry = true): Promise<PerformanceStatus> {
    const problems: string[] = []
    await stopDynamic()
    const profile = await resolve(choice)
    // What this choice does depends on the helper: reEffect puts it in effect again when its readiness changes.
    chosen =
      choice === 'auto' || choice === 'dynamic' || isFallback(choice)
        ? { choice, why, ready: helper === 'ready' }
        : null
    manualNone = choice === 'none' && why === 'manual'
    if (profile === 'none') {
      problems.push(...(await getProfiles().restore()))
      problems.push(...(await wattsOff()))
      active = null
      source = null
    } else if (profile === 'dynamic') {
      // Set first: the controller's target depends on why Dynamic TDP is on (the game's own target or not).
      active = 'dynamic'
      source = why
      if (gameId) problems.push(...(await startDynamic()))
      else {
        // Outside games Windows keeps its own settings, as with 'none' (what a session changed is put back); in a
        // game startDynamic makes the no-driver part neutral and the controller takes the watts over.
        problems.push(...(await getProfiles().restore()))
        problems.push(...(await wattsOff()))
      }
    } else {
      const config = profileConfig(perf(), profile)
      problems.push(...(await getProfiles().apply(config)))
      problems.push(...(await applyWatts(config)))
      active = profile
      source = why
    }
    // The helper's readiness changed while this went on (watts read for the profile, Dynamic TDP that found no
    // helper): once more, as the choice applies now.
    if (retry && chosen && (helper === 'ready') !== chosen.ready)
      return effect(savedChoice(chosen), chosen.why, false)
    error = problems.length ? problems.join(' ') : undefined
    if (error) log.warn(`performance: ${profile}: ${error}`)
    else log.info(`performance: ${profile} (${why ?? 'none'})`)
    return emit()
  }

  function gameProfileOf(id: string): PowerChoice | null {
    if (!perf().perGame) return null
    return deps.library.getGame(id)?.user?.performance?.profile ?? null
  }

  function onSessionStarted(id: string): Promise<PerformanceStatus> {
    return serial(async () => {
      if (!gameId) beforeGame = { active, source, chosen }
      gameId = id
      const own = gameProfileOf(id)
      if (own) return effect(own, 'game')
      return effect(perf().defaultProfile, 'default')
    })
  }

  function onSessionEnded(id: string): Promise<PerformanceStatus> {
    return serial(async () => {
      if (gameId !== id) return snapshot()
      gameId = undefined
      const before = beforeGame
      beforeGame = null
      if (before?.source === 'manual' && before.active)
        return effect(before.chosen?.choice ?? before.active, 'manual')
      return effect(perf().defaultProfile, 'default')
    })
  }

  function onSettings(): void {
    const p = perf()
    const key = JSON.stringify(p)
    if (key === lastPerf) return
    const previous = lastPerf ? (JSON.parse(lastPerf) as Settings['performance']) : null
    lastPerf = key
    if (!previous) return
    void serial(async () => {
      if (previous.dynamic?.targetFps !== p.dynamic?.targetFps) manualTarget = null
      if (
        !gameId &&
        (source === 'default' || source === null) &&
        previous.defaultProfile !== p.defaultProfile
      )
        return effect(p.defaultProfile, 'default')
      if (previous.useWatts !== p.useWatts) {
        // Watts on or off: the helper is ready or not now (read first, so nothing stale is used).
        await refreshWatts(p.useWatts)
        if (!manualNone) {
          // That changes what 'auto', 'dynamic' and the fallback profiles do: put the choice in effect again (the
          // default when it is what is in effect, else the choice as saved; Windows' own by hand stays as it is).
          if (source === 'default' || source === null)
            return effect(
              gameId ? (gameProfileOf(gameId) ?? p.defaultProfile) : p.defaultProfile,
              source ?? 'default'
            )
          if (chosen) return effect(savedChoice(chosen), chosen.why)
          if (active) return effect(active, source)
        }
      }
      // The profile in effect changed (Settings, or the overlay's CPU boost tile: its own or a preset's override).
      if (
        active &&
        active !== 'dynamic' &&
        JSON.stringify(profileConfig(previous, active)) !== JSON.stringify(profileConfig(p, active))
      )
        return effect(active, source)
      // Dynamic TDP reads its target, floor and ceiling every tick.
      if (active === 'dynamic' && dyn) dyn.status = { ...dyn.status, targetFps: targetFps() }
      return emit()
    }).catch((err) => log.warn(`performance: settings change: ${errorText(err)}`))
  }

  /** When rtssHelper() or memoryHelper() last asked a helper that was not ready. */
  let rtssCheckedAt: number | null = null

  /**
   * The helper's client when it is installed, answering and at protocol `version` or later; null otherwise. A helper
   * that is not ready is asked again at most every RTSS_HELPER_RECHECK_MS.
   */
  async function readyClient(version: number): Promise<HelperClient | null> {
    if (disposed) return null
    const b = await getBackend()
    if (!b || b.method === 'asus-wmi') return null
    const isReady = (): boolean => watts.state === 'ready' && (watts.helperVersion ?? 0) >= version
    // Not answering (or not read with its version yet): ask the helper again, but not on every overlay refresh.
    if (!isReady() && (rtssCheckedAt === null || now() - rtssCheckedAt >= RTSS_HELPER_RECHECK_MS)) {
      rtssCheckedAt = now()
      await serial(async () => {
        await refreshWatts(true)
        await reEffect()
      }).catch((err) => log.warn(`performance: reading the power helper failed: ${errorText(err)}`))
    }
    return isReady() ? client : null
  }

  return {
    start() {
      if (unsubs.length || disposed) return
      lastPerf = JSON.stringify(perf())
      const failed = (err: unknown): void => log.warn(`performance: ${errorText(err)}`)
      unsubs = [
        deps.events.on('session:started', (e) => void onSessionStarted(e.gameId).catch(failed)),
        deps.events.on('session:ended', (e) => void onSessionEnded(e.gameId).catch(failed)),
        deps.settings.onChange(onSettings)
      ]
      const running = deps.launcher.running()
      void serial(async () => {
        if (!running) {
          const def = perf().defaultProfile
          if (def !== 'none') return effect(def, 'default')
          // A profile left on by a crash: 'none' means Windows as it was.
          if (await getProfiles().hasBefore()) return effect('none', null)
        }
        return snapshot()
      })
        .then(async () => {
          if (running) await onSessionStarted(running.gameId)
          // With watts on, the helper is started now (so it answers at once when the overlay opens).
          if (!wattsSet) await serial(() => refreshWatts(perf().useWatts))
          if (!(await serial(reEffect))) emit()
        })
        .catch(failed)
    },

    status: snapshot,

    refresh() {
      return serial(async () => {
        await refreshWatts()
        return (await reEffect()) ?? emit()
      })
    },

    apply(profile, forGame, options) {
      return serial(async () => {
        const running = deps.launcher.running()?.gameId
        const wanted =
          typeof options?.targetFps === 'number' && Number.isFinite(options.targetFps)
            ? clampFps(options.targetFps)
            : undefined
        // api.ts: a game id keeps the profile as that game's own ('none' clears it); null clears the running game's.
        if (forGame !== undefined) {
          const target = forGame ?? running
          const keep = forGame !== null && profile !== 'none'
          // With the helper a fallback profile is kept as Dynamic TDP (what it runs as).
          const saved =
            profile === 'none'
              ? null
              : helper === 'ready' && isFallback(profile)
                ? 'dynamic'
                : profile
          if (target) {
            // Dynamic TDP keeps the game's own target (a new one, or the one it had).
            const had = deps.library.getGame(target)?.user?.performance?.targetFps
            const targetFps = saved === 'dynamic' ? (wanted ?? had) : undefined
            deps.library.updateGame(target, {
              user: {
                performance:
                  keep && saved
                    ? { profile: saved, ...(targetFps !== undefined ? { targetFps } : {}) }
                    : null
              }
            })
          }
        } else if (profile === 'dynamic' && wanted !== undefined) manualTarget = wanted
        const ownForRunning = running !== undefined && forGame === running && profile !== 'none'
        const why: Source = ownForRunning ? 'game' : 'manual'
        // Only the target changed: the controller keeps running and picks it up on its next tick.
        if (profile === 'dynamic' && active === 'dynamic' && (dyn || !gameId)) {
          source = why
          chosen = { choice: 'dynamic', why, ready: helper === 'ready' }
          if (dyn) dyn.status = { ...dyn.status, targetFps: targetFps() }
          return emit()
        }
        return effect(profile, why)
      })
    },

    installHelper() {
      return serial(async () => {
        const b = await getBackend()
        if (!b || b.method === 'asus-wmi') {
          error = b ? tMain('mainPerformance.watts.noHelperNeeded') : unsupportedMessage()
          return emit()
        }
        const result = await getIo().install(b.module!, await getSid())
        error = result.ok ? undefined : result.message
        if (result.ok) {
          // The install started the task; the helper compiles its C# before its pipe is there.
          try {
            await (await getClient()).waitUntilRunning?.(HELPER_START_MS)
          } catch (err) {
            log.warn(`performance: the power helper did not start: ${errorText(err)}`)
            // Installed, but not serving: say so (a reinstall would not help), with what went wrong.
            error = tMain('mainPerformance.helper.didNotStart', { error: errorText(err) })
          }
        }
        await refreshWatts()
        if (result.ok && helper === 'ready') {
          // What waited for the helper ('auto', 'dynamic' or a fallback profile, as Dynamic TDP) goes on now.
          const done = await reEffect()
          if (done) return done
        }
        if (result.ok && helper === 'ready' && (active === 'dynamic' || source !== 'manual')) {
          // Dynamic TDP (or the 'auto' default) can start now.
          const own = gameId ? gameProfileOf(gameId) : null
          if (active === 'dynamic') return effect('dynamic', source)
          if (!own && perf().defaultProfile === 'auto') return effect('auto', 'default')
        }
        if (result.ok && active && active !== 'dynamic') {
          const problems = await applyWatts(profileConfig(perf(), active))
          if (problems.length) error = problems.join(' ')
        }
        return emit()
      })
    },

    removeHelper() {
      return serial(async () => {
        const b = await getBackend()
        if (b && b.method !== 'asus-wmi') {
          await stopDynamic()
          const problems = await wattsOff()
          client?.close()
          client = null
          const result = await getIo().remove()
          error = result.ok ? problems.join(' ') || undefined : result.message
        }
        const removing = error
        await refreshWatts(true, true)
        // A choice that ran as Dynamic TDP goes back to what it is without the helper.
        if (await reEffect()) error = [removing, error].filter(Boolean).join(' ') || undefined
        return emit()
      })
    },

    resume() {
      return serial(reapplyWatts)
    },

    async rtssHelper() {
      const c = await readyClient(HELPER_RTSS_VERSION)
      if (!c?.rtssLimit || !c.rtssSelf || !c.rtssRestore) return null
      return {
        rtssLimit: (exe, fps) => c.rtssLimit!(exe, fps),
        rtssSelf: (exe) => c.rtssSelf!(exe),
        rtssRestore: () => c.rtssRestore!()
      }
    },

    async memoryHelper() {
      const c = await readyClient(HELPER_MEMORY_VERSION)
      if (!c?.memoryTrim) return null
      return { memoryTrim: (pids, options) => c.memoryTrim!(pids, options) }
    },

    memoryTier() {
      // Not looked at yet (early in the start): nothing is claimed about this PC.
      if (backend === undefined) return 'unknown'
      if (backend === null || backend.method === 'asus-wmi') return 'unavailable'
      // Installed and not asked yet (no version read): its helper.ps1 is this version's, so it has the operation.
      if (watts.state === 'ready')
        return (watts.helperVersion ?? HELPER_MEMORY_VERSION) >= HELPER_MEMORY_VERSION
          ? 'ready'
          : 'outdated'
      if (watts.state === 'not-installed')
        return isHelperOutdatedMessage(watts.message) ? 'outdated' : 'missing'
      // Installed but not answering: the row offers Remove only, then Install.
      return watts.state === 'error' ? 'not-answering' : 'unavailable'
    },

    async dispose() {
      if (disposed) return
      disposed = true
      for (const u of unsubs) u()
      unsubs = []
      stopTimer()
      syncRecheck()
      await serial(async () => {
        await stopDynamic()
        if (wattsSet) await wattsOff()
        const problems = await getProfiles()
          .restore()
          .catch((err) => [errorText(err)])
        if (problems.length) log.warn(`performance: restoring on exit: ${problems.join(' ')}`)
      })
      client?.close()
      client = null
      io?.dispose?.()
    }
  }
}
