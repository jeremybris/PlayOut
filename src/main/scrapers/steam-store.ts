import type { AchievementsInfo, Game, MetadataCandidate, SteamScreenshot } from '../../shared/types'
import { createLogger } from '../logger'
import { httpJson, HttpError, RateLimiter } from './http'
import type { ScrapedResult, Scraper } from './types'

const log = createLogger('scrapers:steam')

const STORE_API = 'https://store.steampowered.com/api/appdetails'
export const WEB_API = 'https://api.steampowered.com'
const CDN_BASE = 'https://cdn.cloudflare.steamstatic.com/steam/apps'
const STORE_PAGE = 'https://store.steampowered.com/app'
const APPDETAILS_TTL_MS = 24 * 60 * 60 * 1000
const APPDETAILS_CACHE_MAX = 500
const MAX_SCREENSHOTS = 8
const HEAD_TIMEOUT_MS = 10_000

// The store API has an unofficial limit of roughly 200 calls per 5 minutes per IP; the Web API allows far more.
const storeLimiter = new RateLimiter(1, 2)
/** Shared by every Steam Web API call (live data, achievements). */
export const webApiLimiter = new RateLimiter(4, 4)

// ---------------------------------------------------------------------------
// Steam response shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface SteamAppDetails {
  type?: string
  name?: string
  steam_appid?: number
  required_age?: number | string
  is_free?: boolean
  detailed_description?: string
  about_the_game?: string
  short_description?: string
  header_image?: string
  website?: string | null
  developers?: string[]
  publishers?: string[]
  metacritic?: { score?: number; url?: string }
  categories?: { id: number; description: string }[]
  genres?: { id: string; description: string }[]
  screenshots?: { id: number; path_thumbnail?: string; path_full?: string }[]
  movies?: {
    id: number
    name?: string
    mp4?: { '480'?: string; max?: string }
    webm?: { '480'?: string; max?: string }
  }[]
  achievements?: { total?: number }
  release_date?: { coming_soon?: boolean; date?: string }
  /** HTML lists; an empty array when the app has none. */
  pc_requirements?: { minimum?: string; recommended?: string } | unknown[]
  background?: string
}

type AppDetailsEnvelope = Record<string, { success?: boolean; data?: SteamAppDetails } | undefined>

interface SchemaResponse {
  game?: {
    gameName?: string
    availableGameStats?: {
      achievements?: {
        name: string
        displayName?: string
        description?: string
        hidden?: number
        icon?: string
        icongray?: string
      }[]
    }
  }
}

interface PlayerAchievementsResponse {
  playerstats?: {
    success?: boolean
    error?: string
    achievements?: {
      apiname: string
      achieved: number
      unlocktime?: number
      name?: string
      description?: string
    }[]
  }
}

// ---------------------------------------------------------------------------
// Shared text helpers (also used by the GOG scraper and the metadata service)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ntilde: 'ñ',
  ccedil: 'ç'
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** Turn store-page HTML into readable plain text: paragraphs become blank lines, lists become bullets. */
export function htmlToText(html: string | null | undefined): string | undefined {
  if (!html) return undefined
  let text = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|tr|blockquote|section|article|table)\s*>/gi, '\n\n')
    .replace(/<\s*(p|h[1-6]|ul|ol|tr|blockquote|section|article|table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  text = decodeHtmlEntities(text)
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || undefined
}

/** Strip API keys, passwords and tokens from URLs and error messages before they reach a log line. */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(?<![A-Za-z0-9_])((?:y|key|apikey|api_key|devpassword|sspassword|ssid|devid|client_secret|client_id|access_token|token|steamid)=)[^&\s"']+/gi,
      '$1***'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
}

/** A loggable one-line description of an error; never includes credentials. */
export function describeError(err: unknown): string {
  if (err instanceof HttpError) return redactSecrets(`HTTP ${err.status} ${err.url}`)
  if (err instanceof Error) return redactSecrets(err.message)
  return redactSecrets(String(err))
}

// ---------------------------------------------------------------------------
// Game -> Steam app id
// ---------------------------------------------------------------------------

/** The Steam app id of a game: `extra.steamAppId`, or the external id of a game from the Steam provider. */
export function steamAppIdOf(game: Pick<Game, 'source' | 'externalId' | 'extra'>): number | null {
  const raw = game.extra?.steamAppId ?? (game.source === 'steam' ? game.externalId : undefined)
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  sept: '09',
  oct: '10',
  nov: '11',
  dec: '12'
}

/**
 * Parse Steam's locale-formatted release strings ("Apr 18, 2011", "18 Apr, 2011", "April 2011", "2011", "Q4 2026")
 * into 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY'. Returns undefined for "Coming soon" / "To be announced".
 */
export function parseSteamReleaseDate(text: string | undefined | null): string | undefined {
  if (!text) return undefined
  const s = text.trim().replace(/\./g, '')
  const month = (name: string): string | undefined =>
    MONTHS[name.toLowerCase().slice(0, 4)] ?? MONTHS[name.toLowerCase().slice(0, 3)]
  let m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m && month(m[1])) return `${m[3]}-${month(m[1])}-${m[2].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/)
  if (m && month(m[2])) return `${m[3]}-${month(m[2])}-${m[1].padStart(2, '0')}`
  m = s.match(/^([A-Za-z]+),?\s+(\d{4})$/)
  if (m && month(m[1])) return `${m[2]}-${month(m[1])}`
  m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/)
  if (m) return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`
  m = s.match(/\b((?:19|20)\d{2})\b/)
  return m ? m[1] : undefined
}

