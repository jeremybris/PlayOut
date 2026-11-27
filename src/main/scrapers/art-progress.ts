// The game-art downloads' progress for the bottom bars (docs/ARCHITECTURE.md §4.6 "Art progress"): the cover lane's
// games first ("Downloading cover art · n of m"), then the full lane's remaining art (hero, logo, icon,
// screenshots). 'metadata:progress' already carries the lanes' sizes, but per game and without a done count of
// its own per lane (its `done` counts games through both lanes, which lags the covers by an hour), so the bar has
// its own throttled event.
import type { ArtProgress, ArtProgressStage } from '../../shared/types'

/** 'art:progress' at most this often (the first report of a run and the idle report go out at once). */
export const ART_PROGRESS_INTERVAL_MS = 250

export interface ArtProgressTracker {
  /** One game through the stage (covered, given up on, or removed). Call after the lane's queues are updated. */
  finished(stage: ArtProgressStage): void
  /** The lanes' queues changed (games queued, moved between stages): report soon. */
  changed(): void
  /** Stop the timer (no more events). */
  dispose(): void
}

export interface ArtProgressOptions {
  /** Games still to go in a stage (waiting + in flight), read when a report is made. */
  remaining: (stage: ArtProgressStage) => number
  emit: (progress: ArtProgress) => void
  intervalMs?: number
  now?: () => number
}

const IDLE: ArtProgress = { stage: 'cover', done: 0, total: 0 }

export function createArtProgress(options: ArtProgressOptions): ArtProgressTracker {
  const { remaining, emit } = options
  const intervalMs = options.intervalMs ?? ART_PROGRESS_INTERVAL_MS
  const now = options.now ?? Date.now
  const done: Record<ArtProgressStage, number> = { cover: 0, art: 0 }
  let last: ArtProgress = IDLE
  let lastAt = Number.NEGATIVE_INFINITY
  let timer: NodeJS.Timeout | null = null
  let disposed = false

  /** The stage on show: covers while the cover lane has games, then the remaining art; total 0 = idle. */
  function snapshot(): ArtProgress {
    for (const stage of ['cover', 'art'] as const) {
      const left = remaining(stage)
      if (left <= 0) {
        done[stage] = 0
        continue
      }
      return { stage, done: done[stage], total: done[stage] + left }
    }
    return IDLE
  }

  function report(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (disposed) return
    const next = snapshot()
    if (next.stage === last.stage && next.done === last.done && next.total === last.total) return
    last = next
    lastAt = now()
    emit(next)
  }

  function changed(): void {
    if (disposed) return
    const next = snapshot()
    // A run starting or ending is reported at once: the bar appears with the queue and leaves with the last game.
    if ((next.total === 0) !== (last.total === 0)) {
      report()
      return
    }
    if (timer) return
    const wait = lastAt + intervalMs - now()
    if (wait <= 0) {
      report()
      return
    }
    timer = setTimeout(report, wait)
    timer.unref?.()
  }

  return {
    finished(stage) {
      done[stage]++
      changed()
    },
    changed,
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
