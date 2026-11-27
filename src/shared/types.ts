// PlayOut — domain types shared by the main process, the preload script and the renderer.
// This file is the contract between every module. Keep it dependency-free (no imports).

// ---------------------------------------------------------------------------
// Sources and platforms
// ---------------------------------------------------------------------------

/** Where a game record comes from. Stores scan their own client's install data; 'rom' is the ROM folder scanner; 'manual' is a user-added executable. */
export type SourceId =
  'steam' | 'epic' | 'gog' | 'ea' | 'battlenet' | 'ubisoft' | 'xbox' | 'manual' | 'rom'

export const STORE_SOURCES: readonly SourceId[] = [
  'steam',
  'epic',
  'gog',
  'ea',
  'battlenet',
  'ubisoft',
  'xbox'
] as const

/** The sources that are digital store fronts: they have a client, may have an account and an install URI. */
export type StoreSourceId = Exclude<SourceId, 'manual' | 'rom'>

/**
 * A platform is a row in the library UI: one per store, one for plain PC games ('pc'), and one per emulated system
 * (ids follow ES-DE folder names: 'snes', 'psx', 'n64', ...).
 */
/**
 * A Library sort order (renderer lib/libraryView.ts LIBRARY_SORT_OPTIONS). The old 'playable' (Playable First) order
 * is gone: a tab saved with it loads as 'recent' with `playableFirst` on (LibraryTabDef), the same order
 * (a reversed one loads unreversed).
 */
export type LibrarySortId =
  | 'title-asc'
  | 'recent'
  | 'most-played'
  | 'players'
  | 'reviews'
  | 'added'
  | 'release'
  | 'size'
  | 'difficulty'
  | 'hltb'

/**
 * A Library tab's filters (the Filters menu): each list a set of choices, a game matching any one of a list shows,
 * different lists narrow together. Empty everywhere = All Games.
 */
export interface LibraryTabFilters {
  /** Filters > Platform: platform ids (consoles and other systems; stores are `stores`). */
  platforms: string[]
  /** Filters > Platform, below the line: store source ids. */
  stores: string[]
  genres: string[]
  /** Filters > Release: RELEASE_ERAS ids. */
  eras: string[]
  /** Filters > Tags: TAG_FILTERS ids. */
  tags: string[]
  /** Filters > Size: SIZE_BUCKETS ids. */
  sizes: string[]
  /** Filters > H.L.T.B.: HLTB_BUCKETS ids. */
  hltb: string[]
  /**
   * Filters > Difficulty: DifficultyLevel ids (shared/difficulty.ts). Optional and left out of a saved tab while empty,
   * like `developers`: a tab without it stays what an older PlayOut (a paired PC syncing tabs) accepts. Absent reads
   * as [].
   */
  difficulty?: string[]
  /**
   * Filters > Reviews: review score bands (renderer lib/reviews.ts REVIEW_BANDS ids: 'r95' ... 'r0'). Optional and
   * left out of a saved tab while empty, like `difficulty`. Absent reads as [].
   */
  reviews?: string[]
  /** Filters > Controls: CONTROLS_FILTERS ids (renderer lib/controls.ts: vr, controller, keyboard). */
  controls: string[]
  /**
   * Filters > Local Multiplayer: 'local-all' (Steam's local multiplayer tags and every Nucleus Co-Op game) and player
   * counts ('2', '3-4', '5+'; older '2-4' / '4+' are read as '3-4' / '5+'); its Nucleus Co-Op choice is `coop`. Renderer lib/localMultiplayer.ts.
   */
  players: string[]
  /** Filters > Online Multiplayer: 'pvp' (All Competitive), 'coop', 'online-all', 'esports', 'mmo', 'versus', 'team' (Steam tags; renderer lib/onlineMultiplayer.ts). */
  online: string[]
  hidden: boolean
  favorites: boolean
  /** Filters > Nucleus Co-Op: only games with a Co-Op handler (Game.metadata.coop). */
  coop: boolean
  /** Filters > Recompilations: only games with a recompilation available (Game.metadata.recomp). */
  recomp: boolean
  /**
   * Only games by any of these developers (Game.metadata.developers), case-insensitive; empty = any. Added and removed
   * by the developer button on a game page; removed in Filters > Clear filters. Tabs saved before 0.9.42 had one
   * `developer` name: it loads as a list of one (settings-schema.ts, renderer lib/libraryTabs.ts tabFiltersOf).
   * Optional, and left out of a saved tab while empty: a tab without a developer / publisher filter is then exactly
   * what an older PlayOut (a paired PC syncing tabs) accepts. Absent reads as [].
   */
  developers?: string[]
  /** Only games by any of these publishers (Game.metadata.publishers), as `developers`: the publisher button. */
  publishers?: string[]
}

/** What Home's row of games shows (settings.ui.homeRow). */
export const HOME_ROW_MODES = ['recent', 'added', 'favorites', 'played'] as const
export type HomeRowMode = (typeof HOME_ROW_MODES)[number]

/**
 * Where a Library tab's grid was scrolled: the game at the start of the top visible row, and how far (px) the view
 * was past that row's top. Kept as a game rather than pixels, so it still lands right after the window was resized
 * (other columns) or games were added above.
 */
export interface LibraryScrollPosition {
  gameId: string
  offset: number
}

/** One Library tab: its filters and sort. Its name comes from its filters (renderer lib/libraryTabs.ts tabName). */
export interface LibraryTabDef {
  id: string
  filters: LibraryTabFilters
  sort: LibrarySortId
  sortReversed: boolean
  /**
   * The Library's playable-first button: games installed on this PC before the rest, each part in `sort`'s own order
   * (filters still decide which games show). On for new tabs and for tabs saved before it existed.
   */
  playableFirst: boolean
  /** The tab's search text (absent = none). */
  query?: string
}

export interface Platform {
  id: string
  name: string
  shortName?: string
  kind: 'store' | 'pc' | 'system'
  /** simple-icons slug (stores, manufacturers) or lucide icon name, used by <PlatformBadge>. */
  icon: string
  sortOrder: number
  manufacturer?: string
  releaseYear?: number
}

// ---------------------------------------------------------------------------
// Launch and tracking
// ---------------------------------------------------------------------------

export type LaunchSpec =
  /** Open a protocol URI with the shell (steam://rungameid/620, com.epicgames.launcher://apps/...). */
  | { kind: 'uri'; uri: string }
  /** Spawn an executable directly. */
  | { kind: 'exec'; file: string; args: string[]; cwd?: string }
  /** Launch a ROM through an emulator; the command is resolved at launch time from the system definition and settings. */
  | { kind: 'emulator'; systemId: string; romPath: string; emulatorId?: string }
  /** Launch a packaged (UWP / Microsoft Store) app by its application user model id. */
  | { kind: 'uwp'; aumid: string }

/** How the session tracker decides that the game is running after launch. */
export type TrackingSpec =
  /** Any process whose executable lives under installDir counts as the game (Playnite's default for store games). */
  | { mode: 'installDir'; installDir: string }
  /** The game is running while any process with one of these names (without .exe, case-insensitive) exists. */
  | { mode: 'process'; processNames: string[] }
  /** The spawned process itself is the game; the session ends when it exits (emulators, plain exes). */
  | { mode: 'spawned' }
  /** A packaged app: tracked by package family name. */
  | { mode: 'uwp'; packageFamilyName: string }
  /** Cannot be tracked; session is recorded as a launch only. */
  | { mode: 'none' }

export interface LaunchResult {
  ok: boolean
  /** Set when ok is false. */
  error?: LaunchError
  startedAt?: string
}

