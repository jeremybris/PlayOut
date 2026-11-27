// GOG image formatters by product id (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §7 and §13.7): the
// `images.gog-statics.com/<hash>` base either comes stored with the game (`extra.gogImage`, the owned import's
// `row.image`) or from one `gamesdb.gog.com/platforms/<platform>/external_releases/<id>` JSON per game, which also
// resolves EA / Origin and Ubisoft ids. `_glx_vertical_cover.jpg` is 342x482 (no `_2x` formatter exists), `_1600` is
// the hero, `_glx_square_icon_v2` the icon; `api.gog.com/v2/games/<id>` `boxArtImage` (171x241) is the last resort.
import type { ArtKind, Game } from '../../../shared/types'
import type { Logger } from '../../logger'
import { HttpError, httpJson, RateLimiter, redactUrl } from '../http'
import type { ArtCandidate, ArtCandidates, ArtIds, DirectArtSource } from '../types'

export const GAMESDB_BASE_URL = 'https://gamesdb.gog.com'
export const GOG_API_BASE_URL = 'https://api.gog.com'

const SOURCE_ID = 'gog-images' as const

type GamesDbPlatform = 'gog' | 'steam' | 'origin' | 'uplay'

/** `{ formatter, ext }` per kind, best first, applied to a `url_format` or a stored image base. */
const FORMATTERS: Partial<
  Record<ArtKind, { formatter: string; ext: string; width: number; height: number }[]>
> = {
  cover: [{ formatter: 'glx_vertical_cover', ext: 'jpg', width: 342, height: 482 }],
  hero: [{ formatter: '1600', ext: 'jpg', width: 1600, height: 650 }],
  icon: [{ formatter: 'glx_square_icon_v2', ext: 'jpg', width: 112, height: 112 }]
}

interface GamesDbImage {
  url_format?: string
}
interface GamesDbRelease {
  game?: {
    vertical_cover?: GamesDbImage
    background?: GamesDbImage
    square_icon?: GamesDbImage
    logo?: GamesDbImage
  }
  vertical_cover?: GamesDbImage
  background?: GamesDbImage
  square_icon?: GamesDbImage
  logo?: GamesDbImage
}
interface GogV2Game {
  _links?: { boxArtImage?: { href?: string } }
}

export interface GogImagesOptions {
  gamesDbBaseUrl?: string
  gogApiBaseUrl?: string
  /** Shared with other callers of the GOG hosts when the metadata service wires one in; default 5 req / s. */
  limiter?: RateLimiter
  /**
   * Also resolve plain Steam appids through gamesdb (one JSON per game). Off by default: `steam-cdn` already serves
   * them without a request, so this only pays off for the ~8 % of appids the CDN lacks.
   */
  includeSteam?: boolean
  log?: Logger
}

/**
 * `//images-4.gog-statics.com/<hash>` or `https://images.gog.com/<hash>{formatter}.{ext}?namespace=gamesdb` -> a
 * concrete image URL. gamesdb templates leave the `_` to the formatter; others carry it (`<hash>_{formatter}`).
 */
export function gogFormattedUrl(base: string, formatter: string, ext: string): string | undefined {
  let url = base.trim()
  if (!url) return undefined
  if (url.startsWith('//')) url = `https:${url}`
  if (!/^https?:\/\//.test(url)) return undefined
  if (url.includes('{formatter}')) {
    return url.replace(/_?\{formatter\}/, `_${formatter}`).replace('{ext}', ext)
  }
  return `${url}_${formatter}.${ext}`
}

/** The gamesdb platform and id a game can be resolved under, best first. */
export function gamesDbKeysOf(
  ids: ArtIds,
  includeSteam = false
): { platform: GamesDbPlatform; id: string }[] {
  const keys: { platform: GamesDbPlatform; id: string }[] = []
  if (ids.gogProductId) keys.push({ platform: 'gog', id: ids.gogProductId })
  if (ids.eaOfferId) keys.push({ platform: 'origin', id: ids.eaOfferId })
  if (ids.ubisoftId) keys.push({ platform: 'uplay', id: ids.ubisoftId })
  if (includeSteam && ids.steamAppId) keys.push({ platform: 'steam', id: String(ids.steamAppId) })
  return keys
}

function storedImage(game: Game): string | undefined {
  const value = game.extra?.gogImage
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function createGogImagesSource(options: GogImagesOptions = {}): DirectArtSource {
  const log = options.log
  const gamesDb = (options.gamesDbBaseUrl ?? GAMESDB_BASE_URL).replace(/\/+$/, '')
  const gogApi = (options.gogApiBaseUrl ?? GOG_API_BASE_URL).replace(/\/+$/, '')
  const limiter = options.limiter ?? new RateLimiter(5, 5)
  const includeSteam = options.includeSteam ?? false

  async function fetchJson<T>(url: string): Promise<T | null> {
    try {
      return await httpJson<T>(url, {}, { limiter, retries: 1, log })
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      log?.debug(`gog-images: ${redactUrl(url)}: ${(err as Error).message}`)
      return null
    }
  }

  /** Image bases per kind for a game: the stored hash first, then one gamesdb lookup. */
  async function bases(game: Game, ids: ArtIds): Promise<Partial<Record<ArtKind, string>>> {
    const stored = storedImage(game)
    if (stored) return { cover: stored, hero: stored, icon: stored }
    for (const key of gamesDbKeysOf(ids, includeSteam)) {
      const release = await fetchJson<GamesDbRelease>(
        `${gamesDb}/platforms/${key.platform}/external_releases/${encodeURIComponent(key.id)}`
      )
      if (!release) continue
      const images = release.game ?? release
      const out: Partial<Record<ArtKind, string>> = {}
      if (images.vertical_cover?.url_format) out.cover = images.vertical_cover.url_format
      if (images.background?.url_format) out.hero = images.background.url_format
      if (images.square_icon?.url_format) out.icon = images.square_icon.url_format
      if (Object.keys(out).length) return out
    }
    return {}
  }

  async function boxArt(ids: ArtIds): Promise<string | undefined> {
    if (!ids.gogProductId) return undefined
    const v2 = await fetchJson<GogV2Game>(
      `${gogApi}/v2/games/${encodeURIComponent(ids.gogProductId)}`
    )
    const href = v2?._links?.boxArtImage?.href
    return href && /^https?:\/\//.test(href) ? href : undefined
  }

  return {
    id: SOURCE_ID,
    batchSize: 1,
    isConfigured: () => true,
    hasIdFor: (ids) => gamesDbKeysOf(ids, includeSteam).length > 0,
    async candidates(games, kinds) {
      const out = new Map<string, ArtCandidates>()
      for (const { game, ids } of games) {
        if (!storedImage(game) && !gamesDbKeysOf(ids, includeSteam).length) continue
        const found = await bases(game, ids)
        const result: ArtCandidates = {}
        for (const kind of kinds) {
          const base = found[kind]
          const formatters = FORMATTERS[kind]
          if (!base || !formatters) continue
          const list: ArtCandidate[] = []
          for (const f of formatters) {
            const url = gogFormattedUrl(base, f.formatter, f.ext)
            if (url) list.push({ kind, source: SOURCE_ID, url, width: f.width, height: f.height })
          }
          if (list.length) result[kind] = list
        }
        if (kinds.includes('cover') && !result.cover) {
          const href = await boxArt(ids)
          if (href)
            result.cover = [
              { kind: 'cover', source: SOURCE_ID, url: href, width: 171, height: 241 }
            ]
        }
        if (Object.keys(result).length) out.set(game.id, result)
      }
      return out
    }
  }
}
