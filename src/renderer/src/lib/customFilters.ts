import type { CustomFilter } from '@shared/types'

/**
 * The user's own filters (settings.library.customFilters; shared/custom-filters.ts): pure helpers for Filters > Custom
 * and the game options menu (state/customFilters.ts changes them).
 */

/**
 * The game ids of the filters picked (a card any copy of which is among them shows), or null when none of `picked` is
 * one of `filters` (nothing picked, or only ids this PC has no filter for: a deleted one, another PC's tab): no
 * narrowing then.
 */
export function customGameIds(
  filters: readonly CustomFilter[],
  picked: readonly string[]
): Set<string> | null {
  if (picked.length === 0) return null
  const known = filters.filter((f) => picked.includes(f.id))
  if (known.length === 0) return null
  const ids = new Set<string>()
  for (const filter of known) for (const id of filter.gameIds) ids.add(id)
  return ids
}

/** Whether a game (any of its copies' ids) is in a filter. */
export function filterHasGame(filter: CustomFilter, copyIds: readonly string[]): boolean {
  return copyIds.some((id) => filter.gameIds.includes(id))
}

/** A filter's name by id (tab names, Filters > Custom's value text); undefined for an id with no filter here. */
export function customFilterNames(
  filters: readonly CustomFilter[]
): (id: string) => string | undefined {
  const names = new Map(filters.map((f) => [f.id, f.name]))
  return (id) => names.get(id)
}

/** The ids of `picked` that are filters here, in `picked`'s order. */
export function knownCustomIds(
  filters: readonly CustomFilter[],
  picked: readonly string[]
): string[] {
  return picked.filter((id) => filters.some((f) => f.id === id))
}
