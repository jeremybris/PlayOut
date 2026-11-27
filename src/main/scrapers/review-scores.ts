// Review scores for the library, in the background: Steam's user reviews first, IGDB's user rating as the backup.
//
// Steam: the store's IStoreBrowseService/GetItems Web API (no key) answers the review summary of up to 100 apps per
// request, as the store page shows it to an English reader: the English reviews' summary (percent positive, how many
// reviews, Steam's label), else all languages' when Steam has no English one. A whole
// library's Steam games take a few seconds. Games of other stores use the Steam app found for them by the Steam tags
// or the install-size match. A Steam score is taken when Steam shows one (it needs about ten reviews).
//
// IGDB, for the rest (needs the IGDB credentials of Settings > Metadata): its `rating` (users' score, 0-100). A game
// is found by its Steam app (IGDB's external_games links), the IGDB id the metadata scrape recorded (both 400 per
// query), else a title search (one request each; only a close title match from the right year is taken). Every
// IGDB request shares the IGDB scraper's token and its 4 requests / second limiter.
//
// Stored in `metadata.reviewScore`; read again after a month.
import type { Game, GameMetadata, RatingsProgress, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { artIdsOf } from './art-ids'
import { normalizeTitle, stripEdition, titleSimilarity } from './hltb'
import { HttpError, httpJson, RateLimiter } from './http'
import { apicalypseString, igdbScraper } from './igdb'
import { platformIdFor, platformKeyForGame } from './platform-ids'
import { describeError } from './steam-store'

export const STEAM_ITEMS_URL = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/'
/** Apps per Steam GetItems request. */
export const STEAM_REVIEWS_BATCH = 100
/** Games per IGDB id / Steam-id query (IGDB returns at most 500 rows; one Steam id can map to two games). */
export const IGDB_RATINGS_BATCH = 400
/** A score is read again after this long (people keep reviewing); a game without one is asked again after this long. */
export const RATING_REFRESH_MS = 30 * 24 * 60 * 60 * 1000
const PAUSE_AFTER_FAILURES_MS = 15 * 60 * 1000
const FAILURES_BEFORE_PAUSE = 3
/** 'ratings:progress' at most this often (plus the first and last report of a pass). */
const PROGRESS_INTERVAL_MS = 500
/** A progress line in the log every this many IGDB title searches (about every half minute). */
const PROGRESS_LOG_EVERY = 100
/** IGDB's external_game_source (formerly `category`) for Steam. */
const STEAM_SOURCE = 1
const SEARCH_LIMIT = 10
const MIN_SIMILARITY = 0.6
const MIN_SCORE = 0.8
/** Main game, remake, remaster, expanded game, port: preferred over DLC, bundles and mods. */
const PRIMARY_GAME_TYPES = new Set([0, 8, 9, 10, 11])

const IGDB_FIELDS = 'id,rating,rating_count,game_type'

/** Steam's store API: a couple of requests a second is plenty (a library is a few dozen). */
export const steamReviewsLimiter = new RateLimiter(2, 2)

export type ReviewScoreRecord = NonNullable<GameMetadata['reviewScore']>

/** Steam's review summary of one app. `score` 0: Steam shows no score yet (too few reviews). */
export interface SteamReviewSummary {
  percent: number
  count: number
  score: number
  label?: string
}

/** An IGDB game as far as its rating goes. */
export interface IgdbRatedGame {
  id: number
  name?: string
  rating?: number
  rating_count?: number
  first_release_date?: number
  game_type?: number
  alternative_names?: { name?: string }[]
}

/** A row of IGDB's external_games endpoint: one store link of one game. */
export interface IgdbExternalLink {
  uid?: string
  game?: number
}

/** IGDB (or Twitch, for the token) refused the credentials: wrong or revoked client id / secret. */
function isAuthError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false
  return (
    err.status === 401 || err.status === 403 || /invalid client id or secret/i.test(err.message)
  )
}

