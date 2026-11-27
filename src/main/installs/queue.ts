// The install queue (docs/ARCHITECTURE.md §4.8 "Install queue"): one game downloads at a time, whatever the store,
// and a ROM download from another PC waits its turn too. Two stores downloading at once only split the connection
// and the disk, and the user asked for one download at a time. Each kind of entry has a runner that does the actual
// work (installs/index.ts for store installs, streaming-service.ts for ROM downloads); the queue only decides who
// goes next. It is saved on every change, so a restart resumes the download that was running and keeps the line.
//
// Stopping is by run, never by game id: each start gets its own abort signal and returns its own `stop`, which undoes
// exactly what that start created. A game removed and added again while its first start still runs therefore never
// has the new run's watch or job stopped by the old one, and the new run only starts once the old one settled.
import { z } from 'zod'
import type { InstallQueueEntry, StoreSourceId } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { JsonStore } from '../store/json-store'
import { tMain } from '../i18n'

export type InstallQueueKind = InstallQueueEntry['kind']

/** What a caller adds; the queue sets the state and the time. */
export type InstallQueueItem = Omit<InstallQueueEntry, 'state' | 'addedAt'>

/** What one start set going: `stop` undoes exactly that (its own watch or job), never anything else of the game. */
export interface InstallQueueStart {
  error?: string
  /**
   * Settles when the download ended in any way (done, failed, cancelled, stopped). No `done` counts as ended at once.
   * Settling with 'retry' keeps the entry in the queue as waiting at its place instead of dropping it (its source
   * could not be reached); the runner's `ready` then holds it back until the runner pokes the queue. 'finished': it
   * ended for good although it was stopped meanwhile (a pause that came after the transfer, while the game was being
   * added): an entry paused by that stop leaves the queue instead of waiting paused for a download already done.
   */
  done?: Promise<void | 'retry' | 'finished'>
  /**
   * Stop what this start created (its tracker watch, its ROM job); safe to call more than once. `reason` 'pause': the
   * user paused it (the runner keeps what it has, so a later start continues, and shows it as paused, not cancelled).
   */
  stop?: (reason?: 'pause') => void
}

export interface InstallQueueStartOptions {
  /** It was the active one when PlayOut closed, so the store or the partial files may already have it. */
  resumed: boolean
  /**
   * The runner said, in an earlier run of PlayOut, that the hand-off was done (`markHandedOff`); false for a new
   * start, and for a resumed entry whose hand-off may not have happened (PlayOut closed during it).
   */
  handedOff: boolean
  /** The hand-off is done (the store was asked): saved with the entry, so a restart only resumes watching. */
  markHandedOff(): void
  signal: AbortSignal
}

export interface InstallQueueRunner {
  /**
   * Start the entry's download (its turn came). `error` ends the entry at once. `signal` aborts when the entry is no
   * longer wanted (removed): the runner checks it after every await and then returns without creating anything or
   * emitting; whatever it already created is undone through the `stop` it returns, which the queue calls. Two starts
   * of one game never overlap: a start waits (bounded) until the previous run of the same game settled.
   */
  start(entry: InstallQueueEntry, options: InstallQueueStartOptions): Promise<InstallQueueStart>
  /** A start that nobody waits on (its turn came later) failed: shown the way the runner shows its own failures. */
  reportError(entry: InstallQueueEntry, message: string): void
  /** At its turn: true drops the entry without a word (the game was installed meanwhile, or is gone). */
  skip?(entry: InstallQueueEntry): boolean
  /**
   * False holds the entry back (its source is unreachable): it keeps its place, entries after it may start, and it is
   * looked at again when the runner calls `poke`. Absent: always ready.
   */
  ready?(entry: InstallQueueEntry): boolean
  /**
   * Why a waiting entry is held back, for display (InstallQueueEntry.waitingFor: "Waiting for PC1 to come back
   * online"); undefined when it simply waits its turn. Read on every list; the runner calls `poke` when it changes.
   */
  waitingFor?(entry: InstallQueueEntry): string | undefined
  /**
   * The user paused the active entry. 'stop' (the default): its run is stopped (`stop('pause')`) and it goes back to
   * waiting, paused, at the front; the next entry starts. 'hold': it cannot be paused from here (a store's download),
   * so it stays the active entry, marked paused, and the line waits for it as before; the runner does what it can
   * (opens the store's downloads page). Called only for an active entry that is not paused yet. A saved active entry
   * that is paused is asked again at `begin` (no side effects expected then: `resumed` is true).
   */
  pauseActive?(entry: InstallQueueEntry, options: { resumed: boolean }): 'stop' | 'hold'
}

