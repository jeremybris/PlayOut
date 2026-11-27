// The scheduling shared by the background achievements scans (Steam, RetroAchievements, GOG, Epic): a game is read once
// when it joins the library and again only once it was played after its last read. The record of those reads is a
// JSON file per scan; a failed read waits out a growing pause and, after SCAN_PARK_AFTER failures in a row, waits for a
// play (or a sign-in, an import, the next start). A rate limit, a Retry-After or no network pauses the whole scan.
import { readFile } from 'node:fs/promises'
import type { Game } from '../../shared/types'
import { HttpError } from '../scrapers/http'

/** The longest a failed scan step waits. */
export const SCAN_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
/** A game whose read failed this many times in a row is no longer retried on a timer (only after a play, etc.). */
export const SCAN_PARK_AFTER = 5

/** A game's line in a scan record: when it was last read, and what happened since. */
export interface ScanEntry {
  /** When the store last answered for the game (epoch ms); absent while its reads only failed. */
  at?: number
  /** The game's last played then (null: none): a later one since = played since (here, on a paired PC). */
  seen?: string | null
  /** When a PlayOut play session of the game ended (epoch ms): after `at` = read again. */
  playedAt?: number
  /** Failed reads in a row, and when the next one may run. */
  fails?: number
  retryAt?: number
  /** Failed SCAN_PARK_AFTER times in a row (epoch ms): no timed retry, only after a play, a sign-in or a restart. */
  parkedAt?: number
}

/** A parked game gets one more try (a new start, a sign-in, an import). */
export function unpark(entry: ScanEntry): void {
  if (entry.parkedAt === undefined) return
  delete entry.parkedAt
  delete entry.fails
}

/** The wait after `fails` failures in a row: `baseMs`, doubled each time, up to SCAN_BACKOFF_MAX_MS. */
export function scanBackoff(baseMs: number, fails: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, fails - 1), SCAN_BACKOFF_MAX_MS)
}

/** A rate limit, a network failure or a Retry-After: everything waits, not just the game asked about. */
export function sharedFailure(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    (err.status === 429 || err.status === 0 || err.retryAfterMs !== undefined)
  )
}

/** The wait a server asked for (Retry-After), 0 when none. */
export const askedWait = (err: unknown): number =>
  err instanceof HttpError ? (err.retryAfterMs ?? 0) : 0

/**
 * These games' reads failed once more: each waits longer than the last time, or is parked after SCAN_PARK_AFTER
 * failures in a row. Returns when the first of them may be read again (Infinity: all parked).
 */
export function failEntries<E extends ScanEntry>(
  table: Record<string, E>,
  ids: string[],
  baseMs: number,
  err: unknown,
  now = Date.now()
): number {
  const asked = askedWait(err)
  let retry = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const entry = { ...table[id] } as E
    const fails = (entry.fails ?? 0) + 1
    delete entry.retryAt
    if (fails >= SCAN_PARK_AFTER) {
      table[id] = { ...entry, fails, parkedAt: now }
      continue
    }
    const retryAt = now + Math.max(scanBackoff(baseMs, fails), asked)
    table[id] = { ...entry, fails, retryAt }
    retry = Math.min(retry, retryAt)
  }
  return retry
}

/**
 * Played after `since`: a PlayOut session ended (or a paired PC's session arrived) after it, or the game's last played
 * changed to a later time than the one seen at the last read and after it (compared with the value seen, so a clock
 * ahead of this PC's cannot keep the game due).
 */
export function playedAfter(
  game: Pick<Game, 'lastPlayed'>,
  entry: ScanEntry,
  since: number,
  lastSession: number | undefined
): boolean {
  if (entry.playedAt && entry.playedAt > since) return true
  if (lastSession !== undefined && lastSession > since) return true
  const lastPlayed = game.lastPlayed ? Date.parse(game.lastPlayed) : Number.NaN
  if (
    Number.isFinite(lastPlayed) &&
    lastPlayed > since &&
    (game.lastPlayed ?? null) !== (entry.seen ?? null)
  ) {
    const seen = entry.seen ? Date.parse(entry.seen) : Number.NaN
    if (!Number.isFinite(seen) || lastPlayed > seen) return true
  }
  return false
}

/**
 * Whether a game is due: never read, a failed read whose wait is over, or played after its last read (`playedSince`).
 * A parked game waits for a play.
 */
export function scanDue(
  entry: ScanEntry | undefined,
  now: number,
  playedSince: (since: number) => boolean
): boolean {
  if (!entry) return true
  if (entry.parkedAt !== undefined) return playedSince(Math.max(entry.parkedAt, entry.at ?? 0))
  if (entry.retryAt && now < entry.retryAt) return false
  if (entry.at === undefined) return true
  return playedSince(entry.at)
}

/**
 * The record a game's answer leaves: when it was read and the last played seen then. A session that ended after the
 * read keeps the game due.
 */
export function readEntry(
  game: Pick<Game, 'lastPlayed'>,
  previous: ScanEntry | undefined,
  at: number
): ScanEntry {
  const playedAt = previous?.playedAt
  return {
    at,
    seen: game.lastPlayed ?? null,
    ...(playedAt && playedAt > at ? { playedAt } : {})
  }
}

