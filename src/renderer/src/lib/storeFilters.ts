import type { Game, Platform, SourceId, StoreSourceId } from '@shared/types'
import { t, useLanguageStore } from '../i18n'

/**
 * "Other" below Filters > Platform's line: PC games that are not from one of the stores, such as a game added by its .exe. Kept in the
 * tab's `stores` like a store id; the "*" keeps it apart from every real source id.
 */
export const OTHER_PC = '*other'

/**
 * "All Stores" below Filters > Platform's line: every PC game, that is every store's game and every Other one (a game added by its
 * .exe), and no emulation game. Kept in the tab's `stores` like a store id; the "*" keeps it apart from every real
 * source id.
 */
export const ALL_STORES = '*stores'

/**
 * The label of the ALL_STORES choice below Filters > Platform's line. In the language shown: reassigned when it changes, and an ES module's
 * importers read the new value.
 */
export let ALL_STORES_LABEL = t('lib.stores.all')
useLanguageStore.subscribe(() => {
  ALL_STORES_LABEL = t('lib.stores.all')
})

/** One choice of Filters > Platform (below the line): a store, or Other, and the name the menu gives it. */
export interface StoreFilter {
  id: StoreSourceId | typeof OTHER_PC
  label: string
}

/** The stores Filters > Platform (below the line) offers, in the menu's order (the user's names, not the stores' own). */
export const STORE_FILTERS: readonly StoreFilter[] = [
  { id: 'steam', label: 'Steam' },
  { id: 'epic', label: 'Epic' },
  { id: 'gog', label: 'G.O.G' },
  { id: 'xbox', label: 'Xbox' },
  { id: 'ubisoft', label: 'Ubisoft Connect' },
  { id: 'ea', label: 'EA App' },
  { id: 'battlenet', label: 'Battle.Net' }
]

/** The last choice of Filters > Platform, after the stores (its label read in the language shown). */
export const OTHER_PC_FILTER: StoreFilter = {
  id: OTHER_PC,
  get label() {
    return t('lib.stores.other')
  }
}

/** The label of a Filters > Platform (below the line) choice. */
export function storeFilterLabel(id: string): string {
  if (id === OTHER_PC) return OTHER_PC_FILTER.label
  if (id === ALL_STORES) return ALL_STORES_LABEL
  return STORE_FILTERS.find((f) => f.id === id)?.label ?? id
}

/** Whether a source is one of the stores below Filters > Platform's line (ROMs and games added by hand are not). */
export function isStoreFilter(source: SourceId): source is StoreSourceId {
  return STORE_FILTERS.some((f) => f.id === source)
}

/** The kind of a platform id (store, pc or system); undefined for one the library does not know. */
export type PlatformKindOf = (platformId: string) => Platform['kind'] | undefined

/** A kind lookup over the library's platforms. */
export function platformKindOf(platformsById: ReadonlyMap<string, Platform>): PlatformKindOf {
  return (id) => platformsById.get(id)?.kind
}

/**
 * The three families the Library's Platform filter splits games into: a store's game (below the line > a store),
 * an emulated system's game (above the line), and any other PC game, such as one added by its .exe
 * (below the line > Other).
 */
export type GameFamily = 'store' | 'emulation' | 'other-pc'

export function gameFamily(
  game: Pick<Game, 'source' | 'platformId'>,
  kindOf: PlatformKindOf
): GameFamily {
  if (isStoreFilter(game.source)) return 'store'
  if (game.source === 'rom' || kindOf(game.platformId) === 'system') return 'emulation'
  return 'other-pc'
}

/**
 * The Filters > Platform (below the line) choices that have games in `games` (every copy counts, so a GOG copy shown under its Steam card
 * still offers G.O.G); a store with none (not connected, nothing imported) is not offered, nor Other without a PC
 * game from outside the stores.
 */
export function libraryStoreFilters(
  games: readonly Pick<Game, 'source' | 'platformId'>[],
  kindOf: PlatformKindOf
): StoreFilter[] {
  const present = new Set(games.map((g) => g.source))
  const out = STORE_FILTERS.filter((f) => present.has(f.id as SourceId))
  if (games.some((g) => gameFamily(g, kindOf) === 'other-pc')) out.push(OTHER_PC_FILTER)
  return out
}

/**
 * Whether a game passes Filters > Platform (below the line): any game when nothing is picked, any PC game (a store's or Other) for All
 * Stores, a picked store's game, or for Other a PC game from outside the stores.
 */
export function matchesStoreFilter(
  game: Pick<Game, 'source' | 'platformId'>,
  picked: ReadonlySet<string>,
  kindOf: PlatformKindOf
): boolean {
  if (picked.size === 0) return true
  if (picked.has(game.source)) return true
  const family = gameFamily(game, kindOf)
  if (picked.has(ALL_STORES) && family !== 'emulation') return true
  return picked.has(OTHER_PC) && family === 'other-pc'
}

/**
 * Filters > Platform (below the line) after pressing `value`: "All Stores" is on alone (pressed again: off), and a store or Other pressed
 * while it is on replaces it; otherwise a choice toggles as every choice does.
 */
export function pickStore(picked: readonly string[], value: string): string[] {
  if (value === ALL_STORES) return picked.includes(value) ? [] : [value]
  const stores = picked.filter((id) => id !== ALL_STORES)
  return stores.includes(value) ? stores.filter((id) => id !== value) : [...stores, value]
}