export interface InstallQueue {
  register(kind: InstallQueueKind, runner: InstallQueueRunner): void
  /**
   * Queue a game. Already queued: its place. Nothing downloading: it starts now and a start error is returned (the
   * caller shows it), never reported too. Otherwise it waits: `position` 1 is next. The active entry is position 0.
   * A full queue (MAX_QUEUE_ENTRIES) returns an error and adds nothing.
   */
  add(item: InstallQueueItem): Promise<{ position: number; error?: string }>
  /** Take a game out: a waiting one just leaves, the active one is stopped and the next one starts. */
  remove(gameId: string): void
  /** Move a waiting game one place earlier (-1) or later (1); the active entry keeps its place. */
  move(gameId: string, delta: -1 | 1): void
  /**
   * Pause a game (null: every game). A waiting one keeps its place but is skipped until resumed; the active one goes
   * as its runner's `pauseActive` says (stopped and back to waiting, paused, at the front, or held active). Saved.
   */
  pause(gameId: string | null): void
  /** Resume a paused game (null: every one): it starts in its turn, at once when nothing downloads. */
  resume(gameId: string | null): void
  /** The active entry first, then the waiting ones in order. */
  list(): InstallQueueEntry[]
  has(gameId: string): boolean
  /** The game downloading now, or null. */
  activeId(): string | null
  /**
   * Called once both runners are registered and the start-up scan is done (a game installed while PlayOut was
   * closed is then known as installed): the saved active entry resumes, then the line moves on.
   */
  begin(): Promise<void>
  /**
   * Something a runner's `ready` or `waitingFor` depends on changed (a host is online again): the list goes out again
   * ('installs:queue'), entries held back are looked at again and, when nothing downloads, the first ready one starts.
   */
  poke(): void
  /** PlayOut quits: no more starts, completions are ignored and the file keeps the active entry for the next run. */
  dispose(): Promise<void>
}

export interface InstallQueueDeps {
  /** userData/installs/queue.json */
  stateFile: string
  events: Pick<EventBus, 'emit'>
  log: Logger
  now?: () => number
  /** A new run of a game waits at most this long for the previous run of the same game to settle. */
  settleWaitMs?: number
}

/** A start of a game waits at most this long for the previous run of the same game to settle. */
export const SETTLE_WAIT_MS = 30_000
/** The queue holds at most this many games; one more is refused. */
export const MAX_QUEUE_ENTRIES = 1000
export const MAX_TITLE_LENGTH = 500
export const MAX_FROM_LENGTH = 200
const MAX_GAME_ID_LENGTH = 600

/**
 * An entry as kept in queue.json. `handedOff` (main only, never in the public list): the runner said the hand-off
 * was done (the store was asked). A resumed entry without it, including one from a file written before the flag
 * existed, gets the full hand-off again: re-sending a store's install request for a game it already has is harmless,
 * while only watching a game the store was never asked for would wait for an install that never comes.
 */
type StoredEntry = InstallQueueEntry & { handedOff?: boolean }

