import { basename } from 'path'
import type {
  MemoryPassReason,
  MemoryPassResult,
  MemoryPassSteps,
  MemoryStatus,
  MemorySystemTier,
  MemoryTier
} from '../../../shared/memory'
import type { Game, Settings } from '../../../shared/types'
import type { EventBus } from '../../events'
import { PROCESS_LIST_REUSE_MS, type ProcessInfo } from '../../launcher/process-monitor'
import type { Logger } from '../../logger'
import type { NativeOps } from '../../native-host/native-ops'
import { sampleMemory, type MemorySample } from '../../system/perf'
import { HelperMemoryBusyError } from '../helper/protocol'
import type { MemoryHelper } from '../service'
import { trimTargets, type TrimContext } from './exclusions'
import {
  INITIAL_PLANNER_STATE,
  PASS_TIMEOUT_MS,
  passEnded,
  passSkipped,
  planPass,
  SAMPLE_MS,
  sessionEnded,
  sessionStarted,
  standbyPurgeBelowMb,
  type PlannerState
} from './planner'
import type { TrimCounts } from './trim-cs'
import { tMain } from '../../i18n'

/**
 * "Free up memory while PlayOut is running" (Settings › System, docs/USER-GUIDE.md): the thin part around the planner
 * (when) and the exclusions (what). A pass trims the working sets of background programs and, when the power helper
 * is there, has it flush and purge Windows' memory lists. Every technique is temporary. Nothing here stops a service,
 * ends or suspends a process, or changes a Windows setting; none of that belongs in this module.
 *
 * Two tiers: with a ready helper (performance.memoryHelper()) the helper does the whole pass system-wide; otherwise
 * PlayOut's own PowerShell worker trims what this user may trim. Passes never overlap, time out, and never run while
 * the PC goes to sleep or PlayOut quits. Nothing runs before start() (a --mock run never starts it).
 *
 * Whatever cannot be read fails safe: without the process list, the running game's processes or the window in front
 * (and its process in the list) nothing is trimmed (an automatic pass is skipped, the button says why). All of it,
 * and the setting, is read after the helper has answered, right before the trim.
 */

/** Windows moves trimmed pages to its lists a moment after the trim: available memory is read after this. */
export const SETTLE_MS = 1_000
/** How long dispose() waits for a running pass. */
const DISPOSE_WAIT_MS = 2_000
/** The pass after a game's start is tried again this often while the game's processes are not known yet. */
const SESSION_RETRIES = 2

/**
 * The helper may take this long for its cleanup; with reading the processes before it, that stays inside
 * PASS_TIMEOUT_MS.
 */
export const HELPER_TIMEOUT_MS = PASS_TIMEOUT_MS - 20_000
/**
 * A helper that fails later than this is not replaced by PlayOut's own trim: it may have started its cleanup after
 * all, and what was read about the processes and the window in front is no longer fresh.
 */
export const HELPER_FALLBACK_WITHIN_MS = 5_000

export const gameUnknownMessage = (): string => tMain('mainPerformance.memory.gameUnknown')
export const foregroundUnknownMessage = (): string =>
  tMain('mainPerformance.memory.foregroundUnknown')
export const helperBusyMessage = (): string => tMain('mainPerformance.memory.helperBusy')
export const stillFinishingMessage = (): string => tMain('mainPerformance.memory.stillFinishing')
export const passTimeoutMessage = (): string => tMain('mainPerformance.memory.passTimeout')
export const notRunningMessage = (): string => tMain('mainPerformance.memory.notRunning')

export interface MemoryIo {
  /** Available and total physical memory now (system/perf.ts). */
  memory(): MemorySample
  now(): number
  sleep(ms: number): Promise<void>
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** PlayOut's main process, the process that started it, and Windows' folder. */
  pid: number
  parentPid: number
  windowsDir: string
}

