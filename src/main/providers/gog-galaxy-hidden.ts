// GOG games the user hid in GOG Galaxy 2.0. Galaxy keeps the choice in `UserReleaseProperties.isHidden` of its
// SQLite database, keyed by release key (`gog_<productId>` for GOG's own games; other stores' games carry their own
// prefixes and are not read here). Recipe and rules: docs/research/store-accounts.md §3.2 D.
//
// The database is read with Node's built-in `node:sqlite` (no native module), behind a runtime guard, and only from
// a temporary copy of `galaxy-2.0.db` with its `-wal` and `-shm` files: Galaxy holds the live files open in WAL mode,
// and nothing here may lock or write them. The copy (which also holds Galaxy's per-game authorizations) lives in a
// private temp folder only for the read and is deleted right after it; only release keys are queried. Galaxy's user
// ids exceed 2^53, so they are compared as text.
import { promises as fs, rmSync, type Stats } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Game } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { statSafe } from '../util/fs'
import { knownFolders } from '../util/paths'

const log = createLogger('gog')

const DB_FILE = 'galaxy-2.0.db'
const SIDE_FILES = ['-wal', '-shm'] as const

const HIDDEN_QUERY = `
  SELECT releaseKey FROM UserReleaseProperties
  WHERE isHidden = 1
    AND releaseKey LIKE 'gog\\_%' ESCAPE '\\'
    AND CAST(userId AS TEXT) IN (SELECT CAST(id AS TEXT) FROM Users)`

export function defaultGalaxyStorageDir(): string {
  return join(knownFolders().programData, 'GOG.com', 'Galaxy', 'storage')
}

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean }
  ) => {
    prepare(sql: string): { all(): unknown[] }
    close(): void
  }
}

async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    return (await import('node:sqlite')) as unknown as SqliteModule
  } catch {
    return null
  }
}

/** Product ids from Galaxy release keys; anything that is not `gog_<digits>` is ignored. */
export function hiddenProductIds(rows: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    const key = (row as { releaseKey?: unknown })?.releaseKey
    const match = typeof key === 'string' ? /^gog_(\d+)$/.exec(key) : null
    if (match) ids.add(match[1]!)
  }
  return ids
}

export interface GalaxyHiddenOptions {
  /** Galaxy's storage folder (tests); default `%ProgramData%\GOG.com\Galaxy\storage`. */
  storageDir?: string
  log?: Logger
}

const COPY_PREFIX = 'playout-galaxy-hidden-copy-'
/** Copies taken while Galaxy was writing are thrown away and taken again, this many times in all. */
const COPY_ATTEMPTS = 3

/** Last answer, reused while the database files are unchanged (the copy is 100+ MB). */
let cache: { stamp: string; ids: Set<string> } | null = null
/** The read in progress: overlapping syncs (startup, scan, import) share it instead of each copying the database. */
let inflight: { db: string; promise: Promise<Set<string> | null> } | null = null
/** Copy folders that exist right now, removed synchronously if the process exits mid-read. */
const liveCopies = new Set<string>()
let sweptLeftovers = false

function stampOf(files: (Stats | null)[]): string {
  return files.map((s) => (s ? `${s.size}:${s.mtimeMs}` : '-')).join('|')
}

async function statAll(db: string): Promise<(Stats | null)[]> {
  return Promise.all([db, ...SIDE_FILES.map((suffix) => db + suffix)].map((f) => statSafe(f)))
}

/** Copies left by an earlier run that was killed mid-read: they hold Galaxy's authorizations, so they go. */
async function sweepLeftovers(): Promise<void> {
  if (sweptLeftovers) return
  sweptLeftovers = true
  const names = await fs.readdir(tmpdir()).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name.startsWith(COPY_PREFIX))
      .map((name) => join(tmpdir(), name))
      .filter((path) => !liveCopies.has(path))
      .map((path) => removeCopy(path))
  )
}

async function removeCopy(path: string, logger: Logger = log): Promise<void> {
  try {
    // Defender and the indexer briefly hold freshly written large files open.
    await fs.rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (err) {
    logger.warn(`gog: cannot delete the temporary Galaxy copy ${path}: ${(err as Error).message}`)
  } finally {
    liveCopies.delete(path)
  }
}

process.once('exit', () => {
  for (const path of liveCopies) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* exiting: nothing more to do */
    }
  }
})

