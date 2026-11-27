// Epic Games account: the Epic Games Launcher's own authorization-code flow (Playnite EpicAccountClient, legendary),
// library items + catalog bulk lookup for titles, art and filters (docs/research/store-accounts.md §2).
import type { ClientInfo, Game, OwnedGame } from '../../shared/types'
import { removeTrademarks } from '../util/text'
import { apiJson, formBody, OPTIONAL_CALL_RETRY, refreshFailure } from './api'
import {
  describeError,
  SessionExpiredError,
  type AccountContext,
  type AccountTokens,
  type StoreAccount
} from './types'
import { tMain } from '../i18n'

/** base64 of `<client id>:<client secret>` of the public Epic Games Launcher client (id 34a02cf8f4414e29b15921876da36f9a). */
const CLIENT_BASIC =
  'MzRhMDJjZjhmNDQxNGUyOWIxNTkyMTg3NmRhMzZmOWE6ZGFhZmJjY2M3Mzc3NDUwMzlkZmZlNTNkOTRmYzc2Y2Y='
/**
 * Epic's sign-in page in the Launcher's own flow (Playnite, Heroic): no redirectUrl, which Epic now answers with
 * "Invalid Client: Redirect URL is not known to the client". With the Launcher's user agent, a signed-in page goes to
 * the Launcher's registered address, http://localhost/launcher/authorized?code=<code>, and the code is read from there.
 */
export const EPIC_LOGIN_URL = 'https://www.epicgames.com/id/login?responseType=code'
/** Playnite: "needed otherwise captcha won't pass". */
export const EPIC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EpicGamesLauncher'
const ACCOUNT_HOST = 'https://account-public-service-prod03.ol.epicgames.com'
const CATALOG_HOST = 'https://catalog-public-service-prod06.ol.epicgames.com'
const LIBRARY_HOST = 'https://library-service.live.use1a.on.epicgames.com'
const TOKEN_URL = `${ACCOUNT_HOST}/account/api/oauth/token`
/** Refresh this long before `expiresAt`. */
const EXPIRY_MARGIN_MS = 60_000
const CATALOG_BATCH = 50

export interface EpicTokens extends AccountTokens {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  /** ISO. */
  expiresAt: string
  refreshExpiresAt?: string
  accountId: string
  displayName?: string
}

export interface EpicTokenResponse {
  access_token?: string
  expires_in?: number
  expires_at?: string
  refresh_token?: string
  refresh_expires?: number
  refresh_expires_at?: string
  account_id?: string
  displayName?: string
  errorCode?: string
  errorMessage?: string
}

export interface EpicLibraryRecord {
  appName?: string
  namespace?: string
  catalogItemId?: string
  sandboxType?: string
  buildVersion?: string
}

export interface EpicLibraryPage {
  responseMetadata?: { nextCursor?: string | null }
  records?: EpicLibraryRecord[]
}

export interface EpicCatalogItem {
  id?: string
  title?: string
  developer?: string
  keyImages?: { type?: string; url?: string }[]
  categories?: { path?: string }[]
  customAttributes?: Record<string, { type?: string; value?: string }>
  mainGameItem?: { id?: string } | null
  entitlementType?: string
  releaseInfo?: { appId?: string; dateAdded?: string }[]
}

export interface EpicPlaytimeEntry {
  artifactId?: string
  /** Seconds. */
  totalTime?: number
}

/** `/id/api/redirect` renders JSON; Playnite regex-matches the code, PlayOut parses the JSON first. */
export function parseRedirectDocument(text: string): string | null {
  const trimmed = text.trim()
  try {
    const json = JSON.parse(trimmed) as { authorizationCode?: string | null; redirectUrl?: string }
    if (typeof json.authorizationCode === 'string' && /^[A-Za-z0-9]+$/.test(json.authorizationCode))
      return json.authorizationCode
    const fromUrl = /localhost\/launcher\/authorized\?code=([A-Za-z0-9]+)/.exec(
      json.redirectUrl ?? ''
    )
    if (fromUrl) return fromUrl[1]
  } catch {
    /* not JSON */
  }
  const match = /localhost\/launcher\/authorized\?code=([A-Za-z0-9]+)/.exec(trimmed)
  return match ? match[1] : null
}

