// Direct art registry (docs/ARCHITECTURE.md §4.6 "Art pipeline"): sources that turn ids into URLs without a
// search. The registry batches games per source (`batchSize`), skips sources whose credentials are missing and
// merges the per-kind candidates in source order: `steam-cdn`, `gog-images`, `epic-catalog`, `xbox-catalog`,
// `steamgriddb-platform`, `igdb-external`. Every request goes through `http.ts`; the SteamGridDB and IGDB
// sources take the scrapers' own limiters (`steamGridDbLimiter`, `igdbLimiter`) so a service never sees the
// lane's batches and the scraper's searches as two independent buckets.
import type { ArtKind, Game, Settings } from '../../../shared/types'
import type { Logger } from '../../logger'
import type { ArtCandidates, ArtIds, DirectArtSource } from '../types'
import { createEpicCatalogSource } from './epic-catalog'
import { createGogImagesSource } from './gog-images'
import { createIgdbExternalSource } from './igdb-external'
import { createSteamCdnSource } from './steam-cdn'
import { createSteamGridDbPlatformSource } from './steamgriddb-platform'
import { createXboxCatalogSource } from './xbox-catalog'

export { createSteamCdnSource, steamCdnUrl, steamCoverFallbacks, STEAM_CDN } from './steam-cdn'
export { createGogImagesSource, gogFormattedUrl, gamesDbKeysOf } from './gog-images'
export {
  createEpicCatalogSource,
  epicCandidates,
  indexCatalog,
  parseCatcache
} from './epic-catalog'
export { createXboxCatalogSource, xboxCandidates, XBOX_CATALOG_BATCH } from './xbox-catalog'
export {
  createSteamGridDbPlatformSource,
  sgdbKeysOf,
  splitResponse,
  SGDB_PLATFORM_BATCH
} from './steamgriddb-platform'
export { createIgdbExternalSource, igdbQueries, IGDB_EXTERNAL_BATCH } from './igdb-external'

export interface DirectArtRegistryDeps {
  log: Logger
  /** Override the source list (tests); default = the six sources above in lane order. */
  sources?: DirectArtSource[]
}

export interface DirectArtRegistry {
  readonly sources: DirectArtSource[]
  /**
   * Candidate URLs per game and kind from every configured source, best first (source order, then the source's
   * own order). Games with no usable id are absent. Batches larger than a source's `batchSize` are split.
   */
  candidates(
    games: { game: Game; ids: ArtIds }[],
    kinds: ArtKind[],
    settings: Settings
  ): Promise<Map<string, ArtCandidates>>
}

export function defaultDirectArtSources(log: Logger): DirectArtSource[] {
  return [
    createSteamCdnSource(),
    createGogImagesSource({ log }),
    createEpicCatalogSource({ log }),
    createXboxCatalogSource({ log }),
    createSteamGridDbPlatformSource({ log }),
    createIgdbExternalSource({ log })
  ]
}

/** The six sources in lane order, as `metadata-service.ts` wires them into the cover lane. */
export function createDirectArtSources(deps: { log: Logger }): DirectArtSource[] {
  return defaultDirectArtSources(deps.log)
}

export function createDirectArtRegistry(deps: DirectArtRegistryDeps): DirectArtRegistry {
  const { log } = deps
  const sources = deps.sources ?? defaultDirectArtSources(log)
  return {
    sources,
    async candidates(games, kinds, settings) {
      const out = new Map<string, ArtCandidates>()
      if (!games.length || !kinds.length) return out
      for (const source of sources) {
        if (!source.isConfigured(settings)) continue
        const size = Math.max(1, source.batchSize)
        for (let i = 0; i < games.length; i += size) {
          const batch = games.slice(i, i + size)
          let found: Map<string, ArtCandidates>
          try {
            found = await source.candidates(batch, kinds, settings)
          } catch (err) {
            log.warn(
              `direct-art: ${source.id} failed for ${batch.length} games: ${(err as Error).message}`
            )
            continue
          }
          for (const [gameId, result] of found) {
            const merged = out.get(gameId) ?? {}
            for (const kind of kinds) {
              const list = result[kind]
              if (list?.length) merged[kind] = [...(merged[kind] ?? []), ...list]
            }
            out.set(gameId, merged)
          }
        }
      }
      return out
    }
  }
}
