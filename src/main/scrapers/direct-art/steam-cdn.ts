// Steam CDN art by appid (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §5.2 and §13.7): pure URL templates,
// no request to build them. `library_600x900_2x.jpg` (600x900) exists for ~92 % of appids; the rest fall through to
// `library_600x900.jpg` (300x450, accepted as `small`) before the lane moves on. CDN hosts need no limiter.
import type { ArtKind } from '../../../shared/types'
import type { ArtCandidate, ArtCandidates, DirectArtSource } from '../types'

export const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps'

const SOURCE_ID = 'steam-cdn' as const

/** File names per kind on the CDN, best first. */
const FILES: Partial<Record<ArtKind, { name: string; width: number; height: number }[]>> = {
  cover: [
    { name: 'library_600x900_2x.jpg', width: 600, height: 900 },
    { name: 'library_600x900.jpg', width: 300, height: 450 }
  ],
  hero: [{ name: 'library_hero.jpg', width: 1920, height: 620 }],
  logo: [{ name: 'logo.png', width: 640, height: 360 }]
}

export function steamCdnUrl(appId: number, file: string): string {
  return `${STEAM_CDN}/${appId}/${file}`
}

/** The cover fallback chain for a Steam seed URL (`library_600x900_2x.jpg` 404 -> `library_600x900.jpg`), or []. */
export function steamCoverFallbacks(url: string): string[] {
  const match = /^(https?:\/\/[^/]+\/steam\/apps\/\d+)\/library_600x900_2x\.jpg(\?.*)?$/i.exec(url)
  return match ? [`${match[1]}/library_600x900.jpg`] : []
}

export function createSteamCdnSource(): DirectArtSource {
  return {
    id: SOURCE_ID,
    batchSize: 1,
    isConfigured: () => true,
    hasIdFor: (ids) => !!ids.steamAppId,
    async candidates(games, kinds) {
      const out = new Map<string, ArtCandidates>()
      for (const { game, ids } of games) {
        if (!ids.steamAppId) continue
        const result: ArtCandidates = {}
        for (const kind of kinds) {
          const files = FILES[kind]
          if (!files) continue
          result[kind] = files.map((f): ArtCandidate => ({
            kind,
            source: SOURCE_ID,
            url: steamCdnUrl(ids.steamAppId!, f.name),
            width: f.width,
            height: f.height
          }))
        }
        if (Object.keys(result).length) out.set(game.id, result)
      }
      return out
    }
  }
}
