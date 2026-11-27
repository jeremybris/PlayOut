// The favourites kept the same on paired PCs (Settings › Streaming › "Sync favourites with the host / clients"), game
// by game: each PC stamps a game's favourite with the time the user last turned it on or off there (Game.favoriteAt;
// imports, scans and changes taken from another PC never stamp), and the newest change wins.
//
// The library goes host to client only, so the client does the matching: a host game is "the same" as this PC's games
// that buildRemoteLibrary folds it into (remote-library.ts localMatches: exactly the Library's matches). Several
// copies on either side (Steam and GOG) form one group whose favourite is "any copy is a favourite", changed when the
// newest favourite copy was (when none is: the newest change of any copy). A client sends the groups whose favourite differs from the host's offer (POST
// /v1/favorites, ids are the host's offered ids) with its clock; the host takes each that is newer and answers with
// every favourite (or changed) game it offers; the client then takes, group by group, the host's when it is newer.
// The host keeps what it took, so a change made on one client reaches the host and then every other client.
//
// A game never changed since the sync came (no time) loses to any changed one; between two such copies a favourite
// wins, so the favourites PCs already had are kept on both.

import { z } from 'zod'
import type { Game } from '../../shared/types'
import type { HostGame } from './remote-library'

/** One game's favourite, as sent between PCs: the host's offered id, and when it last changed (0 = never). */
export interface FavoriteEntry {
  id: string
  favorite: boolean
  /** Milliseconds; on the clock of the PC that holds the entry (parseFavoriteEntries corrects another PC's). */
  at: number
}

export type FavoriteState = Pick<FavoriteEntry, 'favorite' | 'at'>

/** Most entries taken or sent in one exchange. */
export const MAX_FAVORITE_ENTRIES = 10_000
/** Largest POST /v1/favorites body (the host's request cap). */
export const MAX_FAVORITES_BODY_BYTES = 2 * 1024 * 1024
/** Times before this are "never changed": not clock-corrected. */
const CHANGED_AFTER_MS = Date.UTC(2000, 0, 1)
/** An entry dated further ahead than this (on this PC's clock) is dropped: a wrong clock must not win forever. */
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000
/**
 * Clock differences below this are the request's own timing, not the clocks: ignored, so the times of PCs whose clocks
 * agree go back and forth unchanged.
 */
const MIN_SKEW_MS = 1000

const entrySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(512)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  favorite: z.boolean(),
  at: z.number().finite().min(0)
})

/** A game's favourite time in milliseconds (0: never changed, or unreadable). */
export function favoriteAtMs(game: { favoriteAt?: string }): number {
  const t = game.favoriteAt ? Date.parse(game.favoriteAt) : NaN
  return Number.isFinite(t) && t >= CHANGED_AFTER_MS ? t : 0
}

/**
 * Another PC's entries, checked: null when `raw` is not a list (or too long); otherwise the entries that are valid,
 * the first of each id, on this PC's clock (`skewMs` = that PC's clock minus this PC's), without those dated more
 * than a day ahead.
 */
export function parseFavoriteEntries(
  raw: unknown,
  nowMs: number,
  skewMs = 0
): FavoriteEntry[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_FAVORITE_ENTRIES) return null
  const skew = Number.isFinite(skewMs) && Math.abs(skewMs) >= MIN_SKEW_MS ? skewMs : 0
  const seen = new Set<string>()
  const out: FavoriteEntry[] = []
  for (const item of raw) {
    const parsed = entrySchema.safeParse(item)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    const { id, favorite, at } = parsed.data
    const local = at < CHANGED_AFTER_MS ? 0 : Math.round(at - skew)
    if (local > nowMs + MAX_FUTURE_MS) continue
    out.push({ id, favorite, at: Math.max(0, local) })
  }
  return out
}

/**
 * Several copies of one game as one favourite: any copy is a favourite. Changed when the newest favourite copy was, when
 * one is (another copy turned off later must not date a favourite still kept), else when the newest copy changed.
 */
export function combinedFavorite(
  copies: { favorite: boolean; favoriteAt?: string }[]
): FavoriteState {
  return combinedStates(copies.map((c) => ({ favorite: c.favorite, at: favoriteAtMs(c) })))
}