/** IGDB could not read a query (HTTP 400 that is not about the credentials): asking again will not help. */
class BadQuery extends Error {}

function titleOf(game: Game): string {
  return game.user.titleOverride?.trim() || game.title
}

function yearOf(releaseDate: string | undefined): number | undefined {
  const m = releaseDate?.match(/^(\d{4})/)
  return m ? Number.parseInt(m[1], 10) : undefined
}

function yearOfUnix(seconds: number | undefined): number | undefined {
  return typeof seconds === 'number' && seconds > 0
    ? new Date(seconds * 1000).getUTCFullYear()
    : undefined
}

/** The IGDB id the metadata scrape matched, if any. */
function scrapedIgdbId(game: Game): number | undefined {
  const raw = game.metadata.sources?.igdb
  return raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined
}

/**
 * The Steam app of a game: its own (Steam games, store links), else the one the Steam tags or the install-size
 * lookup matched for another store's game.
 */
export function steamAppFor(game: Game): number | undefined {
  const own = artIdsOf(game).steamAppId
  if (own) return own
  const tags = game.metadata.steamTags?.appId
  if (typeof tags === 'number' && tags > 0) return tags
  const storage = game.metadata.storage
  if (
    storage?.how === 'steam-match' &&
    typeof storage.steamAppId === 'number' &&
    storage.steamAppId > 0
  )
    return storage.steamAppId
  return undefined
}

/**
 * What a game's score is looked up by: its Steam app and the IGDB game its metadata was matched to, else its title;
 * and whether IGDB could be asked. Stored with the score (`via`), so a game matched to another Steam app or IGDB
 * game, retitled, or missed while IGDB was not set up, is read again.
 */
export function ratingLookupKey(game: Game, igdbOn: boolean): string {
  const steam = steamAppFor(game)
  const scraped = scrapedIgdbId(game)
  const key =
    steam || scraped ? `steam:${steam ?? ''}|igdb:${scraped ?? ''}` : `title:${titleOf(game)}`
  return igdbOn ? key : `${key}|no-igdb`
}

/**
 * Whether a game's score should be read now: never read, read a month ago, or looked up by another key since. Games
 * still waiting in the metadata queue are read too (a refresh can keep most of a library waiting for hours); a scrape
 * that matches the game to IGDB changes its key, so it is read again by that match.
 */
export function ratingDue(game: Game, now: number, igdbOn: boolean): boolean {
  if (!titleOf(game)) return false
  const record = game.metadata.reviewScore
  if (!record) return true
  // A Steam score does not depend on IGDB: only an IGDB score or a miss is read again when IGDB is set up.
  if (record.via !== ratingLookupKey(game, record.source === 'steam' || igdbOn)) return true
  const at = Date.parse(record.missedAt ?? record.updatedAt ?? '')
  return !Number.isFinite(at) || now - at >= RATING_REFRESH_MS
}

/** The record of a Steam score. */
export function steamScoreRecord(
  appId: number,
  summary: SteamReviewSummary,
  nowIso: string,
  via: string
): ReviewScoreRecord {
  return {
    source: 'steam',
    score: Math.max(0, Math.min(100, Math.round(summary.percent))),
    count: summary.count,
    ...(summary.label ? { label: summary.label } : {}),
    steamAppId: appId,
    via,
    updatedAt: nowIso
  }
}

/** The record of an IGDB rating, or a miss (no Steam score, and no IGDB game or rating either). */
export function igdbScoreRecord(
  game: IgdbRatedGame | null,
  nowIso: string,
  via: string,
  steamAppId?: number
): ReviewScoreRecord {
  const where = { ...(steamAppId ? { steamAppId } : {}), via }
  if (!game) return { ...where, missedAt: nowIso }
  const score =
    typeof game.rating === 'number' && Number.isFinite(game.rating) && game.rating > 0
      ? Math.min(100, Math.round(game.rating))
      : undefined
  const count = typeof game.rating_count === 'number' ? game.rating_count : undefined
  return score !== undefined && (count === undefined || count > 0)
    ? {
        source: 'igdb',
        score,
        ...(count !== undefined ? { count } : {}),
        igdbId: game.id,
        ...where,
        updatedAt: nowIso
      }
    : { igdbId: game.id, ...where, missedAt: nowIso }
}

