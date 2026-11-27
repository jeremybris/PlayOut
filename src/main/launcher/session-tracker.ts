import type { ChildProcess } from 'child_process'
import type { Game, Settings, TrackingSpec } from '../../shared/types'
import type { Logger } from '../logger'
import type { ActiveSession, LibraryService } from '../services/library-service'
import {
  findByNames,
  findDescendants,
  findUnderDir,
  findUwp,
  normalizeProcessName,
  type ProcessInfo,
  type ProcessMonitor
} from './process-monitor'
import type { RunningGame, WindowController } from './types'

export interface SessionTiming {
  /** Interval between process polls. */
  pollMs: number
  /** Give up waiting for the game process to appear after this long. */
  graceMs: number
  /** The session ends this long after the last matching process disappeared. */
  lingerMs: number
  /**
   * A spawned process that exits within this window is treated as a launcher stub: the linger applies while we
   * look for the process it handed off to. One that ran longer was the game itself and ends the session at once.
   */
  stubWindowMs: number
  /** Consecutive failed polls after which the session is closed. */
  maxPollErrors: number
  /**
   * An emulator launch minimizes PlayOut once the emulator's window took the foreground (PlayOut lost the focus), or
   * after this long at most.
   */
  windowWaitMs: number
}

export const DEFAULT_SESSION_TIMING: SessionTiming = {
  pollMs: 3_000,
  graceMs: 120_000,
  lingerMs: 8_000,
  stubWindowMs: 10_000,
  maxPollErrors: 5,
  windowWaitMs: 3_000
}

/**
 * The library calls the tracker makes. `minutes` is the measured active time (poll gaps, sleep excluded); a
 * library that ignores it falls back to wall-clock time between the session's timestamps.
 */
export interface SessionLibrary {
  beginSession: LibraryService['beginSession']
  endSession(active: ActiveSession, minutes?: number): void
}

/** Playnite's sleep/hibernate rule (docs/research/electron-stack.md 7.4): a poll gap longer than this is not play time. */
export const SLEEP_GAP_ALLOWANCE_MS = 30_000

/** The spawned child is created shortly before tracking starts; a process older than this cannot be it. */
const SPAWN_SKEW_MS = 5_000

export interface SessionTrackerDeps {
  library: SessionLibrary
  settings: { get(): Settings }
  window: WindowController
  monitor: ProcessMonitor
  log: Logger
  timing?: Partial<SessionTiming>
}

export interface TrackedLaunch {
  game: Game
  /** The spawned process for exec / emulator launches; undefined for uri and uwp launches. */
  child?: ChildProcess
  /** Pid of a process started without a ChildProcess handle (elevated start through UAC); used when `child` is absent. */
  pid?: number
  /** When the process was spawned (Date.now()); processes created before it cannot belong to the game. */
  spawnedAt?: number
  /** Emulator commands flagged %RUNINBACKGROUND%: never minimize PlayOut for them. */
  runInBackground?: boolean
  /**
   * Minimize PlayOut only once the game's window took the foreground (or after timing.windowWaitMs), the way a game
   * started from Explorer comes up in front: minimizing while the game has no window yet hands the foreground to
   * another program, and Windows then keeps the game's window behind it. Emulator launches set it.
   */
  waitForWindow?: boolean
  /** Directory watched when the spawned process hands off to another process and exits (install or emulator dir). */
  handoffDir?: string
}

export interface TrackedSession extends RunningGame {
  /** Pid of the spawned process, for 'spawned' tracking. */
  pid?: number
  /** True once a matching process was observed. */
  seen: boolean
}

