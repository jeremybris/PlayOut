// The Library's Active Players sort: the players online now of every Steam game in the library, from SteamCharts
// (steamcharts.ts, one chart-data.json read per app id). Live data, not metadata: it is read only while the user has
// that sort chosen (the renderer asks through the refreshActivePlayers IPC call when the sort is shown, then hourly),
// never in the background otherwise. The game page keeps reading Steam's own count (metadata-service refreshLive);
// the newer of the two is what a game shows and sorts by.
import type { Game, GameMetadata } from '../../shared/types'
import type { Logger } from '../logger'
import { steamAppIdOf } from './steam-store'
import { steamChartsPlayers, type ChartPlayers } from './steamcharts'

/** A game whose count is younger than this is not asked about again (SteamCharts records one point an hour). */
export const ACTIVE_PLAYERS_TTL_MS = 6 * 60 * 60 * 1000
/** A game SteamCharts said it does not track (or has no recent count for) is not asked about again for this long. */
export const ACTIVE_PLAYERS_UNTRACKED_TTL_MS = 24 * 60 * 60 * 1000
/**
 * A SteamCharts history whose last point is older than this (a game it stopped polling, a delisted one) has no count
 * now: that point is not written as the players online now, and the game is not asked about again within the day.
 */
export const ACTIVE_PLAYERS_STALE_MS = 48 * 60 * 60 * 1000
/** How often the games written in a run are announced (one `library:changed` for all of them). */
export const ACTIVE_PLAYERS_BATCH_MS = 3_000
/** A run stops after this many unanswered reads in a row (offline, the site down); the next request tries again. */
export const ACTIVE_PLAYERS_MAX_FAILURES = 3

export interface ActivePlayersDeps {
  library: {
    games(): Game[]
    getGame(id: string): Game | undefined
    applyMetadata(
      id: string,
      update: { metadata?: Partial<GameMetadata> },
      options?: { overwrite?: boolean; quiet?: boolean }
    ): unknown
  }
  /** The games written since the last call (written quietly): announced as one `library:changed`. */
  onChanged: (gameIds: string[]) => void
  log: Logger
  /** Tests; defaults to steamcharts.ts's read (one request at a time, a second apart). */
  fetchChart?: (appId: number) => Promise<ChartPlayers | 'untracked' | null>
  now?: () => number
  batchIntervalMs?: number
  maxFailures?: number
}

export interface ActivePlayersService {
  /**
   * Read SteamCharts for every Steam app id of the library whose count is due (none, or older than six hours), skipping
   * the ones SteamCharts said it does not track within the day. One run at a time: a call during a run gets that run.
   */
  refresh(): Promise<void>
  dispose(): void
}

const timeOf = (iso: string | undefined): number => {
  const at = Date.parse(iso ?? '')
  return Number.isNaN(at) ? 0 : at
}

/**
 * Every app id read is remembered in memory for this run of PlayOut: not asked about again for six hours whatever the
 * answer (also when nothing was written, e.g. Steam's own count was newer), and for a day when SteamCharts does not
 * track it or its last point is stale (ACTIVE_PLAYERS_STALE_MS). Untracked games are also remembered on the game as
 * `peakPlayers: { count: 0 }` (the meaning that field already has, which refreshLive writes for a SteamCharts 404 too)
 * when it has no peak recorded, so a restart does not ask about them again within the day; that mark only counts for a
 * game with no players count (a tracked game whose whole history is 0 has one, and keeps its six-hour refresh).
 */
