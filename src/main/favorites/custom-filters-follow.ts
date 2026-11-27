import type { CustomFilter, Game } from '../../shared/types'
import { fallbackKey } from './favorites-file'

/**
 * The user's own filters (settings.library.customFilters) keep the ids of their games (Game.id, as Favorites do). A
 * game's id can change while it stays the same game, and its filters follow it here, as its favourite does:
 *
 * - a card moved to another id (`movedTo` of a library change: a recompilation's own card absorbed into the original
 *   game's, a ROM converted to another file): the new id takes the old one's place;
 * - a manual game whose exe moved, or a ROM moved to another folder (a new card, the old one gone): matched by the
 *   key Favorites fall back to (favorites-file.ts fallbackKey: source, platform and title, or a ROM's file name). That
 *   key is kept with the id (CustomFilter.gameKeys) while the game is in the library, so it is known after the old
 *   card is gone; the one game with that key takes the id's place (several such games: none, as Favorites do).
 *
 * Store games (Steam, Epic, GOG…) are matched by id alone. An id whose game is not in the library (and has no key
 * match) stays as it is: the game may come back.
 */

/** Follow a chain of moves (a → b → c) to its end; at most 10 steps. */
function finalId(id: string, movedTo: Readonly<Record<string, string>>): string {
  let current = id
  for (let i = 0; i < 10 && movedTo[current]; i++) current = movedTo[current]!
  return current
}

/**
 * The filters with their games' ids brought up to date (moves, re-found manual games and ROMs) and each key kept for
 * the ids that have one; null when nothing changed. `games`: the library now.
 */
export function followCustomFilters(
  filters: readonly CustomFilter[],
  games: readonly Game[],
  movedTo: Readonly<Record<string, string>> = {}
): CustomFilter[] | null {
  if (filters.length === 0) return null
  const byId = new Map(games.map((g) => [g.id, g]))
  let byKey: Map<string, Game[]> | null = null
  const gamesWithKey = (key: string): Game[] => {
    if (!byKey) {
      byKey = new Map()
      for (const g of games) {
        const k = fallbackKey(g)
        if (!k) continue
        const list = byKey.get(k)
        if (list) list.push(g)
        else byKey.set(k, [g])
      }
    }
    return byKey.get(key) ?? []
  }
  let changed = false
  const out = filters.map((filter) => {
    const keys = filter.gameKeys ?? {}
    const ids: string[] = []
    const nextKeys: Record<string, string> = {}
    const seen = new Set<string>()
    const add = (id: string, key: string | undefined): void => {
      if (seen.has(id)) return
      seen.add(id)
      ids.push(id)
      if (key) nextKeys[id] = key
    }
    for (const old of filter.gameIds) {
      const id = finalId(old, movedTo)
      const game = byId.get(id)
      if (game) {
        add(id, fallbackKey(game) ?? undefined)
        continue
      }
      // Gone from the library: the one game now matching its key (not in this filter already) takes its place.
      const key = keys[old] ?? keys[id]
      const candidates = key ? gamesWithKey(key) : []
      const match = candidates.length === 1 ? candidates[0]! : undefined
      if (match && !filter.gameIds.includes(match.id)) add(match.id, key)
      else add(id, key)
    }
    const same =
      ids.length === filter.gameIds.length &&
      ids.every((id, i) => id === filter.gameIds[i]) &&
      sameKeys(keys, nextKeys)
    if (same) return filter
    changed = true
    const next: CustomFilter = { ...filter, gameIds: ids }
    if (Object.keys(nextKeys).length) next.gameKeys = nextKeys
    else delete next.gameKeys
    return next
  })
  return changed ? out : null
}

function sameKeys(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => a[k] === b[k])
}
