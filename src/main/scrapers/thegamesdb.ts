// TheGamesDB API v1 (docs/research/metadata-apis.md section 4): monthly allowance, so every record is cached.
import type { GameMetadata, MetadataCandidate, Settings } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import {
  buildUrl,
  HttpError,
  httpJson,
  RateLimiter,
  serviceError,
  toError,
  type HttpOptions
} from './http'
import { platformIdFor, platformKeyForGame, searchNameFor } from './platform-ids'
import type { ScrapedMedia, Scraper } from './types'

export const TGDB_BASE_URL = 'https://api.thegamesdb.net'
const SERVICE = 'TheGamesDB'
const MAX_CANDIDATES = 15
const MAX_SCREENSHOTS = 6
const CACHE_SIZE = 200
/** Genre / developer / publisher tables change rarely; one call each per day at most. */
const TABLE_TTL_MS = 24 * 60 * 60 * 1000
const GAME_FIELDS = 'players,publishers,genres,overview,last_updated,rating,platform,coop,youtube'
const IMAGE_TYPES = 'boxart,fanart,clearlogo,screenshot,titlescreen'
/**
 * After an HTTP 429 (the key's allowance is used up) TheGamesDB is not asked again for this long: every further
 * request would be refused too, and each would cost a game a scraper error.
 */
export const TGDB_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000
/** The statuses a TheGamesDB request is retried on: not 429 (see `TGDB_RATE_LIMIT_PAUSE_MS`). */
const TGDB_RETRY_STATUSES = [500, 502, 503, 504] as const

interface TgdbGame {
  id: number
  game_title: string
  release_date?: string | null
  platform?: number
  players?: number | string | null
  overview?: string | null
  rating?: string | null
  coop?: string | null
  developers?: number[] | null
  genres?: number[] | null
  publishers?: number[] | null
}

interface TgdbImage {
  id?: number
  type?: string
  side?: string
  filename?: string
  resolution?: string
}

type BaseUrls = Partial<
  Record<'original' | 'small' | 'thumb' | 'cropped_center_thumb' | 'medium' | 'large', string>
>

interface TgdbEnvelope {
  code?: number
  status?: string
  remaining_monthly_allowance?: number
  extra_allowance?: number
}

interface TgdbGamesResponse extends TgdbEnvelope {
  data?: { count?: number; games?: TgdbGame[] }
  include?: {
    boxart?: { base_url?: BaseUrls; data?: Record<string, TgdbImage[]> }
    /** v1 returns the platform map directly, v1.1 wraps it in `data`. */
    platform?: { data?: Record<string, { id?: number; name?: string }> } & Record<string, unknown>
  }
}

interface TgdbImagesResponse extends TgdbEnvelope {
  data?: { base_url?: BaseUrls; images?: Record<string, TgdbImage[]> }
}

type TableName = 'genres' | 'developers' | 'publishers'

interface TgdbTableResponse extends TgdbEnvelope {
  data?: Partial<Record<TableName, Record<string, { id?: number; name?: string }>>>
}

interface CachedGame {
  game: TgdbGame
  boxart: TgdbImage[]
  boxartBase?: BaseUrls
  platformName?: string
}

export interface TheGamesDbOptions {
  baseUrl?: string
  limiter?: RateLimiter
  log?: Logger
  /** The clock (tests). */
  now?: () => number
  /** Retry settings of the API requests (tests: no waits). */
  http?: Pick<HttpOptions, 'retries' | 'delaysMs' | 'retryStatuses'>
}

function imageUrl(
  base: BaseUrls | undefined,
  filename: string | undefined,
  size: keyof BaseUrls = 'large'
): string | undefined {
  if (!filename) return undefined
  const root = base?.[size] ?? base?.original ?? base?.medium
  if (!root) return undefined
  return `${root.replace(/\/+$/, '')}/${filename.replace(/^\/+/, '')}`
}

function platformNames(
  include: TgdbGamesResponse['include']
): Record<string, { id?: number; name?: string }> {
  const platform = include?.platform
  if (!platform) return {}
  if (platform.data && typeof platform.data === 'object') return platform.data
  return platform as Record<string, { id?: number; name?: string }>
}

function describe(err: HttpError): string | undefined {
  if (err.status === 401 || err.status === 403 || err.status === 418)
    return 'invalid API key or monthly allowance exhausted'
  if (err.status === 406) return 'invalid request (missing or malformed id)'
  if (err.status === 404) return 'not found'
  return undefined
}

