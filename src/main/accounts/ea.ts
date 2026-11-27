// EA app account (experimental): the ea.com web session plus the bearer token the site's own SPA attaches to its
// Juno GraphQL calls (Jeshibu's EaLibrary flow). Owned games come from the `getPreloadedOwnedGames` persisted query;
// the legacy offer lookup gives the content id the installed-games provider uses (docs/research/store-accounts.md §6).
import type { ClientInfo, Game, OwnedGame } from '../../shared/types'
import { removeTrademarks } from '../util/text'
import { apiJson } from './api'
import {
  SessionExpiredError,
  StoreUnavailableError,
  type AccountContext,
  type AccountTokens,
  type InstallSpec,
  type StoreAccount
} from './types'
import { tMain } from '../i18n'

export const EA_LOGIN_URL = 'https://www.ea.com/login'
const EA_HOME_URL = 'https://www.ea.com/'
const TOKEN_PAGE_URL = 'https://www.ea.com/sales/deals'
const GRAPHQL_URL = 'https://service-aggregation-layer.juno.ea.com/graphql'
const GRAPHQL_FILTER = 'https://service-aggregation-layer.juno.ea.com/graphql*'
const OWNED_HASH = '779f1cd1355699752e20c0b3877847f4e3010ef5de131c248e98f8eff84f0718'
/** The SPA attaches its token to its first GraphQL call within a few seconds; Jeshibu gives up after 5 s. */
const TOKEN_CAPTURE_TIMEOUT_MS = 8_000
const LEGACY_BATCH = 50

export interface EaTokens extends AccountTokens {
  kind: 'cookie'
  signedInAt: string
  token?: string
  capturedAt?: string
}

export interface EaOwnedItem {
  id?: string
  originOfferId?: string
  product?: {
    id?: string
    name?: string
    gameSlug?: string
    baseItem?: { gameType?: string; title?: string; isLauncher?: boolean }
    gameProductUser?: { ownershipMethods?: string[]; initialEntitlementDate?: string }
  }
}

interface EaGraphqlError {
  message?: string
  extensions?: { code?: string }
}

export interface EaOwnedResponse {
  data?: {
    me?: {
      ownedGameProducts?: { next?: string | null; totalCount?: number; items?: EaOwnedItem[] }
    } | null
  }
  errors?: EaGraphqlError[]
}

export interface EaLegacyOffer {
  offerId?: string
  contentId?: string
  installCheckOverride?: string
  displayName?: string
  softwareId?: string
}

export interface EaLegacyResponse {
  data?: { legacyOffers?: (EaLegacyOffer | null)[] }
  errors?: EaGraphqlError[]
}

/**
 * GraphQL answers errors with HTTP 200. The merge deletes owned-only records the list leaves out, so any error means
 * the import stops here: a game whose lookup failed must not look like a game the user no longer owns.
 */
