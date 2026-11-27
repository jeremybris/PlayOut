// The PlayOut database's files in userData/game-database: shards/<path> (copies of the shards downloaded, so the
// facts are there offline and at once on start), index.json (each shard's ETag and when it was fetched), queue.json
// (games waiting to be contributed) and sent.json (keys contributed or found present already: a key is never
// contributed twice). Whatever a file holds is reduced to valid values: a damaged entry is dropped, never an exception.

export interface ShardEntry {
  etag?: string
  /** When the shard was last downloaded or confirmed (304 / 404), ISO. */
  fetchedAt: string
}

export interface IndexFile {
  version: 1
  /** Shard path ("data/steam/03.csv") -> what is known of it. */
  shards: Record<string, ShardEntry>
}

/** A game waiting to be contributed: its row is built at flush time from the stored record. */
export interface QueuedGame {
  gameId: string
  key: string
  queuedAt: string
}

export interface QueueFile {
  version: 1
  items: QueuedGame[]
}

/** What became of a key: added by this PC, already in the database, or refused by the relay. */
export type SentResult = 'added' | 'present' | 'refused'

export interface SentEntry {
  at: string
  result: SentResult
}

export interface SentFile {
  version: 1
  keys: Record<string, SentEntry>
}

/** The most games kept waiting; the oldest go first when there are more. */
export const MAX_QUEUED_GAMES = 2000
/** The most keys remembered as sent (the oldest are forgotten first: the database has them by then). */
export const MAX_SENT_KEYS = 100_000

/** A shard path as gameDbShardPath makes it: data/<prefix>/<nn>.csv, never anything that leaves the folder. */
export const SHARD_PATH_RE = /^data\/[a-z0-9][a-z0-9._]{0,63}\/[0-9]{2}\.csv$/
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,159}$/
const SENT_RESULTS = new Set<SentResult>(['added', 'present', 'refused'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optText = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined

/** An ISO date that parses, or undefined. */
function dateText(v: unknown): string | undefined {
  const text = optText(v, 64)
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined
}

/** Whether a shard path is one the database can have (and safe to write under shards/). */
export function isShardPath(path: string): boolean {
  return SHARD_PATH_RE.test(path) && !path.includes('..')
}

export function emptyIndex(): IndexFile {
  return { version: 1, shards: {} }
}

export function normalizeIndex(raw: unknown): IndexFile | null {
  if (!isObject(raw)) return null
  const out = emptyIndex()
  const shards = isObject(raw.shards) ? raw.shards : {}
  for (const [path, entry] of Object.entries(shards)) {
    if (!isShardPath(path) || !isObject(entry)) continue
    const fetchedAt = dateText(entry.fetchedAt)
    if (!fetchedAt) continue
    const etag = optText(entry.etag, 300)
    out.shards[path] = { fetchedAt, ...(etag ? { etag } : {}) }
  }
  return out
}

export function emptyQueue(): QueueFile {
  return { version: 1, items: [] }
}

export function normalizeQueue(raw: unknown): QueueFile | null {
  if (!isObject(raw)) return null
  const out = emptyQueue()
  const seen = new Set<string>()
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!isObject(item)) continue
    const gameId = optText(item.gameId, 500)
    const key = optText(item.key, 160)
    if (!gameId || !key || !KEY_RE.test(key) || seen.has(key)) continue
    seen.add(key)
    out.items.push({ gameId, key, queuedAt: dateText(item.queuedAt) ?? new Date(0).toISOString() })
  }
  out.items = out.items.slice(-MAX_QUEUED_GAMES)
  return out
}

/**
 * Add a game to the queue: a game already waiting under the same key keeps its place. Keeps at most
 * MAX_QUEUED_GAMES, dropping the oldest.
 */
export function enqueueGame(items: readonly QueuedGame[], next: QueuedGame): QueuedGame[] {
  if (items.some((i) => i.key === next.key)) return [...items]
  return [...items, next].slice(-MAX_QUEUED_GAMES)
}

export function emptySent(): SentFile {
  return { version: 1, keys: {} }
}

export function normalizeSent(raw: unknown): SentFile | null {
  if (!isObject(raw)) return null
  const out = emptySent()
  const keys = isObject(raw.keys) ? raw.keys : {}
  for (const [key, entry] of Object.entries(keys)) {
    if (!KEY_RE.test(key) || !isObject(entry)) continue
    const at = dateText(entry.at)
    const result = entry.result
    if (!at || typeof result !== 'string' || !SENT_RESULTS.has(result as SentResult)) continue
    out.keys[key] = { at, result: result as SentResult }
  }
  return { version: 1, keys: trimSent(out.keys) }
}

/** The sent keys within MAX_SENT_KEYS, the oldest forgotten first. */
export function trimSent(keys: Record<string, SentEntry>): Record<string, SentEntry> {
  const entries = Object.entries(keys)
  if (entries.length <= MAX_SENT_KEYS) return keys
  entries.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at))
  return Object.fromEntries(entries.slice(-MAX_SENT_KEYS))
}
