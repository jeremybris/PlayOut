import type { DisplayStatus, OverlayState, PerformanceStatus } from '../../shared/overlay'
import {
  FRAME_LIMIT_MAX,
  frameLimitOptions,
  RTSS_OSD_VERIFIED,
  RTSS_TILES_VERIFIED,
  type AutoHdrStatus,
  type BoostPresetId,
  type CpuBoostStatus,
  type FrameLimitStatus,
  type LiveStats,
  type OverlayExtrasStatus,
  type PerfOverlayLevel,
  type PerfOverlayStatus,
  type RtssStatus,
  type SyncRefreshStatus
} from '../../shared/overlay-extras'
import type { PerfSample, Settings, SettingsPatch, SystemStatus } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import type { HdrState } from '../native-host/native-ops'
import { isHelperOutdatedMessage } from '../performance/backends'
import { profileConfig, type PerformanceService } from '../performance/service'
import { isProfileExe } from '../rtss/memory'
import { osdText, type OsdStats } from '../rtss/osd-text'
import type { RtssService } from '../rtss/service'
import { execCommand, type CommandRunner } from '../system/power'
import type { AutoHdr } from './auto-hdr'
import type { GameExtrasStore } from './game-extras-store'
import { isShellProgram } from './overlay-logic'
import { tMain } from '../i18n'

/**
 * The overlay's extra tiles and header chips (docs/home-overlay.md, Overlay extras), in the main process:
 *
 * - Frame rate limit: per game, written by the power helper into RivaTuner's own profile of the game's exe
 *   (Profiles\<exe>.cfg [Framerate] Limit, never the Global profile) and remembered in game-extras.json. Limits stay
 *   in the game's profile after it exits (RTSS applies them by itself) and are put on again when it starts.
 * - Sync FPS + refresh: the limit follows the display's refresh rate while on (a global setting that never overwrites
 *   a game's own choice) for games PlayOut started only, never a program the overlay opened over; an explicit pick
 *   turns it off. Every exe a sync limit was written to is remembered in game-extras.json, so turning sync off takes
 *   each one off again, with or without a game running and after a restart.
 * - Performance overlay: PlayOut's own levels, drawn by RTSS from PlayOut's OSD slot, updated once a second while a
 *   PlayOut game runs (also with the overlay closed); the slot is released at Off, when the game ends, on quit, and at
 *   start (a slot a crashed PlayOut left behind), and a release that did not go through is tried again.
 *
 * The frame limit, sync and performance overlay tiles are offered only once an in-game check passed (RTSS_TILES_VERIFIED,
 * or PLAYOUT_RTSS_TILES=1 for that check): until then they are hidden, nothing is limited or drawn, and only clean-up
 * (sync limits taken off, a left-behind OSD slot released) runs.
 * - Auto HDR (auto-hdr.ts), CPU boost (the profile in effect: Custom's own, or a preset's override that the
 *   performance service applies on top of it), and the live fps and watts for the header chips.
 */

/** How long the game's processes are reused before being listed again, ms. */
export const PIDS_CACHE_MS = 5_000
/** The performance overlay's update interval, ms. */
export const OSD_TICK_MS = 1_000
/** At game start: how often RTSS's hooked exe is looked for, and for how long before the process name is used. */
export const HOOK_RETRY_MS = 5_000
export const HOOK_WAIT_MS = 60_000
/** After that, for the rest of the session: how often a newly hooked exe (the game after its launcher) is looked for. */
export const HOOK_WATCH_MS = 10_000
/** A performance overlay release that did not go through is tried again this often, this many times. */
export const OSD_RELEASE_RETRY_MS = 5_000
export const OSD_RELEASE_RETRIES = 12
/** The power helper's watts are read again at most this often for the chips and the overlay, ms. */
export const WATTS_REFRESH_MS = 5_000
/** Battery, Windows HDR and Auto HDR readings are reused this long, ms. */
export const SLOW_CACHE_MS = 10_000
/** Whether Winhanced runs is looked up again after this long, ms. */
export const CLASH_CACHE_MS = 60_000

export const autoHdrNote = (): string => tMain('mainOverlay.extras.autoHdrNote')
export const clashText = (): string => tMain('mainOverlay.extras.winhancedClash')
const hdrOff = (): string => tMain('mainOverlay.extras.hdrOff')
const startGame = (): string => tMain('mainOverlay.extras.startGame')
const waitingForGame = (): string => tMain('mainOverlay.extras.waiting')
export const notVerified = (): string => tMain('mainOverlay.extras.notVerified')
export const notOnThisPc = (): string => tMain('mainOverlay.extras.notOnThisPc')
export const playoutGamesOnly = (): string => tMain('mainOverlay.extras.playoutGamesOnly')

