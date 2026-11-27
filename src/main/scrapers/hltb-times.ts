// The Library's H.L.T.B. sort: the HowLongToBeat times of the library's games that have none yet, looked up while the
// user has that sort chosen (the renderer asks through the refreshHltbTimes IPC call when the sort is shown, then every
// 30 minutes), never in the background otherwise. Only times: no text or art is scraped again. A game is asked about
// when it has no time and was never looked up, or HLTB had no match for it over HLTB_MISS_RETRY_MS ago (a recorded
// miss is respected); never a game with times, a host's game, or one whose import is still pending (the import looks
// it up itself). The lookups go through hltb.ts (its one-a-second limiter and its pause after repeated failures).
import { hasHltbTimes, hltbTimesDue } from '../../shared/hltb-time'
import type { Game, GameMetadata, HltbProgress } from '../../shared/types'
import type { Logger } from '../logger'
import type { HltbTimes } from './hltb'

/** How often the games given times in a run are announced (one `library:changed` for all of them). */
export const HLTB_TIMES_BATCH_MS = 3_000
/** 'hltb:progress' at most this often (plus the first and last report of a run). */
export const HLTB_TIMES_PROGRESS_MS = 500
/** A run stops after this many failed lookups in a row (HLTB unreachable); the next request tries again. */
export const HLTB_TIMES_MAX_FAILURES = 5

export interface HltbTimesDeps {
  library: {
    games(): Game[]
    getGame(id: string): Game | undefined
    applyMetadata(
      id: string,
      update: { metadata?: Partial<GameMetadata> },
      options?: { overwrite?: boolean; quiet?: boolean }
    ): unknown
  }
  /** Settings > Metadata's HowLongToBeat switch, read before every lookup. */
  enabled(): boolean
  /** hltb.ts hltbLookupOutcome: an answer (times, or null for "no match") or a failure. */
  lookup(
    title: string,
    year?: number,
    consoles?: string[]
  ): Promise<{ times: HltbTimes | null; failed: boolean }>
  /** hltb.ts hltbPaused: lookups are paused after repeated failures (the run stops). */
  paused(): boolean
  /** What a game is looked up by: its title (the user's override first), release year and console names. */
  queryOf(game: Game): { title: string; year?: number; consoles?: string[] }
  /** metadata-service.ts HLTB_MATCH_RULES, recorded with what is written. */
  matchRules: number
  /** A miss is asked about again after this long (metadata-service.ts HLTB_MISS_RETRY_MS). */
  missRetryMs: number
  /** Another HLTB pass running (the start-up backfill): a run waits for it, so two passes never interleave. */
  busy?: () => Promise<unknown> | null
  /** The games given times since the last call (written quietly): announced as one `library:changed`. */
  onChanged(gameIds: string[]): void
  /** 'hltb:progress': games looked at of the run's total; total 0 when the run ends, however it ends. */
  onProgress(progress: HltbProgress): void
  log: Logger
  now?: () => number
  batchIntervalMs?: number
  progressIntervalMs?: number
  maxFailures?: number
}

export interface HltbTimesService {
  /**
   * Look up the times of every game that needs them (hltbTimesDue), one at a time. One run at a time: a call during a
   * run gets that run.
   */
  refresh(): Promise<void>
  /**
   * The H.L.T.B. sort is no longer shown: the run stops after the lookup in progress (its answer is still written),
   * flushes its batch and reports total 0. A refresh after a stop starts a new run once the stopped one is through.
   */
  stop(): void
  /** The run in progress (settled, never rejected), or null when none runs. */
  running(): Promise<void> | null
  dispose(): void
}

const timeOf = (iso: string | undefined): number => {
  const at = Date.parse(iso ?? '')
  return Number.isNaN(at) ? 0 : at
}

// The rules live in shared/hltb-time.ts (the browser mock goes by them too).
export { hasHltbTimes, hltbTimesDue }

