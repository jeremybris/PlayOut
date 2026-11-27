// The PlayOut metadata cloud (shared/metadata-cloud.ts) in the main process:
//
// - Sync: downloads the repository's all.json (no account; If-None-Match with the cached ETag) at start and every 6
//   hours, retrying sooner after a failure, caches it in userData/metadata-cloud/cache.json and lays it over the
//   library through the MetadataCloudOverlay (games added later pick their entry up by key on their own).
// - Owner: with a fine-grained token that may write to the repository, a saved edit is published at once
//   (games/<key>.json through the Contents API, merged onto the fields already there; the repository's Action then
//   rebuilds all.json) and the open suggestions can be approved (merged) or rejected (closed).
// - Everyone else: a saved edit is suggested through the relay (metadata-relay/), which opens a pull request for the
//   owner. Without a relay, or while it cannot be reached, the edit waits in queue.json and is retried hourly and at
//   start (a flush stops at the first edit that cannot go and backs off: exactly the relay's Retry-After when it
//   limited the suggestions, 30 per hour from one PC, else doubling; a timer flushes again when the wait is over).
//   Waiting edits are never dropped for their age or their attempts; only the oldest go when more than MAX_QUEUED
//   wait. Resetting a field takes it out of the game's waiting edit.
// - The owner's own writes (publishes, approvals) are kept in the cache as pending until a downloaded all.json carries
//   them, so an all.json built before them does not hide them; the owner's matching local edit is tidied away only
//   then.
import { join } from 'path'
import {
  diffMetadataFields,
  mergeMetadataFields,
  METADATA_ALL_JSON_URL,
  metadataFieldLabel,
  METADATA_REPO,
  normalizeRelayUrl,
  queueLimitText,
  relayLimit,
  sameMetadataValue,
  unsafeMetadataFields,
  type MetadataCloudConfigPatch,
  type MetadataCloudNotice,
  type MetadataCloudStatus,
  type MetadataQueueLimit,
  type MetadataSuggestion
} from '../../shared/metadata-cloud'
import {
  gameMetadataKey,
  localMetadataEdit,
  METADATA_EDIT_FIELDS,
  type MetadataEdit,
  type MetadataEditField
} from '../../shared/metadata-edit'
import type { Game } from '../../shared/types'
import type { TokenCrypto } from '../accounts/token-store'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import type { MetadataCloudOverlay } from '../metadata-edits/cloud-overlay'
import { safeParseMetadataEdit } from '../metadata-edits/schema'
import type { MetadataEditChange } from '../services/library-service'
import { JsonStore } from '../store/json-store'
import {
  defaultConfig,
  emptyCache,
  emptyQueue,
  enqueueEditReporting,
  MAX_QUEUED,
  normalizeCache,
  normalizeConfig,
  normalizeQueue,
  pruneQueued,
  type CloudCacheFile,
  type CloudConfigFile,
  type PendingWrite,
  type QueueFile,
  type QueuedEdit
} from './files'
import { GitHubClient, GitHubError, type PullRequestInfo } from './github'
import { tMain } from '../i18n'

export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
export const QUEUE_INTERVAL_MS = 60 * 60 * 1000
/** First retry after a failed download; doubles up to SYNC_INTERVAL_MS. */
export const SYNC_RETRY_MS = 5 * 60 * 1000
/** A bigger all.json is refused (thousands of games fit in a few MB). */
export const MAX_ALL_JSON_BYTES = 32 * 1024 * 1024
/** The label the relay gives its pull requests. */
export const SUGGESTION_LABEL = 'suggestion'
/** all.json is checked again this soon after an owner write (longer than the raw CDN's ~5 minute cache). */
export const PENDING_RECHECK_MS = 6 * 60 * 1000
/** An owner write all.json still does not carry after this long is no longer laid over it. */
export const PENDING_MAX_MS = 24 * 60 * 60 * 1000
/** An all.json built this long after an owner write is taken as it is (clock differences stay within it). */
export const PENDING_BUILD_MARGIN_MS = 10 * 60 * 1000
/** A flush that stopped on a failure waits this long before the next (doubling up to QUEUE_BACKOFF_MAX_MS). */
export const QUEUE_RETRY_MS = 5 * 60 * 1000
export const QUEUE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
/**
 * Added to the relay's Retry-After when it limited the suggestions (429): its hour has surely turned by then, even
 * with the clocks a little apart. The limit is not a failure, so it never doubles.
 */
export const QUEUE_RATE_LIMIT_MARGIN_MS = 30 * 1000

const GAME_FILE_RE = /^games\/([^/]+)\.json$/

/** The part of LibraryService the cloud uses. */
export interface CloudLibrary {
  games(): Game[]
  setMetadataEditedHook(
    hook:
      | ((
          game: Game,
          key: string | null,
          edit: MetadataEdit,
          change: MetadataEditChange
        ) => void | Promise<void>)
      | null
  ): void
  clearMetadataEdit(id: string, fields?: readonly MetadataEditField[]): Game
  /**
   * The same tidy-up for the user's edits of host-only games (LibraryService.tidyRemoteMetadataEdit): the edit stored
   * under `key` drops the fields the cloud now carries with the same value.
   */
  tidyRemoteMetadataEdit?(key: string, fields: MetadataEdit): void
}

export interface MetadataCloudDeps {
  /** userData/metadata-cloud */
  dir: string
  overlay: MetadataCloudOverlay
  library: CloudLibrary
  events: Pick<EventBus, 'emit'>
  log: Logger
  appVersion: string
  fetch?: typeof fetch
  /** safeStorage (injected in tests). */
  crypto?: TokenCrypto
  now?: () => number
  /** all.json's URL (tests). */
  allJsonUrl?: string
  /** Store write debounce (tests use 0). */
  debounceMs?: number
}

type Delivery =
  | { result: 'done'; message: string }
  | { result: 'unchanged'; message: string }
  /** Could not go now (no relay, unreachable, 429 / 5xx, token refused): it stays queued. */
  | {
      result: 'retry'
      message: string
      retryAfterMs?: number
      /** A 429: the suggestion service limited this PC ('client') or everyone ('service'). */
      limit?: MetadataQueueLimit
      /** Not sent at all: the queue waits before sending again. */
      waiting?: boolean
    }
  | { result: 'drop'; message: string }

