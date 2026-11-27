// Xbox / Microsoft Store account: Playnite's Azure app code flow, XBL + XSTS tokens, and the titlehub title history
// (titles played at least once; never-played purchases need the Collections API, a later release). See
// docs/research/store-accounts.md §4.
import type { ClientInfo, Game, OwnedGame } from '../../shared/types'
import { removeTrademarks } from '../util/text'
import { apiJson, formBody, OPTIONAL_CALL_RETRY, refreshFailure } from './api'
import {
  describeError,
  SessionExpiredError,
  type AccountContext,
  type AccountTokens,
  type InstallSpec,
  type StoreAccount
} from './types'
import { tMain } from '../i18n'

const CLIENT_ID = '38cd2fa8-66fd-4760-afb2-405eb65d5b0c'
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'
const SCOPE = 'Xboxlive.signin Xboxlive.offline_access'
export const XBOX_LOGIN_URL = `https://login.live.com/oauth20_authorize.srf?client_id=${CLIENT_ID}&response_type=code&approval_prompt=auto&scope=${encodeURIComponent(SCOPE).replace(/%20/g, '+')}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf'
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const TITLEHUB_URL = 'https://titlehub.xboxlive.com'
const USERSTATS_URL = 'https://userstats.xboxlive.com/batch'
const EXPIRY_MARGIN_MS = 60_000
const STATS_BATCH = 100

export interface XboxTokens extends AccountTokens {
  kind: 'msa'
  accessToken: string
  refreshToken: string
  /** ISO: when the Microsoft account token expires. */
  msaExpiresAt: string
  xstsToken: string
  /** User hash: the `x=` part of the XBL3.0 authorization. */
  uhs: string
  /** XUID. */
  xid: string
  gamertag?: string
  /** ISO: XSTS `NotAfter`. */
  xstsNotAfter: string
}

export interface MsaTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

export interface XblTokenResponse {
  Token?: string
  NotAfter?: string
  DisplayClaims?: { xui?: { uhs?: string; xid?: string; gtg?: string }[] }
}

export interface TitleHubTitle {
  titleId?: string
  pfn?: string
  type?: string
  name?: string
  devices?: string[]
  displayImage?: string
  images?: { url?: string; type?: string }[]
  detail?: {
    description?: string
    publisherName?: string
    developerName?: string
    releaseDate?: string
    genres?: string[]
  }
  titleHistory?: { lastTimePlayed?: string }
}

export interface TitleHubResponse {
  titles?: TitleHubTitle[]
}

export interface UserStatsResponse {
  statlistscollection?: { stats?: { titleid?: string; value?: string | number }[] }[]
}

/** The sites the sign-in window may show: Microsoft account sign-in and its helpers. */
export const XBOX_SITES = [
  'live.com',
  'microsoft.com',
  'microsoftonline.com',
  'msauth.net',
  'xbox.com'
]

/** The `code` of `https://login.live.com/oauth20_desktop.srf?code=M.C...&lc=...`. */
export function codeFromRedirect(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (
    parsed.hostname.toLowerCase() !== 'login.live.com' ||
    !parsed.pathname.startsWith('/oauth20_desktop.srf')
  )
    return null
  const code = parsed.searchParams.get('code')
  return code && code.length > 8 ? code : null
}

