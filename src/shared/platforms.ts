import type { Platform, SourceId, StoreSourceId } from './types'

export type { StoreSourceId } from './types'

/**
 * Platform rows for the store providers. `icon` is a simple-icons slug; `shortName` is the store name the
 * Library tab strip and the detail panel's platform pill show when the full name is long.
 */
export const STORE_PLATFORMS: Record<StoreSourceId, Platform> = {
  steam: { id: 'steam', name: 'Steam', kind: 'store', icon: 'steam', sortOrder: 10 },
  epic: {
    id: 'epic',
    name: 'Epic Games',
    shortName: 'Epic',
    kind: 'store',
    icon: 'epicgames',
    sortOrder: 20
  },
  gog: { id: 'gog', name: 'GOG', kind: 'store', icon: 'gogdotcom', sortOrder: 30 },
  ea: { id: 'ea', name: 'EA App', shortName: 'EA', kind: 'store', icon: 'ea', sortOrder: 40 },
  battlenet: {
    id: 'battlenet',
    name: 'Battle.net',
    kind: 'store',
    icon: 'battledotnet',
    sortOrder: 50
  },
  ubisoft: {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    shortName: 'Ubisoft',
    kind: 'store',
    icon: 'ubisoft',
    sortOrder: 60
  },
  // Not 'xbox': that is ES-DE's id for the emulated original Xbox (its ROM folder, its games' platform).
  xbox: { id: 'xbox-pc', name: 'Xbox', kind: 'store', icon: 'xbox', sortOrder: 70 }
}

/** Platform row for user-added executables. `icon` is a lucide icon name. */
export const PC_PLATFORM: Platform = {
  id: 'pc',
  name: 'PC',
  kind: 'pc',
  icon: 'monitor',
  sortOrder: 80
}

/** Emulated systems sort after the stores; their sortOrder is 100 + position in systems.json. */
export const SYSTEM_SORT_BASE = 100

export function platformForSource(source: SourceId): Platform | null {
  if (source === 'manual') return PC_PLATFORM
  if (source === 'rom') return null
  return STORE_PLATFORMS[source]
}
