/**
 * `metadata.sources` key PlayOut sets to STEAM_ACHIEVEMENTS_NONE when Steam itself answered that the game's app has no
 * achievements (main achievements/steam.ts steamAchievementCount: its achievement list is empty). Signed out, a
 * refused key or a failed request never set it: those are not Steam's answer about the game.
 */
export const STEAM_ACHIEVEMENTS_SOURCE = 'steam-achievements'
export const STEAM_ACHIEVEMENTS_NONE = 'none'

/**
 * A game Steam says has no achievements, so its page leaves the Achievements stat out. Counts on the card (a later
 * answer, or another provider's) always win.
 */
export function knownWithoutSteamAchievements(game: {
  metadata: { achievements?: unknown; sources?: Record<string, unknown> }
}): boolean {
  if (game.metadata.achievements) return false
  return game.metadata.sources?.[STEAM_ACHIEVEMENTS_SOURCE] === STEAM_ACHIEVEMENTS_NONE
}
