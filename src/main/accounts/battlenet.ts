// Battle.net account: the cookie session of account.battle.net (Playnite BattleNetAccountClient). There is no token to
// store; the partition's cookies are the credential and the `/api/*` JSON documents are read through a hidden
// window on that partition. Owned titles map to products through resources/systems/battlenet-products.json
// (docs/research/store-accounts.md §5).
import { join } from 'path'
import type { ClientInfo, Game, OwnedGame } from '../../shared/types'
import type { Logger } from '../logger'
import { readJson } from '../util/fs'
import { loadJsonViaWindow } from './api'
import {
  SessionExpiredError,
  StoreUnavailableError,
  type AccountContext,
  type AccountTokens,
  type AuthWindow,
  type InstallSpec,
  type StoreAccount
} from './types'
import { tMain } from '../i18n'

export const BATTLENET_LOGIN_URL =
  'https://account.battle.net/oauth2/authorization/account-settings'
const API_URL = 'https://account.battle.net/api/'
const GAMES_URL = 'https://account.battle.net/api/games-and-subs'
const CLASSIC_URL = 'https://account.battle.net/api/classic-games'

export interface BattlenetTokens extends AccountTokens {
  kind: 'cookie'
  signedInAt: string
  accountId?: string
}

/** The product table rows this importer needs (the provider's `BattlenetProduct` plus `apiId`). */
export interface BattlenetProductRow {
  code: string
  uid: string
  name: string
  type: 'default' | 'classic'
  apiId?: number
  media?: { cover?: string; hero?: string; logo?: string; icon?: string }
}

export interface GamesAndSubs {
  gameAccounts?: {
    titleId?: number | string
    localizedGameName?: string
    gameAccountName?: string
  }[]
}

export interface ClassicGames {
  classicGames?: { localizedGameName?: string; regionalGameFranchiseIconFilename?: string }[]
}

export interface AccountApi {
  authenticated?: boolean
  accountId?: string | number | null
}

/** Sign-in is complete once the account site shows the overview (or its root). */
export function isSignedInUrl(url: string): boolean {
  return /^https:\/\/account\.battle\.net(\/|\/overview\/?)?(\?.*)?$/i.test(url)
}

export function isDeadSessionUrl(url: string): boolean {
  return (
    /^https:\/\/oauth\.battle\.net\/authorize/i.test(url) ||
    /^https:\/\/account\.battle\.net\/login/i.test(url)
  )
}

export async function loadProductRows(
  resourcesDir: string,
  log: Logger
): Promise<BattlenetProductRow[]> {
  const file = join(resourcesDir, 'battlenet-products.json')
  const data = await readJson<{ products?: unknown[] }>(file)
  if (!data || !Array.isArray(data.products)) {
    log.error(`battlenet: product table missing or invalid at ${file}`)
    return []
  }
  return data.products.filter(
    (p): p is BattlenetProductRow =>
      !!p &&
      typeof p === 'object' &&
      typeof (p as BattlenetProductRow).code === 'string' &&
      typeof (p as BattlenetProductRow).uid === 'string' &&
      typeof (p as BattlenetProductRow).name === 'string'
  )
}

function ownedFromProduct(product: BattlenetProductRow): OwnedGame {
  return {
    externalId: product.code,
    title: product.name,
    coverUrl: product.media?.cover,
    heroUrl: product.media?.hero,
    logoUrl: product.media?.logo,
    iconUrl: product.media?.icon,
    extra: { uid: product.uid, battlenetProductType: product.type }
  }
}

/**
 * games-and-subs + classic-games -> OwnedGame[]: one entry per product (several WoW accounts collapse), `titleId`
 * resolved through the table's `apiId` (first match wins for the shared AUKS/PNTA id), classic titles by icon name
 * (two Diablo II entries mean Lord of Destruction, two Warcraft III entries The Frozen Throne). Unknown ids are
 * reported in `unknown` for one log line.
 */