export function createActivePlayers(deps: ActivePlayersDeps): ActivePlayersService {
  const { library, log } = deps
  const fetchChart = deps.fetchChart ?? steamChartsPlayers
  const now = deps.now ?? Date.now
  const batchIntervalMs = deps.batchIntervalMs ?? ACTIVE_PLAYERS_BATCH_MS
  const maxFailures = Math.max(1, deps.maxFailures ?? ACTIVE_PLAYERS_MAX_FAILURES)
  /** App id -> when SteamCharts said it does not track it, or had no recent count for it. */
  const untrackedAt = new Map<number, number>()
  /** App id -> when SteamCharts last answered about it (any answer). */
  const readAt = new Map<number, number>()
  const changed = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let disposed = false

  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!changed.size) return
    const ids = [...changed]
    changed.clear()
    deps.onChanged(ids)
  }

  function noteChanged(id: string): void {
    changed.add(id)
    if (flushTimer || disposed) return
    flushTimer = setTimeout(flush, batchIntervalMs)
    ;(flushTimer as { unref?: () => void }).unref?.()
  }

  /** The library's Steam games by app id, most recently played (then installed) first. */
  function dueApps(): { appId: number; gameIds: string[] }[] {
    const at = now()
    const byApp = new Map<number, Game[]>()
    const ordered = [...library.games()].sort(
      (a, b) =>
        timeOf(b.lastPlayed) - timeOf(a.lastPlayed) || Number(b.installed) - Number(a.installed)
    )
    for (const game of ordered) {
      const appId = steamAppIdOf(game)
      if (!appId) continue
      const list = byApp.get(appId)
      if (list) list.push(game)
      else byApp.set(appId, [game])
    }
    const out: { appId: number; gameIds: string[] }[] = []
    for (const [appId, games] of byApp) {
      const memo = untrackedAt.get(appId)
      if (memo !== undefined && at - memo < ACTIVE_PLAYERS_UNTRACKED_TTL_MS) continue
      const read = readAt.get(appId)
      if (read !== undefined && at - read < ACTIVE_PLAYERS_TTL_MS) continue
      const markedUntracked = games.some(
        (g) =>
          !g.metadata.currentPlayers &&
          g.metadata.peakPlayers?.count === 0 &&
          at - timeOf(g.metadata.peakPlayers.updatedAt) < ACTIVE_PLAYERS_UNTRACKED_TTL_MS
      )
      if (markedUntracked) continue
      const due = games.some((g) => {
        const current = g.metadata.currentPlayers
        return !current || !(at - timeOf(current.updatedAt) < ACTIVE_PLAYERS_TTL_MS)
      })
      if (due) out.push({ appId, gameIds: games.map((g) => g.id) })
    }
    return out
  }

  /** Whether an answer has a count for now: a last point with a time no older than ACTIVE_PLAYERS_STALE_MS. */
  function hasCurrent(answer: ChartPlayers): boolean {
    return (
      answer.current !== null &&
      answer.at !== null &&
      now() - timeOf(answer.at) <= ACTIVE_PLAYERS_STALE_MS
    )
  }

  function write(gameIds: string[], answer: ChartPlayers | 'untracked'): void {
    const nowIso = new Date(now()).toISOString()
    const current = answer !== 'untracked' && hasCurrent(answer)
    for (const id of gameIds) {
      const game = library.getGame(id)
      if (!game) continue
      const metadata: Partial<GameMetadata> = {}
      const stored = game.metadata
      if (answer === 'untracked') {
        if (!stored.peakPlayers?.count) metadata.peakPlayers = { count: 0, updatedAt: nowIso }
      } else {
        // Steam's own count (the game page) may be newer than SteamCharts' last hourly point: kept then.
        // A stale last point (hasCurrent) is not a count for now: only the peak is kept.
        if (
          current &&
          answer.current !== null &&
          answer.at !== null &&
          (!stored.currentPlayers || timeOf(answer.at) > timeOf(stored.currentPlayers.updatedAt))
        )
          metadata.currentPlayers = { count: answer.current, updatedAt: answer.at }
        metadata.peakPlayers = {
          count: Math.max(stored.peakPlayers?.count ?? 0, answer.peak),
          updatedAt: nowIso
        }
      }
      if (!Object.keys(metadata).length) continue
      library.applyMetadata(id, { metadata }, { overwrite: true, quiet: true })
      noteChanged(id)
    }
  }

  async function run(): Promise<void> {
    const apps = dueApps()
    if (!apps.length) return
    log.info(`active players: reading SteamCharts for ${apps.length} Steam game(s)`)
    let failures = 0
    let read = 0
    for (const { appId, gameIds } of apps) {
      if (disposed) return
      const answer = await fetchChart(appId)
      if (disposed) return
      if (answer === null) {
        failures++
        if (failures >= maxFailures) {
          log.warn(
            `active players: SteamCharts did not answer ${failures} times in a row; stopped after ${read} of ${apps.length} game(s)`
          )
          return
        }
        continue
      }
      failures = 0
      read++
      readAt.set(appId, now())
      if (answer === 'untracked' || !hasCurrent(answer)) untrackedAt.set(appId, now())
      write(gameIds, answer)
    }
    log.info(`active players: read ${read} of ${apps.length} Steam game(s)`)
  }

  return {
    refresh() {
      if (disposed) return Promise.resolve()
      running ??= run()
        .catch((err) => log.error('active players refresh failed', err))
        .finally(() => {
          running = null
          flush()
        })
      return running
    },
    dispose() {
      disposed = true
      flush()
    }
  }
}