export function mapTokenResponse(data: EpicTokenResponse, previous?: EpicTokens): EpicTokens {
  if (data.errorCode || !data.access_token || !data.account_id)
    throw new Error(data.errorMessage || data.errorCode || tMain('mainAccounts.token.epic'))
  const expiresAt =
    data.expires_at ?? new Date(Date.now() + (data.expires_in ?? 8 * 3600) * 1000).toISOString()
  const refreshExpiresAt =
    data.refresh_expires_at ??
    (data.refresh_expires
      ? new Date(Date.now() + data.refresh_expires * 1000).toISOString()
      : undefined)
  return {
    kind: 'oauth',
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt,
    refreshExpiresAt,
    accountId: data.account_id,
    displayName: data.displayName ?? previous?.displayName
  }
}

/** Playnite's pre-filter: no Unreal Engine namespace, no private sandboxes, an app name. */
export function filterLibraryRecords(records: EpicLibraryRecord[]): EpicLibraryRecord[] {
  return records.filter(
    (r) =>
      !!r.appName?.trim() &&
      r.namespace !== 'ue' &&
      (r.sandboxType ?? '').toUpperCase() !== 'PRIVATE' &&
      !!r.catalogItemId &&
      !!r.namespace
  )
}

const SKIP_CATEGORIES = new Set(['digitalextras', 'plugins', 'plugins/engine', 'mods'])

/** Why a catalog item is not an installable game of its own (Playnite + lutris rules), or null when it is one. */
export function catalogSkipReason(item: EpicCatalogItem): string | null {
  const paths = (item.categories ?? []).map((c) => (c.path ?? '').toLowerCase())
  if (!paths.includes('applications')) return 'not an application'
  for (const p of paths) if (SKIP_CATEGORIES.has(p)) return p
  if (item.mainGameItem && !paths.includes('addons/launchable')) return 'add-on of another game'
  if ((item.entitlementType ?? '').toUpperCase() === 'AUDIENCE') return 'audience entitlement'
  const attrs = item.customAttributes ?? {}
  const attr = (name: string): string =>
    (Object.entries(attrs).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]?.value ?? '')
      .toLowerCase()
      .trim()
  if (attr('ThirdPartyManagedApp') === 'the ea app') return 'managed by the EA app'
  if (attr('partnerLinkType') === 'ubisoft') return 'managed by Ubisoft Connect'
  if (attr('ListingIdentifier')) return 'Fab listing'
  return null
}

function keyImage(item: EpicCatalogItem, type: string): string | undefined {
  const url = item.keyImages?.find((k) => k.type === type && k.url)?.url
  if (!url) return undefined
  return /^https?:\/\//.test(url) ? url : undefined
}

export function mapCatalogItem(record: EpicLibraryRecord, item: EpicCatalogItem): OwnedGame {
  const appName = record.appName!.trim()
  const title = removeTrademarks(item.title?.trim() || appName)
  const cover = keyImage(item, 'DieselGameBoxTall')
  const game: OwnedGame = {
    externalId: appName,
    title,
    coverUrl: cover ? `${cover}?w=600&h=900&resize=1` : undefined,
    heroUrl: keyImage(item, 'DieselGameBox'),
    logoUrl: keyImage(item, 'DieselGameBoxLogo'),
    developer: item.developer?.trim() || undefined,
    extra: {
      epicAppName: appName,
      epicNamespace: record.namespace!,
      epicCatalogItemId: record.catalogItemId!
    }
  }
  const released =
    item.releaseInfo?.find((r) => r.appId === appName)?.dateAdded ??
    item.releaseInfo?.[0]?.dateAdded
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(released ?? '')
  if (date) game.releaseDate = date[1]
  return game
}

/** The sites the sign-in window may show. */
export const EPIC_SITES = ['epicgames.com']

/**
 * The authorization code from the Launcher's redirect address (`http://localhost/launcher/authorized?code=…`), which
 * Epic sends a signed-in sign-in page to; null for any other address. Nothing listens there: the sign-in window blocks
 * the navigation and only reads the code from it.
 */
