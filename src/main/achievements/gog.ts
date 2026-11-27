// GOG achievements (the same requests GOG Galaxy makes): a game's Galaxy client id and secret from its public build
// manifest, a game-scoped token from GOG's token service with the signed-in account's refresh token, then the user's
// achievements of that game from gameplay.gog.com. Whether a game has achievements at all is checked against its public
// product page's features before PlayOut marks it as having none. Tokens are never logged or stored: the account's stay
// in the account store, the game tokens in memory only.
import { inflateSync } from 'node:zlib'
import type { AchievementsInfo } from '../../shared/types'
import { formBody } from '../accounts/api'
import {
  HttpError,
  httpBytes,
  httpJson,
  RateLimiter,
  USER_AGENT,
  type HttpOptions
} from '../scrapers/http'

const BUILDS_URL = (productId: string): string =>
  `https://content-system.gog.com/products/${encodeURIComponent(productId)}/os/windows/builds?generation=2`
const PRODUCT_URL = (productId: string): string =>
  `https://api.gog.com/v2/games/${encodeURIComponent(productId)}?locale=en-US`
const TOKEN_URL = 'https://auth.gog.com/token'
const ACHIEVEMENTS_URL = (clientId: string, userId: string): string =>
  `https://gameplay.gog.com/clients/${encodeURIComponent(clientId)}/users/${encodeURIComponent(userId)}/achievements`

/** Whose request it is: a game page being opened goes before the background scan's. */
export type GogPriority = 'page' | 'scan'

/**
 * GOG publishes no number: about one request a second, shared by every GOG achievements request. The requests wait in
 * two queues and a page open's are served first, so an open page never waits behind the scan's queued requests. Epic's
 * achievements (epic.ts) pace theirs with an instance of their own.
 */
export class PriorityPacer {
  private readonly waiting: Record<GogPriority, (() => void)[]> = { page: [], scan: [] }
  private draining = false

  constructor(private readonly limiter: Pick<RateLimiter, 'take'>) {}

  take(priority: GogPriority): Promise<void> {
    return new Promise((resolve) => {
      this.waiting[priority].push(resolve)
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const next = this.waiting.page.shift() ?? this.waiting.scan.shift()
        if (!next) break
        await this.limiter.take()
        next()
      }
    } finally {
      this.draining = false
    }
  }
}

const pacer = new PriorityPacer(new RateLimiter(1, 2))
const request = (priority: GogPriority, retries = 1): HttpOptions => ({
  timeoutMs: 20_000,
  retries,
  limiter: { take: () => pacer.take(priority) }
})
/** Pages of one game's list read at most (a malformed page token must not loop). */
const MAX_PAGES = 50
/** A game token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000

/** The signed-in GOG account, as the achievements need it (never logged). */
export interface GogAccountCredential {
  userId: string
  refreshToken: string
}

/** GOG refused the account's refresh token for the game (signed out elsewhere, or the session expired). */
export class GogAuthError extends Error {
  constructor() {
    super('GOG refused the signed-in account')
    this.name = 'GogAuthError'
  }
}

export interface GogClient {
  clientId: string
  clientSecret: string
}

interface BuildsResponse {
  items?: { link?: string }[]
}

interface ManifestV2 {
  clientId?: unknown
  clientSecret?: unknown
}

