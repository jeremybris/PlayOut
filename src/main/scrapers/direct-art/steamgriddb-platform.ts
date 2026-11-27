// SteamGridDB by platform id (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §1 and §13.7): one
// `GET /grids/{platform}/<id,id,...>` per batch of 50 returns the top voted 600x900 grid per game without the
// name search; `/heroes`, `/logos` and `/icons` do the same for the full lane. Platforms: `steam` (appid),
// `egs` (Epic appName), `origin` (EA offer id), `bnet` (Battle.net product code), `uplay` (Ubisoft id).
import type { ArtKind, Settings } from '../../../shared/types'
import type { Logger } from '../../logger'
import { buildUrl, httpJson, RateLimiter, redactUrl } from '../http'
import { SGDB_BASE_URL, steamGridDbLimiter } from '../steamgriddb'
import type { ArtCandidate, ArtCandidates, ArtIds, DirectArtSource } from '../types'

export const SGDB_PLATFORM_BATCH = 50

const SOURCE_ID = 'steamgriddb-platform' as const

export type SgdbPlatform = 'steam' | 'egs' | 'origin' | 'bnet' | 'uplay'

/** Endpoint and filters per kind. */
const ENDPOINTS: Partial<Record<ArtKind, { path: string; dimensions?: string }>> = {
  cover: { path: 'grids', dimensions: '600x900' },
  hero: { path: 'heroes', dimensions: '1920x620,3840x1240' },
  logo: { path: 'logos' },
  icon: { path: 'icons' }
}

interface SgdbImage {
  id?: number
  score?: number
  url?: string
  width?: number
  height?: number
  nsfw?: boolean
  humor?: boolean
}
/** Single id: `data` is the image list; several ids: `data` is one `{ success, data }` per id in request order. */
interface SgdbResponse {
  success?: boolean
  data?: SgdbImage[] | { success?: boolean; data?: SgdbImage[] }[]
}

export interface SteamGridDbPlatformOptions {
  baseUrl?: string
  /** The token bucket; default `steamgriddb.ts`'s `steamGridDbLimiter`, shared with the scraper (tests inject their own). */
  limiter?: RateLimiter
  log?: Logger
}

/** The (platform, id) pairs a game can be looked up under, best first. */
export function sgdbKeysOf(ids: ArtIds): { platform: SgdbPlatform; id: string }[] {
  const keys: { platform: SgdbPlatform; id: string }[] = []
  if (ids.steamAppId) keys.push({ platform: 'steam', id: String(ids.steamAppId) })
  if (ids.epicAppName) keys.push({ platform: 'egs', id: ids.epicAppName })
  if (ids.eaOfferId) keys.push({ platform: 'origin', id: ids.eaOfferId })
  if (ids.battlenetCode) keys.push({ platform: 'bnet', id: ids.battlenetCode })
  if (ids.ubisoftId) keys.push({ platform: 'uplay', id: ids.ubisoftId })
  return keys
}

/** Per-id image lists in request order, for either response shape. Exported for tests. */
export function splitResponse(response: SgdbResponse, count: number): SgdbImage[][] {
  const data = response.data ?? []
  if (count === 1 && data.every((d) => !('data' in (d as object)) && !('success' in (d as object))))
    return [data as SgdbImage[]]
  return (data as { success?: boolean; data?: SgdbImage[] }[]).map((d) =>
    d?.success === false ? [] : (d?.data ?? [])
  )
}

function bestImage(images: SgdbImage[]): SgdbImage | undefined {
  return [...images]
    .filter((i) => i.url && !i.nsfw && !i.humor)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
}

export function createSteamGridDbPlatformSource(
  options: SteamGridDbPlatformOptions = {}
): DirectArtSource & { limiter: RateLimiter } {
  const log = options.log
  const baseUrl = (options.baseUrl ?? SGDB_BASE_URL).replace(/\/+$/, '')
  const limiter = options.limiter ?? steamGridDbLimiter

  function apiKey(settings: Settings): string {
    return settings.scrapers.steamgriddb.apiKey?.trim() ?? ''
  }

  return {
    id: SOURCE_ID,
    batchSize: SGDB_PLATFORM_BATCH,
    limiter,
    isConfigured: (settings) => apiKey(settings).length > 0,
    hasIdFor: (ids) => sgdbKeysOf(ids).length > 0,
    async candidates(games, kinds, settings) {
      const out = new Map<string, ArtCandidates>()
      const key = apiKey(settings)
      if (!key) return out
      // One request per platform and kind; a game is asked under its first platform id only.
      const byPlatform = new Map<SgdbPlatform, { id: string; gameId: string }[]>()
      for (const { game, ids } of games) {
        const first = sgdbKeysOf(ids)[0]
        if (!first) continue
        byPlatform.set(first.platform, [
          ...(byPlatform.get(first.platform) ?? []),
          { id: first.id, gameId: game.id }
        ])
      }
      for (const [platform, entries] of byPlatform) {
        for (const kind of kinds) {
          const endpoint = ENDPOINTS[kind]
          if (!endpoint) continue
          const url = buildUrl(
            `${baseUrl}/${endpoint.path}/${platform}/${entries.map((e) => encodeURIComponent(e.id)).join(',')}`,
            {
              dimensions: endpoint.dimensions,
              types: 'static',
              nsfw: 'false',
              humor: 'false',
              epilepsy: 'false'
            }
          )
          let response: SgdbResponse
          try {
            response = await httpJson<SgdbResponse>(
              url,
              { headers: { Authorization: `Bearer ${key}` } },
              { limiter, retries: 1, log }
            )
          } catch (err) {
            log?.debug(`steamgriddb-platform: ${redactUrl(url)}: ${(err as Error).message}`)
            continue
          }
          const lists = splitResponse(response, entries.length)
          entries.forEach((entry, i) => {
            const image = bestImage(lists[i] ?? [])
            if (!image?.url) return
            const candidate: ArtCandidate = {
              kind,
              source: SOURCE_ID,
              url: image.url,
              width: image.width,
              height: image.height
            }
            const result = out.get(entry.gameId) ?? {}
            result[kind] = [candidate]
            out.set(entry.gameId, result)
          })
        }
      }
      return out
    }
  }
}
