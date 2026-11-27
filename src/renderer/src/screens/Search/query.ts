import { gameGenres } from '@shared/genres'
import type { Game, Platform } from '@shared/types'
import { compareByTitle, searchGames } from '../../lib/library'

/**
 * Search selector for the overlay: title matches first (the foundation's ranked searchGames), then games
 * whose platform name, genre, Steam tag, developer or publisher matches every word of the query, alphabetical.
 */

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function fieldHaystacks(game: Game, platformsById: ReadonlyMap<string, Platform>): string[] {
  const platform = platformsById.get(game.platformId)
  const values: (string | undefined)[] = [
    platform?.name,
    platform?.shortName,
    platform?.manufacturer,
    game.platformId,
    ...gameGenres(game),
    ...(game.metadata.steamTags?.tags ?? []),
    ...(game.metadata.developers ?? []),
    ...(game.metadata.publishers ?? [])
  ]
  return values.filter((v): v is string => !!v).map(normalize)
}

export function searchLibrary(games: Game[], platforms: Platform[], query: string): Game[] {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const byTitle = searchGames(games, query)
  const seen = new Set(byTitle.map((g) => g.id))
  const platformsById = new Map(platforms.map((p) => [p.id, p]))
  const byField = games
    .filter((game) => {
      if (seen.has(game.id)) return false
      const haystacks = fieldHaystacks(game, platformsById)
      return words.every((w) => haystacks.some((h) => h.includes(w)))
    })
    .sort(compareByTitle)
  return [...byTitle, ...byField]
}
