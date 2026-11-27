import type { Game } from '../../shared/types'

/** The user-facing title: the user's override when set, else the scanned/scraped title (as the renderer shows it). */
export function displayTitle(game: Pick<Game, 'title' | 'user'>): string {
  return game.user?.titleOverride?.trim() || game.title
}
