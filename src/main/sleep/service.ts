import { promises as fs } from 'fs'
import { join } from 'path'
import type { Logger } from '../logger'
import type { ForegroundWindow, PauseResult } from '../native-host/native-ops'
import {
  ANTI_CHEAT,
  antiCheatRunning,
  overlayTarget,
  pausable,
  resumeSettled,
  type OverlayTarget
} from '../overlay/overlay-logic'
import {
  APPLY_VERSION,
  applyScript,
  EMPTY_LEDGER,
  ledgerIsEmpty,
  mergeLedgers,
  POWER_RULES,
  readLedger,
  revertScript,
  writeLedger,
  type WakeSourceLedger
} from './wake-sources'

/**
 * Enhanced Sleep/Wake (docs/sleep-wake.md), ported from Winhanced: while a game runs, the game PlayOut last saw in
 * front is frozen when the PC goes to sleep or the screen locks (on Modern Standby PCs the power button locks the
 * screen and turns the display off before Windows reports sleep), and runs again once the PC is awake and unlocked.
 * PlayOut's own wake recovery (the controller reader, the power limits) already runs on every wake. The Windows
 * changes (wake-sources.ts) are made in one elevated step while the setting is on and undone when it is turned off.
 */

/**
 * Anti-cheat services: a game running under one of them is never frozen (it could be flagged or kicked). The list is
 * shared with the overlay's pause (overlay-logic.ts).
 */
export { ANTI_CHEAT }

/** How often the game in front is noted while a game runs. */
export const WATCH_MS = 4_000
/** After waking, the system settles (desktop, audio, drivers) before the game runs again. */
export const SETTLE_MS = 2_000
/** The elevated step waits this long after start-up, so it never competes with PlayOut starting. */
export const APPLY_DELAY_MS = 20_000
/** A resume still unanswered after THAW_TRIES tries is tried again this often, until it settles. */
export const THAW_SLOW_MS = 30_000
/** Retries of a resume the native host did not answer at SETTLE_MS, before slowing down to THAW_SLOW_MS. */
export const THAW_TRIES = 10
/** Quitting waits at most this long for the game to run again. */
export const DISPOSE_WAIT_MS = 5_000

interface FrozenRecord {
  pid: number
  /** Start time (ms since 1601): only this very process is resumed. */
  created: number
  program: string
}

/** What PlayOut remembers about its Windows changes (userData/sleep/state.json). */
interface WindowsState {
  /** The elevated step ran and its ledger is current. */
  applied: boolean
  /** The step's version (APPLY_VERSION) that ran: an older one runs again for what it lacked. */
  version?: number
  /** The user declined the elevation prompt: not asked again until the setting is turned on again. */
  declined: boolean
}