/** Playnite's title cleanup: PC/Windows suffixes and trademarks. */
export function cleanXboxTitle(name: string): string {
  return removeTrademarks(
    name
      .replace(/\s*\((PC|Windows|Windows 10|Windows 11)\)\s*/gi, ' ')
      .replace(/\s*(-|–)?\s*for Windows( 10| 11)?\s*$/i, '')
      .replace(/\s*(-|–)\s*Windows( 10| 11)?\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function imageOf(title: TitleHubTitle, types: string[]): string | undefined {
  for (const type of types) {
    const url = title.images?.find(
      (i) => i.type?.toLowerCase() === type.toLowerCase() && i.url
    )?.url
    if (url) return url
  }
  return undefined
}

/** Keep PC games with a package family name; `productId` and `titleId` become `extra` for the install URI. */
export function mapTitleHistory(
  data: TitleHubResponse,
  minutesByTitleId = new Map<string, number>()
): OwnedGame[] {
  const out: OwnedGame[] = []
  const seen = new Set<string>()
  for (const title of data.titles ?? []) {
    const pfn = title.pfn?.trim()
    if (!pfn || seen.has(pfn)) continue
    if ((title.type ?? '').toLowerCase() !== 'game') continue
    if (!(title.devices ?? []).some((d) => d.toLowerCase() === 'pc')) continue
    const name = cleanXboxTitle(title.name ?? '')
    if (!name) continue
    seen.add(pfn)
    const extra: Record<string, string> = {}
    if (title.titleId) extra.titleId = String(title.titleId)
    const productId = (title as { productId?: string }).productId
    if (productId) extra.storeId = productId
    const game: OwnedGame = {
      externalId: pfn,
      title: name,
      coverUrl: imageOf(title, ['Poster', 'BoxArt']),
      heroUrl: imageOf(title, ['SuperHeroArt', 'TitledHeroArt', 'BrandedKeyArt']),
      logoUrl: imageOf(title, ['Logo']),
      iconUrl: imageOf(title, ['Tile']) ?? title.displayImage,
      developer: title.detail?.developerName?.trim() || undefined,
      publisher: title.detail?.publisherName?.trim() || undefined,
      extra
    }
    const released = /^(\d{4}-\d{2}-\d{2})/.exec(title.detail?.releaseDate ?? '')
    if (released) game.releaseDate = released[1]
    const last = title.titleHistory?.lastTimePlayed
    if (last && !Number.isNaN(Date.parse(last))) game.lastPlayedAt = new Date(last).toISOString()
    const minutes = title.titleId ? minutesByTitleId.get(String(title.titleId)) : undefined
    if (minutes) game.storePlaytimeMinutes = minutes
    out.push(game)
  }
  return out
}

export function parseUserStats(data: UserStatsResponse): Map<string, number> {
  const out = new Map<string, number>()
  for (const list of data.statlistscollection ?? [])
    for (const stat of list.stats ?? []) {
      const minutes = Number(stat.value)
      if (stat.titleid && Number.isFinite(minutes) && minutes > 0)
        out.set(String(stat.titleid), Math.round(minutes))
    }
  return out
}

async function msaToken(body: string): Promise<MsaTokenResponse> {
  return apiJson<MsaTokenResponse>(
    TOKEN_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    { store: 'Xbox', authStatuses: [400, 401, 403] }
  )
}

async function xboxLiveTokens(
  accessToken: string
): Promise<Pick<XboxTokens, 'xstsToken' | 'uhs' | 'xid' | 'gamertag' | 'xstsNotAfter'>> {
  const headers = { 'Content-Type': 'application/json', 'x-xbl-contract-version': '1' }
  const user = await apiJson<XblTokenResponse>(
    XBL_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `d=${accessToken}`
        }
      })
    },
    { store: 'Xbox' }
  )
  if (!user.Token) throw new Error(tMain('mainAccounts.token.xboxUser'))
  const xsts = await apiJson<XblTokenResponse>(
    XSTS_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        RelyingParty: 'http://xboxlive.com',
        TokenType: 'JWT',
        Properties: { SandboxId: 'RETAIL', UserTokens: [user.Token] }
      })
    },
    { store: 'Xbox' }
  )
  const claim = xsts.DisplayClaims?.xui?.[0]
  if (!xsts.Token || !claim?.uhs || !claim.xid) throw new Error(tMain('mainAccounts.token.xsts'))
  return {
    xstsToken: xsts.Token,
    uhs: claim.uhs,
    xid: claim.xid,
    gamertag: claim.gtg,
    xstsNotAfter: xsts.NotAfter ?? new Date(Date.now() + 8 * 3600_000).toISOString()
  }
}

export async function tokensFromMsa(
  data: MsaTokenResponse,
  previous?: XboxTokens
): Promise<XboxTokens> {
  if (data.error || !data.access_token)
    throw new Error(data.error_description || data.error || tMain('mainAccounts.token.microsoft'))
  const live = await xboxLiveTokens(data.access_token)
  return {
    kind: 'msa',
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    msaExpiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    ...live
  }
}

function serviceHeaders(tokens: XboxTokens): Record<string, string> {
  return {
    Authorization: `XBL3.0 x=${tokens.uhs};${tokens.xstsToken}`,
    'x-xbl-contract-version': '2',
    'Accept-Language': 'en-US',
    'Content-Type': 'application/json'
  }
}

