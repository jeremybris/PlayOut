// Metadata service (docs/ARCHITECTURE.md §4.6): two lanes over one `enqueue`. The cover lane lands one cover per
// game from seeds, the local caches, direct URLs and SteamGridDB with no text work in front of it; the full lane
// (text chain -> remaining art -> HLTB) runs only while the cover lane is empty, so a 3,000-game import shows its
// covers in seconds and its descriptions over the following hour instead of the other way round.
import type {
  ArtKind,
  Game,
  GameMetadata,
  MetadataCandidate,
  MetadataLane,
  MetadataProgress,
  ScraperId,
  Settings
} from '../../shared/types'
import { missingArtKinds } from '../../shared/art-sources'
import { gameDbMetadataOf, type GameDbRow } from '../../shared/game-database'
import type { GameDatabaseLookup } from '../game-database/service'
import { createActivePlayers } from './active-players'
import { createHltbTimes } from './hltb-times'
import { steamChartsPeak, type ChartPlayers } from './steamcharts'
import { missingArtUrls } from '../services/library-service'
import { artIdsOf } from './art-ids'
import {
  candidateYear,
  pickCandidate,
  sameTitleKey,
  searchVariantsFor,
  titleMatch,
  withinYear,
  YEAR_MATCH_WINDOW,
  type ConsoleHint
} from './candidate-match'
import { createArtProgress } from './art-progress'
import {
  createCoverLane,
  type CoverLane,
  type CoverLaneStage,
  type LocalArtLookup,
  type Lookahead
} from './cover-lane'
import { createDirectArtSources } from './direct-art'
import { gogProductIdOf, gogScraper } from './gog-api'
import {
  bundleBase,
  hltbConsolesFor,
  hltbLookup,
  hltbLookupOutcome,
  hltbPaused,
  yearTagHidden,
  type HltbTimes
} from './hltb'
import { igdbScraper } from './igdb'
import { createLocalArtRegistry } from './local-art'
import { createMediaBatcher, type MediaBatcher } from './media-batch'
import {
  configurePlatformIds,
  platformIdFor,
  platformKeyForGame,
  platformNameFor,
  platformYearsFor,
  searchNameFor
} from './platform-ids'
import { screenScraperScraper } from './screenscraper'
import {
  describeError,
  redactSecrets,
  steamAppIdOf,
  steamCurrentPlayers,
  steamStoreScraper
} from './steam-store'
import { steamGridDbScraper } from './steamgriddb'
import { theGamesDbScraper } from './thegamesdb'
import type {
  ArtIds,
  ArtSeed,
  DirectArtSource,
  EnqueueOptions,
  MetadataDeps,
  MetadataService,
  ScrapedResult,
  Scraper
} from './types'

/** Full-lane games in flight (text chain, remaining art, HLTB). */
export const FULL_CONCURRENCY = 3
/** Cover-lane games in flight; downloads are gated to `COVER_DOWNLOADS` inside the lane. */
export const COVER_CONCURRENCY = 16
/**
 * The full lane waits for the cover lane, but not forever: once the network stage has run this long (the
 * acceptance bound for every cover of a 3,000-game import) the full lane starts beside it, so a slow or dead
 * connection cannot keep descriptions and HLTB from arriving.
 */
export const FULL_LANE_WAIT_MAX_MS = 10 * 60_000
const LIVE_TTL_MS = 10 * 60 * 1000
/**
 * A game the scrapers found nothing for ('failed') is not run again by an automatic enqueue (a scan, an account
 * import: every launch re-imports the owned list) until this long after the miss, doubled per consecutive miss up
 * to `FAILED_RETRY_MAX_MS`. A forced refresh and `retryFailed` (the user's "refresh missing") run it at once.
 */
export const FAILED_RETRY_BASE_MS = 60 * 60 * 1000
export const FAILED_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000
/**
 * The delay after a run in which a scraper did not answer (PC offline, an outage, a rate limit, refused
 * credentials): that says nothing about the game, so it starts short and, doubled per such run in a row, never
 * passes `FAILED_RETRY_ERROR_MAX_MS`. A PC that was offline for a scan retries minutes later; a source that keeps
 * failing (a used-up monthly allowance) still cannot send every unmatched game through the chain on each scan.
 */
export const FAILED_RETRY_ERROR_MS = 5 * 60 * 1000
export const FAILED_RETRY_ERROR_MAX_MS = FAILED_RETRY_BASE_MS

/** How long after its `errors`-th run in a row with a scraper that did not answer a failed game is left alone. */
export function erroredRetryDelayMs(errors: number): number {
  const doublings = Math.min(Math.max(Math.floor(errors) - 1, 0), 30)
  return Math.min(FAILED_RETRY_ERROR_MS * 2 ** doublings, FAILED_RETRY_ERROR_MAX_MS)
}

/** How long after its `misses`-th consecutive miss an automatic enqueue leaves a failed game alone. */
export function failedRetryDelayMs(misses: number): number {
  const doublings = Math.min(Math.max(Math.floor(misses) - 1, 0), 30)
  return Math.min(FAILED_RETRY_BASE_MS * 2 ** doublings, FAILED_RETRY_MAX_MS)
}

/** Whether a 'failed' game missed recently enough that an automatic enqueue should not run the scrapers again. */
export function failedRecently(
  game: Pick<Game, 'metadataStatus' | 'metadata'>,
  now = Date.now()
): boolean {
  if (game.metadataStatus !== 'failed') return false
  const missed = game.metadata.scrapeMissed
  if (!missed) return false
  // A timestamp that does not parse, or one from the future (the clock was set back), holds nothing back.
  const age = now - Date.parse(missed.at)
  // The last run's own kind decides: a scraper that did not answer (`errors`), or a real miss (`count`).
  const delay = missed.errors
    ? erroredRetryDelayMs(missed.errors)
    : failedRetryDelayMs(missed.count)
  return age >= 0 && age < delay
}

/**
 * Whether a game whose last run ended without a cover (`metadata.coverMissing`) did so recently enough that an
 * automatic enqueue should not look for its art again yet (`failedRetryDelayMs`: 1 h, doubling to 7 days).
 */
export function coverMissingRecently(game: Pick<Game, 'metadata'>, now = Date.now()): boolean {
  const missed = game.metadata.coverMissing
  if (!missed) return false
  const age = now - Date.parse(missed.at)
  return age >= 0 && age < failedRetryDelayMs(missed.count)
}
/** The all-time peak of players (SteamCharts) is read again after this long. */
const PEAK_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_SCREENSHOTS = 4
const MAX_CANDIDATES_PER_SCRAPER = 8
const RESUME_DELAY_MS = 10_000
/** Progress events of the cover lane are coalesced to one per interval (the media batcher's flush). */
const PROGRESS_INTERVAL_MS = 250
/** The full lane's per-game writes are announced to the renderer in one `library:changed` per window. */
const CHANGED_INTERVAL_MS = 250
/** The four kinds an art-only scraper (SteamGridDB) can be asked for; `kinds` undefined means all of them. */
const SCRAPER_ART_KINDS: ArtKind[] = ['cover', 'hero', 'logo', 'icon']

const ART_KINDS: ArtKind[] = ['cover', 'hero', 'logo', 'icon', 'screenshot']
const TEXT_FIELDS: (keyof GameMetadata)[] = [
  'description',
  'shortDescription',
  'releaseDate',
  'developers',
  'publishers',
  'genres',
  'tags',
  'rating',
  'players'
]
/** Order of candidate lists in the search UI: the game's own store first, then the general databases, then art. */
const SEARCH_ORDER: ScraperId[] = [
  'steam',
  'gog',
  'igdb',
  'screenscraper',
  'thegamesdb',
  'steamgriddb'
]

export interface MetadataServiceOptions {
  /** Scrapers to use instead of the built-in set (tests). */
  scrapers?: Scraper[]
  hltbLookup?: (title: string, year?: number, consoles?: string[]) => Promise<HltbTimes | null>
  /** hltbLookup that tells a failure apart from a "no match" answer (tests; defaults to hltb.ts's). */
  hltbLookupOutcome?: (
    title: string,
    year?: number,
    consoles?: string[]
  ) => Promise<{ times: HltbTimes | null; failed: boolean }>
  steamCurrentPlayers?: (appId: number) => Promise<number | null>
  /** The all-time peak of players (tests; defaults to steamcharts.ts's SteamCharts read). */
  steamPeakPlayers?: (appId: number) => Promise<number | null>
  /** One SteamCharts read for the Active Players sort (tests; defaults to steamcharts.ts steamChartsPlayers). */
  steamChartsPlayers?: (appId: number) => Promise<ChartPlayers | 'untracked' | null>
  /** How often the Active Players refresh announces the games it wrote (default 3 s; tests shorten). */
  activePlayersBatchMs?: number
  /** Whether HLTB lookups are paused after failures (tests; defaults to hltb.ts hltbPaused). */
  hltbPaused?: () => boolean
  /** How often the H.L.T.B. sort's lookups announce the games given times (default 3 s; tests shorten). */
  hltbTimesBatchMs?: number
  /** Screenshots downloaded per game (default 4). */
  maxScreenshots?: number
  /** Re-queue games a previous run left 'pending' (default true; tests turn it off). */
  resumePending?: boolean
  /** Delay before that resume pass (default 10 s; tests shorten it). */
  resumeDelayMs?: number
  /** The local art registry (default: every source of `local-art/`; tests and the probe inject their own). */
  localArt?: LocalArtLookup
  /** The direct URL sources in lane order (default: every source of `direct-art/`; tests inject `[]`). */
  directSources?: DirectArtSource[]
  /** Media batcher flush interval and item cap (defaults 250 ms / none; tests shorten). */
  batch?: { intervalMs?: number; maxItems?: number }
  /** How long the full lane waits behind a busy network stage (default `FULL_LANE_WAIT_MAX_MS`; tests shorten). */
  fullLaneWaitMaxMs?: number
  /** The minimum gap between two `art:progress` reports (default 250 ms; tests use 0 to see every change). */
  artProgressIntervalMs?: number
  /** The coalescing window of the full lane's `library:changed` (default 250 ms; tests shorten). */
  changedIntervalMs?: number
}

/**
 * Per-game memo of what each scraper returned (result null = tried, nothing usable), shared by the text and art
 * passes. `kinds` records which art kinds the fetch asked for (null = every kind): the cover lane asks SteamGridDB
 * for the grid only, and the full lane re-fetches just the kinds still missing, reusing the search's candidate.
 */
interface CachedResult {
  result: ScrapedResult | null
  candidate?: MetadataCandidate
  kinds: ArtKind[] | null
  /** The search had another result of the candidate's title: the game's year may still choose between them. */
  contested?: boolean
  /** The scraper did not answer (it threw): not "nothing found". */
  failed?: boolean
}
type ResultCache = Map<ScraperId, CachedResult>

/** One accepted game: what the cover lane needs and whether the full lane follows. */
interface Job {
  seeds: ArtSeed[]
  coverOnly: boolean
  offline: boolean
  seedOnly: boolean
  force: boolean
  /** Enters the full lane after the cover lane (false for coverOnly / offline / seedOnly). */
  full: boolean
  /**
   * A 'done' game looked at again for its missing art only (`EnqueueOptions.missingArt`, or an automatic retry of a
   * game whose `coverMissing` back-off ran out): in the full lane it runs the art fill for the missing kinds, never
   * the text chain or HLTB, and its status stays as it is.
   */
  artOnly?: boolean
  /**
   * The art-only job is the automatic cover retry (not the user's "Refresh missing"): when the cover lane's seeds
   * gave the game its cover meanwhile, the art chain is not asked.
   */
  coverRetry?: boolean
  /** The game was 'done' when queued (a forced Refresh): a quit puts it back to 'done', not 'pending'. */
  wasDone?: boolean
}

function hasText(result: ScrapedResult): boolean {
  return TEXT_FIELDS.some((field) => {
    const value = result.metadata[field]
    if (value === undefined || value === null || value === '') return false
    return !(Array.isArray(value) && value.length === 0)
  })
}

