// SteamGridDB API v2 (docs/research/metadata-apis.md section 1): artwork only - grids (covers), heroes, logos, icons.
import type { ArtKind, Game, MetadataCandidate, Settings } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { buildUrl, HttpError, httpJson, RateLimiter, serviceError, toError } from './http'
import { sameTitleKey } from './candidate-match'
import { searchNameFor } from './platform-ids'
import type { ScrapedMedia, ScrapedResult, Scraper } from './types'

export const SGDB_BASE_URL = 'https://www.steamgriddb.com/api/v2'
const SERVICE = 'SteamGridDB'
const MAX_CANDIDATES = 15

interface SgdbGame {
  id: number
  name: string
  types?: string[]
  verified?: boolean
  /** Unix seconds. */
  release_date?: number
}

interface SgdbImage {
  id: number
  score?: number
  style?: string
  url: string
  thumb?: string
  width?: number
  height?: number
  mime?: string
  language?: string
  upvotes?: number
  downvotes?: number
}

interface SgdbResponse<T> {
  success: boolean
  data?: T
  errors?: string[]
}

type ImageKind = 'grids' | 'heroes' | 'logos' | 'icons'
const IMAGE_KIND_OF: Partial<Record<ArtKind, ImageKind>> = {
  cover: 'grids',
  hero: 'heroes',
  logo: 'logos',
  icon: 'icons'
}

/** Filters shared by every image list: static, family-friendly images only. */
const COMMON_IMAGE_PARAMS = { types: 'static', nsfw: 'false', humor: 'false', epilepsy: 'false' }

const IMAGE_QUERIES: Record<ImageKind, Record<string, string>> = {
  grids: {
    dimensions: '600x900,342x482,660x930',
    mimes: 'image/png,image/jpeg,image/webp',
    limit: '20'
  },
  heroes: {
    dimensions: '1920x620,3840x1240,1600x650',
    mimes: 'image/png,image/jpeg,image/webp',
    limit: '10'
  },
  logos: { mimes: 'image/png,image/webp', limit: '10' },
  icons: { mimes: 'image/png,image/vnd.microsoft.icon', limit: '10' }
}

/** Preferred (width, height) order per kind; images keep the API's score order within the same rank. */
const PREFERRED_SIZES: Partial<Record<ImageKind, [number, number][]>> = {
  grids: [
    [600, 900],
    [660, 930],
    [342, 482]
  ],
  heroes: [
    [1920, 620],
    [3840, 1240],
    [1600, 650]
  ]
}

export interface SteamGridDbOptions {
  baseUrl?: string
  limiter?: RateLimiter
  log?: Logger
}

