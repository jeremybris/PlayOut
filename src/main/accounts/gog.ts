// GOG account: the Galaxy client's OAuth code flow (minigalaxy / lutris / heroic-gogdl) and the account's
// getFilteredProducts listing (docs/research/store-accounts.md §3). Installs go through GOG Galaxy's command line
// when it runs, else its protocol.
import type { ClientInfo, Game, OwnedGame } from '../../shared/types'
import { removeTrademarks } from '../util/text'
import { apiJson, formBody, refreshFailure } from './api'
import {
  describeError,
  SessionExpiredError,
  type AccountContext,
  type AccountTokens,
  type InstallSpec,
  type StoreAccount
} from './types'
import { tMain } from '../i18n'

const CLIENT_ID = '46899977096215655'
const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9'
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client'
export const GOG_LOGIN_URL = `https://auth.gog.com/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&layout=client2`
const TOKEN_URL = 'https://auth.gog.com/token'
const PRODUCTS_URL = 'https://embed.gog.com/account/getFilteredProducts'
const EXPIRY_MARGIN_MS = 60_000
/** ~1 request per second on the account listing (minigalaxy's pace). */
const PAGE_DELAY_MS = 1_000
export const GALAXY_PROCESS = 'GalaxyClient'

export interface GogTokens extends AccountTokens {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: string
  userId: string
  username?: string
}

export interface GogTokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  user_id?: string
  error?: string
  error_description?: string
}

export interface GogProductRow {
  id?: number | string
  title?: string
  /** `//images-N.gog-statics.com/<hash>`, no extension. */
  image?: string
  isGame?: boolean
  isMovie?: boolean
  isHidden?: boolean
  releaseDate?: { date?: string } | string | null
}

export interface GogProductsPage {
  page?: number
  totalPages?: number
  totalProducts?: number
  products?: GogProductRow[]
}

/** The `code` of the client redirect; GOG sometimes sends `https://gog.com:80`-style hosts, so only the path counts. */
export function codeFromRedirect(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!/(^|\.)gog\.com$/i.test(parsed.hostname) || !parsed.pathname.startsWith('/on_login_success'))
    return null
  const code = parsed.searchParams.get('code')
  return code && /^[A-Za-z0-9_-]+$/.test(code) ? code : null
}

export function mapTokenResponse(data: GogTokenResponse, previous?: GogTokens): GogTokens {
  if (data.error || !data.access_token)
    throw new Error(data.error_description || data.error || tMain('mainAccounts.token.gog'))
  const userId = data.user_id ?? previous?.userId
  if (!userId) throw new Error(tMain('mainAccounts.token.gogUser'))
  return {
    kind: 'oauth',
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    userId,
    username: previous?.username
  }
}

/** `//images-4.gog-statics.com/<hash>` -> the vertical cover (formatter from Heroic / the GOG web client). */
export function gogImageUrl(image: string | undefined, formatter: string): string | undefined {
  if (!image) return undefined
  const base = image.startsWith('//') ? `https:${image}` : image
  if (!/^https?:\/\//.test(base)) return undefined
  return `${base}${formatter}.jpg`
}

function releaseDateOf(row: GogProductRow): string | undefined {
  const raw = typeof row.releaseDate === 'string' ? row.releaseDate : row.releaseDate?.date
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw ?? '')
  return match ? match[1] : undefined
}

/**
 * Keep base games only (`isGame && !isMovie`); DLC never appears in the listing. Games the user hid in their
 * gog.com library are imported too, with `extra.gogHidden` set, so the hidden sync can hide them in PlayOut
 * (every listed game carries the flag, so un-hiding on gog.com clears it on the next import).
 */
export function mapGogProducts(rows: GogProductRow[]): OwnedGame[] {
  const out: OwnedGame[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const id = String(row.id ?? '').trim()
    if (!/^\d+$/.test(id) || seen.has(id)) continue
    if (row.isGame === false || row.isMovie === true) continue
    const title = removeTrademarks((row.title ?? '').trim())
    if (!title) continue
    seen.add(id)
    out.push({
      externalId: id,
      title,
      coverUrl: gogImageUrl(row.image, '_glx_vertical_cover'),
      heroUrl: gogImageUrl(row.image, '_1600'),
      releaseDate: releaseDateOf(row),
      extra: { gogProductId: id, gogHidden: row.isHidden === true }
    })
  }
  return out
}