export interface OverlayExtrasDeps {
  settings: {
    get(): Settings
    update(patch: SettingsPatch): Settings
    /** Replace semantics (removing a preset's boost override); without it the override is set to the preset's value. */
    mutate?(mutator: (settings: Settings) => void): Settings
    onChange(listener: (settings: Settings) => void): () => void
  }
  events: Pick<EventBus, 'emit' | 'on'>
  log: Logger
  launcher: {
    running(): { gameId: string; pid?: number } | null
    gameProcesses?(): Promise<{ pid: number; name?: string }[]>
  }
  overlay: { state(): OverlayState }
  performance: Pick<PerformanceService, 'status' | 'rtssHelper' | 'refresh'>
  rtss: RtssService
  display(): Promise<DisplayStatus | null>
  hdrState(device: string): Promise<HdrState | null>
  autoHdr: AutoHdr
  store: GameExtrasStore
  system: { perf(): Promise<PerfSample>; status(): Promise<SystemStatus> }
  /** PlayOut's own exe name for RTSS's "do not hook" profile; null in development (electron.exe is not PlayOut). */
  selfExe: string | null
  /** The frame limit and sync tiles are offered (default: rtssTilesOffered()). */
  rtssTiles?: boolean
  /** The performance overlay tile is offered (default: RTSS_OSD_VERIFIED or rtssTilesOffered()). */
  osdTile?: boolean
  /** Tests: tasklist.exe for the Winhanced check. */
  run?: CommandRunner
  setInterval?(fn: () => void, ms: number): unknown
  clearInterval?(handle: unknown): void
  now?(): number
}

export interface OverlayExtras {
  start(): void
  status(): Promise<OverlayExtrasStatus>
  liveStats(): Promise<LiveStats>
  setFrameLimit(fps: number): Promise<OverlayExtrasStatus>
  setSync(enabled: boolean): Promise<OverlayExtrasStatus>
  setPerfOverlay(level: PerfOverlayLevel): Promise<OverlayExtrasStatus>
  setAutoHdr(enabled: boolean): Promise<OverlayExtrasStatus>
  setCpuBoost(enabled: boolean): Promise<OverlayExtrasStatus>
  /** suite.setDisplayMode calls this after a successful change (sync re-applies). */
  displayChanged(): Promise<void>
  /**
   * Before the power helper is removed: every RivaTuner profile PlayOut changed is put back through it, then the frame
   * limits and sync records are forgotten. Never throws (without a helper the helper keeps its records for later).
   */
  beforeHelperRemoved(): Promise<void>
  dispose(): Promise<void>
}

/** What the frame limit applies to. `via` says how the exe was found. */
interface Target {
  /** A PlayOut game id, or 'exe:<lower-case exe>'. */
  key: string
  exe: string
  gameId?: string
  via: 'hooked' | 'stored' | 'process' | 'program'
}

type Resolved = { target: Target; reason?: undefined } | { target: null; reason: string }

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const lower = (s: string): string => s.toLowerCase()
const isPreset = (p: string): p is BoostPresetId =>
  p === 'silent' || p === 'balanced' || p === 'performance'

/** The RTSS tiles are offered: after the in-game check (RTSS_TILES_VERIFIED), or for that check (PLAYOUT_RTSS_TILES=1). */
export function rtssTilesOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return RTSS_TILES_VERIFIED || env.PLAYOUT_RTSS_TILES === '1'
}

/** Winhanced's processes in `tasklist /FO CSV /NH` output. */
export function winhancedRunning(stdout: string): boolean {
  return stdout
    .split(/\r?\n/)
    .map((l) => /^"([^"]+)"/.exec(l)?.[1] ?? '')
    .some((name) => /^(winhanced|whservice)/i.test(name))
}

/** Settings' CPU boost tile state for the profile in effect. */
export function cpuBoostStatus(
  p: Settings['performance'],
  active: PerformanceStatus['active']
): CpuBoostStatus {
  if (active === null)
    return {
      enabled: false,
      available: false,
      reason: tMain('mainOverlay.extras.chooseProfile'),
      profile: null,
      overridden: false
    }
  if (active === 'dynamic')
    // Dynamic TDP keeps boost on (its neutral no-driver part) and moves the watts itself.
    return {
      enabled: true,
      available: false,
      reason: tMain('mainOverlay.extras.dynamicTdp'),
      profile: 'dynamic',
      overridden: false
    }
  const override = isPreset(active) ? p.boostOverrides?.[active] : undefined
  return {
    enabled: profileConfig(p, active).cpuBoost,
    available: true,
    profile: active,
    overridden: typeof override === 'boolean' && override !== p.profiles[active].cpuBoost
  }
}