export interface SessionTracker {
  /** Begin a session for a game that was just started and watch it according to game.tracking. */
  start(launch: TrackedLaunch): ActiveSession
  current(): TrackedSession | null
  /** End the active session, if any. `restore: false` leaves a window we minimized alone (another game follows). */
  end(options?: { restore?: boolean; reason?: string }): void
  /** Bring PlayOut back if a session minimized it (used when a replacement launch fails). */
  restoreWindow(): void
  /**
   * The live processes the active session counts as the game, from a fresh process list: what the launcher's
   * `stop()` closes. Spawned games: the spawned process and its descendants (with the polls' pid-reuse checks) and
   * processes under the hand-off dir; the other modes: the same matches as their probe. Empty without a session.
   */
  gameProcesses(): Promise<ProcessInfo[]>
  /** End any session without touching the window and stop all timers (app quit). */
  dispose(): void
}

/** What one poll found out. */
interface ProbeResult {
  running: boolean
  /** Short description of the matching processes for the log. */
  detail: string
}

interface Watch {
  session: ActiveSession
  game: Game
  mode: TrackingSpec['mode']
  startedAt: number
  seen: boolean
  lastSeenAt: number
  /** When the previous poll ran; the gap to the next one is play time unless it spans a sleep. */
  lastPollAt: number
  /** Measured active time: the sum of poll gaps that were short enough to be awake time. */
  activeMs: number
  runInBackground: boolean
  waitForWindow: boolean
  ended: boolean
  timer: NodeJS.Timeout | null
  /** Waits for the game's window before minimizing (waitForWindow). */
  windowTimer: NodeJS.Timeout | null
  pollErrors: number
  probe: () => Promise<ProbeResult>
  // 'spawned' only
  child: ChildProcess | null
  pid: number | undefined
  spawnedAt: number
  childExitedAt: number | null
  /** Pids of the spawned process and its descendants; dead ones stay for one extra poll so late orphans still link. */
  tree: Set<number>
  /** Pids of the tree not seen alive: how many polls they have been missing and since when. */
  treeMissing: Map<number, { polls: number; since: number }>
  /** Identity of each tree pid when first seen alive, so a reused pid is recognised as a different process. */
  treeIdentity: Map<number, { name: string; createdAt: number | null }>
  treeEverSeen: boolean
  handoffDir: string | null
  onChildExit: ((code: number | null, signal: string | null) => void) | null
}

export function createSessionTracker(deps: SessionTrackerDeps): SessionTracker {
  return new SessionTrackerImpl(deps)
}

class SessionTrackerImpl implements SessionTracker {
  private readonly timing: SessionTiming
  private readonly log: Logger
  private active: Watch | null = null
  /** True while PlayOut is minimized because of a session (survives a replacement launch). */
  private minimizedByUs = false

  constructor(private readonly deps: SessionTrackerDeps) {
    this.timing = { ...DEFAULT_SESSION_TIMING, ...deps.timing }
    this.log = deps.log
  }

  start(launch: TrackedLaunch): ActiveSession {
    const { game } = launch
    const trackable = this.isTrackable(launch)
    // Only one game at a time; a trackable successor keeps the window minimized and restores it when it ends.
    if (this.active) this.endWatch(this.active, 'replaced by another launch', !trackable)

    const session = this.deps.library.beginSession(game.id)
    const now = Date.now()
    const w: Watch = {
      session,
      game,
      mode: trackable ? game.tracking.mode : 'none',
      startedAt: now,
      seen: false,
      lastSeenAt: now,
      lastPollAt: now,
      activeMs: 0,
      runInBackground: launch.runInBackground ?? false,
      waitForWindow: launch.waitForWindow ?? false,
      ended: false,
      timer: null,
      windowTimer: null,
      pollErrors: 0,
      probe: async () => ({ running: false, detail: '' }),
      child: launch.child ?? null,
      pid: launch.child?.pid ?? launch.pid,
      spawnedAt: launch.spawnedAt ?? now,
      childExitedAt: null,
      tree: new Set(),
      treeMissing: new Map(),
      treeIdentity: new Map(),
      treeEverSeen: false,
      handoffDir: launch.handoffDir ?? null,
      onChildExit: null
    }
    this.active = w

    if (w.mode === 'none') {
      this.log.info(`session for ${game.title} is not trackable; recording the launch only`)
      this.endWatch(w, 'not trackable', true)
      return session
    }

    w.probe = this.makeProbe(w)
    if (w.mode === 'spawned') w.tree.add(w.pid as number)
    if (w.mode === 'spawned' && w.child) {
      w.onChildExit = (code, signal) => {
        if (w.ended || w.childExitedAt !== null) return
        this.childGone(w, signal ? `killed by ${signal}` : `exited with code ${code}`)
        // The process lived until this moment: the linger counts from its exit, not from the last poll that saw
        // it (up to a poll interval earlier), which cut the time left to find what a stub handed off to.
        w.lastSeenAt = w.childExitedAt ?? w.lastSeenAt
        if (w.timer) clearTimeout(w.timer)
        w.timer = null
        void this.poll(w)
      }
      w.child.once('exit', w.onChildExit)
      if (w.child.exitCode !== null || w.child.signalCode !== null) {
        this.childGone(w, `exited before tracking started (code ${w.child.exitCode})`)
      }
    }
    this.log.info(`tracking ${game.title} by ${describeTracking(game.tracking, w)}`)
    void this.poll(w)
    return session
  }

