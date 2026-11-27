// Real, keyless Steam CDN artwork for the mock library. URL patterns are the ones verified in
// docs/research/metadata-apis.md §5.2 (every app id used by the mock was HEAD-checked on 2026-10-29).
import type { GameMedia } from '@shared/types'

const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps'
const STORE_ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps'

/**
 * Cover (600x900), hero (1920x620), logo (transparent PNG) and optional screenshots for a Steam app id.
 * Screenshots are given as store hashes; a leading '+' marks the newer upload layout that lives in a `{hash}/` sub-folder.
 */
export function steamArt(appId: number, screenshots: string[] = []): GameMedia {
  const media: GameMedia = {
    cover: `${CDN}/${appId}/library_600x900_2x.jpg`,
    hero: `${CDN}/${appId}/library_hero.jpg`,
    logo: `${CDN}/${appId}/logo.png`
  }
  if (screenshots.length)
    media.screenshots = screenshots.map((hash) => steamScreenshot(appId, hash))
  return media
}

/** 1920x1080 store screenshot by hash; '+hash' selects the nested `{appid}/{hash}/ss_{hash}` layout. */
export function steamScreenshot(appId: number, hash: string): string {
  const nested = hash.startsWith('+')
  const clean = nested ? hash.slice(1) : hash
  const dir = nested ? `${appId}/${clean}` : `${appId}`
  return `${STORE_ASSETS}/${dir}/ss_${clean}.1920x1080.jpg`
}

export function steamHeader(appId: number): string {
  return `${CDN}/${appId}/header.jpg`
}

export function steamStoreUrl(appId: number): string {
  return `https://store.steampowered.com/app/${appId}`
}

/** file:// URL for a Windows path, the way the renderer would receive a user-chosen image outside the media cache. */
export function fileUrl(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/')
  const withSlash = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized
  return `file://${encodeURI(withSlash)}`
}
