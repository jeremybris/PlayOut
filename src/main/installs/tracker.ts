// Background install tracker (docs/ARCHITECTURE.md §4.8 "InstallService and the tracker"): one watch per game, the
// session-tracker skeleton (setTimeout re-arm, never setInterval). A store probe runs every 2 s (measured stores) or
// 10 s (state-only stores); every 10 s the watch also runs the installed scan of that single source, and `done`
// always comes from the library saying `installed: true`. `powerMonitor` suspend pauses every watch without crediting
// the gap to the timeouts.
//
// When a watch gives up: a plain watch ends `failed` after thirty minutes without any observable change. A watch the
// install queue holds (`holdWhenStalled`) is never ended by a timer once the store was asked: the store may be
// downloading where PlayOut cannot see it, and ending the watch would start a second download next to it. It ends
// only when the confirming scan says installed, when the store's own data says cancelled, or when the user removes
// the game from the queue. One exception (`expectStoreStart`): a fresh hand-off to a store whose probe reliably sees a
// fresh install start (Steam, GOG, Battle.net, Epic) ends `failed` when the store's data never showed the install
// within `unconfirmedMs` (the user did not confirm it there; the queue moves on). Thirty minutes without a change only
// change a held watch's message: "it may be paused there" once the store showed the install, else "PlayOut cannot
// see <Store>'s progress" (no probe, a resumed watch, or a store whose probe cannot be relied on).
// The last resort (`heldTimeoutMs`, a day): a held watch with no observable change at all for that long ends `failed`
// so the one-at-a-time queue is not blocked for ever by an install the store cancelled where PlayOut could not see
// it. Any change the probe sees (bytes, a state line) starts the day again, so a slow download that still moves is
// never ended; the store's own download, if there is one, is not touched (only the watch ends).
import type {
  Game,
  InstallProgress,
  InstallState,
  SourceId,
  StoreSourceId
} from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { tMain } from '../i18n'

/** What one probe of the store's own install data found out; null when it found nothing yet. */
export interface ProbeResult {
  state?: Exclude<InstallState, 'done' | 'failed'>
  /** 0-100 when measurable. */
  percent?: number
  bytesDone?: number
  bytesTotal?: number
  /** User-facing override of the default line for the state ('Paused in Steam'). */
  message?: string
  /** The store's own data says the install finished: the confirming scan runs right away. */
  complete?: boolean
  /** The store's own data says the install was cancelled or its manifest removed. */
  cancelled?: boolean
  /**
   * The store's own data says the install is still in flight: the confirming scan's `installed: true` does not end
   * the watch while this is set (Steam marks a manifest FullyInstalled before the download finished).
   */
  inFlight?: boolean
  /** Opaque fingerprint of what was seen; a change resets the no-change timeout. */
  fingerprint: string
}

export type InstallProbe = () => Promise<ProbeResult | null>

export interface TrackerTiming {
  /** Probe interval for measured stores (Steam ACF, GOG log, Battle.net product.db, EA log). */
  probeMs: number
  /** Probe interval for state-only stores (Epic, Xbox, Ubisoft). */
  stateOnlyProbeMs: number
  /** Confirming installed-scan interval. */
  scanMs: number
  /** No observable change for this long ends the watch as failed (a held watch only says so: `holdWhenStalled`). */
  timeoutMs: number
  /** A held `expectStoreStart` watch whose store never showed the install for this long ends as failed. */
  unconfirmedMs: number
  /**
   * A held watch with no observable change for this long ends as failed and releases the install queue (far longer
   * than `timeoutMs`, which only changes a held watch's message).
   */
  heldTimeoutMs: number
  /** Minimum gap between two progress events of one game (state changes are never delayed). */
  emitMinMs: number
}

export const DEFAULT_TRACKER_TIMING: TrackerTiming = {
  probeMs: 2_000,
  stateOnlyProbeMs: 10_000,
  scanMs: 10_000,
  timeoutMs: 30 * 60_000,
  unconfirmedMs: 10 * 60_000,
  heldTimeoutMs: 24 * 60 * 60_000,
  emitMinMs: 1_000
}

export interface TrackerDeps {
  library: { getGame(id: string): Game | undefined }
  /** The confirming scans run as `reason: 'confirm'` (cached client detection, no progress events, no import). */
  scan: { run(ids: SourceId[], options: { reason: 'confirm' }): Promise<unknown> }
  events: Pick<EventBus, 'emit'>
  log: Logger
  timing?: Partial<TrackerTiming>
  now?: () => number
}

