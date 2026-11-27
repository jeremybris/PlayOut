// IGDB API v4 (docs/research/metadata-apis.md section 2): Twitch client-credentials token, Apicalypse queries.
import type { GameMetadata, MetadataCandidate, Settings } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { normalizeTitle } from './hltb'
import { HttpError, httpJson, RateLimiter, serviceError, toError } from './http'
import { platformIdFor, platformKeyForGame, searchNameFor } from './platform-ids'
import type { ScrapedMedia, ScrapedResult, Scraper } from './types'

export const IGDB_BASE_URL = 'https://api.igdb.com/v4'
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
export const IGDB_IMAGE_BASE_URL = 'https://images.igdb.com/igdb/image/upload'
const SERVICE = 'IGDB'
const MAX_CANDIDATES = 15
const MAX_SCREENSHOTS = 6
/** Refresh the token this long before Twitch says it expires. */
const TOKEN_SAFETY_MS = 60_000
/** Main game, remake, remaster, expanded game, port: listed before DLC, bundles and mods. */
const PRIMARY_GAME_TYPES = new Set([0, 8, 9, 10, 11])
/** IGDB's largest page: ids asked about in one `recordsOf` request. */
const MAX_IDS_PER_QUERY = 500

interface TwitchToken {
  access_token: string
  expires_in: number
  token_type?: string
}

interface Named {
  id?: number
  name?: string
}

interface IgdbImage {
  id?: number
  image_id?: string
  width?: number
  height?: number
}

interface IgdbGameSummary {
  id: number
  name: string
  slug?: string
  first_release_date?: number
  platforms?: Named[]
  cover?: IgdbImage
  game_type?: number
  version_title?: string
  /** The game this record is an edition of ("Limited Edition", "Game of the Year Edition"): its id. */
  version_parent?: number
  alternative_names?: Named[]
}

interface IgdbGame extends IgdbGameSummary {
  summary?: string
  storyline?: string
  total_rating?: number
  aggregated_rating?: number
  rating?: number
  url?: string
  genres?: Named[]
  themes?: Named[]
  game_modes?: Named[]
  player_perspectives?: Named[]
  multiplayer_modes?: { offlinemax?: number; onlinemax?: number; offlinecoopmax?: number }[]
  artworks?: IgdbImage[]
  screenshots?: IgdbImage[]
  involved_companies?: { company?: Named; developer?: boolean; publisher?: boolean }[]
  release_dates?: { date?: number }[]
}

interface IgdbLogo extends IgdbImage {
  game?: number
}

const SEARCH_FIELDS =
  'name,slug,first_release_date,platforms.name,cover.image_id,game_type,version_title,version_parent,alternative_names.name'

const GAME_FIELDS = [
  'name,slug,summary,storyline,first_release_date,total_rating,aggregated_rating,rating,url,game_type',
  'genres.name,themes.name,game_modes.name,player_perspectives.name',
  'multiplayer_modes.offlinemax,multiplayer_modes.onlinemax,multiplayer_modes.offlinecoopmax',
  'cover.image_id,cover.width,cover.height,artworks.image_id,artworks.width,artworks.height,screenshots.image_id',
  'involved_companies.company.name,involved_companies.developer,involved_companies.publisher',
  'release_dates.date,platforms.name'
].join(',')

export interface IgdbOptions {
  baseUrl?: string
  tokenUrl?: string
  limiter?: RateLimiter
  log?: Logger
}

/**
 * The one IGDB token bucket of the app (4 req / s): the scraper and `direct-art/igdb-external.ts` share it, so the
 * full lane's text queries and the cover lane's external-id lookups never add up to twice the allowed rate.
 */
export const igdbLimiter = new RateLimiter(4, 1)

/** The IGDB scraper plus its Twitch token, shared with `direct-art/igdb-external.ts` (one token request per app). */
export interface IgdbScraper extends Scraper {
  token(settings: Settings): Promise<string>
  /** One Apicalypse query to an IGDB endpoint, with the scraper's token, limiter and 401 retry (review-scores.ts). */
  query<T>(settings: Settings, endpoint: string, body: string): Promise<T>
}

