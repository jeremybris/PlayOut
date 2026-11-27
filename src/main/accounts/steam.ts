// Steam account: web sign-in (store cookie session + the `webapi_token` the store page embeds for its own JS) and the
// API key + SteamID64 path from Settings > Metadata (docs/research/store-accounts.md §1). Owned games come from
// IPlayerService/GetOwnedGames; art from the public CDN.
import { join } from 'path'
import type { ClientInfo, Game, OwnedGame, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { nonGameReason, parseLoginUsers } from '../providers/steam'
import { buildUrl } from '../scrapers/http'
import { readTextIfExists } from '../util/fs'
import { apiJson } from './api'
import {
  describeError,
  StoreUnavailableError,
  type AccountContext,
  type AccountTokens,
  type AuthWindow,
  type StoreAccount
} from './types'
import { tMain } from '../i18n'

export const STEAM_API = 'https://api.steampowered.com'
export const STEAM_EXPLORE_URL = 'https://store.steampowered.com/explore/'
export const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps'
/** The store's own per-user data (owned apps, wishlist) for its signed-in pages; read with the store's cookies. */
export const STEAM_USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/'

/**
 * The app ids the signed-in account owns (games and DLC) from the store's `dynamicstore/userdata` answer. Null when
 * the answer lists none: a signed-out session answers with empty lists, which says nothing about what is owned.
 */
export function parseOwnedApps(data: unknown): Set<number> | null {
  const raw =
    data && typeof data === 'object' ? (data as { rgOwnedApps?: unknown }).rgOwnedApps : undefined
  if (!Array.isArray(raw)) return null
  const owned = new Set<number>()
  for (const id of raw) {
    const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : Number.NaN
    if (Number.isInteger(n) && n > 0) owned.add(n)
  }
  return owned.size > 0 ? owned : null
}
const STEAM_ICON_CDN = 'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps'
/** How long the optional "date added" answer may take (the owned list itself has already arrived). */
const ACQUIRED_TIMEOUT_MS = 8_000
/** Steam's first year; `rtime_last_played` values before it are placeholders. */
const MIN_LAST_PLAYED = Date.UTC(2004, 0, 1) / 1000

/** Reads the store page's `application_config` element the way Playnite's SteamStoreService does. */
export const APPLICATION_CONFIG_SCRIPT =
  '(() => { const e = document.getElementById("application_config"); return e ? { u: e.dataset.userinfo || "", c: e.dataset.store_user_config || "" } : null })()'

export interface SteamWebTokens extends AccountTokens {
  kind: 'web'
  steamId64: string
  accountName: string
  webapiToken: string
  capturedAt: string
}

export interface SteamKeyTokens extends AccountTokens {
  kind: 'apikey'
  steamId64: string
  apiKey: string
}

export type SteamTokens = SteamWebTokens | SteamKeyTokens

export interface SteamOwnedApp {
  appid: number
  name?: string
  /** Minutes. */
  playtime_forever?: number
  playtime_disconnected?: number
  /** Unix seconds; 0 when never played. */
  rtime_last_played?: number
  img_icon_url?: string
}

export interface SteamOwnedResponse {
  response?: { game_count?: number; games?: SteamOwnedApp[] }
}

/** IFamilyGroupsService/GetSharedLibraryApps: the one Web API answer with the time an app joined a library. */
export interface SteamSharedLibraryResponse {
  response?: {
    /** The account the answer is for (uint64 as a string). */
    owner_steamid?: string | number
    apps?: {
      appid?: number
      owner_steamids?: (string | number)[]
      /** Unix seconds: what the Steam client sorts by under "Date Added to Library". */
      rt_time_acquired?: number
    }[]
  }
}

interface PlayerSummariesResponse {
  response?: { players?: { steamid?: string; personaname?: string }[] }
}

/** The two data attributes of `<div id="application_config">`, as the capture script returns them. */
export interface ApplicationConfig {
  u: string
  c: string
}

export interface SteamWebIdentity {
  steamId64: string
  accountName: string
  webapiToken: string
}

/** Parse `data-userinfo` / `data-store_user_config`; null until the page shows a logged-in user with a token. */
export function parseApplicationConfig(
  raw: ApplicationConfig | null | undefined
): SteamWebIdentity | null {
  if (!raw) return null
  let user: { logged_in?: boolean; steamid?: string | number; account_name?: string } = {}
  let config: { webapi_token?: string } = {}
  try {
    if (raw.u) user = JSON.parse(raw.u)
    if (raw.c) config = JSON.parse(raw.c)
  } catch {
    return null
  }
  const token = typeof config.webapi_token === 'string' ? config.webapi_token.trim() : ''
  const steamId64 = user.steamid === undefined ? '' : String(user.steamid).trim()
  if (!user.logged_in || !token || !/^\d{17}$/.test(steamId64)) return null
  return {
    steamId64,
    accountName: typeof user.account_name === 'string' ? user.account_name.trim() : '',
    webapiToken: token
  }
}

export function steamCoverUrl(appId: number): string {
  return `${STEAM_CDN}/${appId}/library_600x900_2x.jpg`
}

function unixToIso(seconds: number | undefined): string | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds < MIN_LAST_PLAYED) return undefined
  return new Date(seconds * 1000).toISOString()
}

