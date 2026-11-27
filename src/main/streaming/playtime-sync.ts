// The play time added up on paired PCs (Settings › Streaming › "Sync play time"): each PC copies its play sessions of
// the games both PCs have to the other, so a game's play time, play count, last played (and with them Most played and
// Recently played) count the play on both. A session has an id that is unique across PCs (util/ids newId), so the
// sessions are a union: one already kept (sessions-store has, which also knows the ones dropped by its limit) is never
// counted again, and sending the same sessions twice changes nothing.
//
// The library goes host to client only, so the client does the matching (remote-library.ts localMatches, the same
// groups as the favourites: favoriteGroups) and every session crosses by the host's offered game id. POST /v1/playtime:
//  - `sessions`: the client's sessions for the host to take (at most MAX_SESSIONS_PER_REQUEST; each game a host id);
//  - `games` + `after`: the host's sessions of these (host) games recorded after the cursor, a page at a time.
// A cursor is (recorded time, session id) on the clock of the PC that holds the sessions (recorded: ended there, or
// taken from another PC there), so it needs no clock correction; the session times themselves are corrected (the
// other PC's clock, as the tabs sync). A game newly matched gets its whole history once (after = null).
//
// Never counted twice: a session taken from a PC is never sent back to it (`from`), a stream of a host game is played
// and timed on the host only (the client only runs Moonlight), and a session from a third PC (a host's other client)
// is passed on with its own id, which the others then know. A session of a store that reports an account-wide play
// time (Steam, Epic, Xbox: Game.storePlaytimeMinutes, which already counts the play on every PC of that account; the
// PCs share their store logins) carries that store, goes to the receiver's copy of that store when it has one, and
// adds no minutes there (its play count and last played still count).
//
// A game only the host has (a `remote:` card on the client) has no copy here to take sessions. The client shows when
// the host last played it instead: the host's offer carries each game's last played (which counts the host's own play,
// a stream to any client and the sessions its other clients sent it) and GET /v1/library the host's clock
// (remote-library.ts lastPlayedHere). Only while the sync is on: a host with it off leaves the dates out of its offer,
// a client with it off drops them (streaming-service.ts rebuild). An offer without the host's clock is an older
// host's, which sends its dates whatever its switch says: they are not shown.
//
// A store game the host does not offer (not installed there, or not there at all) has no host id for its sessions to
// cross by. Only when it was last played crosses, by the game's library id, through the host to its other clients:
// POST /v1/playtime `recent`, recency-relay.ts.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import type { Game, PlaySession } from '../../shared/types'
import type { Logger } from '../logger'
import { readJson, renameRetry } from '../util/fs'

/** A session as sent between PCs: `game` is the host's offered id; times on the sender's clock (ISO). */
export interface WireSession {
  id: string
  game: string
  startedAt: string
  endedAt: string
  minutes: number
  /**
   * The PC store whose account play time already counts this session (accountTotalStore of the copy it was played on):
   * a copy of that store on the receiving PC reads the store's total (Game.storePlaytimeMinutes), so the session's
   * minutes are not added there again. Absent: no such store.
   */
  store?: string
}

/** A place in a PC's sessions, in recorded order: after every session recorded before `at`, or at `at` with a lower id. */
export interface SessionCursor {
  at: number
  id: string
}

/** Most sessions in one request or one answer. */
export const MAX_SESSIONS_PER_REQUEST = 500
/** Most games asked for in one request. */
export const MAX_PLAYTIME_GAMES = 10_000
/** Largest POST /v1/playtime body (the host's request cap). */
export const MAX_PLAYTIME_BODY_BYTES = 2 * 1024 * 1024
/** Most requests in one direction of one exchange (the rest goes on the next). */
export const MAX_PLAYTIME_ROUNDS = 20
/** A session dated further ahead than this (on this PC's clock) is dropped: a wrong clock must not be last played. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000
/** Clock differences below this are the request's own timing: ignored. */
const MIN_SKEW_MS = 1000
/** The PC stores that report an account-wide play time (Game.storePlaytimeMinutes: Steam, the Epic launcher, Xbox). */
const ACCOUNT_TOTAL_SOURCES = new Set(['steam', 'epic', 'xbox'])

const SESSION_ID = /^[\w-]{1,64}$/
// eslint-disable-next-line no-control-regex
const GAME_ID = /^[^\u0000-\u001f\u007f]{1,512}$/

