// When a store game the host does not offer was last played on a paired PC (part of the play time sync,
// playtime-sync.ts, and under its switch). Play sessions cross by the host's offered game id, so the play of a game
// the host has not installed (or does not have at all) had no way from one client to another: client B plays its GOG
// game, client A owns it (not installed) and the host has no copy. For those games only the date crosses, by the
// game's library id (`gog:1207658924`: a store game's id is its store and the store's own id, the same on every PC):
//  - a client sends, with POST /v1/playtime, `recent`: the last played of its store games the host's offer does not
//    match (never a hidden one), the most recent MAX_RECENCY_ENTRIES; and `want`: the ids of those games (played or
//    not), the only ones it is told about;
//  - the host keeps the latest date of each game with the PC it came from (this relay, userData/recency-relay.json)
//    and answers `recent`, for the games the caller named only: the dates the other PCs sent, and its own for the
//    store games it has a record of but does not offer. What a PC sends is its whole list: a date it sent before and
//    no longer lists (the game was hidden or removed there) leaves the table, as all of a PC's do when it is unpaired;
//  - the client raises the last played of its own records of those games. Nothing else: no play time, no play count,
//    and never a new card (a game only another client has stays unknown here).
// A date is a "latest wins" value, and "later" means later by more than RECENCY_TOLERANCE_MS: a date that went to
// another PC and comes back was put on two clocks on the way (each estimate off by the request's own timing), so it
// may return a little later than it left. Within the tolerance it is the same play, so sending a date again, or back,
// changes nothing. Dates are put on the receiver's clock and never land ahead of it (parseRecency).

import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { Game } from '../../shared/types'
import type { Logger } from '../logger'
import { readJson, renameRetry } from '../util/fs'

/** A store game's last play on some paired PC: `game` is its library id, `at` the time (ms). */
export interface RecencyEntry {
  game: string
  at: number
}

/** Most dates in one request or answer, and most the host keeps (the most recent ones). */
export const MAX_RECENCY_ENTRIES = 500
/** Most game ids a PC may ask about in one request (`want`). */
export const MAX_RECENCY_WANTED = 10_000
/**
 * Two dates of a game no further apart than this are the same play: a date relayed through two clock corrections
 * comes back a little off, and must not count as a later play (it would go round between the PCs for ever).
 */
export const RECENCY_TOLERANCE_MS = 60_000
/** A date further ahead than this (on this PC's clock) is dropped: a wrong clock, not a play. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000
/** Clock differences below this are the request's own timing: ignored (as the play time sync does). */
const MIN_SKEW_MS = 1000

/** The stores whose games have the same library id on every PC (shared/types StoreSourceId). */
const STORES = new Set(['steam', 'epic', 'gog', 'ea', 'battlenet', 'ubisoft', 'xbox'])
// eslint-disable-next-line no-control-regex
const STORE_GAME_ID = /^([a-z]+):[^\u0000-\u001f\u007f]{1,200}$/
const PC_ID = /^[\w-]{1,128}$/

/** Whether `id` is a store game's library id (the only games whose date is relayed). */
export function isStoreGameId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  const match = STORE_GAME_ID.exec(id)
  return match !== null && STORES.has(match[1])
}

/** When `game` was last played (ms), 0 when never (or no valid date). */
export function playedAt(game: Pick<Game, 'lastPlayed'>): number {
  const at = game.lastPlayed ? Date.parse(game.lastPlayed) : Number.NaN
  return Number.isFinite(at) && at > 0 ? at : 0
}

/** Whether the date `at` is a later play than the one `kept` (0: none kept): later by more than the tolerance. */
export function isLaterPlay(at: number, kept: number): boolean {
  return kept > 0 ? at > kept + RECENCY_TOLERANCE_MS : at > 0
}

/**
 * The game ids another PC asks about (`want`), checked: the store game ids among them. Empty when `raw` is not a
 * list, or one too long.
 */
export function parseWanted(raw: unknown): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(raw) || raw.length > MAX_RECENCY_WANTED) return out
  for (const id of raw) if (isStoreGameId(id)) out.add(id)
  return out
}

/** The most recent `limit` of `entries`, latest first (one per game: its latest). */
export function latestRecency(
  entries: readonly RecencyEntry[],
  limit = MAX_RECENCY_ENTRIES
): RecencyEntry[] {
  const latest = new Map<string, number>()
  for (const e of entries) if (e.at > (latest.get(e.game) ?? 0)) latest.set(e.game, e.at)
  return [...latest]
    .map(([game, at]) => ({ game, at }))
    .sort((a, b) => b.at - a.at || (a.game < b.game ? -1 : 1))
    .slice(0, limit)
}

/**
 * This PC's dates to send: the last played of its store games that `relayed` keeps (those the other PC cannot take
 * sessions of), never a hidden game's (the owner hid it here). The most recent MAX_RECENCY_ENTRIES.
 */