/**
 * The token endpoint takes the client pair and the code / refresh token in a POST body, never in the query string:
 * an HttpError embeds its URL, and a refresh token in a log line would hand over the account.
 */
function tokenRequest(params: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params })
  }
}

/** The sites the sign-in window may show. */
export const GOG_SITES = ['gog.com']

function bearer(tokens: GogTokens): RequestInit {
  // The listing answers a login redirect (302) for a dead session; `manual` turns that into a status we can read.
  return { headers: { Authorization: `Bearer ${tokens.accessToken}` }, redirect: 'manual' }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createGogAccount(options: { pageDelayMs?: number } = {}): StoreAccount {
  const pageDelayMs = options.pageDelayMs ?? PAGE_DELAY_MS

  async function fetchPage(tokens: GogTokens, page: number): Promise<GogProductsPage> {
    return apiJson<GogProductsPage>(`${PRODUCTS_URL}?mediaType=1&page=${page}`, bearer(tokens), {
      store: 'GOG',
      authStatuses: [301, 302, 401, 403]
    })
  }

  return {
    source: 'gog',
    storeName: 'GOG Galaxy',
    supported: true,
    get confirmMessage() {
      return tMain('mainAccounts.confirm.gog')
    },

    async signIn(win): Promise<AccountTokens | null> {
      const code = await win.run<string>({
        url: GOG_LOGIN_URL,
        allowedSites: GOG_SITES,
        onNavigate: (ctx) => codeFromRedirect(ctx.url) ?? undefined
      })
      if (!code) return null
      const data = await apiJson<GogTokenResponse>(
        TOKEN_URL,
        tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
        { store: 'GOG', authStatuses: [400, 401, 403] }
      )
      return mapTokenResponse(data)
    },

    async refresh(tokens, ctx): Promise<AccountTokens | null> {
      const t = tokens as GogTokens
      if (Date.parse(t.expiresAt) - Date.now() > EXPIRY_MARGIN_MS) return t
      if (!t.refreshToken) return null
      try {
        const data = await apiJson<GogTokenResponse>(
          TOKEN_URL,
          tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken }),
          { store: 'GOG', authStatuses: [400, 401, 403] }
        )
        return mapTokenResponse(data, t)
      } catch (err) {
        return refreshFailure(err, 'gog', ctx.log)
      }
    },

    async displayName(tokens, ctx): Promise<string | undefined> {
      const t = tokens as GogTokens
      if (t.username) return t.username
      try {
        const data = await apiJson<{ username?: string }>(
          `https://users.gog.com/users/${encodeURIComponent(t.userId)}`,
          { headers: { Authorization: `Bearer ${t.accessToken}` } },
          { store: 'GOG' }
        )
        return data.username?.trim() || undefined
      } catch (err) {
        ctx.log.debug(`gog: user lookup failed: ${describeError(err)}`)
        return undefined
      }
    },

    async fetchOwned(tokens, ctx: AccountContext): Promise<OwnedGame[]> {
      const t = tokens as GogTokens
      const rows: GogProductRow[] = []
      const first = await fetchPage(t, 1)
      rows.push(...(first.products ?? []))
      const totalPages = Math.min(first.totalPages ?? 1, 500)
      for (let page = 2; page <= totalPages; page++) {
        await sleep(pageDelayMs)
        const data = await fetchPage(t, page)
        rows.push(...(data.products ?? []))
      }
      const owned = mapGogProducts(rows)
      ctx.log.info(
        `gog: ${owned.length} owned game(s) (${first.totalProducts ?? rows.length} listed)`
      )
      return owned
    },

    installSpec(game: Game, client: ClientInfo): InstallSpec | null {
      const id = String(game.extra?.gogProductId ?? game.externalId).trim()
      if (!/^\d+$/.test(id) || !client.installed || !client.path) return null
      // Playnite's UseAutomaticGameInstalls: the command only when the client core is running (checked by the
      // install service through `requiresProcess`), then the game view 2.5 s later; else the game view alone.
      return {
        kind: 'exec',
        file: client.path,
        args: [`/gameId=${id}`, '/command=installGame'],
        requiresProcess: GALAXY_PROCESS,
        followUpUri: `goggalaxy://openGameView/${id}`,
        followUpDelayMs: 2_500
      }
    },

    installError(_game, client) {
      return client.installed
        ? tMain('mainAccounts.install.gogNoId')
        : tMain('mainAccounts.install.gogMissing')
    }
  }
}

export const gogAccount = createGogAccount()

export { SessionExpiredError }