export interface MemoryServiceDeps {
  settings: { get(): Settings; onChange(listener: (settings: Settings) => void): () => void }
  events: Pick<EventBus, 'emit' | 'on'>
  log: Logger
  launcher: {
    running(): { gameId: string } | null
    gameProcesses?(): Promise<{ pid: number }[]>
    /** Every running process (the launcher's process monitor). */
    processes?(): Promise<ProcessInfo[]>
  }
  library: { getGame(id: string): Game | undefined }
  /** foreground() answers null when the window in front could not be read: no pass runs then. */
  native: Pick<NativeOps, 'foreground' | 'trimWorkingSets'>
  /** The power helper's cleanup when it is ready (performance.memoryHelper()), else null. */
  helper(): Promise<MemoryHelper | null>
  /** performance.memoryTier(): what the UI says about the system-wide part. */
  systemTier(): MemorySystemTier
  /** PlayOut's own image names besides playout.exe and electron.exe (the packaged exe's name). */
  ownNames?: readonly string[]
  io?: Partial<MemoryIo>
}

export interface MemoryService {
  start(): void
  status(): MemoryStatus
  /** Run a pass now (the button): the status with its result. Joins a pass that is already running. */
  freeNow(): Promise<MemoryStatus>
  /** The PC goes to sleep: nothing runs until resume(). */
  suspend(): void
  resume(): void
  dispose(): Promise<void>
}