/** The GetItems request for Steam apps' review summaries. */
export function steamItemsUrl(appIds: readonly number[]): string {
  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: { language: 'english', country_code: 'US' },
    data_request: { include_reviews: true }
  }
  return `${STEAM_ITEMS_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`
}

interface SteamSummaryField {
  review_count?: number
  percent_positive?: number
  review_score?: number
  review_score_label?: string
}

interface SteamItemsAnswer {
  response?: {
    store_items?: {
      appid?: number
      id?: number
      success?: number
      reviews?: {
        summary_filtered?: SteamSummaryField
        summary_language_specific?: SteamSummaryField
      }
    }[]
  }
}

/**
 * App id -> review summary, from a GetItems answer: the English reviews' (`summary_language_specific`, the request
 * asks in English), which is what the store page shows first to an English reader; all languages'
 * (`summary_filtered`) when Steam has no English summary. The two can differ a lot (a game review-bombed in one
 * language), and the store page is what players compare with.
 */
export function parseSteamItems(answer: SteamItemsAnswer): Map<number, SteamReviewSummary> {
  const out = new Map<number, SteamReviewSummary>()
  for (const item of answer?.response?.store_items ?? []) {
    const appId = item?.appid ?? item?.id
    const english = item?.reviews?.summary_language_specific
    const s = english && (english.review_count ?? 0) > 0 ? english : item?.reviews?.summary_filtered
    if (typeof appId !== 'number' || item.success !== 1 || !s) continue
    const count = s.review_count ?? 0
    const percent = s.percent_positive
    if (count <= 0 || typeof percent !== 'number' || !Number.isFinite(percent)) continue
    out.set(appId, {
      percent,
      count,
      score: s.review_score ?? 0,
      ...(s.review_score_label ? { label: s.review_score_label } : {})
    })
  }
  return out
}

/** Steam's review summaries of up to STEAM_REVIEWS_BATCH apps. */
async function fetchSteamReviews(
  appIds: readonly number[]
): Promise<Map<number, SteamReviewSummary>> {
  return parseSteamItems(
    await httpJson<SteamItemsAnswer>(steamItemsUrl(appIds), {}, { limiter: steamReviewsLimiter })
  )
}

/**
 * The game a Steam app stands for when IGDB links it to several (the main game and an edition or bundle): a main
 * game first, then one with a rating, then the most ratings.
 */
export function bestOfLinked(games: IgdbRatedGame[]): IgdbRatedGame | null {
  const rank = (g: IgdbRatedGame): number[] => [
    g.game_type === undefined || PRIMARY_GAME_TYPES.has(g.game_type) ? 0 : 1,
    typeof g.rating === 'number' && g.rating > 0 ? 0 : 1,
    -(g.rating_count ?? 0),
    g.id
  ]
  let best: IgdbRatedGame | null = null
  for (const game of games) {
    if (!game || typeof game.id !== 'number') continue
    if (!best) {
      best = game
      continue
    }
    const a = rank(game)
    const b = rank(best)
    const i = a.findIndex((v, k) => v !== b[k])
    if (i >= 0 && a[i]! < b[i]!) best = game
  }
  return best
}

/**
 * The search result that is the game: its name or an alternative name close to the title (editions ignored), the
 * release year within one (a store copy years later is likely a port, a small doubt; IGDB's game years later is
 * likely a remake, a large one), main games before DLC and bundles. Null when nothing is convincing.
 */