/** The manifest is zlib-compressed JSON (older ones plain). */
function readManifest(data: Buffer): ManifestV2 | null {
  for (const decode of [(b: Buffer) => inflateSync(b), (b: Buffer) => b]) {
    try {
      const parsed = JSON.parse(decode(data).toString('utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as ManifestV2) : null
    } catch {
      // Next decoder.
    }
  }
  return null
}

/** The game's Galaxy client (public, no login); null when it has no Galaxy build or no client id. */
export async function gogClientOf(
  productId: string,
  priority: GogPriority = 'scan'
): Promise<GogClient | null> {
  const headers = { 'User-Agent': USER_AGENT }
  let builds: BuildsResponse
  try {
    builds = await httpJson<BuildsResponse>(BUILDS_URL(productId), { headers }, request(priority))
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null
    throw err
  }
  const link = builds.items?.find(
    (b) => typeof b.link === 'string' && /^https:\/\//i.test(b.link)
  )?.link
  if (!link) return null
  const { data } = await httpBytes(link, { headers }, request(priority))
  const manifest = readManifest(data)
  const clientId = manifest?.clientId
  const clientSecret = manifest?.clientSecret
  if (typeof clientId !== 'string' && typeof clientId !== 'number') return null
  if (typeof clientSecret !== 'string' || !clientSecret) return null
  return { clientId: String(clientId), clientSecret }
}

interface ProductResponse {
  _embedded?: { features?: { id?: unknown }[] }
}

/**
 * Whether the game's public product page lists achievements (no login): the second source a "no achievements" mark
 * needs. null when GOG does not know the product.
 */
export async function gogListsAchievements(
  productId: string,
  priority: GogPriority = 'scan'
): Promise<boolean | null> {
  let body: ProductResponse
  try {
    body = await httpJson<ProductResponse>(
      PRODUCT_URL(productId),
      { headers: { 'User-Agent': USER_AGENT } },
      request(priority)
    )
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null
    throw err
  }
  const features = body._embedded?.features
  if (!Array.isArray(features)) return null
  return features.some((f) => f.id === 'achievements')
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
}

/** Game tokens by client id, in memory only. */
const gameTokens = new Map<string, { token: string; expiresAt: number; account: string }>()

/** The `error` code of an OAuth error answer ('invalid_grant', 'invalid_client', ...), when the body has one. */
function oauthError(err: HttpError): string | undefined {
  try {
    const parsed = JSON.parse(err.body ?? '') as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : undefined
  } catch {
    return undefined
  }
}

/**
 * A token for the game's client, as Galaxy gets one: the account's refresh token exchanged with the game's client id
 * and secret (in a POST body: a refresh token must never be in a URL, which errors and logs carry). Nothing comes back
 * to the account: its own refresh token is left as it is, and the game token is kept in memory only.
 *
 * The account is read when the request's turn in the queue has come, right before it goes out, so a refresh of the
 * account while it waited cannot make it send a refresh token that was replaced. Only an answer that refuses the
 * account itself (401, or `invalid_grant` for the newest refresh token, asked once more when it changed) is a
 * GogAuthError. Anything else GOG refuses (another 400 such as `invalid_client` for this game's client, or a 403) is
 * this game's failure only, thrown as the HttpError. null: signed out meanwhile.
 */
export async function gogGameToken(
  client: GogClient,
  account: () => Promise<GogAccountCredential | null>,
  priority: GogPriority = 'scan'
): Promise<string | null> {
  const first = await account()
  if (!first) return null
  const known = gameTokens.get(client.clientId)
  if (known && known.account === first.userId && known.expiresAt - TOKEN_MARGIN_MS > Date.now())
    return known.token
  for (let attempt = 0; ; attempt++) {
    await pacer.take(priority)
    const credential = await account()
    if (!credential) return null
    let body: TokenResponse
    try {
      body = await httpJson<TokenResponse>(
        TOKEN_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT
          },
          body: formBody({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: credential.refreshToken,
            // Galaxy's own request for a game's token: no new sign-in session for the account.
            without_new_session: '1'
          })
        },
        // Paced above already (the account is read after the wait).
        { timeoutMs: 20_000, retries: 0 }
      )
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      if (err.status === 401 || (err.status === 400 && oauthError(err) === 'invalid_grant')) {
        // A refresh of the account may have replaced the refresh token meanwhile: once more with the new one.
        const now = attempt === 0 ? await account() : null
        if (now && now.refreshToken !== credential.refreshToken) continue
        throw new GogAuthError()
      }
      throw err
    }
    if (!body.access_token) throw new Error('GOG gave no token for the game')
    const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3600_000
    gameTokens.set(client.clientId, {
      token: body.access_token,
      expiresAt: Date.now() + expiresIn,
      account: credential.userId
    })
    return body.access_token
  }
}

/** Forget the game tokens (a sign-out). */
export function forgetGogTokens(): void {
  gameTokens.clear()
}

export interface GogAchievementItem {
  achievement_id?: unknown
  achievement_key?: unknown
  name?: unknown
  description?: unknown
  image_url_unlocked?: unknown
  image_url_locked?: unknown
  visible?: unknown
  date_unlocked?: unknown
}

interface AchievementsPage {
  items?: GogAchievementItem[]
  page_token?: unknown
}