function defaultIo(): MemoryIo {
  return {
    memory: sampleMemory,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    pid: process.pid,
    parentPid: process.ppid,
    windowsDir: process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** "modifiedList done (1830 ms), standby skipped (memory is no longer low)" for the log line. */
export function stepsText(steps: MemoryPassSteps): string {
  return (Object.keys(steps) as (keyof MemoryPassSteps)[])
    .map((name) => {
      const s = steps[name]
      if (!s) return ''
      const notes = [s.detail, s.ms !== undefined ? `${s.ms} ms` : ''].filter(Boolean)
      return `${name} ${s.state}${notes.length ? ` (${notes.join(', ')})` : ''}`
    })
    .filter(Boolean)
    .join(', ')
}

/** One line per pass, at info level. */
export function passLogLine(r: MemoryPassResult): string {
  return (
    `memory: ${r.reason} pass (${r.tier}) freed ${r.freedMb} MB ` +
    `(${r.beforeAvailableMb} -> ${r.afterAvailableMb} MB available), trimmed ${r.trimmed}, ` +
    `skipped ${r.skipped}, denied ${r.denied}; ${stepsText(r.steps)}` +
    (r.durationMs !== undefined ? `; took ${r.durationMs} ms` : '') +
    (r.error ? `; ${r.error}` : '')
  )
}

/** Something a pass must know to leave the right programs alone could not be read: nothing is trimmed. */
class CannotDecideError extends Error {}
/** The pass was stopped before it trimmed anything (sleep, quit, given up on, or the setting was turned off). */
class NotRunningError extends Error {}
class PassTimeoutError extends Error {}

interface PassToken {
  /** Set when a pass is given up on: its cleanup, still running, must not start another trim. */
  cancelled: boolean
  /** The cleanup got as far as asking for a trim: only then is it a pass for the planner's cooldowns. */
  attempted: boolean
}

/** What a cleanup did, before it is measured. */
interface Cleaned {
  tier: MemoryTier
  counts: TrimCounts
  steps: MemoryPassSteps
  /** Processes the exclusions left alone. */
  excluded: number
  /** How long the cleanup took where it ran, when that is known. */
  durationMs?: number
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { log } = deps
  const io: MemoryIo = { ...defaultIo(), ...deps.io }
  const ownNames = [
    'playout',
    'electron',
    basename(process.execPath),
    ...(deps.ownNames ?? [])
  ].filter(Boolean)

  let started = false
  let stopped = false
  let paused = false
  let state: PlannerState = INITIAL_PLANNER_STATE
  let current: Promise<MemoryPassResult> | null = null
  /** The running pass is shown as running (a pass that ends up doing nothing is never shown). */
  let shown = false
  /** The cleanup of a pass that timed out, until it has really ended: no other pass starts meanwhile. */
  let draining: Promise<void> | null = null
  let last: MemoryPassResult | null = null
  let sampler: unknown = null
  let sessionTimer: unknown = null
  let sessionRetries = 0
  let unsubs: (() => void)[] = []
  let lastEmitted = ''

  // Read defensively: tests (and a settings object from before this setting) may not have the block.
  const enabled = (): boolean => deps.settings.get().performance?.memory?.enabled === true

  function status(): MemoryStatus {
    return {
      enabled: enabled(),
      running: current !== null && shown,
      systemWide: deps.systemTier(),
      last
    }
  }

  function emit(): MemoryStatus {
    const s = status()
    lastEmitted = JSON.stringify(s)
    deps.events.emit('memory:status', s)
    return s
  }

  function emitIfChanged(): void {
    if (JSON.stringify(status()) !== lastEmitted) emit()
  }

  /** The pass is shown as running from here (it is about to trim). */
  function announce(): void {
    if (shown || stopped) return
    shown = true
    emit()
  }

  async function context(): Promise<{
    list: ProcessInfo[]
    ctx: TrimContext
    createdBefore: number
  }> {
    const running = deps.launcher.running()
    // The list may be one read up to PROCESS_LIST_REUSE_MS ago: a process created since then is not in it, and a
    // pid in it may by now be another process. Both tiers leave everything created after this moment alone.
    const createdBefore = io.now() - PROCESS_LIST_REUSE_MS
    const [list, game, foreground] = await Promise.all([
      deps.launcher.processes?.() ?? Promise.resolve([]),
      running ? (deps.launcher.gameProcesses?.() ?? Promise.resolve([])) : Promise.resolve([]),
      deps.native.foreground().catch(() => null)
    ])
    if (!list.length) throw new Error(tMain('mainPerformance.memory.processesUnreadable'))
    const gameDir = running ? (deps.library.getGame(running.gameId)?.installDir ?? null) : null
    // A running game whose processes are not known (it is still starting, or it is not tracked) could be trimmed
    // by mistake: nothing is, until they are.
    if (running && !game.length) throw new CannotDecideError(gameUnknownMessage())
    // The same for the window in front: foreground() answers null when its worker failed or timed out (likely
    // just when memory is short), and a game PlayOut does not track is protected by being in front and nothing else.
    const front = foreground?.pid
    if (typeof front !== 'number' || !Number.isInteger(front) || front <= 4)
      throw new CannotDecideError(foregroundUnknownMessage())
    // A window whose process is not in the list (it started after the list was read): which program that is, and
    // so which other processes are its own, is not known either.
    if (!list.some((p) => p.pid === front)) throw new CannotDecideError(foregroundUnknownMessage())
    return {
      list,
      createdBefore,
      ctx: {
        ownPid: io.pid,
        ownParentPid: io.parentPid,
        ownNames,
        gameRunning: running !== null,
        gamePids: game.map((p) => p.pid),
        gameDir: gameDir || null,
        foregroundPid: front,
        windowsDir: io.windowsDir
      }
    }
  }

  /**
   * The cleanup itself; throws what stopped it. Starts no trim once `token` is cancelled, nor (the button aside)
   * once the setting is off.
   */
  async function clean(reason: MemoryPassReason, token: PassToken): Promise<Cleaned> {
    const halted = (): boolean =>
      stopped || paused || token.cancelled || (reason !== 'manual' && !enabled())
    // The helper first: asking may take seconds (it is found and connected to), and what a pass decides from (the
    // processes, the game, the window in front, the setting) must be read right before the trim, not before that.
    const helper = await deps.helper().catch(() => null)
    if (halted()) throw new NotRunningError(notRunningMessage())
    const { list, ctx, createdBefore } = await context()
    const targets = trimTargets(list, ctx)
    if (halted()) throw new NotRunningError(notRunningMessage())
    token.attempted = true
    announce()
    if (helper) {
      const askedAt = io.now()
      try {
        const r = await helper.memoryTrim(targets.pids, {
          shell: targets.shell,
          createdBefore,
          // The pass at a game's start never drops the whole standby cache (the game has just filled it with its
          // files); one for low memory at most once while memory stays low.
          purgeBelowMb:
            reason === 'session'
              ? 0
              : standbyPurgeBelowMb(io.memory().totalMb, reason === 'manual' ? undefined : state),
          timeoutMs: HELPER_TIMEOUT_MS
        })
        return {
          tier: 'system',
          counts: r.counts,
          steps: r.steps,
          excluded: targets.skipped,
          ...(r.totalMs !== undefined ? { durationMs: r.totalMs } : {})
        }
      } catch (err) {
        log.warn(`memory: the power helper's cleanup failed: ${errorText(err)}`)
        if (halted()) throw new Error(notRunningMessage(), { cause: err })
        // A cleanup is, or may be, running in the helper (it was busy, lost its cleanup or did not end it in time):
        // trimming the same programs here as well would be a second pass on top of it.
        if (err instanceof HelperMemoryBusyError)
          throw new Error(helperBusyMessage(), { cause: err })
        // It failed late (it did not answer): it may have started, and what was read above is old by now.
        if (io.now() - askedAt > HELPER_FALLBACK_WITHIN_MS)
          throw new Error(errorText(err), { cause: err })
        // The helper refused at once or is not there: this user's own programs are still trimmed.
      }
    }
    const counts = await deps.native.trimWorkingSets(targets.pids, targets.shell, createdBefore)
    // The trim is the whole cleanup of this tier, so its time is the pass's as well.
    const took = counts.ms !== undefined ? { ms: counts.ms } : {}
    return {
      tier: 'user',
      counts,
      steps: { workingSets: { state: 'done', ...took } },
      excluded: targets.skipped,
      ...(counts.ms !== undefined ? { durationMs: counts.ms } : {})
    }
  }

  async function pass(reason: MemoryPassReason): Promise<MemoryPassResult> {
    const before = io.memory().availableMb
    let done: Cleaned | null
    let error: string | undefined
    let cannotDecide = false
    let notRunning = false
    let timer: unknown = null
    const token: PassToken = { cancelled: false, attempted: false }
    let work: Promise<Cleaned> | null = null
    try {
      // The cleanup of a pass that timed out has not ended yet: two never run at once.
      if (draining) throw new Error(stillFinishingMessage())
      work = clean(reason, token)
      // When the timeout wins, the cleanup's own late failure must not go unhandled.
      work.catch(() => undefined)
      done = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = io.setTimeout(
            () => reject(new PassTimeoutError(passTimeoutMessage())),
            PASS_TIMEOUT_MS
          )
        })
      ])
      await io.sleep(SETTLE_MS)
    } catch (err) {
      done = null
      error = errorText(err)
      cannotDecide = err instanceof CannotDecideError
      notRunning = err instanceof NotRunningError
      if (err instanceof PassTimeoutError && work) {
        // Given up on, but possibly still inside a trim: it starts no further one, and no pass starts until it
        // has really ended.
        token.cancelled = true
        const ending: Promise<void> = work
          .then(
            () => undefined,
            () => undefined
          )
          .then(() => {
            if (draining === ending) draining = null
          })
        draining = ending
      }
    } finally {
      if (timer !== null) io.clearTimeout(timer)
    }
    const tier: MemoryTier = done?.tier ?? 'user'
    const counts: TrimCounts = done?.counts ?? { trimmed: 0, denied: 0, skipped: 0, gone: 0 }
    const excluded = done?.excluded ?? 0
    const steps: MemoryPassSteps = done?.steps ?? {
      workingSets: { state: cannotDecide ? 'skipped' : 'failed', detail: error }
    }
    const after = io.memory().availableMb
    const result: MemoryPassResult = {
      at: new Date(io.now()).toISOString(),
      reason,
      tier,
      beforeAvailableMb: before,
      afterAvailableMb: after,
      freedMb: error ? 0 : Math.max(0, after - before),
      trimmed: counts.trimmed,
      skipped: excluded + counts.skipped + counts.gone,
      denied: counts.denied,
      steps,
      ...(done?.durationMs !== undefined ? { durationMs: done.durationMs } : {}),
      ...(error ? { error } : {})
    }
    if (!token.attempted && reason === 'manual') {
      // The button did nothing (it could not decide, or no cleanup could start): the UI says why, but it was not a
      // pass, so the planner's cooldowns and the game's own pass are left as they were.
      last = result
      log.warn(passLogLine(result))
      return result
    }
    if (!token.attempted && (cannotDecide || notRunning)) {
      // Nothing was done: not a pass (no cooldown, the last result stays, the UI is told nothing). A game's own
      // pass is tried again; one for low memory is not asked for again at every sample.
      log.debug(`memory: ${reason} pass skipped: ${error}`)
      if (
        cannotDecide &&
        reason === 'session' &&
        sessionRetries < SESSION_RETRIES &&
        deps.launcher.running()
      ) {
        sessionRetries++
        scheduleSession()
      } else if (reason === 'pressure') state = passSkipped(state, io.now())
      return result
    }
    state = passEnded(state, io.now(), result.freedMb, {
      reason,
      standbyPurged: done?.steps.standby?.state === 'done'
    })
    last = result
    if (error) log.warn(passLogLine(result))
    else log.info(passLogLine(result))
    return result
  }

  /**
   * Starts a pass unless one runs; the returned promise never rejects. The button's pass is shown as running at
   * once; an automatic one only when it gets to trimming, so one that is skipped never reaches the UI.
   */
  function run(reason: MemoryPassReason): Promise<MemoryPassResult> {
    if (current) {
      if (reason === 'manual') announce()
      return current
    }
    shown = false
    const running = pass(reason)
      .catch((err): MemoryPassResult => {
        // pass() reports its failures in the result; this is only for a bug in it.
        log.warn(`memory: ${errorText(err)}`)
        const mb = io.memory().availableMb
        return {
          at: new Date(io.now()).toISOString(),
          reason,
          tier: 'user',
          beforeAvailableMb: mb,
          afterAvailableMb: mb,
          freedMb: 0,
          trimmed: 0,
          skipped: 0,
          denied: 0,
          steps: { workingSets: { state: 'failed', detail: errorText(err) } },
          error: errorText(err)
        }
      })
      .then((result) => {
        current = null
        shown = false
        if (!stopped) emitIfChanged()
        return result
      })
    current = running
    if (reason === 'manual') announce()
    return running
  }

  function tick(): void {
    if (!started || stopped) return
    const m = io.memory()
    const planned = planPass(state, {
      now: io.now(),
      enabled: enabled(),
      paused,
      running: current !== null || draining !== null,
      availableMb: m.availableMb,
      totalMb: m.totalMb
    })
    state = planned.state
    if (planned.decision.run)
      void run(planned.decision.reason).catch((err) => log.warn(`memory: ${errorText(err)}`))
  }

  function scheduleSession(): void {
    state = sessionStarted(state, io.now())
    if (sessionTimer !== null) io.clearTimeout(sessionTimer)
    const wait = Math.max(0, (state.sessionDueAt ?? io.now()) - io.now())
    sessionTimer = io.setTimeout(() => {
      sessionTimer = null
      tick()
    }, wait + 50)
  }

  function cancelSession(): void {
    state = sessionEnded(state)
    if (sessionTimer !== null) io.clearTimeout(sessionTimer)
    sessionTimer = null
  }

  /** The sampler runs only while the setting is on. */
  function sync(): void {
    const on = started && !stopped && enabled()
    if (on && sampler === null) sampler = io.setInterval(tick, SAMPLE_MS)
    else if (!on && sampler !== null) {
      io.clearInterval(sampler)
      sampler = null
    }
    if (!on) cancelSession()
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      unsubs = [
        deps.events.on('session:started', () => {
          if (!enabled()) return
          sessionRetries = 0
          scheduleSession()
        }),
        deps.events.on('session:ended', cancelSession),
        // The helper was installed, updated or removed: the hint in Settings follows.
        deps.events.on('performance:status', emitIfChanged),
        deps.settings.onChange(() => {
          sync()
          emitIfChanged()
        })
      ]
      lastEmitted = JSON.stringify(status())
      sync()
      // The helper is asked once, so Settings can say whether the system-wide part is there.
      if (enabled())
        void deps
          .helper()
          .then(emitIfChanged)
          .catch((err) => log.debug(`memory: ${errorText(err)}`))
    },
    status,
    async freeNow() {
      if (!started || stopped || paused) throw new Error(notRunningMessage())
      await run('manual')
      return status()
    },
    suspend() {
      paused = true
    },
    resume() {
      paused = false
    },
    async dispose() {
      if (stopped) return
      stopped = true
      for (const off of unsubs) off()
      unsubs = []
      sync()
      const running = current
      if (running)
        await Promise.race([
          running.then(
            () => undefined,
            () => undefined
          ),
          io.sleep(DISPOSE_WAIT_MS)
        ])
    }
  }
}
