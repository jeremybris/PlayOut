// The PlayOut database (shared/game-database.ts) in the main process:
//
// - Reading: the shards the library's games live in are downloaded from the raw CDN (no account; If-None-Match with
//   each shard's cached ETag) at start and every 6 hours, kept in userData/game-database/shards and in memory. A
//   shard younger than 6 hours is not asked again; a 404 is an empty shard (the database branch may not exist yet); a
//   failed download keeps the cached copy. The metadata service looks a game up before its scrapers run
//   (lookup / lookupCached). Downloading never re-applies rows to games already done: a matched game only gets the
//   database's facts through the Refresh metadata button.
// - Contributing: a game the database lacked is queued after a successful scrape (noteScraped). Ten minutes after the
//   last game queued, and hourly, the queue is flushed through the relay's /contribute in batches: each row is built
//   then from the stored record (the scraped values, never the user's or the cloud's edits), sent with the install's
//   anonymous id. Every key the relay answers for (added, already present or refused) is remembered in sent.json and
//   never sent again; the rows it added are put into the local shard copy, so they are found before the CDN has them.
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import {
  GAME_DB_MAX_ROWS_PER_REQUEST,
  GAME_DB_RAW_BASE,
  gameDbRowOf,
  gameDbRowProblem,
  gameDbShardPath,
  encodeGameDbCsv,
  parseGameDbCsv,
  type GameDbRow
} from '../../shared/game-database'
import { gameMetadataKey } from '../../shared/metadata-edit'
import { recompAddedId, recompOnlyKey } from '../../shared/recomp-play'
import type { Game, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { readTextWithin } from '../metadata-cloud/service'
import { JsonStore } from '../store/json-store'
import {
  emptyIndex,
  emptyQueue,
  emptySent,
  enqueueGame,
  isShardPath,
  normalizeIndex,
  normalizeQueue,
  normalizeSent,
  trimSent,
  type IndexFile,
  type QueueFile,
  type SentFile,
  type SentResult
} from './files'

/** A shard fetched this recently is not asked for again; also how often the library's shards are refreshed. */
export const SHARD_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** A shard whose download failed is not tried again before this. */
export const SHARD_RETRY_MS = 15 * 60 * 1000
export const SHARD_TIMEOUT_MS = 30_000
/** A bigger shard is refused (a shard holds a few hundred rows: well under 1 MB). */
export const MAX_SHARD_BYTES = 8 * 1024 * 1024
/** Shards downloaded at once by the prefetch. */
export const PREFETCH_CONCURRENCY = 4
/** How long a lookup waits for its shard's download before it answers from what is cached. */
export const LOOKUP_TIMEOUT_MS = 5_000
/** The queue is flushed this long after the last game was queued. */
export const FLUSH_DELAY_MS = 10 * 60 * 1000
export const FLUSH_INTERVAL_MS = 60 * 60 * 1000
/** The first flush after start (the metadata cloud has read its install id and relay by then). */
export const FIRST_FLUSH_DELAY_MS = 2 * 60 * 1000
/** A flush that stopped on a failure waits this long before the next (doubling up to FLUSH_BACKOFF_MAX_MS). */
export const FLUSH_RETRY_MS = 5 * 60 * 1000
export const FLUSH_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
export const CONTRIBUTE_TIMEOUT_MS = 30_000

/** The part of LibraryService the database uses. */
export interface GameDatabaseLibrary {
  games(): Game[]
  getGame(id: string): Game | undefined
}

/** Where contributions go: the metadata cloud's relay and install id (MetadataCloudService). */
export interface GameDatabaseRelay {
  relayEndpoint(): string
  installId(): string
}

export interface GameDatabaseDeps {
  /** userData/game-database */
  dir: string
  library: GameDatabaseLibrary
  settings: { get(): Settings }
  relay: GameDatabaseRelay
  appVersion: string
  log: Logger
  fetch?: typeof fetch
  now?: () => number
  /** The raw base URL of the shards (tests). */
  rawBase?: string
  /** Store write debounce (tests use 0). */
  debounceMs?: number
  /** How long a lookup waits for a download (tests shorten it). */
  lookupTimeoutMs?: number
}

/** A row found for a game, and whether it was found by the game's own key or by its Steam app (an alias). */
export interface GameDbMatch {
  row: GameDbRow
  key: string
  alias: boolean
}

/** What the metadata service uses (scrapers/metadata-service.ts). */
export interface GameDatabaseLookup {
  lookup(game: Game): Promise<GameDbMatch | null>
  lookupCached(game: Game): GameDbMatch | null
  /** Download the shards these games' rows can be in (never rejects). */
  prefetchGames(games: readonly Game[]): Promise<void>
  noteScraped(gameId: string): void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A Retry-After header (seconds or an HTTP date) in ms; undefined when absent or unreadable. */
function retryAfterMs(res: Response, now: number): number | undefined {
  const value = res.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

const numericAppId = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text.trim())
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null
}

/**
 * The Steam app a non-Steam PC game's facts can be found by (its store link, else the app the Steam tags or a
 * scraper matched it to); null for a Steam game, a ROM and a game with none.
 */
export function steamAliasOf(game: Game): number | null {
  if (game.source === 'steam' || game.source === 'rom') return null
  return (
    numericAppId(game.extra?.steamAppId) ??
    numericAppId(game.metadata.steamTags?.appId) ??
    numericAppId(game.metadata.sources?.steam)
  )
}

/** Whether a game is one the database can take from this PC (whatever the database already has). */
export function contributable(game: Game): boolean {
  if (game.remote) return false
  if (game.source === 'manual') return false
  // A recompilation's own card or one added from the recompilations browser is not a game file of its system.
  if (recompOnlyKey(game) || recompAddedId(game)) return false
  if (game.source === 'rom' && game.externalId.startsWith('Recompilations/')) return false
  return gameDbRowOf(game) !== null
}

export class GameDatabaseService implements GameDatabaseLookup {
  private readonly index: JsonStore<IndexFile>
  private readonly queue: JsonStore<QueueFile>
  private readonly sent: JsonStore<SentFile>
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  /** Parsed shards by path (only those read from disk or downloaded). */
  private readonly shards = new Map<string, Map<string, GameDbRow>>()
  /** Downloads in flight by path. */
  private readonly inflight = new Map<string, Promise<void>>()
  /** When a shard's download last failed (not tried again for SHARD_RETRY_MS). */
  private readonly failedAt = new Map<string, number>()
  private loaded: Promise<void> | null = null
  private prefetching: Promise<void> | null = null
  private flushing: Promise<void> | null = null
  private prefetchTimer: NodeJS.Timeout | null = null
  private flushInterval: NodeJS.Timeout | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private flushNotBefore = 0
  private flushFailures = 0
  private disposed = false

  constructor(private readonly deps: GameDatabaseDeps) {
    const debounceMs = deps.debounceMs ?? 400
    this.index = new JsonStore({
      file: join(deps.dir, 'index.json'),
      defaults: emptyIndex,
      normalize: normalizeIndex,
      debounceMs
    })
    this.queue = new JsonStore({
      file: join(deps.dir, 'queue.json'),
      defaults: emptyQueue,
      normalize: normalizeQueue,
      debounceMs
    })
    this.sent = new JsonStore({
      file: join(deps.dir, 'sent.json'),
      defaults: emptySent,
      normalize: normalizeSent,
      debounceMs
    })
    this.doFetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  private enabled(): boolean {
    return this.deps.settings.get().scrapers.gameDatabase.enabled
  }

  private contributing(): boolean {
    const s = this.deps.settings.get().scrapers.gameDatabase
    return s.enabled && s.contribute
  }

  /** Read the files and the cached shards (once). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      await Promise.all([this.index.load(), this.queue.load(), this.sent.load()])
      for (const path of Object.keys(this.index.get().shards)) await this.readCachedShard(path)
    })()
    return this.loaded
  }

  /** Read the files, download the library's shards (then every 6 hours) and start the contribution timers. */
  async start(): Promise<void> {
    await this.load()
    if (this.disposed) return
    void this.prefetch()
    this.prefetchTimer = setInterval(() => void this.prefetch(), SHARD_MAX_AGE_MS)
    this.prefetchTimer.unref?.()
    this.flushInterval = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.flushInterval.unref?.()
    this.scheduleFlush(FIRST_FLUSH_DELAY_MS)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.prefetchTimer) clearInterval(this.prefetchTimer)
    if (this.flushInterval) clearInterval(this.flushInterval)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.prefetchTimer = this.flushInterval = this.flushTimer = null
    await Promise.all([this.index.flush(), this.queue.flush(), this.sent.flush()])
  }

  // --- shards -------------------------------------------------------------------------------------

  private shardFile(path: string): string {
    return join(this.deps.dir, 'shards', ...path.split('/'))
  }

  private async readCachedShard(path: string): Promise<void> {
    if (this.shards.has(path) || !isShardPath(path)) return
    try {
      const text = await fs.readFile(this.shardFile(path), 'utf8')
      this.shards.set(path, parseGameDbCsv(text))
    } catch {
      // No copy (a 404 shard, or the file is gone): an empty shard until it is downloaded.
      this.shards.set(path, new Map())
    }
  }

  private async writeCachedShard(path: string, text: string): Promise<void> {
    const file = this.shardFile(path)
    await fs.mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
  }

  private fresh(path: string): boolean {
    const entry = this.index.get().shards[path]
    if (!entry || !this.shards.has(path)) return false
    const age = this.now() - Date.parse(entry.fetchedAt)
    return age >= 0 && age < SHARD_MAX_AGE_MS
  }

  /** Download a shard unless it is fresh (or failed a short while ago); never rejects. */
  ensureShard(path: string): Promise<void> {
    if (!isShardPath(path) || this.fresh(path)) return Promise.resolve()
    const failed = this.failedAt.get(path)
    if (failed !== undefined && this.now() - failed < SHARD_RETRY_MS) return Promise.resolve()
    let running = this.inflight.get(path)
    if (!running) {
      running = this.download(path)
        .catch((err: unknown) => {
          this.failedAt.set(path, this.now())
          this.deps.log.debug(`game database: ${path} could not be read (${errorText(err)})`)
        })
        .finally(() => this.inflight.delete(path))
      this.inflight.set(path, running)
    }
    return running
  }

  private async download(path: string): Promise<void> {
    await this.load()
    const entry = this.index.get().shards[path]
    const headers: Record<string, string> = { 'User-Agent': 'PlayOut', Accept: 'text/csv, */*' }
    if (entry?.etag && this.shards.get(path)?.size) headers['If-None-Match'] = entry.etag
    const res = await this.doFetch(`${this.deps.rawBase ?? GAME_DB_RAW_BASE}${path}`, {
      headers,
      signal: AbortSignal.timeout(SHARD_TIMEOUT_MS)
    })
    const at = new Date(this.now()).toISOString()
    if (res.status === 304) {
      await this.readCachedShard(path)
      this.index.set((d) => void (d.shards[path] = { ...d.shards[path], fetchedAt: at }))
      this.failedAt.delete(path)
      return
    }
    // 404: the shard (or the whole database branch) does not exist yet: an empty shard, not an error.
    if (res.status === 404) {
      this.shards.set(path, new Map())
      await fs.rm(this.shardFile(path), { force: true }).catch(() => undefined)
      this.index.set((d) => void (d.shards[path] = { fetchedAt: at }))
      this.failedAt.delete(path)
      return
    }
    if (!res.ok) throw new Error(`the database answered ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_SHARD_BYTES) throw new Error('the shard is too large')
    const text = await readTextWithin(res, MAX_SHARD_BYTES)
    if (text === null) throw new Error('the shard is too large')
    const rows = parseGameDbCsv(text)
    await this.writeCachedShard(path, text)
    this.shards.set(path, rows)
    const etag = res.headers.get('etag')
    this.index.set((d) => void (d.shards[path] = { fetchedAt: at, ...(etag ? { etag } : {}) }))
    this.failedAt.delete(path)
  }

  /** The shard paths a game's row can be in: its own key's, then its Steam alias's. */
  private pathsOf(game: Game): string[] {
    const out: string[] = []
    const key = gameMetadataKey(game)
    if (key) out.push(gameDbShardPath(key))
    const alias = steamAliasOf(game)
    if (alias !== null) out.push(gameDbShardPath(`steam-${alias}`))
    return out
  }

  /** Download the shards of every game in the library (PREFETCH_CONCURRENCY at a time); one run at a time. */
  prefetch(): Promise<void> {
    if (this.disposed || !this.enabled()) return Promise.resolve()
    this.prefetching ??= (async () => {
      const count = await this.fetchShardsOf(this.deps.library.games())
      if (count) this.deps.log.info(`game database: ${count} shard(s) checked`)
    })().finally(() => (this.prefetching = null))
    return this.prefetching
  }

  /** Download the shards these games' rows can be in (new games of a scan), PREFETCH_CONCURRENCY at a time. */
  async prefetchGames(games: readonly Game[]): Promise<void> {
    if (this.disposed || !this.enabled()) return
    await this.load()
    await this.fetchShardsOf(games)
  }

  private async fetchShardsOf(games: readonly Game[]): Promise<number> {
    const paths = new Set<string>()
    for (const game of games) {
      if (game.remote) continue
      for (const path of this.pathsOf(game)) paths.add(path)
    }
    const list = [...paths]
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < list.length && !this.disposed) await this.ensureShard(list[next++]!)
    }
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker))
    return list.length
  }

  // --- lookup -------------------------------------------------------------------------------------

  private find(game: Game): GameDbMatch | null {
    if (game.remote) return null
    const key = gameMetadataKey(game)
    if (key) {
      const row = this.shards.get(gameDbShardPath(key))?.get(key)
      if (row) return { row, key, alias: false }
    }
    const alias = steamAliasOf(game)
    if (alias !== null) {
      const aliasKey = `steam-${alias}`
      const row = this.shards.get(gameDbShardPath(aliasKey))?.get(aliasKey)
      if (row) return { row, key: aliasKey, alias: true }
    }
    return null
  }

  /** The game's row from what is in memory (no download): by its key, else by its Steam app. */
  lookupCached(game: Game): GameDbMatch | null {
    return this.find(game)
  }

  /**
   * The game's row, downloading its shards when they are missing or stale (waiting at most LOOKUP_TIMEOUT_MS, then
   * answering from what is cached). Never rejects.
   */
  async lookup(game: Game): Promise<GameDbMatch | null> {
    if (game.remote) return null
    try {
      await this.load()
      const paths = this.pathsOf(game)
      if (paths.length) {
        let timer: NodeJS.Timeout | null = null
        await Promise.race([
          Promise.all(paths.map((p) => this.ensureShard(p))),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS)
            timer.unref?.()
          })
        ])
        if (timer) clearTimeout(timer)
      }
    } catch (err) {
      this.deps.log.debug(`game database: lookup failed (${errorText(err)})`)
    }
    return this.find(game)
  }

  // --- contributions ------------------------------------------------------------------------------

  /** Keys sent or found present already (tests and status). */
  sentResult(key: string): SentResult | undefined {
    return this.sent.get().keys[key]?.result
  }

  /** Games waiting to be contributed (tests and status). */
  queued(): string[] {
    return this.queue.get().items.map((i) => i.key)
  }

  /**
   * After a successful scrape (or a match the user picked) of a game the database lacked: queue it to be contributed.
   * Nothing happens for a game the database has, that was contributed before, or that is not one it takes.
   */
  noteScraped(gameId: string): void {
    if (this.disposed || !this.contributing()) return
    const game = this.deps.library.getGame(gameId)
    if (!game || !contributable(game)) return
    const key = gameMetadataKey(game)
    if (!key || this.sent.get().keys[key]) return
    if (this.shards.get(gameDbShardPath(key))?.has(key)) return
    const queuedAt = new Date(this.now()).toISOString()
    this.queue.set((q) => void (q.items = enqueueGame(q.items, { gameId, key, queuedAt })))
    this.scheduleFlush(FLUSH_DELAY_MS)
  }

  private scheduleFlush(delayMs: number): void {
    if (this.disposed) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    const wait = Math.max(delayMs, this.flushNotBefore - this.now())
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, wait)
    this.flushTimer.unref?.()
  }

  private markSent(keys: Iterable<string>, result: SentResult): void {
    const at = new Date(this.now()).toISOString()
    const list = [...keys]
    if (!list.length) return
    this.sent.set((s) => {
      for (const key of list) s.keys[key] = { at, result }
      s.keys = trimSent(s.keys)
    })
  }

  private dequeue(keys: Iterable<string>): void {
    const drop = new Set(keys)
    if (!drop.size) return
    this.queue.set((q) => void (q.items = q.items.filter((i) => !drop.has(i.key))))
  }

  /** A failed or limited flush: wait (the relay's Retry-After, else doubling) and flush again then. */
  private backOff(retryAfter: number | undefined): void {
    let wait: number
    if (retryAfter !== undefined) wait = retryAfter + 30_000
    else {
      this.flushFailures++
      wait = Math.min(FLUSH_BACKOFF_MAX_MS, FLUSH_RETRY_MS * 2 ** (this.flushFailures - 1))
    }
    this.flushNotBefore = this.now() + wait
    this.scheduleFlush(wait)
  }

  /** Send the waiting games through the relay's /contribute (one flush at a time). */
  flush(): Promise<void> {
    this.flushing ??= this.runFlush()
      .catch((err: unknown) =>
        this.deps.log.warn(`game database: contributing failed (${errorText(err)})`)
      )
      .finally(() => (this.flushing = null))
    return this.flushing
  }

  private async runFlush(): Promise<void> {
    await this.load()
    if (this.disposed || !this.contributing() || this.now() < this.flushNotBefore) return
    const relay = this.deps.relay.relayEndpoint().replace(/\/+$/, '')
    const clientId = this.deps.relay.installId()
    // No relay known yet (the metadata cloud announces it): the games wait for the next flush.
    if (!relay || !this.queue.get().items.length) return
    // The rows are built now, from the stored records: what the scrapers found, never an edit.
    const rows: GameDbRow[] = []
    const gone: string[] = []
    const present: string[] = []
    for (const item of this.queue.get().items) {
      const game = this.deps.library.getGame(item.gameId)
      const row = game && contributable(game) ? gameDbRowOf(game) : null
      if (!row || row.key !== item.key || this.sent.get().keys[item.key]) gone.push(item.key)
      else if (this.shards.get(gameDbShardPath(row.key))?.has(row.key)) present.push(row.key)
      else rows.push(row)
    }
    this.markSent(present, 'present')
    this.dequeue([...gone, ...present])
    for (let i = 0; i < rows.length && !this.disposed; i += GAME_DB_MAX_ROWS_PER_REQUEST) {
      if (!this.contributing()) return
      const batch = rows.slice(i, i + GAME_DB_MAX_ROWS_PER_REQUEST)
      const ok = await this.send(`${relay}/contribute`, clientId, batch)
      if (!ok) return
    }
  }

  /** One batch; false when the flush stops here (it backed off). */
  private async send(url: string, clientId: string, batch: GameDbRow[]): Promise<boolean> {
    const keys = batch.map((r) => r.key)
    let res: Response
    try {
      res = await this.doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'PlayOut' },
        body: JSON.stringify({ clientId, appVersion: this.deps.appVersion, rows: batch }),
        signal: AbortSignal.timeout(CONTRIBUTE_TIMEOUT_MS)
      })
    } catch (err) {
      this.deps.log.debug(`game database: the relay could not be reached (${errorText(err)})`)
      this.backOff(undefined)
      return false
    }
    if (res.status === 429) {
      this.deps.log.info('game database: the relay limited contributions; waiting')
      this.backOff(retryAfterMs(res, this.now()) ?? undefined)
      return false
    }
    // The relay will never take this batch as it is: it is not sent again.
    if (res.status === 400 || res.status === 413 || res.status === 415) {
      const text = await res.text().catch(() => '')
      this.deps.log.warn(
        `game database: the relay refused ${keys.length} game(s): ${text.slice(0, 300)}`
      )
      this.markSent(keys, 'refused')
      this.dequeue(keys)
      return true
    }
    if (!res.ok) {
      this.deps.log.debug(`game database: the relay answered ${res.status}`)
      this.backOff(retryAfterMs(res, this.now()))
      return false
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      this.backOff(undefined)
      return false
    }
    const answer = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >
    const inBatch = new Set(keys)
    const keyList = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((k): k is string => typeof k === 'string' && inBatch.has(k))
        : []
    const added = keyList(answer.added)
    const present = keyList(answer.present)
    const refused = Array.isArray(answer.refused)
      ? keyList(
          answer.refused.map((r: unknown) =>
            typeof r === 'object' && r !== null ? (r as { key?: unknown }).key : undefined
          )
        )
      : []
    if (answer.ok !== true) {
      this.backOff(undefined)
      return false
    }
    this.flushFailures = 0
    this.markSent(added, 'added')
    this.markSent(present, 'present')
    this.markSent(refused, 'refused')
    // The games the relay left for a later request (its budget of GitHub calls ran out, or GitHub failed after some
    // were added) stay queued and are sent again by a later flush. Any other game it did not answer for goes.
    const answered = new Set([...added, ...present, ...refused])
    const later = new Set(keyList(answer.later).filter((k) => !answered.has(k)))
    this.dequeue(keys.filter((k) => !later.has(k)))
    await this.keepAdded(batch.filter((r) => added.includes(r.key)))
    if (added.length)
      this.deps.log.info(`game database: added ${added.length} game(s) to the PlayOut database`)
    if (later.size) {
      this.scheduleFlush(FLUSH_RETRY_MS)
      return false
    }
    return true
  }

  /**
   * Put rows the relay added into the local shard copies, so this PC finds them before the raw CDN serves the new
   * shard. The shard counts as freshly fetched (without an ETag: its next download is a whole one).
   */
  private async keepAdded(rows: GameDbRow[]): Promise<void> {
    const byPath = new Map<string, GameDbRow[]>()
    for (const row of rows) {
      if (gameDbRowProblem(row) !== null) continue
      const path = gameDbShardPath(row.key)
      byPath.set(path, [...(byPath.get(path) ?? []), row])
    }
    const at = new Date(this.now()).toISOString()
    for (const [path, list] of byPath) {
      if (!isShardPath(path)) continue
      await this.readCachedShard(path)
      const shard = this.shards.get(path) ?? new Map<string, GameDbRow>()
      for (const row of list) if (!shard.has(row.key)) shard.set(row.key, row)
      this.shards.set(path, shard)
      try {
        await this.writeCachedShard(path, encodeGameDbCsv([...shard.values()]))
      } catch (err) {
        this.deps.log.debug(`game database: ${path} could not be saved (${errorText(err)})`)
      }
      this.index.set((d) => void (d.shards[path] = { fetchedAt: at }))
    }
  }
}