function unixToIsoDate(seconds: number | undefined): string | undefined {
  if (!seconds || !Number.isFinite(seconds)) return undefined
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

/** The Steam app id to resolve the game by, when the game came from Steam. */
function steamAppIdOf(game: Pick<Game, 'source' | 'externalId' | 'extra'>): string | undefined {
  const fromExtra = game.extra?.steamAppId
  const id =
    fromExtra !== undefined && fromExtra !== null && fromExtra !== ''
      ? String(fromExtra)
      : game.source === 'steam'
        ? game.externalId
        : undefined
  return id && /^\d+$/.test(id) ? id : undefined
}

function rankOf(kind: ImageKind, image: SgdbImage): number {
  if (kind === 'logos') return image.mime === 'image/png' ? 0 : 1
  if (kind === 'icons') {
    const png = image.mime === 'image/png' ? 0 : 10
    const width = image.width ?? 0
    // Prefer crisp 128-512 px icons; tiny or huge ones only as a fallback.
    const sizeRank = width >= 128 && width <= 512 ? 0 : width > 512 ? 1 : 2
    return png + sizeRank
  }
  const sizes = PREFERRED_SIZES[kind] ?? []
  const index = sizes.findIndex(([w, h]) => w === image.width && h === image.height)
  return index === -1 ? sizes.length : index
}

/** Best image of a list: preferred size / format first, then the API's own score order. */
export function pickImage(kind: ImageKind, images: SgdbImage[]): SgdbImage | undefined {
  return images
    .map((image, index) => ({ image, index, rank: rankOf(kind, image) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.image
}

function describe(err: HttpError): string | undefined {
  if (err.status === 401) return 'invalid API key'
  if (err.status === 403) return 'access denied; check the API key'
  if (err.status === 404) return 'not found'
  if (err.status === 400) return `bad request${err.body ? ` (${err.body.slice(0, 120)})` : ''}`
  return undefined
}

export function createSteamGridDbScraper(options: SteamGridDbOptions = {}): Scraper {
  const baseUrl = (options.baseUrl ?? SGDB_BASE_URL).replace(/\/+$/, '')
  const limiter = options.limiter ?? new RateLimiter(3, 3)
  const log = options.log ?? createLogger('scrapers:steamgriddb')

  function apiKey(settings: Settings): string {
    return settings.scrapers.steamgriddb.apiKey?.trim() ?? ''
  }

  function isConfigured(settings: Settings): boolean {
    return apiKey(settings).length > 0
  }

  async function get<T>(
    settings: Settings,
    path: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const url = buildUrl(`${baseUrl}${path}`, params)
    let body: SgdbResponse<T>
    try {
      body = await httpJson<SgdbResponse<T>>(
        url,
        { headers: { Authorization: `Bearer ${apiKey(settings)}` } },
        { limiter, log }
      )
    } catch (err) {
      throw err instanceof HttpError ? serviceError(SERVICE, err, describe) : toError(err)
    }
    if (!body.success || body.data === undefined) {
      throw new HttpError(`${SERVICE}: ${body.errors?.join('; ') || 'request failed'}`, {
        status: 200,
        url
      })
    }
    return body.data
  }

  function toCandidate(game: SgdbGame): MetadataCandidate {
    return {
      scraper: 'steamgriddb',
      externalId: String(game.id),
      title: game.name,
      releaseDate: unixToIsoDate(game.release_date)
    }
  }

  async function bySteamAppId(
    settings: Settings,
    appId: string
  ): Promise<MetadataCandidate | null> {
    try {
      return toCandidate(await get<SgdbGame>(settings, `/games/steam/${appId}`))
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        log.debug(`no SteamGridDB game for Steam app ${appId}`)
        return null
      }
      throw err
    }
  }

  /** `/games/id/{id}` (null for a game SteamGridDB no longer has); the last few are kept, so titleOf + yearOf ask once. */
  const byIdCache = new Map<string, Promise<SgdbGame | null>>()
  function gameById(settings: Settings, externalId: string): Promise<SgdbGame | null> {
    let found = byIdCache.get(externalId)
    if (!found) {
      found = get<SgdbGame>(settings, `/games/id/${encodeURIComponent(externalId)}`).then(
        (game) => game ?? null,
        (err) => {
          byIdCache.delete(externalId)
          if (err instanceof HttpError && err.status === 404) return null
          throw err
        }
      )
      byIdCache.set(externalId, found)
      if (byIdCache.size > 64) byIdCache.delete(byIdCache.keys().next().value!)
    }
    return found
  }

  async function byName(settings: Settings, name: string): Promise<MetadataCandidate[]> {
    const games = (
      await get<SgdbGame[]>(settings, `/search/autocomplete/${encodeURIComponent(name)}`)
    ).slice(0, MAX_CANDIDATES)
    // Several games of one name ("SSX" of 2000 and its 2012 reboot): only a release year tells them apart, and the
    // search does not always give one (its documented answer has none). Those games are looked up by id, which does.
    const sameName = new Map<string, number>()
    for (const g of games) {
      const key = sameTitleKey(g.name)
      sameName.set(key, (sameName.get(key) ?? 0) + 1)
    }
    const dated = await Promise.all(
      games.map(async (g) => {
        if (g.release_date || (sameName.get(sameTitleKey(g.name)) ?? 0) < 2) return g
        try {
          const full = await gameById(settings, String(g.id))
          return full?.release_date ? { ...g, release_date: full.release_date } : g
        } catch {
          return g
        }
      })
    )
    return dated.map(toCandidate)
  }

  async function images(settings: Settings, kind: ImageKind, gameId: string): Promise<SgdbImage[]> {
    try {
      return await get<SgdbImage[]>(settings, `/${kind}/game/${gameId}`, {
        ...IMAGE_QUERIES[kind],
        ...COMMON_IMAGE_PARAMS
      })
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return []
      throw err
    }
  }

  return {
    id: 'steamgriddb',
    artKinds: ['cover', 'hero', 'logo', 'icon'],

    isConfigured,

    async idMatchOf(game, settings) {
      const appId = steamAppIdOf(game)
      if (!appId || !isConfigured(settings)) return undefined
      return (await bySteamAppId(settings, appId))?.externalId ?? null
    },

    async titleOf(externalId, settings) {
      const game = await gameById(settings, externalId)
      return game?.name ? [game.name] : null
    },

    async yearOf(externalId, settings) {
      const date = unixToIsoDate((await gameById(settings, externalId))?.release_date)
      return date ? Number.parseInt(date.slice(0, 4), 10) : null
    },

    async search(game, settings, query) {
      if (!isConfigured(settings))
        throw new HttpError(`${SERVICE}: API key not configured`, { status: 401, url: baseUrl })
      const appId = query ? undefined : steamAppIdOf(game)
      if (appId) {
        const direct = await bySteamAppId(settings, appId)
        if (direct) return [{ ...direct, byId: true }]
      }
      const name = searchNameFor(game, query)
      if (!name) return []
      return byName(settings, name)
    },

    async fetch(_game, candidate, settings, kinds) {
      const gameId = candidate.externalId
      // The full lane names the kinds the game is still missing (the cover lane's answer is reused as it is), so
      // a game that only lacks an icon costs one request instead of four.
      const wanted = new Set<ImageKind>(
        kinds?.length
          ? kinds.flatMap((kind) => IMAGE_KIND_OF[kind] ?? [])
          : (['grids', 'heroes', 'logos', 'icons'] as ImageKind[])
      )
      const [grids, heroes, logos, icons] = await Promise.all(
        (['grids', 'heroes', 'logos', 'icons'] as ImageKind[]).map((kind) =>
          wanted.has(kind) ? images(settings, kind, gameId) : Promise.resolve([])
        )
      )
      const media: ScrapedMedia = {}
      const cover = pickImage('grids', grids)
      const hero = pickImage('heroes', heroes)
      const logo = pickImage('logos', logos)
      const icon = pickImage('icons', icons)
      if (cover) media.cover = cover.url
      if (hero) media.hero = hero.url
      if (logo) media.logo = logo.url
      if (icon) media.icon = icon.url
      log.debug(
        `SteamGridDB game ${gameId}: ${grids.length} grids, ${heroes.length} heroes, ${logos.length} logos, ${icons.length} icons`
      )
      const result: ScrapedResult = {
        title: candidate.title,
        metadata: { sources: { steamgriddb: gameId } },
        media
      }
      if (candidate.releaseDate) result.metadata.releaseDate = candidate.releaseDate
      return result
    }
  }
}

/**
 * The one SteamGridDB token bucket of the app (3 req / s): the scraper's search + fetch and
 * `direct-art/steamgriddb-platform.ts`'s batched platform lookups share it, so the cover lane's keyless searches
 * and the batches for games with ids never add up to twice the allowed rate.
 */
export const steamGridDbLimiter = new RateLimiter(3, 3)

export const steamGridDbScraper: Scraper = createSteamGridDbScraper({ limiter: steamGridDbLimiter })
