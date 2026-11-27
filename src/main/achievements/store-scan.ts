// The background achievements scan of a store PlayOut reads achievements of with the store's own account (GOG):
// scheduled like the Steam scan (scan-scheduler.ts). Each of the store's games is read once when it joins the library
// and again only after it was played since its last read; nothing is read while PlayOut is not signed in to the store,
// and nothing while a game runs. A failed read waits out a growing pause (that game only, unless the store is out of
// reach or asks everyone to wait); an account refused for two different games in a row stops the scan until the next
// sign-in or owned import. Installed games are read first.
import { join } from 'node:path'
import type { AchievementsInfo, Game } from '../../shared/types'
import { STORE_ACHIEVEMENTS_NONE } from '../../shared/store-achievements'
import { RECOMP_ACHIEVEMENTS_SOURCE } from '../../shared/recomp-play'
import type { Logger } from '../logger'
import { describeError } from '../scrapers/steam-store'
import type { LibraryService } from '../services/library-service'
import {
  askedWait,
  createScanRecord,
  createScanRunner,
  failEntries,
  lastSessionTimes,
  playedAfter,
  readEntry,
  scanDue,
  sharedFailure,
  unpark,
  type ScanEntry
} from './scan-scheduler'

/** What the store says about one game's achievements with the signed-in account. */
export type StoreRead =
  | { kind: 'list'; info: AchievementsInfo }
  /** The store has no achievements for the game (checked against a second, public source). */
  | { kind: 'none' }
  /** The store answered, but could not tell (no list yet): read again once played. */
  | { kind: 'unknown' }
  /** Not signed in to the store in PlayOut: the game waits for a sign-in. */
  | { kind: 'signed-out' }

export interface StoreAchievementsProvider {
  /** The store, for logs and the record's file name ('gog' -> gog-scans.json). */
  id: string
  /** The `metadata.sources` key of the store's id or "none" mark. */
  source: string
  /** The store's id the game is read by (GOG's product id); null: not a game this provider reads. */
  keyOf(game: Game): string | null
  /**
   * One game's achievements. Throws when the store could not be asked; `isAuthError` tells a refused account. A page
   * open's read (`priority` 'page') goes before the scan's queued requests.
   */
  read(game: Game, key: string, priority: 'page' | 'scan'): Promise<StoreRead>
  isAuthError(err: unknown): boolean
}

export interface StoreScanDeps {
  library: Pick<
    LibraryService,
    'games' | 'getGame' | 'applyMetadata' | 'clearAchievements' | 'getSessions' | 'allSessions'
  >
  log: Logger
  cacheDir: string
  write(file: string, value: unknown): Promise<void>
  /** Counts on the card (false: unchanged). */
  writeCounts(
    gameId: string,
    counts: { unlocked: number; total: number },
    extra: { sources?: Record<string, string> }
  ): boolean
  announce(gameIds: string[]): void
  gameRunning(): boolean
  startDelayMs: number
  kickDelayMs: number
  gapMs: number
  backoffMs: number
}

interface StoreScanEntry extends ScanEntry {
  /** The store id it was read by (another one since = read again). */
  key?: string
  none?: boolean
}

export interface StoreScan {
  /** Whether this scan reads the game's achievements. */
  handles(game: Game): boolean
  /** A page open: the game's list (its counts and the record follow); null when there is none to show. */
  load(game: Game): Promise<AchievementsInfo | null>
  /** A sign-in or an owned import: a refused account and parked games get another try. */
  sync(): Promise<void>
  /** The library changed: a pass once things settle. */
  kick(): void
  /** A play session of the game ended. */
  played(gameId: string, endedAt: string): void
  /** Signed out: the account's counts leave the cards (the "none" marks stay: they are no account's). */
  signedOut(): void
  dispose(): void
}