/** The user's achievements of the game, every page; null when GOG has none for the game (404). */
export async function gogAchievementItems(
  client: GogClient,
  userId: string,
  token: string,
  locale = 'en-US',
  priority: GogPriority = 'scan'
): Promise<GogAchievementItem[] | null> {
  const items: GogAchievementItem[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const url: string =
      ACHIEVEMENTS_URL(client.clientId, userId) +
      (pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : '')
    let body: AchievementsPage
    try {
      body = await httpJson<AchievementsPage>(
        url,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Gog-Lc': locale,
            Accept: 'application/json',
            'User-Agent': USER_AGENT
          }
        },
        request(priority)
      )
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return page === 0 ? null : items
      // The game's token was refused (it ended early, or the game is not this account's): a new one is asked next
      // time. Not the account's failure (GOG just gave the token for it): readGogAchievements asks once more.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403))
        gameTokens.delete(client.clientId)
      throw err
    }
    if (Array.isArray(body.items)) items.push(...body.items)
    const next = body.page_token
    if (typeof next !== 'string' || !next || next === '0') break
    pageToken = next
  }
  return items
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined
const httpsUrl = (v: unknown): string | undefined => {
  const s = text(v)
  return s && /^https:\/\//i.test(s) ? s : undefined
}

/** GOG's items as PlayOut's list: unlocked first come in GOG's order, as Galaxy shows them. */
export function mapGogAchievements(items: GogAchievementItem[]): AchievementsInfo {
  const list: AchievementsInfo['list'] = []
  const seen = new Set<string>()
  for (const item of items) {
    const id = text(item.achievement_key) ?? text(String(item.achievement_id ?? ''))
    if (!id || seen.has(id)) continue
    seen.add(id)
    const when = text(item.date_unlocked)
    const unlockedAt =
      when && Number.isFinite(Date.parse(when)) ? new Date(when).toISOString() : undefined
    const unlocked = !!when
    list.push({
      id,
      name: text(item.name) ?? id,
      description: text(item.description),
      unlocked,
      unlockedAt,
      icon: unlocked
        ? (httpsUrl(item.image_url_unlocked) ?? httpsUrl(item.image_url_locked))
        : (httpsUrl(item.image_url_locked) ?? httpsUrl(item.image_url_unlocked)),
      ...(item.visible === false ? { hidden: true } : {})
    })
  }
  return {
    provider: 'gog',
    total: list.length,
    unlocked: list.filter((a) => a.unlocked).length,
    list: list.map((a) =>
      Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined))
    ) as AchievementsInfo['list']
  }
}

/** What GOG says about one game's achievements for the signed-in account. */
export type GogRead =
  | { kind: 'list'; info: AchievementsInfo }
  /** GOG has no achievements for it: its list is empty and its product page lists none. */
  | { kind: 'none' }
  /** GOG gave no list, but its product page lists achievements (none synced yet, a game Galaxy never ran). */
  | { kind: 'unknown' }
  /** Not signed in to GOG in PlayOut. */
  | { kind: 'signed-out' }

export interface GogReadDeps {
  account(): Promise<GogAccountCredential | null>
  clientOf?: typeof gogClientOf
  listsAchievements?: typeof gogListsAchievements
  token?: typeof gogGameToken
  items?: typeof gogAchievementItems
  locale?: () => string
}

/** Clients by product (public and fixed per build): read once per run. */
const clients = new Map<string, GogClient | null>()

/**
 * One game's achievements with the signed-in GOG account. Throws when GOG could not be asked: a GogAuthError when it
 * refused the account itself, else this game's failure. A page open's requests (`priority`) go before the scan's.
 */
export async function readGogAchievements(
  productId: string,
  deps: GogReadDeps,
  priority: GogPriority = 'scan'
): Promise<GogRead> {
  const account = await deps.account()
  if (!account) return { kind: 'signed-out' }
  const clientOf = deps.clientOf ?? gogClientOf
  const lists = deps.listsAchievements ?? gogListsAchievements
  const tokenOf = deps.token ?? gogGameToken
  const itemsOf = deps.items ?? gogAchievementItems
  let client = clients.get(productId)
  if (client === undefined) {
    client = await clientOf(productId, priority)
    clients.set(productId, client)
  }
  const noList = async (): Promise<GogRead> =>
    (await lists(productId, priority)) === false ? { kind: 'none' } : { kind: 'unknown' }
  if (!client) return noList()
  const locale = deps.locale?.() ?? 'en-US'
  let items: GogAchievementItem[] | null
  for (let attempt = 0; ; attempt++) {
    const token = await tokenOf(client, deps.account, priority)
    if (!token) return { kind: 'signed-out' }
    try {
      items = await itemsOf(client, account.userId, token, locale, priority)
      break
    } catch (err) {
      // The game's token was refused: once more with a new one (gogAchievementItems dropped the refused one).
      if (attempt === 0 && err instanceof HttpError && err.status === 401) continue
      throw err
    }
  }
  if (!items?.length) return noList()
  return { kind: 'list', info: mapGogAchievements(items) }
}

/** Tests: forget the clients and tokens read. */
export function resetGogCaches(): void {
  clients.clear()
  gameTokens.clear()
}