export function pickIgdbMatch(
  title: string,
  year: number | undefined,
  games: IgdbRatedGame[]
): IgdbRatedGame | null {
  const wanted = normalizeTitle(title)
  if (!wanted) return null
  const wantedBase = stripEdition(wanted)
  let best: { game: IgdbRatedGame; score: number } | null = null
  for (const game of games) {
    if (!game || typeof game.id !== 'number' || typeof game.name !== 'string') continue
    const names = [game.name, ...(game.alternative_names ?? []).map((a) => a?.name ?? '')]
      .map(normalizeTitle)
      .filter(Boolean)
    let similarity = 0
    for (const name of names) {
      similarity = Math.max(
        similarity,
        titleSimilarity(wanted, name),
        titleSimilarity(wantedBase, stripEdition(name)) - 0.01
      )
    }
    if (similarity < MIN_SIMILARITY) continue
    let score = similarity
    const igdbYear = yearOfUnix(game.first_release_date)
    if (year && igdbYear) {
      const gap = year - igdbYear
      score += Math.abs(gap) <= 1 ? 0.1 : gap > 1 ? -0.05 : -0.15
    }
    if (game.game_type !== undefined && !PRIMARY_GAME_TYPES.has(game.game_type)) score -= 0.05
    if (score >= MIN_SCORE - 1e-9 && (!best || score > best.score)) best = { game, score }
  }
  return best?.game ?? null
}

/** The Apicalypse query for IGDB games by id. */
export function byIdQuery(ids: readonly number[]): string {
  return `fields ${IGDB_FIELDS}; where id = (${ids.join(',')}); limit 500;`
}

/**
 * The Apicalypse query for the Steam links of Steam app ids (IGDB's external_games endpoint: one row per link, so
 * the uid and the store are checked on the same link).
 */
export function steamLinksQuery(appIds: readonly number[]): string {
  const uids = appIds.map((id) => `"${id}"`).join(',')
  return `fields uid,game; where uid = (${uids}) & external_game_source = ${STEAM_SOURCE}; limit 500;`
}

/** Steam app id -> the IGDB games linked to it, from a steamLinksQuery answer. */
export function linksByApp(rows: IgdbExternalLink[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const row of rows) {
    const appId = Number.parseInt(row?.uid ?? '', 10)
    const game = row?.game
    if (!Number.isInteger(appId) || appId <= 0 || typeof game !== 'number') continue
    const list = out.get(appId) ?? []
    if (!list.includes(game)) list.push(game)
    out.set(appId, list)
  }
  return out
}