export function createStoreScan(
  provider: StoreAchievementsProvider,
  deps: StoreScanDeps
): StoreScan {
  const { library, log } = deps
  let disposed = false
  /** Bumped by a sign-out: work that started before it writes nothing. */
  let generation = 0
  /** The account was refused, or nobody is signed in: nothing is read until a sign-in or owned import. */
  let waiting = false
  let deferred = false
  let unparkPending = false

  const record = createScanRecord<StoreScanEntry>({
    file: join(deps.cacheDir, `${provider.id}-scans.json`),
    keep: (id) => !!library.getGame(id),
    write: deps.write,
    onSaveError: (err) =>
      log.warn(`${provider.id}: could not save the achievements scan record: ${describeError(err)}`)
  })
  const runner = createScanRunner({
    startDelayMs: deps.startDelayMs,
    kickDelayMs: deps.kickDelayMs,
    backoffMs: deps.backoffMs,
    pass: () => pass(),
    onError: (err) => log.warn(`${provider.id}: achievements scan failed: ${describeError(err)}`)
  })

  const keyOf = (game: Game): string | null => (game.remote ? null : provider.keyOf(game))

  function markNone(gameId: string, changed: string[]): void {
    const game = library.getGame(gameId)
    if (!game || game.metadata.sources?.[provider.source] === STORE_ACHIEVEMENTS_NONE) return
    if (!game.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE])
      library.clearAchievements([gameId], provider.source)
    library.applyMetadata(
      gameId,
      { metadata: { sources: { [provider.source]: STORE_ACHIEVEMENTS_NONE } } },
      { overwrite: true, quiet: true }
    )
    changed.push(gameId)
  }

  function writeList(gameId: string, key: string, info: AchievementsInfo, changed: string[]): void {
    if (info.total <= 0) return
    const marked =
      library.getGame(gameId)?.metadata.sources?.[provider.source] === STORE_ACHIEVEMENTS_NONE
    if (marked) library.clearAchievements([gameId], provider.source)
    if (
      deps.writeCounts(
        gameId,
        { unlocked: info.unlocked, total: info.total },
        { sources: { [provider.source]: key } }
      ) ||
      marked
    )
      changed.push(gameId)
  }

  /** Write what the store said; false when the game must wait for a sign-in. */
  function apply(
    table: Record<string, StoreScanEntry>,
    game: Game,
    key: string,
    read: StoreRead,
    at: number,
    changed: string[]
  ): boolean {
    if (read.kind === 'signed-out') return false
    if (read.kind === 'list') writeList(game.id, key, read.info, changed)
    else if (read.kind === 'none') markNone(game.id, changed)
    table[game.id] = {
      ...readEntry(game, table[game.id], at),
      key,
      ...(read.kind === 'none' ? { none: true } : {})
    }
    return true
  }

  async function pass(): Promise<void> {
    const table = await record.load()
    if (disposed) return
    if (unparkPending) {
      unparkPending = false
      for (const entry of Object.values(table)) unpark(entry)
    }
    if (waiting) return
    if (deps.gameRunning()) {
      deferred = true
      return
    }
    deferred = false
    const paused = runner.pausedFor()
    if (paused > 0) {
      runner.schedule(paused)
      return
    }
    const now = Date.now()
    const sessions = lastSessionTimes(library.allSessions())
    const due: { game: Game; key: string }[] = []
    let nextRetry = Number.POSITIVE_INFINITY
    for (const game of library.games()) {
      const key = keyOf(game)
      if (!key) continue
      const entry = table[game.id]
      const isDue =
        (entry?.key !== undefined && entry.key !== key) ||
        scanDue(entry, now, (since) => playedAfter(game, entry!, since, sessions.get(game.id)))
      if (isDue) due.push({ game, key })
      else if (entry?.retryAt && entry.retryAt > now) nextRetry = Math.min(nextRetry, entry.retryAt)
    }
    // The games on this PC first: an owned game that is not installed matters less.
    due.sort((a, b) => Number(b.game.installed) - Number(a.game.installed))
    if (due.length && !(await readDue(table, due))) return
    if (Number.isFinite(nextRetry)) runner.schedule(nextRetry - Date.now())
  }

  /** Read the due games one at a time; false when the pass stopped. */
  async function readDue(
    table: Record<string, StoreScanEntry>,
    due: { game: Game; key: string }[]
  ): Promise<boolean> {
    const started = generation
    const current = (): boolean => !disposed && started === generation
    let changed: string[] = []
    let counted = 0
    let none = 0
    /** The game the account was last refused for, with no list read since (a second game refused stops the pass). */
    let refusedFor: string | null = null
    if (due.length >= 20)
      log.info(
        `${provider.id}: reading the achievements of ${due.length} game(s) in the background, one at a time`
      )
    const flush = async (): Promise<void> => {
      deps.announce(changed)
      changed = []
      await record.save()
    }
    for (let i = 0; i < due.length; i++) {
      const { game, key } = due[i]
      if (i > 0 && deps.gapMs > 0) await new Promise((r) => setTimeout(r, deps.gapMs))
      if (!current()) return false
      if (deps.gameRunning()) {
        deferred = true
        await flush()
        return false
      }
      const at = Date.now()
      let read: StoreRead
      try {
        read = await provider.read(game, key, 'scan')
      } catch (err) {
        if (!current()) return false
        // The account refused for one game may be that game's trouble only: a second game refused in a row (no list
        // read between them) stops the scan; the first just waits like any failed read.
        if (provider.isAuthError(err) && refusedFor !== null && refusedFor !== game.id) {
          waiting = true
          log.warn(
            `${provider.id}: achievements scan stopped (${describeError(err)}); it goes on after the next sign-in`
          )
          await flush()
          return false
        }
        if (provider.isAuthError(err)) refusedFor = game.id
        const retry = failEntries(table, [game.id], deps.backoffMs, err)
        if (sharedFailure(err)) {
          const wait = runner.pause(askedWait(err))
          log.warn(
            `${provider.id}: achievements scan failed (${describeError(err)}); next try in ${Math.round(wait / 1000)} s`
          )
          await flush()
          return false
        }
        log.warn(
          `${provider.id}: achievements of ${game.id} could not be read: ${describeError(err)}`
        )
        if (Number.isFinite(retry)) runner.schedule(retry - Date.now())
        continue
      }
      if (!current()) return false
      if (!apply(table, game, key, read, at, changed)) {
        waiting = true
        log.debug(
          `${provider.id}: ${due.length - i} game(s) wait for a sign-in to read achievements`
        )
        await flush()
        return false
      }
      if (read.kind === 'list') {
        counted++
        refusedFor = null
      }
      if (read.kind === 'none') none++
      if (changed.length >= 25) await flush()
    }
    await flush()
    runner.passed()
    log.info(
      `${provider.id}: achievements scan read ${due.length} game(s): ${counted} with achievements, ${none} without`
    )
    return true
  }

  return {
    handles: (game) => keyOf(game) !== null,
    async load(game) {
      const key = keyOf(game)
      if (!key) return null
      const started = generation
      const at = Date.now()
      const read = await provider.read(game, key, 'page')
      if (started !== generation || disposed) return null
      const table = await record.load()
      const changed: string[] = []
      if (apply(table, game, key, read, at, changed)) {
        deps.announce(changed)
        await record.save()
      }
      return read.kind === 'list' ? read.info : null
    },
    sync() {
      waiting = false
      unparkPending = true
      return runner.run()
    },
    kick() {
      if (!disposed) runner.kick()
    },
    played(gameId, endedAt) {
      if (disposed) return
      const game = library.getGame(gameId)
      if (!game || !keyOf(game)) {
        if (deferred) runner.kick()
        return
      }
      const ended = Date.parse(endedAt)
      void record
        .load()
        .then(async (table) => {
          table[gameId] = {
            ...table[gameId],
            playedAt: Number.isFinite(ended) ? ended : Date.now()
          }
          await record.save()
          runner.kick()
        })
        .catch((err) =>
          log.warn(`${provider.id}: could not note a play session: ${describeError(err)}`)
        )
    },
    signedOut() {
      generation++
      waiting = false
      runner.clearPause()
      const ids = library
        .games()
        .filter((g) => {
          const from = g.metadata.sources?.[provider.source]
          return !!keyOf(g) && from !== undefined && from !== STORE_ACHIEVEMENTS_NONE
        })
        .map((g) => g.id)
      deps.announce(library.clearAchievements(ids, provider.source))
      // Read again with the next account; the store's "none" answers stay.
      record.change((table) => {
        for (const id of Object.keys(table)) if (!table[id].none) delete table[id]
      })
    },
    dispose() {
      disposed = true
      runner.dispose()
    }
  }
}
