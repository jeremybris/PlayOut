// The game page's Steam links (Store, Workshop, PCGamingWiki, Guides: the SteamLinksGrid right of the feature grid)
// and the in-app web viewer that shows them inside PlayOut's window (main/web-viewer). Shared so the renderer, main
// and the mock API build the same addresses and the same viewer state.
import type { Game } from './types'

/** The four links, in grid order: top left, top right, bottom left, bottom right. */
export const STEAM_LINK_KINDS = ['store', 'workshop', 'pcgamingwiki', 'guides'] as const
export type SteamLinkKind = (typeof STEAM_LINK_KINDS)[number]

export function isSteamLinkKind(value: unknown): value is SteamLinkKind {
  return typeof value === 'string' && (STEAM_LINK_KINDS as readonly string[]).includes(value)
}

/** A valid Steam app id (a positive whole number Steam could use). */
export function isSteamAppId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 2 ** 31
}

/**
 * The address of one link for a Steam app. PCGamingWiki: its own Steam-app-id redirect (github.com/PCGamingWiki/api,
 * `appid.php`), which sends the viewer to the game's wiki page.
 */
export function steamLinkUrl(kind: SteamLinkKind, appId: number): string {
  if (!isSteamAppId(appId)) throw new Error(`not a Steam app id: ${String(appId)}`)
  switch (kind) {
    case 'store':
      return `https://store.steampowered.com/app/${appId}/`
    case 'workshop':
      return `https://steamcommunity.com/app/${appId}/workshop/`
    case 'guides':
      return `https://steamcommunity.com/app/${appId}/guides/`
    case 'pcgamingwiki':
      return `https://www.pcgamingwiki.com/api/appid.php?appid=${appId}`
  }
}

/**
 * The Steam app a game's links are for: Steam games only (a paired host's Steam game too, when its app id came with
 * it), by `extra.steamAppId` or the Steam provider's external id. Null for every other game.
 */
export function steamLinksAppId(
  game: Pick<Game, 'source' | 'externalId' | 'extra'>
): number | null {
  if (game.source !== 'steam') return null
  // The first usable one: an empty or odd `extra.steamAppId` falls back to the external id.
  for (const raw of [game.extra?.steamAppId, game.externalId]) {
    const n = appIdOf(raw)
    if (n !== null) return n
  }
  return null
}

function appIdOf(raw: unknown): number | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN
  return isSteamAppId(n) ? n : null
}

/**
 * Whether the Workshop square shows: unless Steam said the app has no Workshop (its store category 30, read with the
 * Steam tags into `metadata.steamTags.workshop`). Not read yet (absent): shown.
 */
export function steamWorkshopShown(game: Pick<Game, 'metadata'>): boolean {
  return game.metadata.steamTags?.workshop !== false
}

/** What the viewer shows, sent with every change (event 'web-viewer:state'). */
export interface WebViewerState {
  open: boolean
  /** The link it was opened for (its square stays marked). */
  kind?: SteamLinkKind
  /** The page shown now, its title and host (the top bar). */
  url?: string
  title?: string
  host?: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** The page failed to load (no network): the bar says so; Reload tries again. */
  failed?: boolean
  /**
   * A link to another site the page asked for without the user clicking (a script's pop-up or redirect, a download):
   * not opened by itself; the bar offers it ('open-link' opens it in the default browser, 'dismiss-link' drops it).
   */
  held?: { url: string; host: string }
}

export const CLOSED_WEB_VIEWER: WebViewerState = {
  open: false,
  canGoBack: false,
  canGoForward: false,
  loading: false
}

/** The viewer's buttons (webViewerAction). */
export const WEB_VIEWER_ACTIONS = [
  'back',
  'forward',
  'reload',
  'external',
  'open-link',
  'dismiss-link'
] as const
export type WebViewerAction = (typeof WEB_VIEWER_ACTIONS)[number]

/** Where the page sits in PlayOut's window, in the renderer's CSS pixels (setWebViewerBounds). */
export interface WebViewerBounds {
  x: number
  y: number
  width: number
  height: number
}
