// Epic key images from the launcher's catalog cache (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §13.4):
// `%ProgramData%\Epic\EpicGamesLauncher\Data\Catalog\catcache.bin` is base64 of a JSON array of catalog items
// with `keyImages` on `cdn1.epicgames.com`, so an owned-but-not-installed Epic game gets its cover URL with zero
// requests. Indexed by catalog item id and by `releaseInfo[].appId` (= appName); the owned import hands the same
// `keyImages` to the lane as seeds, this is the offline copy for games imported earlier.
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ArtKind } from '../../../shared/types'
import type { Logger } from '../../logger'
import { knownFolders } from '../../util/paths'
import type { ArtCandidate, ArtCandidates, DirectArtSource } from '../types'

const SOURCE_ID = 'epic-catalog' as const

/** Key image types per kind, best first; the resize query keeps covers at 675x900 instead of 1200x1600. */
const KEY_IMAGES: Partial<
  Record<ArtKind, { type: string; query?: string; width: number; height: number }[]>
> = {
  cover: [
    { type: 'DieselGameBoxTall', query: '?w=600&h=900&resize=1', width: 675, height: 900 },
    { type: 'OfferImageTall', query: '?w=600&h=900&resize=1', width: 675, height: 900 }
  ],
  hero: [{ type: 'DieselGameBox', width: 1920, height: 1080 }],
  logo: [{ type: 'DieselGameBoxLogo', width: 1920, height: 1080 }]
}

export interface EpicCatalogItem {
  id?: string
  namespace?: string
  title?: string
  keyImages?: { type?: string; url?: string; width?: number; height?: number }[]
  releaseInfo?: { appId?: string; platform?: string[] }[]
}

export interface EpicCatalogOptions {
  /** Override the cache file (tests); default `%ProgramData%\Epic\EpicGamesLauncher\Data\Catalog\catcache.bin`. */
  catcacheFile?: string
  log?: Logger
}

export function defaultCatcacheFile(): string {
  return join(
    knownFolders().programData,
    'Epic',
    'EpicGamesLauncher',
    'Data',
    'Catalog',
    'catcache.bin'
  )
}

/** Decode `catcache.bin` (base64 JSON array). Tolerates a BOM and a plain-JSON file. Exported for tests. */
export function parseCatcache(raw: Buffer): EpicCatalogItem[] {
  const text = raw
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trim()
  const json = text.startsWith('[') ? text : Buffer.from(text, 'base64').toString('utf8')
  const parsed = JSON.parse(json.replace(/^\uFEFF/, '')) as unknown
  return Array.isArray(parsed) ? (parsed as EpicCatalogItem[]) : []
}

/** Index catalog items by lower-cased catalog item id and by every `releaseInfo[].appId`. */
export function indexCatalog(items: EpicCatalogItem[]): Map<string, EpicCatalogItem> {
  const index = new Map<string, EpicCatalogItem>()
  for (const item of items) {
    if (!item.keyImages?.length) continue
    if (item.id) index.set(item.id.toLowerCase(), item)
    for (const release of item.releaseInfo ?? []) {
      const appId = release.appId?.trim().toLowerCase()
      if (appId && !index.has(appId)) index.set(appId, item)
    }
  }
  return index
}

/** Candidate URLs per kind from an item's `keyImages`, best first. */
export function epicCandidates(item: EpicCatalogItem, kinds: ArtKind[]): ArtCandidates {
  const out: ArtCandidates = {}
  for (const kind of kinds) {
    const list: ArtCandidate[] = []
    for (const spec of KEY_IMAGES[kind] ?? []) {
      const image = item.keyImages?.find((k) => k.type === spec.type && k.url)
      const url = image?.url?.trim()
      if (!url || !/^https?:\/\//.test(url)) continue
      list.push({
        kind,
        source: SOURCE_ID,
        url: `${url}${spec.query ?? ''}`,
        width: spec.query ? spec.width : (image?.width ?? spec.width),
        height: spec.query ? spec.height : (image?.height ?? spec.height)
      })
    }
    if (list.length) out[kind] = list
  }
  return out
}

export function createEpicCatalogSource(options: EpicCatalogOptions = {}): DirectArtSource {
  const log = options.log
  const file = options.catcacheFile ?? defaultCatcacheFile()
  let indexPromise: Promise<Map<string, EpicCatalogItem>> | null = null

  function index(): Promise<Map<string, EpicCatalogItem>> {
    indexPromise ??= (async () => {
      const started = performance.now()
      try {
        const items = parseCatcache(await fs.readFile(file))
        const map = indexCatalog(items)
        log?.info(
          `epic-catalog: ${items.length} catalog items, ${map.size} keys in ${Math.round(performance.now() - started)} ms`
        )
        return map
      } catch (err) {
        log?.debug(`epic-catalog: no catalog cache (${(err as Error).message})`)
        return new Map()
      }
    })()
    return indexPromise
  }

  return {
    id: SOURCE_ID,
    batchSize: 1,
    isConfigured: () => true,
    hasIdFor: (ids) => !!(ids.epicCatalogItemId || ids.epicAppName),
    async candidates(games, kinds) {
      const out = new Map<string, ArtCandidates>()
      const wanted = games.filter(({ ids }) => ids.epicCatalogItemId || ids.epicAppName)
      if (!wanted.length) return out
      const catalog = await index()
      if (!catalog.size) return out
      for (const { game, ids } of wanted) {
        const item =
          (ids.epicCatalogItemId && catalog.get(ids.epicCatalogItemId.toLowerCase())) ||
          (ids.epicAppName && catalog.get(ids.epicAppName.toLowerCase()))
        if (!item) continue
        const result = epicCandidates(item, kinds)
        if (Object.keys(result).length) out.set(game.id, result)
      }
      return out
    }
  }
}
