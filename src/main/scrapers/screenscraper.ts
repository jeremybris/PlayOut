// ScreenScraper API v2 (docs/research/metadata-apis.md section 3): ROM identification by hash, region-aware media.
import { basename, extname } from 'path'
import type { Game, GameMetadata, MetadataCandidate, Settings } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { statSafe } from '../util/fs'
import { hashFile, type FileHashes } from '../util/hash'
import { buildUrl, Gate, HttpError, httpJson, RateLimiter, serviceError, toError } from './http'
import { platformIdFor, platformKeyForGame, searchNameFor } from './platform-ids'
import type { ScrapedMedia, ScrapedResult, Scraper } from './types'

export const SCREENSCRAPER_BASE_URL = 'https://api.screenscraper.fr/api2'
/** Identifies the software to ScreenScraper; must not contain spaces (they break the media URLs it returns). */
export const SCREENSCRAPER_SOFTNAME = 'PlayOut-1.0'
/** ROMs larger than this are identified by name only. */
export const MAX_HASH_BYTES = 128 * 1024 * 1024
const SERVICE = 'ScreenScraper'
const MAX_CANDIDATES = 15
const MAX_SCREENSHOTS = 6
const MAX_THREADS = 4
const CACHE_SIZE = 200
/** ScreenScraper's region codes in fallback order after the user's region (ES-DE order). */
const NAME_REGIONS = ['wor', 'us', 'ss', 'eu', 'jp']
const MEDIA_REGIONS = ['wor', 'us', 'eu', 'jp', 'cus', 'ss']
const LANGUAGES = ['en', 'wor']

interface SsText {
  text?: string
}
interface SsRegionText {
  region?: string
  text?: string
}
interface SsLangText {
  langue?: string
  text?: string
}
export interface SsMedia {
  type?: string
  parent?: string
  url?: string
  region?: string
  format?: string
}
interface SsGenre {
  id?: string
  principale?: string
  noms?: SsLangText[]
}
export interface SsGame {
  id?: string | number
  notgame?: string | boolean
  noms?: SsRegionText[]
  systeme?: { id?: string; text?: string }
  editeur?: SsText
  developpeur?: SsText
  joueurs?: SsText
  /** Out of 20. */
  note?: SsText
  synopsis?: SsLangText[]
  classifications?: { type?: string; text?: string }[]
  dates?: SsRegionText[]
  genres?: SsGenre[]
  medias?: SsMedia[]
  rom?: { romcrc?: string; rommd5?: string; romsha1?: string; romfilename?: string }
}
interface SsUser {
  id?: string
  niveau?: string | number
  maxthreads?: string | number
  requeststoday?: string | number
  maxrequestsperday?: string | number
}
interface SsResponse {
  header?: { success?: string }
  response?: { ssuser?: SsUser; jeu?: SsGame; jeux?: SsGame[] }
}

export interface ScreenScraperOptions {
  baseUrl?: string
  softname?: string
  limiter?: RateLimiter
  log?: Logger
}

function chain(preferred: string | undefined, base: string[]): string[] {
  const p = preferred?.toLowerCase()
  return p ? [p, ...base.filter((r) => r !== p)] : base
}

/** First item whose region appears earliest in the chain; items without a region, then any item, as fallbacks. */
export function pickByRegion<T extends { region?: string }>(
  items: T[] | undefined,
  regions: string[]
): T | undefined {
  const list = (items ?? []).filter((i) => i && typeof i === 'object')
  for (const region of regions) {
    const hit = list.find((i) => i.region?.toLowerCase() === region)
    if (hit) return hit
  }
  return list.find((i) => !i.region) ?? list[0]
}

export function pickByLanguage<T extends { langue?: string }>(
  items: T[] | undefined,
  languages: string[]
): T | undefined {
  const list = (items ?? []).filter((i) => i && typeof i === 'object')
  for (const lang of languages) {
    const hit = list.find((i) => i.langue?.toLowerCase() === lang)
    if (hit) return hit
  }
  return list[0]
}

function pickMedia(
  medias: SsMedia[] | undefined,
  types: string[],
  regions: string[]
): SsMedia | undefined {
  for (const type of types) {
    const hit = pickByRegion(
      (medias ?? []).filter((m) => m.type === type && m.url),
      regions
    )
    if (hit) return hit
  }
  return undefined
}