export interface WatchOptions {
  game: Game
  source: StoreSourceId
  /** Store name for the messages ('Steam'). */
  storeName: string
  /** The `starting` line ('Confirm the install in Steam'). */
  confirmMessage: string
  probe: InstallProbe | null
  /** True for stores whose probe gives numbers (2 s cadence). */
  measured: boolean
  /** Confirming-scan interval for this watch when the store's scan is expensive (PowerShell); default `scanMs`. */
  scanMs?: number
  /**
   * The install queue holds this watch: the stall timeout does not end it (a stall only changes its message); it ends
   * when installed, cancelled in the store, or cancelled by the user. The exceptions are `expectStoreStart` and the
   * last resort, `TrackerTiming.heldTimeoutMs` without any observable change.
   */
  holdWhenStalled?: boolean
  /**
   * With `holdWhenStalled` and a probe: the probe reliably sees a fresh install of this game start, so the store not
   * showing the install within `unconfirmedMs` means the user did not confirm it there, and the watch ends `failed`.
   * Only for a fresh hand-off (never a resumed watch) of a store in STORE_START_VISIBLE_SOURCES (installs/index.ts).
   */
  expectStoreStart?: boolean
  /**
   * The watch ended (done, failed or cancelled): the install queue starts the next game. Not called by `dispose`, so
   * a quitting PlayOut keeps the game at the front of the queue. Also called for a start that found the game watched
   * already (that watch ending).
   */
  onEnd?: () => void
}

/** What `start` gives back: the current progress, and whether this call made the watch it can cancel. */
export interface WatchHandle {
  progress: InstallProgress
  /** False when the game was watched already: the existing watch is kept and `cancel` does nothing. */
  created: boolean
  /** End exactly the watch this call made (silently, like `cancel`), never a later watch of the same game. */
  cancel(): boolean
}

export interface InstallTracker {
  /** Start watching a game; an already tracked game keeps its watch (`created: false`). */
  start(options: WatchOptions): WatchHandle
  /** End a watch silently (no final event). False when the game was not tracked. */
  cancel(gameId: string): boolean
  has(gameId: string): boolean
  list(): InstallProgress[]
  pause(): void
  resume(): void
  dispose(): void
}

interface Watch extends WatchOptions {
  /** Called once when the watch ends or is cancelled: its own onEnd and those of starts that found it. */
  listeners: (() => void)[]
  progress: InstallProgress
  timer: NodeJS.Timeout | null
  /** When the watch started (moved on by a suspend, like the other clocks). */
  startedAtMs: number
  /** The store's data showed the install (a state beyond `starting`) at least once. */
  confirmed: boolean
  /** The last probe gave its own message ('Paused in Steam'), which wins over the stall line. */
  storeMessage: boolean
  /** This stall was logged (once per stall). */
  stallLogged: boolean
  lastChangeAt: number
  lastScanAt: number
  lastEmitAt: number
  lastEmittedState: InstallState | null
  fingerprint: string | null
  /** The last probe said the install is still in flight (ProbeResult.inFlight). */
  inFlight: boolean
  scanDue: boolean
  ticking: boolean
  ended: boolean
}

export function timeoutMessage(storeName: string): string {
  return tMain('mainInstalls.timeout', { store: storeName })
}

/** A held watch whose store never showed the install: it ends `failed`, and the queue moves on. */
export function unconfirmedMessage(storeName: string): string {
  return tMain('mainInstalls.unconfirmed', { store: storeName })
}

/**
 * A held watch PlayOut cannot follow (no probe, or a probe that never showed the install), with no change for the
 * timeout: it goes on, only its message says so.
 */
export function blindMessage(storeName: string): string {
  return tMain('mainInstalls.blind', { store: storeName })
}

/**
 * A held watch the store showed, with no change for the timeout: it goes on, only its message says so. The progress
 * also carries `stalled: true`, which is what the renderer goes by (state/installs.ts installStalled), so this line
 * can be in any language.
 */
export function stalledMessage(storeName: string, timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
  return tMain('mainInstalls.stalled', { store: storeName, count: minutes })
}

/** A held watch with no observable change for `heldTimeoutMs`: it ends `failed`, and the queue moves on. */
export function heldTimeoutMessage(storeName: string, heldTimeoutMs: number): string {
  const hours = Math.max(1, Math.round(heldTimeoutMs / 3_600_000))
  return tMain('mainInstalls.heldTimeout', { store: storeName, count: hours })
}

export function cancelledMessage(storeName: string): string {
  return tMain('mainInstalls.cancelled', { store: storeName })
}

function defaultMessage(state: InstallState, storeName: string, confirmMessage: string): string {
  switch (state) {
    case 'starting':
      return confirmMessage
    case 'queued':
      return tMain('mainInstalls.queuedIn', { store: storeName })
    case 'done':
      return tMain('mainInstalls.installed')
    case 'failed':
      return timeoutMessage(storeName)
    default:
      return tMain('mainInstalls.installingThrough', { store: storeName })
  }
}