export interface ReviewScoresDeps {
  library: {
    games(): Game[]
    getGame(id: string): Game | undefined
    applyMetadata(
      id: string,
      update: { metadata?: Partial<GameMetadata> },
      options?: { overwrite?: boolean; quiet?: boolean }
    ): unknown
  }
  settings: { get(): Settings }
  log: Logger
  /** The pass's progress, for the bottom bar ('ratings:progress'); total 0 when no pass runs. */
  onProgress?: (progress: RatingsProgress) => void
  /** Tests. */
  steamReviews?: (appIds: readonly number[]) => Promise<Map<number, SteamReviewSummary>>
  query?: <T>(settings: Settings, endpoint: string, body: string) => Promise<T>
  isConfigured?: (settings: Settings) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface ReviewScoresService {
  /** Read the score of every game that is due; a call while a pass runs makes it look again when it ends. */
  kick(): void
  /** Resolves once no pass is running (tests). */
  idle(): Promise<void>
  dispose(): void
}

/** The IGDB credentials as one string: a change means a new pass (and lifts a refusal). */
export function igdbCredentialsKey(settings: Settings): string {
  const { clientId, clientSecret } = settings.scrapers.igdb
  return `${clientId?.trim() ?? ''}\n${clientSecret?.trim() ?? ''}`
}

class Stop extends Error {}

/** Steam's store API kept failing, or refused the request: the pass goes on with IGDB. */
class SteamDown extends Error {}

export function createReviewScores(deps: ReviewScoresDeps): ReviewScoresService {
  const { library, settings, log } = deps
  const steamReviews = deps.steamReviews ?? fetchSteamReviews
  const query =
    deps.query ??
    (<T>(s: Settings, endpoint: string, body: string) => igdbScraper.query<T>(s, endpoint, body))
  const isConfigured = deps.isConfigured ?? ((s: Settings) => igdbScraper.isConfigured(s))
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let running: Promise<void> | null = null
  let again = false
  let disposed = false
  /** The credentials IGDB refused: IGDB is not asked until they change. */
  let refused: string | null = null
  /** The (incomplete) credentials the "IGDB backup is off" line was logged for. */
  let notedUnconfigured: string | null = null

  async function pass(): Promise<void> {
    if (disposed) return
    const current = settings.get()
    const key = igdbCredentialsKey(current)
    const igdbOn = isConfigured(current) && key !== refused
    if (!isConfigured(current) && key !== notedUnconfigured) {
      // Said once per credential state: games without a Steam score get none until IGDB is set up.
      notedUnconfigured = key
      log.info(
        'IGDB review scores (the backup for games without a Steam score) are off: Settings > Metadata > IGDB needs both the client ID and the client secret'
      )
    }
    // Installed games first: those are the ones being looked at.
    const due = library
      .games()
      .filter((g) => ratingDue(g, now(), igdbOn))
      .sort((a, b) => Number(b.installed) - Number(a.installed))
    if (!due.length) return
    log.info(`reading the review score of ${due.length} game(s)`)
    let fromSteam = 0
    let fromIgdb = 0
    let failedInRow = 0
    let pauses = 0

    /** What the bottom bar shows: games looked at of the pass's total, and the one being searched for. */
    const progress: RatingsProgress = { done: 0, total: due.length, stage: 'steam' }
    let lastReport = 0
    function report(force = false): void {
      const at = Date.now()
      if (!force && at - lastReport < PROGRESS_INTERVAL_MS) return
      lastReport = at
      deps.onProgress?.(
        progress.total > 0
          ? {
              done: Math.min(progress.done, progress.total),
              total: progress.total,
              stage: progress.stage,
              ...(progress.paused ? { paused: true } : {}),
              ...(progress.current ? { current: progress.current } : {})
            }
          : { done: 0, total: 0, stage: 'steam' }
      )
    }
    report(true)

    /** Whether IGDB may still be asked this pass (credentials unchanged and not refused). */
    const igdbStill = (): boolean => {
      const s = settings.get()
      return igdbOn && isConfigured(s) && igdbCredentialsKey(s) === key && refused !== key
    }

    /** A failure that is not about the credentials or the query: pauses after three in a row, Stop after two pauses. */
    async function failed(err: unknown, what: string): Promise<void> {
      log.debug(`${what} failed: ${describeError(err)}`)
      if (++failedInRow < FAILURES_BEFORE_PAUSE) return
      failedInRow = 0
      if (++pauses > 2) {
        log.info(`${what} is still not answering; scores are read again at the next library change`)
        throw new Stop()
      }
      log.info(
        `${what} is not answering; scores are read again in ${PAUSE_AFTER_FAILURES_MS / 60_000} min`
      )
      progress.paused = true
      report(true)
      try {
        await sleep(PAUSE_AFTER_FAILURES_MS)
      } finally {
        progress.paused = false
        report(true)
      }
    }

    /**
     * One Steam GetItems request; retried after pauses while Steam does not answer. Throws SteamDown when Steam keeps
     * failing or refuses the request (an HTTP 4xx other than 429: asking again will not help), Stop when disposed.
     */
    async function askSteam(appIds: readonly number[]): Promise<Map<number, SteamReviewSummary>> {
      for (;;) {
        if (disposed) throw new Stop()
        try {
          const out = await steamReviews(appIds)
          failedInRow = 0
          return out
        } catch (err) {
          if (
            err instanceof HttpError &&
            err.status >= 400 &&
            err.status < 500 &&
            err.status !== 429
          )
            throw new SteamDown(describeError(err))
          try {
            await failed(err, 'Steam')
          } catch (stop) {
            if (stop instanceof Stop && !disposed) throw new SteamDown(describeError(err))
            throw stop
          }
        }
      }
    }

    /** One IGDB query; retried after pauses while IGDB does not answer. Throws Stop to end the pass. */
    async function ask<T>(endpoint: string, body: string): Promise<T> {
      for (;;) {
        if (disposed || !igdbStill()) throw new Stop()
        try {
          const out = await query<T>(settings.get(), endpoint, body)
          failedInRow = 0
          return out
        } catch (err) {
          if (isAuthError(err)) {
            refused = key
            log.warn('IGDB refused the credentials; IGDB review scores wait for new ones')
            throw new Stop()
          }
          if (err instanceof HttpError && err.status === 400) throw new BadQuery(describeError(err))
          await failed(err, 'IGDB')
        }
      }
    }

    /** Each due game's lookup key when the pass sorted it (without the IGDB part): what its answer was looked up by. */
    const lookedUpBy = new Map(due.map((g) => [g.id, ratingLookupKey(g, true)]))

    /**
     * Store a record, unless the game changed key while this pass ran (it stays due, read by its new key). A Steam
     * score is keyed without the IGDB part, an IGDB score or a miss with it.
     */
    function write(gameId: string, steam: boolean, make: (via: string) => ReviewScoreRecord): void {
      const currentGame = library.getGame(gameId)
      if (!currentGame) return
      const base = lookedUpBy.get(gameId)
      if (base === undefined || base !== ratingLookupKey(currentGame, true)) return
      const record = make(steam ? base : ratingLookupKey(currentGame, igdbOn))
      library.applyMetadata(
        gameId,
        { metadata: { reviewScore: record } },
        { overwrite: true, quiet: record.score === undefined }
      )
      if (record.source === 'steam') fromSteam++
      else if (record.source === 'igdb') fromIgdb++
    }

    const nowIso = (): string => new Date(now()).toISOString()

    /** IGDB games by id, any number (400 per query). */
    async function gamesById(ids: readonly number[]): Promise<Map<number, IgdbRatedGame>> {
      const out = new Map<number, IgdbRatedGame>()
      for (let i = 0; i < ids.length; i += IGDB_RATINGS_BATCH) {
        const rows = await ask<IgdbRatedGame[]>(
          'games',
          byIdQuery(ids.slice(i, i + IGDB_RATINGS_BATCH))
        )
        for (const row of rows) if (typeof row?.id === 'number') out.set(row.id, row)
      }
      return out
    }

    /**
     * The IGDB games linked to Steam apps. An answer that fills the 500-row limit may have left links out (an app
     * linked to several games): the batch is split and asked again.
     */
    async function steamLinks(appIds: readonly number[]): Promise<Map<number, number[]>> {
      const rows = await ask<IgdbExternalLink[]>('external_games', steamLinksQuery(appIds))
      if (rows.length < 500 || appIds.length < 2) return linksByApp(rows)
      const half = Math.ceil(appIds.length / 2)
      const out = await steamLinks(appIds.slice(0, half))
      for (const [app, games] of await steamLinks(appIds.slice(half))) out.set(app, games)
      return out
    }

    // Games without a Steam score, for IGDB, in `due` order (installed first).
    const forIgdb: string[] = []
    try {
      // 1. Steam, 100 apps a request.
      const bySteam = new Map<number, string[]>()
      for (const game of due) {
        const app = steamAppFor(game)
        if (app) bySteam.set(app, [...(bySteam.get(app) ?? []), game.id])
      }
      const apps = [...bySteam.keys()]
      const steamScored = new Set<string>()
      /** Apps Steam answered for (all of them unless Steam went down part way). */
      const steamAsked = new Set<number>()
      let steamDown = false
      try {
        for (let i = 0; i < apps.length; i += STEAM_REVIEWS_BATCH) {
          const batch = apps.slice(i, i + STEAM_REVIEWS_BATCH)
          const summaries = await askSteam(batch)
          for (const app of batch) {
            steamAsked.add(app)
            const summary = summaries.get(app)
            // Steam shows a score from about ten reviews; with fewer, IGDB's may say more.
            if (!summary || summary.score <= 0) continue
            for (const gameId of bySteam.get(app) ?? []) {
              write(gameId, true, (via) => steamScoreRecord(app, summary, nowIso(), via))
              steamScored.add(gameId)
              progress.done++
            }
          }
          report()
        }
      } catch (err) {
        if (!(err instanceof SteamDown)) throw err
        // The games Steam was not asked about stay due (read from Steam next time); the rest go on to IGDB.
        steamDown = true
        failedInRow = 0
        pauses = 0
        log.warn(
          `Steam's review scores are not answering (${err.message}); IGDB carries on for the games Steam cannot help`
        )
      }
      for (const game of due) {
        if (steamScored.has(game.id)) continue
        const app = steamAppFor(game)
        if (steamDown && app && !steamAsked.has(app)) continue
        forIgdb.push(game.id)
      }
      // Games left for Steam next time count as looked at; the IGDB phase counts the rest as it goes.
      progress.done = due.length - forIgdb.length
      log.info(
        `review scores: ${fromSteam} of ${due.length} game(s) from Steam (${steamAsked.size} Steam app(s) in ` +
          `${Math.ceil(steamAsked.size / STEAM_REVIEWS_BATCH)} request(s)); ${forIgdb.length} for IGDB`
      )

      // 2. IGDB for the rest, or a miss for each while IGDB is not set up.
      progress.stage = 'igdb'
      report(true)
      if (!igdbOn) {
        for (const gameId of forIgdb) {
          const g = library.getGame(gameId)
          write(gameId, false, (via) =>
            igdbScoreRecord(null, nowIso(), via, g ? steamAppFor(g) : undefined)
          )
        }
        progress.done = due.length
      } else {
        await igdbPass()
      }
    } catch (err) {
      if (err instanceof BadQuery) {
        log.warn(`IGDB could not read a rating query: ${err.message}`)
        return
      }
      if (!(err instanceof Stop)) throw err
      log.info(
        `review scores stopped after ${progress.done} of ${due.length} game(s) (${fromSteam} from Steam, ${fromIgdb} from IGDB)` +
          (disposed ? '' : '; the rest are read at the next library change or start')
      )
      return
    } finally {
      progress.total = 0
      report(true)
    }
    log.info(
      `review scores: ${fromSteam + fromIgdb} of ${due.length} game(s) have one now (${fromSteam} from Steam, ${fromIgdb} from IGDB)`
    )

    async function igdbPass(): Promise<void> {
      // The IGDB game of each: by the Steam app (batched), the scrape's IGDB id (batched), else a title search.
      const refs = new Map<string, IgdbRatedGame | null>()
      const byId = new Map<number, string[]>()
      const bySteamApp = new Map<number, string[]>()
      const bySearch = new Set<string>()
      const add = (map: Map<number, string[]>, id: number, gameId: string): void => {
        map.set(id, [...(map.get(id) ?? []), gameId])
      }
      for (const gameId of forIgdb) {
        const game = library.getGame(gameId)
        if (!game) continue
        const record = game.metadata.reviewScore
        const app = steamAppFor(game)
        const scraped = scrapedIgdbId(game)
        if (record?.igdbId && record.via === lookedUpBy.get(gameId))
          add(byId, record.igdbId, gameId)
        else if (app) add(bySteamApp, app, gameId)
        else if (scraped) add(byId, scraped, gameId)
        else bySearch.add(gameId)
      }
      const steamIds = [...bySteamApp.keys()]
      for (let i = 0; i < steamIds.length; i += IGDB_RATINGS_BATCH) {
        const batch = steamIds.slice(i, i + IGDB_RATINGS_BATCH)
        const links = await steamLinks(batch)
        const games = await gamesById([...new Set([...links.values()].flat())])
        for (const appId of batch) {
          const match = bestOfLinked(
            (links.get(appId) ?? [])
              .map((id) => games.get(id))
              .filter((g): g is IgdbRatedGame => !!g)
          )
          for (const gameId of bySteamApp.get(appId) ?? []) {
            if (match) refs.set(gameId, match)
            else {
              // IGDB does not link this Steam app: the scrape's IGDB id, else a title search.
              const game = library.getGame(gameId)
              const scraped = game ? scrapedIgdbId(game) : undefined
              if (scraped) add(byId, scraped, gameId)
              else bySearch.add(gameId)
            }
          }
        }
      }
      const ids = [...byId.keys()]
      const found = await gamesById(ids)
      for (const id of ids) {
        for (const gameId of byId.get(id) ?? []) {
          const match = found.get(id)
          // An id IGDB no longer has is searched by title instead.
          if (match) refs.set(gameId, match)
          else bySearch.add(gameId)
        }
      }
      log.info(
        `review scores: IGDB found ${refs.size} game(s) by Steam app or IGDB id, ${bySearch.size} to search by title`
      )

      let searched = 0
      for (const gameId of forIgdb) {
        const game = library.getGame(gameId)
        if (game) {
          const app = steamAppFor(game)
          if (refs.has(gameId)) {
            const match = refs.get(gameId) ?? null
            write(gameId, false, (via) => igdbScoreRecord(match, nowIso(), via, app))
          } else if (bySearch.has(gameId)) {
            progress.current = titleOf(game)
            report()
            const match = await search(game)
            write(gameId, false, (via) => igdbScoreRecord(match, nowIso(), via, app))
            if (++searched % PROGRESS_LOG_EVERY === 0)
              log.info(
                `review scores: ${searched} of ${bySearch.size} IGDB title search(es) done, ${fromIgdb} from IGDB so far`
              )
          }
        }
        progress.done++
      }
      progress.current = undefined
    }

    /** A title search on IGDB, one request; the convincing match, if any. */
    async function search(game: Game): Promise<IgdbRatedGame | null> {
      const title = titleOf(game)
      const term = apicalypseString(title)
      if (!term) return null
      const platformId = platformIdFor('igdb', platformKeyForGame(game))
      const where = platformId ? ` where platforms = (${platformId});` : ''
      let rows: IgdbRatedGame[]
      try {
        rows = await ask<IgdbRatedGame[]>(
          'games',
          `fields ${IGDB_FIELDS},name,first_release_date,alternative_names.name; search "${term}";${where} limit ${SEARCH_LIMIT};`
        )
      } catch (err) {
        // A title IGDB cannot search for: recorded as not found (asked again in a month), the rest carry on.
        if (!(err instanceof BadQuery)) throw err
        log.debug(`IGDB could not search for "${title}": ${err.message}`)
        rows = []
      }
      return pickIgdbMatch(title, yearOf(game.metadata.releaseDate), rows)
    }
  }

  function start(): void {
    running = (async () => {
      do {
        again = false
        try {
          await pass()
        } catch (err) {
          log.error('review scores pass failed', err)
        }
      } while (again && !disposed)
      running = null
    })()
  }

  return {
    kick() {
      if (disposed) return
      if (running) {
        again = true
        return
      }
      start()
    },
    async idle() {
      while (running) await running
    },
    dispose() {
      disposed = true
    }
  }
}