const entrySchema = z.object({
  gameId: z.string().min(1).max(MAX_GAME_ID_LENGTH),
  title: z.string().max(MAX_TITLE_LENGTH),
  kind: z.enum(['store', 'host-rom']),
  source: z.string().min(1).max(40),
  from: z.string().max(MAX_FROM_LENGTH),
  state: z.enum(['active', 'waiting']),
  addedAt: z.string().max(40),
  handedOff: z.boolean().optional(),
  paused: z.boolean().optional()
})
const fileSchema = z.object({ version: z.literal(1), entries: z.array(z.unknown()) })
type QueueFile = { version: 1; entries: StoredEntry[] }

/** The file's entries one by one: an invalid one is dropped, never the whole line. */
function normalize(raw: unknown): QueueFile | null {
  const parsed = fileSchema.safeParse(raw)
  if (!parsed.success) return null
  const entries: StoredEntry[] = []
  for (const item of parsed.data.entries) {
    if (entries.length >= MAX_QUEUE_ENTRIES) break
    const e = entrySchema.safeParse(item)
    if (!e.success || entries.some((x) => x.gameId === e.data.gameId)) continue
    const { handedOff, paused, ...rest } = e.data
    entries.push({
      ...rest,
      source: rest.source as StoreSourceId | 'host',
      ...(handedOff ? { handedOff: true } : {}),
      ...(paused ? { paused: true } : {})
    })
  }
  // At most one active, and it goes first.
  const active = entries.findIndex((e) => e.state === 'active')
  for (const [i, e] of entries.entries()) if (i !== active) e.state = 'waiting'
  if (active > 0) entries.unshift(...entries.splice(active, 1))
  return { version: 1, entries }
}