const wireSchema = z.object({
  id: z.string().regex(SESSION_ID),
  game: z.string().regex(GAME_ID),
  startedAt: z.string().max(64),
  endedAt: z.string().max(64),
  // Any length: a session longer than its own start to end is cut to that (parseWireSessions), never dropped.
  minutes: z.number().finite().min(0),
  // Checked on its own (STORES): a store this PC does not know leaves the session without one, never drops it.
  store: z.unknown().optional()
})

/** The stores a session may name (shared/types StoreSourceId). */
const STORES = new Set(['steam', 'epic', 'gog', 'ea', 'battlenet', 'ubisoft', 'xbox'])

const cursorSchema = z.object({
  at: z.number().finite().min(0),
  id: z.string().regex(SESSION_ID)
})

/**
 * Another PC's sessions, checked: null when `raw` is not a list (or too long); otherwise the valid ones, the first of
 * each id, with their times on this PC's clock (`skewMs` = that PC's clock minus this PC's), without those that end
 * before they start or more than a day ahead; minutes are at most the session's own start to end (a game left running
 * for days is kept, its minutes as measured: never more than the time it ran).
 */
export function parseWireSessions(raw: unknown, nowMs: number, skewMs = 0): WireSession[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_SESSIONS_PER_REQUEST) return null
  const skew = Number.isFinite(skewMs) && Math.abs(skewMs) >= MIN_SKEW_MS ? skewMs : 0
  const seen = new Set<string>()
  const out: WireSession[] = []
  for (const item of raw) {
    const parsed = wireSchema.safeParse(item)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    const start = Date.parse(parsed.data.startedAt) - skew
    const end = Date.parse(parsed.data.endedAt) - skew
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    if (end > nowMs + MAX_FUTURE_MS || start < 0) continue
    seen.add(parsed.data.id)
    out.push({
      id: parsed.data.id,
      game: parsed.data.game,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      minutes: Math.min(Math.round(parsed.data.minutes), Math.ceil((end - start) / 60_000)),
      ...(typeof parsed.data.store === 'string' && STORES.has(parsed.data.store)
        ? { store: parsed.data.store }
        : {})
    })
  }
  return out
}

/** A cursor sent by another PC (or saved here), or null. */
export function parseCursor(raw: unknown): SessionCursor | null {
  const parsed = cursorSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Game ids sent by another PC: the valid ones (null when not a list, or too long). */
export function parseGameIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PLAYTIME_GAMES) return null
  return raw.filter((id): id is string => typeof id === 'string' && GAME_ID.test(id))
}

/** Where a session is in recorded order: when this PC took it from another, else when it ended; null if not ended. */
export function cursorOf(s: PlaySession): SessionCursor | null {
  if (!s.endedAt || !SESSION_ID.test(s.id)) return null
  const at = Date.parse(s.syncedAt ?? s.endedAt)
  return Number.isFinite(at) && at >= 0 ? { at, id: s.id } : null
}

/** Order of two cursors (null = before everything). */
export function compareCursors(a: SessionCursor | null, b: SessionCursor | null): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0
  if (a.at !== b.at) return a.at - b.at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The ended sessions that `include` keeps and that come after `after`, in recorded order: the first `limit`, the
 * cursor of the last one given (or `after` when none), and whether more are left.
 */
export function sessionsAfter(
  sessions: readonly PlaySession[],
  include: (s: PlaySession) => boolean,
  after: SessionCursor | null,
  limit = MAX_SESSIONS_PER_REQUEST
): { page: PlaySession[]; next: SessionCursor | null; more: boolean } {
  const picked: { s: PlaySession; c: SessionCursor }[] = []
  for (const s of sessions) {
    const c = cursorOf(s)
    if (!c || compareCursors(c, after) <= 0 || !include(s)) continue
    picked.push({ s, c })
  }
  picked.sort((a, b) => compareCursors(a.c, b.c))
  const page = picked.slice(0, limit)
  return {
    page: page.map((p) => p.s),
    next: page.length ? page[page.length - 1].c : after,
    more: picked.length > page.length
  }
}

/**
 * The store whose account play time counts a session played on `game`: its source when that store reports an
 * account-wide total (ACCOUNT_TOTAL_SOURCES, or any store whose total this PC read), else undefined.
 */