  current(): TrackedSession | null {
    const w = this.active
    if (!w) return null
    return { gameId: w.game.id, startedAt: w.session.startedAt, pid: w.pid, seen: w.seen }
  }

  end(options: { restore?: boolean; reason?: string } = {}): void {
    if (this.active)
      this.endWatch(this.active, options.reason ?? 'ended on request', options.restore ?? true)
  }

  restoreWindow(): void {
    if (!this.minimizedByUs) return
    this.minimizedByUs = false
    try {
      this.deps.window.restore()
    } catch (err) {
      this.log.warn(`window restore failed: ${(err as Error).message}`)
    }
  }

  private windowVisible(): boolean {
    try {
      return this.deps.window.isVisible()
    } catch {
      return false
    }
  }

  dispose(): void {
    if (this.active) this.endWatch(this.active, 'PlayOut is quitting', false)
  }

  async gameProcesses(): Promise<ProcessInfo[]> {
    const w = this.active
    if (!w || w.ended) return []
    if (w.mode !== 'spawned') return this.makeMatcher(w)()
    const list = await this.deps.monitor.list()
    // Read-only: the poll loop owns the tree bookkeeping, this only looks at it.
    const { alive } = this.scanTree(w, list, Date.now(), false)
    const matches = [...alive]
    if (w.handoffDir) matches.push(...findUnderDir(list, w.handoffDir))
    return dedupe(matches)
  }

  // ---------------------------------------------------------------------------

  private isTrackable(launch: TrackedLaunch): boolean {
    const mode = launch.game.tracking.mode
    if (mode === 'none') return false
    if (mode === 'spawned' && !(launch.child?.pid ?? launch.pid)) {
      this.log.warn(
        `${launch.game.title} uses 'spawned' tracking but no process was spawned; recording the launch only`
      )
      return false
    }
    return true
  }

  private makeProbe(w: Watch): () => Promise<ProbeResult> {
    if (w.game.tracking.mode === 'spawned') return () => this.probeSpawned(w)
    const match = this.makeMatcher(w)
    return async () => summarize(await match())
  }

  /** The processes that count as the game in the modes matched against a process list (not 'spawned'). */
  private makeMatcher(w: Watch): () => Promise<ProcessInfo[]> {
    const tracking = w.game.tracking
    const monitor = this.deps.monitor
    switch (tracking.mode) {
      case 'installDir':
        return async () => findUnderDir(await monitor.list(), tracking.installDir)
      case 'process':
        return async () => findByNames(await monitor.listNames(), tracking.processNames)
      case 'uwp': {
        const installDir = w.game.installDir
        return async () => {
          const list = await monitor.list()
          const matches = findUwp(list, tracking.packageFamilyName)
          if (installDir) matches.push(...findUnderDir(list, installDir))
          return dedupe(matches)
        }
      }
      case 'spawned':
      case 'none':
        return async () => []
    }
  }

