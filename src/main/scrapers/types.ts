import type {
  ArtKind,
  Game,
  GameMetadata,
  MediaKind,
  MetadataCandidate,
  ScraperId,
  Settings
} from '../../shared/types'
import type { EventBus } from '../events'
import type { GameDatabaseLookup } from '../game-database/service'
import type { Logger } from '../logger'
import type { LibraryService } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import type { Gate, RateLimiter } from './http'

/**
 * Throttling a scraper's media URLs must go through when they are served by the API itself (ScreenScraper's
 * mediaJeu.php counts against the account's thread limit and request rate). CDN-hosted media needs none.
 */
export interface MediaPolicy {
  gate?: Gate
  limiter?: RateLimiter
  /**
   * Attempts after the first for 429 / 5xx and network errors (default 3, ScreenScraper's thread limit). The cover
   * lane's direct URLs pass 0: a miss is a miss, the full lane's `artPriority` chain is the retry.
   */
  retries?: number
  /** Per-attempt timeout (default 45 s for API-hosted media; the cover lane's CDN downloads use a short one). */
  timeoutMs?: number
  /**
   * Told about a failure that says nothing about the URL itself (DNS, reset, timeout, 403, 429, 5xx) so the caller
   * can budget the host and not record the URL as missing. A 400, 404 or 410 is an answer about the URL: not told.
   * `status` is unset for a failure without an HTTP answer.
   */
  onNetworkError?(url: string, status?: number): void
  /** Only an image answer is saved; anything else (an HTML error page) counts as a network failure. */
  imageOnly?: boolean
}

/** Remote media URLs a scraper found for a game. */
export interface ScrapedMedia {
  cover?: string
  hero?: string
  logo?: string
  icon?: string
  screenshots?: string[]
  video?: string
}

export interface ScrapedResult {
  title?: string
  metadata: Partial<GameMetadata>
  media: ScrapedMedia
}

export interface Scraper {
  id: ScraperId
  isConfigured(settings: Settings): boolean
  /**
   * The source finds games by their own ids only (a Steam app id, a GOG product id): a free-text query is not how it
   * matches a game, so a title it did not find is never searched again under other names.
   */
  idOnly?: boolean
  /**
   * The names the source gives one of its games, by its id (the title first, then other names); null when the source
   * has no such game.
   */
  titleOf?(externalId: string, settings: Settings): Promise<string[] | null>
  /**
   * The release year of the source's game with this id (null when it has none, or no such game): the name-match
   * re-check tells a same-titled game of another year ("SSX" of 2000 for its 2012 reboot) by it.
   */
  yearOf?(externalId: string, settings: Settings): Promise<number | null>
  /**
   * The source's own game for this one by its store id (SteamGridDB's game for a Steam app id), or null when the source
   * has none for that id; undefined when the game has no such id. A recorded match equal to it was made by id, not by
   * name, and is not re-checked by title (a renamed game's id match is still right).
   */
  idMatchOf?(game: Game, settings: Settings): Promise<string | null | undefined>
  /**
   * The source's records with these ids (those it still has), each by its title as a search would give it (IGDB's
   * "... - Limited Edition" records, a version's title added). Asked in as few requests as the source allows: the
   * one-time re-check of ROM matches (`recheckConsoleMatches`) reads many.
   */
  recordsOf?(externalIds: string[], settings: Settings): Promise<Map<string, { title: string }>>
  /** Candidates for a game: by file hash (ScreenScraper) or by name + platform (others). */
  search(game: Game, settings: Settings, query?: string): Promise<MetadataCandidate[]>
  /**
   * Full metadata and media URLs for a chosen candidate. `kinds`, when given, names the art the caller still
   * needs: an art-only scraper (SteamGridDB) requests nothing else; the text scrapers ignore it.
   */
  fetch(
    game: Game,
    candidate: MetadataCandidate,
    settings: Settings,
    kinds?: ArtKind[]
  ): Promise<ScrapedResult>
  /**
   * The art kinds this scraper can supply at all (SteamGridDB: no screenshots). The full lane's art pass skips the
   * scraper for other kinds instead of searching for nothing; absent = any kind.
   */
  artKinds?: ArtKind[]
  /** Shared gate/limiter the image cache applies when downloading this scraper's media URLs. */
  mediaPolicy?: MediaPolicy
  /**
   * False while the source has paused itself (TheGamesDB after an HTTP 429: its allowance is used up): the chains
   * leave it out, and a request it refuses meanwhile is not a per-game error. Absent = always available.
   */
  available?(): boolean
}

