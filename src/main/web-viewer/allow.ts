// What the in-app web viewer (viewer.ts) may show. Pure, so the decisions are tested outside Electron.

/**
 * The sites the viewer shows itself: the Steam store and community (Store, Workshop, Guides) and PCGamingWiki (its
 * Steam-app-id redirect lands on www). Exact host names only: a look-alike (steamcommunity.com.evil.com,
 * evil-steamcommunity.com) is not one of them. Images, scripts and video the pages load from Steam's CDNs
 * (*.steamstatic.com, Akamai) are sub-resources, not navigations, and load as in any browser.
 */
export const WEB_VIEWER_HOSTS: readonly string[] = [
  'store.steampowered.com',
  'steamcommunity.com',
  'pcgamingwiki.com',
  'www.pcgamingwiki.com'
]

/**
 * What to do with an address the viewer's page navigates to or opens in a new window:
 * - 'allow': https on one of WEB_VIEWER_HOSTS (default port, no user name or password in it): shown in the viewer;
 * - 'external': any other http(s) address: opened in the user's default browser instead;
 * - 'block': everything else (data:, javascript:, file:, steam:, blob:, unparseable): never opened.
 */
export type WebViewerDecision = 'allow' | 'external' | 'block'

export function webViewerDecision(url: string): WebViewerDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'block'
  }
  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'https:' && protocol !== 'http:') return 'block'
  if (
    protocol === 'https:' &&
    !parsed.username &&
    !parsed.password &&
    parsed.port === '' &&
    WEB_VIEWER_HOSTS.includes(parsed.hostname.toLowerCase())
  )
    return 'allow'
  return 'external'
}

/** The longest address handed to the default browser (a page could make one up of any length). */
export const EXTERNAL_URL_MAX = 4096

/**
 * The address to give the default browser for one the page asked for: the canonical form the URL parser made of it
 * (the string that was checked, not the page's own spelling), http(s) only and of a sane length; null: none.
 */
export function externalHref(url: string): string | null {
  if (webViewerDecision(url) === 'block') return null
  let href: string
  try {
    href = new URL(url).href
  } catch {
    return null
  }
  return href.length <= EXTERNAL_URL_MAX ? href : null
}

/** The host shown in the viewer's top bar ('' for an address that does not parse). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** A scroll step from the renderer: a finite number of pixels, at most a few screens either way. */
export function clampScroll(deltaY: unknown): number {
  if (typeof deltaY !== 'number' || !Number.isFinite(deltaY)) return 0
  return Math.max(-5000, Math.min(5000, Math.round(deltaY)))
}