export function launcherRedirectCode(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host !== 'localhost' && host !== '127.0.0.1') return null
    if (parsed.pathname.toLowerCase().replace(/\/+$/, '') !== '/launcher/authorized') return null
    const code = parsed.searchParams.get('code') ?? ''
    return /^[A-Za-z0-9]+$/.test(code) ? code : null
  } catch {
    return null
  }
}

/** Only Epic's own redirect document is parsed for the code, never a look-alike path on another host. */
export function isRedirectPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.hostname.toLowerCase() === 'www.epicgames.com' &&
      parsed.pathname.toLowerCase().startsWith('/id/api/redirect')
    )
  } catch {
    return false
  }
}

export function epicInstallUri(appName: string): string {
  return `com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=install`
}

async function postToken(body: string): Promise<EpicTokenResponse> {
  return apiJson<EpicTokenResponse>(
    TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `basic ${CLIENT_BASIC}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    },
    { store: 'Epic Games', authStatuses: [400, 401, 403] }
  )
}

function bearer(tokens: EpicTokens): RequestInit {
  return { headers: { Authorization: `bearer ${tokens.accessToken}` } }
}

export function createEpicAccount(): StoreAccount {
  async function fetchLibrary(tokens: EpicTokens): Promise<EpicLibraryRecord[]> {
    const records: EpicLibraryRecord[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < 200; page++) {
      const url = new URL(`${LIBRARY_HOST}/library/api/public/items`)
      url.searchParams.set('includeMetadata', 'true')
      url.searchParams.set('platform', 'Windows')
      if (cursor) url.searchParams.set('cursor', cursor)
      const data = await apiJson<EpicLibraryPage>(url.toString(), bearer(tokens), {
        store: 'Epic Games'
      })
      records.push(...(data.records ?? []))
      cursor = data.responseMetadata?.nextCursor
      if (!cursor) break
    }
    return filterLibraryRecords(records)
  }

  async function fetchCatalog(
    tokens: EpicTokens,
    records: EpicLibraryRecord[],
    ctx: AccountContext
  ): Promise<Map<string, EpicCatalogItem>> {
    const items = new Map<string, EpicCatalogItem>()
    const byNamespace = new Map<string, string[]>()
    for (const r of records) {
      const list = byNamespace.get(r.namespace!) ?? []
      if (!list.includes(r.catalogItemId!)) list.push(r.catalogItemId!)
      byNamespace.set(r.namespace!, list)
    }
    for (const [namespace, ids] of byNamespace) {
      for (let i = 0; i < ids.length; i += CATALOG_BATCH) {
        const url = new URL(
          `${CATALOG_HOST}/catalog/api/shared/namespace/${encodeURIComponent(namespace)}/bulk/items`
        )
        for (const id of ids.slice(i, i + CATALOG_BATCH)) url.searchParams.append('id', id)
        url.searchParams.set('country', 'US')
        url.searchParams.set('locale', 'en-US')
        url.searchParams.set('includeMainGameDetails', 'true')
        // A failed batch would make every record in it "skipped" and drop its games from the owned list, so the
        // whole import fails instead and the previous list stays (retried on the next import).
        try {
          const data = await apiJson<Record<string, EpicCatalogItem>>(
            url.toString(),
            bearer(tokens),
            {
              store: 'Epic Games'
            }
          )
          for (const [id, item] of Object.entries(data)) items.set(`${namespace}:${id}`, item)
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err
          ctx.log.warn(`epic: catalog lookup failed for ${namespace}: ${describeError(err)}`)
          throw new Error(`Epic catalog lookup failed: ${describeError(err)}`, { cause: err })
        }
      }
    }
    return items
  }

  async function fetchPlaytime(
    tokens: EpicTokens,
    ctx: AccountContext
  ): Promise<Map<string, number>> {
    const minutes = new Map<string, number>()
    try {
      const data = await apiJson<EpicPlaytimeEntry[]>(
        `${LIBRARY_HOST}/library/api/public/playtime/account/${encodeURIComponent(tokens.accountId)}/all`,
        bearer(tokens),
        // Optional data: the quick retries, not the owned import's slow ones.
        { store: 'Epic Games', ...OPTIONAL_CALL_RETRY }
      )
      for (const entry of Array.isArray(data) ? data : [])
        if (entry.artifactId && typeof entry.totalTime === 'number')
          minutes.set(entry.artifactId, Math.round(entry.totalTime / 60))
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err
      ctx.log.debug(`epic: playtime unavailable: ${describeError(err)}`)
    }
    return minutes
  }

  return {
    source: 'epic',
    storeName: 'Epic Games Launcher',
    supported: true,
    get confirmMessage() {
      return tMain('mainAccounts.confirm.epic')
    },

    async signIn(win): Promise<AccountTokens | null> {
      const code = await win.run<string>({
        url: EPIC_LOGIN_URL,
        userAgent: EPIC_USER_AGENT,
        allowedSites: EPIC_SITES,
        async onNavigate(ctx) {
          // The Launcher's redirect address carries the code (read before the window blocks the navigation).
          const fromRedirect = launcherRedirectCode(ctx.url)
          if (fromRedirect) return fromRedirect
          // Older flow: Epic's JSON redirect document, should Epic send the page there.
          if (!ctx.loaded || !isRedirectPage(ctx.url)) return undefined
          const text = await ctx.executeJavaScript<string>(
            'document.body ? document.body.innerText : ""'
          )
          return parseRedirectDocument(text ?? '') ?? undefined
        }
      })
      if (!code) return null
      const data = await postToken(
        formBody({ grant_type: 'authorization_code', code, token_type: 'eg1' })
      )
      return mapTokenResponse(data)
    },

    async refresh(tokens, ctx): Promise<AccountTokens | null> {
      const t = tokens as EpicTokens
      if (Date.parse(t.expiresAt) - Date.now() > EXPIRY_MARGIN_MS) return t
      if (!t.refreshToken) return null
      try {
        const data = await postToken(
          formBody({
            grant_type: 'refresh_token',
            refresh_token: t.refreshToken,
            token_type: 'eg1'
          })
        )
        return mapTokenResponse(data, t)
      } catch (err) {
        return refreshFailure(err, 'epic', ctx.log)
      }
    },

    async displayName(tokens, ctx): Promise<string | undefined> {
      const t = tokens as EpicTokens
      if (t.displayName) return t.displayName
      try {
        const data = await apiJson<{ id?: string; displayName?: string }>(
          `${ACCOUNT_HOST}/account/api/public/account/${encodeURIComponent(t.accountId)}`,
          bearer(t),
          { store: 'Epic Games' }
        )
        return data.displayName?.trim() || undefined
      } catch (err) {
        ctx.log.debug(`epic: account lookup failed: ${describeError(err)}`)
        return undefined
      }
    },

    async fetchOwned(tokens, ctx): Promise<OwnedGame[]> {
      const t = tokens as EpicTokens
      const records = await fetchLibrary(t)
      const catalog = await fetchCatalog(t, records, ctx)
      const playtime = await fetchPlaytime(t, ctx)
      const owned: OwnedGame[] = []
      const seen = new Set<string>()
      let skipped = 0
      for (const record of records) {
        const key = record.appName!.trim().toLowerCase()
        if (seen.has(key)) continue
        const item = catalog.get(`${record.namespace}:${record.catalogItemId}`)
        if (!item) {
          skipped++
          continue
        }
        const reason = catalogSkipReason(item)
        if (reason) {
          skipped++
          ctx.log.debug(`epic: ${record.appName}: skipped, ${reason}`)
          continue
        }
        seen.add(key)
        const game = mapCatalogItem(record, item)
        const minutes = playtime.get(game.externalId)
        if (minutes) game.storePlaytimeMinutes = minutes
        owned.push(game)
      }
      ctx.log.info(`epic: ${owned.length} owned game(s), ${skipped} library items skipped`)
      return owned
    },

    installSpec(game: Game, client: ClientInfo) {
      if (!client.installed) return null
      const appName = String(game.extra?.epicAppName ?? game.externalId).trim()
      return appName ? { kind: 'uri', uri: epicInstallUri(appName) } : null
    },

    installError(_game, client) {
      return client.installed
        ? tMain('mainAccounts.install.epicNoId')
        : tMain('mainAccounts.install.epicMissing')
    }
  }
}

export const epicAccount = createEpicAccount()
