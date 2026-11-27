import type { Game } from './types'

/**
 * The genres PlayOut shows and filters a game by. A ROM game: its LaunchBox Games Database genres
 * (metadata.launchboxGenres), else, when LaunchBox has none for it or could not be reached yet, its scraped genres
 * (metadata.genres) as before. Any other game (Steam, GOG, Epic, ...): its scraped genres.
 */
export function gameGenres(game: Pick<Game, 'source' | 'metadata'>): string[] {
  const meta = game.metadata
  if (game.source === 'rom') {
    const fromLaunchBox = meta?.launchboxGenres?.genres?.filter((g) => g.trim().length > 0)
    if (fromLaunchBox?.length) return fromLaunchBox
  }
  return meta?.genres ?? []
}