export interface ImageCache {
  readonly dir: string
  /**
   * Download a remote image into the cache (retrying 429/5xx, through `policy` when the host is rate limited);
   * returns the media:// URL or null.
   */
  importRemote(
    gameId: string,
    kind: MediaKind,
    url: string,
    index?: number,
    policy?: MediaPolicy
  ): Promise<string | null>
  /**
   * Download the thumbnail of a Steam store screenshot (the game page's row) as `steam-thumb-<key>.<ext>`, `key`
   * naming the screenshot (not its place in the list); returns the media:// URL or null.
   */
  importSteamThumbnail(
    gameId: string,
    key: string,
    url: string,
    policy?: MediaPolicy
  ): Promise<string | null>
  /** Delete the game's saved Steam screenshot thumbnails whose key is not in `keep`. */
  pruneSteamThumbnails(gameId: string, keep: ReadonlySet<string>): Promise<void>
  /**
   * Move a game's media folder to another game id (a converted ROM): resolves to the map from each old media URL to
   * the moved file's. Nothing moves when the target folder exists already (URLs then stay as they were).
   */
  moveGame(fromId: string, toId: string): Promise<(url: string) => string>
  /** Copy a local file into the cache; returns the media:// URL or null. */
  importLocal(
    gameId: string,
    kind: MediaKind,
    filePath: string,
    index?: number
  ): Promise<string | null>
  /**
   * Copy a host's image of a game into the cache as `<kind>-host.<ext>` (screenshots `screenshot-<n>-host`): a name the
   * metadata lookups' `<kind>.<ext>` writes never delete, so a lookup landing at the same moment cannot leave either
   * URL pointing at a deleted file. Removing the kind (`remove`) removes it too.
   */
  importHostCopy(
    gameId: string,
    kind: MediaKind,
    filePath: string,
    index?: number
  ): Promise<string | null>
  /**
   * Copy the user's own art into the cache as `custom-<kind>.<ext>`: a name the scraped art (`<kind>.<ext>`) never
   * writes over, so a download that was in flight when the user chose a file cannot replace or delete it.
   */
  importCustom(
    gameId: string,
    kind: Exclude<MediaKind, 'screenshot'>,
    filePath: string
  ): Promise<string | null>
  /** Delete the scraped files of one kind (or the game's whole folder); custom copies only go with `custom`. */
  remove(gameId: string, kind?: MediaKind, options?: { custom?: boolean }): Promise<void>
  /** Map a media:// URL path ('/steam_620/cover.jpg') to an absolute file inside the cache, or null. */
  resolve(urlPath: string): string | null
}

// ---------------------------------------------------------------------------
// Art pipeline (ARCHITECTURE.md 4.6 "Art pipeline")
// ---------------------------------------------------------------------------

/**
 * Every id the art sources can key on, collected once per game by `art-ids.ts` from `Game.source` / `externalId`,
 * `Game.extra` and `metadata.sources`. A Steam appid may belong to a non-Steam game (matched by a scraper).
 */
export interface ArtIds {
  steamAppId?: number
  gogProductId?: string
  epicNamespace?: string
  epicCatalogItemId?: string
  epicAppName?: string
  eaOfferId?: string
  xboxStoreId?: string
  xboxTitleId?: string
  battlenetCode?: string
  ubisoftId?: string
  igdbId?: string
  steamGridDbId?: string
  /** ROMs: system id + the ROM's base name, for ES-DE / Playnite media folders. */
  romSystemId?: string
  romName?: string
  /** ROMs in a sub-folder of their system folder: that sub-path ("Favorites 1" for "ps2/Favorites 1/Game.iso"). */
  romRelDir?: string
}