/** GetOwnedGames -> OwnedGame[]: tools and redistributables dropped with the provider's rules, blank names dropped. */
export function mapSteamOwned(data: SteamOwnedResponse): OwnedGame[] {
  const out: OwnedGame[] = []
  const seen = new Set<number>()
  for (const app of data.response?.games ?? []) {
    const appId = Number(app?.appid)
    if (!Number.isInteger(appId) || appId <= 0 || seen.has(appId)) continue
    seen.add(appId)
    const name = (app.name ?? '').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim()
    if (!name) continue
    if (nonGameReason({ appId, name, installDir: '' })) continue
    const minutes = Math.max(
      0,
      Math.round((app.playtime_forever ?? 0) + (app.playtime_disconnected ?? 0))
    )
    const game: OwnedGame = {
      externalId: String(appId),
      title: name,
      coverUrl: steamCoverUrl(appId),
      heroUrl: `${STEAM_CDN}/${appId}/library_hero.jpg`,
      logoUrl: `${STEAM_CDN}/${appId}/logo.png`,
      storePlaytimeMinutes: minutes > 0 ? minutes : undefined,
      lastPlayedAt: unixToIso(app.rtime_last_played),
      extra: { steamAppId: appId }
    }
    if (app.img_icon_url) game.iconUrl = `${STEAM_ICON_CDN}/${appId}/${app.img_icon_url}.jpg`
    out.push(game)
  }
  return out
}

/** The API-key credential from Settings > Metadata, when both values are set. */
export function steamKeyTokens(settings: Settings): SteamKeyTokens | null {
  const { apiKey, steamId64 } = settings.scrapers.steam
  if (!apiKey.trim() || !/^\d{17}$/.test(steamId64.trim())) return null
  return { kind: 'apikey', steamId64: steamId64.trim(), apiKey: apiKey.trim() }
}

function credentialParams(tokens: SteamTokens): Record<string, string> {
  return tokens.kind === 'web' ? { access_token: tokens.webapiToken } : { key: tokens.apiKey }
}

export function ownedGamesUrl(tokens: SteamTokens): string {
  return buildUrl(`${STEAM_API}/IPlayerService/GetOwnedGames/v1/`, {
    ...credentialParams(tokens),
    steamid: tokens.steamId64,
    format: 'json',
    include_appinfo: 'true',
    include_played_free_games: 'true',
    include_free_sub: 'false',
    language: 'english'
  })
}

/**
 * The account's own library with the time each app joined it. Asked the way SteamDB's browser extension asks for
 * every user: family group 0 (Steam ignores the id for the account's own apps, in a Steam Family or not), and every
 * kind of app (`include_excluded`: games whose publisher opted out of family sharing; `include_non_games`, `include_free`),
 * so no owned game is left without its date. GET only; an API key is refused.
 */
export function sharedLibraryUrl(tokens: SteamWebTokens): string {
  return buildUrl(`${STEAM_API}/IFamilyGroupsService/GetSharedLibraryApps/v1/`, {
    access_token: tokens.webapiToken,
    family_groupid: '0',
    include_own: 'true',
    include_excluded: 'true',
    include_free: 'true',
    include_non_games: 'true',
    format: 'json'
  })
}

/**
 * App id -> when this account got it (ISO), from GetSharedLibraryApps. Only apps this account owns itself count (an
 * app lent by a family member carries that member's date); an app without owners listed is taken as the account's.
 * For an app the account and a family member both own, Steam does not say whose date it gives.
 */
