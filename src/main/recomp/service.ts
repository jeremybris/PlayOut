// Recompilations (ARCHITECTURE.md §4.14): the service behind the UP button, the Recompilation page and Settings ›
// Recompilations. It owns the catalog (decomp-buddy + RecompLauncher, loaded ~20 s after start and then daily),
// matches it to the library (Game.metadata.recomp), runs installs and updates one at a time, checks installed
// recompilations for updates at start (then updates the ones set to update automatically), and launches a
// recompilation as a play session of the library game: game files placed or passed first, saves copied to and from
// <Emulation folder>/Recompilations Saves before and after, save folders searched for after install and detected
// around the first play when nobody knows them.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { promises as fs } from 'fs'
import { findMovedRecompDir } from './moved-dir'
import { homedir as osHomedir, hostname } from 'os'
import { basename, dirname, extname, join, resolve } from 'path'
import type { PlayOutApi } from '../../shared/api'
import {
  RECOMP_SAVES_FOLDER,
  isUnscannedRecomp,
  type AddedRecomp,
  type RecompSendResult,
  type AddedRecompState,
  type CloudRecomp,
  type GameFileState,
  type GameRecomps,
  type InstalledRecomp,
  type RecompBrowseEntry,
  type RecompBrowseTitle,
  type RecompCatalogStatus,
  type RecompCloudState,
  type RecompEntry,
  type RecompDeleteChoice,
  type RecompExecutables,
  type RecompHeldAnswer,
  type RecompHeldImage,
  type RecompImageOffer,
  type RecompLaunchResult,
  type RecompProgress,
  type RecompRepoCheck,
  type RecompRow,
  type RecompSaves,
  type RecompTitle,
  type RecompUnpackedFolder,
  AUTO_STARTS_BEFORE_ASK
} from '../../shared/recomp'
import type { Game, GameRecompInfo } from '../../shared/types'
import { recompAddedId, recompOnlyKey } from '../../shared/recomp-play'
import { romGameFolder } from '../emulation/rom-scanner'
import { defaultEmulationDir } from '../emulation/emulation-dir'
import { ensureSevenZip } from '../emulator-setup/sevenzip'
import { runProcess } from '../emulator-setup/run'
import type { Runner } from '../emulator-setup/types'
import type { EventBus } from '../events'
import type { LauncherService } from '../launcher/types'
import { buildSpawnCommand } from '../launcher/launcher'
import type { Logger } from '../logger'
import type { LibraryService } from '../services/library-service'
import { newHoldId, type HeldEntry } from '../services/held-files'
import type { HeldOutcome, HoldResult } from '../services/local-delete'
import {
  isInside,
  knownFolders as realKnownFolders,
  normalizePath,
  type KnownFolders
} from '../util/paths'
import type { AssetHint } from './assets'
import { isInstallerName } from './assets'
import { loadCatalog as realLoadCatalog, repoKey, withExtras, type RecompCatalog } from './catalog'
import { isPlainLine, MAX_GAME_CHARS, oneLine, readAdded, withAdded, writeAdded } from './added'
import { checkRecompRepo } from './add-validate'
import { isRecompConsole } from './consoles'
import {
  automaticExe,
  carryExeChoice,
  checkExeChoice,
  chooseExe,
  confirmExe,
  exeFullPath,
  exeUnclear,
  isExeFile,
  isUserExe,
  listExecutables,
  programOf
} from './executables'
import {
  findSetupImage,
  copyFolder,
  isFolder,
  helperExtractor,
  markerPresent,
  setupGameFolder,
  unpackedSetupFor,
  unpackSetupGame,
  UNPACKED_GAME_SETUPS,
  type ExtractImage,
  type UnpackedGameSetup
} from './game-folder'
import {
  countStart,
  folderOfferKey,
  hasDiscImage,
  imageOfferKey,
  imageStays,
  notePlayerExe,
  unpackedFolderUse
} from './image-offer'
import { isNew, readSeen, recordKnown, recordSeen, writeSeen, type SeenFile } from './seen'
import {
  adoptOldCopy,
  oldCloudSaveDir,
  readCopyMeta,
  resolveConflict,
  syncSaves,
  type CloudSyncDeps
} from './cloud'
import {
  applyCopies,
  dropMissingPaths,
  gameFileStates,
  libraryFilesFor,
  mergeProfileNeeds,
  prepareLaunch,
  readDeveloperProfile,
  verifyGameFile,
  type DeveloperProfile,
  type DigestCache,
  type VerifyResult
} from './gamefiles'
import type { CachedFetchDeps } from './http-cache'
import {
  findExe,
  installRecomp as realInstall,
  safeRecompFolder,
  safeRecompId,
  uninstallRecomp as realUninstall,
  type InstallDeps
} from './install'
import {
  buildTitleIndex,
  defaultPreferred,
  matchGameToTitle,
  recompInfo,
  sameRecompInfo,
  type TitleIndex
} from './match'
import {
  fetchReadme as realFetchReadme,
  fetchReleases as realFetchReleases,
  isNewer,
  isRepublished,
  replacesSidePiece,
  latestRelease,
  newestRelease,
  pinFor,
  toRecompRelease,
  type GhRelease
} from './releases'
import {
  expandSavePaths,
  expandSaveTemplate,
  findSaveFolders,
  isSafeSaveRoot,
  resolveSavePaths,
  snapshotSaveCandidates,
  toSaveTemplate,
  usableSaveTemplates,
  detectSaveFolders,
  type SaveContext,
  type SaveSnapshot
} from './saves'
import {
  createRecompState,
  defaultCloudState,
  recompPlayoutDir,
  resolveRecompRoot,
  type RecompHeldRecord,
  type RecompImageOfferRecord,
  type RecompManifest,
  type RecompUnpackedFolderRecord
} from './state'
import { displayTitle } from '../util/game-title'
import { tMain } from '../i18n'
import {
  createKeyedLock,
  folderNamesWithin,
  machineIdOf,
  pathThereWithin
} from '../save-copy/shared'

/** The recompilation methods of the API (the IPC handlers call these as they are). */
export type RecompMethods = Pick<
  PlayOutApi,
  | 'getGameRecomps'
  | 'setPreferredRecomp'
  | 'installRecomp'
  | 'updateRecomp'
  | 'setRecompVersion'
  | 'updateAllRecomps'
  | 'checkRecompUpdates'
  | 'uninstallRecomp'
  | 'launchRecomp'
  | 'getRecompReleases'
  | 'getRecompReadme'
  | 'pickRecompGameFile'
  | 'setRecompGameFile'
  | 'listRecompExecutables'
  | 'setRecompExecutable'
  | 'pickRecompExecutable'
  | 'getRecompSettings'
  | 'browseRecomps'
  | 'setRecompFavorite'
  | 'addRecompToLibrary'
  | 'refreshRecompCatalog'
  | 'setRecompAutoUpdate'
  | 'setRecompSavePaths'
  | 'addRecompSaveFolder'
  | 'getRecompSaves'
  | 'findRecompSaveFolders'
  | 'setRecompCloud'
  | 'syncRecompSaves'
  | 'resolveRecompConflict'
  | 'openRecompFolder'
  | 'getRecompImageOffers'
  | 'answerRecompImageOffer'
  | 'askRecompImageDelete'
  | 'getRecompHeldImages'
  | 'answerRecompHeldImage'
  | 'checkRecompRepo'
  | 'addRecomp'
  | 'removeAddedRecomp'
  | 'readRecompClipboard'
>

/**
 * The metadata cloud as the browser's Add uses it (MetadataCloudService): PlayOut's own list of recompilations, and
 * sending one the user added (the owner publishes it, anyone else suggests it).
 */
export interface RecompCloudLink {
  cloudRecomps(): CloudRecomp[]
  onCloudRecomps(listener: () => void): () => void
  submitRecomp(input: {
    id: string
    repo: string
    game: string
    systemId: string
    blurb?: string
  }): Promise<RecompSendResult>
  withdrawRecomp(id: string): void
  onRecompDelivered(
    listener: (id: string, state: AddedRecompState, prUrl?: string, refused?: string) => void
  ): () => void
  /** Told when adds start being sent (Suggest my edits switched on, the owner's token works): the waiting ones go. */
  onSendingRecomps?(listener: () => void): () => void
  /** Whether an add is sent at all (the owner, or Suggest my edits on). */
  sendsRecomps(): boolean
  /** Ids of the recompilations waiting in its queue. */
  queuedRecompIds(): string[]
}

export interface RecompService extends RecompMethods {
  /**
   * The recompilations of a game this PC does not keep in its library (a host-only game shown for Download), matched
   * with this PC's catalogs: its metadata.recomp. Null = none; undefined = the catalogs are not loaded yet.
   */
  recompForGame(game: Game): GameRecompInfo | null | undefined
  /** Resolve the install folder, then load the catalog after `startDelayMs` and daily (update check, auto-updates). */
  start(): void
  /** The Recompilations folder (resolved once; the VR Mods folder sits beside it). */
  installRoot(): Promise<string>
  /** The install folder of an installed recompilation, else null. */
  installedDir(id: string): Promise<string | null>
  /** Match the library again soon (after a library change; debounced). */
  kick(): void
  /**
   * A game's favourite changed in the library (LibraryService.onUserFavorite): a recompilation's own card (Add to
   * library) carries it to the recompilation's favourite in the browser.
   */
  noteLibraryFavorite(gameId: string): void
  /**
   * The Emulation folder was moved with its files (Settings › Library): the saves' last-synced hashes still describe
   * the copies, now in the new folder, so they are kept (a folder chosen without moving forgets them: manifestFor).
   */
  noteEmulationFolderMoved(from: string, to: string): Promise<void>
  dispose(): void
}

/** What the service needs of the library (LibraryService, or a fake in tests). */
export type RecompLibrary = Pick<
  LibraryService,
  'games' | 'getGame' | 'applyMetadata' | 'clearMetadataField'
>

