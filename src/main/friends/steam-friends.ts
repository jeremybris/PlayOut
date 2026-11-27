// The overlay's Friends tab (docs/home-overlay.md, "Friends"): the user's Steam friends and what they are playing,
// from the Steam Web API with the key and SteamID64 of Settings › Metadata (settings.scrapers.steam). No sign-in of
// any kind: ISteamUser/GetFriendList lists the friends (the list must be public: Steam answers 401 otherwise), then
// ISteamUser/GetPlayerSummaries (100 ids per call) gives each one's name, picture, status and game.
//
// Read only while the Friends tab is open (the overlay asks on open and every 60 s while it stays open); an answer is
// kept for 30 s so switching tabs is instant. Nothing here polls. The key is never logged: errors are logged by their
// HTTP status only, and every URL that reaches an error message is masked by scrapers/http.ts.
//
// "Message" opens Steam's own chat with that friend (steam://friends/message/<id>), after closing the overlay.
import {
  friendsErrorText,
  STEAM_ID64,
  steamChatUri,
  type FriendPresence,
  type FriendsErrorCode,
  type SteamFriend,
  type SteamFriendsStatus
} from '../../shared/friends'
import type { Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { buildUrl, HttpError, httpJson, type HttpOptions } from '../scrapers/http'
import { WEB_API, webApiLimiter } from '../scrapers/steam-store'
import { tMain } from '../i18n'

/** Steam ids per GetPlayerSummaries call (Steam's own limit). */
export const SUMMARY_BATCH = 100
/** How long an answer is served again without asking Steam (ms). */
export const FRIENDS_CACHE_MS = 30_000
const REQUEST: HttpOptions = { timeoutMs: 15_000, retries: 1, limiter: webApiLimiter }

/**
 * Hosts Steam serves avatars from; any other picture URL (or plain http) is dropped. Of Akamai's
 * shared akamaihd.net only Steam's own legacy host counts, not any Akamai customer's.
 */
const AVATAR_HOSTS =
  /^(?:(?:.+\.)?(?:steamstatic\.com|steamcommunity\.com|steampowered\.com)|steamcdn-a\.akamaihd\.net)$/i

/** Steam's personastate: 0 Offline, 1 Online, 2 Busy, 3 Away, 4 Snooze, 5 Looking to trade, 6 Looking to play. */
const PRESENCES: readonly FriendPresence[] = [
  'offline',
  'online',
  'busy',
  'away',
  'snooze',
  'trade',
  'play'
]

/** The API key and SteamID64 from Settings › Metadata, when both are set. */
export interface SteamKey {
  key: string
  steamId64: string
}

export function steamKeyOf(settings: Settings): SteamKey | null {
  const steam = settings.scrapers?.steam
  const key = steam?.apiKey?.trim() ?? ''
  const steamId64 = steam?.steamId64?.trim() ?? ''
  if (!key || !STEAM_ID64.test(steamId64)) return null
  return { key, steamId64 }
}

/** Steam's personastate as a word; an unknown or missing value counts as offline. */
export function presenceOf(state: unknown): FriendPresence {
  const n = typeof state === 'number' ? state : Number(state)
  return Number.isInteger(n) && n >= 0 && n < PRESENCES.length ? PRESENCES[n]! : 'offline'
}

/** An avatar URL only when it is https on Steam's CDN. */
export function safeAvatar(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && AVATAR_HOSTS.test(u.hostname) ? u.toString() : undefined
  } catch {
    return undefined
  }
}

interface FriendListResponse {
  friendslist?: { friends?: { steamid?: unknown; relationship?: unknown }[] }
}

/** The friends' SteamID64s from GetFriendList's answer (each once, friends only). */
export function parseFriendList(body: unknown): string[] {
  const rows = (body as FriendListResponse | null)?.friendslist?.friends
  if (!Array.isArray(rows)) return []
  const out = new Set<string>()
  for (const row of rows) {
    const id = typeof row?.steamid === 'string' ? row.steamid.trim() : String(row?.steamid ?? '')
    if (!STEAM_ID64.test(id)) continue
    if (row.relationship !== undefined && row.relationship !== 'friend') continue
    out.add(id)
  }
  return [...out]
}

interface PlayerSummary {
  steamid?: unknown
  personaname?: unknown
  avatarmedium?: unknown
  avatarfull?: unknown
  avatar?: unknown
  personastate?: unknown
  gameextrainfo?: unknown
  gameid?: unknown
  lastlogoff?: unknown
}