function throwOnGraphqlErrors(errors: EaGraphqlError[] | undefined): void {
  if (!errors?.length) return
  if (errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED'))
    throw new SessionExpiredError('EA')
  throw new StoreUnavailableError(
    tMain('mainAccounts.unavailable.eaSite'),
    errors[0].message ?? 'GraphQL error'
  )
}

/** EA Play / Game Pass / purchase: kept as a class in `extra.eaOwnership`. */
export function ownershipClass(methods: string[] | undefined): 'owned' | 'gamepass' | 'eaplay' {
  const list = (methods ?? []).map((m) => m.toUpperCase())
  if (list.includes('XGP_VAULT')) return 'gamepass'
  if (list.some((m) => m.includes('VAULT') || m.includes('SUBSCRIPTION'))) return 'eaplay'
  return 'owned'
}

export function ownedGamesUrl(next: string): string {
  const variables = {
    isMac: false,
    addFieldsToPreloadGames: true,
    locale: 'en',
    limit: 500,
    next,
    type: ['DIGITAL_FULL_GAME', 'PACKAGED_FULL_GAME'],
    entitlementEnabled: true,
    storefronts: ['EA', 'STEAM', 'EPIC'],
    ownershipMethods: [
      'UNKNOWN',
      'ASSOCIATION',
      'PURCHASE',
      'REDEMPTION',
      'GIFT_RECEIPT',
      'ENTITLEMENT_GRANT',
      'DIRECT_ENTITLEMENT',
      'PRE_ORDER_PURCHASE',
      'VAULT',
      'XGP_VAULT',
      'STEAM',
      'STEAM_VAULT',
      'STEAM_SUBSCRIPTION',
      'EPIC',
      'EPIC_VAULT',
      'EPIC_SUBSCRIPTION'
    ],
    platforms: ['PC']
  }
  const url = new URL(GRAPHQL_URL)
  url.searchParams.set('operationName', 'getPreloadedOwnedGames')
  url.searchParams.set('variables', JSON.stringify(variables))
  url.searchParams.set(
    'extensions',
    JSON.stringify({ persistedQuery: { version: 1, sha256Hash: OWNED_HASH } })
  )
  return url.toString()
}

const LEGACY_QUERY =
  'query getLegacyCatalogDefs($offerIds: [String!]!, $locale: Locale) { legacyOffers(offerIds: $offerIds, locale: $locale) { offerId: id contentId basePlatform installCheckOverride executePathOverride installationDirectory softwareId downloadPackageType dipManifestRelativePath displayName } }'

/** Base games only (`DIGITAL_FULL_GAME` already excludes DLC; launchers and non-base items are dropped here). */
export function filterOwnedItems(items: EaOwnedItem[]): EaOwnedItem[] {
  return items.filter((item) => {
    const base = item.product?.baseItem
    if (!item.originOfferId || !item.product?.name) return false
    if (base?.isLauncher) return false
    return (base?.gameType ?? 'BASE_GAME').toUpperCase() === 'BASE_GAME'
  })
}

/**
 * One OwnedGame per content id. Items whose legacy offer has no content id cannot be matched to the provider's
 * installed records and are skipped (returned in `skipped` for the log); an empty `installCheckOverride` marks a
 * Steam/Epic-storefront entitlement the EA app cannot install itself (`extra.eaManagedElsewhere`).
 */
export function mapEaOwned(
  items: EaOwnedItem[],
  offers: Map<string, EaLegacyOffer>
): { owned: OwnedGame[]; skipped: string[] } {
  const owned = new Map<string, OwnedGame>()
  const skipped: string[] = []
  for (const item of filterOwnedItems(items)) {
    const offer = offers.get(item.originOfferId!)
    const contentId = offer?.contentId?.trim()
    if (!contentId) {
      skipped.push(item.product?.name ?? item.originOfferId!)
      continue
    }
    if (owned.has(contentId)) continue
    const extra: Record<string, string | boolean> = {
      contentId,
      eaOfferId: item.originOfferId!,
      eaOwnership: ownershipClass(item.product?.gameProductUser?.ownershipMethods)
    }
    if (offer?.softwareId) extra.eaSoftwareId = offer.softwareId
    if (item.product?.gameSlug) extra.eaSlug = item.product.gameSlug
    if (!offer?.installCheckOverride?.trim()) extra.eaManagedElsewhere = true
    owned.set(contentId, {
      externalId: contentId,
      title: removeTrademarks(item.product!.name!.trim()),
      extra
    })
  }
  return { owned: [...owned.values()], skipped }
}

/** The sites the sign-in window may show (EA's sign-in lives on accounts.ea.com / signin.ea.com). */
export const EA_SITES = ['ea.com', 'origin.com']

/** The SPA sent the user to sign in: the cookie session is gone. */
export function isEaLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return (
      host === 'signin.ea.com' ||
      host === 'accounts.ea.com' ||
      (host.endsWith('ea.com') && /^\/login(\/|$)/i.test(parsed.pathname))
    )
  } catch {
    return false
  }
}