/** When each game's newest play session reached this PC (epoch ms): a paired PC's from its sync, one here from its end. */
export function lastSessionTimes(
  sessions: readonly { gameId: string; endedAt?: string; syncedAt?: string }[]
): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of sessions) {
    const when = Date.parse(s.syncedAt ?? s.endedAt ?? '')
    if (!Number.isFinite(when)) continue
    if (when > (out.get(s.gameId) ?? 0)) out.set(s.gameId, when)
  }
  return out
}

// --- the record file ------------------------------------------------------------------

export interface ScanRecord<E extends ScanEntry> {
  /** The record, read once (parked games get one more try on every start). */
  load(): Promise<Record<string, E>>
  /** Written (games that left the library leave it first). */
  save(): Promise<void>
  /** The record when it was read already, else null. */
  loaded(): Record<string, E> | null
  /** Change the record now when read, else once it is (a reset before the first read). */
  change(fn: (table: Record<string, E>) => void): void
}

export function createScanRecord<E extends ScanEntry>(options: {
  file: string
  /** Whether a game id is still in the library (others leave the record on save). */
  keep(id: string): boolean
  write(file: string, value: unknown): Promise<void>
  onSaveError(err: unknown): void
}): ScanRecord<E> {
  let table: Record<string, E> | null = null
  let loading: Promise<Record<string, E>> | null = null
  const pending: ((table: Record<string, E>) => void)[] = []

  function load(): Promise<Record<string, E>> {
    if (table) return Promise.resolve(table)
    loading ??= (async () => {
      let read: Record<string, E> = {}
      try {
        const parsed = JSON.parse(await readFile(options.file, 'utf8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          read = parsed as Record<string, E>
      } catch {
        // No record yet: every game is new to the scan.
      }
      // A new start: games parked after failing again and again get one more try.
      for (const entry of Object.values(read)) unpark(entry)
      table = read
      for (const fn of pending.splice(0)) fn(read)
      return read
    })()
    return loading
  }

  async function save(): Promise<void> {
    if (!table) return
    for (const id of Object.keys(table)) if (!options.keep(id)) delete table[id]
    await options.write(options.file, table).catch((err) => options.onSaveError(err))
  }

  return {
    load,
    save,
    loaded: () => table,
    change(fn) {
      if (table) {
        fn(table)
        void save()
      } else pending.push(fn)
    }
  }
}

// --- the runner -----------------------------------------------------------------------

export interface ScanRunnerOptions {
  /** The first pass waits this long after start (0: none until run or kick). */
  startDelayMs: number
  /** How long kick waits for more changes. */
  kickDelayMs: number
  /** The first pause after a failed step (doubled each failure in a row). */
  backoffMs: number
  /** One pass of the scan. */
  pass(): Promise<void>
  /** A pass threw. */
  onError(err: unknown): void
}

export interface ScanRunner {
  /** Run a pass now (one at a time: a call during a pass runs another right after it). Not before the start delay. */
  run(): Promise<void>
  /** Run a pass in `ms`, unless one is already set to run sooner. */
  schedule(ms: number): void
  /** Things changed: a pass once they settle (a pause after a failure is not cut short). */
  kick(): void
  /** The whole scan pauses after a failure (longer each failure in a row, at least `asked`); returns the wait. */
  pause(asked?: number): number
  /** How long the pause still lasts (0: none). */
  pausedFor(): number
  /** A whole pass went through: the next failure starts the pause over. */
  passed(): void
  /** Forget the pause (the credential changed). */
  clearPause(): void
  started(): boolean
  dispose(): void
}

export function createScanRunner(options: ScanRunnerOptions): ScanRunner {
  let disposed = false
  let started = options.startDelayMs <= 0
  let startTimer: NodeJS.Timeout | null = null
  let timer: NodeJS.Timeout | null = null
  let timerAt = 0
  let pausedUntil = 0
  let pauseFails = 0
  let running: Promise<void> | null = null
  let again = false

  function run(): Promise<void> {
    if (disposed || !started) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          try {
            await options.pass()
          } catch (err) {
            options.onError(err)
          }
        } while (again && !disposed)
      } finally {
        running = null
      }
    })()
    return running
  }

  function schedule(ms: number): void {
    if (disposed || !started) return
    const fireAt = Date.now() + Math.max(0, ms)
    if (timer && timerAt <= fireAt) return
    if (timer) clearTimeout(timer)
    timerAt = fireAt
    timer = setTimeout(
      () => {
        timer = null
        void run()
      },
      Math.max(0, ms)
    )
    timer.unref?.()
  }

  if (!started) {
    startTimer = setTimeout(() => {
      startTimer = null
      started = true
      void run()
    }, options.startDelayMs)
    startTimer.unref?.()
  }

  return {
    run,
    schedule,
    kick() {
      if (disposed || !started) return
      schedule(Math.max(options.kickDelayMs, pausedUntil - Date.now()))
    },
    pause(asked = 0) {
      pauseFails++
      const wait = Math.max(scanBackoff(options.backoffMs, pauseFails), asked)
      pausedUntil = Date.now() + wait
      schedule(wait)
      return wait
    },
    pausedFor: () => Math.max(0, pausedUntil - Date.now()),
    passed() {
      pauseFails = 0
    },
    clearPause() {
      pausedUntil = 0
      pauseFails = 0
    },
    started: () => started,
    dispose() {
      disposed = true
      if (startTimer) clearTimeout(startTimer)
      if (timer) clearTimeout(timer)
    }
  }
}