interface SummariesResponse {
  response?: { players?: PlayerSummary[] }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The friends GetPlayerSummaries describes. A game counts only while the friend is online. */
export function parsePlayerSummaries(body: unknown): SteamFriend[] {
  const rows = (body as SummariesResponse | null)?.response?.players
  if (!Array.isArray(rows)) return []
  const out: SteamFriend[] = []
  for (const row of rows) {
    const steamId = text(row?.steamid)
    if (!STEAM_ID64.test(steamId)) continue
    const presence = presenceOf(row.personastate)
    const friend: SteamFriend = { steamId, name: text(row.personaname) || steamId, presence }
    const avatarUrl =
      safeAvatar(row.avatarmedium) ?? safeAvatar(row.avatarfull) ?? safeAvatar(row.avatar)
    if (avatarUrl) friend.avatarUrl = avatarUrl
    const gameId = text(row.gameid) || (typeof row.gameid === 'number' ? String(row.gameid) : '')
    const game = text(row.gameextrainfo)
    if (presence !== 'offline' && (game || gameId)) {
      friend.game = game || tMain('mainApp.friends.inGame')
      if (gameId) friend.gameId = gameId
    }
    const logoff = Number(row.lastlogoff)
    if (Number.isFinite(logoff) && logoff > 0) friend.lastOnlineAt = logoff * 1000
    out.push(friend)
  }
  return out
}

/** Reads one Steam Web API URL as JSON (rate-limited; injectable for tests). */
export type GetJson = (url: string) => Promise<unknown>

const defaultGetJson: GetJson = (url) => httpJson<unknown>(url, {}, REQUEST)

/** Every friend with their summary, SUMMARY_BATCH ids per GetPlayerSummaries call. Throws what the HTTP layer throws. */
export async function fetchSteamFriends(
  credential: SteamKey,
  getJson: GetJson = defaultGetJson
): Promise<SteamFriend[]> {
  const ids = parseFriendList(
    await getJson(
      buildUrl(`${WEB_API}/ISteamUser/GetFriendList/v1/`, {
        key: credential.key,
        steamid: credential.steamId64,
        relationship: 'friend'
      })
    )
  )
  const friends: SteamFriend[] = []
  for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
    const batch = ids.slice(i, i + SUMMARY_BATCH)
    const body = await getJson(
      buildUrl(`${WEB_API}/ISteamUser/GetPlayerSummaries/v2/`, {
        key: credential.key,
        steamids: batch.join(',')
      })
    )
    friends.push(...parsePlayerSummaries(body))
  }
  return friends
}

/** What went wrong, as one of the tab's messages: 401 is a private list, 403 a refused key, anything else the network. */
export function friendsErrorCode(err: unknown): FriendsErrorCode {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'private'
    if (err.status === 403) return 'key-refused'
  }
  return 'network'
}

/** Only the status or the error's kind: never a message or URL that could carry the key. */
function describeFailure(err: unknown): string {
  if (err instanceof HttpError) return err.status ? `HTTP ${err.status}` : 'no answer'
  return err instanceof Error ? err.name : 'unknown error'
}

export interface FriendsServiceDeps {
  settings: () => Settings
  log: Logger
  /** Close the overlay before Steam's window opens (OverlaySuite.closeForOutsideWindow). */
  closeOverlay: () => Promise<void>
  /** shell.openExternal. */
  openExternal: (uri: string) => Promise<void>
  getJson?: GetJson
  now?: () => number
}

export interface FriendsService {
  /** The friends list: the cached answer when it is under FRIENDS_CACHE_MS old, unless `refresh`. Never rejects. */
  list(options?: { refresh?: boolean }): Promise<SteamFriendsStatus>
  /** Open Steam's chat with one friend (a SteamID64 only), after closing the overlay. */
  message(steamId: string): Promise<void>
}

export function createFriendsService(deps: FriendsServiceDeps): FriendsService {
  const now = deps.now ?? Date.now
  const getJson = deps.getJson ?? defaultGetJson
  /**
   * The last answer, the credential it was read with and when it was read (kept in memory only).
   * `at` is the cache's own time: an answer kept from an earlier read under a network error carries
   * that read's older fetchedAt, which would otherwise make the cache never apply while Steam is down.
   */
  let cache: { credential: string; status: SteamFriendsStatus; at: number } | null = null
  /** The last answer that listed friends: shown again under an error, so a failed refresh keeps the list. */
  let lastGood: { credential: string; status: SteamFriendsStatus } | null = null
  let pending: { credential: string; promise: Promise<SteamFriendsStatus> } | null = null

  async function read(credential: SteamKey, id: string): Promise<SteamFriendsStatus> {
    try {
      const friends = await fetchSteamFriends(credential, getJson)
      const status: SteamFriendsStatus = { friends, fetchedAt: now() }
      lastGood = { credential: id, status }
      return status
    } catch (err) {
      const code = friendsErrorCode(err)
      deps.log.warn(`friends: Steam friends list not read (${describeFailure(err)})`)
      const error = { code, message: friendsErrorText(code, tMain) }
      // A network hiccup keeps the friends already shown; a private list or a refused key does not.
      if (code === 'network' && lastGood?.credential === id) return { ...lastGood.status, error }
      return { friends: [], fetchedAt: now(), error }
    }
  }

  return {
    async list(options = {}) {
      const credential = steamKeyOf(deps.settings())
      if (!credential) {
        cache = null
        lastGood = null
        return {
          friends: [],
          fetchedAt: now(),
          error: { code: 'no-credentials', message: friendsErrorText('no-credentials', tMain) }
        }
      }
      const id = `${credential.steamId64}\n${credential.key}`
      if (!options.refresh && cache?.credential === id && now() - cache.at < FRIENDS_CACHE_MS) {
        return cache.status
      }
      // One request at a time: a poll landing during a Refresh shares its answer.
      if (pending?.credential === id) return pending.promise
      const promise = read(credential, id)
      pending = { credential: id, promise }
      try {
        const status = await promise
        cache = { credential: id, status, at: now() }
        return status
      } finally {
        if (pending?.promise === promise) pending = null
      }
    },

    async message(steamId) {
      if (typeof steamId !== 'string' || !STEAM_ID64.test(steamId)) {
        throw new Error('Not a SteamID64')
      }
      const uri = steamChatUri(steamId)
      // Over a game the overlay would cover Steam's window (and a paused game would stay paused): close it first.
      await deps
        .closeOverlay()
        .catch((err) => deps.log.warn('friends: closing the overlay failed', err))
      await deps.openExternal(uri)
    }
  }
}