export function parseAcquiredTimes(
  data: SteamSharedLibraryResponse,
  steamId64: string
): Map<number, string> {
  const out = new Map<number, string>()
  const apps = data?.response?.apps
  if (!Array.isArray(apps)) return out
  const answeredFor = data.response?.owner_steamid
  const me =
    typeof answeredFor === 'string' && /^\d{17}$/.test(answeredFor) ? answeredFor : steamId64
  // A day's grace for a clock that runs behind; anything later is not a date this account got a game.
  const latest = Date.now() / 1000 + 86_400
  for (const app of apps) {
    const appId = Number(app?.appid)
    if (!Number.isInteger(appId) || appId <= 0) continue
    const owners = Array.isArray(app.owner_steamids) ? app.owner_steamids.map(String) : []
    if (owners.length && !owners.includes(me) && !owners.includes(steamId64)) continue
    const seconds = Number(app.rt_time_acquired)
    if (!Number.isFinite(seconds) || seconds > latest) continue
    const iso = unixToIso(seconds)
    if (iso) out.set(appId, iso)
  }
  return out
}

/** Capture result of a store page load: the identity, or `dead` when the page is the login form. */
type PageOutcome = { identity: SteamWebIdentity } | { dead: true }

/** The sites the sign-in window may show: the store, the login host and the community (Steam Guard pages). */
export const STEAM_SITES = ['steampowered.com', 'steamcommunity.com']

/** Only the store's own documents are read: any other host (a footer link, a redirect elsewhere) is ignored. */
export function isStorePage(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'store.steampowered.com'
  } catch {
    return false
  }
}

async function readStorePage(ctx: {
  url: string
  loaded: boolean
  executeJavaScript<T>(script: string): Promise<T>
}): Promise<PageOutcome | undefined> {
  if (!ctx.loaded || !isStorePage(ctx.url)) return undefined
  if (/\/login/i.test(new URL(ctx.url).pathname)) return { dead: true }
  const raw = await ctx.executeJavaScript<ApplicationConfig | null>(APPLICATION_CONFIG_SCRIPT)
  const identity = parseApplicationConfig(raw)
  return identity ? { identity } : undefined
}

async function personaFromLoginUsers(steamId64: string, log: Logger): Promise<string | undefined> {
  try {
    const { detectSteam } = await import('../providers/steam')
    const detection = await detectSteam(log)
    if (!detection.root) return undefined
    const text = await readTextIfExists(join(detection.root, 'config', 'loginusers.vdf'))
    if (text === null) return undefined
    return parseLoginUsers(text).find((u) => u.steamId64 === steamId64)?.accountName || undefined
  } catch {
    return undefined
  }
}

export interface SteamAccountOptions {
  /** Injected for tests; defaults to the loginusers.vdf lookup through the Steam client folder. */
  personaLookup?: (steamId64: string, log: Logger) => Promise<string | undefined>
}

