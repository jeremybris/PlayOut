// Local art registry (docs/ARCHITECTURE.md §4.6 "Art pipeline"): the caches on this PC that already hold art for
// owned games, asked in order before any download. Availability and each source's index are decided once per run
// (first lookup) and dropped by `reset()` when both lanes drain, so the next scan sees new files. Zero network.
import type { ArtKind, Game, Settings } from '../../../shared/types'
import type { Logger } from '../../logger'
import type { ArtCandidates, ArtIds, LocalArtSource } from '../types'
import { createEsdeMediaSource } from './esde-media'
import { createGalaxyCacheSource } from './galaxy-cache'
import { createPlayniteFilesSource } from './playnite-files'
import { createSteamCacheSource } from './steam-cache'

export type { SteamCacheSource } from './steam-cache'
export type { GalaxyCacheSource, GalaxyPlatform } from './galaxy-cache'
export { createSteamCacheSource, parseAssetCache, parseBinaryVdf } from './steam-cache'
export { createGalaxyCacheSource, galaxyKeysOf, GALAXY_PLATFORMS } from './galaxy-cache'
export { createEsdeMediaSource, parseGamelistMedia, romKey } from './esde-media'
export { createPlayniteFilesSource, playniteKeysOf } from './playnite-files'

export interface LocalArtRegistryDeps {
  settings: { get(): Settings }
  log: Logger
  /** Override the source list (tests, the probe); default = steam-cache, galaxy-cache, esde-media, playnite-files. */
  sources?: LocalArtSource[]
}

export interface LocalArtRegistry {
  readonly sources: LocalArtSource[]
  /**
   * Candidates per kind from every available source, in registry order (so `steam-cache` answers before
   * `galaxy-cache` for the same Steam appid). Empty when `settings.scrapers.localArt` is off.
   */
  lookup(game: Game, ids: ArtIds, kinds: ArtKind[]): Promise<ArtCandidates>
  /** Drop the availability memo and every source's index. */
  reset(): void
}

/** The sources in lookup order; the Steam cache first because it is the largest and the fastest to index. */
export function defaultLocalArtSources(log: Logger): LocalArtSource[] {
  return [
    createSteamCacheSource({ log }),
    createGalaxyCacheSource({ log }),
    createEsdeMediaSource({ log }),
    createPlayniteFilesSource({ log })
  ]
}

export function createLocalArtRegistry(deps: LocalArtRegistryDeps): LocalArtRegistry {
  const { log } = deps
  const sources = deps.sources ?? defaultLocalArtSources(log)
  let availablePromise: Promise<LocalArtSource[]> | null = null

  async function resolveAvailable(settings: Settings): Promise<LocalArtSource[]> {
    const available: LocalArtSource[] = []
    for (const source of sources) {
      try {
        if (await source.isAvailable(settings)) {
          await source.index(settings)
          available.push(source)
        } else {
          log.debug(`local-art: ${source.id} not on this PC, skipped`)
        }
      } catch (err) {
        log.warn(`local-art: ${source.id} unavailable: ${(err as Error).message}`)
      }
    }
    log.info(`local-art: ${available.map((s) => s.id).join(', ') || 'no sources'} available`)
    return available
  }

  function available(settings: Settings): Promise<LocalArtSource[]> {
    availablePromise ??= resolveAvailable(settings)
    return availablePromise
  }

  return {
    sources,

    async lookup(game, ids, kinds) {
      const settings = deps.settings.get()
      const out: ArtCandidates = {}
      if (!settings.scrapers.localArt || !kinds.length) return out
      // Each source is asked only for the kinds nobody before it answered: the lane copies the first accepted
      // candidate, so a Galaxy readdir + sniff for a cover the Steam cache already found would be wasted work.
      let missing = kinds
      for (const source of await available(settings)) {
        if (!missing.length) break
        let found: ArtCandidates
        try {
          found = await source.lookup(game, ids, missing)
        } catch (err) {
          log.warn(
            `local-art: ${source.id} lookup failed for ${game.id}: ${(err as Error).message}`
          )
          continue
        }
        for (const kind of missing) {
          const list = found[kind]
          if (list?.length) out[kind] = list
        }
        missing = missing.filter((kind) => !out[kind])
      }
      return out
    },

    reset() {
      availablePromise = null
      for (const source of sources) source.reset()
    }
  }
}