export function createXboxAccount(): StoreAccount {
  async function fetchStats(
    tokens: XboxTokens,
    titleIds: string[],
    ctx: AccountContext
  ): Promise<Map<string, number>> {
    const minutes = new Map<string, number>()
    for (let i = 0; i < titleIds.length; i += STATS_BATCH) {
      const batch = titleIds.slice(i, i + STATS_BATCH)
      try {
        const data = await apiJson<UserStatsResponse>(
          USERSTATS_URL,
          {
            method: 'POST',
            headers: serviceHeaders(tokens),
            body: JSON.stringify({
              arrangebyfield: 'xuid',
              stats: batch.map((titleid) => ({ name: 'MinutesPlayed', titleid })),
              xuids: [tokens.xid]
            })
          },
          // Optional data: the quick retries, not the owned import's slow ones.
          { store: 'Xbox', ...OPTIONAL_CALL_RETRY }
        )
        for (const [id, value] of parseUserStats(data)) minutes.set(id, value)
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err
        ctx.log.debug(`xbox: play time unavailable: ${describeError(err)}`)
        break
      }
    }
    return minutes
  }

  return {
    source: 'xbox',
    storeName: 'Xbox app',
    supported: true,
    get confirmMessage() {
      return tMain('mainAccounts.confirm.xbox')
    },

    async signIn(win): Promise<AccountTokens | null> {
      const code = await win.run<string>({
        url: XBOX_LOGIN_URL,
        allowedSites: XBOX_SITES,
        onNavigate: (ctx) => codeFromRedirect(ctx.url) ?? undefined
      })
      if (!code) return null
      const data = await msaToken(
        formBody({
          grant_type: 'authorization_code',
          code,
          scope: SCOPE,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI
        })
      )
      return tokensFromMsa(data)
    },

    async refresh(tokens, ctx): Promise<AccountTokens | null> {
      const t = tokens as XboxTokens
      if (Date.parse(t.xstsNotAfter) - Date.now() > EXPIRY_MARGIN_MS) return t
      try {
        if (Date.parse(t.msaExpiresAt) - Date.now() > EXPIRY_MARGIN_MS) {
          return { ...t, ...(await xboxLiveTokens(t.accessToken)) }
        }
        if (!t.refreshToken) return null
        const data = await msaToken(
          formBody({
            grant_type: 'refresh_token',
            refresh_token: t.refreshToken,
            scope: SCOPE,
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI
          })
        )
        return tokensFromMsa(data, t)
      } catch (err) {
        return refreshFailure(err, 'xbox', ctx.log)
      }
    },

    async displayName(tokens): Promise<string | undefined> {
      const t = tokens as XboxTokens
      return t.gamertag || undefined
    },

    async fetchOwned(tokens, ctx): Promise<OwnedGame[]> {
      const t = tokens as XboxTokens
      const data = await apiJson<TitleHubResponse>(
        `${TITLEHUB_URL}/users/xuid(${encodeURIComponent(t.xid)})/titles/titlehistory/decoration/detail,image,gamepass,productId?maxItems=10000`,
        { headers: serviceHeaders(t) },
        { store: 'Xbox' }
      )
      const games = mapTitleHistory(data)
      const titleIds = games.map((g) => String(g.extra?.titleId ?? '')).filter(Boolean)
      const minutes = await fetchStats(t, titleIds, ctx)
      for (const game of games) {
        const m = minutes.get(String(game.extra?.titleId ?? ''))
        if (m) game.storePlaytimeMinutes = m
      }
      ctx.log.info(
        `xbox: ${games.length} owned PC game(s) from the title history (${data.titles?.length ?? 0} titles)`
      )
      return games
    },

    installSpec(game: Game, client: ClientInfo): InstallSpec | null {
      const storeId = String(game.extra?.storeId ?? '').trim()
      if (!/^[A-Za-z0-9]+$/.test(storeId)) return null
      return client.installed
        ? { kind: 'uri', uri: `msxbox://game/?productId=${encodeURIComponent(storeId)}` }
        : { kind: 'uri', uri: `ms-windows-store://pdp/?ProductId=${encodeURIComponent(storeId)}` }
    },

    installError() {
      return tMain('mainAccounts.install.xboxNoId')
    }
  }
}

export const xboxAccount = createXboxAccount()