/**
 * GOG product ids hidden in Galaxy for the signed-in Galaxy user. An empty set when Galaxy's database does not
 * exist (Galaxy not installed: nothing is hidden there). Null when the answer is unknown (database unreadable or
 * changing too fast to copy, no signed-in user, `node:sqlite` missing).
 */
export function readGalaxyHiddenGogIds(
  options: GalaxyHiddenOptions = {}
): Promise<Set<string> | null> {
  const db = join(options.storageDir ?? defaultGalaxyStorageDir(), DB_FILE)
  if (inflight?.db === db) return inflight.promise.then((ids) => ids && new Set(ids))
  const promise = readOnce(db, options.log ?? log).finally(() => {
    if (inflight?.promise === promise) inflight = null
  })
  inflight = { db, promise }
  return promise.then((ids) => ids && new Set(ids))
}

async function readOnce(db: string, logger: Logger): Promise<Set<string> | null> {
  await sweepLeftovers()
  let before = await statAll(db)
  if (!before[0]?.isFile()) return new Set()
  if (cache && cache.stamp === `${db}|${stampOf(before)}`) return cache.ids

  const sqlite = await loadSqlite()
  if (!sqlite) {
    logger.warn('gog: node:sqlite is not available; Galaxy hidden games are not read')
    return null
  }

  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
    let copyDir: string | null = null
    try {
      copyDir = await fs.mkdtemp(join(tmpdir(), COPY_PREFIX))
      liveCopies.add(copyDir)
      await fs.copyFile(db, join(copyDir, DB_FILE))
      for (const [i, suffix] of SIDE_FILES.entries()) {
        if (before[i + 1]) await fs.copyFile(db + suffix, join(copyDir, DB_FILE + suffix))
      }
      // Galaxy wrote or checkpointed during the copy: the three files may not belong to one moment, and SQLite
      // would read such a mix without an error. Take the copy again.
      const after = await statAll(db)
      if (stampOf(after) !== stampOf(before)) {
        before = after
        continue
      }
      const conn = new sqlite.DatabaseSync(join(copyDir, DB_FILE), { readOnly: true })
      let users: unknown[]
      let rows: unknown[]
      try {
        users = conn.prepare('SELECT 1 FROM Users LIMIT 1').all()
        rows = conn.prepare(HIDDEN_QUERY).all()
      } finally {
        conn.close()
      }
      // Signed out of Galaxy: whose choices these would be is unknown.
      if (users.length === 0) return null
      const ids = hiddenProductIds(rows)
      cache = { stamp: `${db}|${stampOf(before)}`, ids }
      return ids
    } catch (err) {
      logger.warn(`gog: cannot read hidden games from ${db}: ${(err as Error).message}`)
      return null
    } finally {
      if (copyDir) await removeCopy(copyDir, logger)
    }
  }
  logger.warn(`gog: ${db} kept changing while it was copied; hidden games not read this time`)
  return null
}

/**
 * Every GOG game hidden at either end: in Galaxy or in the user's gog.com library. The account import records the
 * gog.com flag as `extra.gogHidden` on each game it lists; it counts only while the game is still in the account's
 * listing (`owned`), so signing out or a game leaving the account does not keep a stale flag alive.
 *
 * `galaxy` null (Galaxy's answer unknown): the games already hidden by a store stay hidden, since some of them may be
 * Galaxy's, and only the gog.com flags are applied.
 */
export function gogHiddenIds(
  galaxy: Set<string> | null,
  games: readonly Pick<Game, 'source' | 'externalId' | 'extra' | 'owned' | 'hiddenByStore'>[]
): Set<string> {
  const ids = new Set(galaxy ?? [])
  for (const game of games) {
    if (game.source !== 'gog') continue
    if (game.owned === true && game.extra?.gogHidden === true) ids.add(game.externalId)
    else if (!galaxy && game.hiddenByStore) ids.add(game.externalId)
  }
  return ids
}

/** Forget the cached answer (tests). */
export function resetGalaxyHiddenCache(): void {
  cache = null
  sweptLeftovers = false
}