export function steamCdnUrl(appId: number, file: string): string {
  return `${CDN_BASE}/${appId}/${file}`
}

function unique(values: (string | undefined | null)[]): string[] {
  const out: string[] = []
  for (const v of values) {
    const t = v?.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * Every screenshot of a store page, in the store's order: thumbnail and full size (the full one stands in for a
 * missing thumbnail and the other way round; one with neither is skipped).
 */
export function steamScreenshotsOf(data: Pick<SteamAppDetails, 'screenshots'>): SteamScreenshot[] {
  const out: SteamScreenshot[] = []
  for (const s of data.screenshots ?? []) {
    const thumbnail = s.path_thumbnail?.trim() || s.path_full?.trim()
    const full = s.path_full?.trim() || thumbnail
    if (thumbnail && full) out.push({ thumbnail, full })
  }
  return out
}

/** Pure mapping of an appdetails `data` block to PlayOut metadata and the canonical CDN art URLs. */
export function mapSteamAppDetails(appId: number, data: SteamAppDetails): ScrapedResult {
  const description = htmlToText(data.about_the_game) ?? htmlToText(data.detailed_description)
  const shortDescription = htmlToText(data.short_description)
  const metacritic = data.metacritic?.score
  const website = data.website?.trim()
  const screenshots = (data.screenshots ?? [])
    .map((s) => s.path_full)
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .slice(0, MAX_SCREENSHOTS)
  const movie = data.movies?.[0]
  const video = movie?.mp4?.max ?? movie?.webm?.max ?? movie?.mp4?.['480'] ?? movie?.webm?.['480']

  return {
    title: data.name?.trim() || undefined,
    metadata: {
      description,
      shortDescription,
      releaseDate: parseSteamReleaseDate(data.release_date?.date),
      developers: unique(data.developers ?? []),
      publishers: unique(data.publishers ?? []),
      genres: unique((data.genres ?? []).map((g) => g.description)),
      tags: unique((data.categories ?? []).map((c) => c.description)),
      rating:
        typeof metacritic === 'number' && metacritic >= 0 && metacritic <= 100
          ? metacritic
          : undefined,
      links: { store: `${STORE_PAGE}/${appId}`, ...(website ? { website } : {}) },
      sources: { steam: String(appId) }
    },
    media: {
      cover: steamCdnUrl(appId, 'library_600x900_2x.jpg'),
      hero: steamCdnUrl(appId, 'library_hero.jpg'),
      logo: steamCdnUrl(appId, 'logo.png'),
      screenshots,
      video
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const appDetailsCache = new Map<number, { at: number; data: SteamAppDetails | null }>()

function remember(appId: number, data: SteamAppDetails | null): void {
  if (appDetailsCache.size >= APPDETAILS_CACHE_MAX) {
    const oldest = appDetailsCache.keys().next().value
    if (oldest !== undefined) appDetailsCache.delete(oldest)
  }
  appDetailsCache.set(appId, { at: Date.now(), data })
}

/** appdetails for one app; null when Steam has no store page for it. Cached for 24 h (Steam serves max-age=3600). */
export async function loadSteamAppDetails(appId: number): Promise<SteamAppDetails | null> {
  const cached = appDetailsCache.get(appId)
  if (cached && Date.now() - cached.at < APPDETAILS_TTL_MS) return cached.data
  await storeLimiter.take()
  const url = `${STORE_API}?appids=${appId}&cc=us&l=english`
  const envelope = await httpJson<AppDetailsEnvelope>(url, undefined, {
    timeoutMs: 20_000,
    retries: 2
  })
  const entry = envelope?.[String(appId)]
  const data = entry?.success && entry.data && typeof entry.data === 'object' ? entry.data : null
  remember(appId, data)
  return data
}

/**
 * How many achievements the Steam store page of the app lists (appdetails `filters=achievements`, no credential).
 * Steam answers `"data":[]` for an app without achievements (Call of Duty: United Offensive, 2640: 0) and
 * `"success":false` for an app it has no store page for (null: the store cannot say). Throws when the store cannot be
 * asked (offline, a rate limit, an error status).
 */
export async function steamStoreAchievementTotal(appId: number): Promise<number | null> {
  await storeLimiter.take()
  const envelope = await httpJson<
    Record<string, { success?: boolean; data?: { achievements?: { total?: number } } | unknown[] }>
  >(`${STORE_API}?appids=${appId}&filters=achievements`, undefined, {
    timeoutMs: 20_000,
    retries: 1
  })
  const entry = envelope?.[String(appId)]
  if (!entry || entry.success !== true) return null
  const data = entry.data
  if (!data || Array.isArray(data)) return 0
  const total = Number(data.achievements?.total ?? 0)
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
}

/** HEAD each URL in turn and return the first one the CDN serves; undefined when none exists. */
export async function firstAvailableUrl(urls: string[]): Promise<string | undefined> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS)
      })
      if (res.ok) return url
      log.debug(`cdn ${res.status} ${url}`)
    } catch (err) {
      // Network trouble: let the downloader decide instead of dropping the art.
      log.debug(`cdn check failed ${url}: ${describeError(err)}`)
      return url
    }
  }
  return undefined
}