async function electronCrypto(): Promise<TokenCrypto> {
  const { safeStorage } = await import('electron')
  return safeStorage
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A response's body as UTF-8 text, or null when it is longer than `maxBytes`. Counted in bytes as they arrive, and
 * the download is cancelled at the limit: a body sent without Content-Length (chunked, compressed) is never held
 * in memory whole just to be refused.
 */
export async function readTextWithin(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer())
    return whole.byteLength > maxBytes ? null : new TextDecoder().decode(whole)
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size))
}

/** A games/<key>.json's fields (validated), title and key; null when it is not a usable game file. */
function parseGameFile(
  text: string | undefined
): { fields: MetadataEdit; title?: string; key?: unknown } | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as { fields?: unknown; title?: unknown; key?: unknown }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const fields = safeParseMetadataEdit(raw.fields)
    if (!fields) return null
    return {
      fields,
      ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
      key: raw.key
    }
  } catch {
    return null
  }
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

/** Whether every field `pending` sets has the same value in `there`. */
function carries(there: MetadataEdit | null, pending: MetadataEdit): boolean {
  if (!there) return false
  return METADATA_EDIT_FIELDS.every(
    (f) => pending[f] === undefined || sameMetadataValue(pending[f], there[f])
  )
}

/**
 * What a suggestion changes against its base: the fields its head sets to another value, and the fields the base has
 * that its head no longer has (removed).
 */
function suggestionDelta(
  base: MetadataEdit,
  head: MetadataEdit
): { set: MetadataEdit; removed: MetadataEditField[] } {
  const set: MetadataEdit = {}
  const removed: MetadataEditField[] = []
  for (const f of METADATA_EDIT_FIELDS) {
    if (head[f] !== undefined) {
      if (!sameMetadataValue(base[f], head[f])) (set as Record<string, unknown>)[f] = head[f]
    } else if (base[f] !== undefined) removed.push(f)
  }
  return { set, removed }
}

/** Only `fields` of `edit`. */
function pick(edit: MetadataEdit, fields: readonly MetadataEditField[]): MetadataEdit {
  const out: Record<string, unknown> = {}
  for (const f of fields) if (edit[f] !== undefined) out[f] = edit[f]
  return out as MetadataEdit
}

