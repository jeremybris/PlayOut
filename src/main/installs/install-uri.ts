// Install URIs per store (docs/research/store-accounts.md §8 "Install URIs"). The URI is the `launch` of an owned,
// not installed game (ARCHITECTURE.md §3) and what `shell.openExternal` receives, so every scheme is allow-listed
// and the protocol-specific parts (app ids, product ids) are encoded before they enter the string.
import type { LaunchSpec, OwnedGame, StoreSourceId } from '../../shared/types'

/** The only schemes `installGame` hands to the shell; anything else is refused before `shell.openExternal`. */
export const ALLOWED_INSTALL_SCHEMES = [
  'steam:',
  'com.epicgames.launcher:',
  'goggalaxy:',
  'origin2:',
  'battlenet:',
  'uplay:',
  'msxbox:',
  'ms-windows-store:'
] as const

export function isAllowedInstallUri(uri: string): boolean {
  const match = /^([a-z][a-z0-9.+-]*:)/i.exec(uri)
  if (!match) return false
  const scheme = match[1].toLowerCase()
  return (ALLOWED_INSTALL_SCHEMES as readonly string[]).includes(scheme)
}

type IdSource = Pick<OwnedGame, 'externalId' | 'extra'>

function extraString(game: IdSource, key: string): string | undefined {
  const value = game.extra?.[key]
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text || undefined
}

/**
 * The protocol URI that opens the store client's install dialog for a game, or null when the store has no URI form
 * (Battle.net installs through the client exe, see `InstallService`) or the ids it needs are missing.
 */
export function installUriFor(source: StoreSourceId, game: IdSource): string | null {
  switch (source) {
    case 'steam': {
      const appId = extraString(game, 'steamAppId') ?? game.externalId
      return /^\d+$/.test(appId) ? `steam://install/${appId}` : null
    }
    case 'epic': {
      const appName = extraString(game, 'epicAppName') ?? game.externalId
      return appName
        ? `com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=install`
        : null
    }
    case 'gog': {
      const id = extraString(game, 'gogProductId') ?? game.externalId
      return /^\d+$/.test(id) ? `goggalaxy://openGameView/${id}` : null
    }
    case 'xbox': {
      const storeId = extraString(game, 'storeId')
      return storeId && /^[A-Za-z0-9]+$/.test(storeId)
        ? `msxbox://game/?productId=${encodeURIComponent(storeId)}`
        : null
    }
    case 'ea': {
      const contentId = extraString(game, 'contentId') ?? game.externalId
      return contentId && !contentId.startsWith('path:')
        ? `origin2://game/launch/?offerIds=${encodeURIComponent(contentId)}`
        : null
    }
    case 'ubisoft': {
      const id = extraString(game, 'ubisoftId') ?? game.externalId
      return /^\d+$/.test(id) ? `uplay://install/${id}` : null
    }
    case 'battlenet':
      return null
  }
}

/** Xbox's fallback when the Xbox app is missing: the Microsoft Store product page. */
export function msStoreUriFor(game: IdSource): string | null {
  const storeId = extraString(game, 'storeId')
  return storeId && /^[A-Za-z0-9]+$/.test(storeId)
    ? `ms-windows-store://pdp/?ProductId=${encodeURIComponent(storeId)}`
    : null
}

/**
 * The `launch` of an owned-only record (`mergeOwned`): the install URI, or for Battle.net a `battlenet://` URI the
 * install tracker rewrites into the client command (the launcher never runs it: `launchGame` refuses uninstalled
 * games). An unknown form falls back to the store's own library page so the record is never without a launch.
 */
export function installLaunchSpec(source: StoreSourceId, game: IdSource): LaunchSpec {
  const uri = installUriFor(source, game)
  if (uri) return { kind: 'uri', uri }
  if (source === 'battlenet') return { kind: 'uri', uri: `battlenet://${game.externalId}` }
  if (source === 'xbox') {
    const store = msStoreUriFor(game)
    if (store) return { kind: 'uri', uri: store }
  }
  return { kind: 'uri', uri: LIBRARY_PAGE[source] }
}

/** Each store client's own library view (the fallback `launch` of an owned record without usable ids). */
export const LIBRARY_PAGE: Record<StoreSourceId, string> = {
  steam: 'steam://open/games',
  epic: 'com.epicgames.launcher://store/library',
  gog: 'goggalaxy://openGameView',
  ea: 'origin2://library/open',
  battlenet: 'battlenet://',
  ubisoft: 'uplay://open',
  xbox: 'msxbox://'
}

/** Where each store client lists its downloads (paused there, since PlayOut cannot pause a store's download). */
export function storeDownloadsPage(source: StoreSourceId): string {
  return source === 'steam' ? 'steam://open/downloads' : LIBRARY_PAGE[source]
}

/**
 * "Delete from this PC" of a store game: the store client's own uninstall flow (it asks for confirmation itself). The
 * schemes are a separate allow-list: the install ones plus the one Windows Settings page Xbox games uninstall from.
 */
export const ALLOWED_UNINSTALL_URIS = {
  schemes: ['steam:', 'com.epicgames.launcher:', 'uplay:', 'origin2:', 'battlenet:', 'goggalaxy:'],
  /** Exact URIs allowed outside the schemes (Windows Settings has many pages; only Apps & features). */
  exact: ['ms-settings:appsfeatures']
} as const

export function isAllowedUninstallUri(uri: string): boolean {
  if ((ALLOWED_UNINSTALL_URIS.exact as readonly string[]).includes(uri.toLowerCase())) return true
  const match = /^([a-z][a-z0-9.+-]*:)/i.exec(uri)
  if (!match) return false
  return (ALLOWED_UNINSTALL_URIS.schemes as readonly string[]).includes(match[1].toLowerCase())
}

/**
 * The protocol URI that starts the store client's uninstall of a game, or null when the store has none (GOG runs
 * GalaxyClient.exe, EA and Battle.net the game's Add/Remove Programs entry: see `gogUninstallArgs`) or ids are missing.
 */
export function uninstallUriFor(source: StoreSourceId, game: IdSource): string | null {
  switch (source) {
    case 'steam': {
      const appId = extraString(game, 'steamAppId') ?? game.externalId
      return /^\d+$/.test(appId) ? `steam://uninstall/${appId}` : null
    }
    case 'epic': {
      const appName = extraString(game, 'epicAppName') ?? game.externalId
      return appName
        ? `com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=uninstall`
        : null
    }
    case 'ubisoft': {
      const id = extraString(game, 'ubisoftId') ?? game.externalId
      return /^\d+$/.test(id) ? `uplay://uninstall/${id}` : null
    }
    case 'xbox':
      // Store apps uninstall from Settings > Apps (no per-app URI).
      return 'ms-settings:appsfeatures'
    case 'gog':
    case 'ea':
    case 'battlenet':
      return null
  }
}

/** GalaxyClient.exe's uninstall command line (same form as its installGame), or null without a numeric product id. */
export function gogUninstallArgs(game: IdSource): string[] | null {
  const id = extraString(game, 'gogProductId') ?? game.externalId
  return /^\d+$/.test(id) ? ['/command=uninstall', `/gameId=${id}`] : null
}
