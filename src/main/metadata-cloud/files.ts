// The metadata cloud's files in userData/metadata-cloud: config.json (relay URL, the owner token encrypted with
// safeStorage like accounts.json, the install's random suggestion id), cache.json (the last all.json and its ETag, so
// the cloud's corrections show offline and at once on start) and queue.json (edits waiting to be published or
// suggested, and recompilations added in the browser waiting to be published or suggested). Whatever a file holds is
// reduced to valid values: a damaged entry is dropped, never an exception.
import { randomUUID } from 'crypto'
import type { MetadataTokenState } from '../../shared/metadata-cloud'
import type { MetadataEdit } from '../../shared/metadata-edit'
import type { CloudRecomp } from '../../shared/recomp'
import { safeParseMetadataEdit } from '../metadata-edits/schema'
import { isRecompConsole } from '../recomp/consoles'
import { repoKey } from '../recomp/catalog'
import {
  CLOUD_RECOMP_BLURB_MAX,
  CLOUD_RECOMP_GAME_MAX,
  githubRepoOf,
  isSafeLine,
  parseCloudRecomp,
  parseCloudRecomps
} from './recomps'

export interface CloudConfigFile {
  version: 1
  /** Random id sent with suggestions (the relay's per-install rate limit); not tied to the user. */
  clientId: string
  relayUrl: string
  suggestEdits: boolean
  /** The owner token: base64 of safeStorage.encryptString(token), or plain when encryption is unavailable. */
  token?: { encrypted?: string; plain?: string }
  tokenState?: Exclude<MetadataTokenState, 'none'>
  tokenLogin?: string
  tokenCheckedAt?: string
  tokenError?: string
}

export interface CloudCacheFile {
  version: 1
  etag?: string
  lastSyncAt?: string
  generatedAt?: string
  /** The relay URL the repository announces. */
  relayUrl?: string
  /** key -> fields, as all.json had them (validated again when applied). */
  games: Record<string, unknown>
  /**
   * The owner's own writes to main (publishes and approvals) that all.json may not carry yet (the Action rebuilds it
   * after the push, and the raw CDN caches it for minutes): laid over every downloaded all.json until one carries
   * them, a newer build replaces them, or they are older than PENDING_MAX_MS.
   */
  pending?: Record<string, PendingWrite>
  /**
   * all.json's `recomps` (PlayOut's list of recompilations, parseCloudRecomps). Absent in a cache an older PlayOut
   * wrote, which never read them: such a cache's ETag is not sent, so the next download brings them.
   */
  recomps?: CloudRecomp[]
  /** The owner's own recompilation publishes all.json may not carry yet (as `pending`), by id. */
  pendingRecomps?: Record<string, PendingRecomp>
}

/** One owner publish of a recompilation waiting for all.json. */
export interface PendingRecomp {
  recomp: CloudRecomp
  at: string
}

/** One owner write waiting for all.json: the game's whole fields on main after the write, and when it was made. */
export interface PendingWrite {
  fields: MetadataEdit
  at: string
}

/** An edit waiting to be published (owner) or suggested (anyone else); delivery decides which when it runs. */
export interface QueuedEdit {
  key: string
  title: string
  fields: MetadataEdit
  queuedAt: string
  attempts: number
  lastError?: string
}

/** A recompilation added in the browser, waiting to be published (owner) or suggested (anyone else). */
export interface QueuedRecomp {
  /** "github:<owner>/<repo>". */
  id: string
  /** "<owner>/<repo>" as GitHub spells it. */
  repo: string
  game: string
  systemId: string
  blurb?: string
  queuedAt: string
  attempts: number
  lastError?: string
}

export interface QueueFile {
  version: 1
  items: QueuedEdit[]
  /** Kept apart from the edits: an older PlayOut reads only `items` (and drops this list when it saves). */
  recomps: QueuedRecomp[]
}

/** The most edits kept waiting; the oldest go first when there are more. */
export const MAX_QUEUED = 200

