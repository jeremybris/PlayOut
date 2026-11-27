// Xbox / Microsoft Store display catalog by store id (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §13.7):
// one anonymous `displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<id,...>` request per batch of 20 lists the
// `Images` of each product; `store-images.s-microsoft.com` resizes server-side, so the poster is fetched at
// 600x900 (140 KB) instead of its 617 KB original.
import type { ArtKind } from '../../../shared/types'
import type { Logger } from '../../logger'
import { httpJson, RateLimiter, redactUrl } from '../http'
import type { ArtCandidate, ArtCandidates, DirectArtSource } from '../types'

export const DISPLAYCATALOG_BASE_URL = 'https://displaycatalog.mp.microsoft.com/v7.0'
export const XBOX_CATALOG_BATCH = 20

const SOURCE_ID = 'xbox-catalog' as const

/** `ImagePurpose` values per kind, best first, with the resize query that fits the kind. */
const PURPOSES: Partial<
  Record<ArtKind, { purposes: string[]; query: string; width: number; height: number }>
> = {
  cover: {
    purposes: ['Poster', 'BoxArt', 'BrandedKeyArt'],
    query: '?w=600&h=900&mode=scale&q=90',
    width: 600,
    height: 900
  },
  hero: {
    purposes: ['SuperHeroArt', 'TitledHeroArt', 'BrandedKeyArt'],
    query: '?w=1920&mode=scale&q=90',
    width: 1920,
    height: 1080
  },
  logo: { purposes: ['Logo'], query: '', width: 0, height: 0 },
  icon: { purposes: ['Tile'], query: '?w=256&h=256&mode=scale&q=90', width: 256, height: 256 }
}

interface CatalogImage {
  ImagePurpose?: string
  Uri?: string
  Width?: number
  Height?: number
}
interface CatalogProduct {
  ProductId?: string
  LocalizedProperties?: { Images?: CatalogImage[] }[]
}
interface CatalogResponse {
  Products?: CatalogProduct[]
}

export interface XboxCatalogOptions {
  baseUrl?: string
  limiter?: RateLimiter
  market?: string
  log?: Logger
}

/** Candidate URLs per kind from a product's images, best first. Exported for tests. */
export function xboxCandidates(product: CatalogProduct, kinds: ArtKind[]): ArtCandidates {
  const images = product.LocalizedProperties?.flatMap((p) => p.Images ?? []) ?? []
  const out: ArtCandidates = {}
  for (const kind of kinds) {
    const spec = PURPOSES[kind]
    if (!spec) continue
    const list: ArtCandidate[] = []
    for (const purpose of spec.purposes) {
      const image = images.find((i) => i.ImagePurpose === purpose && i.Uri)
      if (!image?.Uri) continue
      const uri = image.Uri.startsWith('//') ? `https:${image.Uri}` : image.Uri
      if (!/^https?:\/\//.test(uri)) continue
      list.push({
        kind,
        source: SOURCE_ID,
        url: `${uri}${spec.query}`,
        width: spec.width || image.Width,
        height: spec.height || image.Height
      })
    }
    if (list.length) out[kind] = list
  }
  return out
}

const STORE_ID_RE = /^[A-Za-z0-9]+$/

export function createXboxCatalogSource(options: XboxCatalogOptions = {}): DirectArtSource {
  const log = options.log
  const baseUrl = (options.baseUrl ?? DISPLAYCATALOG_BASE_URL).replace(/\/+$/, '')
  const limiter = options.limiter ?? new RateLimiter(4, 4)
  const market = options.market ?? 'US'

  return {
    id: SOURCE_ID,
    batchSize: XBOX_CATALOG_BATCH,
    isConfigured: () => true,
    hasIdFor: (ids) => STORE_ID_RE.test(ids.xboxStoreId?.trim() ?? ''),
    async candidates(games, kinds) {
      const out = new Map<string, ArtCandidates>()
      const byStoreId = new Map<string, string[]>()
      for (const { game, ids } of games) {
        const storeId = ids.xboxStoreId?.trim()
        if (!storeId || !STORE_ID_RE.test(storeId)) continue
        const key = storeId.toUpperCase()
        byStoreId.set(key, [...(byStoreId.get(key) ?? []), game.id])
      }
      if (!byStoreId.size) return out
      const url = `${baseUrl}/products?bigIds=${[...byStoreId.keys()].join(',')}&market=${market}&languages=en-US`
      let response: CatalogResponse
      try {
        response = await httpJson<CatalogResponse>(
          url,
          { headers: { 'MS-CV': 'PlayOut' } },
          { limiter, retries: 1, log }
        )
      } catch (err) {
        log?.debug(`xbox-catalog: ${redactUrl(url)}: ${(err as Error).message}`)
        return out
      }
      for (const product of response.Products ?? []) {
        const gameIds = product.ProductId
          ? byStoreId.get(product.ProductId.toUpperCase())
          : undefined
        if (!gameIds) continue
        const result = xboxCandidates(product, kinds)
        if (!Object.keys(result).length) continue
        for (const gameId of gameIds) out.set(gameId, result)
      }
      return out
    }
  }
}