function normalizeDate(text: string | undefined): string | undefined {
  const t = text?.trim()
  if (!t) return undefined
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(t)) return t
  const year = t.match(/\b(\d{4})\b/)
  return year ? year[1] : undefined
}

function textOf(value: SsText | undefined): string | undefined {
  const t = value?.text?.trim()
  return t || undefined
}

/**
 * Media URLs come back with spaces unescaped; encode them and attach the user's credentials so the download counts
 * against the user's own quota. The query is appended as-is rather than re-serialized, to keep the server's format.
 */
function mediaUrl(url: string, user: { ssid: string; sspassword: string }): string {
  let out = url.trim().replace(/ /g, '%20')
  if (user.ssid && user.sspassword && /^https?:\/\//i.test(out)) {
    const extra: string[] = []
    if (!/[?&]ssid=/.test(out)) extra.push(`ssid=${encodeURIComponent(user.ssid)}`)
    if (!/[?&]sspassword=/.test(out))
      extra.push(`sspassword=${encodeURIComponent(user.sspassword)}`)
    if (extra.length) out += (out.includes('?') ? '&' : '?') + extra.join('&')
  }
  return out
}

function isNotGame(jeu: SsGame): boolean {
  return jeu.notgame === true || String(jeu.notgame).toLowerCase() === 'true'
}

/** Map a ScreenScraper game record to PlayOut metadata and media URLs. */
export function mapScreenScraperGame(
  jeu: SsGame,
  prefs: { region: string; language: string; ssid?: string; sspassword?: string }
): ScrapedResult {
  const nameRegions = chain(prefs.region, NAME_REGIONS)
  const mediaRegions = chain(prefs.region, MEDIA_REGIONS)
  const languages = chain(prefs.language, LANGUAGES)
  const user = { ssid: prefs.ssid ?? '', sspassword: prefs.sspassword ?? '' }

  const metadata: Partial<GameMetadata> = { sources: { screenscraper: String(jeu.id) } }
  const description = pickByLanguage(jeu.synopsis, languages)?.text?.trim()
  if (description) metadata.description = description
  const releaseDate = normalizeDate(pickByRegion(jeu.dates, nameRegions)?.text)
  if (releaseDate) metadata.releaseDate = releaseDate
  const developer = textOf(jeu.developpeur)
  if (developer) metadata.developers = [developer]
  const publisher = textOf(jeu.editeur)
  if (publisher) metadata.publishers = [publisher]
  const genres = [
    ...new Set(
      (jeu.genres ?? [])
        .map((g) => pickByLanguage(g.noms, languages)?.text?.trim())
        .filter((g): g is string => !!g)
    )
  ]
  if (genres.length) metadata.genres = genres
  const note = Number(textOf(jeu.note))
  if (Number.isFinite(note) && note > 0)
    metadata.rating = Math.max(0, Math.min(100, Math.round((note / 20) * 100)))
  const players = textOf(jeu.joueurs)
  if (players) metadata.players = players
  const tags = [
    ...new Set(
      (jeu.classifications ?? [])
        .map((c) => [c.type, c.text].filter(Boolean).join(' ').trim())
        .filter(Boolean)
    )
  ]
  if (tags.length) metadata.tags = tags

  const media: ScrapedMedia = {}
  const cover = pickMedia(jeu.medias, ['box-2D', 'steamgrid'], mediaRegions)
  if (cover?.url) media.cover = mediaUrl(cover.url, user)
  const hero = pickMedia(jeu.medias, ['fanart', 'mixrbv2'], mediaRegions)
  if (hero?.url) media.hero = mediaUrl(hero.url, user)
  const logo = pickMedia(
    jeu.medias,
    ['wheel-hd', 'wheel', 'wheel-carbon', 'wheel-steel'],
    mediaRegions
  )
  if (logo?.url) media.logo = mediaUrl(logo.url, user)
  const screenshots = ['ss', 'sstitle']
    .map((type) => pickMedia(jeu.medias, [type], mediaRegions)?.url)
    .filter((url): url is string => !!url)
    .map((url) => mediaUrl(url, user))
  if (screenshots.length) media.screenshots = [...new Set(screenshots)].slice(0, MAX_SCREENSHOTS)

  const title = pickByRegion(jeu.noms, nameRegions)?.text?.trim()
  return { title: title || undefined, metadata, media }
}

