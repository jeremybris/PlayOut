import type { GameMetadata } from '@shared/types'

/**
 * What the Players stat shows for a Steam game: the number online now (Steam's Web API) and the all-time peak
 * (SteamCharts; 0 when SteamCharts does not track the game). null when neither is known.
 */
export function playersOf(
  meta: Pick<GameMetadata, 'currentPlayers' | 'peakPlayers'>
): { current: number | null; peak: number | null } | null {
  const current = meta.currentPlayers ? Math.max(0, meta.currentPlayers.count) : null
  const peak = meta.peakPlayers && meta.peakPlayers.count > 0 ? meta.peakPlayers.count : null
  if (current === null && peak === null) return null
  // The peak SteamCharts recorded can trail a new record set since it was read: never below the number online now.
  return { current, peak: peak !== null && current !== null ? Math.max(peak, current) : peak }
}

/** The orange bar's share of the green one (0-100): the number online now against the all-time peak. */
export function currentShare(current: number | null, peak: number | null): number {
  if (current === null || current <= 0) return 0
  if (peak === null || peak <= 0) return 100
  // A game with players always shows a sliver, however far below its peak.
  return Math.max(4, Math.min(100, (current / peak) * 100))
}
