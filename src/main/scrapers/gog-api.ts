import type { Game, MetadataCandidate } from '../../shared/types'
import { createLogger } from '../logger'
import { httpJson, HttpError, RateLimiter } from './http'
import { describeError, htmlToText } from './steam-store'
import type { ScrapedResult, Scraper } from './types'

const log = createLogger('scrapers:gog')

const PRODUCTS_API = 'https://api.gog.com/products'
const V2_API = 'https://api.gog.com/v2/games'
const GAMESDB_API = 'https://gamesdb.gog.com/platforms/gog/external_releases'
const CATALOG_API = 'https://catalog.gog.com/v1/catalog'
const STORE_BASE = 'https://www.gog.com/game'
const TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX = 500
const MAX_SCREENSHOTS = 8
const MAX_SEARCH_RESULTS = 8

// Internal store endpoints without published limits: stay well below one request per second per game.
const limiter = new RateLimiter(2, 2)

// ---------------------------------------------------------------------------
// Response shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface GogProduct {
  id: number
  title?: string
  slug?: string
  game_type?: string
  release_date?: string | null
  images?: {
    background?: string
    logo?: string
    logo2x?: string
    icon?: string
    sidebarIcon?: string
  }
  links?: { product_card?: string }
  description?: { lead?: string; full?: string; whats_cool_about_it?: string }
  screenshots?: {
    image_id?: string
    formatter_template_url?: string
    formatted_images?: { formatter_name: string; image_url: string }[]
  }[]
}

interface GamesDbImage {
  url_format?: string
}

export interface GamesDbRelease {
  first_release_date?: string | null
  title?: Record<string, string>
  summary?: Record<string, string>
  game?: {
    first_release_date?: string | null
    developers?: { name?: string }[]
    publishers?: { name?: string }[]
    genres?: { name?: Record<string, string> }[]
    aggregated_rating?: number | null
    summary?: Record<string, string>
    vertical_cover?: GamesDbImage
    cover?: GamesDbImage
    background?: GamesDbImage
    horizontal_artwork?: GamesDbImage
    logo?: GamesDbImage
    icon?: GamesDbImage
    square_icon?: GamesDbImage
    screenshots?: GamesDbImage[]
  }
}

export interface GogV2Game {
  _links?: {
    boxArtImage?: { href?: string }
    backgroundImage?: { href?: string }
    logo?: { href?: string }
    icon?: { href?: string }
  }
}

