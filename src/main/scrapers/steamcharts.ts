// A Steam game's players on SteamCharts (steamcharts.com). Steam's own Web API only gives the number online now
// (ISteamUserStats/GetNumberOfCurrentPlayers, steam-store.ts); SteamCharts has recorded that number for every game it
// tracks since 2012 and publishes the history per game as JSON: [time ms, players] pairs, one per month at first, then
// per day and per hour. The highest value is the all-time peak; the last point (an hour or two old) is the number
// online lately, which the Active Players sort reads for the whole library (active-players.ts).
import { createLogger } from '../logger'
import { httpJson, HttpError, RateLimiter } from './http'

const log = createLogger('scrapers:steamcharts')

export const STEAMCHARTS_CHART_URL = 'https://steamcharts.com/app'

// A free community site: one request at a time, well apart.
const limiter = new RateLimiter(1, 1)
/** The request in flight (the next one waits for it): never two at once, whoever asks. */
let inFlight: Promise<unknown> = Promise.resolve()

/** The highest player count of a SteamCharts history; null when there is no usable point. */
export function peakOfChart(data: unknown): number | null {
  if (!Array.isArray(data)) return null
  let peak: number | null = null
  for (const point of data) {
    if (!Array.isArray(point) || point.length < 2) continue
    const players = point[1]
    if (typeof players !== 'number' || !Number.isFinite(players) || players < 0) continue
    const count = Math.round(players)
    if (peak === null || count > peak) peak = count
  }
  return peak
}

/** What one read of a game's SteamCharts history says. */
export interface ChartPlayers {
  /** The players of the history's last usable point (the latest hour); null when no point has a usable time. */
  current: number | null
  /** That point's time (ISO); null with `current`. */
  at: string | null
  /** The all-time peak (peakOfChart). */
  peak: number
}

/** The latest count (the last point with a usable time and count) and the peak of a history; null without points. */
export function playersOfChart(data: unknown): ChartPlayers | null {
  const peak = peakOfChart(data)
  if (peak === null || !Array.isArray(data)) return null
  for (let i = data.length - 1; i >= 0; i--) {
    const point: unknown = data[i]
    if (!Array.isArray(point) || point.length < 2) continue
    const [time, players] = point as unknown[]
    if (typeof players !== 'number' || !Number.isFinite(players) || players < 0) continue
    if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) continue
    const at = new Date(time)
    if (Number.isNaN(at.getTime())) continue
    return { current: Math.round(players), at: at.toISOString(), peak }
  }
  return { current: null, at: null, peak }
}

/**
 * One read of `appId`'s SteamCharts history (chart-data.json): its latest count and peak, 'untracked' when SteamCharts
 * does not track the game (it answers 404 for those, or a history without points; nothing to ask again soon), or null
 * when it could not be read (offline, the site down, a bad app id).
 */
export async function steamChartsPlayers(
  appId: number
): Promise<ChartPlayers | 'untracked' | null> {
  if (!Number.isInteger(appId) || appId <= 0) return null
  const run = inFlight.then(async () => {
    try {
      await limiter.take()
      const data = await httpJson<unknown>(
        `${STEAMCHARTS_CHART_URL}/${appId}/chart-data.json`,
        { headers: { Accept: 'application/json' } },
        { timeoutMs: 15_000, retries: 1 }
      )
      return playersOfChart(data) ?? 'untracked'
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return 'untracked' as const
      log.debug(
        `players unavailable for ${appId}: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  })
  inFlight = run
  return run
}

/**
 * The all-time peak of `appId` on SteamCharts: a number, `0` when SteamCharts does not track the game (it answers
 * 404 for those; nothing to ask again soon), or null when it could not be read (offline, the site down).
 */
export async function steamChartsPeak(appId: number): Promise<number | null> {
  const players = await steamChartsPlayers(appId)
  if (players === null) return null
  return players === 'untracked' ? 0 : players.peak
}