export function ownRecency(
  games: readonly Pick<Game, 'id' | 'source' | 'hidden' | 'lastPlayed'>[],
  relayed: (game: Pick<Game, 'id'>) => boolean
): RecencyEntry[] {
  const out: RecencyEntry[] = []
  for (const g of games) {
    if (g.hidden || !STORES.has(g.source) || !isStoreGameId(g.id) || !relayed(g)) continue
    const at = playedAt(g)
    if (at) out.push({ game: g.id, at })
  }
  return latestRecency(out)
}

/**
 * Another PC's dates, checked: null when `raw` is not a list (or too long); otherwise the valid ones (a store game's
 * id, a time), the latest of each game, on this PC's clock (`skewMs` = that PC's clock minus this PC's). One more than
 * a day ahead of `nowMs` is dropped; one less far ahead is taken as now, so another PC's clock never outranks a play
 * made here.
 */
export function parseRecency(raw: unknown, nowMs: number, skewMs = 0): RecencyEntry[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RECENCY_ENTRIES) return null
  const skew = Number.isFinite(skewMs) && Math.abs(skewMs) >= MIN_SKEW_MS ? skewMs : 0
  const out: RecencyEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { game, at } = item as { game?: unknown; at?: unknown }
    if (!isStoreGameId(game) || typeof at !== 'number' || !Number.isFinite(at)) continue
    const here = Math.round(at - skew)
    if (here <= 0 || here > nowMs + MAX_FUTURE_MS) continue
    out.push({ game, at: Math.min(here, nowMs) })
  }
  return latestRecency(out)
}

/** The host's table: the latest date of each game its clients sent, and who sent it. */
export interface RecencyRelay {
  load(): Promise<void>
  /**
   * The dates a client sent (already checked, on this PC's clock), its whole list: each one a later play than the
   * one kept (isLaterPlay) replaces it, and a date kept from this client that it no longer lists is dropped. Returns
   * how many entries changed.
   */
  take(entries: readonly RecencyEntry[], from: string): number
  /** The dates the other PCs sent of the games `wanted`: not those `client` sent itself. */
  entriesFor(client: string, wanted: ReadonlySet<string>): RecencyEntry[]
  /** Drop every date `client` sent (it is no longer paired). Returns how many. */
  forget(client: string): number
  flush(): Promise<void>
}

/** The relay table, kept in `file` when given (written soon after each change), else in memory only. */
export function createRecencyRelay(deps: { file?: string; log: Logger }): RecencyRelay {
  const table = new Map<string, { at: number; from: string }>()
  let writing: Promise<void> = Promise.resolve()
  let dirty = false

  /** Only the most recent MAX_RECENCY_ENTRIES are kept: the table never grows with every game ever played. */
  function trim(): void {
    if (table.size <= MAX_RECENCY_ENTRIES) return
    const oldest = [...table].sort((a, b) => a[1].at - b[1].at)
    for (const [game] of oldest.slice(0, table.size - MAX_RECENCY_ENTRIES)) table.delete(game)
  }

  function save(): void {
    const file = deps.file
    if (!file) return
    dirty = true
    writing = writing
      .then(async () => {
        if (!dirty) return
        dirty = false
        await fs.mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await fs.writeFile(
          tmp,
          JSON.stringify({ version: 1, games: Object.fromEntries(table) }),
          'utf8'
        )
        await renameRetry(tmp, file)
      })
      .catch((err) => deps.log.warn(`saving the last played relay: ${String(err)}`))
  }

  return {
    async load() {
      if (!deps.file) return
      const saved = await readJson<{ games?: unknown }>(deps.file).catch(() => null)
      const raw = saved?.games
      if (!raw || typeof raw !== 'object') return
      for (const [game, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!isStoreGameId(game) || !value || typeof value !== 'object') continue
        const { at, from } = value as { at?: unknown; from?: unknown }
        if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
        if (typeof from !== 'string' || !PC_ID.test(from)) continue
        // A date taken while this was loading stays when it is the later one.
        if (at > (table.get(game)?.at ?? 0)) table.set(game, { at, from })
      }
      trim()
    },
    take(entries, from) {
      if (!PC_ID.test(from)) return 0
      let changed = 0
      const listed = new Set<string>()
      for (const e of entries) {
        listed.add(e.game)
        if (!isLaterPlay(e.at, table.get(e.game)?.at ?? 0)) continue
        table.set(e.game, { at: e.at, from })
        changed++
      }
      // No longer on its list (hidden or removed there, or offered by this PC now): not this PC's to pass on.
      for (const [game, kept] of table) {
        if (kept.from !== from || listed.has(game)) continue
        table.delete(game)
        changed++
      }
      if (changed) {
        trim()
        save()
      }
      return changed
    },
    entriesFor: (client, wanted) =>
      latestRecency(
        [...table]
          .filter(([game, v]) => v.from !== client && wanted.has(game))
          .map(([game, v]) => ({ game, at: v.at }))
      ),
    forget(client) {
      let dropped = 0
      for (const [game, kept] of table) {
        if (kept.from !== client) continue
        table.delete(game)
        dropped++
      }
      if (dropped) save()
      return dropped
    },
    flush: () => writing
  }
}