export class MetadataCloudService {
  private readonly config: JsonStore<CloudConfigFile>
  private readonly cache: JsonStore<CloudCacheFile>
  private readonly queue: JsonStore<QueueFile>
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private cryptoApi: TokenCrypto | null
  private token: string | null | undefined = undefined
  private syncing: Promise<MetadataCloudStatus> | null = null
  private flushing: Promise<void> | null = null
  /** A forced flush asked for while another flush ran: it starts when that one is over. */
  private forcedFlush: Promise<void> | null = null
  /** The last delivery (a save's or a flush's): the next one waits for it (exclusive). */
  private delivering: Promise<unknown> = Promise.resolve()
  private lastError: string | null = null
  private failures = 0
  private syncTimer: NodeJS.Timeout | null = null
  private queueTimer: NodeJS.Timeout | null = null
  /** No flush before this time (after one stopped: backoff, or the relay's Retry-After). */ private flushNotBefore = 0
  private flushFailures = 0
  /** The suggestion service limited the waiting edits (429 with a Retry-After): why, until something goes again. */
  private queueLimit: MetadataQueueLimit | null = null
  /** Runs the flush when flushNotBefore passes (one at a time). */
  private flushTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly deps: MetadataCloudDeps) {
    const debounceMs = deps.debounceMs ?? 400
    this.config = new JsonStore({
      file: join(deps.dir, 'config.json'),
      defaults: defaultConfig,
      normalize: normalizeConfig,
      debounceMs
    })
    this.cache = new JsonStore({
      file: join(deps.dir, 'cache.json'),
      defaults: emptyCache,
      normalize: normalizeCache,
      debounceMs
    })
    this.queue = new JsonStore({
      file: join(deps.dir, 'queue.json'),
      defaults: emptyQueue,
      normalize: normalizeQueue,
      debounceMs
    })
    this.doFetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.cryptoApi = deps.crypto ?? null
  }

  /** Read the files, show the cached cloud at once, hook the library's edits and start the timers. */
  async start(): Promise<void> {
    await Promise.all([this.config.load(), this.cache.load(), this.queue.load()])
    // Saves a new install's random suggestion id (defaultConfig made it).
    this.config.set(() => {})
    this.applyOverlay()
    this.deps.library.setMetadataEditedHook((game, key, _edit, change) =>
      this.onEdited(game, key, change)
    )
    this.emitStatus()
    void this.sync()
    if (this.config.get().token && this.config.get().tokenState !== 'ok')
      void this.checkToken().catch(() => {})
    void this.flushQueue()
    this.queueTimer = setInterval(() => void this.flushQueue(), QUEUE_INTERVAL_MS)
    this.queueTimer.unref?.()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.syncTimer) clearTimeout(this.syncTimer)
    if (this.queueTimer) clearInterval(this.queueTimer)
    this.clearFlushTimer()
    this.deps.library.setMetadataEditedHook(null)
    await Promise.all([this.config.flush(), this.cache.flush(), this.queue.flush()])
  }

  // --- status -----------------------------------------------------------------------------------

  status(): MetadataCloudStatus {
    const config = this.config.get()
    const cache = this.cache.get()
    const overlay = this.deps.overlay
    let libraryGames = 0
    if (overlay.size) {
      const seen = new Set<string>()
      for (const game of this.deps.library.games()) {
        const key = gameMetadataKey(game)
        if (key && overlay.has(key) && !seen.has(key)) {
          seen.add(key)
          libraryGames++
        }
      }
    }
    const tokenState = config.token ? (config.tokenState ?? 'unchecked') : 'none'
    const queued = this.queue.get().items.length
    const waiting = queued > 0 && this.now() < this.flushNotBefore
    return {
      syncing: this.syncing !== null,
      lastSyncAt: cache.lastSyncAt ?? null,
      generatedAt: cache.generatedAt ?? null,
      lastError: this.lastError,
      cloudGames: overlay.size,
      libraryGames,
      relayUrl: config.relayUrl,
      sharedRelayUrl: cache.relayUrl ?? '',
      suggestEdits: config.suggestEdits,
      queued,
      queueLimit: waiting ? this.queueLimit : null,
      queueNextAt: waiting ? new Date(this.flushNotBefore).toISOString() : null,
      token: {
        state: tokenState,
        ...(config.token && config.tokenLogin ? { login: config.tokenLogin } : {}),
        ...(config.token && config.tokenCheckedAt ? { checkedAt: config.tokenCheckedAt } : {}),
        ...(config.token && config.tokenError ? { error: config.tokenError } : {})
      },
      owner: tokenState === 'ok'
    }
  }

  private emitStatus(): void {
    if (this.disposed) return
    this.deps.events.emit('metadata-cloud:status', this.status())
  }

  private notice(notice: MetadataCloudNotice): void {
    if (this.disposed) return
    this.deps.events.emit('metadata-cloud:notice', notice)
  }

  // --- all.json ---------------------------------------------------------------------------------

  /** Download all.json now (one download at a time); the next one is scheduled from its result. */
  sync(): Promise<MetadataCloudStatus> {
    if (this.syncing) return this.syncing
    const run = this.download()
      .then(() => {
        this.lastError = null
        this.failures = 0
        // Owner writes all.json does not carry yet: look again soon.
        this.schedule(this.cache.get().pending ? PENDING_RECHECK_MS : SYNC_INTERVAL_MS)
      })
      .catch((err: unknown) => {
        this.lastError = errorText(err)
        this.failures++
        this.deps.log.warn(`metadata cloud: all.json download failed (${this.lastError})`)
        this.schedule(Math.min(SYNC_RETRY_MS * 2 ** (this.failures - 1), SYNC_INTERVAL_MS))
      })
      .then(() => {
        this.syncing = null
        this.emitStatus()
        return this.status()
      })
    this.syncing = run
    this.emitStatus()
    return run
  }

  private schedule(ms: number): void {
    if (this.disposed) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => void this.sync(), ms)
    this.syncTimer.unref?.()
  }

  private async download(): Promise<void> {
    const cache = this.cache.get()
    const headers: Record<string, string> = { 'User-Agent': 'PlayOut', Accept: 'application/json' }
    // Only an ETag of a cache that holds games is worth a 304.
    if (cache.etag && Object.keys(cache.games).length) headers['If-None-Match'] = cache.etag
    let res: Response
    try {
      res = await this.doFetch(this.deps.allJsonUrl ?? METADATA_ALL_JSON_URL, {
        headers,
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      throw new Error(tMain('mainMetadataCloud.cloudUnreachable', { error: errorText(err) }), {
        cause: err
      })
    }
    const at = new Date(this.now()).toISOString()
    if (res.status === 304) {
      this.cache.set((c) => void (c.lastSyncAt = at))
      this.settlePending(this.cache.get().games, this.cache.get().generatedAt)
      this.applyOverlay()
      return
    }
    // 404: the repository has no all.json yet (it is new): an empty cloud, not an error. The owner's first writes
    // stay pending (the Action has not built all.json yet).
    if (res.status === 404) {
      this.cache.replace({
        version: 1,
        games: {},
        lastSyncAt: at,
        pending: this.cache.get().pending
      })
      this.settlePending({}, undefined)
      this.applyOverlay()
      return
    }
    if (!res.ok) throw new Error(tMain('mainMetadataCloud.cloudAnswered', { status: res.status }))
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_ALL_JSON_BYTES) throw new Error('all.json is too large')
    let text: string | null
    try {
      text = await readTextWithin(res, MAX_ALL_JSON_BYTES)
    } catch (err) {
      throw new Error(tMain('mainMetadataCloud.cloudUnreachable', { error: errorText(err) }), {
        cause: err
      })
    }
    if (text === null) throw new Error('all.json is too large')
    let raw: unknown
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      throw new Error('all.json is not valid JSON')
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      throw new Error('all.json has an unexpected form')
    const file = raw as { generatedAt?: unknown; relayUrl?: unknown; games?: unknown }
    const games =
      typeof file.games === 'object' && file.games !== null && !Array.isArray(file.games)
        ? (file.games as Record<string, unknown>)
        : {}
    const relay = typeof file.relayUrl === 'string' ? normalizeRelayUrl(file.relayUrl) : ''
    const relayBefore = this.cache.get().relayUrl ?? ''
    const generatedAt =
      typeof file.generatedAt === 'string' ? file.generatedAt.slice(0, 64) : undefined
    this.cache.replace({
      version: 1,
      etag: res.headers.get('etag') ?? undefined,
      lastSyncAt: at,
      generatedAt,
      relayUrl: relay || undefined,
      games,
      // Written while the download ran: kept.
      pending: this.cache.get().pending
    })
    this.settlePending(games, generatedAt)
    this.applyOverlay()
    // The repository announced a relay: what waits for one can go now.
    if (relay && relay !== relayBefore && this.queue.get().items.length) void this.flushQueue(true)
  }

  /** The overlay: the cached all.json with the owner's pending writes laid over it. */
  private applyOverlay(): void {
    const cache = this.cache.get()
    const games: Record<string, unknown> = { ...cache.games }
    for (const [key, p] of Object.entries(cache.pending ?? {})) games[key] = p.fields
    this.deps.overlay.replaceAll(games)
  }

  /**
   * After a download: a pending owner write the downloaded all.json carries is done (and the owner's local edit that
   * says the same is tidied away); one an all.json built well after it does not carry was replaced since; one older
   * than PENDING_MAX_MS is given up. The rest stays pending.
   */
  private settlePending(games: Record<string, unknown>, generatedAt: string | undefined): void {
    const pending = this.cache.get().pending
    if (!pending) return
    const now = this.now()
    const built = generatedAt ? Date.parse(generatedAt) : NaN
    const keep: Record<string, PendingWrite> = {}
    const confirmed: [string, MetadataEdit][] = []
    for (const [key, p] of Object.entries(pending)) {
      const at = Date.parse(p.at)
      if (carries(safeParseMetadataEdit(games[key]), p.fields)) {
        confirmed.push([key, p.fields])
        continue
      }
      if (!Number.isNaN(built) && built > at + PENDING_BUILD_MARGIN_MS) continue
      if (Number.isNaN(at) || now - at > PENDING_MAX_MS) continue
      keep[key] = p
    }
    if (Object.keys(keep).length === Object.keys(pending).length) return
    this.cache.set((c) => {
      if (Object.keys(keep).length) c.pending = keep
      else delete c.pending
    })
    for (const [key, fields] of confirmed) this.tidyLocalEdit(key, fields)
  }

  /**
   * An owner write shows at once and stays laid over all.json until a download carries it (settlePending); all.json
   * is checked again after PENDING_RECHECK_MS.
   */
  private addPending(key: string, fields: MetadataEdit): void {
    const write: PendingWrite = { fields, at: new Date(this.now()).toISOString() }
    this.cache.set((c) => {
      c.pending = { ...(c.pending ?? {}), [key]: write }
    })
    this.deps.overlay.set(key, fields)
    if (!this.syncing) this.schedule(PENDING_RECHECK_MS)
  }

  // --- configuration and the owner token --------------------------------------------------------

  private async crypto(): Promise<TokenCrypto> {
    return (this.cryptoApi ??= await electronCrypto())
  }

  /** The owner token, decrypted once; null when there is none or it cannot be read on this PC. */
  private async ownerToken(): Promise<string | null> {
    if (this.token !== undefined) return this.token
    const saved = this.config.get().token
    if (!saved) return (this.token = null)
    if (saved.plain) return (this.token = saved.plain)
    try {
      const c = await this.crypto()
      this.token = c.decryptString(Buffer.from(saved.encrypted ?? '', 'base64'))
    } catch (err) {
      this.deps.log.warn(
        `metadata cloud: the saved token could not be decrypted (${errorText(err)})`
      )
      this.token = null
    }
    return this.token
  }

  async setConfig(patch: MetadataCloudConfigPatch): Promise<MetadataCloudStatus> {
    let flush = false
    if (patch.relayUrl !== undefined) {
      const relay = normalizeRelayUrl(patch.relayUrl)
      if (relay === null) throw new Error(tMain('mainMetadataCloud.relayHttps'))
      if (relay !== this.config.get().relayUrl) flush = relay !== ''
      this.config.set((c) => void (c.relayUrl = relay))
    }
    if (patch.suggestEdits !== undefined) {
      this.config.set((c) => void (c.suggestEdits = patch.suggestEdits === true))
      flush ||= patch.suggestEdits === true
    }
    let check = false
    if (patch.token !== undefined) {
      const token = (patch.token ?? '').trim()
      if (!token) {
        this.token = null
        this.config.set((c) => {
          delete c.token
          delete c.tokenState
          delete c.tokenLogin
          delete c.tokenCheckedAt
          delete c.tokenError
        })
      } else {
        if (token.length > 400 || /\s/.test(token))
          throw new Error(tMain('mainMetadataCloud.notToken'))
        const c = await this.crypto()
        const stored = c.isEncryptionAvailable()
          ? { encrypted: c.encryptString(token).toString('base64') }
          : { plain: token }
        if (!stored.encrypted)
          this.deps.log.warn(
            'safeStorage encryption is not available; the metadata token is kept as plain JSON'
          )
        this.token = token
        this.config.set((cfg) => {
          cfg.token = stored
          cfg.tokenState = 'unchecked'
          delete cfg.tokenLogin
          delete cfg.tokenCheckedAt
          delete cfg.tokenError
        })
        check = true
      }
    }
    if (check) await this.checkToken()
    this.emitStatus()
    if (flush) void this.flushQueue(true)
    return this.status()
  }

  /** Ask GitHub whether the token works and may write to the metadata repository. */
  async checkToken(): Promise<MetadataCloudStatus> {
    const token = await this.ownerToken()
    if (!token) {
      if (this.config.get().token)
        this.config.set((c) => {
          c.tokenState = 'invalid'
          c.tokenError = tMain('mainMetadataCloud.tokenUnreadable')
        })
      this.emitStatus()
      return this.status()
    }
    const at = new Date(this.now()).toISOString()
    try {
      const { login, canWrite } = await this.client(token).checkAccess()
      this.config.set((c) => {
        c.tokenState = canWrite ? 'ok' : 'no-access'
        c.tokenLogin = login || undefined
        c.tokenCheckedAt = at
        if (canWrite) delete c.tokenError
        else
          c.tokenError = tMain('mainMetadataCloud.tokenCannotWrite', {
            owner: METADATA_REPO.owner,
            repo: METADATA_REPO.repo
          })
      })
    } catch (err) {
      const status = err instanceof GitHubError ? err.status : 0
      this.config.set((c) => {
        c.tokenCheckedAt = at
        if (status === 401) {
          c.tokenState = 'invalid'
          c.tokenError = tMain('mainMetadataCloud.tokenRefused')
        } else if (status === 403 || status === 404) {
          c.tokenState = 'no-access'
          c.tokenError = tMain('mainMetadataCloud.tokenNoAccess', {
            owner: METADATA_REPO.owner,
            repo: METADATA_REPO.repo
          })
        } else {
          c.tokenState = 'unchecked'
          c.tokenError = errorText(err)
        }
      })
    }
    this.emitStatus()
    if (this.config.get().tokenState === 'ok' && this.queue.get().items.length)
      void this.flushQueue(true)
    return this.status()
  }

  private client(token: string): GitHubClient {
    return new GitHubClient({ token, fetch: this.doFetch })
  }

  /** The owner's client; throws when this PC has no working owner token. */
  private async ownerClient(): Promise<GitHubClient> {
    const token = await this.ownerToken()
    if (!token || this.config.get().tokenState !== 'ok')
      throw new Error(tMain('mainMetadataCloud.addTokenFirst'))
    return this.client(token)
  }

  /** Whether edits are published (a saved token that is not known to be bad) rather than suggested. */
  private isOwner(): boolean {
    const c = this.config.get()
    return !!c.token && (c.tokenState === 'ok' || c.tokenState === 'unchecked')
  }

  /** The relay this PC uses: its own setting, else the one the repository announces. */
  private relayUrl(): string {
    return this.config.get().relayUrl || this.cache.get().relayUrl || ''
  }

  /** The relay this PC uses ('' while none is known): the PlayOut database contributes through the same relay. */
  relayEndpoint(): string {
    return this.relayUrl()
  }

  /** The install's random id (config.json clientId), sent with suggestions and contributions; not tied to the user. */
  installId(): string {
    return this.config.get().clientId
  }

  /** Owner: write the relay URL to the repository's config.json, so every PlayOut learns it with all.json. */
  async shareRelayUrl(): Promise<void> {
    const relay = this.config.get().relayUrl
    if (!relay) throw new Error(tMain('mainMetadataCloud.enterRelay'))
    const gh = await this.ownerClient()
    const current = await gh.readFile('config.json', METADATA_REPO.branch)
    let record: Record<string, unknown> = {}
    try {
      const parsed = current ? (JSON.parse(current.text) as unknown) : {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        record = parsed as Record<string, unknown>
    } catch {
      // replaced below
    }
    if (record.relayUrl === relay) return
    await gh.writeFile({
      path: 'config.json',
      branch: METADATA_REPO.branch,
      text: `${JSON.stringify({ ...record, relayUrl: relay }, null, 2)}\n`,
      message: 'Relay URL',
      sha: current?.sha
    })
  }

  // --- edits: publish or suggest ---------------------------------------------------------------

  /** The library's edited hook: publish (owner) or suggest the fields the user just saved. */
  async onEdited(game: Game, key: string | null, change: MetadataEditChange): Promise<void> {
    // A reset field leaves the game's waiting edit too: what the user withdrew is never sent later.
    // (clearMetadataEdit: `cleared` undefined = every field; setMetadataEdit: `cleared` = the fields it removed.)
    if (key) {
      const everything = !change.set && change.cleared === undefined
      const cleared = everything ? undefined : (change.cleared ?? [])
      if (everything || (cleared && cleared.length)) this.pruneQueue(key, cleared)
    }
    const fields = change.set ? safeParseMetadataEdit(change.set) : null
    // An empty title is "no title edit" (it removes the override), never a value for the cloud.
    if (fields && fields.title !== undefined && !fields.title.trim()) delete fields.title
    // Removing a local edit only goes back to the cloud's value: nothing to send.
    if (!fields || !Object.keys(fields).length) return
    const title = game.title
    if (!key) {
      this.notice({
        kind: 'error',
        title,
        message: tMain('mainMetadataCloud.noKey', { title })
      })
      return
    }
    if (!this.isOwner() && !this.config.get().suggestEdits) return
    // The repository's check would refuse it (and leave the game out of all.json): say so now, keep it local.
    const unsafe = unsafeMetadataFields(fields)
    if (unsafe.length) {
      this.notice({
        kind: 'error',
        title,
        message: tMain('mainMetadataCloud.unsafe', {
          title,
          fields: unsafe.map((f) => metadataFieldLabel(f, tMain)).join(', ')
        })
      })
      return
    }
    // The edit is stored before it is sent (an older waiting edit of the same game goes along with it): a reset or a
    // newer save made while it is being sent then changes the stored copy, and what was sent is taken out of it
    // afterwards only where it still holds the value that went (removeDelivered).
    this.store({
      key,
      title,
      fields,
      queuedAt: new Date(this.now()).toISOString(),
      attempts: 0
    })
    this.emitStatus()
    // One delivery at a time (a flush and saves), so an older value can never land after a newer one.
    await this.exclusive(async () => {
      // Read it again: a reset may have withdrawn it, a flush may have sent it, a newer save may have changed it.
      const stored = this.queue.get().items.find((i) => i.key === key)
      if (!stored) return
      if (!this.isOwner() && !this.config.get().suggestEdits) return
      // Backing off (the relay asked to wait): it stays queued without a request.
      const delivery: Delivery =
        this.now() < this.flushNotBefore
          ? { result: 'retry', message: this.waitingText(), waiting: true }
          : await this.deliver(stored)
      if (delivery.result === 'retry') {
        if (!delivery.waiting && delivery.retryAfterMs !== undefined) this.backOff(delivery)
      } else this.delivered()
      this.afterDelivery(stored, delivery, true)
    })
  }

  /** Put an edit in the queue (merged with the game's waiting edit); the oldest go when more than MAX_QUEUED wait. */
  private store(item: QueuedEdit): void {
    const { items, dropped } = enqueueEditReporting(this.queue.get().items, item)
    this.queue.set((q) => void (q.items = items))
    for (const d of dropped) {
      this.deps.log.warn(
        `metadata cloud: dropped the waiting edit of ${d.key} (more than ${MAX_QUEUED} wait)`
      )
      this.notice({
        kind: 'error',
        title: d.title,
        message: tMain('mainMetadataCloud.dropped', { title: d.title, max: MAX_QUEUED })
      })
    }
  }

  /** Run `task` after every delivery before it (saves and flushes go one at a time). */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.delivering.then(task, task)
    this.delivering = run.catch(() => undefined)
    return run
  }

  /** Take `fields` (all when undefined) out of `key`'s waiting edit. */
  private pruneQueue(key: string, fields: readonly MetadataEditField[] | undefined): void {
    if (!this.queue.get().items.some((i) => i.key === key)) return
    this.queue.set((q) => {
      q.items = pruneQueued(q.items, key, fields)
    })
    this.emitStatus()
  }

  /**
   * Try every waiting edit again (at start, hourly, when a relay or a token appears). Stops at the first edit that
   * cannot go now (no relay, unreachable, 429 / 5xx, token refused: the rest would fail the same way) and backs off;
   * `force` (a new relay or token) skips the backoff.
   */
  flushQueue(force = false): Promise<void> {
    if (this.flushing) {
      if (!force) return this.flushing
      // A new token or relay while a flush still waits on its answer: once it is over (whatever backoff it set), one
      // forced flush more, so the new way is used at once. Several such calls share that one flush.
      this.forcedFlush ??= this.flushing
        .catch(() => undefined)
        .then(() => {
          this.forcedFlush = null
          return this.flushQueue(true)
        })
      return this.forcedFlush
    }
    if (force) {
      this.flushNotBefore = 0
      this.flushFailures = 0
      this.queueLimit = null
      this.clearFlushTimer()
    }
    if (this.now() < this.flushNotBefore) return Promise.resolve()
    const run = this.exclusive(async () => {
      // A save that went before may have backed off.
      if (!force && this.now() < this.flushNotBefore) return
      for (const { key } of [...this.queue.get().items]) {
        if (this.disposed) return
        if (!this.isOwner() && !this.config.get().suggestEdits) return
        // Read it again: a save or a reset may have changed it while the one before was sent.
        const item = this.queue.get().items.find((i) => i.key === key)
        if (!item) continue
        const delivery = await this.deliver(item)
        if (delivery.result === 'retry') {
          // Backed off first, so the status and the edit's note carry the next attempt.
          this.backOff(delivery)
          this.afterDelivery(item, delivery, false)
          return
        }
        // Something went: the service works, whatever stops this flush later starts its backoff afresh.
        this.delivered()
        this.afterDelivery(item, delivery, false)
      }
      this.delivered()
      this.flushNotBefore = 0
      this.clearFlushTimer()
    }).finally(() => {
      this.flushing = null
    })
    this.flushing = run
    return run
  }

  /**
   * No flush for a while. The relay's rate limit (429 with a Retry-After) is not a failure: wait exactly as long as it
   * asked (plus QUEUE_RATE_LIMIT_MARGIN_MS), never doubling. Anything else (unreachable, 5xx, token refused) doubles
   * from QUEUE_RETRY_MS, or waits as long as the server asked if that is longer. Both are capped at
   * QUEUE_BACKOFF_MAX_MS. A timer runs the flush when the wait is over.
   */
  private backOff(delivery: { retryAfterMs?: number; limit?: MetadataQueueLimit }): void {
    let wait: number
    if (delivery.limit && delivery.retryAfterMs !== undefined) {
      this.queueLimit = delivery.limit
      wait = delivery.retryAfterMs + QUEUE_RATE_LIMIT_MARGIN_MS
    } else {
      this.queueLimit = null
      this.flushFailures++
      const doubling = QUEUE_RETRY_MS * 2 ** Math.min(this.flushFailures - 1, 16)
      wait = Math.max(doubling, delivery.retryAfterMs ?? 0)
    }
    this.flushNotBefore = this.now() + Math.min(wait, QUEUE_BACKOFF_MAX_MS)
    this.scheduleFlush()
  }

  /** An edit went (or was answered for good): the backoff and the limit start afresh. */
  private delivered(): void {
    this.flushFailures = 0
    this.queueLimit = null
  }

  /** One timer for flushNotBefore (replacing any earlier one); unref'd so it never keeps PlayOut running. */
  private scheduleFlush(): void {
    this.clearFlushTimer()
    if (this.disposed) return
    const delay = Math.max(0, this.flushNotBefore - this.now())
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.disposed) return
      // Woken a little early (clock changes): wait for the rest.
      if (this.now() < this.flushNotBefore) this.scheduleFlush()
      else void this.flushQueue()
    }, delay)
    this.flushTimer.unref?.()
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /** The note of an edit that waits without being sent (the queue backs off). */
  private waitingText(): string {
    const queued = this.queue.get().items.length
    const nextAt = new Date(this.flushNotBefore).toISOString()
    if (this.queueLimit) return queueLimitText(queued, this.queueLimit, nextAt, tMain)
    const time = new Date(this.flushNotBefore).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    })
    return tMain('mainMetadataCloud.retryAt', { time })
  }

  private afterDelivery(item: QueuedEdit, delivery: Delivery, fromSave: boolean): void {
    const owner = this.isOwner()
    if (delivery.result === 'retry') {
      // It stays queued as it is now (a reset or a newer save made meanwhile is kept; never dropped for its attempts
      // or its age): only its attempts and error are noted.
      // Limited by the suggestion service (now or still): say so plainly, with when the rest go.
      const limited =
        this.queueLimit && this.now() < this.flushNotBefore ? this.waitingText() : null
      const attempts = item.attempts + 1
      const lastError = (limited ?? delivery.message).slice(0, 500)
      if (this.queue.get().items.some((i) => i.key === item.key))
        this.queue.set((q) => {
          q.items = q.items.map((i) => (i.key === item.key ? { ...i, attempts, lastError } : i))
        })
      if (fromSave)
        this.notice({
          kind: 'queued',
          title: item.title,
          message: limited
            ? tMain('mainMetadataCloud.savedLimited', { title: item.title, note: limited })
            : owner
              ? tMain('mainMetadataCloud.savedOwner', { title: item.title })
              : tMain('mainMetadataCloud.savedNoRelay', { title: item.title })
        })
    } else {
      this.removeDelivered(item)
      const kind: MetadataCloudNotice['kind'] =
        delivery.result === 'done'
          ? owner
            ? 'published'
            : 'suggested'
          : delivery.result === 'unchanged'
            ? 'unchanged'
            : 'error'
      // A retried edit only reports what the user would want to know: that it went, or that it was refused.
      if (fromSave || kind !== 'unchanged')
        this.notice({ kind, title: item.title, message: delivery.message })
    }
    this.emitStatus()
  }

  /**
   * Take a delivered (or refused) edit out of the queue. A waiting edit of the same game that changed while it was
   * being sent (a newer save) keeps only the fields that differ from what went.
   */
  private removeDelivered(item: QueuedEdit): void {
    const waiting = this.queue.get().items.find((i) => i.key === item.key)
    if (!waiting) return
    const sent = METADATA_EDIT_FIELDS.filter(
      (f) =>
        waiting.fields[f] !== undefined &&
        item.fields[f] !== undefined &&
        sameMetadataValue(waiting.fields[f], item.fields[f])
    )
    this.queue.set((q) => {
      q.items = pruneQueued(q.items, item.key, sent)
    })
  }

  private deliver(item: QueuedEdit): Promise<Delivery> {
    return this.isOwner() ? this.publish(item) : this.suggest(item)
  }

  /**
   * Merge `fields` onto games/<key>.json on main (each field replaces the same field; `remove`'s fields are taken
   * out) and write it with the sha it
   * read: when someone changed it between the read and the write, it is read and merged again once. Throws
   * GitHubError otherwise. Returns the file's fields after it and whether anything changed.
   */
  private async writeGameFields(
    gh: GitHubClient,
    key: string,
    title: string,
    fields: MetadataEdit,
    message?: (title: string) => string,
    remove: readonly MetadataEditField[] = []
  ): Promise<{ changed: boolean; after: MetadataEdit }> {
    const path = `games/${key}.json`
    for (let attempt = 0; ; attempt++) {
      try {
        const current = await gh.readFile(path, METADATA_REPO.branch)
        let record: Record<string, unknown> = {}
        if (current) {
          try {
            const parsed = JSON.parse(current.text) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
              record = parsed as Record<string, unknown>
          } catch {
            // A broken file is replaced.
          }
        }
        const before = safeParseMetadataEdit(record.fields) ?? {}
        const after = mergeMetadataFields(before, fields)
        for (const f of remove) delete after[f]
        if (current && diffMetadataFields(before, after, tMain).length === 0)
          return { changed: false, after }
        const updated = {
          key,
          title:
            after.title ??
            (typeof record.title === 'string' && record.title ? record.title : title),
          fields: after,
          updatedAt: new Date(this.now()).toISOString()
        }
        await gh.writeFile({
          path,
          branch: METADATA_REPO.branch,
          text: `${JSON.stringify(updated, null, 2)}\n`,
          message: message
            ? message(updated.title)
            : `${current ? 'Update' : 'Add'} ${updated.title} (${key})`,
          sha: current?.sha
        })
        return { changed: true, after }
      } catch (err) {
        const status = err instanceof GitHubError ? err.status : 0
        // Someone else changed the file between the read and the write: read it again once.
        if ((status === 409 || status === 422) && attempt === 0) continue
        throw err
      }
    }
  }

  /** Owner: merge the fields onto games/<key>.json on main and show the result at once (pending until all.json). */
  private async publish(item: QueuedEdit): Promise<Delivery> {
    const token = await this.ownerToken()
    if (!token) return this.suggest(item)
    try {
      const { changed, after } = await this.writeGameFields(
        this.client(token),
        item.key,
        item.title,
        item.fields
      )
      this.addPending(item.key, after)
      return changed
        ? { result: 'done', message: tMain('mainMetadataCloud.published', { title: item.title }) }
        : {
            result: 'unchanged',
            message: tMain('mainMetadataCloud.unchanged', { title: item.title })
          }
    } catch (err) {
      const status = err instanceof GitHubError ? err.status : 0
      if (status === 401 || status === 403 || status === 404) {
        this.config.set((c) => {
          c.tokenState = status === 401 ? 'invalid' : 'no-access'
          c.tokenError = errorText(err)
        })
        this.emitStatus()
        return {
          result: 'retry',
          message: tMain('mainMetadataCloud.tokenRefusedPublish', {
            title: item.title,
            error: errorText(err)
          })
        }
      }
      if (status === 0 || status === 409 || status === 422 || status === 429 || status >= 500)
        return { result: 'retry', message: errorText(err) }
      return {
        result: 'drop',
        message: tMain('mainMetadataCloud.publishFailed', {
          title: item.title,
          error: errorText(err)
        })
      }
    }
  }

  /**
   * The owner's own local edit of fields the cloud now carries with the same value is removed: the cloud has it,
   * and later approvals of that field must not hide behind it. Only once a downloaded all.json carries the write
   * (settlePending): until then the local edit keeps showing it.
   */
  private tidyLocalEdit(key: string, fields: MetadataEdit): void {
    for (const game of this.deps.library.games()) {
      if (gameMetadataKey(game) !== key) continue
      const local = localMetadataEdit(game)
      const same = METADATA_EDIT_FIELDS.filter(
        (f) =>
          local[f] !== undefined &&
          fields[f] !== undefined &&
          sameMetadataValue(local[f], fields[f])
      )
      if (!same.length) continue
      try {
        this.deps.library.clearMetadataEdit(game.id, same)
      } catch (err) {
        this.deps.log.warn(`metadata cloud: could not tidy ${game.id}'s edit (${errorText(err)})`)
      }
    }
    // The owner's edits of host-only games (remote-metadata-edits.json) too.
    try {
      this.deps.library.tidyRemoteMetadataEdit?.(key, fields)
    } catch (err) {
      this.deps.log.warn(
        `metadata cloud: could not tidy the host games' edit of ${key} (${errorText(err)})`
      )
    }
  }

  /** Anyone else: send the fields to the relay, which opens a pull request for the owner. */
  private async suggest(item: QueuedEdit): Promise<Delivery> {
    const relay = this.relayUrl()
    if (!relay) return { result: 'retry', message: tMain('mainMetadataCloud.noRelay') }
    let res: Response
    try {
      res = await this.doFetch(`${relay}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'PlayOut' },
        body: JSON.stringify({
          key: item.key,
          title: item.title.slice(0, 300),
          fields: item.fields,
          appVersion: this.deps.appVersion,
          clientId: this.config.get().clientId
        }),
        signal: AbortSignal.timeout(30_000)
      })
    } catch (err) {
      return {
        result: 'retry',
        message: tMain('mainMetadataCloud.relayUnreachable', { error: errorText(err) })
      }
    }
    let body: { ok?: boolean; error?: string } = {}
    try {
      body = (await res.json()) as typeof body
    } catch {
      // not JSON
    }
    if (res.ok && body.ok !== false)
      return {
        result: 'done',
        message: tMain('mainMetadataCloud.suggested', { title: item.title })
      }
    if (res.status === 409)
      return {
        result: 'unchanged',
        message: tMain('mainMetadataCloud.unchanged', { title: item.title })
      }
    if (res.status === 400 || res.status === 413 || res.status === 415)
      return {
        result: 'drop',
        message: tMain('mainMetadataCloud.suggestionRefused', {
          title: item.title,
          error: body.error ?? res.status
        })
      }
    const after = res.status === 429 ? retryAfterMs(res, this.now()) : undefined
    // The relay names the limit it hit (relayLimit).
    const limit = res.status === 429 ? relayLimit(body.error ?? '') : undefined
    return {
      result: 'retry',
      message: body.error ?? tMain('mainMetadataCloud.relayAnswered', { status: res.status }),
      ...(after !== undefined ? { retryAfterMs: after } : {}),
      ...(limit ? { limit } : {})
    }
  }

  // --- owner: suggestions -----------------------------------------------------------------------

  /** The open pull requests labelled 'suggestion', each with its fields' cloud value -> suggested value. */
  async suggestions(): Promise<MetadataSuggestion[]> {
    const gh = await this.ownerClient()
    const pulls = await gh.openPullRequests(SUGGESTION_LABEL)
    const out: MetadataSuggestion[] = []
    for (const pr of pulls.slice(0, 50)) {
      const base: MetadataSuggestion = {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        key: null,
        gameTitle: pr.title.replace(/^Suggestion:\s*/i, ''),
        createdAt: pr.createdAt,
        headSha: pr.headSha,
        changes: []
      }
      try {
        const files = await gh.pullRequestFiles(pr.number)
        const match = files.length === 1 ? GAME_FILE_RE.exec(files[0] ?? '') : null
        if (!match) {
          out.push({ ...base, error: tMain('mainMetadataCloud.otherFiles') })
          continue
        }
        const path = files[0]!
        const [now, next, from] = await Promise.all([
          gh.readFile(path, METADATA_REPO.branch),
          gh.readFile(path, pr.headSha),
          this.suggestionBase(gh, path, pr)
        ])
        const suggested = parseGameFile(next?.text)
        if (!suggested) {
          out.push({
            ...base,
            key: match[1]!,
            error: tMain('mainMetadataCloud.invalidFile')
          })
          continue
        }
        // What approving writes (the merge and its fallback alike): the fields the head changes against its base,
        // each shown from main's current value; a field main already has at the suggested value is left out.
        const current = parseGameFile(now?.text)?.fields ?? {}
        const { set, removed } = suggestionDelta(from, suggested.fields)
        const fields = [...(Object.keys(set) as MetadataEditField[]), ...removed].filter(
          (f) => !sameMetadataValue(current[f], suggested.fields[f])
        )
        out.push({
          ...base,
          key: match[1]!,
          gameTitle: suggested.title ?? base.gameTitle,
          changes: diffMetadataFields(pick(current, fields), pick(suggested.fields, fields), tMain)
        })
      } catch (err) {
        out.push({ ...base, error: errorText(err) })
      }
    }
    return out
  }

  /**
   * Approve or reject (close, and delete the relay's branch) one suggestion. `reviewedSha`: the head the owner
   * reviewed (MetadataSuggestion.headSha), required to approve; refused when the pull request moved on since.
   */
  async resolveSuggestion(
    number: number,
    action: 'approve' | 'reject',
    reviewedSha?: string
  ): Promise<void> {
    if (action === 'approve' && !reviewedSha)
      throw new Error(tMain('mainMetadataCloud.reviewedOnly', { number }))
    const gh = await this.ownerClient()
    const pr = await gh.pullRequest(number)
    if (!pr.labels.includes(SUGGESTION_LABEL))
      throw new Error(tMain('mainMetadataCloud.notSuggestion', { number }))
    if (action === 'approve') await this.approve(gh, pr, reviewedSha!)
    else {
      await gh.closePullRequest(number)
      await this.deleteSuggestionBranch(gh, pr)
    }
    this.emitStatus()
  }

  /** The game file's fields at the pull request's base ({} when it had none there, or no base is known). */
  private async suggestionBase(
    gh: GitHubClient,
    path: string,
    pr: PullRequestInfo
  ): Promise<MetadataEdit> {
    if (!pr.baseSha) return {}
    return parseGameFile((await gh.readFile(path, pr.baseSha))?.text)?.fields ?? {}
  }

  private async deleteSuggestionBranch(gh: GitHubClient, pr: PullRequestInfo): Promise<void> {
    if (!pr.headInRepo || !pr.headRef.startsWith('suggest/')) return
    await gh
      .deleteBranch(pr.headRef)
      .catch((err: unknown) =>
        this.deps.log.warn(`metadata cloud: could not delete ${pr.headRef} (${errorText(err)})`)
      )
  }

  /**
   * Approve: check the pull request as it is now (one games/<key>.json, valid and accepted by the repository's
   * check, at the head it merges), then squash-merge exactly that head. When it cannot be merged as it is (an
   * approval or publish of the same game since it was opened), the fields it changes are merged onto main's current
   * file instead, and it is closed with a comment.
   */
  private async approve(gh: GitHubClient, pr: PullRequestInfo, reviewedSha: string): Promise<void> {
    const number = pr.number
    const changed = tMain('mainMetadataCloud.changedAfterReview', { number })
    if (reviewedSha !== pr.headSha) throw new Error(changed)
    const files = await gh.pullRequestFiles(number)
    const match = files.length === 1 ? GAME_FILE_RE.exec(files[0] ?? '') : null
    if (!match) throw new Error(tMain('mainMetadataCloud.prOtherFiles', { number }))
    // The file list is the head's at the time it was read: it must still be the head checked and merged below.
    if ((await gh.pullRequest(number)).headSha !== pr.headSha) throw new Error(changed)
    const key = match[1]!
    const path = files[0]!
    const suggested = parseGameFile((await gh.readFile(path, pr.headSha))?.text)
    if (
      !suggested ||
      !Object.keys(suggested.fields).length ||
      (suggested.key !== undefined && suggested.key !== key)
    )
      throw new Error(tMain('mainMetadataCloud.prInvalidFile', { number }))
    const unsafe = unsafeMetadataFields(suggested.fields)
    if (unsafe.length)
      throw new Error(
        tMain('mainMetadataCloud.prUnsafe', {
          number,
          fields: unsafe.map((f) => metadataFieldLabel(f, tMain)).join(', ')
        })
      )
    try {
      await gh.mergePullRequest(number, pr.headSha, pr.title)
      // Show it at once; all.json follows.
      this.addPending(key, suggested.fields)
      return
    } catch (err) {
      if (!(err instanceof GitHubError && (err.status === 405 || err.status === 409))) throw err
    }
    // Not mergeable as it is: apply what it changes (its head against its base) onto main's current file.
    // A field it sets to another value is set; a field its base has and its head no longer has is removed.
    const base = await this.suggestionBase(gh, path, pr)
    const { set: delta, removed } = suggestionDelta(base, suggested.fields)
    let applied = false
    if (Object.keys(delta).length || removed.length) {
      const title = suggested.title ?? pr.title.replace(/^Suggestion:\s*/i, '')
      const { changed: wrote, after } = await this.writeGameFields(
        gh,
        key,
        title,
        delta,
        (t) => `Apply suggestion #${number}: ${t} (${key})`,
        removed
      )
      applied = wrote
      this.addPending(key, after)
    }
    await gh
      .commentOnPullRequest(
        number,
        applied
          ? `Approved in PlayOut: its changes were applied onto the current games/${key}.json (it could not be merged as it was).`
          : 'Approved in PlayOut: main already has these values.'
      )
      .catch((err: unknown) =>
        this.deps.log.warn(`metadata cloud: could not comment on #${number} (${errorText(err)})`)
      )
    await gh.closePullRequest(number)
    await this.deleteSuggestionBranch(gh, pr)
  }
}