/** Where a candidate came from; stored in `metadata.sources` as `art:<kind>` for the detail panel's attribution. */
export type ArtSourceId =
  | 'steam-cache'
  | 'galaxy-cache'
  | 'esde-media'
  | 'playnite-files'
  | 'steam-cdn'
  | 'gog-images'
  | 'epic-catalog'
  | 'xbox-catalog'
  | 'steamgriddb-platform'
  | 'igdb-external'
  | 'store-import'

/** One piece of art a source can supply: either an absolute file on this PC or a URL that needs no search. */
export interface ArtCandidate {
  kind: ArtKind
  source: ArtSourceId
  /** Absolute path of a file on disk (local sources). Exactly one of `path` / `url` is set. */
  path?: string
  /** Direct URL (direct sources); a 404 is cheap and means "try the next candidate". */
  url?: string
  width?: number
  height?: number
  /** Downloads of API-hosted candidates go through the owning scraper's policy; CDN candidates need none. */
  policy?: MediaPolicy
}

/** Result of one source for one game: a map of kinds, each with its candidates best first. */
export type ArtCandidates = Partial<Record<ArtKind, ArtCandidate[]>>

/**
 * A cache on this PC that already holds art for games the user owns, installed or not (Steam librarycache, GOG
 * Galaxy webcache, ES-DE downloaded_media, Playnite library files). Reads disk only, never the network.
 */
export interface LocalArtSource {
  id: ArtSourceId
  /** False when the client / folder is not on this PC; the registry then skips the source for the whole run. */
  isAvailable(settings: Settings): Promise<boolean>
  /**
   * Build the source's directory index once per run (one readdir / one index-file parse, no per-game stat); later
   * calls return the memo. `reset()` drops it so the next lookup re-reads the disk.
   */
  index(settings: Settings): Promise<void>
  reset(): void
  /**
   * Art for the game from the index: absolute paths that exist on disk, already sniffed and filtered by the kind's
   * quality rules (`image-sniff.ts` `acceptsKind`). Keyed by `ids`, never by title.
   */
  lookup(game: Game, ids: ArtIds, kinds: ArtKind[]): Promise<ArtCandidates>
}

/**
 * A source that turns ids into URLs without a search request (Steam CDN by appid, GOG image formatters, Epic
 * keyImages, Xbox display catalog, SteamGridDB platform lookups, IGDB external ids). `candidates` may make at most
 * one metadata request per batch (SteamGridDB / IGDB / Xbox) and none at all for CDN templates.
 */
export interface DirectArtSource {
  id: ArtSourceId
  isConfigured(settings: Settings): boolean
  /** Largest `games` batch one `candidates` call may take (1 for pure URL templates, 50 for SteamGridDB, 500 for IGDB). */
  batchSize: number
  /**
   * Whether the source has an id to key this game on. The lane skips the source (and its batch collector) when
   * this answers false, so a Steam game never idles in the Xbox collector; absent = ask the source.
   */
  hasIdFor?(ids: ArtIds): boolean
  /** Candidate URLs per game id, best first per kind; a game with no usable id is simply absent from the result. */
  candidates(
    games: { game: Game; ids: ArtIds }[],
    kinds: ArtKind[],
    settings: Settings
  ): Promise<Map<string, ArtCandidates>>
}

/** Art the caller already knows about (a provider's `localMedia` path, a store import's `coverUrl`): landed before any lookup. */
export interface ArtSeed {
  gameId: string
  kind: ArtKind
  /** Absolute file on this PC (`ScannedGame.localMedia`). Exactly one of `path` / `url` is set. */
  path?: string
  /** Remote URL (`MergeOwnedResult.remoteMedia`); Steam / GOG / Epic seeds get the 404 fallback chain of §4.6. */
  url?: string
}