  private async probeSpawned(w: Watch): Promise<ProbeResult> {
    const pid = w.pid as number
    if (w.childExitedAt === null) {
      if (this.deps.monitor.isPidAlive(pid)) return { running: true, detail: `pid ${pid}` }
      // The 'exit' event normally gets here first; the pid poll covers a child whose handle we lost.
      this.childGone(w, 'pid no longer alive')
    }
    const list = await this.deps.monitor.list()
    const tree = this.updateTree(w, list)
    if (tree.length) {
      w.treeEverSeen = true
      return summarize(tree)
    }
    if (w.handoffDir) {
      const under = findUnderDir(list, w.handoffDir)
      if (under.length) return summarize(under)
    }
    return { running: false, detail: '' }
  }

  /**
   * Grow the tracked process tree from the live list and drop pids that have been gone for two polls. Windows
   * hands a freed pid to the next process created, so a pid is never trusted on its own: one already observed dead
   * (the exited child, a pid missing from an earlier poll) is only a parent-link anchor for late orphans, and a
   * tree pid whose image name or creation time changed is a different process, dropped together with any children
   * created after it took the pid.
   */
  private updateTree(w: Watch, list: ProcessInfo[]): ProcessInfo[] {
    const now = Date.now()
    const { alive, foreign } = this.scanTree(w, list, now, true)
    for (const p of alive) {
      w.tree.add(p.pid)
      if (!w.treeIdentity.has(p.pid))
        w.treeIdentity.set(p.pid, {
          name: normalizeProcessName(p.name),
          createdAt: p.createdAt ?? null
        })
    }
    const alivePids = new Set(alive.map((p) => p.pid))
    for (const pid of [...w.tree]) {
      if (foreign.has(pid)) {
        w.tree.delete(pid)
        w.treeMissing.delete(pid)
        w.treeIdentity.delete(pid)
        continue
      }
      if (alivePids.has(pid)) {
        w.treeMissing.delete(pid)
        continue
      }
      const missing = w.treeMissing.get(pid)
      if (missing && missing.polls + 1 >= 2) {
        w.tree.delete(pid)
        w.treeMissing.delete(pid)
        w.treeIdentity.delete(pid)
      } else {
        w.treeMissing.set(pid, { polls: (missing?.polls ?? 0) + 1, since: missing?.since ?? now })
      }
    }
    return alive
  }

  /**
   * The live members of the tracked tree in `list` without changing the watch: `foreign` maps each tree pid now
   * held by a different process to when the original process was last known to own it.
   */
  private scanTree(
    w: Watch,
    list: ProcessInfo[],
    now: number,
    logForeign: boolean
  ): { alive: ProcessInfo[]; foreign: Map<number, number> } {
    const foreign = new Map<number, number>()
    const byPid = new Map(list.map((p) => [p.pid, p]))
    for (const pid of w.tree) {
      const p = byPid.get(pid)
      if (p && this.isForeign(w, pid, p)) {
        foreign.set(
          pid,
          pid === w.pid ? (w.childExitedAt ?? now) : (w.treeMissing.get(pid)?.since ?? now)
        )
        if (logForeign)
          this.log.info(
            `${w.game.title}: pid ${pid} now belongs to ${p.name || '?'}; not part of the game`
          )
      }
    }
    const minCreatedAt = w.spawnedAt - SPAWN_SKEW_MS
    const candidates = list.filter((p) => {
      if (foreign.has(p.pid)) return false
      if (typeof p.createdAt === 'number' && p.createdAt < minCreatedAt) return false
      // A child of a reused pid is the game's orphan only when it was created while the original parent lived.
      if (p.parentPid !== null && foreign.has(p.parentPid))
        return typeof p.createdAt === 'number' && p.createdAt < (foreign.get(p.parentPid) as number)
      return true
    })
    const dead = new Set(w.treeMissing.keys())
    if (w.childExitedAt !== null && w.pid !== undefined) dead.add(w.pid)
    const roots = [...w.tree].filter((pid) => !foreign.has(pid))
    return { alive: findDescendants(candidates, roots, dead), foreign }
  }