/** The public shape (no main-only fields). */
function publicEntry(e: StoredEntry): InstallQueueEntry {
  return {
    gameId: e.gameId,
    title: e.title,
    kind: e.kind,
    source: e.source,
    from: e.from,
    state: e.state,
    addedAt: e.addedAt,
    ...(e.paused ? { paused: true } : {})
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message || String(err) : String(err)
}

/** Settles when `p` does, or after `ms` at most (the timer does not keep PlayOut running). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    p.then(done, done)
  })
}

/** One start of the active entry: its own abort signal and, once the start returned, its own stop. */
interface Run {
  entry: StoredEntry
  ac: AbortController
  stop?: (reason?: 'pause') => void
  /** Stopped because the user paused it: its stop gets 'pause'. */
  pausing?: boolean
}

export function createInstallQueue(deps: InstallQueueDeps): InstallQueue {
  const { log, events } = deps
  const now = deps.now ?? Date.now
  const settleWaitMs = deps.settleWaitMs ?? SETTLE_WAIT_MS
  const runners = new Map<InstallQueueKind, InstallQueueRunner>()
  const file = new JsonStore<QueueFile>({
    file: deps.stateFile,
    defaults: () => ({ version: 1, entries: [] }),
    normalize,
    debounceMs: 50
  })
  let entries: StoredEntry[] = []
  /** The run of the active entry (started this run); null for an active entry loaded from the file until `begin`. */
  let current: Run | null = null
  /** Per game: settles once its latest run's start and download both ended, so the next run of it may start. */
  const settling = new Map<string, Promise<void>>()
  /**
   * Games whose last run asked for a retry (their source was unreachable): not started again until `poke`, whatever
   * their runner's `ready` says, so a runner that forgets to hold them back cannot make the queue loop.
   */
  const held = new Set<string>()
  let begun = false
  let disposed = false
  const loaded = file.load().then(
    (data) => {
      entries = data.entries.map((e) => ({ ...e }))
    },
    (err) => log.error(`install queue could not be read: ${errorText(err)}`)
  )

  function save(): void {
    if (disposed) return
    file.replace({ version: 1, entries: entries.map((e) => ({ ...e })) })
  }

  function changed(): void {
    if (disposed) return
    save()
    events.emit('installs:queue', list())
  }

  function list(): InstallQueueEntry[] {
    return entries.map((e) => {
      const entry = publicEntry(e)
      if (e.state !== 'waiting') return entry
      let reason: string | undefined
      try {
        reason = runners.get(e.kind)?.waitingFor?.(entry)
      } catch (err) {
        log.warn(`${e.title}: waiting reason failed: ${errorText(err)}`)
      }
      return reason ? { ...entry, waitingFor: reason.slice(0, MAX_TITLE_LENGTH) } : entry
    })
  }

  function active(): StoredEntry | undefined {
    return entries[0]?.state === 'active' ? entries[0] : undefined
  }

  /** 0 for the active entry, else its place in line (1 = next). */
  function position(index: number): number {
    return active() ? index : index + 1
  }

  function drop(gameId: string): void {
    entries = entries.filter((e) => e.gameId !== gameId)
    held.delete(gameId)
  }

  /** Whether the entry may start now (not held back by its last run or by its runner). */
  function isReady(entry: StoredEntry, runner: InstallQueueRunner): boolean {
    if (entry.paused || held.has(entry.gameId)) return false
    try {
      return runner.ready?.(publicEntry(entry)) !== false
    } catch (err) {
      log.warn(`${entry.title}: readiness check failed: ${errorText(err)}`)
      return true
    }
  }

  function stopRun(r: Run): void {
    try {
      r.stop?.(r.pausing ? 'pause' : undefined)
    } catch (err) {
      log.warn(`${r.entry.title}: could not be stopped: ${errorText(err)}`)
    }
  }

  /** How the runner pauses this active entry: 'stop' unless it says 'hold'. */
  function pauseMode(entry: StoredEntry, resumed: boolean): 'stop' | 'hold' {
    try {
      const runner = runners.get(entry.kind)
      return runner?.pauseActive?.(publicEntry(entry), { resumed }) === 'hold' ? 'hold' : 'stop'
    } catch (err) {
      log.warn(`${entry.title}: pause failed: ${errorText(err)}`)
      return 'stop'
    }
  }

  /**
   * Pause the active entry `a` (not paused yet): held active (its runner cannot pause it), or its run stopped with
   * 'pause' and the entry back to waiting, paused, at the front. The caller saves, emits and starts the next one.
   */
  function pauseActive(a: StoredEntry): void {
    a.paused = true
    if (pauseMode(a, false) === 'hold') {
      log.info(`${a.title}: paused (${a.from} keeps downloading until it is paused there)`)
      return
    }
    const r = current
    current = null
    if (r) {
      r.pausing = true
      // A start still running sees the signal; what it made is stopped once it returns.
      r.ac.abort()
      stopRun(r)
    }
    a.state = 'waiting'
    delete a.handedOff
    log.info(`${a.title}: paused in the install queue`)
  }

  /** Start the entry at the front; resolves with the start error when it failed (already dropped then). */
  async function run(
    entry: StoredEntry,
    runner: InstallQueueRunner,
    resumed: boolean
  ): Promise<string | undefined> {
    const r: Run = { entry, ac: new AbortController() }
    current = r
    const gameId = entry.gameId
    const previous = settling.get(gameId)
    let release: () => void = () => {}
    const settled = new Promise<void>((resolve) => (release = resolve))
    settling.set(gameId, settled)
    const cleanup = (): void => {
      release()
      if (settling.get(gameId) === settled) settling.delete(gameId)
    }
    // The same game removed and added again: its previous run (being stopped) ends first, so two never overlap.
    if (previous) await within(previous, settleWaitMs)
    if (r.ac.signal.aborted || disposed) {
      cleanup()
      return undefined
    }
    const handedOff = resumed && entry.handedOff === true
    // A fresh start hands off again: a saved flag belonged to an earlier run.
    if (!resumed && entry.handedOff) {
      delete entry.handedOff
      save()
    }
    let result: InstallQueueStart
    try {
      result = await runner.start(publicEntry(entry), {
        resumed,
        handedOff,
        markHandedOff: () => {
          if (disposed || current !== r || r.ac.signal.aborted || entry.handedOff) return
          if (!entries.includes(entry)) return
          entry.handedOff = true
          save()
        },
        signal: r.ac.signal
      })
    } catch (err) {
      result = { error: errorText(err) }
    }
    if (result.done) void result.done.then(cleanup, cleanup)
    else cleanup()
    if (!result.error) r.stop = result.stop
    // Removed while it started: what this start created is stopped, nothing else of the game.
    if (r.ac.signal.aborted) {
      stopRun(r)
      return undefined
    }
    if (disposed || current !== r) return undefined
    if (result.error) {
      log.warn(`${entry.title}: could not start (${result.error})`)
      finish(r)
      return result.error
    }
    log.info(`${entry.title}: ${resumed ? 'resumed' : 'started'} (${entry.from})`)
    if (result.done)
      void result.done.then(
        (outcome) => {
          if (outcome === 'finished' && current !== r) finishedAfterStop(r)
          else finish(r, outcome === 'retry')
        },
        () => finish(r)
      )
    else finish(r)
    return undefined
  }

  /**
   * A run stopped by a pause ended for good after all (it was past its transfer): its entry, waiting paused, leaves.
   * Not when the user resumed it meanwhile (its new run decides) or it is gone.
   */
  function finishedAfterStop(r: Run): void {
    if (disposed) return
    const e = entries.find((x) => x.gameId === r.entry.gameId)
    if (!e || e.state !== 'waiting' || !e.paused) return
    log.info(`${e.title}: finished while it was being paused; it leaves the install queue`)
    drop(e.gameId)
    changed()
    void next()
  }

  /**
   * The run `r` of the active entry ended: it leaves and the next one starts. `retry`: its source could not be
   * reached, so it stays in line at its place (waiting, held back until `poke`) and the next ready one starts.
   */
  function finish(r: Run, retry = false): void {
    if (disposed || current !== r) return
    current = null
    const a = active()
    if (a && retry) {
      a.state = 'waiting'
      delete a.handedOff
      held.add(a.gameId)
      log.info(`${a.title}: kept in the install queue until ${a.from} can be reached`)
    } else if (a) drop(a.gameId)
    changed()
    void next()
  }

  /**
   * Start the first ready entry when nothing runs (an entry held back keeps its place; the one started moves to the
   * front, as the active entry always is first). Nothing ready: the queue stays idle until `poke` or `add`. A start
   * that fails here is reported by its runner, since nobody waits on it.
   */
  async function next(): Promise<void> {
    outer: while (!disposed && begun && !active()) {
      for (const entry of entries) {
        const runner = runners.get(entry.kind)
        if (runner && !isReady(entry, runner)) continue
        if (!runner || runner.skip?.(publicEntry(entry))) {
          if (!runner)
            log.warn(`${entry.title}: nothing can download a ${entry.kind} entry; dropped`)
          drop(entry.gameId)
          changed()
          continue outer
        }
        entries = [entry, ...entries.filter((e) => e !== entry)]
        entry.state = 'active'
        changed()
        const error = await run(entry, runner, false)
        if (error) runner.reportError(publicEntry(entry), error)
        return
      }
      return
    }
  }

  return {
    register(kind, runner) {
      runners.set(kind, runner)
    },

    async add(item) {
      await loaded
      if (disposed) return { position: 0, error: tMain('mainInstalls.closing') }
      const at = entries.findIndex((e) => e.gameId === item.gameId)
      if (at >= 0) return { position: position(at) }
      if (!item.gameId || item.gameId.length > MAX_GAME_ID_LENGTH)
        return { position: 0, error: tMain('mainInstalls.cannotQueue') }
      if (entries.length >= MAX_QUEUE_ENTRIES)
        return {
          position: 0,
          error: tMain('mainInstalls.queueFull', { max: MAX_QUEUE_ENTRIES })
        }
      const entry: StoredEntry = {
        gameId: item.gameId,
        title: item.title.slice(0, MAX_TITLE_LENGTH),
        kind: item.kind,
        source: item.source,
        from: item.from.slice(0, MAX_FROM_LENGTH),
        state: 'waiting',
        addedAt: new Date(now()).toISOString()
      }
      // Nothing downloads (and no saved active entry waits for `begin`): it starts now, unless it is held back.
      if (!active() && (begun || !entries.length)) {
        const runner = runners.get(entry.kind)
        if (!runner) return { position: 0, error: tMain('mainInstalls.cannotStart') }
        if (isReady(entry, runner)) {
          entry.state = 'active'
          entries.unshift(entry)
          changed()
          const error = await run(entry, runner, false)
          return error ? { position: 0, error } : { position: 0 }
        }
      }
      // Something downloads (or waits for `begin`, or this one is held back): it waits its turn.
      entries.push(entry)
      changed()
      return { position: position(entries.length - 1) }
    },

    remove(gameId) {
      const entry = entries.find((e) => e.gameId === gameId)
      if (!entry) return
      if (entry.state === 'active') {
        const r = current
        current = null
        if (r) {
          // A start still running sees the signal; what it made is stopped once it returns.
          r.ac.abort()
          stopRun(r)
        }
        log.info(`${entry.title}: removed from the install queue while downloading`)
      }
      drop(gameId)
      changed()
      void next()
    },

    move(gameId, delta) {
      const i = entries.findIndex((e) => e.gameId === gameId)
      const j = i + delta
      if (i < 0 || entries[i].state !== 'waiting') return
      if (j < 0 || j >= entries.length || entries[j].state !== 'waiting') return
      ;[entries[i], entries[j]] = [entries[j], entries[i]]
      changed()
    },

    pause(gameId) {
      if (disposed) return
      const targets = entries.filter((e) => !e.paused && (gameId === null || e.gameId === gameId))
      if (!targets.length) return
      // The waiting ones first, so stopping the active one never starts one of them.
      for (const e of targets) if (e.state === 'waiting') e.paused = true
      const a = active()
      if (a && targets.includes(a)) pauseActive(a)
      log.info(`paused ${targets.length} game(s) in the install queue`)
      changed()
      void next()
    },

    resume(gameId) {
      if (disposed) return
      const targets = entries.filter((e) => e.paused && (gameId === null || e.gameId === gameId))
      if (!targets.length) return
      for (const e of targets) delete e.paused
      log.info(`resumed ${targets.length} game(s) in the install queue`)
      changed()
      void next()
    },

    list,
    has: (gameId) => entries.some((e) => e.gameId === gameId),
    activeId: () => active()?.gameId ?? null,

    async begin() {
      await loaded
      if (begun || disposed) return
      begun = true
      const saved = active()
      if (!saved || current) return void (await next())
      const runner = runners.get(saved.kind)
      if (!runner || runner.skip?.(publicEntry(saved))) {
        drop(saved.gameId)
        changed()
        return void (await next())
      }
      // Paused: a download the queue can stop stays stopped (waiting, paused); a store's keeps being watched.
      const heldPaused = saved.paused === true && pauseMode(saved, true) === 'hold'
      if (!heldPaused && !isReady(saved, runner)) {
        saved.state = 'waiting'
        changed()
        return void (await next())
      }
      const error = await run(saved, runner, true)
      if (error) runner.reportError(publicEntry(saved), error)
    },

    poke() {
      if (disposed) return
      held.clear()
      // The entries' waiting reasons may have changed (a host is back): the list goes out again.
      events.emit('installs:queue', list())
      if (begun && !active()) void next()
    },

    async dispose() {
      if (disposed) return
      disposed = true
      await loaded
      await file.flush()
    }
  }
}