/** combinedFavorite of states already in milliseconds (another PC's entries). */
export function combinedStates(states: FavoriteState[]): FavoriteState {
  let favorite = false
  let favoriteAt = 0
  let anyAt = 0
  for (const s of states) {
    if (s.favorite) {
      favorite = true
      if (s.at > favoriteAt) favoriteAt = s.at
    }
    if (s.at > anyAt) anyAt = s.at
  }
  return { favorite, at: favorite ? favoriteAt : anyAt }
}

/**
 * Which favourite wins for one game: 'same' when both agree; else the newer change; a change beats a favourite never
 * changed; between two never changed, the favourite; an exact tie goes to the host (`theirsIsHost`).
 */
export function pickFavorite(
  mine: FavoriteState,
  theirs: FavoriteState,
  theirsIsHost: boolean
): 'mine' | 'theirs' | 'same' {
  if (mine.favorite === theirs.favorite) return 'same'
  if (theirs.at !== mine.at) return theirs.at > mine.at ? 'theirs' : 'mine'
  if (theirs.at === 0) return theirs.favorite ? 'theirs' : 'mine'
  return theirsIsHost ? 'theirs' : 'mine'
}

/** One game on both PCs: this PC's copies and the host's (offered) copies of it. */
export interface FavoriteGroup {
  local: Game[]
  host: HostGame[]
}

/**
 * The games a host and this PC both have, as groups (copies linked by a match on either side are one group), from
 * `matches` (remote-library.ts localMatches: the host's game id -> this PC's games).
 */
export function favoriteGroups(
  hostGames: HostGame[],
  matches: Map<string, Game[]>
): FavoriteGroup[] {
  // Union-find over "h:<host id>" and "l:<local id>".
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let node = x
    while (node !== root) {
      const next = parent.get(node)!
      parent.set(node, root)
      node = next
    }
    return root
  }
  const add = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x)
  }
  const byHost = new Map<string, HostGame>()
  const byLocal = new Map<string, Game>()
  for (const h of hostGames) {
    const locals = matches.get(h.id)
    if (!locals?.length || byHost.has(h.id)) continue
    byHost.set(h.id, h)
    add(`h:${h.id}`)
    for (const l of locals) {
      byLocal.set(l.id, l)
      add(`l:${l.id}`)
      const a = find(`h:${h.id}`)
      const b = find(`l:${l.id}`)
      if (a !== b) parent.set(a, b)
    }
  }
  const groups = new Map<string, FavoriteGroup>()
  const groupOf = (key: string): FavoriteGroup => {
    const root = find(key)
    let g = groups.get(root)
    if (!g) groups.set(root, (g = { local: [], host: [] }))
    return g
  }
  for (const [id, h] of byHost) groupOf(`h:${id}`).host.push(h)
  for (const [id, l] of byLocal) groupOf(`l:${id}`).local.push(l)
  return [...groups.values()]
}

/**
 * What a client proposes to its host for one group whose favourite differs from the host's (offered) one: turned on,
 * on one host copy (a favourite is one copy: the first); turned off, on every host copy that is a favourite. The host
 * decides with the times (pickFavorite), so a proposal that is older does nothing.
 */
export function proposals(group: FavoriteGroup): FavoriteEntry[] {
  const mine = combinedFavorite(group.local)
  const theirs = combinedFavorite(group.host)
  if (mine.favorite === theirs.favorite || !group.host.length) return []
  // Not a favourite and never changed here: it cannot win anywhere (pickFavorite), so nothing to say.
  if (!mine.favorite && mine.at === 0) return []
  if (mine.favorite) return [{ id: group.host[0].id, favorite: true, at: mine.at }]
  return group.host
    .filter((h) => h.favorite)
    .map((h) => ({ id: h.id, favorite: false, at: mine.at }))
}

/**
 * How this PC's copies of a game take another PC's favourite: turned on, on one copy (the preferred copy, else an
 * installed one, else the first) unless one already is; turned off, on every copy that is one. Returns the copies to
 * change (their id and new favourite).
 */
export function copiesToChange(
  local: Game[],
  favorite: boolean
): { id: string; favorite: boolean }[] {
  if (favorite) {
    if (local.some((g) => g.favorite) || !local.length) return []
    const pick =
      local.find((g) => g.user?.preferredCopy) ?? local.find((g) => g.installed) ?? local[0]
    return [{ id: pick.id, favorite: true }]
  }
  return local.filter((g) => g.favorite).map((g) => ({ id: g.id, favorite: false }))
}