export function accountTotalStore(
  game: Pick<Game, 'source'> & { storePlaytimeMinutes?: number }
): string | undefined {
  if (game.source === 'rom' || game.source === 'manual') return undefined
  return ACCOUNT_TOTAL_SOURCES.has(game.source) || game.storePlaytimeMinutes !== undefined
    ? game.source
    : undefined
}

/**
 * A session as sent: `game` is the id the other PC knows the game by; `playedOn` this PC's copy it is a session of
 * (for its store; a session taken from another PC keeps the store it came with).
 */
export function toWire(
  s: PlaySession,
  game: string,
  playedOn?: Pick<Game, 'source'> & { storePlaytimeMinutes?: number }
): WireSession {
  const store = s.from ? s.store : playedOn && accountTotalStore(playedOn)
  return {
    id: s.id,
    game,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? s.startedAt,
    minutes: s.minutes,
    ...(store ? { store } : {})
  }
}

/**
 * Which of a PC's copies of one game takes a session played on `store`: the copy of that store when there is one
 * (its account total already counts the session, so it is not counted twice), else `fallback`.
 */
export function copyForStore<T extends { id: string; source: string }>(
  copies: readonly T[],
  store: string | undefined,
  fallback: T
): T {
  return (store && copies.find((c) => c.source === store)) || fallback
}

// --- the client's state with each host (userData/playtime-sync.json) ----------------------------------------------

/** What a client has exchanged with one host. */
export interface PlaytimeHostState {
  /** This PC's sessions sent: up to here (this PC's recorded order). */
  sent: SessionCursor | null
  /** This PC's games whose whole history was sent (a game newly matched sends all of it once). */
  sentGames: string[]
  /** The host's sessions taken: up to here (the host's recorded order; its cursor, as it gave it). */
  received: SessionCursor | null
  /** The host's games (offered ids) whose whole history was taken. */
  receivedGames: string[]
}

export interface PlaytimeSyncState {
  load(): Promise<void>
  /** The state with a host (a fresh one when none). */
  get(hostId: string): PlaytimeHostState
  set(hostId: string, state: PlaytimeHostState): void
  flush(): Promise<void>
}

const HOST_ID = /^[\w-]{1,128}$/

function emptyState(): PlaytimeHostState {
  return { sent: null, sentGames: [], received: null, receivedGames: [] }
}

function parseHostState(raw: unknown): PlaytimeHostState {
  if (!raw || typeof raw !== 'object') return emptyState()
  const r = raw as Record<string, unknown>
  return {
    sent: parseCursor(r.sent),
    sentGames: parseGameIds(r.sentGames) ?? [],
    received: parseCursor(r.received),
    receivedGames: parseGameIds(r.receivedGames) ?? []
  }
}

/** The client's cursors with each host, in `file` (written soon after each change). */
export function createPlaytimeSyncState(deps: { file: string; log: Logger }): PlaytimeSyncState {
  const hosts = new Map<string, PlaytimeHostState>()
  let writing: Promise<void> = Promise.resolve()
  let dirty = false

  function save(): void {
    dirty = true
    writing = writing
      .then(async () => {
        if (!dirty) return
        dirty = false
        await fs.mkdir(dirname(deps.file), { recursive: true })
        const tmp = `${deps.file}.${process.pid}.tmp`
        await fs.writeFile(
          tmp,
          JSON.stringify({ version: 1, hosts: Object.fromEntries(hosts) }),
          'utf8'
        )
        await renameRetry(tmp, deps.file)
      })
      .catch((err) => deps.log.warn(`saving the play time sync's state: ${String(err)}`))
  }

  return {
    async load() {
      const saved = await readJson<{ hosts?: unknown }>(deps.file).catch(() => null)
      hosts.clear()
      const raw = saved?.hosts
      if (raw && typeof raw === 'object')
        for (const [id, state] of Object.entries(raw as Record<string, unknown>))
          if (HOST_ID.test(id)) hosts.set(id, parseHostState(state))
    },
    get: (hostId) => {
      const s = hosts.get(hostId)
      return s
        ? { ...s, sentGames: [...s.sentGames], receivedGames: [...s.receivedGames] }
        : emptyState()
    },
    set(hostId, state) {
      if (!HOST_ID.test(hostId)) return
      hosts.set(hostId, state)
      save()
    },
    flush: () => writing
  }
}