export interface SleepWakeDeps {
  log: Logger
  userData: string
  /** The setting (system.enhancedSleepWake). */
  enabled(): boolean
  /** A game PlayOut started is running. */
  gameRunning(): boolean
  native: {
    foreground(): Promise<ForegroundWindow | null>
    pauseProcess(pid: number, pause: boolean, created?: number): Promise<PauseResult>
  }
  /** PlayOut's own windows (never frozen). */
  isPlayOutWindow(hwnd: string): boolean
  /** Lower-case image names of the running processes, or null when unknown. */
  runningImages(): Promise<Set<string> | null>
  /** 'locked' while the lock screen shows (Electron powerMonitor.getSystemIdleState). */
  idleState(): string
  /** Runs a PowerShell script elevated; its exit code (1223: declined). */
  runElevatedScript(script: string): Promise<number | null>
  ownPid?: number
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

export interface SleepWakeService {
  /** Start: thaw a game a crash left frozen, watch games, and make the Windows changes (or undo them). */
  start(): void
  /** The PC is going to sleep, or the screen locked. */
  onSleep(): Promise<void>
  /** The PC woke up. */
  onWake(): Promise<void>
  /** The screen unlocked. */
  onUnlock(): Promise<void>
  /** The setting changed. */
  sync(): void
  /** Quit: the game runs again; the Windows changes stay (they are the setting's, not the session's). */
  dispose(): Promise<void>
}

export function createSleepWakeService(deps: SleepWakeDeps): SleepWakeService {
  const { log } = deps
  const dir = join(deps.userData, 'sleep')
  const frozenFile = join(dir, 'frozen.json')
  const ledgerFile = join(dir, 'wake-sources.json')
  /** An earlier ledger, set aside while the elevated step writes a new one. */
  const priorFile = join(dir, 'wake-sources.prior.json')
  const stateFile = join(dir, 'state.json')
  const ownPid = deps.ownPid ?? process.pid
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return { cancel: () => clearTimeout(t) }
    })

  let watchTimer: { cancel(): void } | null = null
  let applyTimer: { cancel(): void } | null = null
  let thawTimer: { cancel(): void } | null = null
  let lastGame: OverlayTarget | null = null
  let frozen: FrozenRecord | null = null
  let disposed = false
  let thawTries = 0
  /**
   * How often the PC was found awake and unlocked. A freeze asked for before the last of them is stale (its checks
   * were still running when the PC woke up): it no longer freezes anything.
   */
  let awakeCount = 0
  /**
   * One step at a time, in two separate queues: the game (freeze, thaw) never waits behind the Windows changes,
   * whose elevation prompt may stay unanswered for a long time.
   */
  const queue = (): {
    run: <T>(op: () => Promise<T>) => Promise<T>
    idle: () => Promise<unknown>
  } => {
    let chain: Promise<unknown> = Promise.resolve()
    return {
      run: <T>(op: () => Promise<T>): Promise<T> => {
        const next = chain.then(op)
        chain = next.catch(() => undefined)
        return next
      },
      idle: () => chain
    }
  }
  const gameQueue = queue()
  const windowsQueue = queue()

  // --- the game -------------------------------------------------------------------------------------------------

  /**
   * Notes the program in front when it is a game: full screen (borderless or exclusive), which is how PlayOut starts
   * games. A chat or browser window in front is never taken for the game (it would be frozen on a lock).
   */
  async function noteGame(): Promise<void> {
    if (!deps.enabled() || !deps.gameRunning()) {
      lastGame = null
      return
    }
    const fg = await deps.native.foreground().catch(() => null)
    if (!fg || !(fg.fullscreen || fg.exclusive)) return
    const target = overlayTarget(fg, null, deps.isPlayOutWindow)
    if (pausable(target, ownPid)) lastGame = target
  }

  function watch(): void {
    watchTimer?.cancel()
    if (disposed) return
    watchTimer = setTimer(() => {
      void noteGame().finally(watch)
    }, WATCH_MS)
  }

  async function saveFrozen(record: FrozenRecord | null): Promise<void> {
    if (!record) {
      await fs.rm(frozenFile, { force: true })
      return
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(frozenFile, JSON.stringify(record))
  }

  const freeze = (): Promise<void> => {
    const asked = awakeCount
    /** The PC woke up (unlocked) since this freeze was asked for: a pending thaw is left alone, nothing is frozen. */
    const stale = (): boolean => asked !== awakeCount
    return gameQueue.run(async () => {
      if (stale()) return
      thawTimer?.cancel()
      if (frozen || disposed || !deps.enabled() || !deps.gameRunning()) return
      // The game in front right now, else the last one seen (the lock screen is in front once the screen locks).
      await noteGame()
      const target = lastGame
      if (!target) return
      const images = await deps.runningImages()
      if (!images) {
        // Unknown means an anti-cheat service may run: never freeze then.
        log.info(`sleep: running programs unknown; ${target.program} not frozen`)
        return
      }
      const guard = antiCheatRunning(images)
      if (guard) {
        log.info(`sleep: ${target.program} runs with anti-cheat (${guard}); not frozen`)
        return
      }
      // The checks above take a while (the process list): Windows may have suspended PlayOut during them, and the
      // PC is awake again by now. Freezing the game then would only stall it until the thaw.
      if (stale()) {
        log.info(`sleep: the PC is awake again; ${target.program} not frozen`)
        return
      }
      const result = await deps.native.pauseProcess(target.pid, true)
      // A refusal is final; anything else (the native host did not answer) may have frozen it all the same, so the
      // record is kept and the thaw covers it (start time 0: resumed without the check; a running process is
      // unaffected by a resume).
      const refused = !result.ok && ['access', 'gone', 'not a process'].includes(result.error ?? '')
      if (refused) {
        log.info(`sleep: ${target.program} could not be frozen (${result.error ?? 'unknown'})`)
        return
      }
      frozen = { pid: target.pid, created: result.created ?? 0, program: target.program }
      thawTries = 0
      await saveFrozen(frozen).catch((err) => log.warn('sleep: freeze record not saved', err))
      log.info(
        result.ok
          ? `sleep: froze ${target.program} (${target.pid})`
          : `sleep: ${target.program} may be frozen (${result.error ?? 'no answer'}); resumed on wake`
      )
    })
  }

  const thaw = (): Promise<void> =>
    gameQueue.run(async () => {
      thawTimer?.cancel()
      const record = frozen
      if (!record) return
      const result = await deps.native.pauseProcess(record.pid, false, record.created)
      if (!resumeSettled(result)) {
        // The record and frozen.json stay until the resume settles, so the game is never frozen a second time over
        // it and never forgotten.
        if (disposed) {
          log.warn(`sleep: ${record.program} could not be resumed; left to the next start`)
          return
        }
        thawTries++
        if (thawTries < THAW_TRIES) {
          log.warn(
            `sleep: ${record.program} could not be resumed (${result.error ?? 'unknown'}); will retry`
          )
        } else if (thawTries === THAW_TRIES) {
          log.warn(
            `sleep: ${record.program} (${record.pid}) is still frozen after ${THAW_TRIES} tries (${result.error ?? 'unknown'}); trying again every ${THAW_SLOW_MS / 1000} s`
          )
        }
        thawTimer = setTimer(() => void thaw(), thawTries < THAW_TRIES ? SETTLE_MS : THAW_SLOW_MS)
        return
      }
      frozen = null
      thawTries = 0
      await saveFrozen(null).catch(() => undefined)
      log.info(`sleep: resumed ${record.program} (${record.pid})`)
    })

  /**
   * Thaw once the PC is awake and unlocked, after the system settled. Scheduled even when nothing is frozen yet: a
   * freeze still running when the PC woke is queued before the thaw, which then resumes it.
   */
  function thawWhenReady(): void {
    if (deps.idleState() === 'locked') return
    awakeCount++
    thawTimer?.cancel()
    thawTries = 0
    thawTimer = setTimer(() => void thaw(), SETTLE_MS)
  }

  /** A game left frozen by a crash runs again (only that very process: its start time matches). */
  async function thawLeftFrozen(): Promise<void> {
    let record: FrozenRecord
    try {
      record = JSON.parse(await fs.readFile(frozenFile, 'utf8')) as FrozenRecord
    } catch {
      return
    }
    if (Number.isSafeInteger(record.pid) && Number.isSafeInteger(record.created)) {
      frozen = { pid: record.pid, created: record.created, program: String(record.program ?? '') }
      await thaw()
    } else await saveFrozen(null)
  }

  // --- the Windows changes ----------------------------------------------------------------------------------------

  async function readState(): Promise<WindowsState> {
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Partial<WindowsState>
      return {
        applied: raw.applied === true,
        declined: raw.declined === true,
        version: typeof raw.version === 'number' ? raw.version : 1
      }
    } catch {
      return { applied: false, declined: false }
    }
  }

  async function writeState(state: WindowsState): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(stateFile, JSON.stringify(state))
  }

  /** Everything PlayOut changed: the ledger, with one set aside by a run that did not finish. */
  async function readLedgers(): Promise<WakeSourceLedger | null> {
    const [prior, current] = await Promise.all([readLedger(priorFile), readLedger(ledgerFile)])
    return prior ? mergeLedgers(prior, current) : current
  }

  const applyWindows = (): Promise<void> =>
    windowsQueue.run(async () => {
      if (disposed || !deps.enabled()) return
      const state = await readState()
      if ((state.applied && state.version === APPLY_VERSION) || state.declined) return
      await fs.mkdir(dir, { recursive: true })
      // What an earlier run changed (an older version, a run cut short, or its state lost): the new run starts a new
      // ledger and would no longer see those devices as armed, so the earlier ledger is set aside first (it survives
      // a quit during the run) and merged back in afterwards.
      const prior = await readLedgers()
      const hasPrior = prior !== null && !ledgerIsEmpty(prior)
      if (hasPrior) await writeLedger(priorFile, prior)
      const code = await deps.runElevatedScript(applyScript(ledgerFile))
      let ledger = await readLedger(ledgerFile)
      if (hasPrior) {
        // The earlier record holds the original values; a new run would only see PlayOut's own.
        ledger = mergeLedgers(prior, ledger)
        await writeLedger(ledgerFile, ledger)
        await writeLedger(priorFile, null)
      }
      if (code === 1223) {
        await writeState({ applied: false, declined: true })
        log.info(
          'sleep: the Windows changes were declined; asked again when the setting is turned on'
        )
        return
      }
      if (code !== 0 || !ledger) {
        // Not marked done: tried again at the next start (what it changed is in the ledger).
        log.warn(
          `sleep: the Windows changes failed (exit ${code ?? 'none'}${ledger ? '' : ', no record'})`
        )
        return
      }
      await writeState({ applied: true, declined: false, version: APPLY_VERSION })
      const l = ledger ?? EMPTY_LEDGER
      const changed = [
        ...POWER_RULES.filter((r) =>
          l.power.some((c) => c.setting.toLowerCase() === r.setting)
        ).map((r) => r.name),
        ...(l.hibernation ? ['hibernation switched on'] : []),
        ...(l.maintenanceWake !== null ? ['maintenance wake off'] : [])
      ]
      log.info(
        `sleep: wake disarmed for ${l.devices.length} device(s); ${changed.join(', ') || 'no power settings needed changing'}`
      )
    })

  /** `asked`: the user just turned the setting off (asked even after a declined prompt). */
  const revertWindows = (asked: boolean): Promise<void> =>
    windowsQueue.run(async () => {
      // Turned on again meanwhile: nothing to undo (and no prompt to undo what is then made again).
      if (disposed || deps.enabled()) return
      const ledger = await readLedgers()
      const state = await readState()
      if (!state.applied && !ledger) {
        if (state.declined) await writeState({ applied: false, declined: false })
        return
      }
      // A declined undo is not asked again at every start, only when the setting is turned off again.
      if (state.declined && !asked) return
      const toUndo = ledger ?? EMPTY_LEDGER
      if (!ledgerIsEmpty(toUndo)) {
        const code = await deps.runElevatedScript(revertScript(toUndo))
        if (code === 1223) {
          await writeState({ ...state, declined: true })
          log.info(
            'sleep: undoing the Windows changes was declined; asked again when the setting is turned off'
          )
          return
        }
        if (code !== 0) {
          // Part may be undone: no longer counted as applied, so turning the setting on again makes the changes again
          // (the ledger keeps the original values); while it stays off, the undo is tried again at the next start.
          await writeState({ applied: false, declined: false })
          log.warn(
            `sleep: the Windows changes could not be undone (exit ${code ?? 'none'}); tried again later`
          )
          return
        }
      }
      await writeLedger(ledgerFile, null)
      await writeLedger(priorFile, null)
      await writeState({ applied: false, declined: false })
      log.info('sleep: Windows changes undone')
    })

  let lastEnabled: boolean | null = null

  function syncWindows(initial: boolean): void {
    const on = deps.enabled()
    const changed = lastEnabled !== null && lastEnabled !== on
    lastEnabled = on
    // Another setting changed: a pending start-up step stays as it is.
    if (on && !changed && !initial) return
    applyTimer?.cancel()
    applyTimer = null
    const report = (e: unknown): void => log.warn(`sleep: the Windows changes: ${String(e)}`)
    if (on) {
      if (changed) {
        // Turned on by the user: ask again even if a prompt was declined before.
        void windowsQueue
          .run(async () => {
            const s = await readState()
            if (s.declined) await writeState({ applied: false, declined: false })
          })
          .then(() => applyWindows())
          .catch(report)
      } else {
        applyTimer = setTimer(() => void applyWindows().catch(report), APPLY_DELAY_MS)
      }
    } else if (changed || initial) {
      void revertWindows(changed).catch(report)
      void thaw()
    }
  }

  return {
    start() {
      void thawLeftFrozen()
      watch()
      syncWindows(true)
    },
    onSleep: freeze,
    async onWake() {
      thawWhenReady()
    },
    async onUnlock() {
      thawWhenReady()
    },
    sync() {
      syncWindows(false)
    },
    async dispose() {
      disposed = true
      watchTimer?.cancel()
      applyTimer?.cancel()
      thawTimer?.cancel()
      // Never leave a game frozen behind PlayOut, but never hold the quit long either: frozen.json covers a game still
      // frozen then, and a Windows step waiting on its prompt finishes (or not) on its own.
      const done = thaw()
        .catch(() => undefined)
        .then(() => gameQueue.idle())
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DISPOSE_WAIT_MS)
          timer.unref?.()
        })
      ])
      if (timer) clearTimeout(timer)
    }
  }
}