function describe(err: HttpError): string | undefined {
  const body = err.body ?? ''
  // The live API writes "développeur" with the accent (some endpoints without it).
  if (/d[eé]veloppeur/i.test(body)) return 'invalid developer credentials'
  if (/utilisateur|membre/i.test(body) && /erreur de login/i.test(body))
    return 'invalid user name or password'
  if (/non trouv/i.test(body) || err.status === 404) return 'not found'
  switch (err.status) {
    case 400:
      return `bad request${body ? ` (${body.slice(0, 120)})` : ''}`
    case 401:
      return 'API temporarily closed to non-members (server busy)'
    case 403:
      return 'invalid developer credentials'
    case 423:
      return 'API closed for maintenance'
    case 426:
      return 'this PlayOut version is blacklisted by ScreenScraper'
    case 429:
      return 'thread limit reached, try again later'
    case 430:
      return 'daily request quota exceeded'
    case 431:
      return 'too many unrecognised ROMs today'
    default:
      return err.status === 200 ? 'unreadable response' : undefined
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || /non trouv/i.test(err.body ?? ''))
}

export function createScreenScraperScraper(options: ScreenScraperOptions = {}): Scraper {
  const baseUrl = (options.baseUrl ?? SCREENSCRAPER_BASE_URL).replace(/\/+$/, '')
  const softname = options.softname ?? SCREENSCRAPER_SOFTNAME
  const limiter = options.limiter ?? new RateLimiter(1, 1)
  const log = options.log ?? createLogger('scrapers:screenscraper')
  // One slot until ssuser.maxthreads says otherwise; mediaJeu.php downloads share it (docs/research 3.6: 429).
  const gate = new Gate(1)
  const cache = new Map<string, SsGame>()

  function remember(id: string, jeu: SsGame): void {
    cache.delete(id)
    cache.set(id, jeu)
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  }

  function creds(settings: Settings): {
    devId: string
    devPassword: string
    user: string
    password: string
  } {
    const s = settings.scrapers.screenscraper
    return {
      devId: s.devId?.trim() ?? '',
      devPassword: s.devPassword?.trim() ?? '',
      user: s.user?.trim() ?? '',
      password: s.password ?? ''
    }
  }

  function isConfigured(settings: Settings): boolean {
    const c = creds(settings)
    return c.devId.length > 0 && c.devPassword.length > 0
  }

  function prefs(settings: Settings): {
    region: string
    language: string
    ssid?: string
    sspassword?: string
  } {
    const c = creds(settings)
    const user = c.user && c.password ? { ssid: c.user, sspassword: c.password } : {}
    return { region: settings.scrapers.region, language: settings.scrapers.language, ...user }
  }

  async function call(
    settings: Settings,
    endpoint: string,
    params: Record<string, string | number | undefined>
  ): Promise<SsResponse> {
    const c = creds(settings)
    if (!c.devId || !c.devPassword)
      throw new HttpError(`${SERVICE}: developer credentials not configured`, {
        status: 403,
        url: baseUrl
      })
    const user = c.user && c.password ? { ssid: c.user, sspassword: c.password } : {}
    const url = buildUrl(`${baseUrl}/${endpoint}`, {
      devid: c.devId,
      devpassword: c.devPassword,
      softname,
      output: 'json',
      ...user,
      ...params
    })
    let body: SsResponse
    try {
      body = await httpJson<SsResponse>(url, {}, { limiter, gate, log, timeoutMs: 30_000 })
    } catch (err) {
      throw err instanceof HttpError ? serviceError(SERVICE, err, describe) : toError(err)
    }
    const ssuser = body.response?.ssuser
    if (ssuser) {
      if (c.user && String(ssuser.niveau) === '0')
        throw new HttpError(`${SERVICE}: invalid user name or password`, { status: 401, url })
      const threads = Number(ssuser.maxthreads)
      if (threads >= 1) gate.setCapacity(Math.min(MAX_THREADS, threads))
      log.debug(
        `ScreenScraper quota: ${ssuser.requeststoday ?? '?'}/${ssuser.maxrequestsperday ?? '?'} requests today, ${ssuser.maxthreads ?? '?'} threads`
      )
    }
    return body
  }

  function toCandidate(jeu: SsGame, settings: Settings): MetadataCandidate | null {
    if (!jeu || jeu.id === undefined || jeu.id === null || jeu.id === '' || isNotGame(jeu))
      return null
    const p = prefs(settings)
    const title = pickByRegion(jeu.noms, chain(p.region, NAME_REGIONS))?.text?.trim()
    if (!title || /^ZZZ\(notgame\)/i.test(title)) return null
    const id = String(jeu.id)
    remember(id, jeu)
    const candidate: MetadataCandidate = { scraper: 'screenscraper', externalId: id, title }
    const releaseDate = normalizeDate(pickByRegion(jeu.dates, chain(p.region, NAME_REGIONS))?.text)
    if (releaseDate) candidate.releaseDate = releaseDate
    if (jeu.systeme?.text) candidate.platform = jeu.systeme.text
    const systemId = Number.parseInt(String(jeu.systeme?.id ?? ''), 10)
    if (Number.isFinite(systemId)) candidate.platformIds = [systemId]
    const cover = pickMedia(jeu.medias, ['box-2D'], chain(p.region, MEDIA_REGIONS))
    if (cover?.url)
      candidate.cover = mediaUrl(cover.url, { ssid: p.ssid ?? '', sspassword: p.sspassword ?? '' })
    return candidate
  }

  /** Hashes of the ROM file when it is a regular file of at most MAX_HASH_BYTES (m3u playlists are never hashed). */
  async function romIdentity(game: Game): Promise<FileHashes | null> {
    if (!game.romPath || extname(game.romPath).toLowerCase() === '.m3u') return null
    const st = await statSafe(game.romPath)
    if (!st || !st.isFile() || st.size === 0 || st.size > MAX_HASH_BYTES) return null
    const hashes = await hashFile(game.romPath, { maxBytes: MAX_HASH_BYTES })
    if (!hashes) log.warn(`could not hash ${game.romPath}`)
    return hashes
  }

  return {
    id: 'screenscraper',
    isConfigured,
    mediaPolicy: { gate, limiter },

    async search(game, settings, query) {
      const systemeid = platformIdFor('screenscraper', platformKeyForGame(game))
      const romnom = game.romPath ? basename(game.romPath) : undefined
      if (!query) {
        const identity = await romIdentity(game)
        if (identity && romnom) {
          try {
            const body = await call(settings, 'jeuInfos.php', {
              systemeid,
              romtype: 'rom',
              romnom,
              romtaille: identity.size,
              crc: identity.crc32,
              md5: identity.md5,
              sha1: identity.sha1
            })
            const jeu = body.response?.jeu
            const candidate = jeu ? toCandidate(jeu, settings) : null
            if (candidate) {
              const exact = jeu?.rom?.rommd5?.toLowerCase() === identity.md5
              log.debug(
                `ScreenScraper identified ${romnom} as game ${candidate.externalId} (${exact ? 'hash match' : 'name match'})`
              )
              // A name match (no hash) is still ScreenScraper's pick for this very file.
              return [{ ...candidate, byId: true }]
            }
          } catch (err) {
            if (!isNotFound(err)) throw err
            log.debug(`no ScreenScraper game for ${romnom} by hash; searching by name`)
          }
        }
      }
      const name = searchNameFor(game, query)
      if (!name) return []
      try {
        const body = await call(settings, 'jeuRecherche.php', { recherche: name, systemeid })
        return (body.response?.jeux ?? [])
          .map((jeu) => toCandidate(jeu, settings))
          .filter((c): c is MetadataCandidate => c !== null)
          .slice(0, MAX_CANDIDATES)
      } catch (err) {
        if (isNotFound(err)) return []
        throw err
      }
    },

    async fetch(game, candidate, settings) {
      const id = candidate.externalId
      let jeu = cache.get(id)
      if (!jeu) {
        const body = await call(settings, 'jeuInfos.php', {
          gameid: id,
          systemeid: platformIdFor('screenscraper', platformKeyForGame(game)),
          romnom: game.romPath ? basename(game.romPath) : undefined
        })
        jeu = body.response?.jeu
        if (!jeu || jeu.id === undefined)
          throw new HttpError(`${SERVICE}: game ${id} not found`, { status: 404, url: baseUrl })
        remember(id, jeu)
      }
      return mapScreenScraperGame(jeu, prefs(settings))
    }
  }
}

export const screenScraperScraper: Scraper = createScreenScraperScraper()