export function createSteamAccount(options: SteamAccountOptions = {}): StoreAccount {
  const personaLookup = options.personaLookup ?? personaFromLoginUsers

  async function fetchOwnedWith(tokens: SteamTokens, ctx: AccountContext): Promise<OwnedGame[]> {
    const data = await apiJson<SteamOwnedResponse>(ownedGamesUrl(tokens), {}, { store: 'Steam' })
    // `{"response":{}}` is Steam's answer for a private profile and for an API hiccup: no information, not an
    // empty library. Throwing keeps the merge from deleting every owned record.
    if (!Array.isArray(data.response?.games))
      throw new Error(tMain('mainAccounts.unavailable.noGamesList'))
    const owned = mapSteamOwned(data)
    ctx.log.info(
      `steam: ${owned.length} owned game(s) (${data.response?.game_count ?? '?'} listed)`
    )
    if (tokens.kind === 'web') await addAcquiredTimes(owned, tokens, ctx)
    return owned
  }

  /**
   * Steam's "Date Added to Library" for each owned game (OwnedGame.acquiredAt). GetOwnedGames has no such date; the
   * family library answer does, and only for the web sign-in (an API key is refused there). Optional: any failure
   * leaves the games without the date and the import as it was, and never ends the session. One short attempt and one
   * retry, so a slow answer cannot hold the library back.
   */
  async function addAcquiredTimes(
    owned: OwnedGame[],
    tokens: SteamWebTokens,
    ctx: AccountContext
  ): Promise<void> {
    try {
      const times = parseAcquiredTimes(
        await apiJson<SteamSharedLibraryResponse>(
          sharedLibraryUrl(tokens),
          {},
          { store: 'Steam', timeoutMs: ACQUIRED_TIMEOUT_MS, retries: 1, delaysMs: [500] }
        ),
        tokens.steamId64
      )
      let dated = 0
      for (const game of owned) {
        const at = times.get(Number(game.externalId))
        if (!at) continue
        game.acquiredAt = at
        dated++
      }
      const line = `steam: date added known for ${dated} of ${owned.length} owned game(s)`
      if (dated === 0 && owned.length > 0)
        ctx.log.warn(`${line}; "Recently added" keeps the order PlayOut found them in`)
      else ctx.log.info(line)
    } catch (err) {
      ctx.log.warn(`steam: the dates games were added could not be read: ${describeError(err)}`)
    }
  }

  return {
    source: 'steam',
    storeName: 'Steam',
    supported: true,
    get confirmMessage() {
      return tMain('mainAccounts.confirm.steam')
    },

    async signIn(win: AuthWindow): Promise<AccountTokens | null> {
      // The login page is skipped on purpose: the capture waits for the first store page of a signed-in user.
      const outcome = await win.run<PageOutcome>({
        url: STEAM_EXPLORE_URL,
        allowedSites: STEAM_SITES,
        onNavigate: async (ctx) => {
          const result = await readStorePage(ctx)
          return result && 'identity' in result ? result : undefined
        }
      })
      if (!outcome || !('identity' in outcome)) return null
      const tokens: SteamWebTokens = {
        kind: 'web',
        ...outcome.identity,
        capturedAt: new Date().toISOString()
      }
      return tokens
    },

    async refresh(tokens, ctx): Promise<AccountTokens | null> {
      if (tokens.kind !== 'web') return tokens
      // A hidden load of the store on the same partition re-mints the short-lived webapi_token; landing on the
      // login page means the cookie session is gone. No capture at all (offline, a slow store, the 20 s timeout)
      // says nothing about the session, so the credential is kept and the import retried later.
      const outcome = await ctx.hidden.run<PageOutcome>({
        url: STEAM_EXPLORE_URL,
        allowedSites: STEAM_SITES,
        onNavigate: readStorePage
      })
      if (!outcome)
        throw new StoreUnavailableError('Steam', tMain('mainAccounts.unavailable.storePage'))
      if ('dead' in outcome) return null
      const next: SteamWebTokens = {
        ...(tokens as SteamWebTokens),
        kind: 'web',
        ...outcome.identity,
        capturedAt: new Date().toISOString()
      }
      return next
    },

    async displayName(tokens, ctx): Promise<string | undefined> {
      const t = tokens as SteamTokens
      if (t.kind === 'web') return t.accountName || t.steamId64
      try {
        const data = await apiJson<PlayerSummariesResponse>(
          buildUrl(`${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/`, {
            key: t.apiKey,
            steamids: t.steamId64
          }),
          {},
          { store: 'Steam' }
        )
        const persona = data.response?.players?.[0]?.personaname?.trim()
        if (persona) return `${persona} (API key)`
      } catch (err) {
        ctx.log.debug(`steam: GetPlayerSummaries failed: ${describeError(err)}`)
      }
      const persona = await personaLookup(t.steamId64, ctx.log)
      return `${persona ?? t.steamId64} (API key)`
    },

    fetchOwned(tokens, ctx) {
      return fetchOwnedWith(tokens as SteamTokens, ctx)
    },

    installSpec(game: Game, client: ClientInfo): { kind: 'uri'; uri: string } | null {
      // Without the client the URI would land in Windows' "pick an app" prompt and nothing could ever confirm.
      if (!client.installed) return null
      const appId = String(game.extra?.steamAppId ?? game.externalId)
      return /^\d+$/.test(appId) ? { kind: 'uri', uri: `steam://install/${appId}` } : null
    },

    installError(_game: Game, client: ClientInfo): string {
      return client.installed
        ? tMain('mainAccounts.install.steamNoId')
        : tMain('mainAccounts.install.steamMissing')
    }
  }
}

export const steamAccount = createSteamAccount()
