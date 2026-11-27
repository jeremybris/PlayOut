import { useEffect } from 'react'
import { api } from '../api/client'
import { createLog } from '../lib/log'

const log = createLog('active-players')

/** How often the counts are asked for again while the Active Players sort stays shown. */
export const ACTIVE_PLAYERS_REFRESH_MS = 60 * 60 * 1000

/**
 * While `shown` (the Library shows the Active Players sort, on any tab), ask main to read SteamCharts' latest player
 * counts (main scrapers/active-players.ts): when it becomes shown (the sort picked, or the Library opened with it,
 * right after start-up too) and every hour after. Main skips counts younger than six hours and runs one read at a
 * time, so asking again is cheap; the games arrive as 'library:changed' batches and the grid re-sorts by itself.
 */
export function useActivePlayersRefresh(shown: boolean): void {
  useEffect(() => {
    if (!shown) return undefined
    const refresh = (): void => {
      api.refreshActivePlayers().catch((err) => log.warn('refreshActivePlayers failed', err))
    }
    refresh()
    const timer = setInterval(refresh, ACTIVE_PLAYERS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [shown])
}