async function candidateFor(appId: number): Promise<MetadataCandidate | null> {
  const data = await loadSteamAppDetails(appId)
  if (!data) return null
  return {
    scraper: 'steam',
    externalId: String(appId),
    title: data.name?.trim() || `Steam app ${appId}`,
    releaseDate: parseSteamReleaseDate(data.release_date?.date),
    platform: 'PC',
    cover: steamCdnUrl(appId, 'library_600x900.jpg')
  }
}

/**
 * Steam store scraper: metadata from the keyless `appdetails` endpoint and art straight from the CDN.
 * Only games with a Steam app id are handled; a free-text query cannot be searched without a key.
 */
export const steamStoreScraper: Scraper = {
  id: 'steam',
  idOnly: true,

  isConfigured(): boolean {
    return true
  },

  async search(game: Game): Promise<MetadataCandidate[]> {
    const appId = steamAppIdOf(game)
    if (!appId) return []
    const candidate = await candidateFor(appId)
    return candidate ? [{ ...candidate, byId: true }] : []
  },

  async fetch(game: Game, candidate: MetadataCandidate): Promise<ScrapedResult> {
    const appId = Number.parseInt(candidate.externalId, 10)
    if (!Number.isInteger(appId) || appId <= 0)
      throw new Error(`Invalid Steam app id "${candidate.externalId}"`)
    const data = await loadSteamAppDetails(appId)
    if (!data) throw new Error(`Steam has no store page for app ${appId} (${game.title})`)
    const result = mapSteamAppDetails(appId, data)
    // library_600x900.jpg is only 300x450; older apps lack the _2x variant, a hero or a logo altogether.
    const [cover, hero, logo] = await Promise.all([
      firstAvailableUrl([
        steamCdnUrl(appId, 'library_600x900_2x.jpg'),
        steamCdnUrl(appId, 'library_600x900.jpg')
      ]),
      firstAvailableUrl([steamCdnUrl(appId, 'library_hero.jpg'), steamCdnUrl(appId, 'header.jpg')]),
      firstAvailableUrl([steamCdnUrl(appId, 'logo.png')])
    ])
    result.media.cover = cover
    result.media.hero = hero
    result.media.logo = logo
    return result
  }
}

// ---------------------------------------------------------------------------
// Live data (Steam Web API)
// ---------------------------------------------------------------------------