export function createEaAccount(): StoreAccount {
  /** The bearer, null when the page redirected to the sign-in (dead session); throws when nothing was seen. */
  async function mintToken(ctx: AccountContext): Promise<string | null> {
    const outcome = await ctx.hidden.run<{ token: string } | { dead: true }>({
      url: TOKEN_PAGE_URL,
      timeoutMs: TOKEN_CAPTURE_TIMEOUT_MS,
      allowedSites: EA_SITES,
      requestFilter: [GRAPHQL_FILTER],
      onNavigate: (page) => (isEaLoginUrl(page.url) ? { dead: true } : undefined),
      onRequest: (details) => {
        const auth = details.requestHeaders?.authorization
        const match = auth && /^Bearer\s+(\S+)$/i.exec(auth)
        return match ? { token: match[1] } : undefined
      }
    })
    if (!outcome)
      throw new StoreUnavailableError(
        tMain('mainAccounts.unavailable.eaSite'),
        tMain('mainAccounts.unavailable.noBearer')
      )
    return 'dead' in outcome ? null : outcome.token
  }

  async function fetchLegacyOffers(
    token: string,
    offerIds: string[]
  ): Promise<Map<string, EaLegacyOffer>> {
    const out = new Map<string, EaLegacyOffer>()
    for (let i = 0; i < offerIds.length; i += LEGACY_BATCH) {
      const batch = offerIds.slice(i, i + LEGACY_BATCH)
      const data = await apiJson<EaLegacyResponse>(
        GRAPHQL_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            query: LEGACY_QUERY,
            operationName: 'getLegacyCatalogDefs',
            variables: { locale: 'DEFAULT', offerIds: batch }
          })
        },
        { store: 'EA' }
      )
      throwOnGraphqlErrors(data.errors)
      const offers = data.data?.legacyOffers
      // A single null entry can be a delisted offer; a batch with no offers at all is a failed answer.
      if (!offers?.length)
        throw new StoreUnavailableError(
          tMain('mainAccounts.unavailable.eaSite'),
          tMain('mainAccounts.unavailable.noLegacyOffers')
        )
      for (const offer of offers) if (offer?.offerId) out.set(offer.offerId, offer)
    }
    return out
  }

  return {
    source: 'ea',
    storeName: 'EA app',
    supported: true,
    get confirmMessage() {
      return tMain('mainAccounts.confirm.ea')
    },

    async signIn(win): Promise<AccountTokens | null> {
      const ok = await win.run<boolean>({
        url: EA_LOGIN_URL,
        allowedSites: EA_SITES,
        onNavigate: (ctx) =>
          ctx.url === EA_HOME_URL || ctx.url === EA_HOME_URL.slice(0, -1) ? true : undefined
      })
      if (!ok) return null
      const tokens: EaTokens = { kind: 'cookie', signedInAt: new Date().toISOString() }
      return tokens
    },

    async refresh(tokens, ctx): Promise<AccountTokens | null> {
      const token = await mintToken(ctx)
      if (!token) return null
      const t = tokens as EaTokens
      const next: EaTokens = { ...t, kind: 'cookie', token, capturedAt: new Date().toISOString() }
      return next
    },

    async displayName(): Promise<string | undefined> {
      return undefined
    },

    async fetchOwned(tokens, ctx): Promise<OwnedGame[]> {
      const t = tokens as EaTokens
      if (!t.token) throw new SessionExpiredError('EA')
      const items: EaOwnedItem[] = []
      let next: string | null | undefined = '0'
      for (let page = 0; page < 50 && next != null; page++) {
        const data = await apiJson<EaOwnedResponse>(
          ownedGamesUrl(next),
          { headers: { Authorization: `Bearer ${t.token}` } },
          { store: 'EA' }
        )
        throwOnGraphqlErrors(data.errors)
        const products = data.data?.me?.ownedGameProducts
        if (!Array.isArray(products?.items))
          throw new StoreUnavailableError(
            tMain('mainAccounts.unavailable.eaSite'),
            tMain('mainAccounts.unavailable.noOwnedList')
          )
        items.push(...products.items)
        next = products.next ?? null
      }
      const offerIds = [...new Set(filterOwnedItems(items).map((i) => i.originOfferId!))]
      const offers = await fetchLegacyOffers(t.token, offerIds)
      const { owned, skipped } = mapEaOwned(items, offers)
      if (skipped.length) ctx.log.info(`ea: ${skipped.length} item(s) without a content id skipped`)
      ctx.log.info(`ea: ${owned.length} owned game(s) (${items.length} items)`)
      return owned
    },

    installSpec(game: Game, client: ClientInfo): InstallSpec | null {
      if (!client.installed || game.extra?.eaManagedElsewhere === true) return null
      // `game/download` only ever installs; `game/launch` would start a game the EA app already has when PlayOut's
      // record is stale (installed in the EA app since the last scan). The account import always knows the offer id.
      const offerId = String(game.extra?.eaOfferId ?? '').trim()
      if (offerId)
        return {
          kind: 'uri',
          uri: `origin2://game/download?offerId=${encodeURIComponent(offerId)}`
        }
      const contentId = String(game.extra?.contentId ?? game.externalId).trim()
      if (!contentId || contentId.startsWith('path:')) return null
      return {
        kind: 'uri',
        uri: `origin2://game/launch/?offerIds=${encodeURIComponent(contentId)}`
      }
    },

    installError(game, client) {
      if (!client.installed) return tMain('mainAccounts.install.eaMissing')
      if (game.extra?.eaManagedElsewhere === true) return tMain('mainAccounts.install.otherStore')
      return tMain('mainAccounts.install.eaNoId')
    }
  }
}

export const eaAccount = createEaAccount()
