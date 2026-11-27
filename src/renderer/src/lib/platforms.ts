import { STORE_PLATFORMS } from '@shared/platforms'
import type { Game, Platform, SourceId } from '@shared/types'

/** Platform lookups. Platforms come from the library snapshot (one row per store, 'pc', and each system with games). */

/** Find a platform row by id. */
export function findPlatform(id: string, platforms: Platform[]): Platform | undefined {
  return platforms.find((p) => p.id === id)
}

/** Display name for a platform id; unknown ids are shown capitalised ('snes' -> 'Snes'). */
export function platformName(id: string, platforms: Platform[]): string {
  const platform = findPlatform(id, platforms)
  if (platform) return platform.name
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : ''
}

/** Platform row for a game, or a synthetic one so the badge and row header always have something to show. */
export function platformForGame(game: Game, platforms: Platform[]): Platform {
  return findPlatform(game.platformId, platforms) ?? syntheticPlatform(game.platformId)
}

/** Placeholder platform used when a game's platformId has no row yet (e.g. mid-scan). */
export function syntheticPlatform(id: string): Platform {
  return { id, name: platformName(id, []), kind: 'pc', icon: 'gamepad-2', sortOrder: 9999 }
}

/** Platforms ordered as rows should appear: by sortOrder, then name. */
export function sortPlatforms(platforms: Platform[]): Platform[] {
  return [...platforms].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** The store's display name ('Steam', 'Epic Games') for a game source; undefined for 'manual' and 'rom'. */
export function storeNameOf(source: SourceId): string | undefined {
  return source === 'manual' || source === 'rom' ? undefined : STORE_PLATFORMS[source].name
}