export interface RecompDialogs {
  chooseFile(options: {
    title: string
    filters?: { name: string; extensions: string[] }[]
    /** The folder (or file) the picker opens on. */
    defaultPath?: string
  }): Promise<string | null>
  chooseFolder(title: string): Promise<string | null>
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * A library ROM game's disc image on disk (main/services/local-delete.ts does the file work, with its guards): what
 * would go to the Recycle Bin, and moving it there for a recompilation (the card stays: Game.romRemoved).
 * `recompRunning`: the game "running" now is this recompilation (it does not read the image), not an emulator.
 */
export interface OriginalImageFiles {
  plan(
    gameId: string,
    options: { recompRunning: boolean }
  ): Promise<{ paths: string[]; totalBytes: number | null } | { refusal: string }>
  trash(
    gameId: string,
    recompId: string,
    options: { recompRunning: boolean }
  ): Promise<{ ok: boolean; message: string }>
  /**
   * A game folder PlayOut unpacked for a setup program ("Delete the unpacked game folder"): its size, or why the
   * folder guards refuse it. Absent: the folder is never offered.
   */
  folderPlan?(dir: string): Promise<{ totalBytes: number | null } | { refusal: string }>
  /** Move that folder to the Recycle Bin (never deleted for good). */
  trashFolder?(dir: string): Promise<{ ok: boolean; message: string }>
  /**
   * The test run after Delete (services/held-files.ts): with hold, release and restore, a Delete answer moves the
   * image (holdFolder: the unpacked folder) aside, records it first through `beforeMove`, and keeps the card; the
   * recompilation is then started, and the files go to the Recycle Bin (release) once it runs, or back (restore).
   * Absent: a Delete answer moves them to the Recycle Bin at once, untested.
   */
  hold?(
    gameId: string,
    recompId: string,
    holdId: string,
    options: { recompRunning: boolean; beforeMove(entries: HeldEntry[]): Promise<unknown> }
  ): Promise<HoldResult>
  holdFolder?(
    dir: string,
    holdId: string,
    options: { beforeMove(entries: HeldEntry[]): Promise<unknown> }
  ): Promise<HoldResult>
  release?(entries: HeldEntry[], holdId: string): Promise<HeldOutcome>
  restore?(
    entries: HeldEntry[],
    holdId: string,
    card: { gameId: string; image: string } | null
  ): Promise<HeldOutcome>
}

/**
 * Library cards that are a recompilation alone (shared/recomp-play recompOnlyKey): made when a recompilation is
 * installed and its original game is not in the library, gone once none of the game's recompilations is installed.
 */
export interface RecompGames {
  /** Add the card (with art from the recompilation's catalog entries); null when it was there already. */
  add(input: {
    titleKey: string
    title: string
    platformId: string
    recomp: GameRecompInfo
    art: { cover: string | null; hero: string | null; icon: string | null }
  }): string | null
  /** Take the card out of the library (its cached art too). */
  remove(gameId: string): void
  /** The original game is in the library now: the card's play history moves to it and the card goes. */
  absorb(fromId: string, intoId: string): void
  /**
   * Add a recompilation's own card (the browser's Add to library), not installed, whatever else is in the library;
   * the card's id (also when it was there already).
   */
  addEntry?(input: {
    recompId: string
    title: string
    platformId: string
    recomp: GameRecompInfo
    favorite: boolean
    description: string
    developer: string
    art: { cover: string | null; hero: string | null; icon: string | null }
  }): string
  /** Set a card's favourite (a recompilation favourited in the browser). */
  setFavorite?(gameId: string, favorite: boolean): void
}

export interface RecompServiceDeps {
  userData: string
  /** The folder PlayOut.exe is in (installs go to <exeDir>/Recompilations when it is writable). */
  exeDir: string
  library: RecompLibrary
  launcher: Pick<LauncherService, 'track' | 'running'>
  events: Pick<EventBus, 'emit'>
  dialog: RecompDialogs
  /** Open a folder in Explorer (rejects with the shell's message). */
  openPath(path: string): Promise<void>
  /** The disc images behind the "Delete the original disc image?" question (image-offer.ts); absent = never asked. */
  originalImage?: OriginalImageFiles
  /** Library cards for installed recompilations whose game is not in the library; absent = none are made. */
  recompGames?: RecompGames
  /** The metadata cloud (PlayOut's list of recompilations, sending the ones added here); absent = local only. */
  cloud?: RecompCloudLink
  /** Move a folder to the Recycle Bin (Remove an added recompilation and uninstall it); absent = deleted. */
  trash?: (path: string) => Promise<void>
  /** The clipboard's text (the Add dialog's Paste). */
  clipboardText?: () => string | Promise<string>
  log: Logger
  /** The user's Documents folder (it may be redirected to OneDrive). */
  documents?: string
  /**
   * The Emulation folder in use (Settings › Library; default <userData>/Emulation): save copies live in its
   * "Recompilations Saves" folder.
   */
  emulationDir?: () => string
  // --- seams (tests) ---
  /** The Recompilations folder (default: resolveRecompRoot). */
  root?: string
  fetch?: typeof fetch
  loadCatalog?: (deps: CachedFetchDeps & { force?: boolean }) => Promise<RecompCatalog>
  fetchReleases?: typeof realFetchReleases
  fetchReadme?: typeof realFetchReadme
  install?: typeof realInstall
  uninstall?: typeof realUninstall
  run?: Runner
  spawn?: SpawnFn
  knownFolders?: () => KnownFolders
  /** This PC's name in the save copies (default: the computer name). */
  machine?: string
  /** This install's own id in the save copies (default: save-copy/shared.ts machineIdOf(userData)). */
  machineId?: string
  now?: () => Date
  /**
   * Whether this PC is online (Electron's net.isOnline). At start the catalogs are checked for new recompilations
   * when online; offline, they are checked again every `onlineRetryMs` until a check reaches every catalog.
   */
  isOnline?: () => boolean
  /** Catalog load after start (default 10 s) and then every `refreshEveryMs` (default a day). */
  startDelayMs?: number
  refreshEveryMs?: number
  /** While the start-up check has not reached every catalog, it is tried again this often (default 2 min). */
  onlineRetryMs?: number
  /** How often the end of a recompilation's play session is checked after its process exits (default 3 s). */
  sessionPollMs?: number
  /** Library changes are matched this long after the last one (default 1.5 s). */
  matchDebounceMs?: number
  /**
   * The test run after Delete: the recompilation's play session must last at least this long and end with a normal
   * exit (default IMAGE_TEST_MS); its end is checked every `imageTestPollMs` (default 1 s).
   */
  imageTestMs?: number
  imageTestPollMs?: number
  /**
   * PlayOut's Xbox image helper (resources\xbox\PlayOutXbox.exe): a setup program that takes the game unpacked
   * (game-folder.ts) gets the player's disc image unpacked with it first.
   */
  xboxHelper?: string
  /** Seams (tests): the user's home folder, the image unpacker and the table of such setup programs. */
  homedir?: () => string
  extractXboxImage?: ExtractImage
  unpackedGameSetups?: UnpackedGameSetup[]
}

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * The test run after Delete: a recompilation that ran at least this long and then closed normally (exit code 0) runs
 * without its disc image (one that closed before, or with an error, did not: a crash, or it refused to run without it).
 * Still running proves nothing (it may wait on a "disc image not found" box): the verdict waits for the game to close.
 */
export const IMAGE_TEST_MS = 20_000
/** Game files bigger than this are not hashed on the page or at launch (an 8 GB disc would hold the start up). */
const VERIFY_LIMIT_BYTES = 1024 ** 3
/** A play session is waited for at most this long before the after-play work runs anyway. */
const SESSION_WAIT_MAX_MS = 12 * 60 * 60 * 1000

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const sameTag = (a: string, b: string): boolean => {
  const n = (t: string): string =>
    t
      .trim()
      .toLowerCase()
      .replace(/^v(?=\d)/, '')
  return n(a) === n(b)
}

/** Host and repo of an entry id ("github:owner/repo#slug"), for an installed entry the catalog no longer lists. */
export function stubEntry(id: string, installed: InstalledRecomp | null): RecompEntry {
  const m = /^(github|gitlab|codeberg):([^#]+)/.exec(id)
  const host = (m?.[1] ?? 'github') as RecompEntry['host']
  const repo = m?.[2] ?? id
  const base = {
    github: 'https://github.com',
    gitlab: 'https://gitlab.com',
    codeberg: 'https://codeberg.org'
  }[host]
  const name = repo.split('/').pop() ?? repo
  return {
    id,
    name,
    game: name,
    systemId: 'other',
    console: '',
    host,
    repo,
    repoUrl: `${base}/${repo}`,
    author: repo.split('/')[0] ?? '',
    blurb: '',
    description: '',
    features: [],
    tags: [],
    latestTag: installed?.tag ?? null,
    released: null,
    downloadBytes: null,
    stars: null,
    downloads: null,
    license: null,
    completeness: null,
    recommended: false,
    assetPattern: installed?.asset ?? null,
    exe: autoExeOf(installed),
    installer: autoExeOf(installed) ? isInstallerName(autoExeOf(installed)!) : false,
    scannedSha256: null,
    needs: [],
    setupNotes: [],
    savePaths: [],
    iconUrl: null,
    coverUrl: null,
    heroUrl: null,
    archived: false,
    sources: []
  }
}

/** PlayOut's own pick of the program of an install (not the one the user chose instead). */
function autoExeOf(installed: InstalledRecomp | null): string | null {
  if (!installed) return null
  return installed.exeChosen === 'user' ? (installed.autoExe ?? null) : installed.exe
}

/** The asset hint for an entry (and what is installed of it). */
function hintOf(entry: RecompEntry, installed: InstalledRecomp | null): AssetHint {
  return {
    pattern: entry.assetPattern,
    previousName: installed?.asset ?? null,
    previousTag: installed?.tag ?? null
  }
}

/**
 * Whether the installed program is the project's setup program (it is run, not tracked as play). A program the user
 * chose is the game (started and tracked as play), unless it is the very setup program PlayOut picked.
 */
function isInstallerRecord(entry: RecompEntry, installed: InstalledRecomp): boolean {
  if (isUserExe(installed)) {
    const auto = installed.autoExe ?? null
    if (!auto) return false
    const same =
      normalizePath(exeFullPath(installed, installed.exe!)) ===
      normalizePath(exeFullPath(installed, auto))
    return same && isInstallerRecord(entry, { ...installed, exe: auto, exeChosen: undefined })
  }
  return (
    !!installed.exe &&
    (isInstallerName(installed.exe) || (entry.installer && installed.releaseFiles.length <= 1))
  )
}

/**
 * A game as the catalog match reads it: a card whose disc image went to the Recycle Bin for its recompilation
 * (Game.romRemoved) is matched by its image's name as before, so it keeps its recompilation.
 */
function matchable(game: Game): Game {
  return game.romRemoved && !game.romPath ? { ...game, romPath: game.romRemoved.romPath } : game
}

export function createRecompService(deps: RecompServiceDeps): RecompService {
  const { library, launcher, events, log } = deps
  const now = (): Date => deps.now?.() ?? new Date()
  const loadCatalog = deps.loadCatalog ?? realLoadCatalog
  const fetchReleases = deps.fetchReleases ?? realFetchReleases
  const fetchReadme = deps.fetchReadme ?? realFetchReadme
  const install = deps.install ?? realInstall
  const uninstall = deps.uninstall ?? realUninstall
  const spawn: SpawnFn = deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, options))
  const folders = deps.knownFolders ?? realKnownFolders
  const emulationDir = (): string =>
    resolve(deps.emulationDir?.() ?? defaultEmulationDir(deps.userData))
  const savesRoot = (): string => join(emulationDir(), RECOMP_SAVES_FOLDER)
  const machine = deps.machine ?? hostname()
  let machineId = deps.machineId
  const ownId = (): string => (machineId ??= machineIdOf(deps.userData))
  const controller = new AbortController()
  const httpCacheDir = join(deps.userData, 'cache', 'recomp')
  const httpCache = (): CachedFetchDeps => ({
    dir: httpCacheDir,
    fetch: deps.fetch,
    log,
    signal: controller.signal
  })

  let disposed = false
  let rootPromise: Promise<string> | null = null
  let stateObj: ReturnType<typeof createRecompState> | null = null
  /**
   * The catalog in use: the loaded one (baseCatalog) with PlayOut's list and this PC's adds laid in (withExtras).
   * Whether the catalogs were loaded is always asked of baseCatalog: the adds alone are not a loaded catalog.
   */
  let catalog: RecompCatalog | null = null
  /** The catalogs as loaded (decomp-buddy + RecompLauncher). */
  let baseCatalog: RecompCatalog | null = null
  /** The recompilations added in the browser on this PC (recomp-added.json); read on first use. */
  let added: AddedRecomp[] = []
  let addedRead: Promise<void> | null = null
  /** The last successful Check of each repository (Add uses what it found). */
  const checks = new Map<string, Extract<RecompRepoCheck, { ok: true }>>()
  let index: TitleIndex | null = null
  /** Entry id -> the key of the title it is in. */
  let titleOfEntry = new Map<string, string>()
  let catalogJob: Promise<RecompCatalog> | null = null
  /** The installed entries and preferred versions as the last library match read them (recompForGame). */
  let knownInstalled: string[] = []
  let knownPreferred: Record<string, string> = {}
  let refreshing = false
  /** Recompilations seen in complete catalog checks (the browser's "new" marks); read on first use. */
  const seenFile = join(deps.userData, 'recomp-seen.json')
  let seen: SeenFile | null = null
  let seenRead: Promise<SeenFile | null> | null = null
  /** A catalog check reached every catalog this session (the start-up check is retried until one does). */
  let checkedOnline = false
  /** Installed entry id -> the newer tag found by the last update check. */
  const updates = new Map<string, string>()
  /** Installed entry id -> what the last release check knew of the version in use (Settings › Recompilations). */
  const releaseInfo = new Map<string, NonNullable<RecompRow['release']>>()
  /** Installs / updates running or queued (the last report of each). */
  const progress = new Map<string, RecompProgress>()
  let queueTail: Promise<void> = Promise.resolve()
  /** Recompilations being played: entry id -> the library game. */
  const playing = new Map<string, string>()
  /** Recompilations whose start is being prepared (game files, save copy); reserved before the first await. */
  const launching = new Set<string>()
  /** Setup programs started and not exited yet (a setup that takes the game unpacked reads that folder meanwhile). */
  const setupRunning = new Set<string>()
  /**
   * Unpacked game folders (normalized) a Delete answer is checking and moving to the Recycle Bin: no start of a
   * recompilation whose setup uses one gets in from the check until the folder has moved (answerImageOffer).
   */
  const deletingFolders = new Set<string>()
  /** Being started or played: its folder and saves are in use. */
  const inUse = (id: string): boolean => playing.has(id) || launching.has(id)
  /** Save copies are serialized per recompilation. */
  const withLock = createKeyedLock()
  const digestCache: DigestCache = new Map()
  /** Developer profiles (recomplauncher.json) by "<id>|<updatedAt>". */
  const profiles = new Map<string, Promise<DeveloperProfile | null>>()
  /** The one-time move of the save copies to the Emulation folder (see migrateSaves). */
  let migration: Promise<void> | null = null
  let dirsChecked: Promise<void> | null = null
  /** The titles whose original game was in the library at the last match (null before the first). */
  let originalTitles: Set<string> | null = null
  const timers: ReturnType<typeof setTimeout>[] = []
  /** Listeners to drop on dispose (the metadata cloud's). */
  const unsubscribe: (() => void)[] = []
  /** The start-up check's next retry (see start()). */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let matchTimer: ReturnType<typeof setTimeout> | null = null
  let matching: Promise<void> | null = null
  let matchAgain = false

  // --- basics -----------------------------------------------------------------------------------------------------

  function root(): Promise<string> {
    rootPromise ??= deps.root
      ? fs.mkdir(deps.root, { recursive: true }).then(() => deps.root as string)
      : resolveRecompRoot(deps.exeDir, deps.userData)
    return rootPromise
  }

  async function state(): Promise<ReturnType<typeof createRecompState>> {
    stateObj ??= createRecompState(await root())
    migration ??= migrateSaves(stateObj).catch((err) => {
      migration = null
      log.warn('recomp: the save copies could not be switched to the Emulation folder yet', err)
    })
    await migration
    dirsChecked ??= repairMovedDirs(stateObj).then(
      () => undefined,
      (err) => log.warn('recomp: could not check the recompilation folders', err)
    )
    await dirsChecked
    return stateObj
  }

  /**
   * Installed recompilations whose folder was renamed or moved by hand inside the Recompilations folder: their record
   * points at the folder found now (Open folder, Play, sizes and Delete go there). `only` limits it to one id.
   */
  async function repairMovedDirs(
    st: ReturnType<typeof createRecompState>,
    only?: string
  ): Promise<boolean> {
    const m = await st.read()
    const rootDir = await root()
    const found = new Map<string, string>()
    for (const [id, rec] of Object.entries(m.installed)) {
      if (only && id !== only) continue
      const claimed = Object.entries(m.installed)
        .filter(([other]) => other !== id)
        .map(([, r]) => found.get(r.id) ?? r.dir)
      const dir = await findMovedRecompDir(rec, rootDir, [...claimed, ...found.values()])
      if (dir) found.set(id, dir)
    }
    if (!found.size) return false
    await st.update((mm) => {
      for (const [id, dir] of found) {
        const r = mm.installed[id]
        if (!r) continue
        log.info(`recomp: ${id}'s folder ${r.dir} is gone; it is now ${dir}`)
        r.dir = dir
      }
    })
    changed([...found.keys()])
    return true
  }

  /**
   * Once, when the save copies moved from a chosen cloud folder to the Emulation folder: every installed recompilation
   * copies its saves (switched on), and what was last synced with the old cloud copy is forgotten — the first copy
   * then only copies when a side is empty or both are equal, and anything else is a conflict for the user. The old
   * cloud copy itself is adopted later, per recompilation (syncNow).
   */
  async function migrateSaves(st: ReturnType<typeof createRecompState>): Promise<void> {
    if ((await st.read()).savesMigrated) return
    await st.update((m) => {
      if (m.savesMigrated) return
      for (const r of Object.values(m.installed))
        r.cloud = {
          ...r.cloud,
          enabled: true,
          syncedHash: null,
          pending: false,
          error: null,
          conflict: null
        }
      m.savesMigrated = true
    })
  }

  const changed = (ids: string[]): void => events.emit('recomp:changed', { ids })

  function report(p: RecompProgress): void {
    progress.set(p.id, p)
    events.emit('recomp:progress', p)
  }

  const busy = (id: string): boolean => {
    const p = progress.get(id)
    return !!p && p.phase !== 'done' && p.phase !== 'failed'
  }

  function gameOf(gameId: string): Game {
    const game = library.getGame(gameId)
    if (!game) throw new Error('Unknown game')
    return game
  }

  function entryOf(id: string, installed: InstalledRecomp | null): RecompEntry | null {
    return catalog?.entries.get(id) ?? (installed ? stubEntry(id, installed) : null)
  }

  async function installedOf(id: string): Promise<InstalledRecomp | null> {
    return (await (await state()).read()).installed[id] ?? null
  }

  async function requireInstalled(id: string): Promise<InstalledRecomp> {
    let rec = await installedOf(id)
    if (!rec) throw new Error(tMain('mainRecomp.notInstalled'))
    // Its folder was renamed or moved since PlayOut started: find it again.
    if (
      !(await fs.stat(rec.dir).catch(() => null))?.isDirectory() &&
      (await repairMovedDirs(await state(), id))
    )
      rec = (await installedOf(id)) ?? rec
    return rec
  }

  function profileOf(installed: InstalledRecomp): Promise<DeveloperProfile | null> {
    const key = `${installed.id}|${installed.updatedAt}|${installed.dir}`
    let p = profiles.get(key)
    if (!p) {
      p = readDeveloperProfile(installed.dir).catch(() => null)
      profiles.set(key, p)
    }
    return p
  }

  /** The entry as the installed release describes itself (its recomplauncher.json needs replace the catalog's). */
  async function effectiveEntry(
    id: string,
    installed: InstalledRecomp | null
  ): Promise<RecompEntry | null> {
    const entry = entryOf(id, installed)
    if (!entry || !installed) return entry
    const profile = await profileOf(installed)
    return profile?.needs.length
      ? { ...entry, needs: mergeProfileNeeds(entry.needs, profile.needs) }
      : entry
  }

  function saveCtx(installed: InstalledRecomp): SaveContext {
    return {
      install: installed.dir,
      folders: folders(),
      ...(deps.documents ? { documents: deps.documents } : {})
    }
  }

  // --- catalog and matching ---------------------------------------------------------------------------------------

  /** The catalog in use again: the loaded one with PlayOut's list and this PC's adds (an empty one before a load). */
  function compose(): void {
    const base: RecompCatalog = baseCatalog ?? {
      entries: new Map(),
      titles: new Map(),
      byRepo: new Map(),
      fetchedAt: { 'decomp-buddy': null, recomplauncher: null },
      offline: []
    }
    const cloudList = deps.cloud?.cloudRecomps() ?? []
    if (!baseCatalog && !cloudList.length && !added.length) return
    setCatalog(withExtras(base, { cloud: cloudList, user: added }))
  }

  async function loadAdded(): Promise<void> {
    addedRead ??= readAdded(deps.userData).then((list) => {
      added = list
      compose()
    })
    return addedRead
  }

  /** Save the list of adds and use it. */
  async function saveAdded(next: AddedRecomp[]): Promise<void> {
    added = next
    await writeAdded(deps.userData, next)
    compose()
  }

  /**
   * Added recompilations PlayOut's list carries now (approved): their local copy goes, the list's entry (same id, so
   * an install keeps working) takes over.
   */
  async function tidyAdded(): Promise<void> {
    const listed = new Set((deps.cloud?.cloudRecomps() ?? []).map((r) => r.id))
    const keep = added.filter((a) => !listed.has(a.id))
    if (keep.length === added.length) return
    const gone = added.filter((a) => listed.has(a.id))
    for (const a of gone) log.info(`recomp: ${a.repo} is in PlayOut's list now`)
    // Added on this PC: never marked new here once PlayOut's list carries it.
    await noteKnown(gone.map((a) => a.id))
    await saveAdded(keep)
  }

  /**
   * An installed recompilation added here (or from PlayOut's list) that a catalog now lists under another id (one game
   * of a multi-game repository, "#slug"): when the catalog has exactly one entry for that repository, the install is
   * filed under it. Several: it stays as it is (shown as installed under its own id).
   */
  async function rekeyInstalls(): Promise<void> {
    if (!baseCatalog) return
    const ours = new Set([
      ...added.map((a) => a.id),
      ...(deps.cloud?.cloudRecomps() ?? []).map((c) => c.id)
    ])
    const st = await state()
    const m = await st.read()
    const moves: [string, string][] = []
    for (const id of Object.keys(m.installed)) {
      if (id.includes('#') || baseCatalog.entries.has(id)) continue
      const repo = /^github:(.+)$/.exec(id)?.[1]
      if (!repo || !ours.has(id)) continue
      const there = baseCatalog.byRepo.get(repoKey('github', repo)) ?? []
      if (there.length === 1 && there[0] !== id && !m.installed[there[0]!])
        moves.push([id, there[0]!])
    }
    if (!moves.length) return
    await st.update((mm) => {
      for (const [from, to] of moves) {
        const rec = mm.installed[from]
        if (!rec || mm.installed[to]) continue
        mm.installed[to] = { ...rec, id: to }
        delete mm.installed[from]
        for (const [k, v] of Object.entries(mm.preferred)) if (v === from) mm.preferred[k] = to
        mm.favorites = mm.favorites.map((f) => (f === from ? to : f))
        log.info(`recomp: ${from} is listed as ${to} now; its install moved with it`)
      }
    })
    changed(moves.flat())
  }

  function setCatalog(c: RecompCatalog): void {
    catalog = c
    index = buildTitleIndex(c)
    const map = new Map<string, string>()
    for (const t of c.titles.values()) for (const id of t.entries) map.set(id, t.key)
    titleOfEntry = map
  }

  /**
   * Load the catalog (`force` revalidates the cached copies), then match the library. A call without `force` shares
   * a load that is still running; a finished load is never handed out again, so later calls load afresh.
   */
  function loadNow(force: boolean): Promise<RecompCatalog> {
    if (catalogJob && !force) return catalogJob
    const job = (async () => {
      refreshing = true
      try {
        const c = await loadCatalog({ ...httpCache(), force })
        await loadAdded()
        // An empty answer (every source offline, nothing cached) never replaces a catalog in use.
        if (c.entries.size > 0 || !baseCatalog) baseCatalog = c
        else baseCatalog = { ...baseCatalog, offline: c.offline }
        compose()
        // A forced check that reached at least one catalog ends the start-up retries (the daily check covers a
        // catalog that stays unreachable); "new" marks need every catalog.
        if (force && c.entries.size > 0 && c.offline.length < 2) checkedOnline = true
        // PlayOut's list counts as a catalog for "new"; this PC's own adds never do.
        if (c.entries.size > 0 && c.offline.length === 0)
          await noteSeen([
            ...c.entries.keys(),
            ...(deps.cloud?.cloudRecomps() ?? []).map((r) => r.id)
          ])
        await rekeyInstalls().catch((err) =>
          log.warn('recomp: could not move installs to their catalog entries', err)
        )
        log.info(
          `recomp: catalog has ${c.entries.size} recompilation(s) in ${c.titles.size} title(s)${c.offline.length ? ` (offline: ${c.offline.join(', ')})` : ''}`
        )
        await matchAll()
        return catalog!
      } finally {
        refreshing = false
      }
    })()
    catalogJob = job
    const settle = (): void => {
      if (catalogJob === job) catalogJob = null
    }
    job.then(settle, settle)
    return job
  }

  /** Catalog entries marked new (0 until the seen file was read). */
  function newCount(): number {
    if (!catalog || !seen) return 0
    const at = now()
    let n = 0
    for (const [id, e] of catalog.entries)
      if (!e.sources.includes('user') && isNew(seen, id, at)) n++
    return n
  }

  async function loadSeen(): Promise<SeenFile | null> {
    seenRead ??= readSeen(seenFile).then((s) => (seen ??= s))
    return seenRead
  }

  /** Record recompilations this PC added as known since the baseline (never marked new here). */
  async function noteKnown(ids: string[]): Promise<void> {
    if (!ids.length) return
    try {
      await loadSeen()
      const next = recordKnown(seen, ids)
      if (!next) return
      seen = next
      await writeSeen(seenFile, next)
    } catch (err) {
      log.warn('recomp: could not record the added recompilations as seen', err)
    }
  }

  /** Record the entries of a complete catalog check (new ones are stamped now). */
  async function noteSeen(ids: Iterable<string>): Promise<void> {
    try {
      await loadSeen()
      const before = seen ? Object.keys(seen.ids).length : 0
      const next = recordSeen(seen, ids, now().toISOString())
      const added = Object.keys(next.ids).length - before
      if (added === 0 && seen) return
      seen = next
      await writeSeen(seenFile, next)
      if (before > 0 && added > 0) log.info(`recomp: ${added} new recompilation(s) in the catalogs`)
    } catch (err) {
      log.warn('recomp: could not record the catalog entries seen', err)
    }
  }

  async function ensureCatalog(): Promise<RecompCatalog | null> {
    // An empty catalog (offline at start, nothing cached) is not a loaded one: try again. This PC's adds alone are
    // not one either.
    if (baseCatalog && baseCatalog.entries.size > 0 && catalog) return catalog
    try {
      return await loadNow(false)
    } catch (err) {
      log.warn('recomp: the catalog could not be loaded', err)
      return catalog
    }
  }

  function titleForGame(game: Game): RecompTitle | null {
    if (!catalog || !index || game.remote) return null
    const key = game.metadata.recomp?.titleKey
    const stored = key ? catalog.titles.get(key) : undefined
    return stored ?? matchGameToTitle(matchable(game), catalog, index)
  }

  /** Write metadata.recomp on every matched game (and remove it from games no longer matched). */
  async function matchAll(): Promise<void> {
    // Never with this PC's adds alone: matching takes recompilations off every game the catalog does not list.
    if (!catalog || !index || !baseCatalog || baseCatalog.entries.size === 0 || disposed) return
    const m = await (await state()).read()
    const installedIds = Object.keys(m.installed)
    knownInstalled = installedIds
    knownPreferred = { ...m.preferred }
    const nowIso = now().toISOString()
    const changedIds: string[] = []
    // The recompilations' own cards (dealt with below), and the library's other games of each title.
    const ownCards: Game[] = []
    const addedCards: Game[] = []
    const gameOfTitle = new Map<string, string>()
    for (const game of library.games()) {
      if (game.remote) continue
      if (recompOnlyKey(game)) {
        ownCards.push(game)
        continue
      }
      // A recompilation added from the browser: its card is that recompilation's (syncAddedCards), never matched.
      if (recompAddedId(game)) {
        addedCards.push(game)
        continue
      }
      const title = matchGameToTitle(matchable(game), catalog, index)
      if (!title) {
        if (game.metadata.recomp && library.clearMetadataField(game.id, 'recomp', { quiet: true }))
          changedIds.push(game.id)
        continue
      }
      // The game is in the library as something Play can start the recompilation from: installed, kept for its
      // recompilation, or a ROM card (an owned-only store game that is not installed does not count).
      if (game.installed || game.romRemoved || game.source === 'rom')
        if (!gameOfTitle.has(title.key) || game.installed) gameOfTitle.set(title.key, game.id)
      const info = recompInfo(title, installedIds, m.preferred[title.key] ?? null, nowIso)
      if (sameRecompInfo(game.metadata.recomp, info)) continue
      library.applyMetadata(
        game.id,
        { metadata: { recomp: info } },
        { overwrite: true, quiet: true }
      )
      changedIds.push(game.id)
    }
    if (changedIds.length) {
      events.emit('library:changed', { reason: 'metadata', gameIds: changedIds })
      log.info(`recomp: ${changedIds.length} game(s) had their recompilations change`)
    }
    const addedKeys = syncAddedCards(addedCards, installedIds, nowIso)
    const arrived = syncOwnCards(
      ownCards,
      gameOfTitle,
      installedIds,
      m.preferred,
      nowIso,
      addedKeys
    )
    // A title with an added card whose original game came into the library since the last match (downloaded from a
    // paired PC): its installed recompilation waits for two starts before the disc image question too.
    const withOriginal = new Set(gameOfTitle.keys())
    if (originalTitles)
      for (const game of addedCards) {
        const id = recompAddedId(game)!
        const key = game.metadata.recomp?.titleKey
        if (key && withOriginal.has(key) && !originalTitles.has(key) && installedIds.includes(id))
          arrived.push(id)
      }
    originalTitles = withOriginal
    // A recompilation-only game's original arrived (downloaded from a paired PC): the disc image question waits for two
    // starts with it, whatever the recompilation's earlier starts were.
    if (arrived.length)
      await (
        await state()
      ).update((mm) => {
        for (const id of arrived) {
          const r = mm.installed[id]
          if (r) r.imageAskAfter = AUTO_STARTS_BEFORE_ASK
        }
      })
  }

  /**
   * Recompilations added to the library from the browser: each card keeps its one recompilation (installed or not, so
   * Play starts it once installed, Install before). Returns their title keys, by card.
   */
  function syncAddedCards(
    addedCards: Game[],
    installedIds: string[],
    nowIso: string
  ): Map<string, string> {
    const keys = new Map<string, string>()
    for (const game of addedCards) {
      const id = recompAddedId(game)!
      const key = titleOfEntry.get(id) ?? game.metadata.recomp?.titleKey
      if (!key) continue
      // It stands for its game (no recompilation-only card beside it) once its own recompilation is installed; until
      // then another installed recompilation of the game keeps its own card, so it can be played.
      if (installedIds.includes(id) && !keys.has(key)) keys.set(key, game.id)
      const info: GameRecompInfo = {
        titleKey: key,
        count: 1,
        installed: installedIds.includes(id) ? [id] : [],
        preferred: id,
        updatedAt: nowIso
      }
      if (!sameRecompInfo(game.metadata.recomp, info)) {
        library.applyMetadata(
          game.id,
          { metadata: { recomp: info } },
          { overwrite: true, quiet: true }
        )
        events.emit('library:changed', { reason: 'metadata', gameIds: [game.id] })
      }
    }
    return keys
  }

  /** A recompilation's own card added from the browser, else null. */
  function addedCardOf(recompId: string): Game | null {
    return library.games().find((g) => recompAddedId(g) === recompId) ?? null
  }

  /** Every recompilation's own card (Add to library), by recompilation id: one pass over the library for a list. */
  function addedCards(games: Game[]): Map<string, Game> {
    const cards = new Map<string, Game>()
    for (const g of games) {
      const id = recompAddedId(g)
      if (id && !cards.has(id)) cards.set(id, g)
    }
    return cards
  }

  /**
   * The recompilations' own library cards (RecompGames): one for each game with a recompilation installed and no other
   * card in the library; it goes once none of its recompilations is installed (Delete on any page), and merges into
   * the original game's card when that is added.
   */
  function syncOwnCards(
    ownCards: Game[],
    gameOfTitle: Map<string, string>,
    installedIds: string[],
    preferred: Record<string, string>,
    nowIso: string,
    /** Title keys of recompilations added from the browser, by their card: the game is in the library already. */
    addedKeys: Map<string, string> = new Map()
  ): string[] {
    const cards = deps.recompGames
    const arrived: string[] = []
    if (!cards || !catalog) return arrived
    const covered = new Set<string>()
    const firstCard = new Map<string, string>()
    for (const game of ownCards) {
      const stored = recompOnlyKey(game)!
      const storedTitle = catalog.titles.get(stored)
      const madeWith = game.metadata.recomp?.installed ?? []
      // Its recompilations still installed: its title's in the catalog, the ones it was made with, and any the catalog
      // files under its key now (one catalog offline or regrouped must not take the card away while one is installed).
      const installedHere = installedIds.filter(
        (id) =>
          storedTitle?.entries.includes(id) ||
          madeWith.includes(id) ||
          titleOfEntry.get(id) === stored
      )
      // The title's key now: a catalog change can file the same recompilations under another key.
      const key = storedTitle
        ? stored
        : (installedHere
            .map((id) => titleOfEntry.get(id))
            .find((k): k is string => !!k && catalog!.titles.has(k)) ?? stored)
      const title = catalog.titles.get(key)
      // The original game is in the library now: its card takes the play history (also when the last recompilation
      // was deleted in the same pass).
      // The user added one of its recompilations to the library (its own card): this card merges into that one.
      const addedCard = addedKeys.get(key) ?? addedKeys.get(stored)
      if (addedCard) {
        cards.absorb(game.id, addedCard)
        continue
      }
      const original = gameOfTitle.get(key) ?? gameOfTitle.get(stored)
      if (original) {
        log.info(
          `recomp: ${game.title} is in the library now; its recompilation's card merges into it`
        )
        cards.absorb(game.id, original)
        arrived.push(...installedHere)
        continue
      }
      if (!installedHere.length) {
        log.info(
          `recomp: ${game.title} has no recompilation installed any more; its card leaves the library`
        )
        cards.remove(game.id)
        continue
      }
      // A second card of the same game (made under an older key): it merges into the first.
      const first = firstCard.get(key)
      if (first) {
        cards.absorb(game.id, first)
        continue
      }
      firstCard.set(key, game.id)
      covered.add(key)
      covered.add(stored)
      const matched = title ? recompInfo(title, installedIds, preferred[key] ?? null, nowIso) : null
      const info: GameRecompInfo = matched
        ? { ...matched, installed: [...new Set([...matched.installed, ...installedHere])] }
        : { ...game.metadata.recomp!, installed: installedHere }
      if (!sameRecompInfo(game.metadata.recomp, info)) {
        library.applyMetadata(
          game.id,
          { metadata: { recomp: info } },
          { overwrite: true, quiet: true }
        )
        events.emit('library:changed', { reason: 'metadata', gameIds: [game.id] })
      }
    }
    for (const id of installedIds) {
      const key = titleOfEntry.get(id)
      if (!key || covered.has(key) || gameOfTitle.has(key) || addedKeys.has(key)) continue
      const title = catalog.titles.get(key)
      if (!title) continue
      covered.add(key)
      const members = title.entries
        .map((e) => catalog!.entries.get(e))
        .filter((e): e is RecompEntry => !!e)
      const own = catalog.entries.get(id)
      const system = own?.systemId ?? title.systemId
      const art = (pick: (e: RecompEntry) => string | null): string | null =>
        (own && pick(own)) || members.map(pick).find((u) => !!u) || null
      const added = cards.add({
        titleKey: key,
        title: title.game,
        platformId: !system || system === 'other' ? 'pc' : system,
        recomp: recompInfo(title, installedIds, preferred[key] ?? null, nowIso),
        art: {
          cover: art((e) => e.coverUrl),
          hero: art((e) => e.heroUrl),
          icon: art((e) => e.iconUrl)
        }
      })
      if (added)
        log.info(
          `recomp: ${title.game} is not in the library; its recompilation was added as a game (${added})`
        )
    }
    return arrived
  }

  /** Match again now (after an install, an uninstall, a new preferred version), one pass at a time. */
  function rematch(): Promise<void> {
    if (matching) {
      matchAgain = true
      return matching
    }
    matching = (async () => {
      do {
        matchAgain = false
        try {
          await matchAll()
        } catch (err) {
          log.error('recomp: matching failed', err)
        }
      } while (matchAgain && !disposed)
      matching = null
    })()
    return matching
  }

  // --- updates ----------------------------------------------------------------------------------------------------

  async function releasesOf(entry: RecompEntry, force = false): Promise<GhRelease[]> {
    return fetchReleases(entry, httpCache(), { force })
  }

  /** Remember whether the version in use is a pre-release and which release is the newest (the Version row). */
  function noteReleases(id: string, tag: string, releases: GhRelease[], hint: AssetHint): void {
    const current = releases.find((r) => sameTag(r.tag_name, tag))
    releaseInfo.set(id, {
      prerelease: current?.prerelease === true,
      latest: newestRelease(releases, hint)?.tag_name ?? null
    })
  }

  async function checkUpdates(force: boolean): Promise<Record<string, string>> {
    const m = await (await state()).read()
    for (const rec of Object.values(m.installed)) {
      if (disposed) break
      const entry = entryOf(rec.id, rec)!
      try {
        const releases = await releasesOf(entry, force)
        // The record as it is now: an install or a version switch may have finished while the releases loaded.
        const now = (await (await state()).read()).installed[rec.id]
        if (!now) continue
        const hint = hintOf(entry, now)
        noteReleases(now.id, now.tag, releases, hint)
        // Pinned to an older release (Change version): no update is offered until Back to latest.
        if (now.pinnedTag) {
          updates.delete(now.id)
          continue
        }
        const latest = latestRelease(releases, now.tag, hint)
        if (
          latest &&
          (isNewer(latest.tag_name, now.tag, releases) ||
            isRepublished(latest, now, hint) ||
            replacesSidePiece(latest, now, hint))
        )
          updates.set(now.id, latest.tag_name)
        else updates.delete(now.id)
      } catch (err) {
        log.warn(`recomp: update check of ${rec.id} failed (${message(err)})`)
      }
    }
    const after = await (await state()).read()
    for (const id of [...updates.keys()]) if (!after.installed[id]) updates.delete(id)
    for (const id of [...releaseInfo.keys()]) if (!after.installed[id]) releaseInfo.delete(id)
    changed(Object.keys(after.installed))
    return Object.fromEntries(updates)
  }

  async function autoUpdate(): Promise<void> {
    const m = await (await state()).read()
    for (const [id] of updates) {
      const rec = m.installed[id]
      if (rec?.autoUpdate && !rec.pinnedTag && !busy(id) && !inUse(id)) {
        log.info(`recomp: updating ${id} automatically to ${updates.get(id)}`)
        enqueue(id, undefined)
      }
    }
  }

  /**
   * The start-up / daily pass: catalog, update check, automatic updates. The start-up pass may use the cached
   * catalog; the daily ones revalidate it (the cache is a day old by then, give or take a few seconds).
   */
  async function cycle(revalidate: boolean): Promise<void> {
    try {
      await loadNow(revalidate)
    } catch (err) {
      log.warn('recomp: catalog load failed', err)
    }
    if (disposed) return
    try {
      const m = await (await state()).read()
      if (Object.keys(m.installed).length === 0) return
      await checkUpdates(false)
      await autoUpdate()
    } catch (err) {
      log.warn('recomp: update check failed', err)
    }
  }

  // --- installs ---------------------------------------------------------------------------------------------------

  const baseProgress = (id: string): RecompProgress => ({
    id,
    phase: 'queued',
    progress: null,
    bytes: null,
    total: null,
    message: null,
    warning: null
  })

  /**
   * `tag`: that release (Change version, or the Releases list on the Recompilation page). Chosen for an installed
   * recompilation, a release older than the newest is pinned (runInstall).
   */
  function enqueue(id: string, tag: string | undefined): void {
    if (busy(id)) throw new Error(tMain('mainRecomp.alreadyInstalling'))
    if (inUse(id)) throw new Error(tMain('mainRecomp.runningCloseFirst'))
    report(baseProgress(id))
    queueTail = queueTail.then(() => runInstall(id, tag)).catch(() => undefined)
  }

  async function runInstall(id: string, tag: string | undefined): Promise<void> {
    if (disposed) return
    try {
      const st = await state()
      const r = await root()
      const previous = (await st.read()).installed[id] ?? null
      const entry = entryOf(id, previous)
      if (!entry) throw new Error(tMain('mainRecomp.notInCatalog'))
      report({
        ...baseProgress(id),
        phase: 'checking',
        message: tMain('mainRecomp.lookingForRelease')
      })
      const hint = hintOf(entry, previous)
      const releases = await releasesOf(entry)
      // A tag: that release (Change version, the Releases list). None: the newest — from a pinned version (Back to
      // latest) the project's newest release, else the update latestRelease offers.
      const release = tag
        ? releases.find((x) => sameTag(x.tag_name, tag))
        : previous?.pinnedTag
          ? newestRelease(releases, hint)
          : latestRelease(releases, previous?.tag ?? null, hint)
      if (!release)
        throw new Error(
          tag
            ? tMain('mainRecomp.releaseNotFound', { tag, name: entry.name })
            : tMain('mainRecomp.noWindowsDownload', { name: entry.name })
        )
      if (
        previous &&
        !tag &&
        sameTag(release.tag_name, previous.tag) &&
        !isRepublished(release, previous, hint) &&
        !replacesSidePiece(release, previous, hint)
      ) {
        updates.delete(id)
        noteReleases(id, release.tag_name, releases, hint)
        if (previous.pinnedTag)
          await st.update((mm) => {
            const r = mm.installed[id]
            if (r) r.pinnedTag = null
          })
        report({
          ...baseProgress(id),
          phase: 'done',
          progress: 1,
          message: tMain('mainRecomp.upToDate', { name: entry.name })
        })
        changed([id])
        return
      }
      const http = { fetch: deps.fetch, signal: controller.signal, log }
      // The pipeline ends with 'done' before its record is stored here. Reported at once, the recompilation would
      // stop being busy while the stored record is still the one of the release before: a Change version, an
      // uninstall or a start in that moment would act on it, and the page would show the old release as just
      // installed. So that last report waits until the record is stored and the library matched again.
      const finished: { report: RecompProgress | null } = { report: null }
      const installDeps: InstallDeps = {
        root: r,
        cacheDir: join(recompPlayoutDir(r), 'cache'),
        http,
        sevenZip: () => ensureSevenZip(recompPlayoutDir(r), http),
        run: deps.run ?? runProcess,
        log,
        onProgress: (p) => {
          if (p.phase === 'done') finished.report = p
          else report(p)
        },
        now
      }
      const record = await install(entry, release, previous, installDeps)
      // A release older than the newest chosen for an installed recompilation (Change version in Settings, or the
      // Releases list on the Recompilation page) is kept (pinned); the newest, an update or a first install follows
      // updates again.
      record.pinnedTag = tag && previous ? pinFor(releases, release.tag_name, hint) : null
      if (!previous) record.cloud = defaultCloudState()
      const profile = await readDeveloperProfile(record.dir).catch(() => null)
      if (!record.exe && profile?.start?.program) record.exe = profile.start.program
      if (record.saveSource !== 'user') {
        const saves = await resolveSavePaths(entry, record, saveCtx(record))
        if (saves.paths.length) {
          record.savePaths = saves.paths
          record.saveSource = saves.source
        }
      }
      await st.update(async (mm) => {
        const current = mm.installed[id]
        // The program the user chose stays while its file is there (else PlayOut's new pick, logged).
        await carryExeChoice(record, current ?? previous, log)
        if (!current) {
          if (!previous) record.cloud = defaultCloudState()
          mm.installed[id] = record
          return
        }
        // The download took a while: the user's settings and the cloud sync state stored meanwhile win over the
        // copy taken before it. Only what the install itself knows comes from `record`.
        const savesKept =
          current.saveSource === 'user' ||
          !previous ||
          current.saveSource !== previous.saveSource ||
          current.savePaths.join('\n') !== previous.savePaths.join('\n')
        mm.installed[id] = {
          ...record,
          installedAt: current.installedAt,
          autoUpdate: current.autoUpdate,
          gameFiles: current.gameFiles,
          cloud: current.cloud,
          ...(current.saveSuggestions ? { saveSuggestions: current.saveSuggestions } : {}),
          ...(current.saveCopyFolder ? { saveCopyFolder: current.saveCopyFolder } : {}),
          ...(current.oldCopyAdopted ? { oldCopyAdopted: true } : {}),
          // The start count and the player's confirmation of the program (image-offer.ts) survive an update: countStart
          // starts again by itself when the program changed.
          ...(current.exeIdentified ? { exeIdentified: current.exeIdentified } : {}),
          ...(savesKept ? { savePaths: current.savePaths, saveSource: current.saveSource } : {})
        }
      })
      updates.delete(id)
      noteReleases(id, record.tag, releases, hint)
      log.info(
        `recomp: ${id} ${previous ? 'updated' : 'installed'} at ${record.tag} in ${record.dir}${
          record.pinnedTag ? ' (pinned)' : ''
        }`
      )
      // Nobody documents the saves: look in the usual places now (the first play detects them otherwise).
      if (!previous)
        await findSaves(id).catch((err) =>
          log.warn(`recomp: looking for the saves of ${id} failed (${message(err)})`)
        )
      await rematch()
      report(finished.report ?? { ...baseProgress(id), phase: 'done', progress: 1 })
      changed([id])
    } catch (err) {
      const last = progress.get(id)
      if (last?.phase !== 'failed')
        report({
          ...baseProgress(id),
          phase: 'failed',
          message: message(err),
          warning: last?.warning ?? null
        })
      log.warn(`recomp: installing ${id} failed (${message(err)})`)
      changed([id])
    }
  }

  // --- game files -------------------------------------------------------------------------------------------------

  async function verifiedFor(
    entry: RecompEntry,
    states: GameFileState[]
  ): Promise<Record<string, VerifyResult>> {
    const out: Record<string, VerifyResult> = {}
    for (const s of states) {
      if (!s.path || out[s.path] || !s.hashes.length) continue
      const need = entry.needs.find((n) => n.id === s.id) ?? s
      const st = await fs.stat(s.path).catch(() => null)
      if (!st?.isFile() || st.size > VERIFY_LIMIT_BYTES) continue
      out[s.path] = await verifyGameFile(s.path, need, digestCache).catch(
        () => 'unverified' as const
      )
    }
    return out
  }

  /** The game-file state of an entry for a game: picks, library files, checks, missing paths dropped. */
  async function statesFor(
    entry: RecompEntry,
    installed: InstalledRecomp | null,
    game: Game | null
  ): Promise<GameFileState[]> {
    const lib = game ? libraryFilesFor(game) : []
    // A recompilation's own card (Add to library, or made because the game was not in the library) has no game file:
    // the library's games of its title lend theirs (the original's disc image, when it is in the library).
    if (game && (recompAddedId(game) || recompOnlyKey(game))) {
      const key = game.metadata.recomp?.titleKey
      if (key)
        for (const other of library.games())
          if (other.id !== game.id && !other.remote && other.metadata.recomp?.titleKey === key)
            lib.push(...libraryFilesFor(other))
    }
    const first = gameFileStates(entry, installed, lib, {})
    const verified = await verifiedFor(entry, first)
    return dropMissingPaths(gameFileStates(entry, installed, lib, verified))
  }

  async function setGameFile(
    gameId: string,
    recompId: string,
    needId: string,
    path: string | null
  ): Promise<GameFileState[]> {
    const game = gameOf(gameId)
    const rec = await installedOf(recompId)
    if (!rec) throw new Error(tMain('mainRecomp.files.installFirst'))
    const entry = (await effectiveEntry(recompId, rec))!
    const need = entry.needs.find((n) => n.id === needId)
    if (!need) throw new Error('Unknown game file')
    if (path !== null) {
      const st = await fs.stat(path).catch(() => null)
      if (!st) throw new Error(tMain('mainRecomp.files.notFound', { path }))
      if (st.isDirectory() && need.accepts === 'file')
        throw new Error(tMain('mainRecomp.files.pickFile'))
      if (st.isFile() && need.accepts === 'folder')
        throw new Error(tMain('mainRecomp.files.pickFolder'))
    }
    const next = await (
      await state()
    ).update((m) => {
      const r = m.installed[recompId]
      if (!r) return
      if (path === null) delete r.gameFiles[needId]
      else r.gameFiles[needId] = { path: resolve(path), source: 'picked' }
    })
    changed([recompId])
    await recheckImageOffers(recompId).catch((err) =>
      log.warn(`recomp: ${recompId}: could not check its disc image questions (${message(err)})`)
    )
    return statesFor(entry, next.installed[recompId] ?? null, game)
  }

  // --- saves and their copies -------------------------------------------------------------------------------------

  /** How long reading the Recompilations Saves folder may take (an Emulation folder on a drive that is gone). */
  const COPY_FOLDER_READ_MS = 1500

  /**
   * The folder names in <Emulation>/Recompilations Saves, read once with a time limit: [] when it does not exist yet,
   * null when it cannot be read in time (a disconnected network or USB drive).
   */
  function copyFolderNames(): Promise<string[] | null> {
    return folderNamesWithin(savesRoot(), COPY_FOLDER_READ_MS)
  }

  /** Whether a file or folder is there, answered within COPY_FOLDER_READ_MS (false when it takes longer). */
  function pathThere(p: string): Promise<boolean> {
    return pathThereWithin(p, COPY_FOLDER_READ_MS)
  }

  /**
   * This recompilation's copy folder name in <Emulation>/Recompilations Saves: the one chosen before (kept whatever the
   * catalog says now), else the one already there for its id (another PC made it), else "<project name> (<safe id>)".
   * `switched`: the folder chosen before is gone while another folder for this id is there, so that one is used: its
   * copy did not come from the last sync here (the last-synced hash must be forgotten, a difference is a conflict).
   * `names` null (unreadable) never switches.
   */
  function pickCopyFolder(
    id: string,
    rec: InstalledRecomp | null,
    names: string[] | null
  ): { name: string; switched: boolean } {
    const safe = safeRecompId(id).toLowerCase()
    const hits = (names ?? [])
      .filter((n) => {
        const lower = n.toLowerCase()
        return lower === safe || lower.endsWith(` (${safe})`)
      })
      .sort()
    const stored = rec?.saveCopyFolder
    const has = (n: string): string | undefined =>
      hits.find((h) => h.toLowerCase() === n.toLowerCase())
    if (stored) {
      if (!hits.length || has(stored)) return { name: has(stored) ?? stored, switched: false }
      return { name: hits[0]!, switched: true }
    }
    const wanted = safeRecompFolder(entryOf(id, rec) ?? { id, name: '' })
    return { name: has(wanted) ?? hits[0] ?? wanted, switched: false }
  }

  /** This recompilation's copy folder (see pickCopyFolder); `names` from copyFolderNames when already read. */
  async function copyDirOf(
    id: string,
    rec: InstalledRecomp | null,
    names?: string[] | null
  ): Promise<string> {
    const list = names === undefined ? await copyFolderNames() : names
    return join(savesRoot(), pickCopyFolder(id, rec, list).name)
  }

  /**
   * The copy folder a sync uses, its name stored with the record the first time (and when it switched, the
   * last-synced hash forgotten: `switched`). Not stored while the Emulation folder cannot be read.
   */
  async function claimCopyDir(
    id: string,
    rec: InstalledRecomp
  ): Promise<{ dir: string; switched: boolean }> {
    const names = await copyFolderNames()
    const pick = pickCopyFolder(id, rec, names)
    const changedName = pick.name !== rec.saveCopyFolder || pick.switched
    // Chosen only while the Emulation folder is there (a drive that is gone hides the folders other PCs made).
    if (names !== null && changedName && (await pathThere(emulationDir()))) {
      if (pick.switched)
        log.info(
          `recomp saves: ${id} copy folder ${rec.saveCopyFolder} is gone; using ${pick.name} (a difference is a conflict)`
        )
      await (
        await state()
      ).update((m) => {
        const r = m.installed[id]
        if (!r) return
        r.saveCopyFolder = pick.name
        if (pick.switched) r.cloud = { ...r.cloud, syncedHash: null }
      })
    }
    return { dir: join(savesRoot(), pick.name), switched: pick.switched }
  }

  /** The save folders in use (templates and real paths, index-aligned); adopts the copy's when none is known. */
  async function savesOf(
    id: string,
    rec: InstalledRecomp,
    copyDir: string
  ): Promise<{ templates: string[]; paths: string[]; source: InstalledRecomp['saveSource'] }> {
    const entry = entryOf(id, rec)!
    const ctx = saveCtx(rec)
    let { paths: templates, source } = await resolveSavePaths(entry, rec, ctx)
    if (!templates.length) {
      const meta = await readCopyMeta(copyDir)
      const adopted = meta ? usableSaveTemplates(meta.roots, ctx) : []
      if (adopted.length) {
        templates = adopted
        source = 'detected'
      }
    }
    if (
      templates.length &&
      (source !== rec.saveSource || templates.join('\n') !== rec.savePaths.join('\n'))
    ) {
      await (
        await state()
      ).update((m) => {
        const r = m.installed[id]
        if (!r) return
        r.savePaths = templates
        r.saveSource = source
      })
    }
    return { templates, paths: expandSavePaths(templates, ctx), source }
  }

  async function copyDeps(
    templates: string[],
    copyDir: string,
    rootDir: string
  ): Promise<CloudSyncDeps> {
    return {
      rootDir,
      dir: copyDir,
      machine,
      machineId: ownId(),
      log,
      now,
      backupsDir: join(recompPlayoutDir(await root()), 'save-backups'),
      templates
    }
  }

  /**
   * The manifest with its last-synced hashes valid for the Emulation folder in use: when it changed (Settings ›
   * Library), every last-synced hash is forgotten first, so a copy already in the new folder that differs from the
   * saves is a conflict for the user, never newer saves copied back over them.
   */
  async function manifestFor(rootDir: string): Promise<RecompManifest> {
    const st = await state()
    const m = await st.read()
    if (m.savesRoot && normalizePath(m.savesRoot) === normalizePath(rootDir)) return m
    return st.update((mm) => {
      if (mm.savesRoot && normalizePath(mm.savesRoot) === normalizePath(rootDir)) return
      if (mm.savesRoot)
        for (const r of Object.values(mm.installed))
          r.cloud = { ...r.cloud, syncedHash: null, conflict: null, pending: false, error: null }
      mm.savesRoot = rootDir
    })
  }

  /**
   * The copy folder of a recompilation (claimCopyDir), after adopting the copy an older PlayOut kept in the chosen
   * cloud folder when there is none yet — looked for once per recompilation (oldCopyAdopted), never again: a copy
   * folder emptied later (a new Emulation folder, a copy deleted to start over) gets this PC's saves, not the old copy.
   * The look counts as done once a copy was adopted, the copy folder holds a copy, or the cloud folder could be read
   * (a cloud folder on a drive that is gone is looked at again next time). `fresh`: the last-synced hash must be
   * forgotten (an adopted copy, or a switched copy folder).
   */
  async function prepareCopy(
    id: string,
    rec: InstalledRecomp,
    m: RecompManifest
  ): Promise<{ dir: string; fresh: boolean }> {
    const { dir, switched } = await claimCopyDir(id, rec)
    let adopted = false
    if (m.cloudDir && !rec.oldCopyAdopted && rec.cloud.enabled) {
      adopted = await adoptOldCopy(oldCloudSaveDir(m.cloudDir, id), dir, log)
      const done =
        adopted ||
        (await pathThere(join(dir, 'meta.json'))) ||
        (await pathThere(join(dir, 'current'))) ||
        (await pathThere(m.cloudDir))
      if (done)
        await (
          await state()
        ).update((mm) => {
          const r = mm.installed[id]
          if (r) r.oldCopyAdopted = true
        })
    }
    return { dir, fresh: adopted || switched }
  }

  /**
   * Bring one recompilation's saves and their copy in the Emulation folder in step; the new state is stored. A manual
   * sync is refused while the game is being started or played: copying back would rewrite and delete save files under
   * the running game (the copy after play runs once it closes).
   */
  function syncNow(
    id: string,
    direction: 'before-play' | 'after-play' | 'manual'
  ): Promise<RecompCloudState> {
    return withLock(id, async () => {
      if (direction === 'manual' && inUse(id))
        throw new Error(tMain('mainRecomp.saves.runningCopiedOnClose'))
      const rootDir = emulationDir()
      const m = await manifestFor(rootDir)
      const rec = m.installed[id]
      if (!rec) throw new Error(tMain('mainRecomp.notInstalled'))
      const copy = await prepareCopy(id, rec, m)
      const from = copy.fresh ? { ...rec.cloud, syncedHash: null } : rec.cloud
      const saves = await savesOf(id, rec, copy.dir)
      const next = await syncSaves(
        id,
        saves.paths,
        from,
        await copyDeps(saves.templates, copy.dir, rootDir),
        direction
      )
      await (
        await state()
      ).update((mm) => {
        const r = mm.installed[id]
        if (!r) return
        // The Emulation folder changed meanwhile: this result belongs to the old one (the new one starts over).
        if (normalizePath(emulationDir()) !== normalizePath(rootDir))
          r.cloud = { ...next, syncedHash: null }
        else r.cloud = next
      })
      return next
    })
  }

  // --- launch -----------------------------------------------------------------------------------------------------

  function spawnDetached(
    file: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<ChildProcess> {
    const command = buildSpawnCommand(file, args)
    if ('error' in command) return Promise.reject(new Error(command.error.message))
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command.file, command.args, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: command.verbatim
      })
      child.once('spawn', () => resolvePromise(child))
      // Kept for the program's whole life (not `once`): a ChildProcess can report an 'error' after it started too, and
      // one without a listener is raised as an uncaught exception, which would take the main process down.
      child.on('error', (err) => reject(err))
      child.unref()
    })
  }

  async function waitForSessionEnd(gameId: string): Promise<void> {
    const pollMs = deps.sessionPollMs ?? 3000
    const until = Date.now() + SESSION_WAIT_MAX_MS
    while (!disposed && launcher.running()?.gameId === gameId && Date.now() < until)
      await new Promise((r) => setTimeout(r, pollMs))
  }

  /** After the play session: find the save folders when none were known, then copy them to the Emulation folder. */
  async function afterPlay(id: string, before: SaveSnapshot | null): Promise<void> {
    try {
      const st = await state()
      const rec = (await st.read()).installed[id]
      if (!rec) return
      if (before) {
        const entry = entryOf(id, rec)!
        const ctx = saveCtx(rec)
        const after = await snapshotSaveCandidates(entry, rec, ctx.folders, deps.documents)
        const found = detectSaveFolders(before, after, rec, ctx)
        if (found.length) {
          log.info(`recomp: ${id} saves in ${found.join(', ')}`)
          await st.update((m) => {
            const r = m.installed[id]
            if (r && !r.savePaths.length) {
              r.savePaths = found
              r.saveSource = 'detected'
            }
          })
        }
      }
      const m = await st.read()
      if (m.installed[id]?.cloud.enabled) await syncNow(id, 'after-play')
    } catch (err) {
      log.warn(`recomp: after playing ${id}: ${message(err)}`)
    } finally {
      changed([id])
    }
  }

  // --- the program it starts -------------------------------------------------------------------------------------

  async function executablesOf(id: string): Promise<RecompExecutables> {
    const rec = await requireInstalled(id)
    const entry = entryOf(id, rec) ?? stubEntry(id, rec)
    const profile = await profileOf(rec)
    return listExecutables(rec, entry, profile?.start?.program ?? null)
  }

  /** The user's program choice (`path` checked: an existing .exe), or Automatic (null). */
  async function setExecutable(id: string, path: string | null): Promise<RecompExecutables> {
    const st = await state()
    const before = await requireInstalled(id)
    const exe = path === null ? null : await checkExeChoice(before, path)
    let fallback: string | null = null
    if (exe === null && before.exeChosen === 'user' && before.autoExe === undefined) {
      const entry = entryOf(id, before) ?? stubEntry(id, before)
      fallback = await findExe(before.dir, entry.exe, entry).catch(() => null)
    }
    const profileProgram = (await profileOf(before))?.start?.program ?? null
    await st.update((m) => {
      const rec = m.installed[id]
      if (!rec) throw new Error(tMain('mainRecomp.notInstalled'))
      if (exe === null) automaticExe(rec, fallback)
      else chooseExe(rec, exe)
      // The player identified the program (picked it, or confirmed PlayOut's pick with Automatic).
      const { program } = programOf(rec, profileProgram)
      if (program) notePlayerExe(rec, exeFullPath(rec, program))
    })
    log.info(
      exe === null
        ? `recomp: ${id} starts PlayOut's pick of its program again`
        : `recomp: ${id} starts ${exe} (chosen by the user)`
    )
    changed([id])
    // Its disc image may go now ("Delete the original disc image?"), and a question already waiting is checked again
    // (the program it asked for may be a setup program now); a failure here never fails the choice.
    await offerImages(id)
      .then(() => recheckImageOffers(id))
      .catch((err) => log.warn(`recomp: ${id}: could not check its disc image (${message(err)})`))
    return executablesOf(id)
  }

  /** `onSpawn`: the game's process once it started (the test run after Delete watches it). */
  async function launch(
    gameId: string,
    recompId?: string,
    onSpawn?: (child: ChildProcess) => void
  ): Promise<RecompLaunchResult> {
    const game = gameOf(gameId)
    await ensureCatalog()
    const st = await state()
    const m = await st.read()
    let id = recompId ?? null
    if (!id) {
      const title = titleForGame(game)
      if (!title)
        return { ok: false, reason: 'not-installed', message: tMain('mainRecomp.launch.noRecomp') }
      const chosen = defaultPreferred(
        title,
        Object.keys(m.installed),
        m.preferred[title.key] ?? null
      )
      // The chosen one when it is installed, else the first installed one (as the UP button picks).
      id = m.installed[chosen] ? chosen : (title.entries.find((e) => m.installed[e]) ?? chosen)
    }
    const rec = m.installed[id]
    const entry = await effectiveEntry(id, rec ?? null)
    const name = entry?.name ?? tMain('mainRecomp.launch.defaultName')
    if (!rec || !entry)
      return {
        ok: false,
        reason: 'not-installed',
        message: tMain('mainRecomp.launch.notInstalled', { name })
      }
    // A start already under way (a setup's game disc being unpacked can take minutes and shows as 'extracting'):
    // say so instead of the busy message below, which would read as an install or update.
    if (launching.has(id))
      return {
        ok: false,
        reason: 'running',
        message: tMain('mainRecomp.launch.alreadyStarting', { name })
      }
    if (busy(id))
      return {
        ok: false,
        reason: 'running',
        message: tMain('mainRecomp.launch.installing', { name })
      }
    const setupFolder = setupFolderOf(id)
    if (setupFolder && deletingFolders.has(normalizePath(setupFolder)))
      return {
        ok: false,
        reason: 'running',
        message: tMain('mainRecomp.launch.movingSetup', { folder: setupFolder, name })
      }
    if (inUse(id))
      return {
        ok: false,
        reason: 'running',
        message: tMain('mainRecomp.launch.alreadyRunning', { name })
      }
    // Reserved until it runs (then `playing` holds it) or the start stops: no second start, update or uninstall
    // gets in while the game files, save copy and program are prepared.
    launching.add(id)
    try {
      return await startReserved(game, id, rec, entry, name, onSpawn)
    } finally {
      launching.delete(id)
    }
  }

  /**
   * Before a setup program that takes the game unpacked (game-folder.ts): when the game is not unpacked where it
   * looks yet and the library has the game's disc image, unpack it there (progress as 'extracting' reports).
   * Resolves to what to tell the player when that failed, else null (also when there is no image: as before).
   */
  async function prepareSetupGame(
    game: Game,
    id: string,
    setup: UnpackedGameSetup,
    name: string
  ): Promise<string | null> {
    const home = deps.homedir?.() ?? osHomedir()
    if (await markerPresent(setup, home)) return null
    const image = await findSetupImage(
      setup,
      game,
      library.games(),
      (g) => titleForGame(g)?.entries.includes(id) ?? false
    )
    if (!image) {
      log.info(`recomp: no ${setup.platform} image of ${setup.game} in the library for ${id}`)
      return null
    }
    const extract = (await isFolder(image))
      ? copyFolder
      : (deps.extractXboxImage ?? (deps.xboxHelper ? helperExtractor(deps.xboxHelper) : null))
    if (!extract) return tMain('mainRecomp.setup.noHelper', { game: setup.game })
    if (disposed || controller.signal.aborted) return null
    const what = { game: setup.game, name }
    // The install's last report (it may carry the unverified-download warning) is put back when the unpack ends,
    // and its warning stays on the unpack's reports meanwhile.
    const before = progress.get(id)
    const warning = before?.warning ?? null
    let last = -1
    report({
      ...baseProgress(id),
      phase: 'extracting',
      progress: 0,
      message: tMain('mainRecomp.setup.preparing', what),
      warning
    })
    const result = await unpackSetupGame(setup, image, {
      home,
      extract,
      log,
      signal: controller.signal,
      onPercent: (percent) => {
        const p = Math.max(0, Math.min(100, Math.floor(percent)))
        if (p === last) return
        last = p
        report({
          ...baseProgress(id),
          phase: 'extracting',
          progress: p / 100,
          message: tMain('mainRecomp.setup.unpacking', what),
          warning
        })
      }
    })
    report(before ?? { ...baseProgress(id), phase: 'done', progress: 1, warning })
    if (result.ok) {
      // PlayOut made this folder: only such a folder is ever offered for deletion ("Delete the unpacked game folder").
      const owner =
        library
          .games()
          .find(
            (g) => g.romPath === image || (!!g.romPath && romGameFolder(g.romPath, g) === image)
          ) ?? game
      await (
        await state()
      )
        .update((mm) => {
          mm.unpackedFolders[normalizePath(result.folder)] = {
            folder: result.folder,
            recompId: id,
            gameId: owner.id,
            at: now().toISOString(),
            state: 'unpacked'
          }
        })
        .catch((err) =>
          log.warn(`recomp: ${id}: could not remember the unpacked folder (${message(err)})`)
        )
    }
    return result.ok ? null : result.message
  }

  async function startReserved(
    game: Game,
    id: string,
    rec: InstalledRecomp,
    entry: RecompEntry,
    name: string,
    onSpawn?: (child: ChildProcess) => void
  ): Promise<RecompLaunchResult> {
    const gameId = game.id
    const st = await state()
    const setupProgram = isInstallerRecord(entry, rec)
    const profile = await profileOf(rec)

    // The program is unclear (nobody named or confirmed it and several programs the release shipped could be the
    // game): the player picks it first, before game files or saves are touched; the pick is saved as theirs, so later
    // starts do not ask.
    if (
      !setupProgram &&
      !rec.exeChosen &&
      programOf(rec, profile?.start?.program ?? null).source === 'auto'
    ) {
      const executables = await listExecutables(rec, entry, null)
      if (exeUnclear(executables, rec, setupProgram)) {
        log.info(`recomp: ${id}: which program starts the game is unclear; asking the player`)
        return { ok: false, reason: 'choose-exe', recompId: id, executables }
      }
    }

    // A setup program: run it (the user installs the game with it); there is nothing to track.
    if (setupProgram) {
      const file = exeFullPath(rec, rec.exe!)
      if (!isUserExe(rec) && !isInside(rec.dir, file))
        return { ok: false, reason: 'failed', message: tMain('mainRecomp.launch.setupMissing') }
      // A setup that takes the game unpacked: the player's disc image is unpacked where it looks first.
      const setup = unpackedSetupFor(id, deps.unpackedGameSetups ?? UNPACKED_GAME_SETUPS)
      const warning = setup ? await prepareSetupGame(game, id, setup, name) : null
      // PlayOut closed while the disc was being unpacked (the helper was stopped): do not start the setup as it exits.
      if (disposed || controller.signal.aborted)
        return { ok: false, reason: 'failed', message: tMain('mainRecomp.launch.closing') }
      try {
        const child =
          extname(file).toLowerCase() === '.msi'
            ? await spawnDetached('msiexec.exe', ['/i', file], rec.dir, process.env)
            : await spawnDetached(file, [], rec.dir, process.env)
        // While it runs, the game folder it installs from is never offered for deletion.
        setupRunning.add(id)
        child.once('exit', () => setupRunning.delete(id))
        log.info(`recomp: started the setup program of ${id}: ${file}`)
        return warning ? { ok: true, warning } : { ok: true }
      } catch (err) {
        return {
          ok: false,
          reason: 'failed',
          message: tMain('mainRecomp.launch.couldNotStartFile', {
            file: basename(file),
            error: message(err)
          })
        }
      }
    }

    // Game files: everything required must be there (or the page asks for it).
    const states = await statesFor(entry, rec, game)
    const prep = prepareLaunch(entry, rec, states)
    if (prep.missing.length) return { ok: false, reason: 'needs-files', needs: states }
    const picks = states.filter((s) => s.path && s.source === 'library' && !rec.gameFiles[s.id])
    if (picks.length)
      await st.update((mm) => {
        const r = mm.installed[id]
        if (r) for (const s of picks) r.gameFiles[s.id] = { path: s.path!, source: 'library' }
      })

    // The save copy first: a conflict stops the start until the user picks.
    if (rec.cloud.enabled) {
      if (rec.cloud.conflict)
        return { ok: false, reason: 'save-conflict', conflict: rec.cloud.conflict }
      const synced = await syncNow(id, 'before-play').catch((err) => {
        log.warn(`recomp: ${id} before-play sync failed (${message(err)})`)
        return null
      })
      if (synced?.conflict) {
        changed([id])
        return { ok: false, reason: 'save-conflict', conflict: synced.conflict }
      }
    }

    const { program, source } = programOf(rec, profile?.start?.program ?? null)
    if (!program)
      return {
        ok: false,
        reason: 'failed',
        message: tMain('mainRecomp.launch.programNotFound', { name, dir: rec.dir })
      }
    const file = exeFullPath(rec, program)
    // The user's choice may be outside the install folder (a setup program put the game elsewhere): it must still be
    // an existing .exe. PlayOut's own pick must be inside the install folder.
    const chosen = source === 'user'
    if (chosen && !(await isExeFile(file)))
      return {
        ok: false,
        reason: 'failed',
        message: tMain('mainRecomp.launch.chosenGone', { file, name })
      }
    if (!chosen && (!isInside(rec.dir, file) || !(await fs.stat(file).catch(() => null))?.isFile()))
      return {
        ok: false,
        reason: 'failed',
        message: tMain('mainRecomp.launch.exeMissing', { file: basename(file), dir: rec.dir })
      }
    // The developer's start arguments and environment go with the developer's program (not another one chosen).
    const devStart =
      profile?.start &&
      (!chosen ||
        (!!profile.start.program &&
          normalizePath(exeFullPath(rec, profile.start.program)) === normalizePath(file)))
        ? profile.start
        : undefined
    // Every program inside the install folder (PlayOut's pick or the user's, even in a subfolder) runs there, as
    // recompilations always have: game files are placed relative to it. Only a chosen program outside it (a setup
    // program put the game elsewhere) runs in its own folder.
    const cwd = isInside(rec.dir, file) ? rec.dir : dirname(file)

    try {
      await applyCopies(prep.copies, log)
    } catch (err) {
      return {
        ok: false,
        reason: 'failed',
        message: tMain('mainRecomp.launch.placeFilesFailed', { error: message(err) })
      }
    }

    // Saves nobody knows yet: look at the likely places before and after the session.
    const fresh = (await st.read()).installed[id] ?? rec
    const before = fresh.savePaths.length
      ? null
      : await snapshotSaveCandidates(entry, fresh, saveCtx(fresh).folders, deps.documents).catch(
          () => null
        )

    const args = [...(devStart?.args ?? []), ...prep.args]
    const env: NodeJS.ProcessEnv = { ...process.env, ...(devStart?.env ?? {}), ...prep.env }
    let child: ChildProcess
    try {
      child = await spawnDetached(file, args, cwd, env)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return {
        ok: false,
        reason: 'failed',
        message:
          code === 'EACCES'
            ? tMain('mainRecomp.launch.needsAdmin', { file: basename(file) })
            : tMain('mainRecomp.launch.couldNotStart', { name, error: message(err) })
      }
    }
    // Listened for from the moment it runs: the state writes below take a moment, and a program that closes during
    // one of them must still be seen closing, or the recompilation would count as running until PlayOut restarts
    // (no update, no uninstall, no start) and its after-play work would never happen.
    const exited = new Promise<void>((resolve) => {
      if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') resolve()
      else child.once('exit', () => resolve())
    })
    log.info(
      `recomp: launching ${game.title} with ${id}: ${file} ${args.join(' ')} (cwd ${cwd}${chosen ? ', chosen by the user' : ''})`
    )
    // PlayOut's own pick started the game: it is confirmed, so files placed in the folder later (game files copied
    // into it, the player's own programs) never make UP ask which program starts it.
    if (source === 'auto' && !rec.exeChosen)
      await st
        .update((mm) => {
          const r = mm.installed[id]
          if (r && r.exe === rec.exe) confirmExe(r)
        })
        .catch((err) => log.warn(`recomp: ${id}: could not remember its program (${message(err)})`))
    playing.set(id, gameId)
    launcher.track(game, child)
    onSpawn?.(child)
    // A successful start: PlayOut's own pick asks about the disc image after its second start, the player's at once.
    let askImage = false
    await st
      .update((mm) => {
        const r = mm.installed[id]
        if (!r) return
        askImage = countStart(r, file, chosen)
        // The game's original arrived only lately (downloaded from a paired PC): asked after two starts with it.
        if (r.imageAskAfter) {
          r.imageAskAfter -= 1
          if (r.imageAskAfter > 0) askImage = false
          else delete r.imageAskAfter
        }
      })
      .catch((err) => log.warn(`recomp: ${id}: could not count its start (${message(err)})`))
    if (askImage)
      void offerImages(id, game).catch((err) =>
        log.warn(`recomp: ${id}: could not check its disc image (${message(err)})`)
      )
    void exited
      .then(() => waitForSessionEnd(gameId))
      .then(() => {
        playing.delete(id)
        return afterPlay(id, before)
      })
      .catch((err) => log.warn(`recomp: after playing ${id}: ${message(err)}`))
    return { ok: true }
  }

  // --- "Delete the original disc image?" (image-offer.ts) ---------------------------------------------------------

  /** The game "running" now is one of its recompilations (which do not read the image), not an emulator. */
  const recompRunningFor = (gameId: string): boolean => [...playing.values()].includes(gameId)

  /** Library games whose disc image a recompilation may replace: the started game and the games matched to it. */
  function imageGames(id: string, launched?: Game): Game[] {
    return library
      .games()
      .filter(
        (g) =>
          hasDiscImage(g) &&
          (g.id === launched?.id || (titleForGame(g)?.entries.includes(id) ?? false))
      )
  }

  /**
   * Why `game`'s image must stay for the recompilation `rec`, or null when it may go: a setup program still installs from
   * it, the recompilation reads it at every start (an argument, an environment variable, a copy into its folder), or
   * it is not ready to play yet (a game file it needs is not chosen). `states`: its game-file states when known.
   */
  async function imageNeeded(
    rec: InstalledRecomp,
    entry: RecompEntry,
    game: Game,
    files: string[],
    states?: GameFileState[]
  ): Promise<string | null> {
    if (isInstallerRecord(entry, rec))
      return tMain('mainRecomp.imageStays.installsFromIt', { name: entry.name })
    const stays = imageStays(states ?? (await statesFor(entry, rec, game)), files)
    if (stays === 'reads') return tMain('mainRecomp.imageStays.reads', { name: entry.name })
    if (stays === 'not-ready')
      return tMain('mainRecomp.imageStays.needsFiles', { name: entry.name })
    return null
  }

  /**
   * Why the waiting question `offer` may no longer be answered with Delete (of its image), or null when it still may:
   * the recompilation is gone, or the image is needed now (imageNeeded: its game files or program changed since it was
   * asked). Checked again on every answer and whenever the waiting questions are listed.
   */
  async function offerStale(
    offer: RecompImageOfferRecord,
    game: Game,
    rec: InstalledRecomp | undefined
  ): Promise<string | null> {
    if (!rec) return tMain('mainRecomp.busy.noLongerInstalled')
    const entry = await effectiveEntry(offer.recompId, rec)
    if (!entry) return tMain('mainRecomp.busy.noLongerKnown')
    const image = offer.image ?? game.romPath ?? ''
    const plan = await deps.originalImage
      ?.plan(game.id, { recompRunning: recompRunningFor(game.id) })
      .catch(() => null)
    const files = plan && 'paths' in plan ? [image, ...plan.paths] : [image]
    return imageNeeded(rec, entry, game, files)
  }

  // --- "Delete the unpacked game folder" (image-offer.ts unpackedFolderUse) ---------------------------------------

  const unpackedSetups = (): UnpackedGameSetup[] => deps.unpackedGameSetups ?? UNPACKED_GAME_SETUPS
  const home = (): string => deps.homedir?.() ?? osHomedir()

  /** The folder recompilation `id`'s setup program reads the unpacked game from (game-folder.ts), or null. */
  function setupFolderOf(id: string): string | null {
    const setup = unpackedSetupFor(id, unpackedSetups())
    return setup ? setupGameFolder(setup, home()) : null
  }

  /**
   * The record of the game folder PlayOut itself unpacked for recompilation `id`'s setup program, when there is one and
   * it is still that setup's folder (a folder path is never taken from the manifest alone), not already deleted.
   */
  function unpackedRecordOf(m: RecompManifest, id: string): RecompUnpackedFolderRecord | null {
    const folder = setupFolderOf(id)
    if (!folder) return null
    const r = m.unpackedFolders[normalizePath(folder)]
    return r && normalizePath(r.folder) === normalizePath(folder) && r.state !== 'deleted'
      ? r
      : null
  }

  /**
   * Something uses a setup's game folder right now: a start of a recompilation with that setup folder is being prepared
   * (the unpack runs then), its setup program or game is running, or the recompilation is installing or updating.
   */
  function folderBusy(id: string, folder: string): string | null {
    const same = (other: string): boolean => {
      const f = setupFolderOf(other)
      return other === id || (!!f && normalizePath(f) === normalizePath(folder))
    }
    if ([...launching].some(same)) return tMain('mainRecomp.busy.preparing')
    if ([...setupRunning].some(same)) return tMain('mainRecomp.busy.setupRunning')
    if ([...playing.keys()].some(same)) return tMain('mainRecomp.busy.gameRunning')
    if (busy(id)) return tMain('mainRecomp.busy.installing')
    return null
  }

  type FolderCheck =
    { record: RecompUnpackedFolderRecord; totalBytes: number | null } | { why: string } | null

  /**
   * Whether the folder PlayOut unpacked for recompilation `id` may go now: `record` and its size when it may; `why`
   * when it must stay (or cannot go now); null when PlayOut unpacked no folder for it. It stays while the setup program
   * is still what starts it, while the program that starts the game is not identified (exeIdentified) or is not the
   * program in use, while a game file it needs is not chosen, while it is used (unpackedFolderUse: the program, the
   * folder it starts in, an install folder or a game file is in or around it), while it is busy (folderBusy) and when
   * the folder guards refuse it (local-delete.ts: never a known folder, a drive's top, PlayOut's own folders, a link).
   */
  async function folderOf(
    id: string,
    m: RecompManifest,
    game: Game | null,
    states?: GameFileState[]
  ): Promise<FolderCheck> {
    const record = unpackedRecordOf(m, id)
    if (!record) return null
    const files = deps.originalImage
    if (!files?.folderPlan || !files.trashFolder)
      return { why: tMain('mainRecomp.folder.cannotDelete') }
    const rec = m.installed[id]
    if (!rec) return { why: tMain('mainRecomp.folder.notInstalled') }
    const entry = await effectiveEntry(id, rec)
    if (!entry) return { why: tMain('mainRecomp.folder.notKnown') }
    const folder = record.folder
    const busyWhy = folderBusy(id, folder)
    if (busyWhy) return { why: busyWhy }
    if (isInstallerRecord(entry, rec))
      return {
        why: tMain('mainRecomp.imageStays.installsFromIt', { name: entry.name })
      }
    const { program } = programOf(rec, (await profileOf(rec))?.start?.program ?? null)
    const full = program ? exeFullPath(rec, program) : null
    const identified =
      !!full && !!rec.exeIdentified && rec.exeIdentified.exe === normalizePath(full)
    const owner = game ?? library.getGame(record.gameId) ?? null
    const s = states ?? (await statesFor(entry, rec, owner))
    if (s.some((x) => !x.ready))
      return {
        why: tMain('mainRecomp.imageStays.needsFiles', { name: entry.name })
      }
    const used = unpackedFolderUse(folder, {
      program: identified ? full : null,
      cwd: full ? (isInside(rec.dir, full) ? rec.dir : dirname(full)) : null,
      installDirs: [...Object.values(m.installed).map((r) => r.dir), await root()],
      gameFiles: [
        ...Object.values(rec.gameFiles).map((g) => g.path),
        ...s.flatMap((x) => (x.path ? [x.path] : []))
      ]
    })
    if (used) return { why: used }
    const plan = await files.folderPlan(folder).catch((err: unknown) => ({ refusal: message(err) }))
    if ('refusal' in plan) return { why: plan.refusal }
    return { record, totalBytes: plan.totalBytes }
  }

  const folderView = (
    f: { record: RecompUnpackedFolderRecord; totalBytes: number | null },
    m: RecompManifest
  ): RecompUnpackedFolder => ({
    path: f.record.folder,
    totalBytes: f.totalBytes,
    kept: (m.unpackedFolders[normalizePath(f.record.folder)] ?? f.record).state === 'kept'
  })

  /** The folder a question offers, as it may go now; null when it must stay now (or is gone). */
  async function offerFolder(
    offer: RecompImageOfferRecord,
    m: RecompManifest
  ): Promise<{ record: RecompUnpackedFolderRecord; totalBytes: number | null } | null> {
    if (!offer.folder) return null
    const f = await folderOf(offer.recompId, m, library.getGame(offer.gameId) ?? null).catch(
      () => null
    )
    return f && 'record' in f && normalizePath(f.record.folder) === normalizePath(offer.folder)
      ? f
      : null
  }

  const setFolderState = (
    mm: RecompManifest,
    folder: string,
    next: RecompUnpackedFolderRecord['state']
  ): void => {
    const r = mm.unpackedFolders[normalizePath(folder)]
    // A folder already in the Recycle Bin stays so until a new unpack (Keep it never brings it back).
    if (r && (next === 'deleted' || r.state === 'unpacked')) r.state = next
  }

  /** A question offering `folder` is waiting already (with or without an image). */
  const folderAsked = (m: RecompManifest, folder: string): boolean =>
    Object.values(m.imageOffers).some(
      (o) =>
        o.state === 'pending' && !!o.folder && normalizePath(o.folder) === normalizePath(folder)
    )

  /**
   * Ask about the disc images recompilation `id` no longer needs (each image once: an answered or waiting question is
   * never asked again), and about the game folder PlayOut unpacked for its setup program once it no longer uses it
   * (with the first image asked, else in a question of its own; once: a folder answered is not asked again). Images
   * and folders in use (a conversion, a download queue, a running setup) are skipped for now.
   */
  async function offerImages(id: string, launched?: Game): Promise<void> {
    const files = deps.originalImage
    if (!files || disposed) return
    // The games are matched to the recompilation through the catalog.
    await ensureCatalog()
    const st = await state()
    const m = await st.read()
    const rec = m.installed[id]
    if (!rec) return
    const entry = await effectiveEntry(id, rec)
    if (!entry) return
    const fresh: [string, RecompImageOfferRecord][] = []
    for (const game of imageGames(id, launched)) {
      const image = game.romPath!
      const key = imageOfferKey(id, image)
      if (m.imageOffers[key]) continue
      // The library may still name an image the player moved or deleted: there is nothing to delete.
      if (!(await imageOnDisk(image))) {
        log.info(`recomp: ${id}: not asking about ${image} (it is no longer on disk)`)
        continue
      }
      const plan = await files.plan(game.id, { recompRunning: recompRunningFor(game.id) })
      if ('refusal' in plan) {
        log.info(`recomp: ${id}: not asking about ${image} now (${plan.refusal})`)
        continue
      }
      const why = await imageNeeded(rec, entry, game, [image, ...plan.paths])
      if (why) {
        log.info(`recomp: ${id}: ${image} stays (${why})`)
        continue
      }
      fresh.push([
        key,
        { state: 'pending', recompId: id, gameId: game.id, image, at: now().toISOString() }
      ])
    }
    const record = unpackedRecordOf(m, id)
    if (record?.state === 'unpacked' && !folderAsked(m, record.folder)) {
      const f = await folderOf(id, m, launched ?? null)
      if (f && 'record' in f) {
        if (fresh.length) fresh[0]![1].folder = record.folder
        else
          fresh.push([
            folderOfferKey(id, record.folder),
            {
              state: 'pending',
              recompId: id,
              gameId: record.gameId,
              image: null,
              folder: record.folder,
              at: now().toISOString()
            }
          ])
      } else if (f) log.info(`recomp: ${id}: ${record.folder} stays (${f.why})`)
    }
    if (!fresh.length) return
    await st.update((mm) => {
      for (const [key, offer] of fresh) mm.imageOffers[key] ??= offer
    })
    const asked = fresh.flatMap(([, o]) => [o.image, o.folder].filter((x): x is string => !!x))
    log.info(`recomp: ${id}: asking whether to delete ${asked.join(', ')}`)
    await emitImageOffers()
  }

  /**
   * One waiting question as the renderer shows it (the files and their size, as they would go now). `game`: the game
   * whose image may go (null: the image part is gone or must stay); `folder`: the unpacked folder that may go.
   */
  async function imageOfferView(
    key: string,
    offer: RecompImageOfferRecord,
    game: Game | null,
    rec: InstalledRecomp,
    folder: RecompUnpackedFolder | null
  ): Promise<RecompImageOffer> {
    const owner = game ?? library.getGame(offer.gameId) ?? null
    const name = entryOf(offer.recompId, rec)?.name ?? offer.recompId
    const base = {
      key,
      recompId: offer.recompId,
      recompName: name,
      gameId: offer.gameId,
      gameTitle: owner
        ? displayTitle(owner)
        : (unpackedSetupFor(offer.recompId, unpackedSetups())?.game ?? name),
      folder,
      at: offer.at
    }
    if (!game || !offer.image) return { ...base, fileName: null, files: [], totalBytes: null }
    const image = offer.image
    const plan = await deps.originalImage
      ?.plan(game.id, { recompRunning: recompRunningFor(game.id) })
      .catch(() => null)
    const paths = plan && 'paths' in plan && plan.paths.length ? plan.paths : [image]
    const main = paths.find((p) => normalizePath(p) === normalizePath(image))
    const ordered = main ? [main, ...paths.filter((p) => p !== main)] : paths
    let totalBytes: number | null = plan && 'paths' in plan ? plan.totalBytes : null
    if (totalBytes === null && !(plan && 'paths' in plan))
      totalBytes = (await fs.stat(image).catch(() => null))?.size ?? null
    return {
      ...base,
      fileName: basename(image),
      files: ordered.map((p) => basename(p)),
      totalBytes
    }
  }

  /** The library game of a waiting question while it still holds that image, else null (the image part is stale). */
  function offerGame(offer: RecompImageOfferRecord): Game | null {
    if (!offer.image) return null
    const game = library.getGame(offer.gameId)
    return game && hasDiscImage(game) && normalizePath(game.romPath!) === normalizePath(offer.image)
      ? game
      : null
  }

  /** The disc image is a file on disk (one moved or deleted by hand is not: there is nothing to delete). */
  const imageOnDisk = async (path: string): Promise<boolean> =>
    (await fs.stat(path).catch(() => null))?.isFile() ?? false

  /** The image part of a question while it may still be answered with Delete: its game; else why not ('gone'). */
  async function imagePart(
    offer: RecompImageOfferRecord,
    rec: InstalledRecomp | undefined
  ): Promise<{ game: Game } | { why: string }> {
    const game = offerGame(offer)
    // No longer on disk (moved into the recompilation's folder or deleted by hand): nothing left to offer.
    if (!game || !(await imageOnDisk(offer.image!))) return { why: 'gone' }
    const why = await offerStale(offer, game, rec).catch(() => null)
    return why ? { why } : { game }
  }

  /**
   * The waiting questions. A question whose recompilation is gone, or whose image is gone or needed now (offerStale:
   * its game files or program changed since) and whose folder (if any) must stay now (folderOf), is dropped (a later
   * trigger may ask again); one with a part left shows that part only.
   */
  async function pendingImageOffers(): Promise<RecompImageOffer[]> {
    const st = await state()
    const m = await st.read()
    const out: RecompImageOffer[] = []
    const stale: string[] = []
    for (const [key, offer] of Object.entries(m.imageOffers)) {
      if (offer.state !== 'pending') continue
      const rec = m.installed[offer.recompId]
      const image = offer.image ? await imagePart(offer, rec) : null
      const folder = rec ? await offerFolder(offer, m) : null
      const imageGame = image && 'game' in image ? image.game : null
      if (!rec || (!imageGame && !folder)) {
        if (image && 'why' in image && image.why !== 'gone')
          log.info(
            `recomp: ${offer.recompId}: no longer asking about ${offer.image} (${image.why})`
          )
        stale.push(key)
        continue
      }
      out.push(
        await imageOfferView(key, offer, imageGame, rec, folder ? folderView(folder, m) : null)
      )
    }
    if (stale.length)
      await st.update((mm) => {
        for (const key of stale)
          if (mm.imageOffers[key]?.state === 'pending') delete mm.imageOffers[key]
      })
    return out
  }

  async function emitImageOffers(): Promise<void> {
    events.emit('recomp:image-offers', { offers: await pendingImageOffers() })
  }

  /** Recompilation `id`'s game files or program changed: a question waiting for it is checked again (pendingImageOffers). */
  async function recheckImageOffers(id: string): Promise<void> {
    const m = await (await state()).read()
    if (Object.values(m.imageOffers).some((o) => o.state === 'pending' && o.recompId === id))
      await emitImageOffers()
  }

  /**
   * Answer a question. Keep it remembers every item it asked about. A delete checks again what it moves first (nothing
   * moves when one of them must stay now), moves the folder before the image (the image can unpack it again), and
   * remembers the item it left out as kept.
   */
  async function answerImageOffer(
    key: string,
    answer: RecompDeleteChoice | 'keep'
  ): Promise<{ ok: boolean; message: string }> {
    const st = await state()
    const offer = (await st.read()).imageOffers[key]
    if (!offer || offer.state !== 'pending')
      return { ok: false, message: tMain('mainRecomp.offer.answered') }
    const name = offer.image ? basename(offer.image) : 'the unpacked game folder'
    const mark = (
      next: RecompImageOfferRecord['state'],
      folderNext?: RecompUnpackedFolderRecord['state']
    ): Promise<unknown> =>
      st.update((mm) => {
        const o = mm.imageOffers[key]
        if (o) o.state = next
        if (folderNext && offer.folder) setFolderState(mm, offer.folder, folderNext)
      })
    // An item is remembered as kept only when the player saw it in the question (it may go now): the folder
    // (offerFolder) and the image (imagePart: the question shows the folder alone while the image must stay).
    const folderShown = async (): Promise<boolean> =>
      !!offer.folder && !!(await offerFolder(offer, await st.read()).catch(() => null))
    const imageShown = async (): Promise<boolean> => {
      if (!offer.image) return false
      const rec = (await st.read()).installed[offer.recompId]
      const part = await imagePart(offer, rec).catch(() => null)
      return !!part && 'game' in part
    }
    /** The question asked about the folder alone: its image part goes back to unasked (a later trigger may ask). */
    const forgetImage = (folderNext: RecompUnpackedFolderRecord['state']): Promise<unknown> =>
      st.update((mm) => {
        if (mm.imageOffers[key]?.state === 'pending') delete mm.imageOffers[key]
        if (offer.folder) setFolderState(mm, offer.folder, folderNext)
      })
    if (answer === 'keep') {
      const sawFolder = await folderShown()
      if (offer.image && sawFolder && !(await imageShown())) await forgetImage('kept')
      else await mark('kept', sawFolder ? 'kept' : undefined)
      const kept = [offer.image, offer.folder].filter(Boolean).join(' and ')
      log.info(`recomp: ${offer.recompId}: keeping ${kept}`)
      await emitImageOffers()
      return { ok: true, message: `Kept ${offer.image ? name : offer.folder}` }
    }
    const wantImage = answer === 'delete' || answer === 'delete-both'
    const wantFolder = answer === 'delete-folder' || answer === 'delete-both'
    const folder = offer.folder ?? null
    if (wantFolder && !folder) return { ok: false, message: tMain('mainRecomp.offer.noFolder') }
    if (wantImage && !offer.image) return { ok: false, message: tMain('mainRecomp.offer.noImage') }
    const files = deps.originalImage
    if (!files) return { ok: false, message: tMain('mainRecomp.offer.noFiles') }
    // From the check until the folder has moved, no start of a recompilation using it gets in (startRecomp).
    const reserved = folder && wantFolder ? normalizePath(folder) : null
    if (reserved) {
      if (deletingFolders.has(reserved))
        return { ok: false, message: tMain('mainRecomp.offer.alreadyMoving', { folder: folder! }) }
      deletingFolders.add(reserved)
    }
    let holdId: string | null = null
    try {
      // Asked a while ago (a question waits across restarts): what holds now decides. The catalog first, so the
      // recompilation's game files are its real ones.
      await ensureCatalog()
      const m = await st.read()
      const rec = m.installed[offer.recompId]
      let game: Game | null = null
      if (wantImage) {
        const part = await imagePart(offer, rec)
        if ('why' in part) {
          // Gone, or needed now: the image part is dropped; a question with nothing else to offer goes.
          if (!folder || !rec)
            await st.update((mm) => {
              if (mm.imageOffers[key]?.state === 'pending') delete mm.imageOffers[key]
            })
          await emitImageOffers()
          if (part.why === 'gone')
            return { ok: false, message: tMain('mainRecomp.offer.gameGone', { name }) }
          log.info(`recomp: ${offer.recompId}: not deleting ${offer.image} (${part.why})`)
          return { ok: false, message: tMain('mainRecomp.offer.mustStay', { name, why: part.why }) }
        }
        game = part.game
      }
      if (folder && wantFolder) {
        const f = rec
          ? await folderOf(offer.recompId, m, library.getGame(offer.gameId) ?? null)
          : null
        const why = !rec
          ? tMain('mainRecomp.busy.noLongerInstalled')
          : !f
            ? tMain('mainRecomp.offer.notUnpacked')
            : 'why' in f
              ? f.why
              : normalizePath(f.record.folder) !== normalizePath(folder)
                ? tMain('mainRecomp.offer.otherFolder')
                : null
        if (why) {
          log.info(`recomp: ${offer.recompId}: not deleting ${folder} (${why})`)
          await emitImageOffers()
          return { ok: false, message: tMain('mainRecomp.offer.folderMustStay', { folder, why }) }
        }
      }
      // Only the folder goes: the image is remembered as kept when the question showed it (else it is asked later).
      const sawImage = answer === 'delete-folder' && (await imageShown())
      let result = { ok: true, message: '' }
      // The test run (held-files.ts): moved aside, not to the Recycle Bin, until the recompilation runs without it.
      if (holdMode(wantFolder)) {
        const held = await holdForTest(key, offer, game, folder && wantFolder ? folder : null)
        if (!held.ok) {
          await emitImageOffers()
          return held
        }
        holdId = held.holdId
        result = { ok: true, message: held.message }
        if (folder && wantFolder) await st.update((mm) => setFolderState(mm, folder, 'deleted'))
      } else if (folder && wantFolder) {
        const moved = await files.trashFolder!(folder)
        if (!moved.ok) {
          await emitImageOffers()
          return moved
        }
        await st.update((mm) => setFolderState(mm, folder, 'deleted'))
        log.info(`recomp: ${offer.recompId}: ${folder} moved to the Recycle Bin`)
        result = { ok: true, message: tMain('mainRecomp.offer.movedFolder', { folder }) }
      }
      if (game && !holdId) {
        const trashed = await files.trash(game.id, offer.recompId, {
          recompRunning: recompRunningFor(game.id)
        })
        if (trashed.ok)
          log.info(`recomp: ${offer.recompId}: ${offer.image} moved to the Recycle Bin`)
        result = !wantFolder
          ? trashed
          : trashed.ok
            ? { ok: true, message: tMain('mainRecomp.offer.movedBoth', { name, folder: folder! }) }
            : {
                ok: false,
                message: tMain('mainRecomp.offer.movedFolderNotImage', {
                  folder: folder!,
                  name,
                  error: trashed.message
                })
              }
      }
      // The question is answered once what was chosen moved; the item a delete left out is remembered as kept.
      if (answer === 'delete' && result.ok)
        await mark('deleted', (await folderShown()) ? 'kept' : undefined)
      else if (answer === 'delete-folder') {
        if (offer.image && !sawImage) await forgetImage('deleted')
        else await mark(offer.image ? 'kept' : 'deleted')
      } else if (answer === 'delete-both' && result.ok) await mark('deleted')
      await emitImageOffers()
      changed([offer.recompId])
      return result
    } finally {
      if (reserved) deletingFolders.delete(reserved)
      // Once moved aside, the test always runs (and takes the hold out of activeHolds), even when a manifest write
      // after the move failed: a hold is never left 'testing' with no question and no test.
      if (holdId) void runTest(holdId, true)
    }
  }

  // --- The test run after Delete (services/held-files.ts) -------------------------------------------------------
  // A Delete answer moves the image (and/or the unpacked folder) aside into a hidden folder beside it, keeps the card,
  // and starts the recompilation at once. Once the game is closed (its process, or the game a launcher it started
  // handed over to) after at least IMAGE_TEST_MS with a normal exit: the files go to the Recycle Bin. It did not start,
  // closed before, or exited with an error: the player is asked whether to restore them. A start refused for another reason (already running, a save conflict, which program…) judges
  // nothing: the files stay aside and the player picks Restore, Test again or Delete anyway. A test PlayOut did not
  // finish (it closed) is asked about at the next start. Nothing goes to the Recycle Bin untested or unasked.

  /** Holds being moved aside, tested or answered now (a record not in here and not judged was interrupted). */
  const activeHolds = new Set<string>()
  const testMs = (): number => deps.imageTestMs ?? IMAGE_TEST_MS
  const testPollMs = (): number => deps.imageTestPollMs ?? 1000
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => {
      setTimeout(r, Math.max(0, ms)).unref?.()
    })

  /** The test run is available (the file work can hold, release and restore; and hold a folder when one goes). */
  function holdMode(withFolder: boolean): boolean {
    const f = deps.originalImage
    return !!(f?.hold && f.release && f.restore && (!withFolder || f.holdFolder))
  }

  const recompNameOf = (id: string, m: RecompManifest): string =>
    entryOf(id, m.installed[id] ?? null)?.name ?? tMain('mainRecomp.launch.defaultName')

  /** What a hold moved aside, in words ("Burnout Revenge (USA).iso", "C:\…\game", or both). */
  const heldWhat = (r: Pick<RecompHeldRecord, 'image' | 'folder'>): string => {
    const image = r.image ? basename(r.image) : null
    if (image && r.folder)
      return tMain('mainRecomp.held.imageAndFolder', { image, folder: r.folder })
    return image || r.folder || tMain('mainRecomp.held.theFiles')
  }

  async function setHeld(holdId: string, patch: Partial<RecompHeldRecord>): Promise<void> {
    await (
      await state()
    ).update((mm) => {
      const r = mm.heldImages[holdId]
      if (r) Object.assign(r, patch)
    })
  }

  function heldView(r: RecompHeldRecord, m: RecompManifest): RecompHeldImage {
    const game = library.getGame(r.gameId)
    const state: RecompHeldImage['state'] =
      r.state === 'holding' || r.state === 'testing'
        ? activeHolds.has(r.holdId)
          ? 'testing'
          : 'interrupted'
        : r.state
    const image = r.image ? normalizePath(r.image) : null
    const names = r.entries.map((e) => basename(e.original))
    const main = r.entries.findIndex((e) => normalizePath(e.original) === image)
    const files = main > 0 ? [names[main]!, ...names.filter((_, i) => i !== main)] : names
    return {
      holdId: r.holdId,
      recompId: r.recompId,
      recompName: recompNameOf(r.recompId, m),
      gameId: r.gameId,
      gameTitle: game ? displayTitle(game) : basename(r.image ?? r.folder ?? r.gameId),
      fileName: r.image ? basename(r.image) : null,
      files,
      folder: r.folder,
      state,
      reason:
        state === 'interrupted'
          ? (r.reason ?? tMain('mainRecomp.held.interrupted'))
          : state === 'testing'
            ? null
            : r.reason,
      at: r.at,
      decidedAt: state === 'interrupted' ? (r.decidedAt ?? r.at) : r.decidedAt
    }
  }

  async function heldImages(): Promise<RecompHeldImage[]> {
    const m = await (await state()).read()
    return Object.values(m.heldImages)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((r) => heldView(r, m))
  }

  async function emitHeld(note?: { ok: boolean; message: string }): Promise<void> {
    events.emit('recomp:held-images', { items: await heldImages(), ...(note ? { note } : {}) })
  }

  /**
   * Move what a Delete answer picked aside (the folder first, then the image), recorded before anything moves. On a
   * failure what moved goes back; anything that cannot stays recorded and is asked about. On success the hold stays
   * in activeHolds for runTest.
   */
  async function holdForTest(
    key: string,
    offer: RecompImageOfferRecord,
    game: Game | null,
    folder: string | null
  ): Promise<{ ok: true; holdId: string; message: string } | { ok: false; message: string }> {
    const files = deps.originalImage!
    const st = await state()
    const holdId = newHoldId(now().getTime())
    const record: RecompHeldRecord = {
      holdId,
      recompId: offer.recompId,
      gameId: offer.gameId,
      offerKey: key,
      image: game ? offer.image : null,
      folder,
      entries: [],
      at: now().toISOString(),
      state: 'holding',
      reason: null,
      decidedAt: null
    }
    let committed: HeldEntry[] = []
    const beforeMove = (entries: HeldEntry[]): Promise<unknown> =>
      st.update((mm) => {
        mm.heldImages[holdId] = {
          ...(mm.heldImages[holdId] ?? record),
          entries: [...committed, ...entries]
        }
      })
    /** A failure: keep only what is still aside (asked about), or forget the record. */
    const settle = async (still: HeldEntry[], why: string): Promise<void> => {
      await st.update((mm) => {
        if (!still.length) delete mm.heldImages[holdId]
        else
          mm.heldImages[holdId] = {
            ...(mm.heldImages[holdId] ?? record),
            entries: still,
            state: 'not-tested',
            reason: why,
            decidedAt: now().toISOString()
          }
      })
      activeHolds.delete(holdId)
      await emitHeld()
    }
    activeHolds.add(holdId)
    try {
      if (folder) {
        const r = await files.holdFolder!(folder, holdId, { beforeMove })
        if (!r.ok) {
          await settle(r.stuck, r.message)
          return { ok: false, message: r.message }
        }
        committed = r.entries
      }
      if (game) {
        const r = await files.hold!(game.id, offer.recompId, holdId, {
          recompRunning: recompRunningFor(game.id),
          beforeMove
        })
        if (!r.ok) {
          // The folder went aside already: it goes back (nothing deleted), else it stays asked about.
          let still = [...committed, ...r.stuck]
          if (committed.length) {
            const back = await files.restore!(committed, holdId, null)
            still = [...back.left, ...r.stuck]
          }
          await settle(still, r.message)
          return { ok: false, message: r.message }
        }
        committed = [...committed, ...r.entries]
      }
      await setHeld(holdId, { state: 'testing', entries: committed })
    } catch (err) {
      await settle(committed, message(err)).catch(() => {})
      return {
        ok: false,
        message: tMain('mainRecomp.held.nothingMoreMoved', { error: message(err) })
      }
    }
    const name = recompNameOf(offer.recompId, await st.read())
    log.info(
      `recomp: ${offer.recompId}: ${heldWhat(record)} moved aside; starting it to check it runs without`
    )
    return {
      ok: true,
      holdId,
      message: tMain('mainRecomp.held.movedAside', { what: heldWhat(record), name })
    }
  }

  type TestVerdict =
    { state: 'passed' } | { state: 'crashed' | 'not-tested'; reason: string } | null

  /** Seconds in words. */
  const secs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))} s`

  /** A start refused: whether that says anything about the image ('crashed') or not ('not-tested'). */
  function refusalVerdict(
    result: Exclude<RecompLaunchResult, { ok: true }>,
    name: string
  ): TestVerdict {
    switch (result.reason) {
      case 'failed':
        if (disposed) return null
        return {
          state: 'crashed',
          reason: tMain('mainRecomp.test.didNotStart', { name, error: result.message })
        }
      case 'needs-files':
        return { state: 'crashed', reason: tMain('mainRecomp.test.asksForFiles', { name }) }
      case 'save-conflict':
        return {
          state: 'not-tested',
          reason: tMain('mainRecomp.test.saveConflict')
        }
      case 'choose-exe':
        return {
          state: 'not-tested',
          reason: tMain('mainRecomp.test.chooseExe', { name })
        }
      default:
        return { state: 'not-tested', reason: result.message }
    }
  }

  /**
   * Start the recompilation and judge it once it has closed (null: PlayOut is closing, no verdict). Still running
   * proves nothing: a recompilation that cannot find its disc image often waits on an error box or a "select your
   * ISO" picker. So the verdict waits for the end of the play session (its process, or the game a launcher it
   * started handed over to). Passed: the session lasted at least IMAGE_TEST_MS and the process exited normally (exit
   * code 0). Crashed: it did not start, it closed before IMAGE_TEST_MS, or it exited with an error code or a signal
   * (asked about: the player may still answer Delete anyway).
   */
  async function testStart(r: RecompHeldRecord, name: string): Promise<TestVerdict> {
    type Exit = { code: number | null; signal: string | null; at: number }
    let spawnedAt = 0
    let exit: Exit | null = null
    let result: RecompLaunchResult
    try {
      result = await launch(r.gameId, r.recompId, (child) => {
        spawnedAt = Date.now()
        // It may have exited while the start was still being noted (exitCode / signalCode are set then).
        const code = typeof child.exitCode === 'number' ? child.exitCode : null
        const signal = typeof child.signalCode === 'string' ? child.signalCode : null
        if (code !== null || signal !== null) exit = { code, signal, at: Date.now() }
        else
          child.once('exit', (c: number | null, s: string | null) => {
            exit ??= { code: c, signal: s, at: Date.now() }
          })
      })
    } catch (err) {
      result = { ok: false, reason: 'failed', message: message(err) }
    }
    if (disposed) return null
    if (!result.ok) return refusalVerdict(result, name)
    if (!spawnedAt)
      return { state: 'not-tested', reason: tMain('mainRecomp.test.notWatched', { name }) }
    const grace = testMs()
    // The last time the play session was seen going on after the process exited (a launcher handed over to the game).
    let sessionSeenAt = 0
    for (;;) {
      if (disposed) return null
      const ended = exit as Exit | null
      const session = launcher.running()?.gameId === r.gameId
      if (ended && session) sessionSeenAt = Date.now()
      if (ended && !session) {
        const lasted = Math.max(ended.at, sessionSeenAt) - spawnedAt
        const clean = !ended.signal && ended.code === 0
        if (clean && lasted >= grace) return { state: 'passed' }
        // One whole sentence per case (how long it ran, and the signal or exit code when there is one).
        const late = lasted >= grace
        const vars = { name, time: secs(lasted) }
        const reason = ended.signal
          ? late
            ? tMain('mainRecomp.test.closedWithErrorSignal', { ...vars, signal: ended.signal })
            : tMain('mainRecomp.test.closedEarlySignal', { ...vars, signal: ended.signal })
          : ended.code !== null && ended.code !== 0
            ? late
              ? tMain('mainRecomp.test.closedWithErrorCode', { ...vars, code: ended.code })
              : tMain('mainRecomp.test.closedEarlyCode', { ...vars, code: ended.code })
            : late
              ? tMain('mainRecomp.test.closedWithError', vars)
              : tMain('mainRecomp.test.closedEarly', vars)
        return { state: 'crashed', reason }
      }
      await sleep(testPollMs())
    }
  }

  /** Run (or run again) the test of a hold. `reserved`: the caller holds it in activeHolds already. */
  async function runTest(holdId: string, reserved = false): Promise<void> {
    if (!reserved) {
      if (activeHolds.has(holdId)) return
      activeHolds.add(holdId)
    }
    try {
      const st = await state()
      const r = (await st.read()).heldImages[holdId]
      if (!r || disposed) return
      await setHeld(holdId, { state: 'testing', reason: null, decidedAt: null })
      await emitHeld()
      const name = recompNameOf(r.recompId, await st.read())
      const verdict = await testStart(r, name)
      // PlayOut is closing: the record stays 'testing' and is asked about at the next start.
      if (!verdict || disposed) return
      const decidedAt = now().toISOString()
      const what = heldWhat(r)
      if (verdict.state === 'passed') {
        const current = (await st.read()).heldImages[holdId] ?? r
        const out = await deps.originalImage!.release!(current.entries, holdId)
        if (out.ok) {
          await st.update((mm) => {
            delete mm.heldImages[holdId]
          })
          log.info(`recomp: ${r.recompId}: runs without ${what}; moved it to the Recycle Bin`)
          activeHolds.delete(holdId)
          await emitHeld({
            ok: true,
            message: tMain('mainRecomp.test.passedMoved', { name, what })
          })
          changed([r.recompId])
          return
        }
        await setHeld(holdId, {
          state: 'passed',
          entries: out.left,
          reason: tMain('mainRecomp.test.passedButNot', { name, error: out.message }),
          decidedAt
        })
      } else {
        log.info(
          `recomp: ${r.recompId}: test without ${what}: ${verdict.state} (${verdict.reason})`
        )
        await setHeld(holdId, { state: verdict.state, reason: verdict.reason, decidedAt })
      }
      activeHolds.delete(holdId)
      await emitHeld()
    } catch (err) {
      log.warn(`recomp: the test run of ${holdId} failed: ${message(err)}`)
      await setHeld(holdId, {
        state: 'not-tested',
        reason: tMain('mainRecomp.test.couldNotCheck', { error: message(err) }),
        decidedAt: now().toISOString()
      }).catch(() => {})
      activeHolds.delete(holdId)
      await emitHeld().catch(() => {})
    } finally {
      activeHolds.delete(holdId)
    }
  }

  /** Answer a held image's question (RecompHeldAnswer). */
  async function answerHeld(
    holdId: string,
    answer: RecompHeldAnswer
  ): Promise<{ ok: boolean; message: string }> {
    const st = await state()
    const m = await st.read()
    const r = m.heldImages[holdId]
    if (!r) return { ok: false, message: tMain('mainRecomp.offer.answered') }
    if (activeHolds.has(holdId))
      return { ok: false, message: tMain('mainRecomp.held.stillChecking') }
    const files = deps.originalImage
    if (!files?.release || !files.restore)
      return { ok: false, message: tMain('mainRecomp.held.cannotMove') }
    const name = recompNameOf(r.recompId, m)
    const what = heldWhat(r)
    if (answer === 'retry') {
      void runTest(holdId)
      return { ok: true, message: tMain('mainRecomp.held.startingAgain', { name, what }) }
    }
    activeHolds.add(holdId)
    try {
      if (answer === 'delete') {
        const out = await files.release(r.entries, holdId)
        if (!out.ok) {
          await setHeld(holdId, { entries: out.left, reason: out.message })
          return { ok: false, message: out.message }
        }
        await st.update((mm) => {
          delete mm.heldImages[holdId]
        })
        log.info(`recomp: ${r.recompId}: ${what} moved to the Recycle Bin (Delete anyway)`)
        return { ok: true, message: tMain('mainRecomp.held.moved', { what }) }
      }
      const out = await files.restore(
        r.entries,
        holdId,
        r.image ? { gameId: r.gameId, image: r.image } : null
      )
      if (out.left.length) {
        await setHeld(holdId, { entries: out.left, reason: out.message })
        return { ok: false, message: out.message }
      }
      // Back: the image (and folder) is remembered as kept for this recompilation (not offered again).
      await st.update((mm) => {
        delete mm.heldImages[holdId]
        if (r.image) {
          const own = mm.imageOffers[r.offerKey]
          const key =
            own?.image && normalizePath(own.image) === normalizePath(r.image)
              ? r.offerKey
              : imageOfferKey(r.recompId, r.image)
          mm.imageOffers[key] = {
            ...(mm.imageOffers[key] ?? {
              recompId: r.recompId,
              gameId: r.gameId,
              image: r.image,
              at: r.at
            }),
            state: 'kept'
          }
        }
        if (r.folder) {
          const f = mm.unpackedFolders[normalizePath(r.folder)]
          if (f) f.state = 'kept'
        }
      })
      log.info(`recomp: ${r.recompId}: restored ${what}`)
      return { ok: true, message: out.ok ? `Restored ${what}` : out.message }
    } finally {
      activeHolds.delete(holdId)
      await emitHeld().catch(() => {})
      await emitImageOffers().catch(() => {})
      changed([r.recompId])
    }
  }

  /**
   * The Recompilation page's "Delete…": ask about the game's disc image and/or the game folder PlayOut unpacked for the
   * recompilation's setup program again, even after Keep it. Rejects when neither may go (the image's reason first).
   */
  async function askImageAgain(gameId: string, recompId: string): Promise<RecompImageOffer> {
    const game = gameOf(gameId)
    await ensureCatalog()
    if (!(titleForGame(game)?.entries.includes(recompId) ?? false))
      throw new Error(tMain('mainRecomp.image.notThisGame'))
    const rec = await requireInstalled(recompId)
    const entry = (await effectiveEntry(recompId, rec))!
    if (!deps.originalImage) throw new Error(tMain('mainRecomp.image.cannotDelete'))
    const m = await (await state()).read()
    const f = await folderOf(recompId, m, game)
    const folder = f && 'record' in f ? f : null
    let image: string | null = null
    let imageWhy = tMain('mainRecomp.image.none')
    if (hasDiscImage(game)) {
      const plan = await deps.originalImage.plan(game.id, {
        recompRunning: recompRunningFor(game.id)
      })
      if ('refusal' in plan) imageWhy = plan.refusal
      else {
        const why = await imageNeeded(rec, entry, game, [game.romPath!, ...plan.paths])
        if (why)
          imageWhy = tMain('mainRecomp.image.mustStay', { file: basename(game.romPath!), why })
        else image = game.romPath!
      }
    }
    if (!image && !folder) {
      const record = unpackedRecordOf(m, recompId)
      throw new Error(
        f && 'why' in f && record && !hasDiscImage(game)
          ? tMain('mainRecomp.image.folderMustStay', { folder: record.folder, why: f.why })
          : imageWhy
      )
    }
    const key = image
      ? imageOfferKey(recompId, image)
      : folderOfferKey(recompId, folder!.record.folder)
    const record: RecompImageOfferRecord = {
      state: 'pending',
      recompId,
      gameId,
      image,
      ...(folder ? { folder: folder.record.folder } : {}),
      at: now().toISOString()
    }
    const after = await (
      await state()
    ).update((mm) => {
      mm.imageOffers[key] = record
    })
    await emitImageOffers()
    return imageOfferView(
      key,
      record,
      image ? game : null,
      rec,
      folder ? folderView(folder, after) : null
    )
  }

  /**
   * The Recompilation page's "Delete…" section: this game's image when an installed recompilation can do without it,
   * and the game folder PlayOut unpacked for that recompilation's setup program when it no longer uses it.
   */
  async function originalImageOf(
    game: Game,
    m: RecompManifest,
    order: string[],
    gameFiles: Record<string, GameFileState[]>
  ): Promise<GameRecomps['originalImage']> {
    if (!deps.originalImage) return null
    const image = hasDiscImage(game) ? game.romPath! : null
    // Its whole file set (cue/bin tracks, m3u discs), as the button checks it; just the image while it is in use.
    const plan = image
      ? await deps.originalImage
          .plan(game.id, { recompRunning: recompRunningFor(game.id) })
          .catch(() => null)
      : null
    const files = !image ? [] : plan && 'paths' in plan ? [image, ...plan.paths] : [image]
    for (const id of order) {
      const rec = m.installed[id]
      const entry = rec ? await effectiveEntry(id, rec) : null
      if (!rec || !entry) continue
      const imageOk = !!image && !(await imageNeeded(rec, entry, game, files, gameFiles[id]))
      const f = await folderOf(id, m, game, gameFiles[id]).catch(() => null)
      const folder = f && 'record' in f ? folderView(f, m) : null
      if (!imageOk && !folder) continue
      const state = imageOk ? m.imageOffers[imageOfferKey(id, image!)]?.state : undefined
      return {
        recompId: id,
        fileName: imageOk ? basename(image!) : null,
        kept: state === 'kept',
        folder
      }
    }
    return null
  }

  // --- views ------------------------------------------------------------------------------------------------------

  async function catalogStatus(): Promise<RecompCatalogStatus> {
    return {
      fetchedAt: catalog?.fetchedAt ?? { 'decomp-buddy': null, recomplauncher: null },
      entries: catalog?.entries.size ?? 0,
      titles: catalog?.titles.size ?? 0,
      matchedGames: library.games().filter((g) => g.metadata.recomp && !g.remote).length,
      newEntries: newCount(),
      offline: catalog?.offline ?? [],
      refreshing
    }
  }

  /** Suggested save folders (real paths) that are usable here and not already in use. */
  function suggestionsOf(rec: InstalledRecomp, inUse: string[], ctx: SaveContext): string[] {
    const out: string[] = []
    for (const t of usableSaveTemplates(rec.saveSuggestions ?? [], ctx)) {
      const real = expandSaveTemplate(t, ctx)
      if (!real || inUse.some((u) => isInside(u, real) || isInside(real, u))) continue
      out.push(real)
    }
    return out
  }

  /**
   * One recompilation's saves: folders in use, suggestions, and where the copies live (`names`: the copy folders,
   * read once for a whole listing).
   */
  async function savesView(
    id: string,
    rec: InstalledRecomp,
    names?: string[] | null
  ): Promise<RecompSaves> {
    const entry = entryOf(id, rec)!
    const ctx = saveCtx(rec)
    let templates: string[] = []
    let source = rec.saveSource
    try {
      ;({ paths: templates, source } = await resolveSavePaths(entry, rec, ctx))
    } catch {
      /* unreadable install: no save folders shown */
    }
    const resolved = expandSavePaths(templates, ctx)
    return {
      templates,
      resolved,
      source: templates.length ? source : rec.saveSource,
      suggestions: suggestionsOf(rec, resolved, ctx),
      savesDir: await copyDirOf(id, rec, names),
      cloud: rec.cloud
    }
  }

  /**
   * Look for the save folders in the usual places (findSaveFolders). With none known, a single folder found is used
   * (source 'detected') only when it is a strong match (named like the whole game, project, repository or program, or a
   * save folder of the install): a folder sharing just a word ("DarkSoulsIII" for Perfect Dark) is only offered; everything else found and not in use becomes the suggestions. PlayOut's own folders and the
   * other recompilations' save folders are never offered.
   */
  async function findSaves(id: string): Promise<RecompSaves> {
    const st = await state()
    const m = await st.read()
    const rec = m.installed[id]
    if (!rec) throw new Error(tMain('mainRecomp.notInstalled'))
    const entry = entryOf(id, rec)!
    const ctx = saveCtx(rec)
    const current = await resolveSavePaths(entry, rec, ctx)
    const inUse = expandSavePaths(current.paths, ctx)
    const exclude = [await root(), emulationDir(), deps.userData]
    for (const other of Object.values(m.installed)) {
      if (other.id === id) continue
      exclude.push(other.dir)
      exclude.push(...expandSavePaths(other.savePaths, saveCtx(other)))
    }
    const found = await findSaveFolders(entry, rec, ctx, { exclude })
    const freshFound = found.filter(
      (f) => !inUse.some((u) => isInside(u, f.path) || isInside(f.path, u))
    )
    const fresh = freshFound.map((f) => f.path)
    const useOne = !current.paths.length && freshFound.length === 1 && freshFound[0]!.strong
    if (fresh.length)
      log.info(
        `recomp: ${id} save folders found: ${fresh.join(', ')}${useOne ? ' (using it)' : ''}`
      )
    const next = await st.update((mm) => {
      const r = mm.installed[id]
      if (!r) return
      if (useOne) {
        r.savePaths = [toSaveTemplate(fresh[0]!, ctx)]
        r.saveSource = 'detected'
        r.saveSuggestions = []
      } else {
        r.saveSuggestions = fresh.map((p) => toSaveTemplate(p, ctx))
      }
    })
    changed([id])
    const after = next.installed[id]
    if (!after) throw new Error(tMain('mainRecomp.notInstalled'))
    return savesView(id, after)
  }

  /**
   * Settings › Recompilations' "Delete…" for recompilation `id`: what of a matched game (`gameIds`, the first with
   * something) may go, as the game's Recompilation page offers it for this recompilation. Never fails the listing.
   */
  async function originalImageOfRow(
    id: string,
    m: RecompManifest,
    gameIds: string[]
  ): Promise<RecompRow['originalImage']> {
    for (const gameId of gameIds) {
      const game = library.games().find((g) => g.id === gameId)
      if (!game || game.remote) continue
      const found = await originalImageOf(game, m, [id], {}).catch((err: unknown) => {
        log.warn(`recomp: could not read what of ${gameId} may be deleted (${message(err)})`)
        return null
      })
      if (found) return { ...found, gameId }
    }
    return null
  }

  async function rowOf(
    rec: InstalledRecomp,
    m: RecompManifest,
    names?: string[] | null
  ): Promise<RecompRow> {
    const all = m.installed
    const entry = entryOf(rec.id, rec)!
    const key = titleOfEntry.get(rec.id)
    const title = key ? catalog?.titles.get(key) : undefined
    const saves = await savesView(rec.id, rec, names)
    const gameIds = key
      ? library
          .games()
          .filter((g) => g.metadata.recomp?.titleKey === key && !g.remote)
          .map((g) => g.id)
      : []
    return {
      entry,
      installed: {
        ...rec,
        savePaths: saves.templates,
        saveSource: saves.source
      },
      gameIds,
      update: rec.pinnedTag ? null : (updates.get(rec.id) ?? null),
      release: releaseInfo.get(rec.id) ?? null,
      alternatives: (title?.entries ?? [])
        .filter((id) => id !== rec.id)
        .map((id) => ({ id, name: catalog?.entries.get(id)?.name ?? id, installed: !!all[id] })),
      resolvedSavePaths: saves.resolved,
      savesDir: saves.savesDir,
      saveSuggestions: saves.suggestions,
      originalImage: await originalImageOfRow(rec.id, m, gameIds)
    }
  }

  // --- recompilations added in the browser ------------------------------------------------------------------------

  /** Note how far an add got (the cloud sent it, or refused it: `refused` says why). */
  async function noteAddedState(
    id: string,
    st: AddedRecompState,
    prUrl?: string,
    refused?: string
  ): Promise<void> {
    await loadAdded()
    const entry = added.find((a) => a.id === id)
    const why = st === 'local' ? refused || undefined : undefined
    if (!entry || (entry.state === st && entry.prUrl === prUrl && entry.refused === why)) return
    await saveAdded(
      added.map((a) => {
        if (a.id !== id) return a
        const next: AddedRecomp = { ...a, state: st, ...(prUrl ? { prUrl } : {}) }
        if (why) next.refused = why
        else delete next.refused
        return next
      })
    )
    if (st === 'published') await noteKnown([id])
    changed([id])
  }

  /**
   * Send the adds that wait: 'queued' ones the cloud's queue does not hold, and (while the cloud sends adds) 'local'
   * ones made while sending was off. One the cloud refused is never sent again.
   */
  function sendWaiting(): void {
    const cloud = deps.cloud
    if (!cloud) return
    const queued = new Set(cloud.queuedRecompIds())
    const sends = cloud.sendsRecomps()
    for (const a of added) {
      if (queued.has(a.id)) continue
      if (a.state === 'queued' || (sends && a.state === 'local' && !a.refused)) void sendAdded(a)
    }
  }

  /** Send an add to the metadata cloud (the owner publishes, anyone else suggests) and note how far it got. */
  async function sendAdded(entry: AddedRecomp): Promise<void> {
    if (!deps.cloud) return
    try {
      const r = await deps.cloud.submitRecomp({
        id: entry.id,
        repo: entry.repo,
        game: entry.game,
        systemId: entry.systemId,
        ...(entry.blurb ? { blurb: entry.blurb } : {})
      })
      // Removed while it was being sent, or a flush sent it meanwhile (and noted it): nothing to note.
      const current = added.find((a) => a.id === entry.id)
      if (!current || r.state === null) return
      // Never back from sent to unsent: a late answer of this call loses to what a flush noted already.
      if (
        (current.state === 'suggested' || current.state === 'published') &&
        (r.state === 'local' || r.state === 'queued')
      )
        return
      await noteAddedState(entry.id, r.state, r.prUrl, r.refused)
    } catch (err) {
      log.warn(`recomp: ${entry.repo} could not be sent`, err)
    }
  }

  // --- the API ----------------------------------------------------------------------------------------------------

  const api: RecompMethods = {
    async getGameRecomps(gameId): Promise<GameRecomps | null> {
      const game = gameOf(gameId)
      await ensureCatalog()
      const title = titleForGame(game)
      if (!title || !catalog) return null
      const m = await (await state()).read()
      const preferred = defaultPreferred(
        title,
        Object.keys(m.installed),
        m.preferred[title.key] ?? null
      )
      const entries: RecompEntry[] = []
      const installed: Record<string, InstalledRecomp> = {}
      const gameFiles: Record<string, GameFileState[]> = {}
      for (const id of title.entries) {
        const rec = m.installed[id] ?? null
        const entry = await effectiveEntry(id, rec)
        if (!entry) continue
        entries.push(entry)
        if (rec) installed[id] = rec
        gameFiles[id] = await statesFor(entry, rec, game)
      }
      return {
        gameId,
        title,
        entries,
        installed,
        preferred,
        updates: Object.fromEntries(
          title.entries.flatMap((id) =>
            updates.has(id) && !m.installed[id]?.pinnedTag ? [[id, updates.get(id)!]] : []
          )
        ),
        gameFiles,
        libraryFiles: libraryFilesFor(game),
        originalImage: await originalImageOf(
          game,
          m,
          [preferred, ...title.entries.filter((id) => id !== preferred)],
          gameFiles
        )
      }
    },

    async setPreferredRecomp(gameId, recompId) {
      const game = gameOf(gameId)
      await ensureCatalog()
      const title = titleForGame(game)
      if (!title || !title.entries.includes(recompId))
        throw new Error(tMain('mainRecomp.image.notThisGame'))
      await (
        await state()
      ).update((m) => {
        m.preferred[title.key] = recompId
      })
      await rematch()
      changed([recompId])
    },

    async installRecomp(recompId, tag) {
      await ensureCatalog()
      const rec = await installedOf(recompId)
      if (!entryOf(recompId, rec)) throw new Error(tMain('mainRecomp.notInCatalog'))
      enqueue(recompId, tag)
    },

    async updateRecomp(recompId) {
      await requireInstalled(recompId)
      enqueue(recompId, undefined)
    },

    async setRecompVersion(recompId, tag) {
      await ensureCatalog()
      const rec = await requireInstalled(recompId)
      const refuse = (): void => {
        if (busy(recompId)) throw new Error(tMain('mainRecomp.version.installing'))
        if (inUse(recompId)) throw new Error(tMain('mainRecomp.version.running'))
      }
      refuse()
      const entry = entryOf(recompId, rec)
      if (!entry) throw new Error(tMain('mainRecomp.notInCatalog'))
      // Back to latest: the newest release, and the pin goes (runInstall).
      if (tag === null) return enqueue(recompId, undefined)
      const releases = await releasesOf(entry)
      const hint = hintOf(entry, rec)
      const release = releases.find((r) => !r.draft && sameTag(r.tag_name, tag))
      if (!release)
        throw new Error(tMain('mainRecomp.version.notRelease', { tag, name: entry.name }))
      if (!toRecompRelease(release, hint).asset)
        throw new Error(
          tMain('mainRecomp.version.noWindows', { tag: release.tag_name, name: entry.name })
        )
      refuse()
      // Already in use: only whether it is kept changes (unless what is installed is a side piece of the game, its
      // server or an editor: then the game is installed at that release).
      if (sameTag(release.tag_name, rec.tag) && !replacesSidePiece(release, rec, hint)) {
        const pin = pinFor(releases, release.tag_name, hint)
        await (
          await state()
        ).update((m) => {
          const r = m.installed[recompId]
          if (r) r.pinnedTag = pin
        })
        if (pin) updates.delete(recompId)
        noteReleases(recompId, rec.tag, releases, hint)
        changed([recompId])
        return
      }
      enqueue(recompId, release.tag_name)
    },

    async updateAllRecomps() {
      const m = await (await state()).read()
      for (const id of updates.keys())
        if (m.installed[id] && !m.installed[id].pinnedTag && !busy(id) && !inUse(id))
          enqueue(id, undefined)
    },

    async checkRecompUpdates() {
      await ensureCatalog()
      return checkUpdates(true)
    },

    async uninstallRecomp(recompId) {
      const rec = await requireInstalled(recompId)
      if (busy(recompId)) throw new Error(tMain('mainRecomp.version.installing'))
      if (inUse(recompId)) throw new Error(tMain('mainRecomp.version.running'))
      const r = await root()
      await uninstall(rec, { root: r, cacheDir: join(recompPlayoutDir(r), 'cache'), log, now })
      await (
        await state()
      ).update((m) => {
        delete m.installed[recompId]
      })
      updates.delete(recompId)
      releaseInfo.delete(recompId)
      progress.delete(recompId)
      await rematch()
      changed([recompId])
    },

    launchRecomp: (gameId, recompId) => launch(gameId, recompId),

    getRecompImageOffers: () => pendingImageOffers(),
    answerRecompImageOffer: answerImageOffer,
    askRecompImageDelete: askImageAgain,
    getRecompHeldImages: () => heldImages(),
    answerRecompHeldImage: answerHeld,

    async getRecompReleases(recompId) {
      await ensureCatalog()
      const rec = await installedOf(recompId)
      const entry = entryOf(recompId, rec)
      if (!entry) throw new Error(tMain('mainRecomp.notInCatalog'))
      const releases = await releasesOf(entry)
      const hint = hintOf(entry, rec)
      // The newest and the pin follow the rules of the update check and setRecompVersion, so the screens label and
      // warn as main acts.
      const newest = newestRelease(releases, hint)
      return releases
        .filter((r) => !r.draft)
        .map((r) => {
          const out = toRecompRelease(r, hint)
          return {
            ...out,
            newest: !!newest && sameTag(newest.tag_name, r.tag_name),
            pins: !!out.asset && pinFor(releases, r.tag_name, hint) !== null
          }
        })
    },

    async getRecompReadme(recompId) {
      await ensureCatalog()
      const entry = entryOf(recompId, await installedOf(recompId))
      if (!entry) return ''
      return fetchReadme(entry, httpCache())
    },

    async pickRecompGameFile(gameId, recompId, needId) {
      const game = gameOf(gameId)
      const rec = await installedOf(recompId)
      if (!rec) throw new Error(tMain('mainRecomp.files.installFirst'))
      const entry = (await effectiveEntry(recompId, rec))!
      const need = entry.needs.find((n) => n.id === needId)
      if (!need) throw new Error('Unknown game file')
      const path =
        need.accepts === 'folder'
          ? await deps.dialog.chooseFolder(`Choose ${need.label}`)
          : await deps.dialog.chooseFile({
              title: `Choose ${need.label}`,
              ...(need.formats.length
                ? {
                    filters: [
                      {
                        name: need.label,
                        extensions: need.formats.map((f) => f.replace(/^\./, ''))
                      },
                      { name: tMain('mainRecomp.dialog.allFiles'), extensions: ['*'] }
                    ]
                  }
                : {})
            })
      if (!path) return statesFor(entry, rec, game)
      return setGameFile(gameId, recompId, needId, path)
    },

    setRecompGameFile: setGameFile,

    listRecompExecutables: executablesOf,

    async setRecompExecutable(recompId, path) {
      await requireInstalled(recompId)
      if (busy(recompId)) throw new Error(tMain('mainRecomp.version.installing'))
      return setExecutable(recompId, path)
    },

    async pickRecompExecutable(recompId) {
      const rec = await requireInstalled(recompId)
      if (busy(recompId)) throw new Error(tMain('mainRecomp.version.installing'))
      const entry = entryOf(recompId, rec) ?? stubEntry(recompId, rec)
      const current = (await executablesOf(recompId)).currentFull
      const path = await deps.dialog.chooseFile({
        title: tMain('mainRecomp.dialog.chooseProgram', { name: entry.name }),
        filters: [{ name: tMain('mainRecomp.dialog.programs'), extensions: ['exe'] }],
        defaultPath: current ? dirname(current) : rec.dir
      })
      if (!path) return executablesOf(recompId)
      return setExecutable(recompId, path)
    },

    async getRecompSettings() {
      await ensureCatalog()
      await loadSeen()
      const m = await (await state()).read()
      const rows: RecompRow[] = []
      // The copy folders are read once (with a time limit) for every row, not once per recompilation.
      const names = await copyFolderNames()
      for (const rec of Object.values(m.installed)) rows.push(await rowOf(rec, m, names))
      rows.sort((a, b) => a.entry.name.localeCompare(b.entry.name))
      return {
        catalog: await catalogStatus(),
        root: await root(),
        savesDir: savesRoot(),
        rows,
        busy: [...progress.values()].filter((p) => busy(p.id))
      }
    },

    async browseRecomps() {
      await ensureCatalog()
      await loadAdded()
      await loadSeen()
      const addedById = new Map(added.map((a) => [a.id, a]))
      const m = await (await state()).read()
      const at = now()
      const gamesOf = new Map<string, string[]>()
      // The library is read once here: per recompilation it was read (and copied) twice, which made every heart or
      // install in the browser stall on a large library.
      const allGames = library.games()
      const cardOf = addedCards(allGames)
      for (const g of allGames) {
        const key = g.remote ? undefined : g.metadata.recomp?.titleKey
        if (!key) continue
        const list = gamesOf.get(key) ?? []
        list.push(g.id)
        gamesOf.set(key, list)
      }
      const favorites = new Set(m.favorites)
      const titles: RecompBrowseTitle[] = []
      let newCount = 0
      for (const t of catalog?.titles.values() ?? []) {
        const entries: RecompBrowseEntry[] = []
        let cover: string | null = null
        for (const id of t.entries) {
          const e = catalog!.entries.get(id)
          if (!e) continue
          cover ??= e.coverUrl
          const mine = e.sources.includes('user') ? addedById.get(id) : undefined
          const fresh = !mine && isNew(seen, id, at)
          if (fresh) newCount++
          entries.push({
            id,
            name: e.name,
            repo: e.repo,
            game: e.game,
            author: e.author,
            blurb: e.blurb,
            tags: e.tags,
            stars: e.stars,
            addedAt: e.addedAt ?? null,
            updatedAt: e.updatedAt ?? null,
            latestTag: e.latestTag,
            downloadBytes: e.downloadBytes,
            recommended: e.recommended,
            archived: e.archived,
            repoUrl: e.repoUrl,
            installed: !!m.installed[id],
            isNew: fresh,
            // Its own card's heart when it has one (a merge or a paired PC can change it there).
            favorite: cardOf.get(id)?.favorite ?? favorites.has(id),
            libraryGameId: cardOf.get(id)?.id ?? null,
            ...(mine
              ? {
                  added: mine.state,
                  awaiting: mine.state === 'queued' || mine.state === 'suggested',
                  ...(mine.state === 'local'
                    ? mine.refused
                      ? { notSent: 'refused' as const, refusedReason: mine.refused }
                      : { notSent: 'off' as const }
                    : {})
                }
              : {}),
            ...(isUnscannedRecomp(e.sources) ? { unscanned: true } : {})
          })
        }
        if (!entries.length) continue
        titles.push({
          key: t.key,
          game: t.game,
          systemId: t.systemId,
          console: t.console,
          coverUrl: cover,
          entries,
          gameIds: gamesOf.get(t.key) ?? []
        })
      }
      return { catalog: await catalogStatus(), titles, newCount }
    },

    async setRecompFavorite(recompId, favorite) {
      await (
        await state()
      ).update((mm) => {
        const rest = mm.favorites.filter((id) => id !== recompId)
        mm.favorites = favorite ? [...rest, recompId] : rest
      })
      // Its own library card, when it has one, shows it too.
      const card = addedCardOf(recompId)
      if (card && card.favorite !== favorite) deps.recompGames?.setFavorite?.(card.id, favorite)
      changed([recompId])
    },

    async addRecompToLibrary(recompId) {
      await ensureCatalog()
      const existing = addedCardOf(recompId)
      if (existing) return existing.id
      const cards = deps.recompGames
      if (!cards?.addEntry) throw new Error(tMain('mainRecomp.cards.cannotAdd'))
      const m = await (await state()).read()
      const entry = entryOf(recompId, m.installed[recompId] ?? null)
      if (!entry) throw new Error(tMain('mainRecomp.cards.notInCatalogs'))
      const key = titleOfEntry.get(recompId) ?? `${entry.systemId}:${entry.game.toLowerCase()}`
      const gameId = cards.addEntry({
        recompId,
        title: entry.name,
        platformId: !entry.systemId || entry.systemId === 'other' ? 'pc' : entry.systemId,
        recomp: {
          titleKey: key,
          count: 1,
          installed: m.installed[recompId] ? [recompId] : [],
          preferred: recompId,
          updatedAt: now().toISOString()
        },
        favorite: m.favorites.includes(recompId),
        description: entry.description || entry.blurb,
        developer: entry.author,
        art: { cover: entry.coverUrl, hero: entry.heroUrl, icon: entry.iconUrl }
      })
      log.info(`recomp: ${recompId} was added to the library as ${gameId}`)
      void rematch()
      changed([recompId])
      return gameId
    },

    async readRecompClipboard() {
      const text = (await deps.clipboardText?.()) ?? ''
      return text.trim().slice(0, 2048)
    },

    async checkRecompRepo(url) {
      await ensureCatalog()
      await loadAdded()
      const result = await checkRecompRepo(url, {
        cache: httpCache(),
        fetch: deps.fetch,
        fetchReleases,
        listed: (id) => catalog?.byRepo.get(id)?.[0] ?? (added.some((a) => a.id === id) ? id : null)
      })
      if (result.ok) checks.set(result.id, result)
      return result
    },

    async addRecomp(input) {
      await ensureCatalog()
      await loadAdded()
      const check = checks.get(input.id)
      if (!check) throw new Error(tMain('mainRecomp.add.checkFirst'))
      const game = oneLine(input.game, MAX_GAME_CHARS)
      if (!game) throw new Error(tMain('mainRecomp.add.gameMissing'))
      // The metadata repository's check (and every PlayOut) refuses HTML and script URLs: never stored or sent.
      if (!isPlainLine(game)) throw new Error(tMain('mainRecomp.add.gameNotPlain'))
      if (!isRecompConsole(input.systemId)) throw new Error(tMain('mainRecomp.add.consoleUnknown'))
      if (catalog?.byRepo.has(check.id) || added.some((a) => a.id === check.id))
        throw new Error(tMain('mainRecomp.add.alreadyListed', { repo: check.repo }))
      const sending = deps.cloud?.sendsRecomps() ?? false
      const entry: AddedRecomp = {
        id: check.id,
        repo: check.repo,
        game,
        systemId: input.systemId,
        // The repository's description, as one plain line (text a check would refuse is left out, not sent).
        ...(check.description && isPlainLine(check.description)
          ? { blurb: check.description }
          : {}),
        stars: check.stars,
        license: check.license,
        ...(check.archived ? { archived: true } : {}),
        ...(check.fork ? { fork: true } : {}),
        addedAt: now().toISOString(),
        state: sending ? 'queued' : 'local'
      }
      await saveAdded(withAdded(added, entry))
      checks.delete(check.id)
      log.info(`recomp: ${check.repo} was added (${game}, ${input.systemId})`)
      await rematch()
      changed([entry.id])
      // Sent only while the cloud sends adds; one made while sending is off goes once it is switched on (sendWaiting).
      if (deps.cloud && sending) void sendAdded(entry)
      return { id: entry.id, titleKey: titleOfEntry.get(entry.id) ?? '' }
    },

    async removeAddedRecomp(recompId, uninstallToo) {
      await loadAdded()
      const entry = added.find((a) => a.id === recompId)
      if (!entry) throw new Error(tMain('mainRecomp.add.notAdded'))
      // Its folder found again first when it was moved (as Uninstall does), so the right folder goes.
      const rec = uninstallToo ? await requireInstalled(recompId).catch(() => null) : null
      if (rec && uninstallToo) {
        if (busy(recompId)) throw new Error(tMain('mainRecomp.version.installing'))
        if (inUse(recompId)) throw new Error(tMain('mainRecomp.version.running'))
        const r = await root()
        const dir = resolve(rec.dir)
        if (!isInside(r, dir) || normalizePath(dir) === normalizePath(resolve(r)))
          throw new Error(tMain('mainRecomp.install.outsideFolder', { folder: dir }))
        if (deps.trash) {
          // To the Recycle Bin (never deleted for good); a folder already gone is fine.
          if (await fs.stat(dir).catch(() => null)) await deps.trash(dir)
          log.info(`recomp: ${recompId} was moved to the Recycle Bin from ${dir}`)
          // What Uninstall removes besides the folder: a half-done update and the cached download.
          const rmOpts = { recursive: true, force: true, maxRetries: 3 }
          await fs.rm(`${dir}.staging`, rmOpts).catch(() => undefined)
          await fs
            .rm(join(recompPlayoutDir(r), 'cache', 'downloads', safeRecompId(recompId)), rmOpts)
            .catch(() => undefined)
        } else
          await uninstall(rec, { root: r, cacheDir: join(recompPlayoutDir(r), 'cache'), log, now })
        await (
          await state()
        ).update((m) => {
          delete m.installed[recompId]
        })
        updates.delete(recompId)
        releaseInfo.delete(recompId)
        progress.delete(recompId)
      }
      deps.cloud?.withdrawRecomp(recompId)
      await saveAdded(added.filter((a) => a.id !== recompId))
      log.info(`recomp: ${entry.repo} was removed from the browser`)
      await rematch()
      changed([recompId])
    },

    async refreshRecompCatalog() {
      try {
        await loadNow(true)
      } catch (err) {
        log.warn('recomp: catalog refresh failed', err)
        if (!baseCatalog) throw err
      }
      changed([])
      return catalogStatus()
    },

    async setRecompAutoUpdate(recompId, on) {
      await requireInstalled(recompId)
      await (
        await state()
      ).update((m) => {
        const r = m.installed[recompId]
        if (r) r.autoUpdate = on
      })
      changed([recompId])
    },

    async setRecompSavePaths(recompId, paths) {
      const rec = await requireInstalled(recompId)
      const entry = entryOf(recompId, rec)!
      const ctx = saveCtx(rec)
      let templates: string[]
      let source: InstalledRecomp['saveSource']
      if (paths === null) {
        // Detect again: the developer's / catalog's folders, else detection around the next play.
        ;({ paths: templates, source } = await resolveSavePaths(
          entry,
          { ...rec, savePaths: [], saveSource: null },
          ctx
        ))
      } else {
        const asTemplates = paths.map((p) =>
          /^[a-z]:[\\/]/i.test(p) ? toSaveTemplate(resolve(p), ctx) : p
        )
        templates = usableSaveTemplates(asTemplates, ctx)
        if (templates.length < new Set(asTemplates).size)
          log.info(
            `recomp: ${recompId}: some save folders were left out (unsafe or not usable here)`
          )
        source = 'user'
      }
      await (
        await state()
      ).update((m) => {
        const r = m.installed[recompId]
        if (!r) return
        r.savePaths = templates
        r.saveSource = templates.length || paths !== null ? source : null
        // A suggestion now in use is no longer suggested.
        if (r.saveSuggestions?.length) {
          const used = expandSavePaths(templates, ctx).map(normalizePath)
          r.saveSuggestions = r.saveSuggestions.filter((t) => {
            const real = expandSaveTemplate(t, ctx)
            return !!real && !used.includes(normalizePath(real))
          })
        }
      })
      changed([recompId])
      return expandSavePaths(templates, ctx)
    },

    async addRecompSaveFolder(recompId, path) {
      const rec = await requireInstalled(recompId)
      const picked =
        path ?? (await deps.dialog.chooseFolder(tMain('mainRecomp.saves.chooseFolder')))
      const entry = entryOf(recompId, rec)!
      const ctx = saveCtx(rec)
      const current = (await resolveSavePaths(entry, rec, ctx)).paths
      if (!picked) return expandSavePaths(current, ctx)
      const real = resolve(picked)
      if (!isSafeSaveRoot(real, ctx)) throw new Error(tMain('mainRecomp.saves.tooBroad'))
      // PlayOut's own folders (the Emulation folder, the Recompilations folder, its data) are refused, and anything
      // holding one; a folder inside this recompilation's own install (a portable recompilation saving next to its
      // program, an install save folder Find offered) is its save folder (isSafeSaveRoot refuses the install itself).
      // The game's own folder counts too: a setup-program port (Xerenge) installs the game elsewhere, often beside it
      // in the Recompilations folder, and the program chosen under Program is there.
      const own = [emulationDir(), await root(), deps.userData].filter(Boolean)
      const gameDirs = [resolve(rec.dir)]
      if (isUserExe(rec)) {
        const gameDir = dirname(exeFullPath(rec, rec.exe!))
        // Never a PlayOut folder itself (a program chosen right in the Recompilations folder would open all of it).
        if (!own.some((d) => isInside(gameDir, d))) gameDirs.push(gameDir)
      }
      const inOwnInstall = gameDirs.some(
        (d) => isInside(d, real) && normalizePath(d) !== normalizePath(real)
      )
      const isPlayOuts =
        own.some((d) => isInside(real, d)) || (!inOwnInstall && own.some((d) => isInside(d, real)))
      if (isPlayOuts) throw new Error(tMain('mainRecomp.saves.ownFolder'))
      const st = await fs.stat(real).catch(() => null)
      if (!st?.isDirectory()) throw new Error(tMain('mainRecomp.saves.notFolder', { path: real }))
      const template = toSaveTemplate(real, ctx)
      return api.setRecompSavePaths(recompId, [...current, template])
    },

    async getRecompSaves(recompId) {
      await ensureCatalog()
      return savesView(recompId, await requireInstalled(recompId))
    },

    async findRecompSaveFolders(recompId) {
      await ensureCatalog()
      await requireInstalled(recompId)
      return findSaves(recompId)
    },

    async setRecompCloud(recompId, enabled) {
      await requireInstalled(recompId)
      const st = await state()
      await st.update((m) => {
        const r = m.installed[recompId]
        if (r) r.cloud = { ...r.cloud, enabled, pending: false, error: null }
      })
      changed([recompId])
      // While it is being played the first sync waits for the one after play (a restore now would hit the game).
      if (enabled && !inUse(recompId))
        void syncNow(recompId, 'manual')
          .catch((err) => log.warn(`recomp: first sync of ${recompId} failed (${message(err)})`))
          .finally(() => changed([recompId]))
    },

    async syncRecompSaves(recompId) {
      const next = await syncNow(recompId, 'manual')
      changed([recompId])
      return next
    },

    async resolveRecompConflict(recompId, keep) {
      const next = await withLock(recompId, async () => {
        if (inUse(recompId)) throw new Error(tMain('mainRecomp.saves.runningPick'))
        const st = await state()
        const rootDir = emulationDir()
        const m = await manifestFor(rootDir)
        const rec = m.installed[recompId]
        if (!rec) throw new Error(tMain('mainRecomp.notInstalled'))
        const copy = await prepareCopy(recompId, rec, m)
        const saves = await savesOf(recompId, rec, copy.dir)
        const result = await resolveConflict(
          recompId,
          saves.paths,
          rec.cloud,
          keep,
          await copyDeps(saves.templates, copy.dir, rootDir)
        )
        await st.update((mm) => {
          const r = mm.installed[recompId]
          if (r) r.cloud = result
        })
        return result
      })
      changed([recompId])
      return next
    },

    async openRecompFolder(recompId, which) {
      const rec = await requireInstalled(recompId)
      if (which === 'install') {
        // The folder of the program Play starts (the user's choice or PlayOut's pick), so it opens where the game is
        // even when the install folder was renamed or the program lives elsewhere; else the install folder.
        const { program } = programOf(rec, (await profileOf(rec))?.start?.program ?? null)
        const file = program ? exeFullPath(rec, program) : null
        if (file && (await fs.stat(file).catch(() => null))?.isFile())
          return deps.openPath(dirname(file))
        if (!(await fs.stat(rec.dir).catch(() => null))?.isDirectory())
          throw new Error(tMain('mainRecomp.saves.dirGone', { dir: rec.dir }))
        return deps.openPath(rec.dir)
      }
      if (which === 'copies') {
        // Made when the Emulation folder is there (a chosen folder on a disconnected drive is not made).
        if (!(await fs.stat(emulationDir()).catch(() => null))?.isDirectory())
          throw new Error(
            tMain('mainRecomp.saves.emulationUnreachable', { folder: emulationDir() })
          )
        const dir = (await claimCopyDir(recompId, rec)).dir
        await fs.mkdir(dir, { recursive: true })
        return deps.openPath(dir)
      }
      const entry = entryOf(recompId, rec)!
      const ctx = saveCtx(rec)
      const paths = expandSavePaths((await resolveSavePaths(entry, rec, ctx)).paths, ctx)
      for (const p of paths) {
        const st = await fs.stat(p).catch(() => null)
        if (st?.isDirectory()) return deps.openPath(p)
        if (st?.isFile()) return deps.openPath(resolve(p, '..'))
      }
      throw new Error(tMain('mainRecomp.saves.unknownLocation'))
    }
  }

  return {
    ...api,
    installRoot: root,
    async installedDir(id) {
      return (await installedOf(id))?.dir ?? null
    },
    recompForGame(game) {
      if (!catalog || !index || !baseCatalog || baseCatalog.entries.size === 0) return undefined
      const title = matchGameToTitle(matchable(game), catalog, index)
      return title
        ? recompInfo(title, knownInstalled, knownPreferred[title.key] ?? null, now().toISOString())
        : null
    },
    start(): void {
      if (disposed) return
      void root().catch((err) => log.error('recomp: no install folder', err))
      // PlayOut's list of recompilations changed (a download, the owner's publish): shown at once, and the adds it
      // carries now are tidied away.
      const offCloud = deps.cloud?.onCloudRecomps(() => {
        void loadAdded()
          .then(async () => {
            compose()
            await tidyAdded()
            await rekeyInstalls()
            await rematch()
            changed([])
          })
          .catch((err) => log.warn("recomp: could not take PlayOut's list in", err))
      })
      const offDelivered = deps.cloud?.onRecompDelivered((id, st, prUrl, refused) => {
        void noteAddedState(id, st, prUrl, refused).catch((err) =>
          log.warn(`recomp: ${id}: could not note how far it got`, err)
        )
      })
      // Sending turned on: the adds made while it was off go now.
      const offSending = deps.cloud?.onSendingRecomps?.(() => {
        void loadAdded()
          .then(() => sendWaiting())
          .catch((err) => log.warn('recomp: could not send the added recompilations', err))
      })
      unsubscribe.push(...[offCloud, offDelivered, offSending].filter((f): f is () => void => !!f))
      // Adds waiting to be sent that the cloud's queue lost (an older PlayOut saved it meanwhile), and adds made while
      // sending was off: sent now.
      void loadAdded()
        .then(() => sendWaiting())
        .catch((err) => log.warn('recomp: could not read the added recompilations', err))
      const online = (): boolean => deps.isOnline?.() ?? true
      timers.push(
        setTimeout(() => {
          // Online at start: ask the catalogs for new recompilations now (a cheap "not modified" when nothing
          // changed), not just when the cached copy is a day old.
          void cycle(online()).then(() => changed([]))
          const every = setInterval(
            () => void cycle(true).then(() => changed([])),
            deps.refreshEveryMs ?? DAY_MS
          )
          every.unref?.()
          timers.push(every as unknown as ReturnType<typeof setTimeout>)
          // Offline at start, or no catalog could be reached: check again once the PC is online. Waiting for the PC
          // to come online costs nothing; a check that fails while online waits twice as long the next time (up to
          // an hour), and after six of those the daily check takes over.
          let wait = deps.onlineRetryMs ?? 2 * 60_000
          let failures = 0
          const retry = (): void => {
            const t = setTimeout(() => {
              if (disposed || checkedOnline) return
              if (!online() || catalogJob) return retry()
              void loadNow(true)
                .then(() => changed([]))
                .catch((err) => log.warn('recomp: catalog check failed', err))
                .finally(() => {
                  if (disposed || checkedOnline || ++failures >= 6) return
                  wait = Math.min(wait * 2, 60 * 60_000)
                  retry()
                })
            }, wait)
            t.unref?.()
            retryTimer = t
          }
          retry()
        }, deps.startDelayMs ?? 10_000)
      )
      timers[timers.length - 1]?.unref?.()
    },
    async noteEmulationFolderMoved(from: string, to: string): Promise<void> {
      const st = await state()
      await st.update((mm) => {
        if (mm.savesRoot && normalizePath(mm.savesRoot) === normalizePath(from)) mm.savesRoot = to
      })
    },
    noteLibraryFavorite(gameId: string): void {
      const game = library.getGame(gameId)
      const id = game ? recompAddedId(game) : null
      if (!game || !id) return
      void (async () => {
        const st = await state()
        const m = await st.read()
        if (m.favorites.includes(id) === game.favorite) return
        await st.update((mm) => {
          const rest = mm.favorites.filter((x) => x !== id)
          mm.favorites = game.favorite ? [...rest, id] : rest
        })
        changed([id])
      })().catch((err) => log.warn(`recomp: ${id}: could not keep its favourite (${message(err)})`))
    },

    kick(): void {
      if (disposed || !catalog) return
      if (matchTimer) clearTimeout(matchTimer)
      matchTimer = setTimeout(() => {
        matchTimer = null
        void rematch()
      }, deps.matchDebounceMs ?? 1500)
      matchTimer.unref?.()
    },
    dispose(): void {
      disposed = true
      controller.abort()
      for (const t of timers) {
        clearTimeout(t)
        clearInterval(t as unknown as ReturnType<typeof setInterval>)
      }
      if (matchTimer) clearTimeout(matchTimer)
      if (retryTimer) clearTimeout(retryTimer)
      for (const off of unsubscribe.splice(0)) off()
    }
  }
}