const TOKEN_STATES = new Set(['unchecked', 'ok', 'invalid', 'no-access'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optText = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined

export function newClientId(): string {
  return randomUUID().replace(/-/g, '')
}

export function defaultConfig(): CloudConfigFile {
  return { version: 1, clientId: newClientId(), relayUrl: '', suggestEdits: true }
}

export function normalizeConfig(raw: unknown): CloudConfigFile | null {
  if (!isObject(raw)) return null
  const out = defaultConfig()
  if (typeof raw.clientId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(raw.clientId))
    out.clientId = raw.clientId
  out.relayUrl = optText(raw.relayUrl, 500) ?? ''
  if (raw.suggestEdits === false) out.suggestEdits = false
  if (isObject(raw.token)) {
    const encrypted = optText(raw.token.encrypted, 10_000)
    const plain = optText(raw.token.plain, 500)
    if (encrypted) out.token = { encrypted }
    else if (plain) out.token = { plain }
  }
  if (out.token) {
    if (typeof raw.tokenState === 'string' && TOKEN_STATES.has(raw.tokenState))
      out.tokenState = raw.tokenState as CloudConfigFile['tokenState']
    else out.tokenState = 'unchecked'
    out.tokenLogin = optText(raw.tokenLogin, 100)
    out.tokenCheckedAt = optText(raw.tokenCheckedAt, 64)
    out.tokenError = optText(raw.tokenError, 500)
  }
  return out
}

export function emptyCache(): CloudCacheFile {
  return { version: 1, games: {} }
}

export function normalizeCache(raw: unknown): CloudCacheFile | null {
  if (!isObject(raw)) return null
  const out = emptyCache()
  out.etag = optText(raw.etag, 300)
  out.lastSyncAt = optText(raw.lastSyncAt, 64)
  out.generatedAt = optText(raw.generatedAt, 64)
  out.relayUrl = optText(raw.relayUrl, 500)
  if (isObject(raw.games)) out.games = raw.games
  if (Array.isArray(raw.recomps)) out.recomps = parseCloudRecomps(raw.recomps)
  if (isObject(raw.pendingRecomps)) {
    const pending: Record<string, PendingRecomp> = {}
    for (const entry of Object.values(raw.pendingRecomps)) {
      if (!isObject(entry)) continue
      const recomp = parseCloudRecomp(entry.recomp)
      const at = optText(entry.at, 64)
      if (!recomp || !at || Number.isNaN(Date.parse(at))) continue
      pending[recomp.id] = { recomp, at }
    }
    if (Object.keys(pending).length) out.pendingRecomps = pending
  }
  if (isObject(raw.pending)) {
    const pending: Record<string, PendingWrite> = {}
    for (const [key, entry] of Object.entries(raw.pending)) {
      if (!key || key.length > 300 || !isObject(entry)) continue
      const fields = safeParseMetadataEdit(entry.fields)
      const at = optText(entry.at, 64)
      if (!fields || !Object.keys(fields).length || !at || Number.isNaN(Date.parse(at))) continue
      pending[key] = { fields, at }
    }
    if (Object.keys(pending).length) out.pending = pending
  }
  return out
}

export function emptyQueue(): QueueFile {
  return { version: 1, items: [], recomps: [] }
}

/** A waiting recompilation as stored, or null when it is not a valid one. */
export function parseQueuedRecomp(item: unknown): QueuedRecomp | null {
  if (!isObject(item)) return null
  const repo = githubRepoOf(item.repo)
  if (!repo || item.id !== repoKey('github', repo) || !isRecompConsole(item.systemId)) return null
  const game = typeof item.game === 'string' ? item.game.trim() : ''
  if (!game || game.length > CLOUD_RECOMP_GAME_MAX || !isSafeLine(game)) return null
  const blurb =
    typeof item.blurb === 'string' &&
    item.blurb.trim() &&
    item.blurb.length <= CLOUD_RECOMP_BLURB_MAX &&
    isSafeLine(item.blurb)
      ? item.blurb.trim()
      : undefined
  return {
    id: item.id,
    repo,
    game,
    systemId: item.systemId,
    ...(blurb ? { blurb } : {}),
    queuedAt: optText(item.queuedAt, 64) ?? new Date(0).toISOString(),
    attempts:
      typeof item.attempts === 'number' && Number.isInteger(item.attempts) && item.attempts >= 0
        ? item.attempts
        : 0,
    lastError: optText(item.lastError, 500)
  }
}

export function normalizeQueue(raw: unknown): QueueFile | null {
  if (!isObject(raw)) return null
  const out = emptyQueue()
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!isObject(item)) continue
    const key = optText(item.key, 300)
    const fields = safeParseMetadataEdit(item.fields)
    if (!key || !fields || !Object.keys(fields).length) continue
    out.items.push({
      key,
      title: optText(item.title, 300) ?? key,
      fields,
      queuedAt: optText(item.queuedAt, 64) ?? new Date(0).toISOString(),
      attempts:
        typeof item.attempts === 'number' && Number.isInteger(item.attempts) && item.attempts >= 0
          ? item.attempts
          : 0,
      lastError: optText(item.lastError, 500)
    })
  }
  out.items = out.items.slice(-MAX_QUEUED)
  const ids = new Set<string>()
  for (const item of Array.isArray(raw.recomps) ? raw.recomps : []) {
    const r = parseQueuedRecomp(item)
    if (!r || ids.has(r.id)) continue
    ids.add(r.id)
    out.recomps.push(r)
  }
  out.recomps = out.recomps.slice(-MAX_QUEUED)
  return out
}

/**
 * Add an edit to the queue: an edit already waiting for the same game takes the new fields over its own (one
 * suggestion per game), and moves to the end. Keeps at most MAX_QUEUED, dropping the oldest.
 */
export function enqueueEdit(items: readonly QueuedEdit[], next: QueuedEdit): QueuedEdit[] {
  return enqueueEditReporting(items, next).items
}

/** enqueueEdit, also returning the oldest edits it dropped to stay within MAX_QUEUED. */
export function enqueueEditReporting(
  items: readonly QueuedEdit[],
  next: QueuedEdit
): { items: QueuedEdit[]; dropped: QueuedEdit[] } {
  const existing = items.find((i) => i.key === next.key)
  const merged: QueuedEdit = existing
    ? { ...next, fields: { ...existing.fields, ...next.fields }, attempts: 0 }
    : next
  const all = [...items.filter((i) => i.key !== next.key), merged]
  const over = Math.max(0, all.length - MAX_QUEUED)
  return { items: all.slice(over), dropped: all.slice(0, over) }
}

/**
 * The queue without the given fields of `key`'s waiting edit (all of them when `fields` is undefined): a field the
 * user reset must not be sent later. An edit left with no field is removed.
 */
export function pruneQueued(
  items: readonly QueuedEdit[],
  key: string,
  fields: readonly string[] | undefined
): QueuedEdit[] {
  const out: QueuedEdit[] = []
  for (const item of items) {
    if (item.key !== key) {
      out.push(item)
      continue
    }
    if (!fields) continue
    const rest = { ...item.fields } as Record<string, unknown>
    for (const f of fields) delete rest[f]
    if (Object.keys(rest).length) out.push({ ...item, fields: rest as MetadataEdit })
  }
  return out
}