export interface EnqueueOptions {
  /** Re-run both lanes for games already 'done' (Refresh, custom art cleared). */
  force?: boolean
  /**
   * Run a game whose last run found nothing ('failed') even if that was a moment ago: a request by the user.
   * Without it (a scan, an import) such a game waits out its retry delay; `force` implies it.
   */
  retryFailed?: boolean
  /** Consumed first by the cover lane, no lookup; a 'done' game named by a seed runs only the seed step. */
  seeds?: ArtSeed[]
  /** Cover lane only (autoScrape off): seeds + local caches, no direct URLs, no SteamGridDB, no full lane. */
  coverOnly?: boolean
  /** Touch no network at all (the --art-bench probe): seeds with a path and local caches only. */
  offline?: boolean
  /**
   * The user's "Refresh missing" (or a newly saved art key): a game already 'done' that lacks some art (cover, hero,
   * logo, icon) runs the cover lane and the art fill for the missing kinds only, over the art chain, the direct and
   * the local sources: no text, no HLTB, nothing it has is replaced, URLs recorded as missing are not asked again.
   * Its back-offs are ignored (not erased); a landed cover clears them.
   */
  missingArt?: boolean
}

export interface MetadataService {
  /**
   * Queue games for scraping (skips games already done unless force or a seed names them). Every accepted game
   * enters the cover lane first and the full lane behind it (ARCHITECTURE.md 4.6 "Art pipeline"). Returns how many
   * games were accepted now (a game already queued is not counted again).
   */
  enqueue(gameIds: string[], options?: EnqueueOptions): number
  search(gameId: string, query: string): Promise<MetadataCandidate[]>
  apply(gameId: string, candidate: MetadataCandidate): Promise<Game>
  /** Refresh live values (Steam current players); cheap and cached. Achievements: achievements-service.ts. */
  refreshLive(gameId: string): Promise<void>
  /**
   * The Library shows the Active Players sort: read SteamCharts' latest player count of every Steam game whose count
   * is older than six hours (active-players.ts). One run at a time; resolves when it is through.
   */
  refreshActivePlayers(): Promise<void>
  /**
   * The Library shows the H.L.T.B. sort: look up the HowLongToBeat times of the games without any (never looked up, or a
   * miss older than HLTB_MISS_RETRY_MS), not hosts' games, with HLTB on; paced by hltb.ts's limiter, stopping when HLTB
   * pauses. One run at a time (a call during a run gets that run); waits for the start-up pass (backfillHltb) first.
   */
  refreshHltbTimes(): Promise<void>
  /** The H.L.T.B. sort is no longer shown: its run stops after the lookup in progress (hltb-times.ts stop). */
  stopHltbTimes(): void
  /**
   * Look up again, one game at a time, the HowLongToBeat times found before PlayOut read HLTB's "Solo" times
   * (`hltb.combined` absent), so the H.L.T.B. filter places those games by the time HLTB shows. Once per run.
   */
  backfillHltb(): Promise<void>
  /**
   * Once per run, and in effect once per library: the ROM games matched before a ROM's console counted
   * (NAME_MATCH_RULES 5) whose recorded match is an edition's record, or whose SteamGridDB art is a same-titled game's
   * of another year, are scraped again (and those flagged on an earlier start whose run did not get through); the rest
   * are marked as checked. Does nothing with auto-scrape off.
   */
  recheckConsoleMatches(): Promise<void>
  dispose(): void
}

export interface MetadataDeps {
  settings: SettingsStore
  library: LibraryService
  imageCache: ImageCache
  events: EventBus
  resourcesDir: string
  log: Logger
  /**
   * The PlayOut database (main/game-database): looked up before the text scrapers when Settings › Metadata › "Use the
   * PlayOut database" is on, and told about games it lacked once they are scraped. Absent in most tests.
   */
  gameDatabase?: GameDatabaseLookup
}