export function mapBattlenetOwned(
  games: GamesAndSubs | null,
  classic: ClassicGames | null,
  products: BattlenetProductRow[]
): { owned: OwnedGame[]; unknown: string[] } {
  const owned = new Map<string, OwnedGame>()
  const unknown: string[] = []
  for (const account of games?.gameAccounts ?? []) {
    const apiId = Number(account.titleId)
    if (!Number.isFinite(apiId)) continue
    const product = products.find((p) => p.type === 'default' && p.apiId === apiId)
    if (!product) {
      unknown.push(`${account.localizedGameName ?? '?'} (${apiId})`)
      continue
    }
    if (!owned.has(product.code)) owned.set(product.code, ownedFromProduct(product))
  }
  const counts = new Map<string, number>()
  for (const game of classic?.classicGames ?? []) {
    const icon = (game.regionalGameFranchiseIconFilename ?? '').toLowerCase()
    const key = icon.includes('diablo-ii') ? 'd2' : icon.includes('warcraft-iii') ? 'w3' : null
    if (!key) {
      unknown.push(`${game.localizedGameName ?? '?'} (classic)`)
      continue
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const classicCode = (base: string, expansion: string, count: number): string | null =>
    count >= 2 ? expansion : count === 1 ? base : null
  for (const code of [
    classicCode('D2', 'D2X', counts.get('d2') ?? 0),
    classicCode('W3', 'W3X', counts.get('w3') ?? 0)
  ]) {
    if (!code) continue
    const product = products.find((p) => p.code.toUpperCase() === code.toUpperCase())
    if (product && !owned.has(product.code)) owned.set(product.code, ownedFromProduct(product))
  }
  return { owned: [...owned.values()], unknown }
}

/** The client command Playnite's BnetInstallController / the GOG plugin send: the install dialog pre-selected. */
export function battlenetInstallSpec(clientExe: string, uid: string): InstallSpec {
  return { kind: 'exec', file: clientExe, args: ['--install', `--game=${uid}`] }
}

async function readAccountApi(hidden: AuthWindow): Promise<AccountApi | null> {
  return loadJsonViaWindow<AccountApi>(hidden, API_URL, 'Battle.net')
}

/** The sites the sign-in window may show. */
export const BATTLENET_SITES = ['battle.net', 'blizzard.com']

export function createBattlenetAccount(products: () => BattlenetProductRow[]): StoreAccount {
  return {
    source: 'battlenet',
    storeName: 'Battle.net',
    supported: true,
    get confirmMessage() {
      return tMain('mainAccounts.confirm.battlenet')
    },

    async signIn(win): Promise<AccountTokens | null> {
      const ok = await win.run<boolean>({
        url: BATTLENET_LOGIN_URL,
        allowedSites: BATTLENET_SITES,
        onNavigate: (ctx) => (isSignedInUrl(ctx.url) ? true : undefined)
      })
      if (!ok) return null
      const tokens: BattlenetTokens = { kind: 'cookie', signedInAt: new Date().toISOString() }
      return tokens
    },

    async refresh(tokens, ctx): Promise<AccountTokens | null> {
      // The authorization redirect re-mints the 30-minute SESSIONID from the oauth.battle.net SSO cookies; landing on
      // the authorize page means those are gone too. No landing at all (offline, timeout) says nothing.
      const alive = await ctx.hidden.run<boolean>({
        url: BATTLENET_LOGIN_URL,
        allowedSites: BATTLENET_SITES,
        onNavigate: (c) =>
          isDeadSessionUrl(c.url) ? false : isSignedInUrl(c.url) && c.loaded ? true : undefined
      })
      if (alive === false) return null
      if (alive === null)
        throw new StoreUnavailableError('Battle.net', tMain('mainAccounts.unavailable.accountPage'))
      const api = await readAccountApi(ctx.hidden)
      if (!api?.authenticated) return null
      return { ...tokens, accountId: api.accountId == null ? undefined : String(api.accountId) }
    },

    async displayName(tokens): Promise<string | undefined> {
      const t = tokens as BattlenetTokens
      return t.accountId ? `Account ${t.accountId}` : undefined
    },

    async fetchOwned(_tokens, ctx: AccountContext): Promise<OwnedGame[]> {
      const games = await loadJsonViaWindow<GamesAndSubs>(ctx.hidden, GAMES_URL, 'Battle.net')
      if (!games) throw new SessionExpiredError('Battle.net')
      const classic = await loadJsonViaWindow<ClassicGames>(ctx.hidden, CLASSIC_URL, 'Battle.net')
      const { owned, unknown } = mapBattlenetOwned(games, classic, products())
      if (unknown.length)
        ctx.log.info(`battlenet: ${unknown.length} unknown title(s) skipped: ${unknown.join(', ')}`)
      ctx.log.info(`battlenet: ${owned.length} owned game(s)`)
      return owned
    },

    installSpec(game: Game, client: ClientInfo): InstallSpec | null {
      if (!client.installed || !client.path) return null
      const product = products().find((p) => p.code === game.externalId)
      if (product?.type === 'classic') return null
      const uid = String(game.extra?.uid ?? product?.uid ?? '').trim()
      if (!/^[a-z0-9_]+$/i.test(uid)) return null
      return battlenetInstallSpec(client.path, uid)
    },

    installError(game, client) {
      if (!client.installed) return tMain('mainAccounts.install.battlenetMissing')
      const product = products().find((p) => p.code === game.externalId)
      if (product?.type === 'classic')
        return tMain('mainAccounts.install.battlenetClassic', { title: game.title })
      return tMain('mainAccounts.install.battlenetUnknown')
    }
  }
}
