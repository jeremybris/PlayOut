/**
 * Achievements of GOG and Epic Games games, read with the store's account signed in to PlayOut (main
 * achievements/gog.ts, achievements/epic.ts). The game's `metadata.sources[<store>_ACHIEVEMENTS_SOURCE]` is the store's
 * id of the game (GOG's product id, Epic's sandbox id) once the store gave its counts, or STORE_ACHIEVEMENTS_NONE once
 * the store answered that the game has none: for GOG its achievement list was empty and its public product page lists
 * no achievements either; for Epic the game's public achievement definitions state none. Signed out or a failed
 * request never set the mark.
 */
export const GOG_ACHIEVEMENTS_SOURCE = 'gog-achievements'
export const EPIC_ACHIEVEMENTS_SOURCE = 'epic-achievements'
export const STORE_ACHIEVEMENTS_NONE = 'none'

export type StoreAchievementsSource =
  typeof GOG_ACHIEVEMENTS_SOURCE | typeof EPIC_ACHIEVEMENTS_SOURCE

/** The Epic sandbox id (namespace) of an Epic game, which its achievements are read by; null without one. */
export function epicSandboxOf(game: {
  source: string
  extra?: Record<string, unknown>
}): string | null {
  if (game.source !== 'epic') return null
  const id = game.extra?.epicNamespace
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id.trim()) ? id.trim() : null
}

/**
 * The store whose own achievements a game shows; null: none of these.
 * - A GOG game without a Steam app id: GOG's. A GOG game PlayOut knows the Steam app id of keeps Steam's.
 * - An Epic game with its sandbox id: Epic's, also when PlayOut knows a Steam app id for it. Play starts the Epic copy,
 *   so Epic's achievements are the ones the play earns (Steam's would be another copy's).
 */
export function storeAchievementsSource(game: {
  source: string
  extra?: Record<string, unknown>
}): StoreAchievementsSource | null {
  if (game.source === 'epic') return epicSandboxOf(game) ? EPIC_ACHIEVEMENTS_SOURCE : null
  if (game.source !== 'gog') return null
  // A GOG game PlayOut knows the Steam app id of keeps Steam's achievements (the Steam scan reads it).
  return game.extra?.steamAppId === undefined ? GOG_ACHIEVEMENTS_SOURCE : null
}

/**
 * A GOG or Epic game its store says has no achievements, so its page leaves the Achievements stat out. Counts on the
 * card always win.
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