function query(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

/** Players currently in the app (keyless). null when Steam does not know the app or the call fails. */
export async function steamCurrentPlayers(appId: number): Promise<number | null> {
  if (!Number.isInteger(appId) || appId <= 0) return null
  try {
    await webApiLimiter.take()
    const res = await httpJson<{ response?: { player_count?: number; result?: number } }>(
      `${WEB_API}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?${query({ appid: appId })}`,
      undefined,
      { timeoutMs: 10_000, retries: 1 }
    )
    const r = res?.response
    if (!r || (r.result !== undefined && r.result !== 1) || typeof r.player_count !== 'number')
      return null
    return r.player_count
  } catch (err) {
    log.debug(`current players unavailable for ${appId}: ${describeError(err)}`)
    return null
  }
}

/**
 * The game's achievement list with the player's progress: GetSchemaForGame (definitions, icons) merged with
 * GetPlayerAchievements (unlocked flags, unlock times). Requires the user's Web API key and SteamID64; null when
 * either is missing, the game has no achievements, or the profile's game details are private.
 */
export async function steamAchievements(
  appId: number,
  apiKey: string,
  steamId64: string
): Promise<AchievementsInfo | null> {
  const key = apiKey.trim()
  const steamid = steamId64.trim()
  if (!key || !steamid || !Number.isInteger(appId) || appId <= 0) return null
  try {
    await webApiLimiter.take()
    const schema = await httpJson<SchemaResponse>(
      `${WEB_API}/ISteamUserStats/GetSchemaForGame/v2/?${query({ key, appid: appId, l: 'english' })}`,
      undefined,
      { timeoutMs: 15_000, retries: 1 }
    )
    const defs = schema?.game?.availableGameStats?.achievements ?? []
    if (!defs.length) return null

    await webApiLimiter.take()
    let unlockedByName = new Map<string, number | undefined>()
    try {
      const player = await httpJson<PlayerAchievementsResponse>(
        `${WEB_API}/ISteamUserStats/GetPlayerAchievements/v1/?${query({ key, steamid, appid: appId, l: 'english' })}`,
        undefined,
        { timeoutMs: 15_000, retries: 1 }
      )
      const stats = player?.playerstats
      if (!stats || stats.success === false) {
        log.debug(
          `player achievements unavailable for ${appId}: ${stats?.error ?? 'no playerstats'}`
        )
        return null
      }
      unlockedByName = new Map(
        (stats.achievements ?? [])
          .filter((a) => a.achieved === 1)
          .map((a) => [a.apiname, a.unlocktime])
      )
    } catch (err) {
      // 403 = profile not public, 400 = app has no stats for this user.
      log.debug(`player achievements unavailable for ${appId}: ${describeError(err)}`)
      return null
    }

    const list: AchievementsInfo['list'] = defs.map((d) => {
      const unlocked = unlockedByName.has(d.name)
      const unlocktime = unlockedByName.get(d.name)
      return {
        id: d.name,
        name: d.displayName?.trim() || d.name,
        description: d.description?.trim() || undefined,
        unlocked,
        unlockedAt: unlocked && unlocktime ? new Date(unlocktime * 1000).toISOString() : undefined,
        icon: unlocked ? d.icon : (d.icongray ?? d.icon),
        hidden: d.hidden === 1
      }
    })
    return { total: list.length, unlocked: list.filter((a) => a.unlocked).length, list }
  } catch (err) {
    log.warn(`achievements failed for ${appId}: ${describeError(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Storage requirement
// ---------------------------------------------------------------------------

const STORAGE_LABEL =
  /(?:storage|hard\s*(?:disk|drive)(?:\s*space)?|disk\s*space|hdd|free\s*space)\s*:/i
const UNIT_BYTES: Record<string, number> = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }

/**
 * The disk space a requirements list asks for, in bytes ("Storage: 8 GB available space", "Hard Drive: 500 MB",
 * "Hard Disk Space: 1,5 GB"); undefined when it names none. Units are read the way stores mean them (1 GB = 1024 MB),
 * so the figure shows as written.
 */
export function parseStorageRequirement(html: string | undefined): number | undefined {
  if (!html) return undefined
  const text = html
    .replace(/<br\s*\/?>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
  for (const line of text.split('\n')) {
    const label = STORAGE_LABEL.exec(line)
    if (!label) continue
    const rest = line
      .slice(label.index + label[0].length)
      .replace(/gib\b/gi, 'GB')
      .replace(/mib\b/gi, 'MB')
    const m = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*(kb|mb|gb|tb)\b/i.exec(rest)
    if (!m) continue
    // "1,200 MB" groups thousands; "1,5 GB" is a decimal comma.
    const digits = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(m[1])
      ? m[1].replace(/,/g, '')
      : m[1].replace(',', '.')
    const value = Number.parseFloat(digits)
    const bytes = Math.round(value * UNIT_BYTES[m[2].toLowerCase()])
    if (bytes > 0) return bytes
  }
  return undefined
}

/** Steam's storage requirement for an app: the recommended list's, else the minimum's. */
export function steamStorageRequirement(data: SteamAppDetails): number | undefined {
  const req = data.pc_requirements
  if (!req || Array.isArray(req)) return undefined
  return parseStorageRequirement(req.recommended) ?? parseStorageRequirement(req.minimum)
}

/** Test hook: forget cached appdetails. */
export function clearSteamCaches(): void {
  appDetailsCache.clear()
}