export function createTheGamesDbScraper(options: TheGamesDbOptions = {}): Scraper {
  const baseUrl = (options.baseUrl ?? TGDB_BASE_URL).replace(/\/+$/, '')
  const limiter = options.limiter ?? new RateLimiter(2, 2)
  const log = options.log ?? createLogger('scrapers:thegamesdb')
  const now = options.now ?? Date.now
  /** Until when requests are not sent (an HTTP 429 paused the source); 0 = not paused. */
  let pausedUntil = 0

  function available(): boolean {
    return now() >= pausedUntil
  }
  const cache = new Map<string, CachedGame>()
  const tables = new Map<TableName, { names: Map<number, string>; loadedAt: number }>()
  const tableRequests = new Map<TableName, Promise<Map<number, string>>>()

  function apiKey(settings: Settings): string {
    return settings.scrapers.thegamesdb.apiKey?.trim() ?? ''
  }

  function isConfigured(settings: Settings): boolean {
    return apiKey(settings).length > 0
  }

  function remember(id: string, entry: CachedGame): void {
    cache.delete(id)
    cache.set(id, entry)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  }

  async function get<T extends TgdbEnvelope>(
    settings: Settings,
    path: string,
    params: Record<string, string | number | undefined>
  ): Promise<T> {
    const key = apiKey(settings)
    if (!key)
      throw new HttpError(`${SERVICE}: API key not configured`, { status: 403, url: baseUrl })
    const paused = (): Error =>
      serviceError(SERVICE, new HttpError('paused', { status: 429, url: baseUrl }), describe)
    if (!available()) throw paused()
    // The rate limiter's wait comes before the pause check: a request that waited while another one got the 429
    // is not sent.
    await limiter.take()
    if (!available()) throw paused()
    const url = buildUrl(`${baseUrl}${path}`, { apikey: key, ...params })
    let body: T
    try {
      // A 429 is not retried (the allowance is used up); 5xx answers and network failures are, after the usual
      // back-off.
      body = await httpJson<T>(
        url,
        {},
        { retryStatuses: TGDB_RETRY_STATUSES, ...options.http, log }
      )
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        // Logged once per pause: the requests in flight that are refused too only extend nothing.
        if (available())
          log.warn(
            `TheGamesDB answered HTTP 429 (allowance used up); not asking it for ${Math.round(TGDB_RATE_LIMIT_PAUSE_MS / 60_000)} min`
          )
        pausedUntil = Math.max(pausedUntil, now() + TGDB_RATE_LIMIT_PAUSE_MS)
      }
      throw err instanceof HttpError ? serviceError(SERVICE, err, describe) : toError(err)
    }
    if (typeof body.remaining_monthly_allowance === 'number') {
      log.debug(
        `TheGamesDB allowance: ${body.remaining_monthly_allowance} requests left this month`
      )
    }
    return body
  }

  /** Lazily loaded id -> name table; a failed load is logged and leaves the names out rather than failing the fetch. */
  function table(settings: Settings, name: TableName): Promise<Map<number, string>> {
    const cached = tables.get(name)
    if (cached && Date.now() - cached.loadedAt < TABLE_TTL_MS) return Promise.resolve(cached.names)
    const inflight = tableRequests.get(name)
    if (inflight) return inflight
    const path = {
      genres: '/v1/Genres',
      developers: '/v1/Developers',
      publishers: '/v1/Publishers'
    }[name]
    const task = (async (): Promise<Map<number, string>> => {
      try {
        const body = await get<TgdbTableResponse>(settings, path, {})
        const names = new Map<number, string>()
        for (const entry of Object.values(body.data?.[name] ?? {})) {
          if (typeof entry?.id === 'number' && entry.name) names.set(entry.id, entry.name)
        }
        tables.set(name, { names, loadedAt: Date.now() })
        log.debug(`TheGamesDB ${name} table: ${names.size} entries`)
        return names
      } catch (err) {
        log.warn(`TheGamesDB ${name} table unavailable: ${toError(err).message}`)
        return cached?.names ?? new Map()
      } finally {
        tableRequests.delete(name)
      }
    })()
    tableRequests.set(name, task)
    return task
  }

  function rememberGames(body: TgdbGamesResponse): CachedGame[] {
    const platforms = platformNames(body.include)
    const boxartBase = body.include?.boxart?.base_url
    const entries: CachedGame[] = []
    for (const game of body.data?.games ?? []) {
      if (typeof game?.id !== 'number' || !game.game_title) continue
      const entry: CachedGame = {
        game,
        boxart: body.include?.boxart?.data?.[String(game.id)] ?? [],
        boxartBase,
        platformName:
          game.platform !== undefined ? platforms[String(game.platform)]?.name : undefined
      }
      remember(String(game.id), entry)
      entries.push(entry)
    }
    return entries
  }

  function toCandidate(entry: CachedGame): MetadataCandidate {
    const candidate: MetadataCandidate = {
      scraper: 'thegamesdb',
      externalId: String(entry.game.id),
      title: entry.game.game_title
    }
    if (entry.game.release_date) candidate.releaseDate = entry.game.release_date
    if (entry.platformName) candidate.platform = entry.platformName
    if (typeof entry.game.platform === 'number') candidate.platformIds = [entry.game.platform]
    const front =
      entry.boxart.find((b) => b.type === 'boxart' && b.side === 'front') ??
      entry.boxart.find((b) => b.type === 'boxart')
    const cover =
      imageUrl(entry.boxartBase, front?.filename, 'small') ??
      imageUrl(entry.boxartBase, front?.filename, 'thumb')
    if (cover) candidate.cover = cover
    return candidate
  }

  async function lookupNames(
    settings: Settings,
    name: TableName,
    ids: number[] | null | undefined
  ): Promise<string[]> {
    const wanted = (ids ?? []).filter((id) => typeof id === 'number')
    if (!wanted.length) return []
    const names = await table(settings, name)
    return [...new Set(wanted.map((id) => names.get(id)).filter((n): n is string => !!n))]
  }

  async function images(
    settings: Settings,
    id: string
  ): Promise<{ base?: BaseUrls; list: TgdbImage[] }> {
    try {
      const body = await get<TgdbImagesResponse>(settings, '/v1/Games/Images', {
        games_id: id,
        'filter[type]': IMAGE_TYPES
      })
      return { base: body.data?.base_url, list: body.data?.images?.[id] ?? [] }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 406))
        return { list: [] }
      throw err
    }
  }

  return {
    id: 'thegamesdb',
    isConfigured,
    available,

    async search(game, settings, query) {
      const name = searchNameFor(game, query)
      if (!name) return []
      const platformId = platformIdFor('thegamesdb', platformKeyForGame(game))
      const body = await get<TgdbGamesResponse>(settings, '/v1.1/Games/ByGameName', {
        name,
        fields: GAME_FIELDS,
        include: 'boxart,platform',
        'filter[platform]': platformId
      })
      return rememberGames(body).slice(0, MAX_CANDIDATES).map(toCandidate)
    },

    async fetch(_game, candidate, settings) {
      const id = candidate.externalId
      if (!/^\d+$/.test(id)) throw new Error(`${SERVICE}: invalid game id ${id}`)
      let entry = cache.get(id)
      if (!entry) {
        const body = await get<TgdbGamesResponse>(settings, '/v1/Games/ByGameID', {
          id,
          fields: GAME_FIELDS,
          include: 'boxart,platform'
        })
        entry = rememberGames(body).find((e) => String(e.game.id) === id)
        if (!entry)
          throw new HttpError(`${SERVICE}: game ${id} not found`, {
            status: 404,
            url: `${baseUrl}/v1/Games/ByGameID`
          })
      }
      const game = entry.game
      const [developers, publishers, genres, art] = await Promise.all([
        lookupNames(settings, 'developers', game.developers),
        lookupNames(settings, 'publishers', game.publishers),
        lookupNames(settings, 'genres', game.genres),
        images(settings, id)
      ])

      const metadata: Partial<GameMetadata> = { sources: { thegamesdb: id } }
      const overview = game.overview?.trim()
      if (overview) metadata.description = overview
      if (game.release_date) metadata.releaseDate = game.release_date
      if (developers.length) metadata.developers = developers
      if (publishers.length) metadata.publishers = publishers
      if (genres.length) metadata.genres = genres
      const players =
        game.players !== undefined && game.players !== null && String(game.players).trim()
          ? String(game.players).trim()
          : undefined
      if (players && players !== '0') metadata.players = players
      // TheGamesDB's rating is an age-rating label such as 'E - Everyone', not a score.
      const tags = [
        game.rating?.trim(),
        game.coop?.trim().toLowerCase() === 'yes' ? 'Co-op' : undefined
      ].filter((t): t is string => !!t)
      if (tags.length) metadata.tags = tags

      const list = art.list.length ? art.list : entry.boxart
      const base = art.list.length ? art.base : entry.boxartBase
      const media: ScrapedMedia = {}
      const front =
        list.find((i) => i.type === 'boxart' && i.side === 'front') ??
        list.find((i) => i.type === 'boxart' && !i.side)
      const cover = imageUrl(base, front?.filename)
      if (cover) media.cover = cover
      const hero = imageUrl(base, list.find((i) => i.type === 'fanart')?.filename)
      if (hero) media.hero = hero
      const logo = imageUrl(base, list.find((i) => i.type === 'clearlogo')?.filename)
      if (logo) media.logo = logo
      const screenshots = list
        .filter((i) => i.type === 'screenshot' || i.type === 'titlescreen')
        .map((i) => imageUrl(base, i.filename))
        .filter((u): u is string => !!u)
      if (screenshots.length) media.screenshots = screenshots.slice(0, MAX_SCREENSHOTS)
      return { title: game.game_title, metadata, media }
    }
  }
}

export const theGamesDbScraper: Scraper = createTheGamesDbScraper()