export function createOverlayExtras(deps: OverlayExtrasDeps): OverlayExtras {
  const { log, rtss, store } = deps
  const now = (): number => deps.now?.() ?? Date.now()
  const setTimer = (fn: () => void, ms: number): unknown =>
    deps.setInterval ? deps.setInterval(fn, ms) : setInterval(fn, ms)
  const clearTimer = (h: unknown): void => {
    if (h === null || h === undefined) return
    if (deps.clearInterval) deps.clearInterval(h)
    else clearInterval(h as NodeJS.Timeout)
  }
  const run = deps.run ?? execCommand
  const perf = (): Settings['performance'] => deps.settings.get().performance
  const rtssTiles = deps.rtssTiles ?? rtssTilesOffered()
  const osdTile = deps.osdTile ?? (RTSS_OSD_VERIFIED || rtssTilesOffered())
  /** Sync in effect: offered and on. */
  const syncOn = (): boolean => rtssTiles && perf().syncFpsToRefresh

  let started = false
  let disposed = false
  let unsubs: (() => void)[] = []

  /** Every RivaTuner profile write goes through one queue (a pick never races the game-start re-apply). */
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  // --- cached readings ---------------------------------------------------------------------------------------------

  /** A value read at most every `ms` (a failed read is not kept). */
  function cached<T>(ms: number, read: () => Promise<T>): { get(): Promise<T>; clear(): void } {
    let entry: { at: number; value: Promise<T> } | null = null
    return {
      get() {
        if (entry && now() - entry.at < ms) return entry.value
        const value = read()
        const e = { at: now(), value }
        entry = e
        value.catch(() => {
          if (entry === e) entry = null
        })
        return value
      },
      clear() {
        entry = null
      }
    }
  }

  let procs: { at: number; gameId: string; list: { pid: number; name?: string }[] } | null = null
  /** The running game's processes (with the spawned one), reused for PIDS_CACHE_MS. */
  async function gameProcesses(): Promise<{ pid: number; name?: string }[]> {
    const running = deps.launcher.running()
    if (!running) return []
    if (procs && procs.gameId === running.gameId && now() - procs.at < PIDS_CACHE_MS)
      return procs.list
    const list = ((await deps.launcher.gameProcesses?.().catch(() => [])) ?? []).filter(
      (p) => Number.isInteger(p.pid) && p.pid > 4
    )
    if (running.pid && !list.some((p) => p.pid === running.pid)) list.push({ pid: running.pid })
    procs = { at: now(), gameId: running.gameId, list }
    return list
  }
  const gamePids = async (): Promise<number[]> => (await gameProcesses()).map((p) => p.pid)

  const display = cached(PIDS_CACHE_MS, () => deps.display().catch(() => null))
  const currentHz = async (): Promise<number | undefined> => {
    const d = await display.get()
    const hz = d?.current.hz
    return typeof hz === 'number' && Number.isFinite(hz) && hz > 1 ? Math.round(hz) : undefined
  }
  const hdr = cached(SLOW_CACHE_MS, async () => {
    const d = await display.get()
    return d ? await deps.hdrState(d.name).catch(() => null) : null
  })
  const autoHdrValue = cached(SLOW_CACHE_MS, () => deps.autoHdr.read())
  const battery = cached(SLOW_CACHE_MS, async () => {
    const s = await deps.system.status().catch(() => null)
    return s?.battery?.present ? s.battery.percent : null
  })
  const clash = cached(CLASH_CACHE_MS, async () => {
    const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], 10_000)
    return r.code === 0 && winhancedRunning(r.stdout)
  })

  async function rtssStatus(fresh = false): Promise<RtssStatus> {
    return rtss.status(fresh).catch((err) => {
      log.debug(`extras: RTSS status: ${errorText(err)}`)
      return { state: 'missing' } as RtssStatus
    })
  }

  /** Watts for the chips and the overlay: Dynamic TDP's, else the helper's reading; asked again every 5 s. */
  let wattsReadAt = 0
  function watts(ps: PerformanceStatus): number | null {
    if (ps.watts.state !== 'ready') return null
    if (now() - wattsReadAt >= WATTS_REFRESH_MS) {
      wattsReadAt = now()
      void deps.performance.refresh().catch(() => undefined)
    }
    const w = ps.dynamic?.watts ?? ps.watts.currentWatts
    return typeof w === 'number' && Number.isFinite(w) ? Math.round(w) : null
  }

  // --- target and availability ---------------------------------------------------------------------------------------

  /**
   * The program the frame limit applies to. A running PlayOut game: the exe RTSS hooked for its processes, else the
   * exe its limit was written to before, else (`fallback`) its spawned process's name. Otherwise the program the
   * overlay opened over.
   */
  async function resolveTarget(fallback: boolean, rtssRunning: boolean): Promise<Resolved> {
    const running = deps.launcher.running()
    if (running) {
      const key = running.gameId
      const list = await gameProcesses()
      if (rtssRunning) {
        const hooked = await rtss
          .hookedExe(list.map((p) => p.pid))
          .catch((err) => (log.debug(`extras: hooked exe: ${errorText(err)}`), null))
        if (hooked && isProfileExe(hooked))
          return { target: { key, exe: hooked, gameId: key, via: 'hooked' } }
      }
      const stored = store.get(key)?.exe
      if (stored && isProfileExe(stored))
        return { target: { key, exe: stored, gameId: key, via: 'stored' } }
      if (fallback) {
        const own = list.find((p) => p.pid === running.pid)?.name ?? list.find((p) => p.name)?.name
        if (own && isProfileExe(own))
          return { target: { key, exe: own, gameId: key, via: 'process' } }
      }
      return { target: null, reason: waitingForGame() }
    }
    // Windows' shell, Steam, PlayOut and other launchers are never limited (the overlay over the desktop is no game).
    const program = deps.overlay.state().program
    if (program && isProfileExe(program) && !isShellProgram(program))
      return { target: { key: `exe:${lower(program)}`, exe: program, via: 'program' } }
    return { target: null, reason: startGame() }
  }

  /** Why RivaTuner limits cannot be written now (RTSS, then the power helper); undefined when they can. */
  async function writeReason(r: RtssStatus): Promise<string | undefined> {
    if (r.state === 'missing') return 'Needs RivaTuner Statistics Server'
    if (r.state === 'stopped') return tMain('mainOverlay.extras.rtssStopped')
    const helper = await deps.performance.rtssHelper().catch(() => null)
    if (helper) return undefined
    const ps = deps.performance.status()
    // No helper method on this PC (or ASUS firmware watts, which never use it): Settings offers nothing to install.
    if (ps.watts.state === 'unsupported' || ps.watts.method === 'asus-wmi') return notOnThisPc()
    const outdated =
      ps.helper === 'outdated' ||
      isHelperOutdatedMessage(ps.watts.message) ||
      (ps.watts.state === 'ready' && ps.watts.helperVersion !== undefined)
    return outdated
      ? tMain('mainOverlay.extras.updateHelper')
      : tMain('mainOverlay.extras.needsHelper')
  }

  // --- frame limit ---------------------------------------------------------------------------------------------------

  /**
   * Put the limit in effect for a target: the display's rate with sync on, else the game's own choice (0 puts back
   * what was there before PlayOut, which also takes off an earlier sync limit). A limit written to another exe for the
   * same game before is taken off it, and the game's record moves to the new exe.
   */
  async function applyFor(t: Target): Promise<void> {
    const stored = store.get(t.key)
    // Sync is for PlayOut's games only: a program the overlay opened over keeps its own choice.
    const hz = syncOn() && t.via !== 'program' ? await currentHz() : undefined
    const fps = hz ?? stored?.frameLimit ?? 0
    for (const old of [stored?.exe, store.getSynced(t.key)]) {
      if (old && lower(old) !== lower(t.exe)) {
        await rtss
          .setFrameLimit(old, 0)
          .catch((err) => log.warn(`extras: taking the limit off ${old}: ${errorText(err)}`))
      }
    }
    if (stored && lower(stored.exe) !== lower(t.exe))
      await store.set(
        t.key,
        stored.frameLimit ? { frameLimit: stored.frameLimit, exe: t.exe } : null
      )
    await rtss.setFrameLimit(t.exe, fps)
    await store.setSynced(t.key, hz ? t.exe : null)
    log.info(
      `extras: frame limit ${fps || 'off'} for ${t.exe}${hz ? ' (follows the display)' : ''}`
    )
  }

  /**
   * Take every sync limit off (sync is off): each exe a sync limit was written to gets its game's own choice back
   * when it is that choice's exe, else nothing (0 puts back what was there). `skip` is the key applyFor handles.
   */
  async function unsyncAll(skip?: string): Promise<void> {
    for (const [key, exe] of store.allSynced()) {
      if (key === skip) continue
      const stored = store.get(key)
      const fps = stored && lower(stored.exe) === lower(exe) ? stored.frameLimit : 0
      try {
        await rtss.setFrameLimit(exe, fps)
        await store.setSynced(key, null)
        log.info(`extras: sync limit taken off ${exe}`)
      } catch (err) {
        log.warn(`extras: taking the sync limit off ${exe}: ${errorText(err)}`)
      }
    }
  }

  /**
   * Re-apply when limits can be written (sync changes, display changes): sync off takes every sync limit off; then
   * the running PlayOut game gets the limit in effect. A program the overlay opened over is never touched here.
   */
  async function applyCurrent(why: string): Promise<void> {
    const r = await rtssStatus()
    if (await writeReason(r)) return
    const resolved = rtssTiles && deps.launcher.running() ? await resolveTarget(true, true) : null
    const t = resolved?.target && resolved.target.via !== 'program' ? resolved.target : null
    if (!syncOn()) await unsyncAll(t?.key)
    if (!t) return
    await applyFor(t).catch((err) => log.warn(`extras: frame limit (${why}): ${errorText(err)}`))
  }

  /** At start and when the helper becomes ready: sync limits left on while sync is off are taken off. */
  async function cleanUpSynced(): Promise<void> {
    if (disposed || syncOn() || !store.allSynced().length) return
    if (await writeReason(await rtssStatus())) return
    await unsyncAll()
  }

  /**
   * At game start: put the limit (sync or the game's own choice) on as soon as the game's exe is known. RTSS hooks a
   * game some seconds after it starts; until then the exe its limit was written to before is used, and after
   * HOOK_WAIT_MS without a hook the spawned process's name.
   */
  let hookTimer: unknown = null
  /** Bumped by every game start and stop: a step of an earlier game never touches the timer. */
  let hookRun = 0
  function stopHookWait(): void {
    hookRun++
    clearTimer(hookTimer)
    hookTimer = null
  }
  function onGameStart(gameId: string): void {
    stopHookWait()
    procs = null
    if (!rtssTiles) return
    const runId = hookRun
    const since = now()
    let appliedTo: string | null = null
    let busy = false
    // Settled: the hooked exe (or, after HOOK_WAIT_MS, the fallback) has the limit. The session is still watched
    // (HOOK_WATCH_MS): a game RTSS hooks after its launcher, or after a long login or shader compile, gets it then.
    let settled = false
    type Step = 'stop' | 'wait' | 'settled'
    const attempt = async (): Promise<Step> => {
      const running = deps.launcher.running()
      if (disposed || !running || running.gameId !== gameId) return 'stop'
      const r = await rtssStatus()
      const final = settled || now() - since >= HOOK_WAIT_MS
      if (r.state === 'missing') return 'stop'
      // RTSS may be started after the game (it is often started on demand): keep looking.
      if (r.state !== 'running') return final ? 'settled' : 'wait'
      if (await writeReason(r)) return 'stop'
      const resolved = await resolveTarget(final, true)
      if (!resolved.target) return final ? 'settled' : 'wait'
      const t = resolved.target
      // Once settled, only an exe RTSS hooked moves the limit (never back to a fallback).
      if (settled && t.via !== 'hooked') return 'settled'
      if (!appliedTo || lower(appliedTo) !== lower(t.exe)) {
        await serial(() => applyFor(t))
        appliedTo = t.exe
        emitSoon()
      }
      return t.via === 'hooked' || final ? 'settled' : 'wait'
    }
    const step = (): void => {
      if (busy) return
      busy = true
      void attempt()
        .catch((err): Step => {
          log.warn(`extras: frame limit at game start: ${errorText(err)}`)
          return 'stop'
        })
        .then((next) => {
          busy = false
          if (runId !== hookRun) return
          if (next === 'stop') stopHookWait()
          else if (next === 'settled' && !settled) {
            settled = true
            clearTimer(hookTimer)
            hookTimer = setTimer(step, HOOK_WATCH_MS)
          }
        })
    }
    hookTimer = setTimer(step, HOOK_RETRY_MS)
    step()
  }

  // --- performance overlay -------------------------------------------------------------------------------------------

  let osdTimer: unknown = null
  let osdBusy = false
  let osdShown = false
  // A slot a crashed PlayOut left behind may still be drawn: released at start, and again until a release goes through.
  let releasePending = true
  let releaseTimer: unknown = null
  let releaseTries = 0
  function stopReleaseRetry(): void {
    clearTimer(releaseTimer)
    releaseTimer = null
    releaseTries = 0
  }

  async function osdStats(): Promise<OsdStats> {
    const ps = deps.performance.status()
    const game = await rtss.gameFps(await gamePids()).catch(() => null)
    const fps = game?.fps ?? ps.dynamic?.fps ?? null
    const frameTimeMs =
      (game ? game.frameTimeMs : ps.dynamic?.frameTimeMs) ?? (fps ? 1000 / fps : null)
    const sample = await deps.system.perf().catch(() => null)
    const ram =
      sample?.memoryUsedMb != null && sample.memoryTotalMb
        ? (100 * sample.memoryUsedMb) / sample.memoryTotalMb
        : null
    return {
      fps,
      frameTimeMs: frameTimeMs ?? null,
      cpuPercent: sample?.cpuPercent ?? null,
      gpuPercent: sample?.gpuPercent ?? null,
      watts: watts(ps),
      ramPercent: ram,
      batteryPercent: await battery.get().catch(() => null)
    }
  }

  async function osdTick(): Promise<void> {
    const level = perf().perfOverlay
    if (osdBusy || disposed || !level || !deps.launcher.running()) return
    osdBusy = true
    try {
      const text = osdText(
        level,
        await osdStats(),
        new Date(now()),
        deps.settings.get().ui.clock24h
      )
      if (disposed || !perf().perfOverlay || !osdTimer) return
      const ok = await rtss.osdWrite(text).catch((err) => {
        log.debug(`extras: OSD write: ${errorText(err)}`)
        return false
      })
      if (ok !== osdShown) {
        osdShown = ok
        emitSoon()
      }
    } finally {
      osdBusy = false
    }
  }

  /** Draw while a PlayOut game runs and the level is not 0; release the slot otherwise. */
  async function syncOsd(): Promise<void> {
    const want = !disposed && osdTile && perf().perfOverlay > 0 && deps.launcher.running() !== null
    if (want) {
      stopReleaseRetry()
      releasePending = true
      if (osdTimer === null) {
        osdTimer = setTimer(() => void osdTick(), OSD_TICK_MS)
        await osdTick()
      }
      return
    }
    if (osdTimer === null && !osdShown && !releasePending) return
    clearTimer(osdTimer)
    osdTimer = null
    const was = osdShown
    osdShown = false
    const released = await rtss.osdRelease().catch((err) => {
      log.warn(`extras: releasing the OSD: ${errorText(err)}`)
      return false
    })
    releasePending = !released
    if (!releasePending || disposed) stopReleaseRetry()
    else if (releaseTimer === null)
      releaseTimer = setTimer(() => {
        if (++releaseTries >= OSD_RELEASE_RETRIES) stopReleaseRetry()
        void syncOsd()
      }, OSD_RELEASE_RETRY_MS)
    if (was) emitSoon()
  }

  // --- self exclusion ------------------------------------------------------------------------------------------------

  let selfExcluded = false
  let selfBusy = false
  async function excludeSelf(): Promise<void> {
    const exe = deps.selfExe
    if (!exe || selfExcluded || selfBusy || disposed) return
    selfBusy = true
    try {
      const r = await rtssStatus()
      if (r.state === 'missing') return
      if (!(await deps.performance.rtssHelper().catch(() => null))) return
      await rtss.excludeSelf(exe)
      selfExcluded = true
    } catch (err) {
      log.warn(`extras: excluding ${exe} from RivaTuner: ${errorText(err)}`)
    } finally {
      selfBusy = false
    }
  }

  // --- status --------------------------------------------------------------------------------------------------------

  async function status(): Promise<OverlayExtrasStatus> {
    const p = perf()
    const r = await rtssStatus()
    const running = r.state === 'running'
    const [why, resolved, hz] = await Promise.all([
      writeReason(r),
      resolveTarget(true, running),
      currentHz()
    ])
    const t = resolved.target
    const stored = t ? store.get(t.key) : null
    const chosen = stored?.frameLimit ?? 0
    const reason = !rtssTiles ? notVerified() : (why ?? resolved.reason)
    const synced = syncOn() && hz && t?.via !== 'program'
    const frameLimit: FrameLimitStatus = {
      available: !reason,
      ...(reason ? { reason } : {}),
      fps: synced ? hz : chosen,
      chosen,
      options: frameLimitOptions(hz),
      ...(t ? { exe: t.exe } : {}),
      ...(t?.gameId ? { gameId: t.gameId } : {})
    }
    // Sync is a global setting: it can be turned on before a game runs (it applies when one starts).
    const syncReason = !rtssTiles ? notVerified() : why
    const sync: SyncRefreshStatus = {
      enabled: rtssTiles && p.syncFpsToRefresh,
      available: !syncReason,
      ...(syncReason ? { reason: syncReason } : {}),
      ...(hz ? { hz } : {})
    }
    // Drawn only while a PlayOut game runs: over a game started elsewhere, the tile says so instead of doing nothing.
    const program = deps.overlay.state().program
    const otherGame =
      !deps.launcher.running() && !!program && isProfileExe(program) && !isShellProgram(program)
    const overlayReason = !osdTile
      ? notVerified()
      : r.state === 'missing'
        ? 'Needs RivaTuner Statistics Server'
        : r.state === 'stopped'
          ? tMain('mainOverlay.extras.rtssStopped')
          : otherGame
            ? playoutGamesOnly()
            : undefined
    const perfOverlay: PerfOverlayStatus = {
      level: p.perfOverlay ?? 0,
      available: !overlayReason,
      ...(overlayReason ? { reason: overlayReason } : {}),
      drawing: osdShown
    }
    const [autoHdr, clashing] = await Promise.all([
      autoHdrStatus(),
      r.state === 'missing' ? Promise.resolve(false) : clash.get().catch(() => false)
    ])
    return {
      rtss: r,
      rtssTiles,
      osdTile,
      frameLimit,
      sync,
      perfOverlay,
      autoHdr,
      cpuBoost: cpuBoostStatus(p, deps.performance.status().active),
      ...(clashing ? { clash: clashText() } : {})
    }
  }

  async function autoHdrStatus(): Promise<AutoHdrStatus> {
    const state = await hdr.get().catch(() => null)
    const hdrOn = state ? state.enabled : null
    let enabled: boolean | null = null
    let readFailed = false
    try {
      enabled = await autoHdrValue.get()
    } catch (err) {
      readFailed = true
      log.debug(`extras: Auto HDR: ${errorText(err)}`)
    }
    const reason =
      hdrOn === false
        ? hdrOff()
        : readFailed
          ? tMain('mainOverlay.extras.autoHdrUnreadable')
          : undefined
    return {
      enabled,
      hdrOn,
      available: !reason,
      ...(reason ? { reason } : {}),
      note: autoHdrNote()
    }
  }

  let lastKey = ''
  let emitting = false
  let again = false
  /** Recompute the status and emit 'overlay:extras' when it differs from the last one sent. */
  function emitSoon(): void {
    if (disposed || !started) return
    if (emitting) {
      again = true
      return
    }
    emitting = true
    void status()
      .then((s) => {
        const key = JSON.stringify(s)
        if (key !== lastKey && !disposed) {
          lastKey = key
          deps.events.emit('overlay:extras', s)
        }
      })
      .catch((err) => log.debug(`extras: status: ${errorText(err)}`))
      .finally(() => {
        emitting = false
        if (again) {
          again = false
          emitSoon()
        }
      })
  }

  /** After a change: the status, emitted at once. */
  async function changed(): Promise<OverlayExtrasStatus> {
    const s = await status()
    lastKey = JSON.stringify(s)
    deps.events.emit('overlay:extras', s)
    return s
  }

  // --- settings changes from elsewhere ---------------------------------------------------------------------------------

  let seen = { sync: false, level: 0 as PerfOverlayLevel, boost: '' }
  const seenOf = (s: Settings): typeof seen => ({
    sync: s.performance.syncFpsToRefresh,
    level: s.performance.perfOverlay ?? 0,
    boost: JSON.stringify([s.performance.boostOverrides ?? {}, s.performance.profiles])
  })
  function onSettings(s: Settings): void {
    const next = seenOf(s)
    const prev = seen
    seen = next
    if (prev.sync !== next.sync && rtssTiles) void serial(() => applyCurrent('sync'))
    if (prev.level !== next.level) void syncOsd()
    if (prev.sync !== next.sync || prev.level !== next.level || prev.boost !== next.boost)
      emitSoon()
  }

  let lastPerf = ''
  function onPerformance(ps: PerformanceStatus): void {
    const key = JSON.stringify([
      ps.active,
      ps.helper,
      ps.watts.state,
      ps.watts.helperVersion,
      ps.watts.message
    ])
    if (key === lastPerf) return
    lastPerf = key
    void excludeSelf()
    void serial(cleanUpSynced).catch(() => undefined)
    emitSoon()
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      seen = seenOf(deps.settings.get())
      unsubs = [
        deps.settings.onChange(onSettings),
        deps.events.on('performance:status', onPerformance),
        deps.events.on('overlay:state', () => emitSoon()),
        deps.events.on('session:started', (e) => {
          onGameStart(e.gameId)
          void syncOsd()
          emitSoon()
        }),
        deps.events.on('session:ended', () => {
          // Per-game limits stay in the game's RivaTuner profile by design (they apply whenever it runs).
          stopHookWait()
          procs = null
          void syncOsd()
          emitSoon()
        })
      ]
      void excludeSelf()
      void serial(cleanUpSynced).catch(() => undefined)
      const running = deps.launcher.running()
      if (running) onGameStart(running.gameId)
      void syncOsd()
      emitSoon()
    },

    status,

    async liveStats() {
      const ps = deps.performance.status()
      const r = await rtssStatus()
      const game =
        r.state === 'running' ? await rtss.gameFps(await gamePids()).catch(() => null) : null
      const w = watts(ps)
      if (game && Number.isFinite(game.fps))
        return {
          fps: Math.round(game.fps),
          ...(game.frameTimeMs !== undefined ? { frameTimeMs: game.frameTimeMs } : {}),
          fpsSource: 'rtss',
          watts: w
        }
      const dyn = ps.dynamic?.fps
      if (typeof dyn === 'number' && Number.isFinite(dyn))
        return {
          fps: Math.round(dyn),
          ...(ps.dynamic?.frameTimeMs !== undefined ? { frameTimeMs: ps.dynamic.frameTimeMs } : {}),
          fpsSource: 'presentmon',
          watts: w
        }
      return { fps: null, fpsSource: null, watts: w }
    },

    async setFrameLimit(fps) {
      if (!Number.isInteger(fps) || fps < 0 || fps > FRAME_LIMIT_MAX)
        throw new Error(tMain('mainOverlay.extras.frameLimitRange', { max: FRAME_LIMIT_MAX }))
      if (!rtssTiles) throw new Error(notVerified())
      await serial(async () => {
        const r = await rtssStatus(true)
        const why = await writeReason(r)
        if (why) throw new Error(why)
        const resolved = await resolveTarget(true, true)
        if (!resolved.target) throw new Error(resolved.reason)
        const t = resolved.target
        // An explicit pick sticks: sync goes off first (its change is not re-applied: this write replaces it).
        if (perf().syncFpsToRefresh) {
          seen = { ...seen, sync: false }
          deps.settings.update({ performance: { syncFpsToRefresh: false } })
          seen = seenOf(deps.settings.get())
        }
        // Sync is off now: its limits on other games' exes go too.
        await unsyncAll(t.key)
        const stored = store.get(t.key)
        for (const old of [stored?.exe, store.getSynced(t.key)]) {
          if (old && lower(old) !== lower(t.exe))
            await rtss
              .setFrameLimit(old, 0)
              .catch((err) => log.warn(`extras: taking the limit off ${old}: ${errorText(err)}`))
        }
        await rtss.setFrameLimit(t.exe, fps)
        await store.setSynced(t.key, null)
        await store.set(t.key, fps ? { frameLimit: fps, exe: t.exe } : null)
        log.info(`extras: frame limit ${fps || 'off'} for ${t.exe} (picked)`)
      })
      return changed()
    },

    async setSync(enabled) {
      if (enabled && !rtssTiles) throw new Error(notVerified())
      if (perf().syncFpsToRefresh !== enabled) {
        seen = { ...seen, sync: enabled }
        deps.settings.update({ performance: { syncFpsToRefresh: enabled } })
        seen = seenOf(deps.settings.get())
        // On: the display's rate; off: the game's own choice again (0 puts back what was there).
        await serial(() => applyCurrent(enabled ? 'sync on' : 'sync off'))
      }
      return changed()
    },

    async setPerfOverlay(level) {
      if (![0, 1, 2, 3].includes(level)) throw new Error('Not a performance overlay level')
      if (level && !osdTile) throw new Error(notVerified())
      if ((perf().perfOverlay ?? 0) !== level) {
        seen = { ...seen, level }
        deps.settings.update({ performance: { perfOverlay: level } })
        seen = seenOf(deps.settings.get())
      }
      await syncOsd()
      return changed()
    },

    async setAutoHdr(enabled) {
      hdr.clear()
      const state = await hdr.get().catch(() => null)
      if (state && !state.enabled) throw new Error(hdrOff())
      await deps.autoHdr.write(enabled)
      autoHdrValue.clear()
      log.info(`extras: Auto HDR ${enabled ? 'on' : 'off'}`)
      return changed()
    },

    async setCpuBoost(enabled) {
      const p = perf()
      const active = deps.performance.status().active
      const current = cpuBoostStatus(p, active)
      if (!current.available || active === null || active === 'dynamic')
        throw new Error(current.reason ?? tMain('mainOverlay.extras.cpuBoostLocked'))
      if (active === 'custom') {
        deps.settings.update({
          performance: {
            profiles: { ...p.profiles, custom: { ...p.profiles.custom, cpuBoost: enabled } }
          }
        })
      } else if (enabled === p.profiles[active].cpuBoost) {
        // Back to the preset's own value: the override goes.
        if (deps.settings.mutate)
          deps.settings.mutate((s) => {
            const o = { ...(s.performance.boostOverrides ?? {}) }
            delete o[active]
            s.performance.boostOverrides = o
          })
        else deps.settings.update({ performance: { boostOverrides: { [active]: enabled } } })
      } else deps.settings.update({ performance: { boostOverrides: { [active]: enabled } } })
      // The performance service puts the profile in effect again (powercfg PERFBOOSTMODE) from the settings change.
      log.info(`extras: CPU boost ${enabled ? 'on' : 'off'} (${active})`)
      return changed()
    },

    async displayChanged() {
      display.clear()
      hdr.clear()
      if (syncOn()) await serial(() => applyCurrent('display changed'))
      emitSoon()
    },

    async beforeHelperRemoved() {
      await serial(async () => {
        if (!(await deps.performance.rtssHelper().catch(() => null))) return
        try {
          const n = await rtss.restoreAll()
          await store.clear()
          selfExcluded = false
          log.info(`extras: ${n} RivaTuner profile(s) put back before the power helper is removed`)
        } catch (err) {
          // The helper's own record stays (the removal keeps it), so a later install can still put them back.
          log.warn(`extras: putting RivaTuner profiles back: ${errorText(err)}`)
        }
      }).catch(() => undefined)
      emitSoon()
    },

    async dispose() {
      if (disposed) return
      disposed = true
      for (const u of unsubs) u()
      unsubs = []
      stopHookWait()
      stopReleaseRetry()
      clearTimer(osdTimer)
      osdTimer = null
      osdShown = false
      await rtss
        .osdRelease()
        .catch((err) => log.warn(`extras: releasing the OSD: ${errorText(err)}`))
      await rtss.dispose().catch(() => undefined)
    }
  }
}