export function createInstallTracker(deps: TrackerDeps): InstallTracker {
  const timing: TrackerTiming = { ...DEFAULT_TRACKER_TIMING, ...deps.timing }
  const now = deps.now ?? Date.now
  const watches = new Map<string, Watch>()
  let paused = false
  let pausedAt = 0
  let disposed = false

  function emit(w: Watch, force = false): void {
    const t = now()
    const stateChanged = w.progress.state !== w.lastEmittedState
    if (!force && !stateChanged && t - w.lastEmitAt < timing.emitMinMs) return
    w.lastEmitAt = t
    w.lastEmittedState = w.progress.state
    deps.events.emit('install:progress', { ...w.progress })
  }

  function arm(w: Watch): void {
    if (w.ended || paused || disposed) return
    if (w.timer) clearTimeout(w.timer)
    w.timer = setTimeout(() => void tick(w), w.measured ? timing.probeMs : timing.stateOnlyProbeMs)
  }

  function end(w: Watch, state: 'done' | 'failed', message: string): void {
    if (w.ended) return
    w.ended = true
    if (w.timer) clearTimeout(w.timer)
    w.timer = null
    watches.delete(w.game.id)
    // An ended install is no longer stalled, whatever its last line said.
    const progress: InstallProgress = { ...w.progress }
    delete progress.stalled
    w.progress = {
      ...progress,
      state,
      message,
      updatedAt: new Date(now()).toISOString(),
      ...(state === 'done' ? { percent: 100 } : {})
    }
    deps.log.info(`${w.game.title}: install tracking ended (${state}: ${message})`)
    emit(w, true)
    ended(w)
  }

  function ended(w: Watch): void {
    for (const listener of w.listeners.splice(0)) {
      try {
        listener()
      } catch (err) {
        deps.log.warn(`${w.game.title}: install end listener failed: ${(err as Error).message}`)
      }
    }
  }

  function cancelWatch(w: Watch): boolean {
    if (w.ended || watches.get(w.game.id) !== w) return false
    w.ended = true
    if (w.timer) clearTimeout(w.timer)
    w.timer = null
    watches.delete(w.game.id)
    deps.log.info(`${w.game.title}: install tracking cancelled`)
    ended(w)
    return true
  }

  /** No observable change for the timeout. */
  function stalled(w: Watch): boolean {
    return now() - w.lastChangeAt >= timing.timeoutMs
  }

  /** A held watch, stalled: its line says so until something changes. */
  function holdsStalled(w: Watch): boolean {
    return !!w.holdWhenStalled && stalled(w)
  }

  /** Whether a stalled held watch is paused in the store (it showed the install) rather than PlayOut being blind. */
  function pausedInStore(w: Watch): boolean {
    return !!w.probe && !!w.confirmed
  }

  /** The line of a stalled held watch: paused in the store when it showed the install, else PlayOut is blind. */
  function heldStallText(w: Watch): string {
    return pausedInStore(w)
      ? stalledMessage(w.storeName, timing.timeoutMs)
      : blindMessage(w.storeName)
  }

  function apply(w: Watch, r: ProbeResult): boolean {
    const before = JSON.stringify(w.progress)
    const current = w.progress.state
    const state: InstallState =
      r.state ?? (r.percent !== undefined && current === 'starting' ? 'downloading' : current)
    if (state !== 'starting') w.confirmed = true
    const next: InstallProgress = {
      ...w.progress,
      state,
      message:
        r.message ??
        (holdsStalled(w) ? heldStallText(w) : defaultMessage(state, w.storeName, w.confirmMessage))
    }
    // The flag the renderer reads, set exactly when the line above is stalledMessage's.
    if (!r.message && holdsStalled(w) && pausedInStore(w)) next.stalled = true
    else delete next.stalled
    if (r.percent !== undefined) next.percent = Math.max(0, Math.min(100, Math.round(r.percent)))
    else delete next.percent
    if (r.bytesDone !== undefined) next.bytesDone = r.bytesDone
    else delete next.bytesDone
    if (r.bytesTotal !== undefined) next.bytesTotal = r.bytesTotal
    else delete next.bytesTotal
    const changed = JSON.stringify(next) !== before
    if (changed) next.updatedAt = new Date(now()).toISOString()
    w.progress = next
    return changed
  }

  async function tick(w: Watch): Promise<void> {
    if (w.ended || paused || disposed || w.ticking) return
    w.ticking = true
    try {
      let changed = false
      if (w.probe) {
        let result: ProbeResult | null = null
        try {
          result = await w.probe()
        } catch (err) {
          deps.log.warn(`${w.game.title}: install probe failed: ${(err as Error).message}`)
        }
        if (w.ended) return
        if (result) {
          w.storeMessage = result.message !== undefined
          if (result.cancelled) {
            end(w, 'failed', cancelledMessage(w.storeName))
            return
          }
          if (result.fingerprint !== w.fingerprint) {
            w.fingerprint = result.fingerprint
            w.lastChangeAt = now()
          }
          w.inFlight = result.inFlight === true
          if (result.complete) w.scanDue = true
          changed = apply(w, result) || changed
        }
      }

      const t = now()
      if (w.scanDue || t - w.lastScanAt >= (w.scanMs ?? timing.scanMs)) {
        w.scanDue = false
        w.lastScanAt = t
        try {
          await deps.scan.run([w.source], { reason: 'confirm' })
        } catch (err) {
          deps.log.warn(`${w.game.title}: confirming scan failed: ${(err as Error).message}`)
        }
        if (w.ended) return
        // The probe's word wins over the scan while the store still reports the install in flight.
        if (deps.library.getGame(w.game.id)?.installed && !w.inFlight) {
          end(w, 'done', tMain('mainInstalls.isInstalled', { title: w.game.title }))
          return
        }
      }

      if (w.holdWhenStalled) {
        // A fresh hand-off the store reliably shows never showed up there: the user did not confirm it in the store.
        if (
          w.expectStoreStart &&
          w.probe &&
          !w.confirmed &&
          now() - w.startedAtMs >= timing.unconfirmedMs
        ) {
          end(w, 'failed', unconfirmedMessage(w.storeName))
          return
        }
        // The last resort: nothing observable changed for a day (the store cancelled it where PlayOut cannot see
        // that, or never started it). The queue must not wait for ever; a download that still moves never gets here.
        if (now() - w.lastChangeAt >= timing.heldTimeoutMs) {
          end(w, 'failed', heldTimeoutMessage(w.storeName, timing.heldTimeoutMs))
          return
        }
        // No change for the timeout (paused or queued there, or the store downloads where PlayOut cannot see it):
        // the watch goes on, the line says so.
        if (holdsStalled(w)) {
          const text = heldStallText(w)
          if (!w.storeMessage && w.progress.message !== text) {
            w.progress = {
              ...w.progress,
              message: text,
              ...(pausedInStore(w) ? { stalled: true } : {}),
              updatedAt: new Date(now()).toISOString()
            }
            changed = true
          }
          if (!w.stallLogged) {
            w.stallLogged = true
            deps.log.info(`${w.game.title}: ${text}`)
            // Not throttled away: nothing else changes during a stall, so a dropped event would never be followed.
            emit(w, true)
            changed = false
          }
        } else w.stallLogged = false
      } else if (stalled(w)) {
        end(w, 'failed', timeoutMessage(w.storeName))
        return
      }
      if (changed) emit(w)
    } finally {
      w.ticking = false
      arm(w)
    }
  }

  return {
    start(options) {
      const existing = watches.get(options.game.id)
      if (existing) {
        if (options.onEnd) existing.listeners.push(options.onEnd)
        return { progress: { ...existing.progress }, created: false, cancel: () => false }
      }
      const t = now()
      const startedAt = new Date(t).toISOString()
      const w: Watch = {
        ...options,
        listeners: options.onEnd ? [options.onEnd] : [],
        progress: {
          gameId: options.game.id,
          source: options.source,
          state: 'starting',
          message: options.confirmMessage,
          startedAt,
          updatedAt: startedAt
        },
        timer: null,
        startedAtMs: t,
        confirmed: false,
        storeMessage: false,
        stallLogged: false,
        lastChangeAt: t,
        lastScanAt: t,
        lastEmitAt: 0,
        lastEmittedState: null,
        fingerprint: null,
        inFlight: false,
        scanDue: false,
        ticking: false,
        ended: false
      }
      watches.set(w.game.id, w)
      deps.log.info(
        `${w.game.title}: tracking the ${w.storeName} install (${w.measured ? 'measured' : 'state-only'}${w.probe ? '' : ', scan only'})`
      )
      emit(w, true)
      arm(w)
      return { progress: { ...w.progress }, created: true, cancel: () => cancelWatch(w) }
    },

    cancel(gameId) {
      const w = watches.get(gameId)
      return w ? cancelWatch(w) : false
    },

    has: (gameId) => watches.has(gameId),

    list: () => [...watches.values()].map((w) => ({ ...w.progress })),

    pause() {
      if (paused) return
      paused = true
      pausedAt = now()
      for (const w of watches.values()) {
        if (w.timer) clearTimeout(w.timer)
        w.timer = null
      }
    },

    resume() {
      if (!paused) return
      paused = false
      const gap = Math.max(0, now() - pausedAt)
      for (const w of watches.values()) {
        w.startedAtMs += gap
        w.lastChangeAt += gap
        w.lastScanAt += gap
        arm(w)
      }
    },

    dispose() {
      disposed = true
      for (const w of watches.values()) {
        w.ended = true
        if (w.timer) clearTimeout(w.timer)
        w.timer = null
      }
      watches.clear()
    }
  }
}