  /** True when the process now holding a tracked pid is not the one the tree knew under it. */
  private isForeign(w: Watch, pid: number, p: ProcessInfo): boolean {
    if (pid === w.pid) {
      // The spawned child: anything created after it exited, or before it was spawned, has a reused pid.
      if (typeof p.createdAt !== 'number') return false
      if (w.childExitedAt !== null && p.createdAt > w.childExitedAt) return true
      return p.createdAt < w.spawnedAt - SPAWN_SKEW_MS
    }
    const known = w.treeIdentity.get(pid)
    if (!known) return false
    if (known.name && normalizeProcessName(p.name) !== known.name) return true
    return (
      known.createdAt !== null && typeof p.createdAt === 'number' && p.createdAt !== known.createdAt
    )
  }

  private childGone(w: Watch, how: string): void {
    if (w.childExitedAt !== null) return
    w.childExitedAt = Date.now()
    const lifetime = w.childExitedAt - w.startedAt
    this.log.info(
      `${w.game.title}: spawned process ${w.pid} ${how} after ${Math.round(lifetime / 1000)} s`
    )
  }

  private async poll(w: Watch): Promise<void> {
    if (w.ended) return
    let result: ProbeResult | null = null
    try {
      result = await w.probe()
    } catch (err) {
      w.pollErrors++
      this.log.warn(
        `process poll failed (${w.pollErrors}/${this.timing.maxPollErrors}): ${(err as Error).message}`
      )
    }
    if (w.ended) return

    const now = Date.now()
    this.creditPollGap(w, now)
    if (result === null) {
      if (w.pollErrors >= this.timing.maxPollErrors) {
        this.endWatch(w, 'process polling failed repeatedly', true)
        return
      }
    } else {
      w.pollErrors = 0
      if (result.running) {
        w.lastSeenAt = now
        if (!w.seen) this.markRunning(w, result.detail)
      } else if (w.seen) {
        if (this.spawnedGameExited(w) || now - w.lastSeenAt >= this.timing.lingerMs) {
          this.endWatch(w, 'game exited', true)
          return
        }
      } else if (now - w.startedAt >= this.timing.graceMs) {
        this.log.warn(
          `${w.game.title}: game process not seen within ${Math.round(this.timing.graceMs / 1000)} s`
        )
        this.endWatch(w, 'game process not seen', true)
        return
      }
    }

    // While lingering, wake up exactly when the linger expires instead of a full poll interval later; the floor
    // keeps a short linger from turning into a busy loop against PowerShell.
    let delay = this.timing.pollMs
    if (w.seen && result && !result.running) {
      const floor = Math.min(250, this.timing.pollMs)
      delay = Math.max(
        floor,
        Math.min(this.timing.pollMs, this.timing.lingerMs - (now - w.lastSeenAt))
      )
    }
    w.timer = setTimeout(() => void this.poll(w), delay)
  }

  /**
   * Play time is the sum of the gaps between polls. Timers do not run while Windows sleeps, so a gap much longer
   * than the poll interval is the machine having been asleep or hibernating and is not credited (Playnite's rule,
   * docs/research/electron-stack.md 7.4 step 3).
   */
  private creditPollGap(w: Watch, now: number): void {
    const gap = now - w.lastPollAt
    w.lastPollAt = now
    if (gap < 0) return
    if (gap <= this.timing.pollMs + SLEEP_GAP_ALLOWANCE_MS) w.activeMs += gap
    else
      this.log.info(
        `${w.game.title}: ignoring a ${Math.round(gap / 1000)} s gap between polls (sleep or hibernate)`
      )
  }

  /** A spawned process that ran past the stub window and left no descendants was the game: no linger needed. */
  private spawnedGameExited(w: Watch): boolean {
    if (w.mode !== 'spawned' || w.childExitedAt === null || w.treeEverSeen) return false
    return w.childExitedAt - w.startedAt >= this.timing.stubWindowMs
  }