/** Build an IGDB image URL for an image id and size token (t_cover_big_2x, t_1080p, ...). */
export function igdbImageUrl(imageId: string, size: string, ext: 'jpg' | 'png' = 'jpg'): string {
  return `${IGDB_IMAGE_BASE_URL}/${size}/${imageId}.${ext}`
}

/** Escape a free-text term for an Apicalypse string literal. */
export function apicalypseString(term: string): string {
  const printable = Array.from(term, (c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('')
  return printable.replace(/[\\"]/g, ' ').replace(/\s+/g, ' ').trim()
}

function unixToIsoDate(seconds: number | undefined): string | undefined {
  if (!seconds || !Number.isFinite(seconds)) return undefined
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

function names(list: Named[] | undefined): string[] {
  return [...new Set((list ?? []).map((n) => n.name?.trim()).filter((n): n is string => !!n))]
}

function playersOf(game: IgdbGame): string | undefined {
  const local = Math.max(
    0,
    ...(game.multiplayer_modes ?? []).map((m) => Math.max(m.offlinemax ?? 0, m.offlinecoopmax ?? 0))
  )
  if (local > 1) return `1-${local}`
  const modes = names(game.game_modes).map((m) => m.toLowerCase())
  if (modes.length && modes.every((m) => m === 'single player')) return '1'
  return undefined
}

function releaseDateOf(game: IgdbGame): string | undefined {
  const first = unixToIsoDate(game.first_release_date)
  if (first) return first
  const dates = (game.release_dates ?? [])
    .map((r) => r.date)
    .filter((d): d is number => typeof d === 'number' && d > 0)
  return dates.length ? unixToIsoDate(Math.min(...dates)) : undefined
}

function ratingOf(game: IgdbGame): number | undefined {
  const value = game.total_rating ?? game.aggregated_rating ?? game.rating
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** Map a full IGDB game record to PlayOut metadata and media URLs. */
export function mapIgdbGame(game: IgdbGame, logo?: IgdbLogo | null): ScrapedResult {
  const developers: string[] = []
  const publishers: string[] = []
  for (const ic of game.involved_companies ?? []) {
    const name = ic.company?.name?.trim()
    if (!name) continue
    if (ic.developer && !developers.includes(name)) developers.push(name)
    if (ic.publisher && !publishers.includes(name)) publishers.push(name)
  }
  const metadata: Partial<GameMetadata> = { sources: { igdb: String(game.id) } }
  const description = game.summary?.trim() || game.storyline?.trim()
  if (description) metadata.description = description
  const releaseDate = releaseDateOf(game)
  if (releaseDate) metadata.releaseDate = releaseDate
  if (developers.length) metadata.developers = developers
  if (publishers.length) metadata.publishers = publishers
  const genres = names(game.genres)
  if (genres.length) metadata.genres = genres
  const tags = [
    ...new Set([
      ...names(game.themes),
      ...names(game.game_modes),
      ...names(game.player_perspectives)
    ])
  ]
  if (tags.length) metadata.tags = tags
  const rating = ratingOf(game)
  if (rating !== undefined) metadata.rating = rating
  const players = playersOf(game)
  if (players) metadata.players = players
  if (game.url) metadata.links = { website: game.url }

  const media: ScrapedMedia = {}
  if (game.cover?.image_id) media.cover = igdbImageUrl(game.cover.image_id, 't_cover_big_2x')
  const artworks = (game.artworks ?? []).filter((a) => a.image_id)
  const screenshots = (game.screenshots ?? []).filter((s) => s.image_id)
  // Prefer a landscape artwork for the hero; fall back to the first screenshot.
  const hero =
    artworks.find((a) => (a.width ?? 0) >= (a.height ?? 0)) ?? artworks[0] ?? screenshots[0]
  if (hero?.image_id) media.hero = igdbImageUrl(hero.image_id, 't_1080p')
  if (screenshots.length)
    media.screenshots = screenshots
      .slice(0, MAX_SCREENSHOTS)
      .map((s) => igdbImageUrl(s.image_id!, 't_screenshot_huge'))
  if (logo?.image_id) media.logo = igdbImageUrl(logo.image_id, 't_1080p', 'png')
  return { title: game.name, metadata, media }
}

function describe(err: HttpError): string | undefined {
  if (err.status === 401) return 'invalid client id or secret'
  if (err.status === 403) return 'access denied; check the Twitch application'
  if (err.status === 400) return `bad request${err.body ? ` (${err.body.slice(0, 160)})` : ''}`
  return undefined
}

export function createIgdbScraper(options: IgdbOptions = {}): IgdbScraper {
  const baseUrl = (options.baseUrl ?? IGDB_BASE_URL).replace(/\/+$/, '')
  const tokenUrl = options.tokenUrl ?? TWITCH_TOKEN_URL
  const limiter = options.limiter ?? new RateLimiter(4, 1)
  const log = options.log ?? createLogger('scrapers:igdb')

  let cached: { clientId: string; clientSecret: string; token: string; expiresAt: number } | null =
    null
  let tokenRequest: Promise<string> | null = null
  /** Set after the logos endpoint answers 4xx so later fetches skip it. */
  let logosUnsupported = false

  function credentials(settings: Settings): { clientId: string; clientSecret: string } {
    return {
      clientId: settings.scrapers.igdb.clientId?.trim() ?? '',
      clientSecret: settings.scrapers.igdb.clientSecret?.trim() ?? ''
    }
  }

  function isConfigured(settings: Settings): boolean {
    const { clientId, clientSecret } = credentials(settings)
    return clientId.length > 0 && clientSecret.length > 0
  }

  async function requestToken(clientId: string, clientSecret: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    })
    let token: TwitchToken
    try {
      token = await httpJson<TwitchToken>(
        tokenUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        },
        { log }
      )
    } catch (err) {
      if (err instanceof HttpError) {
        throw serviceError(SERVICE, err, (e) =>
          e.status === 400 || e.status === 401 || e.status === 403
            ? 'invalid client id or secret'
            : undefined
        )
      }
      throw toError(err)
    }
    if (!token.access_token)
      throw new HttpError(`${SERVICE}: token response without access_token`, {
        status: 200,
        url: tokenUrl
      })
    const ttlMs = Math.max(0, (token.expires_in ?? 0) * 1000 - TOKEN_SAFETY_MS)
    cached = { clientId, clientSecret, token: token.access_token, expiresAt: Date.now() + ttlMs }
    log.debug(`IGDB token obtained, valid for ${Math.round(ttlMs / 3_600_000)} h`)
    return token.access_token
  }

  async function getToken(settings: Settings, force = false): Promise<string> {
    const { clientId, clientSecret } = credentials(settings)
    if (!clientId || !clientSecret)
      throw new HttpError(`${SERVICE}: client id and secret not configured`, {
        status: 401,
        url: tokenUrl
      })
    const valid =
      cached &&
      cached.clientId === clientId &&
      cached.clientSecret === clientSecret &&
      Date.now() < cached.expiresAt
    if (valid && !force) return cached!.token
    if (!tokenRequest) {
      tokenRequest = requestToken(clientId, clientSecret).finally(() => {
        tokenRequest = null
      })
    }
    return tokenRequest
  }

  async function query<T>(settings: Settings, endpoint: string, body: string): Promise<T> {
    const url = `${baseUrl}/${endpoint}`
    const { clientId } = credentials(settings)
    const send = async (token: string): Promise<T> =>
      httpJson<T>(
        url,
        {
          method: 'POST',
          headers: {
            'Client-ID': clientId,
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'text/plain'
          },
          body
        },
        { limiter, log }
      )
    try {
      try {
        return await send(await getToken(settings))
      } catch (err) {
        // An expired or revoked token answers 401: get a fresh one and try once more.
        if (err instanceof HttpError && err.status === 401) {
          log.debug('IGDB answered 401; refreshing the token')
          return await send(await getToken(settings, true))
        }
        throw err
      }
    } catch (err) {
      // Token errors are already labelled by requestToken; only API responses need the generic mapping.
      if (err instanceof HttpError && !err.message.startsWith(`${SERVICE}: `))
        throw serviceError(SERVICE, err, describe)
      throw toError(err)
    }
  }

  /** The record's name with its version ("X (Limited Edition)"), unless the name already ends with it. */
  function titled(game: IgdbGameSummary): string {
    const version = game.version_title?.trim()
    if (!version) return game.name
    const said = normalizeTitle(version)
    return said && normalizeTitle(game.name).endsWith(said)
      ? game.name
      : `${game.name} (${version})`
  }

  function toCandidate(game: IgdbGameSummary): MetadataCandidate {
    const candidate: MetadataCandidate = {
      scraper: 'igdb',
      externalId: String(game.id),
      title: titled(game)
    }
    const releaseDate = unixToIsoDate(game.first_release_date)
    if (releaseDate) candidate.releaseDate = releaseDate
    const platforms = names(game.platforms)
    if (platforms.length) candidate.platform = platforms.slice(0, 3).join(', ')
    const platformIds = (game.platforms ?? [])
      .map((p) => p.id)
      .filter((id): id is number => typeof id === 'number')
    if (platformIds.length) candidate.platformIds = platformIds
    if (game.cover?.image_id) candidate.cover = igdbImageUrl(game.cover.image_id, 't_cover_big')
    const alt = names(game.alternative_names)
    if (alt.length) candidate.altTitles = alt
    return candidate
  }

  async function fetchLogo(settings: Settings, gameId: string): Promise<IgdbLogo | null> {
    if (logosUnsupported) return null
    try {
      const logos = await query<IgdbLogo[]>(
        settings,
        'logos',
        `fields image_id,width,height; where game = ${gameId}; limit 1;`
      )
      return logos[0] ?? null
    } catch (err) {
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        logosUnsupported = true
        log.info(
          `IGDB logos endpoint unavailable (HTTP ${err.status}); logos will come from other scrapers`
        )
        return null
      }
      log.warn(`IGDB logo lookup failed for game ${gameId}: ${toError(err).message}`)
      return null
    }
  }

  return {
    id: 'igdb',
    isConfigured,
    token: (settings) => getToken(settings),
    query,

    async titleOf(externalId, settings) {
      if (!/^\d+$/.test(externalId)) return null
      const games = await query<IgdbGameSummary[]>(
        settings,
        'games',
        `fields name,alternative_names.name; where id = ${externalId}; limit 1;`
      )
      const game = games[0]
      return game?.name ? [game.name, ...names(game.alternative_names)] : null
    },

    async recordsOf(externalIds, settings) {
      const out = new Map<string, { title: string }>()
      const ids = [...new Set(externalIds.filter((id) => /^\d+$/.test(id)))]
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_QUERY) {
        const batch = ids.slice(i, i + MAX_IDS_PER_QUERY)
        const games = await query<IgdbGameSummary[]>(
          settings,
          'games',
          `fields name,version_title; where id = (${batch.join(',')}); limit ${MAX_IDS_PER_QUERY};`
        )
        for (const game of games) {
          if (!game?.name) continue
          out.set(String(game.id), { title: titled(game) })
        }
      }
      return out
    },

    async search(game, settings, searchQuery) {
      const term = apicalypseString(searchNameFor(game, searchQuery))
      if (!term) return []
      const platformId = platformIdFor('igdb', platformKeyForGame(game))
      const where = platformId ? ` where platforms = (${platformId});` : ''
      const body = `fields ${SEARCH_FIELDS}; search "${term}";${where} limit ${MAX_CANDIDATES};`
      const games = await query<IgdbGameSummary[]>(settings, 'games', body)
      // A game's own record before the records of its editions (IGDB lists "X - Limited Edition" as a main game whose
      // `version_parent` is X) and before DLC, bundles and mods: they stay findable, behind it.
      const primary = games.filter(
        (g) =>
          !g.version_parent && (g.game_type === undefined || PRIMARY_GAME_TYPES.has(g.game_type))
      )
      const secondary = games.filter((g) => !primary.includes(g))
      return [...primary, ...secondary].map(toCandidate)
    },

    async fetch(_game, candidate, settings) {
      const id = candidate.externalId
      if (!/^\d+$/.test(id)) throw new Error(`${SERVICE}: invalid game id ${id}`)
      const games = await query<IgdbGame[]>(
        settings,
        'games',
        `fields ${GAME_FIELDS}; where id = ${id}; limit 1;`
      )
      const game = games[0]
      if (!game)
        throw new HttpError(`${SERVICE}: game ${id} not found`, {
          status: 404,
          url: `${baseUrl}/games`
        })
      const logo = await fetchLogo(settings, id)
      return mapIgdbGame(game, logo)
    }
  }
}

export const igdbScraper: IgdbScraper = createIgdbScraper({ limiter: igdbLimiter })
