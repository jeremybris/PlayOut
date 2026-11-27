import { useEffect } from 'react'
import { api } from '../api/client'
import { createLog } from '../lib/log'

const log = createLog('hltb-times')

/** How often the missing times are asked for again while the H.L.T.B. sort stays shown. */
export const HLTB_TIMES_REFRESH_MS = 30 * 60 * 1000

/**
 * While `shown` (the Library shows the H.L.T.B. sort, on any tab), ask main to look up the HowLongToBeat times of the
 * games that have none yet (main scrapers/metadata-service.ts refreshHltbTimes): when it becomes shown (the sort
 * picked, or the Library opened with it) and every 30 minutes after. Main skips games with times and games HLTB had no
 * match for within the month, runs one pass at a time and stops while HLTB is paused, so asking again is cheap; the
 * games arrive as 'library:changed' batches and the grid re-sorts by itself, and 'hltb:progress' drives the header's
 * "Looking up H.L.T.B. times" line. When it stops being shown, main is told to stop (stopHltbTimes): lookups run only
 * while the sort is shown.
 */
export function useHltbTimesRefresh(shown: boolean): void {
  useEffect(() => {
    if (!shown) return undefined
    const refresh = (): void => {
      api.refreshHltbTimes().catch((err) => log.warn('refreshHltbTimes failed', err))
    }
    refresh()
    const timer = setInterval(refresh, HLTB_TIMES_REFRESH_MS)
    return () => {
      clearInterval(timer)
      // No longer shown (another sort, a tab's settings, another screen): main stops after the lookup in progress.
      api.stopHltbTimes().catch((err) => log.warn('stopHltbTimes failed', err))
    }
  }, [shown])
}
