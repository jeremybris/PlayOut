import type { GameMetadata } from '@shared/types'

/**
 * Most players the game page's controller badge shows. LaunchBox's MaxPlayers counts online players too (16, 32,
 * 64 and more for online games); up to eight it is almost always people on one couch, so larger counts show nothing.
 */
export const MAX_LOCAL_PLAYERS = 8

/** How many local players the game page shows for a game; undefined when there is no count to show. */
export function localPlayersShown(
  metadata: Pick<GameMetadata, 'localPlayers'>
): number | undefined {
  const max = metadata.localPlayers?.max
  return typeof max === 'number' && max >= 1 && max <= MAX_LOCAL_PLAYERS ? max : undefined
}