export interface LaunchError {
  kind: 'emulator-missing' | 'core-missing' | 'client-missing' | 'file-missing' | 'failed'
  message: string
  /** For emulator-missing / core-missing: which emulator or core could not be found. */
  emulatorId?: string
  coreFile?: string
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

/** One screenshot of a Steam store page: the store's thumbnail (about 600 px wide) and full-size image. */
export interface SteamScreenshot {
  thumbnail: string
  full: string
  /** The thumbnail saved on this PC (media:// URL), once the background pass has downloaded it. */
  local?: string
  /**
   * Not downloaded again until the list is refreshed: Steam's CDN answered that the thumbnail does not exist, or it
   * failed three passes in a row.
   */
  missing?: boolean
  /** Passes in which the thumbnail failed to download (network, 5xx, 403); the third marks it `missing`. */
  failures?: number
}

/**
 * The background download of Steam games' store screenshots (scrapers/steam-screenshots.ts): `done` of `total` games,
 * `current` the one being downloaded. total 0 = no pass runs.
 */
export interface ScreenshotsProgress {
  done: number
  total: number
  current?: string
}

export interface GameMetadata {
  description?: string
  shortDescription?: string
  /** 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY'. */
  releaseDate?: string
  developers?: string[]
  publishers?: string[]
  genres?: string[]
  tags?: string[]
  /** 0-100. */
  rating?: number
  /** Free text such as '1-2'. */
  players?: string
  /**
   * HowLongToBeat hours. `solo`: HLTB's "Solo" time, for a game HLTB shows that way (`combined`: its play styles
   * combined, no Main Story box) or one without a Main Story time. `combined` absent: looked up before PlayOut read
   * Solo times (looked up again once).
   */
  /**
   * The version of the name-match rules (scrapers/candidate-match.ts) the game's name-searched sources were matched or
   * re-checked with; below the current one, the background re-check (metadata-service.ts) looks at the game again.
   */
  nameMatchRules?: number
  /**
   * The sources already re-checked under `rules` while another did not answer (refused credentials, an outage): only
   * the rest are asked next run. Read only while `nameMatchRules` is below `rules` (every source answered then).
   */
  nameMatchChecked?: { rules: number; sources: string[] }
  /**
   * The source ('igdb', 'steamgriddb') whose recorded match the one-time re-check found to be another game
   * (metadata-service.ts `recheckConsoleMatches`): the game's next scrape is forced, replacing that match's text and
   * art, and the mark goes once a forced run in which that source answered is through. Kept in the library file so a
   * quit before that run does not lose it. About this PC's matching: not shared with a streaming client.
   */
  rematch?: string
  /**
   * The forced run of a game carrying `rematch` did not get through (a source failed, an image did not download): when,
   * and how many such runs in a row. The next one waits (metadata-service.ts `rematchHeld`); removed with the mark.
   */
  rematchTried?: { at: string; count: number }
  /**
   * The scrapers found nothing for the game (`metadataStatus` 'failed'): when, and how many runs in a row. An
   * automatic enqueue (scan, import) leaves the game alone for a while after it (metadata-service.ts
   * `failedRecently`); removed by a run that finds something. `errors`: the last runs (that many in a row) had a
   * scraper that did not answer, which is not counted as a miss and only holds the game back briefly.
   */
  scrapeMissed?: { at: string; count: number; errors?: number }
  /**
   * A metadata run ended without a cover (no scraped cover, no custom one), whatever the status: when, and how many
   * such runs in a row. Automatic enqueues look for the missing art again only after `failedRetryDelayMs(count)`
   * (metadata-service.ts `coverMissingRecently`); Settings › Metadata › "Refresh missing" and a newly saved art key
   * look at once. Removed when a cover lands.
   */
  coverMissing?: { at: string; count: number }
  hltb?: {
    main?: number
    extra?: number
    completionist?: number
    solo?: number
    combined?: boolean
    /** Looked up and HLTB has no match (no times above): asked again after a month. */
    missedAt?: string /** The matching rules it was found or recorded by (metadata-service.ts HLTB_MATCH_RULES; absent = 1). */
    rules?: number
    updatedAt?: string
  }
  /**
   * How many players the game takes, from the LaunchBox Games Database (launchbox-players.ts): `max` = its
   * MaxPlayers, `coop` = cooperative play, `launchboxId` = the LaunchBox entry. `max` absent with `missedAt`: no
   * LaunchBox entry with a count (a game that had one and lost its match).
   */
  localPlayers?: {
    max?: number
    coop?: boolean
    launchboxId?: number
    updatedAt?: string
    missedAt?: string
  }
  /**
   * The game's genres from the LaunchBox Games Database (launchbox-players.ts), for ROM games only: shown instead
   * of `genres` (shared/genres.ts gameGenres), which the scrapers keep filling as the fallback
   * for a game LaunchBox has no genres for or while LaunchBox cannot be reached. `genres` absent with `missedAt`: no
   * LaunchBox entry with genres.
   */
  launchboxGenres?: {
    genres?: string[]
    launchboxId?: number
    updatedAt?: string
    missedAt?: string
  }
  /**
   * A Nucleus Co-op handler for the game (coop/coop-service.ts): split-screen with several instances of the game.
   * `archive` is the handler package (`handler-<hubId>-v<version>.nc`); `matchedBy` says how it was found.
   */
  coop?: CoopGameInfo
  /**
   * Recompilations of the game (main/recomp): native PC ports listed by decomp-buddy / RecompLauncher, matched by
   * system + normalized title (PC games: by title). Present = the game page shows the UP button. `installed`: the
   * installed entry ids; `preferred`: the user's chosen version (shared/recomp.ts).
   */
  recomp?: GameRecompInfo
  /**
   * The game's review score (review-scores.ts): Steam's user reviews (`source` 'steam': `score` = percent positive,
   * `count` = reviews, `label` = Steam's wording, "Very Positive"), else IGDB's user rating (`source` 'igdb':
   * `score` 0-100, `count` = ratings; needs the IGDB credentials of Settings > Metadata). `steamAppId` /
   * `igdbId`: where it is from. `score` absent with `missedAt`: neither has one; asked again after a month. Kept
   * apart from `rating`, which the text scrapers own (Metacritic, critic scores).
   */
  reviewScore?: {
    source?: 'steam' | 'igdb'
    score?: number
    count?: number
    label?: string
    steamAppId?: number
    igdbId?: number
    /** What it was looked up by (Steam app and IGDB match, else title): when that changes, it is read again. */
    via?: string
    updatedAt?: string
    missedAt?: string
  }
  /**
   * Steam's user tags ("Roguelike", "Souls-like"), strongest first (up to 20). `appId`: the Steam app they are
   * from; `title`: the title a Steam search was made by (another store's game with no Steam app on record).
   * `tags` empty with `missedAt`: no Steam app or no tags; asked again after a month. Kept apart from `tags`,
   * which the text scrapers own.
   */
  steamTags?: {
    tags: string[]
    appId?: number
    title?: string
    updatedAt?: string
    missedAt?: string
    /**
     * How the Steam app is played, from the same Steam answer: `controller` full / partial controller support (Steam's
     * controller categories 28 / 18), `vr` 'only' (needs a headset) or 'supported'. Absent: not read yet (records
     * from before 0.1.127 are read again once). The game page's controls badge: none of them = keyboard and mouse.
     */
    controls?: SteamControls
    /**
     * Steam lists Valve Anti-Cheat for the app (its feature category 8), from the same Steam answer. VAC leaves no
     * files in the game's folder, so PeerParty reads it from here. Absent: not read yet (read again once).
     */
    vac?: boolean
  }
  /**
   * How hard the game is: the user's or the cloud's pick (MetadataEdit.difficulty), laid over the game as it leaves
   * the main process. Never stored here and nothing scrapes it; absent = Medium (shared/difficulty.ts pickedDifficulty,
   * else DEFAULT_DIFFICULTY).
   */
  difficulty?: DifficultyLevel
  achievements?: { unlocked: number; total: number; updatedAt: string }
  currentPlayers?: { count: number; updatedAt: string }
  /**
   * Steam games: the most players ever online at once, from SteamCharts' history (Steam's API has no all-time peak;
   * main scrapers/steamcharts.ts). `count` 0: SteamCharts does not track the game. Read again after a day.
   */
  peakPlayers?: { count: number; updatedAt: string }
  /**
   * Steam games: the screenshots of the game's Steam store page (Steam CDN URLs, store order), shown in a row on
   * the game page. `items` empty: Steam has none (or no store page). Fetched again after a month.
   */
  steamScreenshots?: { items: SteamScreenshot[]; updatedAt: string }
  /**
   * The size of a game that is not installed. `how`: 'steam' = what the Steam client would install (its depots,
   * exact), 'epic' = what the Epic Games Launcher would install (the build manifest, exact; needs the Epic sign-in),
   * 'steam-match' = the same for the same game on Steam (another store's game, matched by title;
   * `steamAppId` names it), 'gog' = the GOG installer's size, 'requirement' = the Steam store page's disk space
   * requirement (an estimate). `bytes` absent: checked and none found. Checked again after a month.
   */
  storage?: {
    bytes?: number
    how?: 'steam' | 'epic' | 'steam-match' | 'gog' | 'requirement'
    steamAppId?: number
    /** Epic's manifest was asked (signed in to Epic): a Steam match is not replaced by it again within the month. */
    epicChecked?: true
    /** 'epic' with optional content (language packs, high-res textures) counted in: an upper bound, not exact. */
    approximate?: true
    /** Another source failed while this was found: asked again the next day instead of next month. */
    partial?: true
    /** The title the Steam match was made by; a different title (an override) asks again. */
    matchKey?: string
    /** 'steam' / 'steam-match': the depot rules it was worked out by (install-size.ts STEAM_SIZE_RULES; absent = 1). */
    steamRules?: number
    checkedAt: string
  }
  links?: { store?: string; website?: string }
  /** Provider -> external id that was matched (e.g. { steamgriddb: '5250', igdb: '1020' }). */
  sources?: Record<string, string>
  updatedAt?: string
}

/** A difficulty level (shared/difficulty.ts DIFFICULTY_IDS, easiest first). */
export type DifficultyLevel = 'story' | 'easy' | 'medium' | 'hard' | 'impossible'

/**
 * Media URLs the renderer can load directly: media://<gameId>/<file> for cached files (main process serves them),
 * or https:// URLs in the browser mock.
 */
export interface GameMedia {
  /** Portrait 2:3 box art (600x900). */
  cover?: string
  /** Wide hero / background art (1920x620 or larger). */
  hero?: string
  /** Transparent logo (clear logo / marquee). */
  logo?: string
  icon?: string
  screenshots?: string[]
  video?: string
}

export type MediaKind = 'cover' | 'hero' | 'logo' | 'icon' | 'screenshot' | 'video'
/** The media kinds the art pipeline (ARCHITECTURE.md 4.6 "Art pipeline") can find and download. */
export type ArtKind = Exclude<MediaKind, 'video'>

export interface Game {
  /** Stable id: `${source}:${externalId}` (rom: `rom:${systemId}:${hash}`). */
  id: string
  source: SourceId
  /** Store app id, catalog item id, product code, or ROM relative path. */
  externalId: string
  platformId: string
  title: string
  /** Title used for sorting ('The ' stripped, lowercase). */
  sortTitle: string
  installed: boolean
  /**
   * True while a signed-in store account lists the game as owned (set by `mergeOwned`, never by installed scans).
   * An owned, not installed game is shown greyed out with an Install action; see ARCHITECTURE.md §4.8.
   */
  owned?: boolean
  installDir?: string
  /** Main executable, when known (manual games, store games with a known exe). */
  exePath?: string
  /** Absolute ROM path for rom games. */
  romPath?: string
  /**
   * A ROM game whose disc image the player moved to the Recycle Bin once its recompilation was ready (the "Delete the
   * original" question, main/recomp/image-offer.ts): the card stays (art, metadata, play time, favourite) and Play / UP
   * start the recompilation `recompId`. `romPath` is gone from the record (it is kept here only for the log and the
   * recompilation match); nothing that works on ROM files (convert, Trim Games, emulators, Delete from this PC,
   * texture packs, streaming downloads) acts on it. A scan that finds the file again (restored from the Recycle Bin)
   * makes it an ordinary ROM card again, as does Restore after the recompilation's test run failed (`launchRomPath` and
   * `installSize`: the launch's file and the measured size before, put back then).
   */
  romRemoved?: {
    at: string
    recompId: string
    romPath: string
    launchRomPath?: string
    installSize?: Game['installSize']
  }
  launch: LaunchSpec
  tracking: TrackingSpec
  hidden: boolean
  /**
   * The store's own client has this game hidden, as of the last sync. Kept apart from `hidden`: a game the user shows
   * again here stays shown until the store changes its mind, and one the user hid here stays hidden.
   */
  hiddenByStore?: boolean
  favorite: boolean
  /**
   * When the user last turned `favorite` on or off (ISO, this PC's clock), here or on a paired PC whose change was
   * taken (the favourites sync, main/streaming/favorites-sync.ts). Absent: never changed since the sync came.
   */
  favoriteAt?: string
  /** The user marked the game as completed. Absent (never `false`) when not completed. */
  completed?: boolean
  /** Minutes tracked by PlayOut sessions. */
  playtimeMinutes: number
  /** Minutes reported by the store (Steam localconfig), when available. */
  storePlaytimeMinutes?: number
  /** ISO timestamp of the last session start (ours or the store's). */
  lastPlayed?: string
  playCount: number
  addedAt: string
  metadata: GameMetadata
  media: GameMedia
  metadataStatus: 'none' | 'pending' | 'done' | 'failed'
  /** Per-game user overrides (never overwritten by scans). */
  user: GameUserData
  /** Provider-specific extras (steam appid, epic namespace, gog product id, battle.net product code...). */
  extra?: Record<string, string | number | boolean>
  /** Only on games a paired host offers and this PC does not have (Streaming; see RemoteLibrary). */
  remote?: RemoteGameInfo
  /**
   * Space the installed game takes. `how`: 'store' = the client's own record (Steam, Epic), 'file' = the ROM file,
   * 'folder' = the install folder added up by PlayOut. `path` is what was measured, so a moved install is measured
   * again.
   */
  installSize?: {
    bytes: number
    how: 'store' | 'file' | 'folder'
    path?: string
    measuredAt: string
    /** The folder could not be added up (a shared folder, too many files, unreadable): no size to show. */
    unmeasurable?: true
  }
}

export interface GameUserData {
  titleOverride?: string
  /** Co-Op setup chosen by the user (Co-Op setup); absent = everything automatic. */
  coop?: CoopSetup
  /** Preferred emulator id for rom games. */
  emulatorId?: string
  /** Custom launch arguments appended for exec launches. */
  extraArgs?: string
  /** Install size the user entered (bytes), shown instead of a measured or store size. */
  installSize?: number
  /** User-chosen media files (absolute paths), take precedence over scraped media. */
  customMedia?: Partial<Record<Exclude<MediaKind, 'screenshot'>, string>>
  notes?: string
  /**
   * Set on at most one copy of a game: when the same game is found in several stores, the library shows this copy.
   * Absent (never `false`) when not preferred.
   */
  preferredCopy?: boolean
  /** The game's own power profile, applied while it runs (the overlay's Power section). */
  performance?: {
    profile: import('./overlay').PowerChoice
    /** Dynamic TDP's target frame rate for this game (profile 'dynamic'). */
    targetFps?: number
  }
  /** The game's music playlist: paths relative to the music folder. */
  playlist?: string[]
  /**
   * The user's own corrections of the game's metadata (the game page's Edit sheet; shared/metadata-edit.ts): laid
   * over the scraped metadata and the cloud's when the game is shown. The title edit is `titleOverride`, never here.
   */
  metadataEdits?: import('./metadata-edit').MetadataEdit
}

/** Patch the renderer may apply to a game. A `null` user field clears it (undefined is dropped by IPC). */
export interface GameUserPatch {
  favorite?: boolean
  hidden?: boolean
  /** `false` removes the flag. */
  completed?: boolean
  user?: { [K in keyof GameUserData]?: GameUserData[K] | null }
}

export interface PlaySession {
  id: string
  gameId: string
  startedAt: string
  endedAt?: string
  minutes: number
  /**
   * A session played on another PC, taken by the play time sync (main/streaming/playtime-sync.ts): the paired PC it
   * came from (its streaming id). Absent: played on this PC.
   */
  from?: string
  /** When this PC took it from that PC (ISO, this PC's clock). */
  syncedAt?: string
  /**
   * A session taken from another PC: the PC store whose account play time already counts it (it was played on that
   * store's copy there). Its minutes are not in this PC's playtimeMinutes when it went to this PC's copy of that store,
   * whose storePlaytimeMinutes counts them already.
   */
  store?: string
}

export interface LibrarySnapshot {
  games: Game[]
  platforms: Platform[]
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** What a provider returns for one installed game; the library service merges it into a Game. */
export interface ScannedGame {
  source: SourceId
  externalId: string
  platformId: string
  title: string
  installDir?: string
  exePath?: string
  romPath?: string
  launch: LaunchSpec
  tracking: TrackingSpec
  storePlaytimeMinutes?: number
  lastPlayed?: string
  /** Local art already on disk (absolute paths); the media cache copies them. */
  localMedia?: Partial<Record<Exclude<MediaKind, 'screenshot'>, string>>
  /** Seed metadata known from the source (e.g. an ES-DE gamelist entry). */
  metadata?: Partial<GameMetadata>
  extra?: Record<string, string | number | boolean>
}

export interface ClientInfo {
  installed: boolean
  /** Path of the client executable or install directory. */
  path?: string
  version?: string
}

export interface SourceStatus {
  id: SourceId
  name: string
  enabled: boolean
  client: ClientInfo
  lastScanAt?: string
  gameCount: number
  /** Last scan error, if any. */
  error?: string
}

export interface ScanProgress {
  sourceId: SourceId
  phase: 'detecting' | 'scanning' | 'done' | 'error'
  found: number
  message?: string
}

export interface ScanResult {
  sources: SourceStatus[]
  added: number
  updated: number
  removed: number
  /** ROM subfolders that matched no known system. */
  unknownFolders?: string[]
}

// ---------------------------------------------------------------------------
// Store accounts and installs (docs/ARCHITECTURE.md §4.8, docs/research/store-accounts.md)
// ---------------------------------------------------------------------------

/** One row of the Library "Settings" tab: what PlayOut knows about a store account. */
export interface AccountStatus {
  source: StoreSourceId
  /** False when this release cannot import the store's owned library (then `reason` says why, user-facing). */
  supported: boolean
  reason?: string
  signedIn: boolean
  /** Account / persona name shown as "Signed in as …". */
  displayName?: string
  /** ISO timestamp and count of the last successful owned-library import. */
  lastImportAt?: string
  lastImportCount?: number
  /** True while an import for this source is running. */
  importing: boolean
  /**
   * The credential comes from Settings > Metadata (Steam's Web API key + SteamID64), not from a sign-in: the row
   * shows where to remove it instead of a Sign out button.
   */
  viaSettings?: boolean
  /** Last sign-in or import error, user-presentable. */
  error?: string
  /**
   * 'store': `error` is a problem on the store's side (its servers answered 5xx / 429, or could not be reached); the
   * library is unchanged and PlayOut retries by itself, so the UI shows it as a notice rather than a failure.
   */
  errorKind?: 'store'
}

/**
 * One game a store account owns, as the account importer reports it. `externalId` must be the same id the store's
 * provider uses for the installed game (Steam appid, Epic AppName, GOG product id, Xbox package family name,
 * Battle.net product code, EA content id) so `mergeOwned` and `mergeScan` land on the same Game record.
 */
export interface OwnedGame {
  externalId: string
  title: string
  /** Art URLs the store API returned (https); imported before any scraper runs. */
  coverUrl?: string
  heroUrl?: string
  logoUrl?: string
  iconUrl?: string
  storePlaytimeMinutes?: number
  /** ISO timestamp of the store's last-played time, when the store reports one. */
  lastPlayedAt?: string
  /**
   * ISO timestamp of when the account got the game, when the store reports one (Steam's "Date Added to Library"). It
   * becomes the record's `addedAt`, so Sort > Recently added follows the store's own order.
   */
  acquiredAt?: string
  /** 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY'. */
  releaseDate?: string
  developer?: string
  publisher?: string
  /** Provider-specific ids, same keys as the provider writes (steamAppId, epicNamespace, gogProductId, storeId...). */
  extra?: Record<string, string | number | boolean>
}

export interface ImportOwnedResult {
  sources: {
    id: StoreSourceId
    /** Owned games the store listed. */
    imported: number
    /** New library records created (owned, not installed). */
    added: number
    /** Records the account no longer lists (owned cleared; removed when never installed and never played). */
    removed: number
    error?: string
  }[]
}

/**
 * One DLC of a Steam game, for the install-time picker and Manage DLC (main `steam-dlc/`). Steam keeps the choice in
 * the game's `appmanifest_<appid>.acf`: `UserConfig.DisabledDLC` lists the DLC turned off (what Steam should do),
 * `MountedConfig.DisabledDLC` what it has done, and an `InstalledDepots` entry with this `dlcappid` is content on disk.
 */
export interface SteamDlcItem {
  appId: number
  name: string
  /** Download size in bytes of the DLC's content (its Windows depots); null when it has none (it only unlocks). */
  sizeBytes: number | null
  /** The signed-in Steam account owns it; null when that is unknown (not signed in to Steam in PlayOut). */
  owned: boolean | null
  /** On in Steam: not in `UserConfig.DisabledDLC` (true for a game not installed, Steam's default). */
  enabled: boolean
  /** Its content is on this PC (a depot of it in `InstalledDepots`). */
  installed: boolean
  /** Steam has not applied the latest choice for it yet (UserConfig differs from MountedConfig). */
  pending: boolean
  /** Opt-in content (Workshop tools and the like) or DLC the game manages itself: only Steam's own page changes it. */
  steamOnly: boolean
}

export interface SteamDlcInfo {
  gameId: string
  appId: number
  /** The game is installed on this PC (its appmanifest exists). */
  installed: boolean
  /** Owned (or ownership unknown) DLC, by name. */
  dlc: SteamDlcItem[]
  /** DLC the account does not own, left out of `dlc` (0 when ownership is unknown). */
  notOwnedCount: number
  /** Steam is running: applying a change closes it and opens it again. */
  steamRunning: boolean
  /** Why a change cannot be applied now (a game running, Steam downloading), user-presentable; null when it can. */
  blocked: string | null
  /** DLC turned off at install time, applied once the install finishes; null when nothing waits. */
  plannedDisabled: number[] | null
  /** Set when the DLC list could not be read (offline, Steam's info service down); user-presentable. */
  error?: string
}

export interface SteamDlcResult {
  ok: boolean
  /** Set when ok is false; user-presentable. */
  error?: string
  /** The game is not installed yet: the choice is saved and applied when its install finishes. */
  planned?: boolean
  /** Steam was closed and opened again to apply the choice. */
  restartedSteam?: boolean
}

export interface InstallResult {
  ok: boolean
  /** Set when ok is false; user-presentable. */
  error?: string
  /**
   * Set when another game is downloading: the game waits in PlayOut's install queue, at this place (1 = next).
   * Its store or host is only asked once every game before it finished.
   */
  queued?: number
}

/**
 * One game in PlayOut's install queue (docs/ARCHITECTURE.md §4.8 "Install queue"): one game downloads at a time,
 * whatever the store, and ROM downloads from another PC wait their turn too. Emitted as the whole list
 * ('installs:queue'), the active entry first.
 */
export interface InstallQueueEntry {
  gameId: string
  title: string
  /** A store install (handed to the store client and tracked), or a ROM download from another PC. */
  kind: 'store' | 'host-rom'
  /** The store, or 'host' for a ROM from another PC. */
  source: StoreSourceId | 'host'
  /** Where it comes from, for display: the store's name ('Steam') or the host's name. */
  from: string
  /**
   * 'active': downloading now (progress in 'install:progress' or 'streaming:download'); 'waiting': waits its
   * turn. At most one entry is active.
   */
  state: 'active' | 'waiting'
  /** ISO time it was added. */
  addedAt: string
  /**
   * Why a waiting entry is held back rather than next in line, for display ("Waiting for <host> to come back
   * online": a ROM whose host cannot be reached). Unset for an entry that simply waits its turn.
   */
  waitingFor?: string
  /**
   * Paused by the user (pauseInstall): a waiting game keeps its place but is skipped until resumed. A ROM download from
   * another PC stops (what it has is kept, resumeInstall continues it) and waits paused. A store install PlayOut cannot
   * pause: it stays the active download, marked paused, while the user pauses it in the store (its downloads page is
   * opened). Kept across a restart.
   */
  paused?: boolean
}

export type InstallState =
  /** The install URI was sent; waiting for the store client to show its dialog / create its manifest. */
  | 'starting'
  | 'queued'
  | 'downloading'
  /** Verifying, committing, finalizing: the download is complete but the game is not yet installed. */
  | 'installing'
  /** The installed scan reported the game installed; the tracker is finished. */
  | 'done'
  /** Cancelled in the client, or no change for 30 minutes. */
  | 'failed'
  /** The client exposes no state for this install (indeterminate bar). */
  | 'unknown'

/** A fixed local drive and its space (Settings › Storage; main system/drives.ts). */
export interface StorageDrive {
  /** The drive's root, like C:\ */
  root: string
  /** Its volume name ("Games"), if it has one. */
  label: string | null
  totalBytes: number
  freeBytes: number
}

/** Progress of one background install PlayOut tracks (one per game); emitted as 'install:progress'. */
export interface InstallProgress {
  gameId: string
  source: StoreSourceId
  state: InstallState
  /** 0-100 when measurable; absent = indeterminate bar. */
  percent?: number
  bytesDone?: number
  bytesTotal?: number
  /** User-facing line, e.g. 'Installing through Steam…' or 'Confirm the install in Steam'. */
  message?: string
  /**
   * The store showed the install but nothing moved for a while (main's stalledMessage, 'it may be paused there'): not
   * failed, keeps its turn. The renderer goes by this flag, never by the words of `message`, which are translated.
   */
  stalled?: boolean
  startedAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Emulation
// ---------------------------------------------------------------------------

/** One ES-DE style system definition (resources/systems/systems.json). */
export interface SystemDefinition {
  /** ROM subfolder name and platform id, e.g. 'snes'. */
  id: string
  name: string
  /** Extra folder names that also map to this system. */
  aliases?: string[]
  extensions: string[]
  /** Key into platform-ids.json for scrapers. */
  platformKey: string
  manufacturer?: string
  releaseYear?: number
  emulators: EmulatorCommand[]
  /** Directories with these extensions are games (e.g. '.ps3', '.wiiu'). */
  dirExtensions?: string[]
}

export interface EmulatorCommand {
  /** Stable id such as 'retroarch-snes9x' or 'dolphin'. */
  id: string
  label: string
  /** ES-DE command template using %EMULATOR_X%, %CORE_X%, %ROM%, %BASENAME%, %GAMEDIR% ... */
  command: string
  /**
   * Ids and labels of the ES-DE commands this one replaced (scripts/build-systems.mjs COMMAND_MERGES): a game,
   * preference or ES-DE import that names one of them runs this command.
   */
  aliases?: string[]
  /**
   * The emulator cannot open .zip / .7z ROMs (scripts/build-systems.mjs COMMAND_DEFAULTS): when it is the system's
   * default and nothing else was chosen, an archived ROM runs the system's first RetroArch command, which unpacks it.
   */
  noArchives?: true
}

export interface EmulatorStatus {
  /** Emulator name as used in %EMULATOR_X% placeholders, e.g. 'RETROARCH', 'DOLPHIN'. */
  id: string
  name: string
  /** Resolved executable path, if found or overridden. */
  path: string | null
  /** 'override' when set by the user in settings; 'playout' when PlayOut downloaded and set it up. */
  foundBy?: 'override' | 'playout' | 'rule' | null
  /** Where the find rules looked. */
  searchedPaths: string[]
  /** For RetroArch: detected cores directory. */
  coresDir?: string | null
  downloadUrl?: string
  /** PlayOut can download and set this emulator up itself (Settings › Emulators › Install). */
  installable?: boolean
}

/** The emulator setup's progress (first-time setup, Set up emulators, Install). total 0 = idle. */
export interface EmulatorSetupProgress {
  /** Emulators finished (installed or failed) in this run. */
  done: number
  /** Emulators in this run; 0 when idle. */
  total: number
  /**
   * The step under way: Visual C++ / DirectX runtimes, downloads and unpacking, linking BIOS files, or Update all
   * emulators (checking for and putting in the newest builds).
   */
  stage?: 'runtimes' | 'emulators' | 'bios' | 'updates'
  /** Names of the emulators being downloaded or set up right now. */
  current?: string[]
  /** Bytes downloaded so far in this run, and the total known so far. */
  bytesDone?: number
  bytesTotal?: number
  /** Files of an emulator downloaded as a folder (RPCS3 from Google Drive): present so far, and in all. */
  filesDone?: number
  filesTotal?: number
}

export interface EmulatorSetupItem {
  /** Find-rules id, e.g. 'RPCS3'. */
  id: string
  name: string
  state: 'installed' | 'missing' | 'installing' | 'failed'
  version?: string
  /** The build channel of the installed version when Update all emulators put it in (nightly, dev, ...). */
  channel?: string
  /** The executable PlayOut installed. */
  exe?: string
  /** Why the last attempt failed. */
  error?: string
}

export interface EmulatorSetupStatus {
  /** Where the emulators are installed: the Emulation folder next to PlayOut.exe. */
  root: string
  /** The data Emulation folder (BIOS, saves, states, texture packs). */
  emulationDir: string
  biosDir: string
  items: EmulatorSetupItem[]
  progress: EmulatorSetupProgress
  /** Problems that need the user (a declined runtime install, BIOS files not found, ...). */
  notices: string[]
  /** What the last Update all emulators did (since PlayOut started); absent before the first one. */
  lastUpdate?: EmulatorUpdateReport
}

/** One emulator's outcome in Update all emulators. */
export interface EmulatorUpdateItem {
  id: string
  name: string
  /**
   * updated: the newest build is in; current: it already was; running: left alone because the emulator is open;
   * failed: the check or the update failed (the installed build is kept); unavailable: it publishes no newer builds.
   */
  result: 'updated' | 'current' | 'running' | 'failed' | 'unavailable'
  /** The version installed before, and the newest one found. */
  from?: string
  to?: string
  /** The build channel used: nightly, dev, canary, ... (or 'stable' when there is no nightly). */
  channel?: string
  error?: string
}

export interface EmulatorUpdateReport {
  /** When the run ended (ISO). */
  at: string
  items: EmulatorUpdateItem[]
}

export interface SystemInfo extends SystemDefinition {
  gameCount: number
  /** Ids of this system's EmulatorCommands whose %EMULATOR_X% references all resolved to a file. */
  availableEmulators: string[]
}

export interface ImportResult {
  gamesUpdated: number
  mediaCopied: number
  message?: string
}

// ---------------------------------------------------------------------------
// Metadata / scrapers
// ---------------------------------------------------------------------------

export type ScraperId =
  'steamgriddb' | 'igdb' | 'screenscraper' | 'thegamesdb' | 'steam' | 'hltb' | 'gog'

export interface MetadataCandidate {
  scraper: ScraperId
  externalId: string
  title: string
  /**
   * Found by the game's own id (a Steam app id, a GOG product id, a ROM's hash), not by its name: the right game
   * whatever its title says, so it is used without comparing titles.
   */
  byId?: boolean
  /** Other names the source knows the game by (IGDB's alternative and regional names): a match on one counts. */
  altTitles?: string[]
  releaseDate?: string
  platform?: string
  /**
   * The source's own ids of the platforms it lists the game on (IGDB platform ids, TheGamesDB's, ScreenScraper's
   * system id): of same-titled results, one on the console the game was found on is taken.
   */
  platformIds?: number[]
  cover?: string
}

export interface AchievementsInfo {
  /** Where the list comes from: Steam for store games, RetroAchievements for ROMs. Absent means Steam. */
  provider?: AchievementsProvider
  total: number
  unlocked: number
  /** RetroAchievements: points earned and possible. */
  points?: { earned: number; total: number }
  /** RetroAchievements: the game's page. */
  url?: string
  list: {
    id: string
    name: string
    description?: string
    unlocked: boolean
    unlockedAt?: string
    icon?: string
    hidden?: boolean
    /** RetroAchievements: the achievement's points. */
    points?: number
    /** RetroAchievements: earned in hardcore mode. */
    hardcore?: boolean
  }[]
}

export type AchievementsProvider = 'steam' | 'retroachievements'

/** The RetroAchievements account of Settings > Emulators, as the last check or sync left it. */
export interface RetroAchievementsStatus {
  /**
   * signed-out: no username or key. checking: a check or sync is running. signed-in: the key was accepted.
   * invalid: RetroAchievements rejected the username or key. error: it could not be reached (message says why).
   */
  state: 'signed-out' | 'checking' | 'signed-in' | 'invalid' | 'error'
  user?: string
  /** Avatar image URL. */
  avatar?: string
  /** Hardcore points (RetroAchievements' main score). */
  points?: number
  softcorePoints?: number
  /** ROMs matched to a RetroAchievements game by the last sync. */
  matched?: number
  /** ROMs the last sync looked at. */
  roms?: number
  /** When the last sync finished. */
  syncedAt?: string
  message?: string
  /**
   * Bumped by every change of the username or key: a status with a higher revision than the one shown when the
   * user edited answers that edit (an older sync still running reports the old revision).
   */
  revision: number
}

/**
 * The review scores pass: `done` of `total` games looked at. `stage` 'steam': Steam's review summaries (100 games
 * a request, seconds for a library); 'igdb': IGDB for the games without a Steam score (title searches, a few a
 * second). `paused`: Steam or IGDB stopped answering; the pass waits 15 minutes. `current`: the game searched
 * for. total 0 = no pass runs.
 */
export interface RatingsProgress {
  done: number
  total: number
  stage: 'steam' | 'igdb'
  paused?: boolean
  current?: string
}

/**
 * LaunchBox's player counts (launchbox-players.ts): `stage` 'download' (bytes of Metadata.zip) or 'reading' (bytes
 * of its Metadata.xml read). total 0 = idle.
 */
/** Tools a Co-Op handler can use that remove DRM or bypass anti-cheat: Co-Op warns once before using them. */
export type CoopRiskTool = 'steamless' | 'smartsteamemu' | 'steamstub' | 'eac'

/** What a Nucleus Co-op handler script says about itself (read without running it: coop/handler-script.ts). */
export interface CoopHandlerScript {
  gameName: string
  exeName?: string
  /** Other exe names the handler accepts (Game.ExecutableNames). */
  exeNames: string[]
  /** Files or folders that must exist next to the exe (Game.ExecutableContext). */
  exeContext: string[]
  steamId?: string
  guid?: string
  binariesFolder?: string
  maxPlayers?: number
  maxPlayersOneMonitor?: number
  supportsKeyboard: boolean
  supportsMultipleKeyboardsAndMice: boolean
  hubId?: string
  hubVersion?: number
  risks: CoopRiskTool[]
}

/** One downloaded handler package in the Co-Op index (coop/handler-pack.ts). */
export interface CoopHandlerEntry extends CoopHandlerScript {
  /** The package file: `handler-<hubId>-v<version>.nc`. */
  archive: string
  /** The hub's title (often the game name plus a mod or mode: "Elden Ring Seamless Co-op"). */
  title?: string
  controllers?: boolean
  mouseKeyboard?: boolean
  multiMouseKeyboard?: boolean
}

/** GameMetadata.recomp: the game's recompilations (main/recomp/match.ts). */
export interface GameRecompInfo {
  /** RecompTitle key ("<systemId>:<normalized game>"). */
  titleKey: string
  /** Recompilations of the game usable on Windows. */
  count: number
  /** Installed entry ids among them. */
  installed: string[]
  /** The user's chosen version, else the recommended one. */
  preferred: string
  updatedAt: string
}

/** The Co-Op handler matched to a game (Game.metadata.coop). */
export interface CoopGameInfo {
  archive: string
  hubId?: string
  /** The handler's game name (Nucleus's handler file name). */
  gameName: string
  maxPlayers?: number
  /** The handler lets a keyboard and mouse be a player. */
  keyboard?: boolean
  risks?: CoopRiskTool[]
  matchedBy: 'exe' | 'steam' | 'name'
  updatedAt: string
}

/**
 * Nucleus screen layouts (UserScreenType): `DualHorizontal` = two players stacked top and bottom, `DualVertical` =
 * side by side, `FourPlayers` = 2×2, and so on.
 */
export type CoopLayout =
  | 'FullScreen'
  | 'DualHorizontal'
  | 'DualVertical'
  | 'FourPlayers'
  | 'SixPlayers'
  | 'EightPlayers'
  | 'SixteenPlayers'

/** Settings > Library > Co-Op: the default split for two players. */
export type CoopTwoPlayerLayout = 'stacked' | 'sideBySide'

/** A Co-Op input device, as the helper lists it (`devices`). */
export interface CoopDevice {
  /** 'xinput:0', 'dinput:{guid}', 'kb' (the keyboard and mouse together). */
  id: string
  kind: 'xinput' | 'dinput' | 'keyboard'
  name: string
  /** XInput slot. */
  index?: number
  guid?: string
}

/** A monitor as the helper sees it. */
export interface CoopScreen {
  index: number
  primary: boolean
  bounds: { x: number; y: number; width: number; height: number }
  name?: string
}

/** The user's Co-Op choices for a game (GameUserData.coop); any field absent = chosen automatically. */
export interface CoopSetup {
  /** The game's exe to run (absent: the game's known exe, else the handler's exe found in the install folder). */
  exePath?: string
  players?: number
  layout?: CoopLayout
  /** Device id per player, in player order. */
  devices?: string[]
  /** The DRM / anti-cheat warning was accepted for this game. */
  risksAccepted?: boolean
}

/** Downloading or indexing the Co-Op handlers ('coop:progress'); total 0 = idle. */
export interface CoopProgress {
  stage: 'listing' | 'download' | 'indexing' | 'tools'
  done: number
  total: number
}

/** Settings > Library's Co-Op status. */
export interface CoopStatus {
  /** Handler packages downloaded (zipped). */
  handlers: number
  /** Library games a handler was matched to. */
  games: number
  busy: boolean
  /** The Nucleus tools are downloaded. */
  toolsReady: boolean
  /** The Co-Op helper ships with this build. */
  helperReady: boolean
}

/** A Co-Op session's progress ('coop:session'); `state` 'ended' when it is over. */
export interface CoopSessionEvent {
  gameId: string
  state: 'preparing' | 'starting' | 'running' | 'ended' | 'error'
  message?: string
}

/** What Co-Op would do for a game now (shown by Co-Op setup, used by Co-Op play). */
export interface CoopPlan {
  gameId: string
  exePath: string | null
  /** Exes in the install folder the handler accepts (choices for Co-Op setup). */
  exeChoices: string[]
  players: number
  maxPlayers: number
  layout: CoopLayout
  devices: CoopDevice[]
  /** The device of each player, in order. */
  assigned: string[]
  screens: CoopScreen[]
  /** The monitors in use, the main one first: each one's layout and how many players it shows. */
  monitors: { index: number; layout: CoopLayout; players: number }[]
  /** Why Co-Op cannot start as planned (no exe, fewer than two players, ...); null = ready. */
  problem: string | null
  risks: CoopRiskTool[]
}

export interface PlayersProgress {
  stage: 'download' | 'reading'
  done: number
  total: number
}

/**
 * The background HowLongToBeat pass (metadata-service.ts backfillHltb: games never matched, earlier misses, times
 * from older versions): `done` of `total` games looked at, `current` the one being matched. total 0 = no pass runs.
 */
export interface HltbProgress {
  done: number
  total: number
  current?: string
  /**
   * 'sort': the H.L.T.B. sort's lookups of games without a time (main scrapers/hltb-times.ts), shown as the Library's
   * "Looking up H.L.T.B. times" line; absent: the start-up pass (bottom bar).
   */
  source?: 'sort'
}

/** Which art the bottom bar is counting: one cover per game (cover lane), then the rest of each game's art. */
export type ArtProgressStage = 'cover' | 'art'

/**
 * The game art downloads (scrapers/art-progress.ts, ARCHITECTURE.md §4.6 "Art progress"): `done` of `total` games
 * through the stage on show; covers while the cover lane has games, then the full lane's art. total 0 = idle.
 */
export interface ArtProgress {
  stage: ArtProgressStage
  done: number
  total: number
}

export interface MetadataProgress {
  gameId: string
  status: 'pending' | 'done' | 'failed'
  /** Games still waiting or in flight in either lane. */
  remaining: number
  message?: string
  /** Which lane produced the event (ARCHITECTURE.md 4.6 "Art pipeline"); absent from the browser mock's events. */
  lane?: MetadataLane
  /** Games accepted by `enqueue` and not yet finished by both lanes. */
  queued?: number
  /** Games the cover lane still has to look at (waiting + in flight). */
  coverLane?: number
  /** Games the full lane still has to look at (waiting, in flight, or paused behind the cover lane). */
  fullLane?: number
  /** Games finished by both lanes since the queues were last empty. */
  done?: number
}

/**
 * The two metadata queues: the cover lane lands one cover per game from local caches, direct URLs and SteamGridDB
 * ahead of everything else; the full lane runs the text chain, the remaining art kinds and HLTB.
 */
export type MetadataLane = 'cover' | 'full'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Metadata services whose credentials Settings › Metadata can test (testCredentials). */
export type CredentialService =
  'steamgriddb' | 'igdb' | 'screenscraper' | 'thegamesdb' | 'steam' | 'retroachievements'

/** The credential fields of one service, as stored in settings.scrapers. */
export type ServiceCredentials<S extends CredentialService> = Settings['scrapers'][S]

/**
 * Outcome of a credential test. `valid`: the service accepted them. `invalid`: the service rejected them.
 * `unchecked`: the answer said nothing about the credentials (offline, timeout, rate limit, server error, a
 * required field missing); the message says why.
 */
export interface CredentialCheck {
  status: 'valid' | 'invalid' | 'unchecked'
  /** One sentence for a notification, starting with the service name. Never contains the credentials. */
  message: string
}

export interface Settings {
  /** See `SETTINGS_VERSION` in shared/defaults.ts. */
  version: 4
  library: {
    romsRoot: string | null
    /** Show games that are not installed (owned store games, games a rescan no longer found) greyed out. Default true. */
    showUninstalled: boolean
    showHidden: boolean
    /**
     * Show duplicates: every copy of a game on consoles has its own card, and only a game's PC store copies share one
     * (Steam > GOG > Epic > Xbox), as before 0.1.125. Off (default): one card per game across PC stores and the PS3,
     * PS2, GameCube, Xbox 360 and Xbox ROMs, recompilations first (renderer lib/copies.ts).
     */
    showDuplicates: boolean
    sources: Record<SourceId, { enabled: boolean }>
    /** ES-DE home (contains gamelists/ and downloaded_media/); null = auto-detect ~/ES-DE. */
    esdeHome: string | null
    /**
     * The Emulation folder (EmuDeck's layout: bios, roms, saves, tools…): where Convert finds keys and BIOS files.
     * null = PlayOut's own, `<settings folder>/Emulation`, generated at launch.
     */
    emulationDir: string | null
    /** Co-Op: the keyboard and mouse count as a player (games whose handler supports them). Default false. */
    coopKeyboardMouse: boolean
    /**
     * Co-Op: how two players share a screen by default: 'stacked' = top and bottom (side by side when the screen is too
     * short for two windows), 'sideBySide' = left and right. Co-Op setup's layout for a game takes precedence.
     */
    coopTwoPlayerLayout: CoopTwoPlayerLayout
    /**
     * Trim Games: every ROM game new to the library is converted to its smaller format through Settings › Convert's
     * runs (PS2 ISO → CHD, Xbox ISO → XISO, PlayStation CUE/BIN → CHD, PSP ISO → CSO, PS3 disc folder → ISO, Wii and
     * GameCube ISO → RVZ; main/convert/auto-trim.ts). Games already in the library are not touched. Default false.
     */
    trimGames: boolean
  }
  emulators: {
    /** emulator id (e.g. 'RETROARCH') -> executable path. */
    overrides: Record<string, string>
    /** RetroArch cores directory override. */
    coresDir: string | null
    /** system id -> preferred emulator command id. */
    preferred: Record<string, string>
    /**
     * PS3 games get their missing updates by themselves: Sony's update list is checked at start and when a PS3 game is
     * added, and the updates are installed through RPCS3 while it is closed (main/emulation/ps3-update-service.ts).
     * The game menu's "Update PS3 game" works either way. Default true.
     */
    ps3AutoUpdate: boolean
  }
  scrapers: {
    steamgriddb: { apiKey: string }
    igdb: { clientId: string; clientSecret: string }
    screenscraper: { devId: string; devPassword: string; user: string; password: string }
    thegamesdb: { apiKey: string }
    steam: { apiKey: string; steamId64: string }
    /** RetroAchievements account (Settings > Emulators): progress for ROM games. */
    retroachievements: { username: string; apiKey: string }
    hltb: { enabled: boolean }
    /** Read Steam's user tags for every game (keyless). Default true. */
    steamTags: { enabled: boolean }
    /**
     * The PlayOut database (shared/game-database.ts, main/game-database): `enabled` fills a game's facts from it before
     * the scrapers run; `contribute` sends the games it lacks (their title and facts, with the anonymous install id)
     * through the relay. Turning `enabled` off also stops contributing. Both default true.
     */
    gameDatabase: { enabled: boolean; contribute: boolean }
    autoScrape: boolean
    region: 'us' | 'eu' | 'jp' | 'wor'
    language: 'en'
    /** Order in which art sources are tried by the full lane. */
    artPriority: ScraperId[]
    /**
     * Read art already on this PC (Steam librarycache, GOG Galaxy webcache, Epic catalog, ES-DE media, Playnite)
     * before any download. Default true; Settings > Metadata "Use art from installed store clients".
     */
    localArt: boolean
  }
  ui: {
    startFullscreen: boolean
    clock24h: boolean
    recentCount: number
    /**
     * What Home's row of games shows (Settings > Library > Front page): 'recent' (Recently Played, the default),
     * 'added' (Recently Added), 'favorites' (Favorites) or 'played' (Most Played). Its card count is recentCount.
     */
    homeRow: HomeRowMode
    animations: boolean
    minimizeWhilePlaying: boolean
    /**
     * The Library's tabs, left to right (after the fixed Settings tab), each its filters and sort. null until the
     * first run made them from the platform tabs of earlier versions (renderer lib/libraryTabs.ts migrateTabs).
     */
    libraryTabs: LibraryTabDef[] | null
    /** The Library tab shown last: a LibraryTabDef id, or 'settings'; '' = the first tab. */
    libraryTab: string
    /** Per Library tab id: the game whose card was focused last, so each tab opens where it was left. */
    libraryPositions: Record<string, string>
    /** Per Library tab id: how far its grid was scrolled, so each tab opens scrolled where it was left. */
    libraryScroll: Record<string, LibraryScrollPosition>
    /**
     * Size of the Library's covers, every tab alike (the slider on the grid's left): a step of COVER_SCALE_STEPS
     * (shared/cover-scale.ts) times the original 240x360u. Default 1 (the original size).
     */
    libraryCoverScale: number
  }
  input: {
    /** 0-1 analog stick deadzone. */
    deadzone: number
    vibration: boolean
    swapAB: boolean
    /** Initial repeat delay when holding a direction, ms. */
    repeatDelayMs: number
    /** Repeat interval when holding a direction, ms. */
    repeatRateMs: number
    /** The home button opens the overlay over any game (docs/home-overlay.md). Default true. */
    homeButtonEnabled: boolean
    /** The buttons held together that open it. Default ['guide'] (the Home / Guide / PS button). */
    homeCombo: import('./overlay').PadButton[]
    /** How long the combo must be held before it opens, ms (0 = at once). */
    homeHoldMs: number
    /**
     * The buttons held together that open the on-screen keyboard (Windows' touch keyboard), over any game or in PlayOut.
     * Default [] (not set).
     */
    keyboardCombo: import('./overlay').PadButton[]
    /** Turn Steam's "Guide button focuses Steam" and in-game overlay off while the combo uses Guide (Steam restarts if it is running). */
    homeOverrideSteam: boolean
    /**
     * Turn Xbox Game Bar off while the home button is on: its controller shortcuts, its links (any program opening it
     * gets nothing) and Game Bar itself, closed whenever it starts. Everything is put back when turned off.
     */
    homeOverrideGameBar: boolean
    /** Pause (suspend) the program the overlay opens over, so it takes no input until the overlay closes. */
    homePauseGame: boolean
    /**
     * A swipe from the left edge of a touchscreen opens the overlay while a game runs (docs/home-overlay.md, "Touch
     * swipe"). Default on; does nothing without a touchscreen.
     */
    touchSwipeOverlay: boolean
    /**
     * The in-game overlay (docs/home-overlay.md, "In-game overlay"): over a game in true exclusive full screen the
     * overlay is drawn inside the game (an injected DLL) instead of as a window, so the game does not minimize. Never for
     * a game with anti-cheat. Default on.
     */
    ingameOverlay: boolean
    /** Game ids the in-game overlay is never used for (the game's own choice, or turned off after a crash). */
    ingameNever: string[]
  }
  /** Power profiles (the overlay's Power section). */
  performance: {
    /**
     * Profile used outside games (and for games without their own); 'none' leaves Windows as it is. 'auto' (the
     * default, never picked in the UI): Dynamic TDP when the power helper is ready, else 'none'. With a ready helper the
     * fallback profiles (silent, balanced, performance) also apply as Dynamic TDP.
     */
    defaultProfile: import('./overlay').PowerChoice | 'none' | 'auto'
    profiles: Record<import('./overlay').PowerProfileId, import('./overlay').PowerProfileConfig>
    /** Apply each game's own profile when it starts. Default true. */
    perGame: boolean
    /** Set watts through the power helper when it is installed. Default true. */
    useWatts: boolean
    /** Dynamic TDP (with the power helper): the frame rate to hold and an optional watts floor and ceiling. */
    dynamic: {
      /** 20-240, default 60. */
      targetFps: number
      /** Never below this many watts (null: the PC's minimum). */
      minWatts: number | null
      /** Never above this many watts (null: the PC's maximum). */
      maxWatts: number | null
    }
    /** The performance overlay drawn by RTSS during games (0 = off). Default 0. */
    perfOverlay: import('./overlay-extras').PerfOverlayLevel
    /** The frame limit follows the display's refresh rate (re-applied on refresh changes and game start). Default false. */
    syncFpsToRefresh: boolean
    /**
     * The overlay's CPU boost tile on a built-in preset: its boost replaced while that preset is in effect (absent = the
     * preset's own). Custom's boost is its own cpuBoost. Default {}.
     */
    boostOverrides: Partial<Record<import('./overlay-extras').BoostPresetId, boolean>>
    /**
     * Free up memory while PlayOut is running (shared/memory.ts): background programs' working sets are trimmed when a
     * game starts and when available memory runs low; with the power helper also Windows' memory lists. Temporary
     * only: nothing is stopped or disabled. Default off.
     */
    memory: { enabled: boolean }
  }
  /** The overlay's music player. */
  music: {
    /** The folder of music files; null = none chosen. */
    folder: string | null
    /** When a game starts: keep what plays, play the game's playlist, or load it paused. */
    gameStart: 'keep' | 'play' | 'load'
    /** Player volume, 0-1. */
    volume: number
    /** The player is muted (the overlay's Mute under Music volume); moving the volume unmutes it. Default false. */
    muted: boolean
  }
  system: {
    /**
     * PlayOut's own language (Settings > System > Language; src/shared/i18n): a language code such as "es", or ''
     * until the first start picks one from Steam's or Windows' language (main/i18n). Not the metadata language
     * (scrapers.language).
     */
    language: string
    launchAtLogin: boolean
    confirmPowerActions: boolean
    /** Closing the window hides it to the system tray instead of quitting (main/tray.ts). */
    minimizeToTray: boolean
    /**
     * Enhanced Sleep/Wake (main/sleep, docs/sleep-wake.md): the running game is frozen while the PC sleeps or the
     * screen is locked, and network adapters and fingerprint readers no longer wake the PC, which hibernates after
     * 48 hours of sleep (undone when turned off).
     */
    enhancedSleepWake: boolean
    /**
     * Wake with the Xbox button (main/controller-wake): an Xbox controller's Xbox button wakes the PC from sleep, through
     * the Xbox Wireless Adapter or a USB cable (one administrator step; undone when turned off). Off by default.
     */
    controllerWake: boolean
  }
  /** Settings > Streaming (ARCHITECTURE.md §4.13). */
  streaming: StreamingSettings
}

/** Deep partial used by updateSettings. */
export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}

// ---------------------------------------------------------------------------
// Streaming (ARCHITECTURE.md §4.13): two PlayOut PCs paired with a 4-digit PIN. The host's installed store games and
// its ROM games appear on the client; PC games stream through Moonlight (client) and Sunshine (host), ROM games can
// also be downloaded.
// ---------------------------------------------------------------------------

export type StreamResolution = 'auto' | '720' | '1080' | '1440' | '4K'

export interface StreamingSettings {
  /**
   * This PC lets paired PlayOut computers see its games, stream them (Sunshine) and download its ROMs. On for new
   * installs (0.1.129); a PC that had it off keeps it off.
   */
  hostEnabled: boolean
  /** TCP port of PlayOut's host service (pairing, library, art, ROM downloads). UDP port + 1 answers LAN discovery. */
  hostPort: number
  /** Show the games of paired hosts in this PC's library. */
  showHostGames: boolean
  /** Moonlight stream resolution; 'auto' = this PC's screen. */
  resolution: StreamResolution
  fps: 30 | 60 | 120
  /** Moonlight bitrate in kbps; 0 = Moonlight's default for the resolution and frame rate. */
  bitrateKbps: number
  /**
   * Keep the Emulation folder the same on this PC and the PCs it is paired with, both ways (everything but its roms
   * and texturepacks folders). Both PCs must have it on.
   */
  syncEmulation: boolean
  /**
   * As a host: give paired computers this PC's metadata and RetroAchievements logins (Settings › Metadata, the
   * RetroAchievements account), which they use where they have none of their own. Default true.
   */
  shareLogins: boolean
  /**
   * Keep the Library tabs (their filters, sort and order) the same on this PC and the PCs it is paired with, both
   * ways: the newest change wins (main/streaming/library-tabs-sync.ts). Each tab's search text stays per PC. With it
   * off, this PC neither sends its tabs nor takes another's. Default true.
   */
  syncLibraryTabs: boolean
  /**
   * Keep the favourites the same on this PC and the PCs it is paired with, both ways, game by game: the newest change
   * wins (main/streaming/favorites-sync.ts). Also lets a host's game shown here be made a favourite (on the host).
   * With it off, this PC neither sends its favourites nor takes another's. Default true.
   */
  syncFavorites: boolean
  /**
   * Add up the play time of the games this PC and the PCs it is paired with both have: each PC's play sessions of
   * them are copied to the other (main/streaming/playtime-sync.ts), so play time, last played, Most played and
   * Recently played count both PCs; a host's offer also says when each of its games was last played, which a client
   * shows on the games only the host has, and the last played of the store games a host does not offer passes through
   * it from one client to the others (main/streaming/recency-relay.ts). With it off, this PC neither sends its sessions
   * nor takes another's, and neither offers, passes on nor shows those dates. Default true.
   */
  syncPlaytime: boolean
}

/** A downloaded helper program (Sunshine on the host, Moonlight on the client). */
export interface StreamingToolStatus {
  state: 'missing' | 'downloading' | 'installed' | 'running' | 'error'
  version?: string
  /** 0-100 while downloading. */
  percent?: number
  error?: string
}

/** A computer this PC is paired with (a client on the host side, a host on the client side). */
export interface PairedComputer {
  id: string
  name: string
  pairedAt: string
  lastSeen?: string
  /** Last address it was reached at (client side) or connected from (host side). */
  address?: string
}

export interface StreamingHostStatus {
  enabled: boolean
  state: 'off' | 'starting' | 'ready' | 'error'
  /**
   * The host service is up, so other PCs can pair and download ROMs. Also true while Sunshine is still downloading
   * ('starting') or failed ('error'): only streaming needs Sunshine.
   */
  listening: boolean
  error?: string
  sunshine: StreamingToolStatus
  /**
   * Automatic port forwarding (UPnP) on this network. 'mapped': reachable over the internet at externalIp;
   * 'unavailable': the router has no UPnP, so only computers on the same network can connect.
   */
  portForwarding: {
    state: 'off' | 'checking' | 'mapped' | 'unavailable'
    externalIp?: string
    error?: string
  }
  /** This PC's local network addresses (for "Enter address" on a client). */
  lanAddresses: string[]
  port: number
  /** The PIN shown while a client may pair, valid until expiresAt. */
  pairing: { pin: string; expiresAt: string } | null
  /** Too many wrong PINs: pairing is refused until then. */
  lockedUntil?: string
  clients: PairedComputer[]
  /** A virtual gamepad driver (ViGEmBus) is installed, so streamed controllers work on this PC. */
  controllerDriver: boolean
  /** A client is streaming a game from this PC right now. */
  streaming: { clientName: string; gameId: string; title: string } | null
}

export interface PairedHost extends PairedComputer {
  online: boolean
  /** Addresses tried in order: the local network one, then the internet one (when the host has port forwarding). */
  lanAddress?: string
  wanAddress?: string
  port: number
  /** Games it offers (last refresh). */
  games?: number
  error?: string
  /** The Emulation folder sync with this host (absent: it has not run yet). */
  emulationSync?: EmulationSyncStatus
}

/** The Emulation folder sync with one host (client side). */
export interface EmulationSyncStatus {
  /**
   * 'waiting': not now (a game is running on one of the PCs, or the host has the sync turned off: see `message`).
   */
  state: 'syncing' | 'synced' | 'waiting' | 'error'
  /** When the last complete pass ended. */
  lastSync?: string
  /** While syncing: files done of total. */
  done?: number
  total?: number
  /** Why it waits or failed. */
  message?: string
  /** The last complete pass: files copied each way, deleted, and conflicts (the older copy went to the backups). */
  last?: {
    downloaded: number
    uploaded: number
    deleted: number
    conflicts: number
    failed: number
  }
}

/** A PlayOut host found on the local network. */
export interface DiscoveredHost {
  id: string
  name: string
  address: string
  port: number
  paired: boolean
}

export interface StreamingClientStatus {
  moonlight: StreamingToolStatus
  hosts: PairedHost[]
}

export interface StreamingStatus {
  host: StreamingHostStatus
  client: StreamingClientStatus
}

/** What a paired host offers for one game (client side). */
export interface RemoteGameInfo {
  hostId: string
  hostName: string
  /** The game's id on the host. */
  hostGameId: string
  /** Installed on the host, so it can be streamed (store games and ROM games). */
  streamable: boolean
  /** A ROM game whose files can be downloaded into this PC's ROM folder. */
  downloadable: boolean
  /** ROM games: size of every file of the ROM (cue/bin, m3u discs, folders). */
  sizeBytes?: number
  /** The host is not reachable now: this is the game as it offered it when last reached. */
  offline?: true
}

/**
 * The paired hosts' games as this PC shows them. `games`: games only a host has (id `remote:<hostId>:<hostGameId>`,
 * `installed` false, `remote` set, media served through `media://remote/...`). `alsoOnHost`: this PC's own game id ->
 * the hosts that have the same game (offered as "Stream from <host>" in its Play menu).
 */
export interface RemoteLibrary {
  games: Game[]
  alsoOnHost: Record<string, RemoteGameInfo[]>
  /**
   * A recompilation-only card's original game on the paired hosts (by this PC's id of the card): the host ROMs that
   * match the same recompilation title and can be downloaded, so the card offers Download to give the recompilation
   * the original's files. Absent or empty: none.
   */
  recompSources?: Record<string, RemoteGameInfo[]>
  updatedAt: string
}

export interface StreamSession {
  /** The game the user picked (this PC's game id or a `remote:` id). */
  gameId: string
  hostId: string
  hostName: string
  state: 'preparing' | 'pairing' | 'connecting' | 'streaming' | 'ended' | 'error'
  message?: string
}

export interface RomDownloadProgress {
  /** The `remote:` game id being downloaded. */
  gameId: string
  hostId: string
  /**
   * 'paused': stopped by pauseInstall (the game waits paused in the install queue); bytesDone / percent keep what it
   * has, and resumeInstall continues from there.
   */
  state: 'downloading' | 'paused' | 'done' | 'failed' | 'cancelled'
  bytesDone: number
  bytesTotal: number
  /** 0-100 */
  percent: number
  message?: string
  /**
   * On a 'failed' event: not a failure, the host cannot be reached and the download keeps its place in the queue
   * (`message` says "Waiting for <host> to come back online" in the user's language). The renderer goes by this flag.
   */
  hostOffline?: boolean
  /** This PC's game id once the downloaded ROM was added to the library. */
  installedGameId?: string
}

// ---------------------------------------------------------------------------
// System status / controls
// ---------------------------------------------------------------------------

export type PowerMode = 'efficiency' | 'balanced' | 'performance'
export type PowerAction = 'exit' | 'minimize' | 'sleep' | 'hibernate' | 'restart' | 'shutdown'
export type WindowsSettingsPage = 'bluetooth' | 'wifi' | 'sound' | 'display' | 'power' | 'gamepad'

export interface SystemStatus {
  battery: { present: boolean; percent: number; charging: boolean } | null
  network: {
    connected: boolean
    kind: 'wifi' | 'ethernet' | 'none'
    ssid?: string
    signal?: number
  }
  bluetooth: { available: boolean; on: boolean }
  volume: { level: number; muted: boolean } | null
  brightness: number | null
  powerMode: PowerMode | null
  updatedAt: string
}

export interface PerfSample {
  cpuPercent: number | null
  memoryUsedMb: number | null
  memoryTotalMb: number | null
  gpuPercent: number | null
  updatedAt: string
}

export interface AppInfo {
  name: string
  version: string
  userDataPath: string
  /** The user's Documents folder (the default Emulation folder is Documents\Emulation). */
  documentsPath: string
  isPackaged: boolean
  platform: string
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  /** A development run: there is no installed copy to replace. */
  | 'unsupported'

/** Where the update of PlayOut itself stands (ARCHITECTURE.md §4.9). */
export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** The version found or being installed. */
  version?: string
  /** The portable build cannot replace itself: `releaseUrl` is its way to the new version. */
  manual: boolean
  releaseUrl: string
  /** 0-100 while downloading. */
  percent?: number
  bytesDone?: number
  bytesTotal?: number
  bytesPerSecond?: number
  message?: string
}

// ---------------------------------------------------------------------------
// Events (main -> renderer)
// ---------------------------------------------------------------------------

export interface PlayOutEvents {
  'library:changed': {
    reason: 'scan' | 'update' | 'metadata' | 'session' | 'remove' | 'import'
    gameIds?: string[]
    /**
     * Games that left under one id and live on under another (a converted ROM's record follows its new file:
     * library-service rekeyRom): old id -> new id. An open game page follows its game.
     */
    movedTo?: Record<string, string>
  }
  'scan:progress': ScanProgress
  'metadata:progress': MetadataProgress
  /** The game art downloads (covers, then the remaining art), a few times a second at most; total 0 = idle. */
  'art:progress': ArtProgress
  /**
   * The install-size scan (installed folders measured, other games looked up): `done` of `total` games, `remaining`
   * = total - done. total 0 = idle. `paused`: the stores stopped answering; the scan resumes later.
   */
  'install-size:progress': {
    remaining: number
    done: number
    total: number
    paused?: boolean
    /** The game whose install folder is being added up right now (a large one takes a while). */
    current?: string
  }
  /** LaunchBox's player counts being downloaded and read, a few times a second at most; total 0 = idle. */
  'players:progress': PlayersProgress
  /** Downloading or indexing the Co-Op handlers or tools, a few times a second at most; total 0 = idle. */
  'coop:progress': CoopProgress
  /** Settings › Convert: the converter's download and the run, each file's state. */
  'convert:progress': import('./convert').ConvertStatus
  /** The Emulation folder being moved (Settings › Library), a few times a second at most; 'done' when it ended. */
  'emulation-move:progress': import('./emulation-move').EmulationMoveProgress
  /**
   * Trim Games (Settings › Library) started converting ROM games: how many, their titles, and whether they came from
   * the look at the whole library when it was switched on (else they are new to the library).
   */
  'trim:started': { count: number; titles: string[]; fromLibrary?: boolean }
  /**
   * Trim Games left ROM games as they are (a missing key or emulator, a format it cannot convert): one game's title, or
   * with `count` several games' titles for one reason.
   */
  'trim:skipped': { title: string; reason: string; count?: number }
  /** A recompilation installing / updating (main/recomp), a few times a second at most. */
  'recomp:progress': import('./recomp').RecompProgress
  /** This PC took a paired host's logins for these services (it had none of its own). */
  'streaming:logins': { hostName: string; services: string[] }
  /** The metadata cloud's sync, token or queue changed (Settings › Metadata › Cloud metadata). */
  'metadata-cloud:status': import('./metadata-cloud').MetadataCloudStatus
  /** A saved edit was published, suggested, queued or refused (a toast). */
  'metadata-cloud:notice': import('./metadata-cloud').MetadataCloudNotice
  /** DLC choices planned at install time were applied (or failed) after the install finished. */
  'steam-dlc:applied': { gameId: string; title: string; ok: boolean; error?: string }
  /** An Upgrade menu action running, done or failed for a game (main upgrades/service.ts). */
  'upgrades:progress': import('./upgrades').UpgradeProgress
  /** A PS3 game's update being checked, downloaded or installed (main/emulation/ps3-update-service.ts). */
  'ps3-update:progress': Ps3UpdateProgress
  /** Recompilations installed, removed, updated, preferred or their saves changed: re-read what is shown. */
  'recomp:changed': { ids: string[] }
  /**
   * The "Delete the original disc image?" questions waiting for an answer changed (main/recomp/image-offer.ts): the
   * renderer asks them one at a time.
   */
  'recomp:image-offers': { offers: import('./recomp').RecompImageOffer[] }
  /**
   * Disc images moved aside for a recompilation's test run changed (main/recomp/service.ts): the renderer asks the
   * ones with a verdict one at a time. `note`: a test's outcome to show (a toast), e.g. the test passed.
   */
  'recomp:held-images': {
    items: import('./recomp').RecompHeldImage[]
    note?: { ok: boolean; message: string }
  }
  /** A VR mod downloading (main/vr-mods), a few times a second at most. */
  'vr-mods:progress': import('./vr-mods').VrModProgress
  /** VR mods downloaded, updated or removed, or updates found: re-read what is shown. */
  'vr-mods:changed': { ids: string[] }
  /** A Co-Op session starting, running or ending. */
  'coop:session': CoopSessionEvent
  /** A game's PeerParty eligibility was (re)checked. */
  'peerparty:status': import('./peerparty').PeerPartyStatus
  /** The games PeerParty is offered for (Filters > L.A.N. Party), after a sweep of unscanned folders ended. */
  'peerparty:compatible': import('./peerparty').PeerPartyCompatible
  /** PeerParty downloading, checking or starting a game, a few times a second at most. */
  'peerparty:progress': import('./peerparty').PeerPartyProgress
  /** A game started or stopped running through PeerParty. */
  'peerparty:session': { session: import('./peerparty').PeerPartySession | null }
  /** The background HowLongToBeat pass, a few times a second at most; total 0 = idle. */
  'hltb:progress': HltbProgress
  /** The background Steam screenshot downloads, a few times a second at most; total 0 = idle. */
  'screenshots:progress': ScreenshotsProgress
  /** Copying the paired hosts' metadata and art into this PC, a few times a second at most; total 0 = idle. */
  'host-sync:progress': ScreenshotsProgress
  /** The emulator setup's progress (a few times a second at most; total 0 = idle). */
  'emulator-setup:progress': EmulatorSetupProgress
  /** A Steam game's screenshot list or saved thumbnails changed (an open game page shows them at once). */
  'steam-screenshots:updated': { gameId: string; items: SteamScreenshot[] }
  /** The review scores pass (review-scores.ts), a few times a second at most; total 0 = idle. */
  'ratings:progress': RatingsProgress
  'settings:changed': Settings
  /** The home button's state changed (Settings › Controls). */
  'home:status': import('./overlay').HomeButtonStatus
  /** Settings › Controls is recording a new combo: the buttons held so far, and the combo when done. */
  'home:capture': import('./overlay').ComboCaptureEvent
  /** The overlay opened or closed (both windows). */
  'overlay:state': import('./overlay').OverlayState
  /** The pads, while the in-game overlay is open (its renderer navigates with them; it has no focus). */
  'overlay:pad': import('./overlay').OverlayPadState
  /** The in-game overlay was turned off for a game (it crashed, or the overlay faulted): a toast in the main window. */
  'overlay:ingame-notice': { gameId: string; title: string; message: string }
  /** The power profile in effect changed. */
  'performance:status': import('./overlay').PerformanceStatus
  /** A memory cleanup pass started or ended, or the setting or the power helper changed (Settings › System). */
  'memory:status': import('./memory').MemoryStatus
  /** Wake with the Xbox button: its administrator step ran (Settings › System). */
  'controller-wake:status': import('./controller-wake').ControllerWakeStatus
  /** The overlay's extra tiles changed (frame limit, sync, performance overlay, Auto HDR, CPU boost, RTSS). */
  'overlay:extras': import('./overlay-extras').OverlayExtrasStatus
  'session:started': { gameId: string; startedAt: string }
  'session:ended': { gameId: string; startedAt: string; endedAt: string; minutes: number }
  'launch:error': { gameId: string; error: LaunchError }
  /** Every change of a tracked install, at most once per second per game. */
  'install:progress': InstallProgress
  /** The install queue changed (added, started, finished, removed, moved): every entry, the active one first. */
  'installs:queue': InstallQueueEntry[]
  /** Sign-in, sign-out, import start/end: the full account list. */
  'accounts:changed': AccountStatus[]
  'system:status': SystemStatus
  /** Every step of an update of PlayOut, and its download progress. */
  'update:status': UpdateStatus
  /** The RetroAchievements account's state changed (a check, a sync, a sign-out). */
  'retroachievements:status': RetroAchievementsStatus
  'window:focus': { focused: boolean }
  /** Any change of the host or client side of Streaming (tool downloads, port forwarding, pairing, hosts online). */
  'streaming:status': StreamingStatus
  /** The paired hosts' games changed (refresh, host online/offline, a client game added or removed). */
  'streaming:library': RemoteLibrary
  /** A stream starting, running or ending on this PC (client). */
  'streaming:session': StreamSession
  /** A ROM download from a host, at most a few times a second. */
  'streaming:download': RomDownloadProgress
}

export type PlayOutEventName = keyof PlayOutEvents

/**
 * "Delete from this PC" (deleteGameLocally): what happens to an installed game of this PC. `files`: a ROM's file set,
 * or a manual game's folder, goes to the Recycle Bin and the record leaves the library; `store`: the store client's own
 * uninstall starts (it asks itself) and the record stays; `uninstaller`: the game's own Add/Remove Programs uninstaller
 * starts and the record leaves the library; `remove-only`: nothing can be deleted safely (the reason says why), only
 * Remove from library is offered; `refused`: not now (running, downloading, not installed...), see `reason`.
 */
export interface LocalDeletePlan {
  gameId: string
  kind: 'files' | 'store' | 'uninstaller' | 'remove-only' | 'refused'
  /** Why the game cannot be deleted (refused / remove-only). */
  reason?: string
  /** files: what goes to the Recycle Bin; uninstaller: the program that runs. */
  paths: string[]
  /** files: bytes of `paths`, when known. */
  totalBytes?: number
  /** files: files of this ROM that another game of the library also uses; they are kept. */
  kept?: string[]
  /** store: the client's name ('Steam'). */
  storeName?: string
  /** files: a manual game's whole folder (everything inside it, saves included, goes to the Recycle Bin). */
  folder?: boolean
  /** store: 'settings' when only Windows Settings › Apps opens (Xbox), where the user uninstalls the game. */
  opens?: 'settings'
  /**
   * files, PS3 / Switch / Xbox 360 games: the game's updates and DLC in EmulationUpdates and DLC (a PS3 game's folders
   * in dev_hdd0game named after its serial; Switch / Xbox 360 files with its title id or a similar name). They go to
   * the Recycle Bin too when the delete is run with `updatesDlc` (the prompt's checkbox, ticked by default).
   */
  updatesDlc?: { paths: string[]; totalBytes?: number }
}

/** How a Steam app is played (GameMetadata.steamTags.controls). */
export interface SteamControls {
  controller: 'full' | 'partial' | null
  vr: 'only' | 'supported' | null
  /**
   * Touch screen support (Filters > Controls > Touch). Optional: no scraper sets it yet (Steam's store data read in
   * main/scrapers/steam-tags.ts is where a future source would); the Edit sheet's Touch choice (a local edit or a
   * cloud entry, MetadataEdit.controls.touch) does.
   */
  touch?: 'supported'
  /**
   * Full mouse and keyboard support alongside the controller (the Edit sheet's "Mouse & Keyboard + Controller" and
   * "All"; MetadataEdit.controls.keyboard). Optional: no scraper sets it.
   */
  keyboard?: 'full'
}

/** One PS3 game's update work, as the renderer shows it. */
export interface Ps3UpdateProgress {
  gameId: string
  title: string
  /** Started from the game menu (its result toasts there), not by the automatic pass. */
  manual: boolean
  phase: 'checking' | 'downloading' | 'installing' | 'done' | 'up-to-date' | 'failed' | 'waiting'
  /** The version being installed, or the one the game is at ('done', 'up-to-date'). */
  version: string | null
  /** downloading: bytes so far and the package's size. */
  bytes: number | null
  total: number | null
  /** failed / waiting: why (RPCS3 is open, the server cannot be reached, ...). */
  message: string | null
}

/** The result of the game menu's "Update PS3 game". */
export interface Ps3UpdateResult {
  outcome: 'installed' | 'up-to-date' | 'no-updates' | 'failed'
  /** The version the game is at now. */
  version: string | null
  message: string
}

/** What "Delete from this PC" also deletes. */
export interface LocalDeleteOptions {
  /** The game's updates and DLC (LocalDeletePlan.updatesDlc). Default false. */
  updatesDlc?: boolean
}

export interface LocalDeleteResult {
  ok: boolean
  /** User-facing outcome or error. */
  message: string
  kind?: LocalDeletePlan['kind']
  /** The record left the library (files; an uninstaller's game leaves later, once it is gone from the PC). */
  removed?: boolean
}