export function createHltbTimes(deps: HltbTimesDeps): HltbTimesService {
  const { library, log } = deps
  const now = deps.now ?? Date.now
  const batchIntervalMs = deps.batchIntervalMs ?? HLTB_TIMES_BATCH_MS
  const progressIntervalMs = deps.progressIntervalMs ?? HLTB_TIMES_PROGRESS_MS
  const maxFailures = Math.max(1, deps.maxFailures ?? HLTB_TIMES_MAX_FAILURES)
  const changed = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let current: Promise<void> | null = null
  let disposed = false
  /** Bumped by stop(): a run started under an older generation stops before its next lookup. */
  let generation = 0
  let currentGeneration = -1

  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!changed.size) return
    const ids = [...changed]
    changed.clear()
    deps.onChanged(ids)
  }

  function noteChanged(id: string): void {
    changed.add(id)
    if (flushTimer || disposed) return
    flushTimer = setTimeout(flush, batchIntervalMs)
    ;(flushTimer as { unref?: () => void }).unref?.()
  }

  const due = (game: Game): boolean => hltbTimesDue(game, now(), deps.missRetryMs)

  /** The games to look up: most recently played first, then installed ones, then A to Z. */
  function dueGames(): string[] {
    return library
      .games()
      .filter(due)
      .sort(
        (a, b) =>
          timeOf(b.lastPlayed) - timeOf(a.lastPlayed) ||
          Number(b.installed) - Number(a.installed) ||
          a.title.localeCompare(b.title)
      )
      .map((g) => g.id)
  }

  async function run(gen: number): Promise<void> {
    const stopped = (): boolean => disposed || gen !== generation
    const other = deps.busy?.()
    if (other) await other.catch(() => {})
    if (stopped() || !deps.enabled() || deps.paused()) return
    const ids = dueGames()
    if (!ids.length) return
    log.info(`hltb: looking up ${ids.length} game(s) without times for the H.L.T.B. sort`)
    let lastReport = 0
    const report = (done: number, title?: string, force = false): void => {
      const at = now()
      if (!force && at - lastReport < progressIntervalMs) return
      lastReport = at
      if (!disposed)
        deps.onProgress({
          done: Math.min(done, ids.length),
          total: ids.length,
          source: 'sort',
          ...(title ? { current: title } : {})
        })
    }
    let found = 0
    let failedInRow = 0
    report(0, undefined, true)
    try {
      for (const [index, id] of ids.entries()) {
        if (stopped()) {
          log.info('hltb: the H.L.T.B. sort is no longer shown; its lookups stop')
          break
        }
        if (!deps.enabled()) break
        if (deps.paused()) {
          log.info('hltb: lookups are paused; the H.L.T.B. sort asks again later')
          break
        }
        const game = library.getGame(id)
        // Given times meanwhile (a refresh, the import), or gone.
        if (!game || !due(game)) continue
        const query = deps.queryOf(game)
        report(index, query.title, index === 0)
        const outcome = await deps
          .lookup(query.title, query.year, query.consoles)
          .catch(() => ({ times: null, failed: true }))
        if (disposed) break
        if (outcome.failed) {
          if (++failedInRow >= maxFailures) {
            log.info('hltb: lookups are not answering; the H.L.T.B. sort asks again later')
            break
          }
          continue
        }
        failedInRow = 0
        const latest = library.getGame(id)
        if (!latest || hasHltbTimes(latest)) continue
        const at = new Date(now()).toISOString()
        if (outcome.times) {
          library.applyMetadata(
            id,
            { metadata: { hltb: { ...outcome.times, rules: deps.matchRules, updatedAt: at } } },
            { overwrite: true, quiet: true }
          )
          noteChanged(id)
          found++
        } else {
          // No match: recorded, so the sort does not ask about it again within HLTB_MISS_RETRY_MS.
          library.applyMetadata(
            id,
            { metadata: { hltb: { missedAt: at, rules: deps.matchRules } } },
            { overwrite: true, quiet: true }
          )
        }
      }
    } finally {
      if (!disposed) deps.onProgress({ done: 0, total: 0, source: 'sort' })
    }
    log.info(`hltb: ${found} of ${ids.length} game(s) have times for the H.L.T.B. sort`)
  }

  return {
    refresh() {
      if (disposed) return Promise.resolve()
      // A run of this generation is going: that run. One stopped meanwhile: a new run once it is through.
      if (current && currentGeneration === generation) return current
      const gen = generation
      const previous = current
      const next: Promise<void> = (previous ?? Promise.resolve())
        .then(() => run(gen))
        .catch((err) => log.error('hltb times refresh failed', err))
        .finally(() => {
          if (current === next) {
            current = null
            currentGeneration = -1
          }
          flush()
        })
      current = next
      currentGeneration = gen
      return next
    },
    stop() {
      generation++
    },
    running() {
      return current
    },
    dispose() {
      disposed = true
      flush()
    }
  }
}