interface CatalogResponse {
  products?: {
    id?: string | number
    title?: string
    releaseDate?: string
    coverVertical?: string
    productType?: string
  }[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The GOG product id of a game: `extra.gogProductId`, or the external id of a game from the GOG provider. */
export function gogProductIdOf(game: Pick<Game, 'source' | 'externalId' | 'extra'>): string | null {
  const raw = game.extra?.gogProductId ?? (game.source === 'gog' ? game.externalId : undefined)
  const id = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  return /^\d+$/.test(id) ? id : null
}

/** GOG image links come protocol-relative ("//images-2.gog-statics.com/..."). */
function absoluteUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined
  if (url.startsWith('//')) return `https:${url}`
  return /^https?:\/\//.test(url) ? url : undefined
}

/** Fill a gamesdb `url_format` template (`...{formatter}.{ext}?namespace=gamesdb`). */
export function gamesDbImageUrl(
  image: GamesDbImage | undefined,
  formatter: string,
  ext: 'jpg' | 'png' | 'webp'
): string | undefined {
  const template = image?.url_format
  if (!template || !template.includes('{formatter}')) return undefined
  return template.replace('{formatter}', formatter).replace('{ext}', ext)
}

/** 'YYYY-MM-DD' from an ISO timestamp or a 'YYYY.MM.DD' catalog date, taken as written (no time-zone shift). */
export function gogDatePart(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const m = value.trim().match(/^(\d{4})[-.](\d{2})[-.](\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

function localized(value: Record<string, string> | undefined): string | undefined {
  const text = value?.['en-US'] ?? value?.['*'] ?? (value ? Object.values(value)[0] : undefined)
  return text?.trim() || undefined
}

function names(list: { name?: string }[] | undefined): string[] {
  const out: string[] = []
  for (const item of list ?? []) {
    const n = item?.name?.trim()
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

function productScreenshots(product: GogProduct): string[] {
  const out: string[] = []
  for (const shot of product.screenshots ?? []) {
    const large = shot.formatted_images?.find((f) => f.formatter_name === 'ggvgl_2x')?.image_url
    const url = large ?? shot.formatter_template_url?.replace('{formatter}', 'ggvgl_2x')
    if (url) out.push(url)
    if (out.length >= MAX_SCREENSHOTS) break
  }
  return out
}

/** Pure mapping of a product (+ optional gamesdb release and v2 record) to PlayOut metadata and art URLs. */
export function mapGogProduct(
  product: GogProduct,
  release: GamesDbRelease | null,
  v2: GogV2Game | null
): ScrapedResult {
  const id = String(product.id)
  const game = release?.game
  const lead = htmlToText(product.description?.lead)
  const full = htmlToText(product.description?.full)
  const summary = localized(release?.summary) ?? localized(game?.summary)
  const rating = game?.aggregated_rating
  const gamesDbScreens = (game?.screenshots ?? [])
    .map((s) => gamesDbImageUrl(s, '_1600', 'jpg'))
    .filter((u): u is string => !!u)
    .slice(0, MAX_SCREENSHOTS)

  return {
    title: product.title?.trim() || localized(release?.title) || undefined,
    metadata: {
      description: full ?? lead ?? summary,
      shortDescription: lead ?? summary,
      releaseDate:
        gogDatePart(release?.first_release_date) ??
        gogDatePart(game?.first_release_date) ??
        gogDatePart(product.release_date),
      developers: names(game?.developers),
      publishers: names(game?.publishers),
      genres: (game?.genres ?? []).map((g) => localized(g.name)).filter((g): g is string => !!g),
      rating:
        typeof rating === 'number' && rating >= 0 && rating <= 100
          ? Math.round(rating * 10) / 10
          : undefined,
      links: {
        store:
          product.links?.product_card ??
          (product.slug ? `${STORE_BASE}/${product.slug}` : undefined)
      },
      sources: { gog: id }
    },
    media: {
      cover:
        gamesDbImageUrl(game?.vertical_cover, '', 'jpg') ??
        absoluteUrl(v2?._links?.boxArtImage?.href),
      hero:
        gamesDbImageUrl(game?.background, '_1600', 'jpg') ??
        absoluteUrl(product.images?.background) ??
        absoluteUrl(v2?._links?.backgroundImage?.href),
      logo:
        gamesDbImageUrl(game?.logo, '_glx_logo_2x', 'png') ??
        absoluteUrl(v2?._links?.logo?.href) ??
        absoluteUrl(product.images?.logo2x),
      icon:
        gamesDbImageUrl(game?.square_icon, '_glx_square_icon_v2', 'png') ??
        absoluteUrl(product.images?.icon) ??
        absoluteUrl(v2?._links?.icon?.href),
      screenshots: gamesDbScreens.length ? gamesDbScreens : productScreenshots(product)
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP (every endpoint is keyless; responses are cached for a day)
// ---------------------------------------------------------------------------

const productCache = new Map<string, { at: number; value: GogProduct | null }>()
const releaseCache = new Map<string, { at: number; value: GamesDbRelease | null }>()
const v2Cache = new Map<string, { at: number; value: GogV2Game | null }>()

async function cached<T>(
  store: Map<string, { at: number; value: T }>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await load()
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
  store.set(key, { at: Date.now(), value })
  return value
}

/** The product record, or null when GOG answers 404 for the id. */
export async function loadGogProduct(id: string): Promise<GogProduct | null> {
  return cached(productCache, id, async () => {
    await limiter.take()
    try {
      const product = await httpJson<GogProduct>(
        `${PRODUCTS_API}/${id}?expand=description,screenshots`,
        undefined,
        {
          timeoutMs: 20_000,
          retries: 2
        }
      )
      return product && typeof product === 'object' && product.id !== undefined ? product : null
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    }
  })
}

/**
 * GOG Galaxy's cross-store record for the product (developers, genres, rating, Galaxy art); null when unavailable.
 * Only a genuine 404 is remembered as "no data": a 5xx, 429, timeout or network error is not cached, so the next
 * scrape (or a forced refresh) asks again instead of leaving the game without credits and Galaxy art for a day.
 */
export async function loadGamesDbRelease(id: string): Promise<GamesDbRelease | null> {
  try {
    return await cached(releaseCache, id, async () => {
      await limiter.take()
      try {
        const release = await httpJson<GamesDbRelease>(`${GAMESDB_API}/${id}`, undefined, {
          timeoutMs: 20_000,
          retries: 1
        })
        return release && typeof release === 'object' ? release : null
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null
        throw err
      }
    })
  } catch (err) {
    log.debug(`gamesdb unavailable for ${id}: ${describeError(err)}`)
    return null
  }
}

/** Same caching rule as loadGamesDbRelease: 404 is cached, transient failures are not. */
async function loadGogV2(id: string): Promise<GogV2Game | null> {
  try {
    return await cached(v2Cache, id, async () => {
      await limiter.take()
      try {
        const v2 = await httpJson<GogV2Game>(`${V2_API}/${id}?locale=en-US`, undefined, {
          timeoutMs: 20_000,
          retries: 1
        })
        return v2 && typeof v2 === 'object' ? v2 : null
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null
        throw err
      }
    })
  } catch (err) {
    log.debug(`v2 record unavailable for ${id}: ${describeError(err)}`)
    return null
  }
}

async function searchCatalog(query: string): Promise<MetadataCandidate[]> {
  await limiter.take()
  const url = `${CATALOG_API}?limit=${MAX_SEARCH_RESULTS}&query=like:${encodeURIComponent(query)}&order=desc:score&productType=in:game`
  const res = await httpJson<CatalogResponse>(url, undefined, { timeoutMs: 20_000, retries: 1 })
  const out: MetadataCandidate[] = []
  for (const p of res?.products ?? []) {
    const id = p.id === undefined ? '' : String(p.id)
    if (!/^\d+$/.test(id) || !p.title) continue
    out.push({
      scraper: 'gog',
      externalId: id,
      title: p.title,
      releaseDate: gogDatePart(p.releaseDate),
      platform: 'PC',
      cover: absoluteUrl(p.coverVertical)
    })
    if (out.length >= MAX_SEARCH_RESULTS) break
  }
  return out
}

async function candidateFor(id: string): Promise<MetadataCandidate | null> {
  const product = await loadGogProduct(id)
  if (!product) return null
  const release = await loadGamesDbRelease(id)
  return {
    scraper: 'gog',
    externalId: id,
    title: product.title?.trim() || localized(release?.title) || `GOG product ${id}`,
    releaseDate: gogDatePart(release?.first_release_date) ?? gogDatePart(product.release_date),
    platform: 'PC',
    cover: gamesDbImageUrl(release?.game?.vertical_cover, '_glx_vertical_cover', 'jpg')
  }
}

/**
 * GOG scraper (keyless): `api.gog.com/products` for descriptions and store art, `gamesdb.gog.com` for
 * developers, genres, ratings and Galaxy-style art, and the public catalog for free-text searches.
 */
export const gogScraper: Scraper = {
  id: 'gog',
  idOnly: true,

  isConfigured(): boolean {
    return true
  },

  async search(game: Game, _settings, query?: string): Promise<MetadataCandidate[]> {
    const q = query?.trim()
    if (q) return searchCatalog(q)
    const id = gogProductIdOf(game)
    if (!id) return []
    const candidate = await candidateFor(id)
    return candidate ? [{ ...candidate, byId: true }] : []
  },

  async fetch(game: Game, candidate: MetadataCandidate): Promise<ScrapedResult> {
    const id = candidate.externalId.trim()
    if (!/^\d+$/.test(id)) throw new Error(`Invalid GOG product id "${candidate.externalId}"`)
    const product = await loadGogProduct(id)
    if (!product) throw new Error(`GOG has no product ${id} (${game.title})`)
    const release = await loadGamesDbRelease(id)
    const v2 = release?.game?.vertical_cover?.url_format ? null : await loadGogV2(id)
    return mapGogProduct(product, release, v2)
  }
}

/** Test hook: forget cached responses. */
export function clearGogCaches(): void {
  productCache.clear()
  releaseCache.clear()
  v2Cache.clear()
}
