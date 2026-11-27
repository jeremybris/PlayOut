import { knownWithoutRetroAchievements } from '@shared/ra-consoles'
import { RECOMP_ACHIEVEMENTS_SOURCE, recompAchievementsFor } from '@shared/recomp-play'
import type { Game } from '@shared/types'

/**
 * The game page's ACHIEVEMENTS stat: whether it shows, and whether it is RetroAchievements' (a ROM's) or the game's own
 * ('achievements': a store game's, or the recompilation's Play starts when PlayOut reads its achievements). A paired
 * host's game shows it when the host's offer carries counts. A ROM (a recompilation's game too) known to have no
 * RetroAchievements leaves it out, unless its recompilation has achievements.
 */
export function achievementsStat(game: Game): { show: boolean; label: 'retro' | 'achievements' } {
  const remote = !!game.remote
  const recomp = !remote && recompAchievementsFor(game) !== null
  const isRom = game.source === 'rom'
  const show =
    recomp ||
    game.metadata.achievements !== undefined ||
    (!remote && (game.source === 'steam' || (isRom && !knownWithoutRetroAchievements(game))))
  // A paired host's counts that came from its recompilation are the game's own too. On this PC only the recompilation
  // Play starts counts: counts left from one no longer installed are cleared by main (achievements-service.ts).
  const own = recomp || (remote && !!game.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE])
  return { show, label: isRom && !own ? 'retro' : 'achievements' }
}