/** A game HLTB had no match for is looked up again after this long (HLTB adds games; titles get fixed). */
const HLTB_MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The version of the HLTB matching a record was made by (`hltb.rules`). 2: search words without the dashes and "+"
 * that hid Steam titles from HLTB's search (KINGDOM HEARTS -HD 1.5+2.5 ReMIX-). 3: a "Game + Add-on" store title
 * (KINGDOM HEARTS III + Re Mind) is matched to its game, never to the add-on's DLC entry. 4: a title with a short series
 * label first ("007: From Russia with Love") is also searched without it (HLTB's "From Russia with Love"). A miss
 * recorded by older rules is looked up again at once, not a month later, and so are the times of a "Game + Add-on"
 * game found by older rules (they may be the add-on's). 5: HLTB's entry named with its year ("SSX (2012)") is that
 * game of that year, and an entry on the console a ROM was found on goes before one that is not; only the games rule
 * 4 could get wrong by it are looked up again: a miss for a short title with a year (`yearTagHidden`), and the times
 * of a ROM with such a title that is known to share its name with another game (its IGDB address is numbered, or the
 * library has a game of that title from other years). Other recorded times stay until the game is refreshed.
 */
export const HLTB_MATCH_RULES = 5

/**
 * The version of the name-match rules (candidate-match.ts) a game's name-searched sources were matched with
 * (`metadata.nameMatchRules`). 1: a name-search result is checked against the title (0.1.67). 2: Steam games' SteamGridDB
 * matches made by name (not by their app id) are checked too, and a remaster or remake is not its original (0.1.71). 3: of
 * equally close results, the one released closest to the game's year; a recorded match of the same title but another
 * year ("SSX" of 2000 for its 2012 reboot) is scraped again when a closer one exists (0.1.160). 4: SteamGridDB results of the same name are given their
 * release year (its search may not), so 3 is redone where it could not tell them apart (0.1.163). 5: a game's own
 * record goes before an edition of it ("X" before "X - Limited Edition"), and a ROM's console counts: of same-titled
 * results, one the source lists on that console, and while the year is not known one from the console's years.
 * Recorded on each game when it is matched. Games are not re-checked in the background (Refresh metadata matches
 * again), except once after rule 5 by `recheckConsoleMatches`: ROM games whose recorded IGDB match is an edition's
 * record or whose SteamGridDB game is a same-titled one of another year.
 */
export const NAME_MATCH_RULES = 5
/** IGDB ids asked about in one request of `recheckConsoleMatches` (IGDB's largest page). */
const RECHECK_IGDB_BATCH = 500
/**
 * `recheckConsoleMatches` stops asking SteamGridDB after this many requests it did not answer (a refused key, the PC
 * offline): the games not asked about keep their old rule number and are asked on the next start.
 */
const RECHECK_SGDB_FAILURES_MAX = 3
/** The sources a game's name is searched at whose match `recheckConsoleMatches` can flag. */
const REMATCH_SOURCES: ScraperId[] = ['igdb', 'steamgriddb']

/**
 * Whether a game flagged by `recheckConsoleMatches` is left alone for now: its forced run did not get through
 * (`metadata.rematchTried`: when, and how many in a row), and it is forced again only after `failedRetryDelayMs` of
 * that count (an hour, doubled per run, a week at most), not on every start and every scan while a source keeps
 * failing (refused credentials, a used-up allowance).
 */
export function rematchHeld(game: Pick<Game, 'metadata'>, now = Date.now()): boolean {
  const tried = game.metadata.rematchTried
  if (!game.metadata.rematch || !tried) return false
  // A timestamp that does not parse, or one from the future (the clock was set back), holds nothing back.
  const age = now - Date.parse(tried.at)
  return age >= 0 && age < failedRetryDelayMs(tried.count)
}
/** `metadata.sources` key of a match the user picked (Identify): never re-checked. Its value names the source. */
export const USER_MATCH_SOURCE = 'user-match'
/** The direct art sources that look a game up by a scraper's recorded id: their art came from the same match. */
const WRONG_MATCH_ART_SOURCES: Partial<Record<ScraperId, string[]>> = {
  igdb: ['igdb-external'],
  steamgriddb: ['steamgriddb-platform']
}

/**
 * IGDB's address of a game that shares its name with one it listed before: the slug gets a number ("/games/ssx--1"
 * for the 2012 "SSX", "/games/ssx" for the game of 2000).
 */
const IGDB_SHARED_NAME_RE = /igdb\.com\/games\/[^/?#]+--\d+\/?$/i

/** 'hltb:progress' at most this often (plus the first and last report of a pass). */
const HLTB_PROGRESS_INTERVAL_MS = 500
/** A progress line in the log every this many games (about every two minutes at HLTB's one lookup a second). */
const HLTB_PROGRESS_LOG_EVERY = 100

/** The title a game is looked up by: the user's override, else its own. */
function titleOfGame(game: Game): string {
  return game.user.titleOverride?.trim() || game.title
}

function yearOf(releaseDate: string | undefined): number | undefined {
  const m = releaseDate?.match(/^(\d{4})/)
  return m ? Number.parseInt(m[1], 10) : undefined
}

/**
 * What the console a ROM was found on (its folder) says to a source's name search: the source's own id of it and its
 * years. Nothing for a store or PC game: its matching is as it was.
 */
function consoleHintFor(scraper: Scraper, game: Game): ConsoleHint {
  if (game.source !== 'rom') return {}
  const key = platformKeyForGame(game)
  const hint: ConsoleHint = {}
  if (scraper.id === 'igdb' || scraper.id === 'screenscraper' || scraper.id === 'thegamesdb') {
    const platformId = platformIdFor(scraper.id, key)
    if (platformId) hint.platformId = platformId
  }
  const era = platformYearsFor(key)
  if (era) hint.era = era
  return hint
}

/** The names HowLongToBeat may list a ROM's console by (none for a store or PC game). */
function hltbConsolesOf(game: Game): string[] | undefined {
  if (game.source !== 'rom') return undefined
  const key = platformKeyForGame(game)
  const consoles = hltbConsolesFor(key, platformNameFor(key))
  return consoles.length ? consoles : undefined
}

export function createMetadataService(
  deps: MetadataDeps,
  options: MetadataServiceOptions = {}
): MetadataService {
  const { library, imageCache, events, log } = deps
  const scrapers = new Map<ScraperId, Scraper>()
  for (const s of options.scrapers ?? [
    steamStoreScraper,
    gogScraper,
    screenScraperScraper,
    igdbScraper,
    theGamesDbScraper,
    steamGridDbScraper
  ]) {
    scrapers.set(s.id, s)
  }
  const lookupHltb = options.hltbLookup ?? hltbLookup
  // The background re-check tells "HLTB has no such game" (recorded) from "HLTB did not answer" (asked next run).
  const lookupHltbOutcome =
    options.hltbLookupOutcome ??
    (options.hltbLookup
      ? async (title: string, year?: number, consoles?: string[]) => ({
          times: await lookupHltb(title, year, consoles),
          failed: false
        })
      : hltbLookupOutcome)
  const fetchCurrentPlayers = options.steamCurrentPlayers ?? steamCurrentPlayers
  const fetchPeakPlayers = options.steamPeakPlayers ?? steamChartsPeak
  const maxScreenshots = Math.max(0, options.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS)
  const fullLaneWaitMaxMs = options.fullLaneWaitMaxMs ?? FULL_LANE_WAIT_MAX_MS
  const changedIntervalMs = options.changedIntervalMs ?? CHANGED_INTERVAL_MS
  // IGDB / ScreenScraper / TheGamesDB platform ids live in resources/systems/platform-ids.json.
  if (deps.resourcesDir) configurePlatformIds(deps.resourcesDir)

  // --- queues -----------------------------------------------------------------
  /** Every accepted game until both lanes are through with it. */
  const jobs = new Map<string, Job>()
  /** Cover lane, local stage (path seeds, local caches) and network stage (URL seeds, direct URLs, SteamGridDB). */
  const coverQueue: string[] = []
  const networkQueue: string[] = []
  const coverActive = new Set<string>()
  const fullQueue: string[] = []
  const fullActive = new Set<string>()
  /** Full-lane games in flight whose art step has not finished yet (the 'art' stage of 'art:progress'). */
  const artPending = new Set<string>()
  const forced = new Set<string>()
  /** Forced requests that arrived while the game was in the full lane; re-queued when that job finishes. */
  const rerun = new Set<string>()
  /** Scraper results the cover lane fetched (SteamGridDB), reused by the full lane for the same game. */
  const results = new Map<string, ResultCache>()
  /** Games whose run in hand had a scraper that did not answer (it threw): "nothing found" is not a real miss. */
  const scrapeErrors = new Set<string>()
  /**
   * Games whose run in hand left out or was refused by a source that paused itself (TheGamesDB after a 429): that
   * source was never asked, so a run without a find is neither a miss nor an error (`noteOutcome`).
   */
  const scrapePaused = new Set<string>()
  /**
   * Games the user identified (`apply`) while a job of theirs was queued or in flight: that job writes nothing more
   * (a forced background run would put its own match over the user's). Until the job is through.
   */
  const userPicked = new Set<string>()
  let done = 0
  let disposed = false
  let hltbBackfill: Promise<void> | null = null
  /** The start-up HLTB pass while it runs (the H.L.T.B. sort's lookups wait for it). */
  let hltbBackfillActive: Promise<void> | null = null
  let consoleRecheck: Promise<void> | null = null
  let resumeTimer: NodeJS.Timeout | null = null
  let progressTimer: NodeJS.Timeout | null = null
  let lastCovered: string | null = null
  /** The local indexes were (re)built for the batch in hand; false once the cover lane has used them. */
  let localIndexFresh = true
  /** When the cover lane's network stage began (null while the lane is idle or still in the local stage). */
  let networkSince: number | null = null
  /** Wakes the full lane once the network stage has run for `fullLaneWaitMaxMs`. */
  let fullWaitTimer: NodeJS.Timeout | null = null

  // --- live caches -------------------------------------------------------------
  const liveRefreshedAt = new Map<string, number>()
  /** The Active Players sort's SteamCharts reads (active-players.ts); its writes are announced in batches. */
  const activePlayers = createActivePlayers({
    library,
    log,
    fetchChart: options.steamChartsPlayers,
    batchIntervalMs: options.activePlayersBatchMs,
    onChanged: (gameIds) => {
      if (!disposed) events.emit('library:changed', { reason: 'metadata', gameIds })
    }
  })

  /** The H.L.T.B. sort's lookups of games without times (hltb-times.ts); its writes are announced in batches. */
  const hltbTimes = createHltbTimes({
    library,
    log,
    enabled: () => deps.settings.get().scrapers.hltb.enabled,
    lookup: (title, year, consoles) => lookupHltbOutcome(title, year, consoles),
    paused: options.hltbPaused ?? (() => hltbPaused()),
    queryOf: (game) => ({
      title: titleOfGame(game),
      year: yearOf(game.metadata.releaseDate),
      consoles: hltbConsolesOf(game)
    }),
    matchRules: HLTB_MATCH_RULES,
    missRetryMs: HLTB_MISS_RETRY_MS,
    busy: () => hltbBackfillActive,
    batchIntervalMs: options.hltbTimesBatchMs,
    progressIntervalMs: HLTB_PROGRESS_INTERVAL_MS,
    onChanged: (gameIds) => {
      if (!disposed) events.emit('library:changed', { reason: 'metadata', gameIds })
    },
    onProgress: (progress) => {
      if (!disposed) events.emit('hltb:progress', progress)
    }
  })

  // The batcher's writes are announced through the same coalesced `library:changed` as the full lane's (below):
  // one event names everything that changed in the window, the first one of a quiet period goes out at once.
  const batcher: MediaBatcher = createMediaBatcher(
    { setMediaBatch: (items) => noteChanged(library.setMediaBatch(items, { quiet: true })) },
    { intervalMs: options.batch?.intervalMs, maxItems: options.batch?.maxItems }
  )

  /**
   * The sources that matched the game by its name and can be asked again: SteamGridDB for a game without a Steam app id
   * (with one, it is found by the id), and IGDB. TheGamesDB has a monthly allowance and ScreenScraper matches ROMs by
   * their hash, so they are not asked; a game scraped again for another source's wrong match is matched again by them.
   */
  function configured(ids: readonly ScraperId[], settings: Settings, forGame?: string): Scraper[] {
    const out: Scraper[] = []
    for (const id of ids) {
      const scraper = scrapers.get(id)
      if (!scraper || out.includes(scraper)) continue
      let ok = false
      try {
        ok = scraper.isConfigured(settings)
        // A source that paused itself (TheGamesDB after a 429) is left out until it is available again; the game's
        // run then lacks an answer it would have had (`scrapePaused`).
        if (ok && pausedBy(scraper)) {
          ok = false
          if (forGame) scrapePaused.add(forGame)
        }
      } catch (err) {
        log.warn(`${id}: isConfigured failed: ${describeError(err)}`)
      }
      if (ok) out.push(scraper)
    }
    return out
  }

  /** The scraper has paused itself (`Scraper.available`): a request it refused meanwhile is no per-game error. */
  function pausedBy(scraper: Scraper): boolean {
    try {
      return scraper.available?.() === false
    } catch {
      return false
    }
  }

  function resultsFor(gameId: string): ResultCache {
    let cache = results.get(gameId)
    if (!cache) {
      cache = new Map()
      results.set(gameId, cache)
    }
    return cache
  }

  /**
   * Search + fetch with one scraper, memoised per game; failures are logged and count as "nothing". A memo that
   * was fetched for fewer art kinds than asked now (the cover lane's `['cover']`) is completed with one more
   * fetch for the missing kinds, from the same candidate (no second search); the media maps are merged.
   */
  async function scrapeWith(
    scraper: Scraper,
    game: Game,
    settings: Settings,
    cache: ResultCache,
    kinds?: ArtKind[]
  ): Promise<ScrapedResult | null> {
    const wanted = kinds ?? SCRAPER_ART_KINDS
    const cached = cache.get(scraper.id)
    if (cached) {
      if (!cached.result || !cached.candidate || !cached.kinds) return cached.result
      const missing = wanted.filter((k) => !cached.kinds!.includes(k))
      if (!missing.length) return cached.result
      try {
        const more = await scraper.fetch(game, cached.candidate, settings, missing)
        cached.result = { ...cached.result, media: { ...cached.result.media, ...more.media } }
      } catch (err) {
        if (pausedBy(scraper)) {
          scrapePaused.add(game.id)
          log.debug(`${scraper.id}: paused; "${game.title}" not asked`)
        } else {
          scrapeErrors.add(game.id)
          log.warn(`${scraper.id}: failed for "${game.title}": ${describeError(err)}`)
        }
      }
      cached.kinds = [...new Set([...cached.kinds, ...missing])]
      return cached.result
    }
    const entry: CachedResult = { result: null, kinds: kinds ? [...kinds] : null }
    try {
      const { candidate, contested } = await findMatch(scraper, game, settings)
      if (candidate) {
        entry.candidate = candidate
        entry.contested = contested
        entry.result = await scraper.fetch(game, candidate, settings, kinds)
      } else log.debug(`${scraper.id}: no match for "${game.title}"`)
    } catch (err) {
      if (pausedBy(scraper)) {
        // The source paused itself (a used-up allowance): it says nothing about this game, so the game's run is
        // neither an error nor a miss of that source; the source logged the pause once.
        scrapePaused.add(game.id)
        log.debug(`${scraper.id}: paused; "${game.title}" not asked`)
      } else {
        entry.failed = true
        scrapeErrors.add(game.id)
        log.warn(`${scraper.id}: failed for "${game.title}": ${describeError(err)}`)
      }
    }
    cache.set(scraper.id, entry)
    return entry.result
  }

  /**
   * The source's game for this one: a result it found by the game's own id as it is; else, of a name search, the
   * result whose title is close to the game's (a search's first hit is often another game: "Nickelodeon GUTS" for the
   * ROM "Nickelodeon Rugrats - Search for Reptar"). When none is, the title is searched again as the ROM sets' " - "
   * read as ": " and without a licensor in front. Undefined when nothing is convincing. Of equally close results, the
   * one released closest to the game's year (this run's text sources' year, else the one it has) is taken; a ROM's
   * console counts too (`consoleHintFor`).
   */
  async function findCandidate(
    scraper: Scraper,
    game: Game,
    settings: Settings
  ): Promise<MetadataCandidate | undefined> {
    return (await findMatch(scraper, game, settings)).candidate
  }

  /** findCandidate, and whether the search had another result of that title (`contested`). */
  async function findMatch(
    scraper: Scraper,
    game: Game,
    settings: Settings
  ): Promise<{ candidate?: MetadataCandidate; contested: boolean }> {
    const wanted = searchNameFor(game)
    const year = yearHints.get(game.id) ?? yearOf(game.metadata.releaseDate)
    const on = consoleHintFor(scraper, game)
    const pick = (
      results: MetadataCandidate[]
    ): { candidate?: MetadataCandidate; contested: boolean } => {
      const candidate = pickCandidate(results, wanted, year, on)
      const key = candidate && sameTitleKey(candidate.title)
      const contested =
        !!candidate &&
        results.some((c) => c.externalId !== candidate.externalId && sameTitleKey(c.title) === key)
      return { candidate, contested }
    }
    const first = pick(await scraper.search(game, settings))
    if (first.candidate || scraper.idOnly) return first
    for (const query of searchVariantsFor(wanted).slice(1)) {
      const found = pick(await scraper.search(game, settings, query))
      if (found.candidate) {
        log.debug(
          `${scraper.id}: "${game.title}" found as "${found.candidate.title}" by "${query}"`
        )
        return found
      }
    }
    return { contested: false }
  }

  /** Game id -> the release year this run's text sources gave it (before it is written): name matches go by it. */
  const yearHints = new Map<string, number>()

  /**
   * After the text sources gave the game a year: an art match the cover lane (or an earlier step of this run) made by
   * name alone for another game of the same title released years apart ("SSX" of 2000 for its 2012 reboot, found
   * before the year was known) is made again with the year; when that is another game, the first match's art and id
   * go, so the art chain fills them from the right one. So is a match with no date that the search had a same-titled
   * rival for (the source's first "SSX" has no date, its second is of 2012); one without a rival is not searched
   * again. Never touches a match made by the game's own id.
   */
  async function rematchByYear(
    gameId: string,
    settings: Settings,
    cache: ResultCache
  ): Promise<void> {
    const year = yearHints.get(gameId)
    const current = library.getGame(gameId)
    if (!year || !current) return
    // The text sources gave the year: they are not second-guessed by it, only the art-only sources (SteamGridDB).
    const textSources = new Set(textChain(current, settings).map((s) => s.id))
    for (const [id, entry] of [...cache]) {
      if (textSources.has(id)) continue
      const candidate = entry.candidate
      const found = candidate ? candidateYear(candidate) : undefined
      if (!candidate || candidate.byId || withinYear(candidate, year)) continue
      if (found === undefined && !entry.contested) continue
      const scraper = scrapers.get(id)
      const game = library.getGame(gameId)
      if (!scraper || !game) continue
      let better: MetadataCandidate | undefined
      try {
        better = await findCandidate(scraper, game, settings)
      } catch (err) {
        log.debug(`${id}: year re-match failed for "${game.title}": ${describeError(err)}`)
        continue
      }
      if (!better || better.externalId === candidate.externalId) continue
      // Only for one released near the game's year (a port far from every candidate keeps its match), or, from a
      // match the console's years made that is of another year, back to the source's own undated choice.
      const betterYear = candidateYear(better)
      if (!withinYear(better, year) && !(betterYear === undefined && found !== undefined)) continue
      log.info(
        `${id}: "${game.title}" (${year}) was matched to ${candidate.externalId} (${found ?? 'no date'}); now ${better.externalId} (${betterYear ?? 'no date'})`
      )
      if (
        library.getGame(gameId)?.metadata.sources?.[id] === candidate.externalId ||
        game.metadata.sources?.['art:cover'] === id
      )
        await dropWrongMatch(gameId, id)
      // The right game's art in place of the first one's, without searching again: the art chain takes it from here.
      try {
        const result = await scraper.fetch(game, better, settings, entry.kinds ?? undefined)
        cache.set(id, { result, candidate: better, kinds: entry.kinds, contested: true })
      } catch (err) {
        scrapeErrors.add(gameId)
        log.warn(`${id}: failed for "${game.title}": ${describeError(err)}`)
        cache.delete(id)
      }
    }
  }

  /** The next games of a queue a batch source may fetch along with the game in hand (`Lookahead`). */
  function lookaheadOver(queue: string[]): Lookahead {
    return (limit, usable) => {
      const out: { game: Game; ids: ArtIds }[] = []
      for (const id of queue) {
        if (out.length >= limit) break
        const job = jobs.get(id)
        if (!job || job.coverOnly || job.seedOnly || job.offline) continue
        const game = library.getGame(id)
        if (!game) continue
        const ids = artIdsOf(game)
        if (usable(game, ids)) out.push({ game, ids })
      }
      return out
    }
  }

  const coverLane: CoverLane = createCoverLane({
    library,
    imageCache,
    settings: deps.settings,
    localArt: options.localArt ?? createLocalArtRegistry({ settings: deps.settings, log }),
    directSources: options.directSources ?? createDirectArtSources({ log }),
    batcher,
    log,
    steamGridDb: (game, settings) => {
      const [sgdb] = configured(['steamgriddb'], settings, game.id)
      if (!sgdb) return Promise.resolve(null)
      // The grid only: the full lane fetches the other kinds later, and only the ones still missing.
      return scrapeWith(sgdb, game, settings, resultsFor(game.id), ['cover'])
    }
  })

  // --- library:changed coalescing ------------------------------------------------
  // The full lane writes each game once (text + art sources + HLTB + status, `quiet`) and announces the games of
  // the last window in one event, so the renderer sees a few small `library:changed` a second instead of 4-6 per
  // game for an hour.
  const changedIds = new Set<string>()
  let changedTimer: NodeJS.Timeout | null = null

  let lastChangedAt = Number.NEGATIVE_INFINITY

  function flushChanged(): void {
    if (changedTimer) {
      clearTimeout(changedTimer)
      changedTimer = null
    }
    if (!changedIds.size) return
    const gameIds = [...changedIds]
    changedIds.clear()
    lastChangedAt = Date.now()
    events.emit('library:changed', { reason: 'metadata', gameIds })
  }

  /** Announce changed games: at once after a quiet period (the first cover of a run), then once per window. */
  function noteChanged(gameIds: string | string[]): void {
    for (const id of Array.isArray(gameIds) ? gameIds : [gameIds]) changedIds.add(id)
    if (!changedIds.size || changedTimer || disposed) return
    const since = Date.now() - lastChangedAt
    if (since >= changedIntervalMs) {
      flushChanged()
      return
    }
    changedTimer = setTimeout(flushChanged, changedIntervalMs - since)
    changedTimer.unref?.()
  }

  // --- progress ----------------------------------------------------------------

  const coverLaneSize = (): number => coverQueue.length + networkQueue.length + coverActive.size
  const fullLaneSize = (): number => fullQueue.length + fullActive.size

  /** 'art:progress' (art-progress.ts): the cover lane's games, then the full lane's art steps. */
  const artProgress = createArtProgress({
    remaining: (stage) =>
      stage === 'cover' ? coverLaneSize() : fullQueue.length + artPending.size,
    emit: (progress) => events.emit('art:progress', progress),
    intervalMs: options.artProgressIntervalMs
  })

  /** The full lane is through with a game's art (or with the game before it got that far). */
  function artFinished(gameId: string): void {
    if (artPending.delete(gameId)) artProgress.finished('art')
  }

  function emitProgress(
    gameId: string,
    status: MetadataProgress['status'],
    lane: MetadataLane,
    message?: string
  ): void {
    events.emit('metadata:progress', {
      gameId,
      status,
      remaining: jobs.size,
      message,
      lane,
      queued: jobs.size,
      coverLane: coverLaneSize(),
      fullLane: fullLaneSize(),
      done
    })
  }

  /** Cover-lane progress is coalesced: one event per interval, riding on the batcher's flush. */
  function scheduleProgress(gameId: string): void {
    lastCovered = gameId
    if (progressTimer || disposed) return
    progressTimer = setTimeout(() => {
      progressTimer = null
      if (disposed) return
      batcher.flush()
      if (lastCovered) emitProgress(lastCovered, 'pending', 'cover')
    }, PROGRESS_INTERVAL_MS)
    progressTimer.unref?.()
  }

  /** The game is through both lanes (or the only lane it entered). */
  function finishJob(gameId: string, status: MetadataProgress['status'], lane: MetadataLane): void {
    jobs.delete(gameId)
    results.delete(gameId)
    scrapeErrors.delete(gameId)
    scrapePaused.delete(gameId)
    userPicked.delete(gameId)
    done++
    if (jobs.size === 0) {
      // Both lanes drained: write what is pending, tell the renderer once, forget the indexes so the next scan
      // sees new files.
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
      batcher.flush()
      flushChanged()
      coverLane.reset()
      localIndexFresh = true
      networkSince = null
      emitProgress(gameId, status, lane, library.getGame(gameId)?.title)
    } else if (lane === 'full') {
      emitProgress(gameId, status, lane, library.getGame(gameId)?.title)
    } else {
      scheduleProgress(gameId)
    }
  }

  // --- full lane ---------------------------------------------------------------

  /** Text sources in priority order: the game's own store, ScreenScraper for ROMs, then the general databases. */
  function textChain(game: Game, settings: Settings): Scraper[] {
    const ids: ScraperId[] = []
    if (steamAppIdOf(game)) ids.push('steam')
    if (gogProductIdOf(game)) ids.push('gog')
    if (game.source === 'rom') ids.push('screenscraper')
    ids.push('igdb', 'thegamesdb')
    return configured(ids, settings, game.id)
  }

  /** The art sources in the user's order; with `forGame`, a paused one is noted on that game's run. */
  function artChain(settings: Settings, forGame?: string): Scraper[] {
    return configured(settings.scrapers.artPriority, settings, forGame)
  }

  /** Download one art kind from a scraper's result; the scraper's media policy throttles API-hosted media. */
  async function importKind(
    gameId: string,
    kind: ArtKind,
    scraper: Scraper,
    result: ScrapedResult,
    quality: 'full' | undefined
  ): Promise<boolean> {
    const policy = scraper.mediaPolicy
    if (kind === 'screenshot') {
      const urls = (result.media.screenshots ?? [])
        .filter((u) => typeof u === 'string' && u.length > 0)
        .slice(0, maxScreenshots)
      if (!urls.length) return false
      const local: string[] = []
      for (let i = 0; i < urls.length; i++) {
        const url = await imageCache.importRemote(gameId, 'screenshot', urls[i], i, policy)
        if (url) local.push(url)
      }
      if (!local.length || !library.getGame(gameId)) return false
      library.applyMetadata(gameId, { media: { screenshots: local } }, { overwrite: true })
      return true
    }
    const url = result.media[kind]
    if (!url) return false
    const local = await imageCache.importRemote(gameId, kind, url, undefined, policy)
    if (!local) {
      log.debug(`${kind} download failed: ${redactSecrets(url)}`)
      return false
    }
    // The user may have chosen a file while the download was in flight (`setMediaBatch` skips it too).
    const current = library.getGame(gameId)
    if (!current || current.user.customMedia?.[kind]) return false
    batcher.add({ gameId, kind, url: local, source: scraper.id, quality })
    return true
  }

  function hasArt(game: Game, kind: ArtKind): boolean {
    const current = kind === 'screenshot' ? game.media.screenshots : game.media[kind]
    if (Array.isArray(current) ? current.length > 0 : !!current) return true
    return kind !== 'screenshot' && batcher.has(game.id, kind)
  }

  /** A cover the cover lane landed at 300x450: the full lane replaces it with a full-size one when one exists. */
  function wantsUpgrade(game: Game, kind: ArtKind): boolean {
    return (
      kind === 'cover' &&
      game.metadata.sources?.['art:cover:quality'] === 'small' &&
      !game.user.customMedia?.cover
    )
  }

  interface FillArtOptions {
    /** Replace art the game already has (a user-chosen match, Refresh). */
    overwrite: boolean
    /** Ask the local caches and direct sources before `chain` (off after a user-chosen match: the ids may be wrong). */
    useSources: boolean
    /** The job's seeds: the kinds the cover lane deferred are landed first. */
    seeds?: ArtSeed[]
    lookahead?: Lookahead
    /** The run was overtaken (the user identified the game meanwhile): nothing more is downloaded for it. */
    abandoned?: () => boolean
    /** Only these kinds are looked for (an art-only run: the missing cover, hero, logo and icon; no screenshots). */
    kinds?: readonly ArtKind[]
  }

  /**
   * For every art kind the game is missing: the seeds and the local caches and direct sources first (through the
   * cover lane's `fillKinds`), then `chain` in order, downloading the first URL that works. Kinds the game already
   * has (or the cover lane landed, flushed or not) are skipped unless `overwrite`; user-chosen custom media is
   * always left alone. Returns the kinds that were filled and the scraper ids (`metadata.sources`) of the results
   * that supplied them, for the caller to write in its one transaction per game.
   */
  async function fillArt(
    gameId: string,
    settings: Settings,
    chain: Scraper[],
    cache: ResultCache,
    options: FillArtOptions
  ): Promise<{ filled: Set<ArtKind>; sources: Record<string, string> }> {
    const filled = new Set<ArtKind>()
    const sources: Record<string, string> = {}
    const game = library.getGame(gameId)
    if (!game) return { filled, sources }
    const { overwrite } = options
    const missing = (kind: ArtKind): boolean => {
      if (options.kinds && !options.kinds.includes(kind)) return false
      const current = library.getGame(gameId)
      if (!current) return false
      if (kind !== 'screenshot' && current.user.customMedia?.[kind]) return false
      return overwrite || !hasArt(current, kind) || wantsUpgrade(current, kind)
    }
    if (options.useSources) {
      const ids = artIdsOf(game)
      const wanted = ART_KINDS.filter((kind) => kind !== 'screenshot' && missing(kind))
      const plain = wanted.filter((k) => !wantsUpgrade(game, k))
      const kindsOptions = {
        seeds: options.seeds,
        force: overwrite,
        lookahead: options.lookahead
      }
      for (const kind of await coverLane.fillKinds(game, ids, plain, kindsOptions)) filled.add(kind)
      if (wanted.some((k) => wantsUpgrade(game, k)))
        for (const kind of await coverLane.fillKinds(game, ids, ['cover'], {
          ...kindsOptions,
          upgradeCover: true
        }))
          filled.add(kind)
    }
    for (const kind of ART_KINDS) {
      if (options.abandoned?.()) return { filled, sources }
      if (filled.has(kind) || !missing(kind)) continue
      const current = library.getGame(gameId)
      if (!current) return { filled, sources }
      const upgrade = !overwrite && wantsUpgrade(current, kind)
      for (const scraper of chain) {
        if (options.abandoned?.()) return { filled, sources }
        // Only SteamGridDB's 600x900 grids are worth replacing a small cover with.
        if (upgrade && scraper.id !== 'steamgriddb') continue
        // An art-only scraper is not searched for a kind it cannot supply (SteamGridDB for screenshots).
        if (scraper.artKinds && !scraper.artKinds.includes(kind)) continue
        // A scraper asked for the first time here fetches only the kinds still missing at this point.
        const stillMissing = ART_KINDS.filter(
          (k) => k !== 'screenshot' && !filled.has(k) && missing(k)
        )
        const result = await scrapeWith(scraper, current, settings, cache, stillMissing)
        if (!result) continue
        if (!(await importKind(gameId, kind, scraper, result, upgrade ? 'full' : undefined)))
          continue
        if (!library.getGame(gameId)) return { filled, sources }
        Object.assign(sources, result.metadata.sources ?? {})
        filled.add(kind)
        break
      }
    }
    return { filled, sources }
  }

  /**
   * A source's match found to be another game: the art it brought (the scraper's, or a direct source's keyed by the
   * same id) and its ids go, the user's own art stays.
   */
  async function dropWrongMatch(gameId: string, source: ScraperId): Promise<void> {
    batcher.flush()
    // The art the wrong id brought, from the scraper or from the direct source keyed by that id.
    const from = new Set<string>([source, ...(WRONG_MATCH_ART_SOURCES[source] ?? [])])
    for (const kind of ART_KINDS) {
      const game = library.getGame(gameId)
      if (!game || kind === 'screenshot') continue
      if (game.user.customMedia?.[kind]) continue
      if (!from.has(game.metadata.sources?.[`art:${kind}`] ?? '') || !hasArt(game, kind)) continue
      library.setMedia(gameId, kind, null)
      try {
        await imageCache.remove(gameId, kind)
      } catch (err) {
        log.debug(`could not remove ${kind} of ${gameId}: ${describeError(err)}`)
      }
    }
    // The wrong id itself goes too: the next scrape's direct sources must not find that game again by it.
    const game = library.getGame(gameId)
    if (!game) return
    const sources = Object.fromEntries(
      Object.entries(game.metadata.sources ?? {}).filter(
        ([key, value]) => key !== source && !(key.startsWith('art:') && from.has(value))
      )
    )
    library.applyMetadata(
      gameId,
      { metadata: { sources } },
      { overwrite: true, replaceSources: true, quiet: true }
    )
  }

  /**
   * In the forced run of a game `recheckConsoleMatches` flagged: SteamGridDB is asked before the art step, and when
   * its game is another one than the recorded one, the recorded one's art and id go first (`dropWrongMatch`). The art
   * step then fills what the right game has; a kind it does not have stays empty for the other art sources, not on the
   * other game's picture. The answer is memoised: the art step does not search again.
   */
  async function replaceSteamGridDbMatch(
    gameId: string,
    settings: Settings,
    cache: ResultCache
  ): Promise<void> {
    const game = library.getGame(gameId)
    const recorded = game?.metadata.sources?.steamgriddb
    const sgdb = artChain(settings).find((s) => s.id === 'steamgriddb')
    if (!game || !recorded || !sgdb) return
    await scrapeWith(sgdb, game, settings, cache)
    const found = cache.get(sgdb.id)?.candidate?.externalId
    if (!found || found === recorded) return
    log.info(`steamgriddb: "${game.title}" was matched to ${recorded}; now ${found}`)
    await dropWrongMatch(gameId, sgdb.id)
  }

  /**
   * Drop every non-custom piece of art the game still has except `keep`: after the user re-identifies a game,
   * whatever the chosen source did not supply belongs to the previous (wrong) match.
   */
  async function clearStaleArt(gameId: string, keep: Set<ArtKind>): Promise<void> {
    batcher.flush()
    for (const kind of ART_KINDS) {
      const game = library.getGame(gameId)
      if (!game || keep.has(kind)) continue
      if (kind !== 'screenshot' && game.user.customMedia?.[kind]) continue
      if (!hasArt(game, kind)) continue
      if (kind === 'screenshot')
        library.applyMetadata(gameId, { media: { screenshots: [] } }, { overwrite: true })
      else library.setMedia(gameId, kind, null)
      try {
        await imageCache.remove(gameId, kind)
      } catch (err) {
        log.debug(`could not remove stale ${kind} for ${gameId}: ${describeError(err)}`)
      }
    }
  }

  /**
   * The HLTB times for the game (null when disabled, already there and not forced, or not found). `text` is what
   * the text chain found for this run (not yet written): its title and release year steer the lookup.
   */
  async function fetchHltb(
    gameId: string,
    settings: Settings,
    force: boolean,
    text: { title?: string; releaseDate?: string } = {}
  ): Promise<GameMetadata['hltb'] | null> {
    if (!settings.scrapers.hltb.enabled) return null
    const game = library.getGame(gameId)
    if (!game || (game.metadata.hltb && !force)) return null
    const title = game.user.titleOverride?.trim() || text.title || game.title
    const times = await lookupHltb(
      title,
      yearOf(text.releaseDate ?? game.metadata.releaseDate),
      hltbConsolesOf(game)
    )
    if (!times || !library.getGame(gameId)) return null
    return { ...times, rules: HLTB_MATCH_RULES, updatedAt: new Date().toISOString() }
  }

  /**
   * The text of the chain merged in its priority order: with `force` every field a scraper of this run has replaces
   * what the game had (the first scraper that has it wins), so nothing of an earlier, wrong match outlives a refresh
   * where a source still supplies that field (the description and link of IGDB's "Limited Edition" record under a
   * ScreenScraper answer that has neither); otherwise every scraper only fills fields the game lacks. `sources` are
   * merged from all of them.
   */
  function mergeText(
    game: Game,
    results: ScrapedResult[],
    force: boolean
  ): { title?: string; metadata: Partial<GameMetadata> } {
    const metadata: Partial<GameMetadata> = {}
    const sources: Record<string, string> = {}
    let title: string | undefined
    // Whether a result of this run gave the title: under `force` the first that has one wins (the database row, the
    // first result when the database has the game, has none, so the first scraper's title still replaces the old one).
    let titleTaken = false
    const empty = (value: unknown): boolean =>
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    results.forEach((result, i) => {
      const first = force && i === 0
      if (result.title && ((force && !titleTaken) || (!title && !game.title))) {
        title = result.title
        titleTaken = true
      }
      for (const [key, value] of Object.entries(result.metadata) as [
        keyof GameMetadata,
        unknown
      ][]) {
        if (key === 'sources' || empty(value)) continue
        if (first || (empty(metadata[key]) && (force || empty(game.metadata[key]))))
          (metadata as Record<string, unknown>)[key] = value
      }
      Object.assign(sources, result.metadata.sources ?? {})
    })
    if (Object.keys(sources).length) metadata.sources = sources
    return { title, metadata }
  }

  /**
   * The full pipeline for one queued game: text in priority order, art per kind, HLTB, then one library write
   * (text, art sources, HLTB and the final status in a single transaction, announced through the coalesced
   * `library:changed`).
   */
  async function processGame(gameId: string, force: boolean): Promise<void> {
    const game = library.getGame(gameId)
    // The user identified the game while this job waited (or does while it runs): their choice stands.
    const overtaken = (): boolean => userPicked.has(gameId)
    if (!game || overtaken()) return
    const settings = deps.settings.get()
    const cache = resultsFor(gameId)
    const job = jobs.get(gameId)
    const lookahead = lookaheadOver(fullQueue)
    const texts: ScrapedResult[] = []
    // The PlayOut database first: its row is the first text result, so its facts win on a forced Refresh and fill
    // empty fields otherwise; the scrapers still supply the description, the art and the links.
    const database = databaseFor(game, settings)
    let dbFound = false
    if (database) {
      const match = await database.lookup(game).catch(() => null)
      if (overtaken()) return
      if (match) {
        dbFound = true
        texts.push(databaseResult(game, match.row))
      }
    }
    for (const scraper of textChain(game, settings)) {
      const result = await scrapeWith(scraper, game, settings, cache)
      if (overtaken()) return
      if (!result || !(hasText(result) || result.title)) continue
      if (!library.getGame(gameId)) return
      texts.push(result)
    }
    // Only the scrapers count as a find (with the art and HLTB below): a game that has only the database's row is
    // kept with its facts but stays 'failed', so a later scan still fetches its description and art.
    let found = texts.length - (dbFound ? 1 : 0) > 0
    // The year the text sources agree on first (their priority order): art matched by name goes by it.
    const textYear = texts.map((t) => yearOf(t.metadata.releaseDate)).find((y) => y !== undefined)
    if (textYear) yearHints.set(gameId, textYear)
    let art: Awaited<ReturnType<typeof fillArt>>
    try {
      try {
        await rematchByYear(gameId, settings, cache)
      } catch (err) {
        log.debug(`year re-match failed for ${gameId}: ${describeError(err)}`)
      }
      if (force && game.metadata.rematch && !overtaken())
        await replaceSteamGridDbMatch(gameId, settings, cache)
      if (overtaken()) return
      art = await fillArt(gameId, settings, artChain(settings, gameId), cache, {
        overwrite: force,
        useSources: true,
        seeds: job?.seeds,
        lookahead,
        abandoned: overtaken
      })
    } finally {
      // Only this run's: a later run without a text year goes by the game's recorded one.
      yearHints.delete(gameId)
    }
    artFinished(gameId)
    if (overtaken()) return
    if (art.filled.size) found = true
    const before = library.getGame(gameId)
    if (!before) return
    const merged = mergeText(before, texts, force)
    const hltb = await fetchHltb(gameId, settings, force, {
      title: merged.title,
      releaseDate: merged.metadata.releaseDate
    })
    if (hltb) found = true
    // The cover lane may have landed art for this game and counted it as found for the renderer already.
    const current = library.getGame(gameId)
    if (!current || overtaken()) return
    if (hasOwnArt(current)) found = true
    // A game flagged by recheckConsoleMatches is through with it once a forced run is in which every source that
    // matches by name answered and the art of SteamGridDB's game landed; until then it keeps its mark and its old rule
    // number, and is run again later (`rematchHeld`: not at once, a source may keep failing).
    const marked = current.metadata.rematch
    const sgdbArt = cache.get('steamgriddb')?.result?.media
    const artMissed =
      !!sgdbArt &&
      SCRAPER_ART_KINDS.some(
        (kind) =>
          kind !== 'screenshot' &&
          !!sgdbArt[kind] &&
          !current.user.customMedia?.[kind] &&
          !hasArt(current, kind)
      )
    const unanswered =
      !!marked &&
      (!force || artMissed || REMATCH_SOURCES.some((id) => cache.get(id)?.failed === true))
    const sources = { ...(merged.metadata.sources ?? {}), ...art.sources }
    const metadata: Partial<GameMetadata> = {
      ...merged.metadata,
      ...(Object.keys(sources).length ? { sources } : {}),
      ...(hltb ? { hltb } : {}),
      // Matched just now, with the current rules: nothing to re-check.
      ...(found && !unanswered ? { nameMatchRules: NAME_MATCH_RULES } : {}),
      ...(marked && force && unanswered
        ? {
            rematchTried: {
              at: new Date().toISOString(),
              count: (current.metadata.rematchTried?.count ?? 0) + 1
            }
          }
        : {})
    }
    library.applyMetadata(
      gameId,
      {
        title: merged.title,
        ...(Object.keys(metadata).length ? { metadata } : {}),
        status: found ? 'done' : 'failed'
      },
      { overwrite: force, quiet: true }
    )
    if (marked && !unanswered) clearRematch(gameId)
    noteCoverOutcome(gameId)
    noteChanged(gameId)
    // A game the database lacked, now matched: offered to it (the service checks the setting and the game).
    if (database && !dbFound && found) database.noteScraped(gameId)
  }

  /**
   * The art-only run of a 'done' game (`Job.artOnly`): the art fill for the kinds it is missing over the art chain,
   * the local caches and the direct sources. Nothing it has is replaced (no overwrite), its text, HLTB times, status
   * and the user's edits are not touched; only the art sources' ids are added to `metadata.sources`.
   */
  async function processMissingArt(gameId: string): Promise<void> {
    const overtaken = (): boolean => userPicked.has(gameId)
    const game = library.getGame(gameId)
    if (!game || overtaken()) return
    if (jobs.get(gameId)?.coverRetry && (hasArt(game, 'cover') || game.user.customMedia?.cover)) {
      artFinished(gameId)
      noteCoverOutcome(gameId, { clearMissed: true })
      noteChanged(gameId)
      return
    }
    const settings = deps.settings.get()
    const art = await fillArt(gameId, settings, artChain(settings, gameId), resultsFor(gameId), {
      overwrite: false,
      useSources: true,
      seeds: jobs.get(gameId)?.seeds,
      lookahead: lookaheadOver(fullQueue),
      abandoned: overtaken,
      // Only the kinds it lacks: a small cover it has is not upgraded here (nothing it has is replaced).
      kinds: missingArtKinds(game)
    })
    artFinished(gameId)
    if (overtaken() || !library.getGame(gameId)) return
    if (Object.keys(art.sources).length)
      library.applyMetadata(gameId, { metadata: { sources: art.sources } }, { quiet: true })
    if (art.filled.size) log.debug(`missing art for ${gameId}: ${[...art.filled].join(', ')}`)
    noteCoverOutcome(gameId, { clearMissed: true })
    noteChanged(gameId)
  }

  /**
   * After a run: a game left without a cover (none scraped, none of the user's) records `coverMissing` (when, how many
   * runs in a row) for the automatic enqueues' back-off, whatever its status; one with a cover forgets it. A cover
   * that landed in an art-only run also ends the game's `scrapeMissed` back-off (`clearMissed`).
   */
  function noteCoverOutcome(gameId: string, options: { clearMissed?: boolean } = {}): void {
    const game = library.getGame(gameId)
    if (!game || game.remote) return
    if (hasArt(game, 'cover') || game.user.customMedia?.cover) {
      library.clearMetadataField(gameId, 'coverMissing', { quiet: true })
      if (options.clearMissed) library.clearMetadataField(gameId, 'scrapeMissed', { quiet: true })
      return
    }
    library.applyMetadata(
      gameId,
      {
        metadata: {
          coverMissing: {
            at: new Date().toISOString(),
            // A paused art source was not asked: no evidence of one more cover-less run.
            count: (game.metadata.coverMissing?.count ?? 0) + (scrapePaused.has(gameId) ? 0 : 1)
          }
        }
      },
      { overwrite: true, quiet: true }
    )
  }

  /** The PlayOut database when it is switched on and the game is this PC's own (never a paired host's). */
  function databaseFor(game: Game, settings: Settings): GameDatabaseLookup | null {
    if (!deps.gameDatabase || game.remote) return null
    return settings.scrapers.gameDatabase.enabled ? deps.gameDatabase : null
  }

  /**
   * A database row as a text result. The Steam tags record keeps the controls badge the game has (the row has no
   * controls), so a Refresh that lays the row's tags does not lose it; its Valve Anti-Cheat answer (PeerParty) is
   * kept the same way.
   */
  function databaseResult(game: Game, row: GameDbRow): ScrapedResult {
    const metadata = gameDbMetadataOf(row, game.source === 'rom', new Date().toISOString())
    const controls = game.metadata.steamTags?.controls
    if (metadata.steamTags && controls) metadata.steamTags = { ...metadata.steamTags, controls }
    const vac = game.metadata.steamTags?.vac
    if (metadata.steamTags && vac !== undefined) metadata.steamTags = { ...metadata.steamTags, vac }
    return { metadata, media: {} }
  }

  /** The game is through with the mark of `recheckConsoleMatches` (matched again, or identified by the user). */
  function clearRematch(gameId: string): void {
    library.clearMetadataField(gameId, 'rematch', { quiet: true })
    library.clearMetadataField(gameId, 'rematchTried', { quiet: true })
  }

  /** Whether the game has art that is not the user's own custom art (what makes a run count as a find). */
  function hasOwnArt(game: Game): boolean {
    return ART_KINDS.some(
      (kind) => (kind === 'screenshot' || !game.user.customMedia?.[kind]) && hasArt(game, kind)
    )
  }

  /**
   * Records a full-lane miss on the game (when, and how many in a row) for the automatic enqueues' backoff, and
   * forgets it once a run found something. A run in which a scraper did not answer (`errored`) is no evidence that
   * the game is unknown: it is not counted as one more miss in a row and only holds the game back for
   * `erroredRetryDelayMs`. A run that left out a source that paused itself (`paused`) raises neither count.
   * Quiet: the run's own write already announced the game.
   */
  function noteOutcome(
    gameId: string,
    status: 'done' | 'failed',
    errored: boolean,
    paused = false
  ): void {
    const game = library.getGame(gameId)
    if (!game) return
    if (status === 'done') {
      library.clearMetadataField(gameId, 'scrapeMissed', { quiet: true })
      return
    }
    const last = game.metadata.scrapeMissed
    const misses = last?.count ?? 0
    const at = new Date().toISOString()
    library.applyMetadata(
      gameId,
      {
        metadata: {
          scrapeMissed: errored
            ? { at, count: misses, errors: (last?.errors ?? 0) + 1 }
            : paused
              ? // A source that paused itself was not asked: neither one more miss nor one more error; the game
                // waits as its last record says (a first one: `failedRetryDelayMs(0)`, about the pause's hour).
                { at, count: misses, ...(last?.errors ? { errors: last.errors } : {}) }
              : { at, count: misses + 1 }
        }
      },
      { overwrite: true, quiet: true }
    )
  }

  /** Whether the full lane may start games now: the cover lane is idle, or its network stage has run too long. */
  function fullLaneMayRun(): boolean {
    if (coverLaneSize() === 0) return true
    return networkSince !== null && Date.now() - networkSince >= fullLaneWaitMaxMs
  }

  function pumpFull(): void {
    // The full lane waits while the cover lane has work: a new enqueue pauses it again (games in flight finish).
    // After `FULL_LANE_WAIT_MAX_MS` of network stage it runs beside the cover lane instead.
    if (
      !disposed &&
      fullQueue.length &&
      networkSince !== null &&
      !fullLaneMayRun() &&
      !fullWaitTimer
    ) {
      fullWaitTimer = setTimeout(
        () => {
          fullWaitTimer = null
          pumpFull()
        },
        Math.max(0, networkSince + fullLaneWaitMaxMs - Date.now())
      )
      fullWaitTimer.unref?.()
    }
    while (
      !disposed &&
      fullLaneMayRun() &&
      fullActive.size < FULL_CONCURRENCY &&
      fullQueue.length
    ) {
      const gameId = fullQueue.shift()!
      const force = forced.delete(gameId)
      const artOnly = !force && jobs.get(gameId)?.artOnly === true
      fullActive.add(gameId)
      artPending.add(gameId)
      void (artOnly ? processMissingArt(gameId) : processGame(gameId, force))
        .then((): 'done' | 'failed' =>
          library.getGame(gameId)?.metadataStatus === 'failed' ? 'failed' : 'done'
        )
        .catch((err): 'done' | 'failed' => {
          log.error(`metadata failed for ${gameId}: ${describeError(err)}`)
          // An art-only run that broke off leaves the game as it was ('done', its text untouched).
          if (artOnly) return 'done'
          // The run broke off: like a scraper that did not answer, that is not "nothing exists for this game".
          scrapeErrors.add(gameId)
          if (library.getGame(gameId)) library.applyMetadata(gameId, { status: 'failed' })
          return 'failed'
        })
        .then((status) => {
          fullActive.delete(gameId)
          // An art-only run is no text run: the game's `scrapeMissed` stays (a landed cover cleared it already).
          const paused = scrapePaused.delete(gameId)
          if (artOnly) scrapeErrors.delete(gameId)
          else noteOutcome(gameId, status, scrapeErrors.delete(gameId), paused)
          // A game removed (or failed) before its art step still leaves the 'art' stage.
          artFinished(gameId)
          // A forced refresh asked for while this run was in flight (custom art cleared, user pressed Refresh)
          // runs again now, so the request is not lost; queued inline so this event's count includes it.
          if (rerun.delete(gameId) && !disposed && library.getGame(gameId)) {
            const job = jobs.get(gameId)
            if (job) {
              job.force = true
              job.artOnly = false
            }
            // Asked for after the user identified the game: that run is theirs.
            userPicked.delete(gameId)
            // A fresh run asks the scrapers again instead of replaying this run's memoised answers.
            results.delete(gameId)
            fullQueue.push(gameId)
            forced.add(gameId)
            library.applyMetadata(gameId, { status: 'pending' })
            artProgress.changed()
            emitProgress(gameId, status, 'full', library.getGame(gameId)?.title)
          } else {
            finishJob(gameId, status, 'full')
          }
          pumpFull()
        })
    }
  }

  // --- cover lane --------------------------------------------------------------

  /** Whether a game the local stage could not cover has anything left to try on the network. */
  function needsNetwork(job: Job): boolean {
    if (job.offline) return false
    if (job.coverOnly || job.seedOnly) return job.seeds.some((s) => !!s.url)
    return true
  }

  /**
   * A seed landed art on a game an automatic enqueue was holding back as recently failed (a seed-only job): that is
   * new information, not a repeat miss, so the job goes through the full lane once after all. It ends 'done' there
   * (the game has art now) with whatever text and HLTB the sources have, instead of staying 'failed' with a cover
   * that no later scan would name again.
   */
  function promoteSeeded(gameId: string, job: Job): boolean {
    if (!job.seedOnly || job.coverOnly || job.offline || job.full) return false
    if (library.getGame(gameId)?.metadataStatus !== 'failed') return false
    // The cover lane's writes are batched: the game has its art only once they are written.
    batcher.flush()
    const game = library.getGame(gameId)
    if (!game || !hasOwnArt(game)) return false
    job.seedOnly = false
    job.full = true
    fullQueue.push(gameId)
    library.applyMetadata(gameId, { status: 'pending' })
    artProgress.changed()
    return true
  }

  function pumpCover(): void {
    // The local stage (path seeds, local caches: no network) drains first; the network stage (URL seeds, direct
    // URLs, SteamGridDB) only fills the slots the local stage leaves free, so covers already on this PC never
    // wait behind downloads.
    while (
      !disposed &&
      coverActive.size < COVER_CONCURRENCY &&
      (coverQueue.length || networkQueue.length)
    ) {
      const stage: CoverLaneStage = coverQueue.length ? 'local' : 'network'
      const gameId = (stage === 'local' ? coverQueue : networkQueue).shift()!
      const job = jobs.get(gameId)
      const game = library.getGame(gameId)
      if (!job || !game) {
        jobs.delete(gameId)
        artProgress.finished('cover')
        continue
      }
      localIndexFresh = false
      if (stage === 'network' && networkSince === null) networkSince = Date.now()
      coverActive.add(gameId)
      void coverLane
        .runCoverLane(game, artIdsOf(game), {
          stage,
          seeds: job.seeds,
          coverOnly: job.coverOnly,
          offline: job.offline,
          seedOnly: job.seedOnly,
          force: job.force,
          deferExtras: job.full,
          lookahead: lookaheadOver(networkQueue)
        })
        .catch((err) => {
          log.warn(`cover lane failed for "${game.title}": ${describeError(err)}`)
          return { covered: false }
        })
        .then((outcome) => {
          coverActive.delete(gameId)
          if (disposed) return
          // A cover now (landed, or there already): the game's "ended without a cover" back-off is over.
          if (outcome.covered) library.clearMetadataField(gameId, 'coverMissing', { quiet: true })
          if (stage === 'local' && !outcome.covered && needsNetwork(job)) {
            networkQueue.push(gameId)
          } else {
            artProgress.finished('cover')
            if (job.full || promoteSeeded(gameId, job)) scheduleProgress(gameId)
            else finishJob(gameId, 'done', 'cover')
          }
          pumpCover()
          if (coverLaneSize() === 0) {
            // The full lane reads what the cover lane landed (media, the 'small' cover marker): write it first.
            networkSince = null
            if (fullWaitTimer) {
              clearTimeout(fullWaitTimer)
              fullWaitTimer = null
            }
            batcher.flush()
          }
          pumpFull()
        })
    }
  }

  // --- enqueue -----------------------------------------------------------------

  /**
   * New games get the PlayOut database's facts at once from what it has in memory (no download), only into empty
   * fields, so a big new library shows its facts long before the full lane reaches each game (whose run looks the
   * database up again).
   */
  function fillFromDatabase(gameIds: string[], downloaded = false): void {
    const database = deps.gameDatabase
    if (!database || !gameIds.length || disposed) return
    const settings = deps.settings.get()
    const changed: string[] = []
    const missed: Game[] = []
    for (const gameId of gameIds) {
      const game = library.getGame(gameId)
      if (!game || !databaseFor(game, settings) || userPicked.has(gameId)) continue
      // After the download: only games still waiting for their run (a run looks the database up itself).
      if (downloaded && (!jobs.has(gameId) || fullActive.has(gameId) || forced.has(gameId)))
        continue
      const match = database.lookupCached(game)
      if (!match) {
        missed.push(game)
        continue
      }
      library.applyMetadata(
        gameId,
        { metadata: databaseResult(game, match.row).metadata },
        { overwrite: false, quiet: true }
      )
      changed.push(gameId)
    }
    if (changed.length) noteChanged(changed)
    // Games whose shards were not in memory: once they are downloaded, the same fill for those still waiting.
    if (!downloaded && missed.length)
      void database
        .prefetchGames(missed)
        .then(() =>
          fillFromDatabase(
            missed.map((g) => g.id),
            true
          )
        )
        .catch((err: unknown) =>
          log.debug(`game database: instant fill failed: ${describeError(err)}`)
        )
  }

  function enqueue(gameIds: string[], opts: EnqueueOptions = {}): number {
    if (disposed) return 0
    const missingArt = opts.missingArt === true
    const forceAll = opts.force === true
    const retryFailed = forceAll || opts.retryFailed === true
    const coverOnly = opts.coverOnly === true
    const offline = opts.offline === true
    const seedsByGame = new Map<string, ArtSeed[]>()
    for (const seed of opts.seeds ?? []) {
      if (!seed.gameId || (!seed.path && !seed.url)) continue
      // A seed for art the game already has, or for a URL that answered 404 in an earlier run, costs nothing
      // (every launch re-imports the owned list, and the tracker's confirming scans report the same files).
      if (!forceAll && seed.kind !== 'screenshot') {
        const game = library.getGame(seed.gameId)
        if (game?.media[seed.kind] || game?.user.customMedia?.[seed.kind]) continue
        if (seed.url && game && missingArtUrls(game, seed.kind).includes(seed.url)) continue
      }
      const list = seedsByGame.get(seed.gameId) ?? []
      list.push(seed)
      seedsByGame.set(seed.gameId, list)
    }
    if (jobs.size === 0) done = 0
    // A batch that starts while the cover lane is idle (the full lane may still be busy for an hour) re-reads the
    // local caches: Steam may have written art for these very games since the indexes were built.
    if (coverLaneSize() === 0 && !localIndexFresh) {
      coverLane.resetLocal()
      localIndexFresh = true
    }
    const accepted: string[] = []
    const pending: string[] = []
    let artOnlyCount = 0
    for (const gameId of new Set([...gameIds, ...seedsByGame.keys()])) {
      const game = library.getGame(gameId)
      if (!game) {
        log.debug(`enqueue: unknown game ${gameId}`)
        continue
      }
      const seeds = seedsByGame.get(gameId) ?? []
      // A game recheckConsoleMatches flagged whose forced run did not get through (the app quit first, or the source
      // did not answer): whatever asks for its metadata next replaces the wrong match, it does not fill gaps beside it.
      // Not while such a run failed a short while ago (`rematchHeld`): then the game is as any other until later.
      const force =
        forceAll || (!!game.metadata.rematch && !coverOnly && !offline && !rematchHeld(game))
      const existing = jobs.get(gameId)
      if (existing) {
        // Already queued or in flight: a forced request is honoured once the current run is through, seeds join
        // the cover job when it has not started yet.
        // The user's "Refresh missing" over a queued automatic cover retry: all the missing art is looked for.
        if (missingArt) delete existing.coverRetry
        if (seeds.length && (coverQueue.includes(gameId) || networkQueue.includes(gameId)))
          existing.seeds.push(...seeds)
        if (forceAll) {
          if (fullActive.has(gameId)) rerun.add(gameId)
          else if (existing.full) {
            existing.force = true
            forced.add(gameId)
            // An art-only job waiting for the full lane becomes the full run the user asked for.
            if (existing.artOnly) {
              existing.artOnly = false
              library.setMetadataStatusBatch([gameId], 'pending')
            }
            // A refresh asked for after the user identified the game is theirs too.
            userPicked.delete(gameId)
          }
        }
        continue
      }
      // A game that failed a short while ago is treated as 'done' by an automatic enqueue (its seeds still run):
      // otherwise every scan / import would send each unmatched game through the whole scraper chain again.
      const isDone =
        game.metadataStatus === 'done' || (!retryFailed && !coverOnly && failedRecently(game))
      // A 'done' game missing art: the user's "Refresh missing" (or a newly saved key) looks for that art at once; an
      // automatic enqueue only once the game's "ended without a cover" back-off has run out. A cover-less game
      // without the marker (scraped before 0.9.82) was never tried under these rules: it is due now, and its run
      // records the marker, so the back-off applies from then on. Art only: the text of a matched game is never
      // scraped again in the background.
      const artOnly =
        isDone &&
        !force &&
        !coverOnly &&
        !offline &&
        game.metadataStatus === 'done' &&
        missingArtKinds(game).length > 0 &&
        (missingArt ||
          (!game.media.cover && !game.user.customMedia?.cover && !coverMissingRecently(game)))
      if (isDone && !force && !seeds.length && !artOnly) continue
      const seedOnly = isDone && !force && !artOnly
      const full = !coverOnly && !offline && !seedOnly
      jobs.set(gameId, {
        seeds,
        coverOnly,
        offline,
        seedOnly,
        force,
        full,
        ...(artOnly ? { artOnly: true } : {}),
        ...(artOnly && !missingArt ? { coverRetry: true } : {}),
        ...(game.metadataStatus === 'done' ? { wasDone: true } : {})
      })
      coverQueue.push(gameId)
      if (full) {
        fullQueue.push(gameId)
        if (force) forced.add(gameId)
        if (artOnly) artOnlyCount++
        // An art-only job keeps the game's status: it is 'done', and stays so.
        else pending.push(gameId)
      }
      accepted.push(gameId)
    }
    if (!accepted.length) return 0
    if (pending.length) library.setMetadataStatusBatch(pending, 'pending')
    fillFromDatabase(pending.filter((id) => !jobs.get(id)?.force))
    log.info(
      `queued ${accepted.length} game(s): cover lane ${coverLaneSize()}, full lane ${fullLaneSize()}` +
        (seedsByGame.size ? `, ${opts.seeds?.length ?? 0} seed(s)` : '') +
        (coverOnly ? ', covers only' : '') +
        (offline ? ', offline' : '') +
        (artOnlyCount ? `, ${artOnlyCount} for missing art only` : '')
    )
    emitProgress(accepted[0], 'pending', 'cover')
    pumpCover()
    artProgress.changed()
    return accepted.length
  }

  // --- one-time re-check of ROM matches made before the console counted -----------

  /**
   * Whether the SteamGridDB game a ROM's art is from is a same-titled game of another year where SteamGridDB has one
   * of the game's own year ("SSX" of 2000 for the 2012 game): 'wrong'; 'fine' when not (or when nothing can tell: no
   * recorded year, no date at SteamGridDB, a port dated years after the only game of that title); 'unasked' when
   * SteamGridDB is not set up, 'failed' when it did not answer. One request by the recorded id (kept, so shared ids
   * ask once), and a name search only when the years are more than YEAR_MATCH_WINDOW apart. The game the search then
   * gives counts when it is of the game's year, or has no date (`pickCandidate` takes an undated same-titled game
   * before one dated years away).
   */
  async function steamGridDbMatchOf(
    game: Game,
    sgdb: Scraper | undefined,
    settings: Settings
  ): Promise<'fine' | 'wrong' | 'unasked' | 'failed'> {
    const sources = game.metadata.sources ?? {}
    const id = sources.steamgriddb
    const year = yearOf(game.metadata.releaseDate)
    if (!id || year === undefined) return 'fine'
    if (!Object.keys(sources).some((k) => /^art:[a-z]+$/.test(k) && sources[k] === 'steamgriddb'))
      return 'fine'
    if (!sgdb?.yearOf) return 'unasked'
    try {
      const found = await sgdb.yearOf(id, settings)
      if (typeof found !== 'number' || Math.abs(found - year) <= YEAR_MATCH_WINDOW) return 'fine'
      const better = await findCandidate(sgdb, game, settings)
      const right =
        !!better &&
        better.externalId !== id &&
        (withinYear(better, year) || candidateYear(better) === undefined)
      return right ? 'wrong' : 'fine'
    } catch (err) {
      log.debug(`match re-check: SteamGridDB did not answer: ${describeError(err)}`)
      return 'failed'
    }
  }

  /**
   * Once after NAME_MATCH_RULES 5: the ROM games matched by older rules (never one the user identified) whose recorded
   * match that rule would not make are scraped again (forced, so the wrong match's text and art are replaced; the
   * user's own art and edits stay); the others are marked as checked, one by one, and never looked at again. Two
   * checks, both starting from what is recorded:
   * - the IGDB record is the game's title with edition words the ROM's own title does not have ("... - Limited
   *   Edition" for the game): one IGDB request per 500 games, no search. A record under another name (an alternative
   *   name, a compilation) is left alone, whatever IGDB lists it as.
   * - the SteamGridDB game its art is from is a same-titled game of another year (`steamGridDbMatchOf`): one
   *   SteamGridDB request for each ROM game with SteamGridDB art and a known year.
   * A flagged game carries `metadata.rematch` (the source) until a forced run is through in which IGDB and
   * SteamGridDB both answered and SteamGridDB's art landed: a quit before that leaves the mark, and the next start (or
   * whatever enqueues the game first) runs it forced again; a run in which a source failed leaves it too, and is
   * repeated only after a while (`rematchHeld`), not on every start. A game whose source could not be asked (not
   * configured, no answer) keeps its old rule number: asked next start. SteamGridDB is not asked about the rest of the
   * library once it failed RECHECK_SGDB_FAILURES_MAX times in a pass.
   */
  async function recheckConsoleMatches(): Promise<void> {
    const settings = deps.settings.get()
    if (disposed || !settings.scrapers.autoScrape) return
    const eligible = (g: Game): boolean =>
      g.source === 'rom' && !g.metadata.sources?.[USER_MATCH_SOURCE] && !jobs.has(g.id)
    // Flagged on an earlier start, and that forced run did not get through.
    const left = library
      .games()
      .filter((g) => !!g.metadata.rematch && eligible(g) && !rematchHeld(g))
      .map((g) => g.id)
    if (left.length) {
      log.info(`match re-check: ${left.length} game(s) flagged earlier are scraped again`)
      enqueue(left, { force: true })
    }
    const stale = library
      .games()
      .filter(
        (g) =>
          eligible(g) &&
          g.metadataStatus === 'done' &&
          !g.metadata.rematch &&
          (g.metadata.nameMatchRules ?? 0) < NAME_MATCH_RULES
      )
    if (!stale.length) return
    const flag = (ids: string[], source: ScraperId): void => {
      const marked = ids.filter((id) => library.getGame(id) && !jobs.has(id))
      for (const id of marked)
        library.applyMetadata(
          id,
          { metadata: { rematch: source } },
          { overwrite: true, quiet: true }
        )
      if (marked.length) enqueue(marked, { force: true })
    }
    const unasked = new Set<string>()
    let flagged = 0

    // 1. IGDB: an edition's record where the game has its own.
    const editions: string[] = []
    const withIgdb = stale.filter((g) => /^\d+$/.test(g.metadata.sources?.igdb ?? ''))
    const [igdb] = configured(['igdb'], settings)
    if (!igdb?.recordsOf) for (const g of withIgdb) unasked.add(g.id)
    else {
      for (let i = 0; i < withIgdb.length && !disposed; i += RECHECK_IGDB_BATCH) {
        const batch = withIgdb.slice(i, i + RECHECK_IGDB_BATCH)
        try {
          const records = await igdb.recordsOf(
            batch.map((g) => g.metadata.sources!.igdb!),
            settings
          )
          for (const g of batch) {
            const record = records.get(g.metadata.sources!.igdb!)
            if (!record) continue
            // The record's title is the game's but for edition words: a ROM that names the edition itself ("...
            // Limited Edition") is rightly on it, and a record under another name is not judged by its kind.
            const match = titleMatch(searchNameFor(g), record.title)
            if (match.exact && !match.own) editions.push(g.id)
          }
        } catch (err) {
          log.debug(`match re-check: IGDB did not answer: ${describeError(err)}`)
          for (const g of batch) unasked.add(g.id)
        }
      }
    }
    if (disposed) return
    flag(editions, 'igdb')
    flagged += editions.length

    // 2. SteamGridDB: art from a same-titled game of another year. Each game is settled as it is answered, so a quit
    // part-way through a large library does not ask about the settled ones again.
    const [sgdb] = configured(['steamgriddb'], settings)
    let checked = 0
    let failures = 0
    for (const g of stale) {
      if (editions.includes(g.id)) continue
      const game = library.getGame(g.id)
      // One whose IGDB record could not be asked about is looked at whole on the next start.
      if (!game || jobs.has(g.id) || game.metadata.rematch || unasked.has(g.id)) continue
      const match = await steamGridDbMatchOf(game, sgdb, settings)
      if (disposed) return
      if (match === 'wrong') {
        flag([g.id], 'steamgriddb')
        flagged++
      } else if (match === 'failed') {
        unasked.add(g.id)
        // A refused key, the PC offline: not one failing request per game of the library, on every start.
        if (++failures >= RECHECK_SGDB_FAILURES_MAX) {
          log.info('match re-check: SteamGridDB is not answering; the rest is asked next start')
          break
        }
      } else if (match === 'unasked') unasked.add(g.id)
      else if (library.getGame(g.id) && !jobs.has(g.id)) {
        library.applyMetadata(
          g.id,
          { metadata: { nameMatchRules: NAME_MATCH_RULES } },
          { overwrite: true, quiet: true }
        )
        checked++
      }
    }
    log.info(
      `match re-check: ${stale.length} ROM game(s) matched by older rules: ${flagged} scraped again, ` +
        `${checked} kept, ${unasked.size} asked next start`
    )
  }

  // --- live Steam data ---------------------------------------------------------

  async function refreshLive(gameId: string): Promise<void> {
    const game = library.getGame(gameId)
    if (!game) return
    const appId = steamAppIdOf(game)
    if (!appId) return
    const last = liveRefreshedAt.get(gameId)
    if (last !== undefined && Date.now() - last < LIVE_TTL_MS) return
    liveRefreshedAt.set(gameId, Date.now())
    const peakAt = Date.parse(game.metadata.peakPlayers?.updatedAt ?? '')
    const peakDue = !(Date.now() - peakAt < PEAK_TTL_MS)
    const [count, peak] = await Promise.all([
      fetchCurrentPlayers(appId),
      peakDue ? fetchPeakPlayers(appId) : Promise.resolve(null)
    ])
    const now = new Date().toISOString()
    const metadata: Partial<GameMetadata> = {}
    if (count !== null) metadata.currentPlayers = { count, updatedAt: now }
    if (peak !== null) metadata.peakPlayers = { count: peak, updatedAt: now }
    if (Object.keys(metadata).length && library.getGame(gameId)) {
      library.applyMetadata(gameId, { metadata }, { overwrite: true })
    }
  }

  const service: MetadataService = {
    enqueue,

    async search(gameId, query) {
      const game = library.requireGame(gameId)
      const settings = deps.settings.get()
      const q = query.trim() || undefined
      const chain = configured(SEARCH_ORDER, settings)
      const settled = await Promise.allSettled(
        chain.map((scraper) => scraper.search(game, settings, q))
      )
      const out: MetadataCandidate[] = []
      settled.forEach((outcome, i) => {
        const scraper = chain[i]
        if (outcome.status === 'rejected') {
          log.warn(`${scraper.id}: search failed: ${describeError(outcome.reason)}`)
          return
        }
        for (const candidate of outcome.value.slice(0, MAX_CANDIDATES_PER_SCRAPER))
          out.push({ ...candidate, scraper: scraper.id })
      })
      return out
    },

    async apply(gameId, candidate) {
      const game = library.requireGame(gameId)
      const scraper = scrapers.get(candidate.scraper)
      if (!scraper) throw new Error(`Unknown metadata source "${candidate.scraper}"`)
      const settings = deps.settings.get()
      let result: ScrapedResult
      try {
        result = await scraper.fetch(game, candidate, settings)
      } catch (err) {
        log.warn(`${scraper.id}: fetch failed for "${candidate.title}": ${describeError(err)}`)
        throw new Error(`${scraper.id}: ${describeError(err)}`, { cause: err })
      }
      // A run of this game still queued or in flight (a scan's, the forced one of `recheckConsoleMatches`) must not
      // put its own match over this one: it is not forced any more and writes nothing.
      const job = jobs.get(gameId)
      if (job) {
        userPicked.add(gameId)
        job.force = false
        forced.delete(gameId)
        rerun.delete(gameId)
      }
      // The user picked this match: the previous match's source ids go, not just its text.
      library.applyMetadata(
        gameId,
        {
          title: result.title,
          metadata: {
            ...result.metadata,
            sources: { ...(result.metadata.sources ?? {}), [USER_MATCH_SOURCE]: scraper.id }
          },
          status: 'done'
        },
        { overwrite: true, replaceSources: true }
      )
      clearRematch(gameId)
      const cache: ResultCache = new Map([
        [scraper.id, { result, candidate, kinds: null } satisfies CachedResult]
      ])
      // The chosen source replaces what it has; everything else still on the game came from the previous
      // match and is dropped before the chain fills the gaps, now searching by the corrected title. The local
      // caches and direct sources are keyed by store ids, which the previous match may have got wrong too, so
      // only the scrapers run here. The user is waiting on this call, so every write is announced at once.
      const writeSources = (sources: Record<string, string>): void => {
        if (Object.keys(sources).length && library.getGame(gameId))
          library.applyMetadata(gameId, { metadata: { sources } }, { overwrite: true })
      }
      const supplied = await fillArt(gameId, settings, [scraper], cache, {
        overwrite: true,
        useSources: false
      })
      writeSources(supplied.sources)
      await clearStaleArt(gameId, supplied.filled)
      const rest = await fillArt(gameId, settings, artChain(settings), cache, {
        overwrite: false,
        useSources: false
      })
      writeSources(rest.sources)
      const hltb = await fetchHltb(gameId, settings, true)
      if (hltb) library.applyMetadata(gameId, { metadata: { hltb } }, { overwrite: true })
      batcher.flush()
      // The user's own match is a good one: offered to the PlayOut database when it lacks the game.
      const picked = library.getGame(gameId)
      const database = picked ? databaseFor(picked, settings) : null
      if (picked && database && !database.lookupCached(picked)) database.noteScraped(gameId)
      return library.requireGame(gameId)
    },

    refreshLive,

    refreshActivePlayers() {
      return activePlayers.refresh()
    },

    refreshHltbTimes() {
      return hltbTimes.refresh()
    },

    stopHltbTimes() {
      hltbTimes.stop()
    },

    backfillHltb() {
      if (hltbBackfill) return hltbBackfill
      hltbBackfill = (async () => {
        // After the H.L.T.B. sort's lookups if they run: two passes never interleave their progress.
        await hltbTimes.running()
        if (!deps.settings.get().scrapers.hltb.enabled) return
        // Looked up again: times found before Solo times were read (`combined` absent), and scraped games with no
        // times (an older matcher missed them: a port released years after HLTB's entry), except those HLTB
        // answered "no match" for within the month.
        // The years of the library's games by title: two games of one title years apart ("SSX" on two consoles).
        const yearsByTitle = new Map<string, number[]>()
        for (const g of library.games()) {
          const year = yearOf(g.metadata.releaseDate)
          if (year === undefined) continue
          const key = sameTitleKey(titleOfGame(g))
          yearsByTitle.set(key, [...(yearsByTitle.get(key) ?? []), year])
        }
        /** What is recorded says another game has this one's name: only then HLTB tags one of them with its year. */
        const sharesName = (g: Game, year: number): boolean =>
          IGDB_SHARED_NAME_RE.test(g.metadata.links?.website ?? '') ||
          (yearsByTitle.get(sameTitleKey(titleOfGame(g))) ?? []).some(
            (y) => Math.abs(y - year) > YEAR_MATCH_WINDOW
          )
        const due = (g: Game): boolean => {
          const hltb = g.metadata.hltb
          const rules = hltb?.rules ?? 1
          // Rule 5 only changed which entry a short title with a year is ("SSX" of 2012: HLTB's "SSX (2012)"): a
          // miss by it for any game (a miss says little, and such titles are few); another game's times only for a
          // ROM known to share its name with another game (most titles are short enough for `yearTagHidden`, and
          // nearly all of their times are right: they are not all asked for again).
          const year = yearOf(g.metadata.releaseDate)
          const byYearTag =
            !!hltb &&
            rules < HLTB_MATCH_RULES &&
            year !== undefined &&
            (hltb.missedAt
              ? yearTagHidden(titleOfGame(g), year, true)
              : g.source === 'rom' && yearTagHidden(titleOfGame(g), year) && sharesName(g, year))
          if (hltb?.missedAt)
            return (
              rules < 4 || byYearTag || Date.now() - Date.parse(hltb.missedAt) >= HLTB_MISS_RETRY_MS
            )
          if (hltb && ((rules < 4 && bundleBase(titleOfGame(g))) || byYearTag)) return true
          if (hltb) return hltb.combined === undefined
          return g.metadataStatus === 'done'
        }
        const stale = library
          .games()
          .filter(due)
          .map((g) => ({ id: g.id, order: Math.random() }))
          // A different order each run: games HLTB cannot answer for cannot hold up the same rest every time.
          .sort((a, b) => a.order - b.order)
          .map((g) => g.id)
        if (!stale.length) return
        log.info(`hltb: looking up ${stale.length} game(s) again`)
        let updated = 0
        let failedInRow = 0
        // The bottom bar ('hltb:progress'): games looked at of the pass's total and the one being matched; total 0
        // when the pass ends, however it ends.
        let lastReport = 0
        const report = (done: number, current?: string, force = false): void => {
          const at = Date.now()
          if (!force && at - lastReport < HLTB_PROGRESS_INTERVAL_MS) return
          lastReport = at
          if (!disposed)
            events.emit('hltb:progress', {
              done: Math.min(done, stale.length),
              total: stale.length,
              ...(current ? { current } : {})
            })
        }
        report(0, undefined, true)
        try {
          for (const [index, gameId] of stale.entries()) {
            const settings = deps.settings.get()
            if (disposed || !settings.scrapers.hltb.enabled) break
            const game = library.getGame(gameId)
            // Looked up again meanwhile (a refresh, the full lane), or gone.
            if (!game || !due(game)) continue
            const title = game.user.titleOverride?.trim() || game.title
            // The first game's name shows at once; later ones at most twice a second.
            report(index, title, index === 0)
            if (index > 0 && index % HLTB_PROGRESS_LOG_EVERY === 0)
              log.info(
                `hltb: ${index} of ${stale.length} game(s) looked up again, ${updated} with times`
              )
            const outcome = await lookupHltbOutcome(
              title,
              yearOf(game.metadata.releaseDate),
              hltbConsolesOf(game)
            ).catch(() => ({ times: null, failed: true }))
            if (disposed) break
            if (outcome.failed) {
              // HLTB not answering (or paused after failures): the rest waits for the next run.
              if (++failedInRow >= 5) {
                log.info('hltb: lookups are not answering; the rest is looked up next run')
                break
              }
              continue
            }
            failedInRow = 0
            const latest = library.getGame(gameId)
            if (!latest) continue
            const now = new Date().toISOString()
            if (outcome.times) {
              library.applyMetadata(
                gameId,
                {
                  metadata: { hltb: { ...outcome.times, rules: HLTB_MATCH_RULES, updatedAt: now } }
                },
                { overwrite: true }
              )
              updated++
            } else if (latest.metadata.hltb && !latest.metadata.hltb.missedAt) {
              // Times found before that HLTB no longer matches: kept, and not asked again. For a "Game + Add-on"
              // game they may be the add-on's: that game is recorded as having none.
              const hadBundle = bundleBase(titleOfGame(latest))
              library.applyMetadata(
                gameId,
                {
                  metadata: {
                    hltb: hadBundle
                      ? { missedAt: now, rules: HLTB_MATCH_RULES }
                      : { ...latest.metadata.hltb, combined: false, rules: HLTB_MATCH_RULES }
                  }
                },
                { overwrite: true, quiet: !hadBundle }
              )
            } else {
              // No match: recorded, so the next runs skip it for a month.
              library.applyMetadata(
                gameId,
                { metadata: { hltb: { missedAt: now, rules: HLTB_MATCH_RULES } } },
                { overwrite: true, quiet: true }
              )
            }
          }
        } finally {
          if (!disposed) events.emit('hltb:progress', { done: 0, total: 0 })
        }
        log.info(`hltb: ${updated} of ${stale.length} game(s) have times after looking again`)
      })()
      const active = hltbBackfill.then(
        () => {},
        () => {}
      )
      hltbBackfillActive = active
      void active.then(() => {
        if (hltbBackfillActive === active) hltbBackfillActive = null
      })
      return hltbBackfill
    },

    recheckConsoleMatches() {
      consoleRecheck ??= recheckConsoleMatches()
      return consoleRecheck
    },

    dispose() {
      disposed = true
      activePlayers.dispose()
      hltbTimes.dispose()
      // Jobs that never got through stay 'pending' (dispose runs before the library store is flushed), so the next
      // start's resume pass finishes an import the quit cut off. A game that was 'done' when it was queued (a
      // forced Refresh, the match re-check) has its metadata still: it is 'done' again (a re-checked game's mark,
      // `metadata.rematch`, has the next start run it). Art-only jobs never left 'done'.
      for (const gameId of fullQueue) {
        if (fullActive.has(gameId)) continue
        const game = library.getGame(gameId)
        if (game?.metadataStatus !== 'pending') continue
        if (jobs.get(gameId)?.wasDone || game.metadata.rematch)
          library.applyMetadata(gameId, { status: 'done' })
      }
      coverQueue.length = 0
      networkQueue.length = 0
      fullQueue.length = 0
      artPending.clear()
      artProgress.dispose()
      jobs.clear()
      forced.clear()
      rerun.clear()
      results.clear()
      if (progressTimer) {
        clearTimeout(progressTimer)
        progressTimer = null
      }
      if (resumeTimer) {
        clearTimeout(resumeTimer)
        resumeTimer = null
      }
      if (fullWaitTimer) {
        clearTimeout(fullWaitTimer)
        fullWaitTimer = null
      }
      batcher.dispose()
      flushChanged()
      coverLane.reset()
    }
  }

  if (options.resumePending !== false) {
    // Games left 'pending' by a crash or a quit mid-queue would otherwise never be picked up again: they were
    // explicitly requested, so they resume even with auto-scrape off; without it they are only unstuck.
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      if (disposed) return
      const games = library.games()
      const stale = games
        .filter((g) => g.metadataStatus === 'pending' && !jobs.has(g.id))
        .map((g) => g.id)
      const autoScrape = deps.settings.get().scrapers.autoScrape
      // Matched games without a cover whose back-off has run out, or that never had one (no coverMissing marker:
      // scraped before 0.9.82): their missing art only (enqueue decides per game; the queue's own concurrency paces
      // a long list).
      const coverless = autoScrape
        ? games
            .filter(
              (g) =>
                g.metadataStatus === 'done' &&
                !g.remote &&
                !jobs.has(g.id) &&
                missingArtKinds(g).includes('cover') &&
                !coverMissingRecently(g)
            )
            .map((g) => g.id)
        : []
      if (coverless.length) {
        log.info(`looking again for the missing covers of ${coverless.length} game(s)`)
        enqueue(coverless)
      }
      if (!stale.length) return
      if (autoScrape) {
        log.info(`resuming ${stale.length} pending metadata job(s)`)
        // One enqueue: the lanes run COVER_CONCURRENCY / FULL_CONCURRENCY at a time, however long the list.
        enqueue(stale)
      } else {
        log.info(`resetting ${stale.length} interrupted metadata job(s) (auto-scrape is off)`)
        library.setMetadataStatusBatch(stale, 'none')
      }
    }, options.resumeDelayMs ?? RESUME_DELAY_MS)
    resumeTimer.unref()
  }

  return service
}
