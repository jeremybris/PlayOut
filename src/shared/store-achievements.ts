/**
 * Achievements of GOG games, read with the GOG account signed in to PlayOut (main achievements/gog.ts). The game's
 * `metadata.sources[GOG_ACHIEVEMENTS_SOURCE]` is its GOG product id once GOG gave its counts, or
 * STORE_ACHIEVEMENTS_NONE once GOG answered that the game has none: its achievement list was empty and its public
 * product page lists no achievements either. Signed out or a failed request never set the mark.
 */
export const GOG_ACHIEVEMENTS_SOURCE = 'gog-achievements'
export const STORE_ACHIEVEMENTS_NONE = 'none'

/** The store whose own achievements a game shows (a GOG game without a Steam app id); null: none of these. */
export function storeAchievementsSource(game: {
  source: string
  extra?: Record<string, unknown>
}): typeof GOG_ACHIEVEMENTS_SOURCE | null {
  if (game.source !== 'gog') return null
  // A GOG game PlayOut knows the Steam app id of keeps Steam's achievements (the Steam scan reads it).
  return game.extra?.steamAppId === undefined ? GOG_ACHIEVEMENTS_SOURCE : null
}

/**
 * A GOG game GOG says has no achievements, so its page leaves the Achievements stat out. Counts on the card always
 * win.
 */
export function knownWithoutStoreAchievements(game: {
  source: string
  extra?: Record<string, unknown>
  metadata: { achievements?: unknown; sources?: Record<string, unknown> }
}): boolean {
  if (game.metadata.achievements) return false
  const source = storeAchievementsSource(game)
  return !!source && game.metadata.sources?.[source] === STORE_ACHIEVEMENTS_NONE
}