  private markRunning(w: Watch, detail: string): void {
    w.seen = true
    this.log.info(`${w.game.title} is running (${detail})`)
    if (w.runInBackground) return
    let minimize = false
    try {
      minimize = this.deps.settings.get().ui.minimizeWhilePlaying
    } catch (err) {
      this.log.warn(`could not read settings: ${(err as Error).message}`)
    }
    if (!minimize) return
    if (w.waitForWindow && this.windowFocused()) {
      // Polled: the game's window taking the foreground shows as PlayOut losing it.
      const until = Date.now() + this.timing.windowWaitMs
      const step = Math.min(100, this.timing.windowWaitMs)
      const check = (): void => {
        w.windowTimer = null
        if (w.ended) return
        if (Date.now() < until && this.windowFocused()) {
          w.windowTimer = setTimeout(check, step)
          return
        }
        this.minimizeWindow()
      }
      w.windowTimer = setTimeout(check, step)
      return
    }
    this.minimizeWindow()
  }

  private windowFocused(): boolean {
    try {
      return this.deps.window.isFocused?.() ?? false
    } catch {
      return false
    }
  }

  private minimizeWindow(): void {
    try {
      // Also covers a replacement launch after the user brought PlayOut back while the previous game ran.
      if (!this.deps.window.isMinimized()) this.deps.window.minimize()
      this.minimizedByUs = true
    } catch (err) {
      this.log.warn(`window minimize failed: ${(err as Error).message}`)
    }
  }

  private endWatch(w: Watch, reason: string, restore: boolean): void {
    if (w.ended) return
    w.ended = true
    if (w.timer) clearTimeout(w.timer)
    w.timer = null
    if (w.windowTimer) clearTimeout(w.windowTimer)
    w.windowTimer = null
    if (w.child && w.onChildExit) w.child.removeListener('exit', w.onChildExit)
    if (this.active === w) this.active = null

    this.creditPollGap(w, Date.now())
    const minutes = Math.max(0, Math.round(w.activeMs / 60_000))
    this.log.info(`session ended for ${w.game.title}: ${reason} (${minutes} min, seen=${w.seen})`)
    try {
      this.deps.library.endSession(w.session, minutes)
    } catch (err) {
      this.log.error(`could not record the session for ${w.game.title}: ${(err as Error).message}`)
    }
    if (!restore) return
    // PlayOut takes the foreground back after a game, also when it stayed open (on another screen, or behind the
    // game): the controller only drives PlayOut while it is the active window.
    // Not a window closed to the tray during the game: that stays where the user put it.
    if (!this.minimizedByUs && w.seen && !w.runInBackground && this.windowVisible())
      this.minimizedByUs = true
    this.restoreWindow()
  }
}

function summarize(matches: ProcessInfo[]): ProbeResult {
  if (!matches.length) return { running: false, detail: '' }
  const shown = matches.slice(0, 3).map((p) => `${p.name || '?'} (${p.pid})`)
  if (matches.length > 3) shown.push(`+${matches.length - 3} more`)
  return { running: true, detail: shown.join(', ') }
}

function dedupe(list: ProcessInfo[]): ProcessInfo[] {
  const seen = new Set<number>()
  return list.filter((p) => (seen.has(p.pid) ? false : (seen.add(p.pid), true)))
}

function describeTracking(tracking: TrackingSpec, w: Watch): string {
  switch (tracking.mode) {
    case 'installDir':
      return `processes under ${tracking.installDir}`
    case 'process':
      return `process names ${tracking.processNames.join(', ')}`
    case 'uwp':
      return `package ${tracking.packageFamilyName}`
    case 'spawned':
      return `spawned pid ${w.pid}${w.handoffDir ? ` (hand-off dir ${w.handoffDir})` : ''}`
    case 'none':
      return 'nothing'
  }
}
