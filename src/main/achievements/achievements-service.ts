// Achievements for the whole library (ARCHITECTURE.md §4.10): Steam games from the Steam Web API, ROMs from
// RetroAchievements. Steam games are read in the background once when they join the library and again only after
// they were played since their last read (the Steam scan below); a pass after every ROM scan fills the ROMs. The
// counts show on the cards and the game detail screen; a game's full list is fetched when it is opened.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AchievementsInfo, Game, RetroAchievementsStatus } from '../../shared/types'
import type { EventBus } from '../events'
import type { RemoteRetroAnswer } from '../streaming/remote-library'
import type { Logger } from '../logger'
import { HttpError } from '../scrapers/http'
import { describeError, steamAppIdOf } from '../scrapers/steam-store'
import type { LibraryService } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import { RA_NONE, raHashTrusted } from '../../shared/ra-consoles'
import { canHash, matchTitle, RA_CONSOLE, raConsoleFor, raHashRom } from './ra-hash'
import {
  raCompletionProgress,
  raGameList,
  raGameProgress,
  raProfile,
  raReady,
  raRecentlyPlayed,
  RaAuthError,
  type RaCredentials,
  type RaGame,
  type RaProfile,
  type RaRecentGame
} from './retroachievements'
import {
  PROGRESS_BATCH,
  steamAchievementCount,
  steamAchievementsProgress,
  steamGameAchievements,
  SteamAuthError,
  type SteamCredential,
  type SteamProgress
} from './steam'
import { mainLanguage, tMain } from '../i18n'
import {
  forgetGogTokens,
  GogAuthError,
  readGogAchievements,
  type GogAccountCredential
} from './gog'
import { createStoreScan, type StoreRead } from './store-scan'
import { GOG_ACHIEVEMENTS_SOURCE, storeAchievementsSource } from '../../shared/store-achievements'
import {
  askedWait,
  createScanRecord,
  createScanRunner,
  failEntries,
  lastSessionTimes,
  playedAfter,
  readEntry,
  scanDue,
  unpark,
  sharedFailure,
  type ScanEntry
} from './scan-scheduler'
import { RECOMP_ACHIEVEMENTS_SOURCE, recompAchievementsFor } from '../../shared/recomp-play'
import type { RecompAchievementsReader } from '../recomp/achievements'
import {
  knownWithoutSteamAchievements,
  STEAM_ACHIEVEMENTS_NONE,
  STEAM_ACHIEVEMENTS_SOURCE
} from '../../shared/steam-achievements'

/** A game's list is fetched again after this long. */
const LIVE_TTL_MS = 10 * 60 * 1000
/** RetroAchievements game lists (with hashes) are refreshed weekly; new sets appear slowly. */
const RA_LIST_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * A cached list counts as whole (a ROM missing from it has no achievements) only this fresh: a set published since may
 * have the ROM's hash.
 */
const RA_LIST_WHOLE_MS = 24 * 60 * 60 * 1000
/** The Steam scan waits this long after the app starts before its first pass (the start-up work goes first). */
const STEAM_START_DELAY_MS = 60 * 1000
/** Library changes and play sessions settle this long before the Steam scan looks at them. */
const STEAM_KICK_DELAY_MS = 5 * 1000
/** Between two one-game Steam requests of the scan: a few a second at most. */
const STEAM_SCAN_GAP_MS = 400
/**
 * The store scans (GOG) start after the Steam scan's start-up wait. No extra wait between two games: gog.ts already
 * paces every GOG request (about one a second, a page open's first).
 */
const STORE_START_DELAY_MS = 90 * 1000
const STORE_SCAN_GAP_MS = 0
/** A failed Steam scan step waits this long, doubled each failure in a row (scan-scheduler.ts). */
const STEAM_BACKOFF_MS = 2 * 60 * 1000
/** The one-game reads of a pass write their marks and the record this often (games, or ms), not after every game. */
const STEAM_FLUSH_EVERY = 25
const STEAM_FLUSH_MS = 5 * 1000
/** A page open's keyless check that found achievements is not repeated for this long (unless the game is played). */
const KEYLESS_CHECK_TTL_MS = 6 * 60 * 60 * 1000
/** A Settings edit settles before the account is checked again. */
const RA_SETTINGS_DELAY_MS = 800
/** RetroAchievements: a ROM scan or a play session settles this long before the scan looks at it. */
const RA_KICK_DELAY_MS = 5 * 1000
/** A failed RetroAchievements step waits this long, doubled each failure in a row (scan-scheduler.ts). */
const RA_BACKOFF_MS = 2 * 60 * 1000
/** The start-up read of the installed recompilations' achievements waits this long (the start-up work goes first). */
const RECOMP_START_DELAY_MS = 30 * 1000
/** This PC's ROMs are hashed for its paired clients this long after the app starts (the start-up work goes first). */
const RA_HASH_START_DELAY_MS = 60 * 1000
/** A ROM file that could not be read for its hash is tried again after this long. */
const HASH_RETRY_MS = 6 * 60 * 60 * 1000
/** Hashed ROMs are checked for a changed file (size, date) at most this often; new ROMs are hashed on every pass. */
const HASH_RECHECK_MS = 60 * 60 * 1000
/** Up to this many games are read one request each; more take the one completion-progress request instead. */
const RA_PER_GAME_MAX = 5
/** The `metadata.sources` key of a ROM's RetroAchievements game id. */
export const RA_SOURCE = 'retroachievements'

export interface AchievementsDeps {
  settings: Pick<SettingsStore, 'get' | 'onChange'>
  library: Pick<
    LibraryService,
    'games' | 'getGame' | 'applyMetadata' | 'clearAchievements' | 'getSessions' | 'allSessions'
  >
  events: Pick<EventBus, 'emit'>
  log: Logger
  /**
   * RetroAchievements' game lists and the ROM hash cache live in `<cacheDir>`, and so does the Steam scan's record
   * (steam-scans.json: when each Steam game was last read).
   */
  cacheDir: string
  /** A game is running: the Steam scan holds its requests until it ends. */
  gameRunning?: () => boolean
  /**
   * Whether this PC's ROMs are hashed for paired clients (it hosts: Settings > Streaming). Default: yes. A ROM is still
   * hashed when this PC's own RetroAchievements account matches it.
   */
  hashForClients?: () => boolean
}

/** Network calls, injectable for tests. */
export interface AchievementsOptions {
  steamProgress?: typeof steamAchievementsProgress
  steamGame?: typeof steamGameAchievements
  steamCount?: typeof steamAchievementCount
  raProfile?: typeof raProfile
  raGameList?: typeof raGameList
  raCompletion?: typeof raCompletionProgress
  raGame?: typeof raGameProgress
  raRecent?: typeof raRecentlyPlayed
  /** How long kickRetro waits for more changes. */
  raKickDelayMs?: number
  /** The first wait after a failed RetroAchievements step. */
  raBackoffMs?: number
  /** The first hashing of this PC's ROMs for its clients after start (0: at the first RetroAchievements pass). */
  raHashStartDelayMs?: number
  /** The start-up read of installed recompilations without counts yet waits this long (0: none). */
  recompStartDelayMs?: number
  hashRom?: typeof raHashRom
  settingsDelayMs?: number
  /** The Steam scan's first pass after start (0: none until syncSteam or kickSteam). */
  steamStartDelayMs?: number
  /** How long kickSteam waits for more changes. */
  steamKickDelayMs?: number
  /** Between two one-game Steam requests of the scan. */
  steamScanGapMs?: number
  /** The first wait after a failed Steam scan step. */
  steamBackoffMs?: number
  /** One GOG game's achievements (tests; default: gog.ts with the GOG account). */
  gogRead?: (productId: string, priority: 'page' | 'scan') => Promise<StoreRead>
  /** The store scans' first pass after start (0: none until syncStore or kick). */
  storeStartDelayMs?: number
  /** Between two one-game store requests. */
  storeScanGapMs?: number
}

/** The signed-in Steam account's credential; `refresh` mints a new access token first. */
export type SteamAccountCredential = (refresh: boolean) => Promise<SteamCredential | null>

export interface AchievementsService {
  /** The accounts service is created after this one; it hands over the Steam account here. */
  useSteamAccount(credential: SteamAccountCredential): void
  /** The recompilation service is created after this one; it hands over its achievements reader here. */
  useRecomp(reader: RecompAchievementsReader): void
  /**
   * A recompilation's play session ended: the games it plays for read its achievements again (their counts on the
   * cards follow). Nothing else reads them in the background.
   */
  recompPlayed(recompId: string): Promise<void>
  /**
   * Take recompilation counts off the cards whose recompilation no longer gives them (uninstalled, or Play now starts
   * another recompilation or the emulator). Cheap; run after the library's metadata changes.
   */
  forgetStaleRecomp(): void
  /** A game's achievements with the user's unlocks; null when there are none or no account to read them with. */
  get(gameId: string): Promise<AchievementsInfo | null>
  /**
   * The Steam scan: read unlocked / total (or Steam's "no achievements") for the Steam games that are due, a few
   * requests a second: games never read (new to the library), and games played since they were last read (a PlayOut
   * session ended after it, or Steam's last played / playtime moved past it). Nothing else is read again. Without a
   * Settings key or a signed-in account the due games wait for one. Resolves when the pass is over.
   */
  syncSteam(): Promise<void>
  /** The library changed (games added, Steam's playtime imported): run the Steam scan once things settle. */
  kickSteam(): void
  /** A PlayOut play session of the game ended: it is read again by the Steam scan. */
  steamPlayed(gameId: string, endedAt: string): void
  /**
   * The Steam account was signed out (or replaced): its counts leave the cards unless the Settings key still
   * covers them, and a sync still running for it writes nothing.
   */
  steamSignedOut(): void
  /** Check the RetroAchievements account and fill unlocked / total for every ROM it recognises. */
  syncRetro(): Promise<RetroAchievementsStatus>
  retroStatus(): RetroAchievementsStatus
  /**
   * The RetroAchievements scan (like the Steam scan): the ROMs not read with this account yet (new ROMs, a paired host's
   * ROMs) and the ROMs played since their last read; the first pass of a run also checks the account and reads
   * RetroAchievements' recently played list. Then (a minute after start at the earliest, only while this PC hosts, and
   * never while a game runs) hashes this PC's new ROMs for its paired clients, signed in or not.
   */
  kickRetro(delayMs?: number): void
  /** A play session ended: whichever scan reads the game (Steam, RetroAchievements, GOG) reads it again. */
  played(gameId: string, endedAt: string): void
  /** The library changed: the Steam and store scans run once things settle. */
  kick(): void
  /** The streaming service is created after this one; it hands over the paired hosts' games here. */
  useRemote(source: RemoteGamesSource): void
  /**
   * A paired host's ROM (`remote:` id): its list with this PC's RetroAchievements account ('list'); 'host' when this PC
   * cannot read it (not signed in, not a ROM it matches, no RetroAchievements game found: the host's own list is asked
   * then); 'none' when this account found it has none. Throws when the read failed while this PC's counts of the ROM
   * are on its card.
   */
  getRemote(gameId: string): Promise<RemoteRomRead>
  /** A paired host's ROM: this PC's RetroAchievements counts of it, or its "none"; undefined when not read. */
  remoteRetro(gameId: string): RemoteRetroCounts | undefined
  /** A ROM's RetroAchievements hash when this PC worked it out already (what the host offers its clients). */
  raHashOf(game: Game): string | undefined
  /** The accounts service is created after this one; it hands over the GOG account here. */
  useGogAccount(credential: () => Promise<GogAccountCredential | null>): void
  /** A sign-in to the store or an owned import: its achievements scan runs (waiting games included). */
  syncStore(source: 'gog'): Promise<void>
  /** Signed out of the store: its counts leave the cards. */
  storeSignedOut(source: 'gog'): void
  /**
   * Recompilations were installed or changed (`recomp:changed` ids): the games Play starts them for read their
   * achievements now when their cards have none of theirs yet. No ids: the start-up read, after a short wait and never
   * while a game runs, which skips recompilations already read without counts (until they change or are played).
   */
  recompChanged(ids?: string[]): Promise<void>
  dispose(): void
}

interface HashCacheEntry {
  size: number
  mtimeMs: number
  consoleId: number
  hash: string | null
  /** Reading the file failed then (locked, a sleeping drive): not tried again for HASH_RETRY_MS. */
  failedAt?: number
}

/**
 * A console's games with achievements; `whole` while the list is fresh enough that a ROM missing from it has none.
 * `failed`: its download failed (the games are an older list's, or none); `fetchedAt`: when the list was downloaded
 * (0: none).
 */
interface ConsoleList {
  games: RaGame[]
  whole: boolean
  failed: boolean
  fetchedAt: number
}

/** What matching found: the ROMs' games, and the ROMs that could not be told (their console's list failed). */
interface MatchResult {
  matches: Map<string, RaGame>
  /** Not matched because the console's list could not be downloaded: matched again later, not recorded as read. */
  unsure: Set<string>
  /** When the list each ROM was matched against was downloaded. */
  listAt: Map<string, number>
  /** A game started meanwhile (`stopIf`): the rest is matched once it ends. */
  stopped: boolean
}

interface ListCacheFile {
  fetchedAt: number
  games: RaGame[]
}

const isRom = (g: Game): boolean => g.source === 'rom' && !!g.romPath

/** A paired host's game (streaming remote-library.ts remoteGameId). */
const isRemoteId = (id: string): boolean => id.startsWith('remote:')

/**
 * A paired host's ROM this PC matches with its own RetroAchievements account: a ROM of a system RetroAchievements
 * covers whose counts are not the host's recompilation's. A host ROM card without a file (`downloadable` false: the
 * host's recompilation-only card, or a disc image the host deleted once its recompilation played, remote-library.ts
 * noRomFile) plays a recompilation, not the ROM, so RetroAchievements' sets do not apply to it: the host's counts stay.
 */
export function isRemoteRom(g: Game): boolean {
  return (
    !!g.remote &&
    g.source === 'rom' &&
    g.remote.downloadable &&
    !g.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE] &&
    raConsoleFor(g.platformId) !== null
  )
}

/** A ROM to match: one of this PC's (hashed from its file) or a paired host's (its hash from the host's offer). */
interface RomCandidate {
  id: string
  platformId: string
  title: string
  /** This PC's file, hashed when matched. */
  path?: string
  /** The hash known already (a host's ROM: null when the host sent none, so only titles match). */
  hash?: string | null
  /** The file's name without its extension, and the extension (lower case, with the dot). */
  file: string
  ext: string
}

function splitName(name: string): { file: string; ext: string } {
  const ext = extname(name)
  return { file: ext ? name.slice(0, -ext.length) : name, ext: ext.toLowerCase() }
}

function localCandidate(game: Game): RomCandidate {
  const path = game.romPath
  const name = path ? basename(path) : (game.externalId.split(/[\\/]/).pop() ?? '')
  return { id: game.id, platformId: game.platformId, title: game.title, path, ...splitName(name) }
}

function remoteCandidate(game: Game): RomCandidate {
  return {
    id: game.id,
    platformId: game.platformId,
    title: game.title,
    hash: game.remote?.raHash ?? null,
    ...splitName(game.externalId.split(/[\\/]/).pop() ?? '')
  }
}

/** What a ROM was matched from: another file (or host hash) since = matched again. */
const fromOf = (c: RomCandidate): string =>
  c.path ?? `${c.platformId}|${c.hash ?? ''}|${c.file}${c.ext}`

const clampCounts = (p: {
  unlocked: number
  total: number
}): { unlocked: number; total: number } => ({
  unlocked: Math.min(Math.max(0, p.unlocked), p.total),
  total: p.total
})

/** A ROM's line in ra-scans.json (scan-scheduler.ts ScanEntry). */
interface RaScanEntry extends ScanEntry {
  /** The RetroAchievements user (lower case) it was read with; another one = never read. */
  account?: string
  /** What it was matched from (fromOf). */
  from?: string
  /** The RetroAchievements game it matched. */
  raId?: number
  /** RetroAchievements has no achievements for it. */
  none?: boolean
  /**
   * Matched with no game and no "none": when the console's list it was matched against was downloaded. A newer list
   * in hand since (downloaded for another ROM, or a page open) makes it due again (a set may have been added).
   */
  listAt?: number
  /** A paired host's ROM: this account's counts (this PC's own ROMs keep theirs on the card). */
  unlocked?: number
  total?: number
}

interface RomFound {
  raId: number
  counts?: { unlocked: number; total: number }
}

type RetroMode = 'full' | 'due'

/** A paired host's ROM as this PC's RetroAchievements account sees it (streaming-service rebuild). */
export type RemoteRetroCounts = RemoteRetroAnswer

/** A paired host's ROM's list as this PC's RetroAchievements account reads it (getRemote). */
export type RemoteRomRead =
  | { kind: 'list'; info: AchievementsInfo }
  /** This PC cannot read it (not signed in, not a ROM it matches, unknown to RetroAchievements): the host's list. */
  | { kind: 'host' }
  /** This PC's account found it has no achievements (its card shows none either). */
  | { kind: 'none' }

/** The paired hosts' games (the streaming service is created after this one). */
export interface RemoteGamesSource {
  games(): Promise<Game[]>
  /** How many hosts are paired (0: none, so an empty games list is final). */
  pairedHosts?(): Promise<number>
  /** This PC's counts of the hosts' ROMs changed: the remote library is shown again. */
  changed(): void
}

/** A Steam game's line in steam-scans.json: when the Steam scan last read it (scan-scheduler.ts ScanEntry). */
interface SteamScanEntry extends ScanEntry {
  /** Steam's playtime (minutes) then: more since = played through Steam since. */
  storeMinutes?: number
  /** That read followed a PlayOut session: Steam's playtime growing next only catches up with that session. */
  afterSession?: boolean
  /** The app id it was read by (another one since = a new match, read again). */
  appId?: number
  /** Steam said then that the game has no achievements (the mark is put back if a new match dropped it). */
  none?: boolean
  /** When a pass asked for its counts and got none; Steam's own list is still to be asked. */
  countOnlyAt?: number
}

export function createAchievementsService(
  deps: AchievementsDeps,
  options: AchievementsOptions = {}
): AchievementsService {
  const { library, settings, events, log } = deps
  const fetchSteamProgress = options.steamProgress ?? steamAchievementsProgress
  const fetchSteamGame = options.steamGame ?? steamGameAchievements
  const fetchSteamCount = options.steamCount ?? steamAchievementCount
  const fetchRaProfile = options.raProfile ?? raProfile
  const fetchRaGameList = options.raGameList ?? raGameList
  const fetchRaCompletion = options.raCompletion ?? raCompletionProgress
  const fetchRaGame = options.raGame ?? raGameProgress
  const fetchRaRecent = options.raRecent ?? raRecentlyPlayed
  const hashRom = options.hashRom ?? raHashRom

  let steamAccount: SteamAccountCredential | null = null
  let recompReader: RecompAchievementsReader | null = null
  /** Bumped by steamSignedOut: Steam work that started before it writes nothing. */
  let steamGeneration = 0
  let disposed = false
  const cache = new Map<string, { at: number; key: string; info: AchievementsInfo }>()
  const inflight = new Map<string, Promise<AchievementsInfo | null>>()

  // --- Steam ------------------------------------------------------------------

  /** The Web API key from Settings > Metadata: the full achievement list with unlock times. */
  function keyCredential(): SteamCredential | null {
    const { apiKey, steamId64 } = settings.get().scrapers.steam
    return apiKey.trim() && steamId64.trim()
      ? { steamId64: steamId64.trim(), key: apiKey.trim() }
      : null
  }

  /**
   * Run `fn` with the Settings key when there is one (and it belongs to the signed-in account, when there is one),
   * else (or when Steam refuses the key, or `fn` gets nothing with it) with the signed-in account's token, minting
   * a new token once if Steam refuses the stored one. null when there is no credential at all.
   */
  async function withSteam<T>(
    fn: (credential: SteamCredential) => Promise<T | null>
  ): Promise<T | null> {
    const key = keyCredential()
    const account = steamAccount ? await steamAccount(false) : null
    // The account the library was imported with wins over a key for another SteamID64.
    const token = account && 'accessToken' in account ? account : null
    const useKey = key && (!token || token.steamId64 === key.steamId64)
    if (useKey) {
      try {
        const result = await fn(key)
        if (result !== null || !token) return result
      } catch (err) {
        if (!(err instanceof SteamAuthError) || !token) throw err
        log.warn('steam: the Web API key from Settings was refused; trying the signed-in account')
      }
    }
    // Without a stored token, the account is the Settings key itself: nothing else to try.
    if (!token) return useKey || !account ? null : fn(account)
    try {
      return await fn(token)
    } catch (err) {
      if (!(err instanceof SteamAuthError)) throw err
    }
    const fresh = await steamAccount?.(true)
    return fresh && 'accessToken' in fresh ? fn(fresh) : null
  }

  function writeCounts(
    gameId: string,
    counts: { unlocked: number; total: number },
    extra: { sources?: Record<string, string> } = {}
  ): boolean {
    const game = library.getGame(gameId)
    if (!game) return false
    const current = game.metadata.achievements
    const sameSource =
      !extra.sources ||
      Object.entries(extra.sources).every(([k, v]) => game.metadata.sources?.[k] === v)
    if (
      current &&
      current.unlocked === counts.unlocked &&
      current.total === counts.total &&
      sameSource
    )
      return false
    library.applyMetadata(
      gameId,
      {
        metadata: {
          achievements: { ...counts, updatedAt: new Date().toISOString() },
          ...(extra.sources ? { sources: extra.sources } : {})
        }
      },
      { overwrite: true, quiet: true }
    )
    return true
  }

  function announce(gameIds: string[]): void {
    if (gameIds.length && !disposed) events.emit('library:changed', { reason: 'metadata', gameIds })
  }

  // --- the Steam scan ---------------------------------------------------------------
  // Each Steam game (a store game with a Steam app id) is read once when it joins the library, then again only once it
  // was played after its last read (scan-scheduler.ts). Never on a timer otherwise: a failed read waits out a growing
  // pause and, after SCAN_PARK_AFTER failures in a row, waits for a play, an owned import or sign-in, or the next start;
  // games waiting for a Steam account (or for one Steam accepts) wait for the next sign-in, owned import or Settings
  // key. Nothing is read while a game runs.

  const steamScanGapMs = options.steamScanGapMs ?? STEAM_SCAN_GAP_MS
  const steamBackoffMs = options.steamBackoffMs ?? STEAM_BACKOFF_MS
  const gameRunning = (): boolean => deps.gameRunning?.() ?? false
  /** Steam refused every credential: nothing is read until the credential changes (or an import / sign-in). */
  let steamAuthBlocked = false
  /** A pass stopped for a running game: the next session change (or play) picks it up. */
  let steamDeferred = false
  /** An owned import or sign-in asked: parked games get one more try. */
  let steamUnparkPending = false
  /** Page opens whose keyless check found achievements this account has no progress in: app id -> when. */
  const keylessChecked = new Map<number, number>()

  const steamRecord = createScanRecord<SteamScanEntry>({
    file: join(deps.cacheDir, 'steam-scans.json'),
    keep: (id) => !!library.getGame(id),
    write: (file, value) => writeJson(file, value),
    onSaveError: (err) =>
      log.warn(`steam: could not save the achievements scan record: ${describeError(err)}`)
  })
  const loadScans = (): Promise<Record<string, SteamScanEntry>> => steamRecord.load()
  const saveScans = (): Promise<void> => steamRecord.save()

  const steamRunner = createScanRunner({
    startDelayMs: options.steamStartDelayMs ?? STEAM_START_DELAY_MS,
    kickDelayMs: options.steamKickDelayMs ?? STEAM_KICK_DELAY_MS,
    backoffMs: steamBackoffMs,
    pass: () => runSteamScan(),
    onError: (err) => log.warn(`steam: achievements scan failed: ${describeError(err)}`)
  })

  /** The counts went with the account: every game is read again, except those Steam said have none. */
  function forgetSteamScans(table: Record<string, SteamScanEntry>): void {
    for (const id of Object.keys(table)) {
      const game = library.getGame(id)
      if (!game || !(table[id].none || knownWithoutSteamAchievements(game))) delete table[id]
    }
  }

  /** The Steam app id the scan reads a game by; null for ROMs, a paired host's games and games without one. */
  function scanAppId(game: Game): number | null {
    if (game.source === 'rom' || game.remote) return null
    return steamAppIdOf(game)
  }

  /** When each game's newest play session reached this PC (epoch ms, this PC's clock). */
  function lastSessions(gameId?: string): Map<string, number> {
    return lastSessionTimes(gameId ? library.getSessions(gameId) : library.allSessions())
  }

  /**
   * Played after `since` (scan-scheduler.ts playedAfter), or Steam's playtime grew (not when that only caught up with
   * the PlayOut session the last read already followed).
   */
  function playedSince(
    game: Game,
    entry: SteamScanEntry,
    since: number,
    lastSession: number | undefined
  ): boolean {
    if (playedAfter(game, entry, since, lastSession)) return true
    return !entry.afterSession && (game.storePlaytimeMinutes ?? 0) > (entry.storeMinutes ?? 0)
  }

  /**
   * Never read, read for another app id (a new match), a failed read whose wait is over, or played after its last
   * read (here, on a paired PC or through Steam). A parked game waits for a play.
   */
  function steamDue(
    game: Game,
    entry: SteamScanEntry | undefined,
    now: number,
    lastSession: number | undefined
  ): boolean {
    if (entry?.appId !== undefined && entry.appId !== scanAppId(game)) return true
    return scanDue(entry, now, (since) => playedSince(game, entry!, since, lastSession))
  }

  /** Steam answered for these games at `at` (a session that ended after it still makes them due). */
  function recordScan(
    table: Record<string, SteamScanEntry>,
    ids: string[],
    at: number,
    none = false
  ): void {
    for (const id of ids) {
      const game = library.getGame(id)
      if (!game) continue
      const playedAt = table[id]?.playedAt
      const appId = scanAppId(game)
      table[id] = {
        ...readEntry(game, table[id], at),
        storeMinutes: game.storePlaytimeMinutes ?? 0,
        ...(appId ? { appId } : {}),
        ...(none ? { none: true } : {}),
        // This read followed a PlayOut session: Steam's playtime catching up with it later is no new play.
        ...(playedAt && playedAt <= at ? { afterSession: true } : {})
      }
    }
  }

  /**
   * A scan step failed. Steam refusing the credential stops the scan until the credential changes (no game is held
   * back for it). Otherwise its games wait, longer after each failure in a row, and after SCAN_PARK_AFTER failures
   * wait for a play (or an import, a sign-in, the next start); with `everyone` (a batch request, a rate limit, no
   * network) the whole scan pauses too, as long as Steam asked when it said.
   */
  function scanFailed(
    table: Record<string, SteamScanEntry>,
    ids: string[],
    err: unknown,
    everyone: boolean
  ): void {
    if (err instanceof SteamAuthError) {
      steamAuthBlocked = true
      log.warn(
        `steam: achievements scan stopped (${describeError(err)}); it goes on once the Steam account or key changes`
      )
      return
    }
    const now = Date.now()
    const retry = failEntries(table, ids, steamBackoffMs, err, now)
    const limited = err instanceof HttpError && err.status === 429
    if (!everyone && !sharedFailure(err)) {
      log.warn(`steam: achievements of ${ids.join(', ')} could not be read: ${describeError(err)}`)
      // Only these games wait; the scan reads them once their wait is over.
      if (Number.isFinite(retry)) steamRunner.schedule(retry - now)
      return
    }
    const wait = steamRunner.pause(askedWait(err))
    log.warn(
      `steam: achievements scan ${limited ? 'rate limited' : 'failed'} (${describeError(err)}); next try in ${Math.round(wait / 1000)} s`
    )
  }

  /** Steam said the game has no achievements: the mark goes on, Steam counts read before go (a recompilation's stay). */
  function markSteamNone(gameId: string, changed: string[]): void {
    const game = library.getGame(gameId)
    if (!game || game.remote) return
    if (game.metadata.sources?.[STEAM_ACHIEVEMENTS_SOURCE] === STEAM_ACHIEVEMENTS_NONE) return
    if (!game.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE]) library.clearAchievements([gameId])
    library.applyMetadata(
      gameId,
      { metadata: { sources: { [STEAM_ACHIEVEMENTS_SOURCE]: STEAM_ACHIEVEMENTS_NONE } } },
      { overwrite: true, quiet: true }
    )
    changed.push(gameId)
  }

  /**
   * The record says Steam answered "none" for the game's app id, but the mark is gone (a new metadata match replaced
   * the game's sources): put it back without asking Steam again.
   */
  function restoreNone(game: Game, entry: SteamScanEntry | undefined, changed: string[]): boolean {
    if (!entry?.none || game.metadata.achievements || knownWithoutSteamAchievements(game))
      return false
    if (entry.appId !== undefined && entry.appId !== scanAppId(game)) return false
    markSteamNone(game.id, changed)
    return true
  }

  /** Counts from Steam, replacing a "no achievements" mark (the game got achievements since). */
  function writeSteamCounts(gameId: string, counts: SteamProgress, changed: string[]): void {
    const marked = !!library.getGame(gameId)?.metadata.sources?.[STEAM_ACHIEVEMENTS_SOURCE]
    if (marked) library.clearAchievements([gameId], STEAM_ACHIEVEMENTS_SOURCE)
    if (writeCounts(gameId, counts) || marked) changed.push(gameId)
  }

  /** A page open read the game: the scan counts it as read then. */
  async function noteSteamRead(gameId: string, at: number, none = false): Promise<void> {
    const table = await loadScans()
    recordScan(table, [gameId], at, none)
    await saveScans()
  }

  const pause = (ms: number): Promise<void> =>
    ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

  async function runSteamScan(): Promise<void> {
    const table = await loadScans()
    if (disposed) return
    if (steamUnparkPending) {
      steamUnparkPending = false
      for (const entry of Object.values(table)) unpark(entry)
    }
    if (steamAuthBlocked) {
      log.debug('steam: achievements scan waits for a Steam account or key Steam accepts')
      return
    }
    if (gameRunning()) {
      steamDeferred = true
      return
    }
    steamDeferred = false
    const now = Date.now()
    const paused = steamRunner.pausedFor()
    if (paused > 0) {
      steamRunner.schedule(paused)
      return
    }
    const sessions = lastSessions()
    const byApp = new Map<number, string[]>()
    /** Apps whose counts the last pass already asked for (none came): only Steam's own list is left to ask. */
    const countOnly = new Set<number>()
    const restored: string[] = []
    let recordChanged = false
    let nextRetry = Number.POSITIVE_INFINITY
    for (const game of library.games()) {
      const appId = scanAppId(game)
      if (!appId) continue
      const entry = table[game.id]
      if (!steamDue(game, entry, now, sessions.get(game.id))) {
        if (entry?.retryAt && entry.retryAt > now) nextRetry = Math.min(nextRetry, entry.retryAt)
        restoreNone(game, entry, restored)
        // Steam's playtime caught up with the PlayOut session the last read followed: that is the new baseline.
        if (entry?.afterSession && (game.storePlaytimeMinutes ?? 0) > (entry.storeMinutes ?? 0)) {
          entry.storeMinutes = game.storePlaytimeMinutes ?? 0
          delete entry.afterSession
          recordChanged = true
        }
        continue
      }
      const ids = byApp.get(appId) ?? []
      ids.push(game.id)
      byApp.set(appId, ids)
      if (entry?.countOnlyAt !== undefined && entry.at === undefined) countOnly.add(appId)
    }
    announce(restored)
    if (recordChanged) await saveScans()
    if (byApp.size && !(await scanSteamApps(table, byApp, countOnly))) return
    // A failed game's wait ends: it is read then (nothing else is on a timer).
    if (Number.isFinite(nextRetry)) steamRunner.schedule(nextRetry - Date.now())
  }

  /**
   * Read the due games: their counts a hundred apps per request, then, one at a time, Steam's own list for the apps
   * that got no counts (`countOnly`: those a stopped pass already asked counts for). false when the pass stopped
   * (a failure, no account, a sign-out or a game started meanwhile).
   */
  async function scanSteamApps(
    table: Record<string, SteamScanEntry>,
    byApp: Map<number, string[]>,
    countOnly: Set<number>
  ): Promise<boolean> {
    const generation = steamGeneration
    const current = (): boolean => !disposed && generation === steamGeneration
    const stopForGame = (): boolean => {
      if (!gameRunning()) return false
      steamDeferred = true
      return true
    }
    const apps = [...byApp.keys()].filter((a) => !countOnly.has(a))
    const unanswered: number[] = [...countOnly]
    let counted = 0
    let none = 0
    for (let i = 0; i < apps.length; i += PROGRESS_BATCH) {
      if (!current() || stopForGame()) return false
      const batch = apps.slice(i, i + PROGRESS_BATCH)
      const at = Date.now()
      let progress: Map<number, SteamProgress> | null
      try {
        progress = await withSteam((credential) => fetchSteamProgress(batch, credential))
      } catch (err) {
        if (current()) {
          scanFailed(
            table,
            batch.flatMap((a) => byApp.get(a) ?? []),
            err,
            true
          )
          await saveScans()
        }
        return false
      }
      if (!current()) return false
      if (!progress) {
        // No Settings key and no signed-in account: the games wait for one (a sign-in imports the library and asks).
        log.debug(`steam: ${byApp.size} game(s) wait for a Steam account to read achievements`)
        return false
      }
      const changed: string[] = []
      for (const appId of batch) {
        const p = progress.get(appId)
        const ids = byApp.get(appId) ?? []
        if (!p || p.total <= 0) {
          unanswered.push(appId)
          // Asked: a pass stopped before Steam's own list was read asks only that next time.
          for (const id of ids) table[id] = { ...table[id], countOnlyAt: at }
          continue
        }
        counted++
        for (const id of ids) {
          writeSteamCounts(id, p, changed)
          cache.delete(id)
        }
        recordScan(table, ids, at)
      }
      announce(changed)
      await saveScans()
    }
    // No counts: Steam's own list (no credential needed) tells a game without achievements from one this account
    // has no progress in (another account owns it, a private profile), which is read again only once played. The
    // marks and the record are written in batches, not after every game.
    let marked: string[] = []
    let dirty = false
    let flushedAt = Date.now()
    const flush = async (): Promise<void> => {
      announce(marked)
      marked = []
      if (dirty) await saveScans()
      dirty = false
      flushedAt = Date.now()
    }
    for (let i = 0; i < unanswered.length; i++) {
      const appId = unanswered[i]
      if (i > 0) await pause(steamScanGapMs)
      if (!current() || stopForGame()) {
        if (current()) await flush()
        return false
      }
      const ids = byApp.get(appId) ?? []
      const asked = Date.now()
      let total: number | null
      try {
        total = await fetchSteamCount(appId)
      } catch (err) {
        if (!current()) return false
        const everyone = sharedFailure(err)
        scanFailed(table, ids, err, false)
        dirty = true
        if (everyone) {
          await flush()
          return false
        }
        continue
      }
      if (!current()) return false
      if (total === 0) {
        none++
        for (const id of ids) markSteamNone(id, marked)
      }
      recordScan(table, ids, asked, total === 0)
      dirty = true
      if (marked.length >= STEAM_FLUSH_EVERY || Date.now() - flushedAt >= STEAM_FLUSH_MS)
        await flush()
    }
    await flush()
    // The whole pass went through: the next failure starts the pause over.
    steamRunner.passed()
    log.info(
      `steam: achievements scan read ${byApp.size} game(s): ${counted} with counts, ${none} without achievements`
    )
    return true
  }

  const runSteam = (): Promise<void> => steamRunner.run()

  /** An owned import or a sign-in: a refused credential and parked games get another try. */
  function syncSteam(): Promise<void> {
    steamAuthBlocked = false
    steamUnparkPending = true
    return runSteam()
  }

  function kickSteam(): void {
    // A pause after a failure is not cut short.
    steamRunner.kick()
  }

  function steamPlayed(gameId: string, endedAt: string): void {
    if (disposed) return
    const game = library.getGame(gameId)
    const appId = game ? scanAppId(game) : null
    if (!appId) {
      // Another game ended: a pass held back while it ran goes on.
      if (steamDeferred) kickSteam()
      return
    }
    keylessChecked.delete(appId)
    const ended = Date.parse(endedAt)
    void loadScans()
      .then(async (table) => {
        table[gameId] = { ...table[gameId], playedAt: Number.isFinite(ended) ? ended : Date.now() }
        await saveScans()
        kickSteam()
      })
      .catch((err) => log.warn(`steam: could not note a play session: ${describeError(err)}`))
  }

  /**
   * The credential the Steam counts were read with went away or changed: fence the work still running for it,
   * take its counts off the cards and read them again with whatever credential is left (none: they stay empty).
   * Steam's "no achievements" marks stay: they are no account's.
   */
  function resetSteam(): void {
    steamGeneration++
    steamAuthBlocked = false
    keylessChecked.clear()
    for (const [id, entry] of cache) if (entry.key === 'steam') cache.delete(id)
    const ids = library
      .games()
      .filter((g) => g.source !== 'rom' && steamAppIdOf(g) && g.metadata.achievements)
      .map((g) => g.id)
    announce(library.clearAchievements(ids))
    steamRunner.clearPause()
    steamRecord.change(forgetSteamScans)
  }

  function steamSignedOut(): void {
    resetSteam()
    // The Settings key may still sign Steam in (for this account or another one): its own counts come back.
    if (keyCredential()) void runSteam()
  }

  // --- RetroAchievements --------------------------------------------------------

  /** Credential changes seen so far; the run in progress reports the one it started with. */
  let revision = 0
  let runRevision = 0
  let status: RetroAchievementsStatus = { state: 'signed-out', revision }
  let profile: RaProfile | null = null

  function setStatus(next: Omit<RetroAchievementsStatus, 'revision'>): RetroAchievementsStatus {
    status = { ...next, revision: runRevision }
    if (!disposed) events.emit('retroachievements:status', status)
    return status
  }

  function raCredentials(): RaCredentials | null {
    const creds = settings.get().scrapers.retroachievements
    return raReady(creds) ? { username: creds.username.trim(), apiKey: creds.apiKey.trim() } : null
  }

  const credentialKey = (creds: RaCredentials | null): string =>
    creds ? `${creds.username.toLowerCase()}\n${creds.apiKey}` : ''

  // ROM hashes, keyed by path and invalidated by size / mtime: hashing a library of ROMs takes a while.
  const hashFile = join(deps.cacheDir, 'rom-hashes.json')
  let hashes: Record<string, HashCacheEntry> | null = null
  let hashesDirty = false

  async function loadHashes(): Promise<Record<string, HashCacheEntry>> {
    if (hashes) return hashes
    try {
      const parsed = JSON.parse(await readFile(hashFile, 'utf8')) as unknown
      hashes =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, HashCacheEntry>)
          : {}
    } catch {
      hashes = {}
    }
    return hashes
  }

  // One write at a time per file: a sync and a game open can both save the same cache.
  const writes = new Map<string, Promise<void>>()
  let tempSeq = 0
  function writeJson(file: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value)
    const previous = writes.get(file) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(deps.cacheDir, { recursive: true })
        const temp = `${file}.${process.pid}.${++tempSeq}.tmp`
        await writeFile(temp, text, 'utf8')
        await rename(temp, file)
      })
    writes.set(file, next)
    // The caller handles the failure; this branch only tidies up and must not raise an unhandled rejection.
    next
      .finally(() => {
        if (writes.get(file) === next) writes.delete(file)
      })
      .catch(() => undefined)
    return next
  }

  /** `retryFailed`: a file that could not be read lately is tried again now (Sync now, a page open). */
  async function romHash(
    path: string,
    consoleId: number,
    retryFailed = false
  ): Promise<string | null> {
    if (!canHash(consoleId)) return null
    const table = await loadHashes()
    let info
    try {
      info = await stat(path)
    } catch {
      return null
    }
    const known = table[path]
    if (
      known &&
      known.size === info.size &&
      known.mtimeMs === info.mtimeMs &&
      known.consoleId === consoleId &&
      (known.failedAt === undefined ||
        (!retryFailed && Date.now() - known.failedAt < HASH_RETRY_MS))
    )
      return known.hash
    let hash: string | null
    try {
      hash = await hashRom(path, consoleId)
    } catch (err) {
      // A locked file or a sleeping drive: tried again later (not on every pass) instead of remembering "no hash".
      log.debug(`retroachievements: could not hash ${path}: ${describeError(err)}`)
      table[path] = {
        size: info.size,
        mtimeMs: info.mtimeMs,
        consoleId,
        hash: null,
        failedAt: Date.now()
      }
      hashesDirty = true
      return null
    }
    table[path] = { size: info.size, mtimeMs: info.mtimeMs, consoleId, hash }
    hashesDirty = true
    return hash
  }

  /** One download per console at a time: a game open during a sync waits for the sync's list. */
  const listInflight = new Map<number, Promise<ConsoleList>>()
  function consoleGames(consoleId: number, creds: RaCredentials): Promise<ConsoleList> {
    const running = listInflight.get(consoleId)
    if (running) return running
    const task = loadConsoleGames(consoleId, creds).finally(() => listInflight.delete(consoleId))
    listInflight.set(consoleId, task)
    return task
  }

  /**
   * A console's games with their hashes: from the weekly cache, or RetroAchievements (stale cache on failure, then
   * not `whole`: a ROM missing from it may be in the newer list).
   */
  async function loadConsoleGames(consoleId: number, creds: RaCredentials): Promise<ConsoleList> {
    const file = join(deps.cacheDir, `games-${consoleId}.json`)
    let cached: ListCacheFile | null
    try {
      cached = JSON.parse(await readFile(file, 'utf8')) as ListCacheFile
    } catch {
      cached = null
    }
    const cachedAt = cached && Number.isFinite(cached.fetchedAt) ? cached.fetchedAt : 0
    if (cached && Array.isArray(cached.games) && Date.now() - cachedAt < RA_LIST_TTL_MS) {
      listFetchedAt.set(consoleId, cachedAt)
      return {
        games: cached.games,
        whole: Date.now() - cachedAt < RA_LIST_WHOLE_MS,
        failed: false,
        fetchedAt: cachedAt
      }
    }
    try {
      const games = await fetchRaGameList(consoleId, creds)
      const fetchedAt = Date.now()
      await writeJson(file, { fetchedAt, games } satisfies ListCacheFile).catch((err) =>
        log.warn(`retroachievements: could not cache console ${consoleId}: ${describeError(err)}`)
      )
      listFetchedAt.set(consoleId, fetchedAt)
      return { games, whole: true, failed: false, fetchedAt }
    } catch (err) {
      if (err instanceof RaAuthError) throw err
      log.warn(`retroachievements: game list ${consoleId} failed: ${describeError(err)}`)
      return {
        games: Array.isArray(cached?.games) ? cached.games : [],
        whole: false,
        failed: true,
        fetchedAt: cachedAt
      }
    }
  }

  /** When each console's list in hand was downloaded (from this run's reads of it). */
  const listFetchedAt = new Map<number, number>()

  async function saveHashes(): Promise<void> {
    if (!hashesDirty || !hashes) return
    hashesDirty = false
    await writeJson(hashFile, hashes).catch((err) =>
      log.warn(`retroachievements: could not save ROM hashes: ${describeError(err)}`)
    )
  }

  /** When hashRoms last checked every hashed ROM for a changed file. */
  let hashesCheckedAt = 0
  /** A hashing pass stopped for a game: the game's end picks it up. */
  let hashDeferred = false

  /**
   * Hash this PC's ROMs without any account, for its paired clients: they match the ROMs this PC offers with their own
   * RetroAchievements account by these hashes (raHashOf, remote-library.ts hostOffer). Only while this PC hosts; new
   * ROMs on every pass, and at most hourly a check of the hashed ones for a replaced file (one stat each). Stops when a
   * game starts: nothing is read while one runs.
   */
  async function hashRoms(): Promise<void> {
    if (!(deps.hashForClients?.() ?? true)) return
    const table = await loadHashes()
    const recheck = Date.now() - hashesCheckedAt >= HASH_RECHECK_MS
    let hashed = 0
    let stopped = false
    for (const game of library.games()) {
      if (disposed) break
      if (!isRom(game)) continue
      const consoleId = raConsoleFor(game.platformId)
      if (consoleId === null || !canHash(consoleId)) continue
      const known = table[game.romPath!]
      if (!recheck && known?.consoleId === consoleId && known.failedAt === undefined) continue
      if (gameRunning()) {
        stopped = true
        break
      }
      const before = table[game.romPath!]
      await romHash(game.romPath!, consoleId)
      if (table[game.romPath!] !== before && table[game.romPath!]?.hash) hashed++
    }
    hashDeferred = stopped
    if (recheck && !stopped && !disposed) hashesCheckedAt = Date.now()
    if (hashed) log.info(`retroachievements: hashed ${hashed} ROM(s) for the paired clients`)
    await saveHashes()
  }

  /** A ROM's RetroAchievements hash when this PC worked it out already (no file is read here). */
  function raHashOf(game: Game): string | undefined {
    if (!hashes || !isRom(game)) return undefined
    const consoleId = raConsoleFor(game.platformId)
    const known = hashes[game.romPath!]
    return consoleId !== null && known?.consoleId === consoleId && known.hash
      ? known.hash
      : undefined
  }

  /**
   * Find each ROM's RetroAchievements game: by hash, else by a title that only one game of the console has. `none`
   * collects the ROMs certainly without achievements: hashed as RetroAchievements does (raHashTrusted), found in no
   * game of a whole list (a list has only games with achievements) and matched by no title either.
   */
  async function matchRoms(
    roms: RomCandidate[],
    creds: RaCredentials,
    none?: Set<string>,
    /** The background scan: stop (and hash nothing more) once this says so (a game started). */
    stopIf?: () => boolean
  ): Promise<MatchResult> {
    // Only the background scan leaves a file that could not be read lately alone (Sync now and a page open retry it).
    const retryFailed = !stopIf
    const byConsole = new Map<number, RomCandidate[]>()
    for (const rom of roms) {
      const consoleId = raConsoleFor(rom.platformId)
      if (consoleId === null) continue
      const list = byConsole.get(consoleId) ?? []
      list.push(rom)
      byConsole.set(consoleId, list)
    }
    const result: MatchResult = {
      matches: new Map(),
      unsure: new Set(),
      listAt: new Map(),
      stopped: false
    }
    const { matches } = result
    for (const [consoleId, consoleRoms] of byConsole) {
      if (disposed) break
      const { games, whole, failed, fetchedAt } = await consoleGames(consoleId, creds)
      for (const rom of consoleRoms) result.listAt.set(rom.id, fetchedAt)
      // The list could not be downloaded: these ROMs cannot be told yet (a cached older list still matches some).
      if (!games.length) {
        if (failed) for (const rom of consoleRoms) result.unsure.add(rom.id)
        continue
      }
      const byHash = new Map<string, RaGame>()
      const byTitle = new Map<string, RaGame | null>()
      for (const game of games) {
        for (const hash of game.hashes) byHash.set(hash, game)
        // Hacks, homebrew and test kits ("~Hack~ ...") never stand in for a retail ROM by name.
        if (game.title.startsWith('~')) continue
        for (const part of game.title.split(' | ')) {
          const key = matchTitle(part)
          if (!key) continue
          byTitle.set(key, byTitle.has(key) && byTitle.get(key)?.id !== game.id ? null : game)
        }
      }
      for (const rom of consoleRoms) {
        if (rom.hash === undefined && rom.path && stopIf?.()) {
          result.stopped = true
          break
        }
        const hash =
          rom.hash !== undefined
            ? rom.hash
            : rom.path
              ? await romHash(rom.path, consoleId, retryFailed)
              : null
        const match =
          (hash ? byHash.get(hash) : undefined) ??
          byTitle.get(matchTitle(rom.title)) ??
          (rom.file ? byTitle.get(matchTitle(rom.file)) : undefined)
        if (match) matches.set(rom.id, match)
        else if (failed) result.unsure.add(rom.id)
        // A zip's ROM is its first file that is not a manual or an image: another file in it may have given the hash.
        else if (
          hash &&
          whole &&
          raHashTrusted(rom.platformId) &&
          (consoleId === RA_CONSOLE.arcade || rom.ext !== '.zip')
        )
          none?.add(rom.id)
      }
      if (result.stopped) break
    }
    await saveHashes()
    return result
  }

  /** Mark a ROM as without RetroAchievements (RA_NONE), its counts dropped. */
  function markNone(gameId: string, changed: string[]): void {
    const game = library.getGame(gameId)
    if (!game || (game.metadata.sources?.[RA_SOURCE] === RA_NONE && !game.metadata.achievements))
      return
    library.clearAchievements([gameId], RA_SOURCE)
    library.applyMetadata(
      gameId,
      { metadata: { sources: { [RA_SOURCE]: RA_NONE } } },
      { overwrite: true, quiet: true }
    )
    changed.push(gameId)
  }

  /** ROMs that carry RetroAchievements counts; cleared when the account goes away (a recompilation's stay). */
  function clearRetro(): void {
    const ids = library
      .games()
      .filter(
        (g) =>
          isRom(g) &&
          !g.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE] &&
          (g.metadata.achievements || g.metadata.sources?.[RA_SOURCE])
      )
      .map((g) => g.id)
    announce(library.clearAchievements(ids, RA_SOURCE))
    // The paired hosts' ROMs: what the account found for them goes too.
    const table = raRecord.loaded()
    if (table && Object.keys(table).some((id) => isRemoteId(id))) {
      raRecord.change((t) => {
        for (const id of Object.keys(t)) if (isRemoteId(id)) delete t[id]
      })
      remoteSource?.changed()
    }
  }

  // --- the RetroAchievements scan -------------------------------------------------------
  // Like the Steam scan: a ROM is matched and read once when it joins the library (or a paired host offers it), then
  // again only once it was played after its last read (here, on a paired PC, or in RetroAchievements' recently played
  // list, read once per start, which also catches play on other devices). The full pass (syncRetro) stays for a new
  // account and Settings' Sync now. ra-scans.json keeps when each ROM was read, and the counts of the hosts' ROMs.

  const raRecord = createScanRecord<RaScanEntry>({
    file: join(deps.cacheDir, 'ra-scans.json'),
    // A paired host's ROMs stay while the hosts' games are not in hand.
    keep: (id) =>
      !!library.getGame(id) || (isRemoteId(id) && (remoteIds === null || remoteIds.has(id))),
    write: (file, value) => writeJson(file, value),
    onSaveError: (err) =>
      log.warn(`retroachievements: could not save the scan record: ${describeError(err)}`)
  })
  const retroRunner = createScanRunner({
    startDelayMs: 0,
    kickDelayMs: options.raKickDelayMs ?? RA_KICK_DELAY_MS,
    backoffMs: options.raBackoffMs ?? RA_BACKOFF_MS,
    pass: async () => {
      // Nothing is read (or hashed) while a game runs; its end picks the pass up.
      if (gameRunning()) {
        retroDeferred = true
        return
      }
      retroDeferred = false
      const paused = retroRunner.pausedFor()
      if (paused > 0) {
        retroRunner.schedule(paused)
        return
      }
      await queueRetro('due')
      // Hashing for the paired clients needs no account; it runs on its own, after the start-up work.
      hashRunner.kick()
    },
    onError: (err) => log.warn(`retroachievements: scan failed: ${describeError(err)}`)
  })
  const hashRunner = createScanRunner({
    startDelayMs: options.raHashStartDelayMs ?? RA_HASH_START_DELAY_MS,
    kickDelayMs: options.raKickDelayMs ?? RA_KICK_DELAY_MS,
    backoffMs: options.raBackoffMs ?? RA_BACKOFF_MS,
    pass: async () => {
      if (gameRunning()) {
        hashDeferred = true
        return
      }
      await hashRoms()
    },
    onError: (err) => log.warn(`retroachievements: hashing ROMs failed: ${describeError(err)}`)
  })
  /** RetroAchievements' recently played list was read this run for this account (once per start). */
  let recentReadFor = ''
  /** A pass held back while a game ran. */
  let retroDeferred = false
  /** The paired hosts' games as last seen (null: not asked yet). */
  let remoteIds: Set<string> | null = null
  let remoteSource: RemoteGamesSource | null = null

  /** The paired hosts' ROMs this PC can match: ROMs of a system RetroAchievements covers (isRemoteRom). */
  async function remoteRoms(): Promise<Game[]> {
    if (!remoteSource) return []
    let games: Game[]
    try {
      games = await remoteSource.games()
    } catch (err) {
      log.debug(`retroachievements: the hosts' games could not be read: ${describeError(err)}`)
      return []
    }
    // An empty list may only mean the hosts' offers are not loaded yet: what was read for them stays, unless no host is
    // paired any more (then their ROMs leave the record).
    if (games.length) remoteIds = new Set(games.map((g) => g.id))
    else if ((await remoteSource.pairedHosts?.().catch(() => null)) === 0) remoteIds = new Set()
    return games.filter(isRemoteRom)
  }

  /** A ROM's line in the record with this account's answer; undefined when it is another account's. */
  function entryFor(
    table: Record<string, RaScanEntry>,
    id: string,
    account: string
  ): RaScanEntry | undefined {
    const entry = table[id]
    return entry?.account === account ? entry : undefined
  }

  let retroRun: Promise<RetroAchievementsStatus> | null = null
  let retroAgain: RetroMode | null = null
  let syncedFor = ''

  /**
   * One pass: `full` matches and reads every ROM (a new account, Sync now); `due` only the ROMs the scan has not read
   * with this account yet or that were played since (and, once per start, RetroAchievements' recently played list).
   */
  async function runRetroSync(mode: RetroMode): Promise<RetroAchievementsStatus> {
    // The background pass asks nothing for an account already found signed out or refused: a new username or key
    // (a higher revision) runs the full pass.
    if (
      mode === 'due' &&
      (status.state === 'signed-out' || status.state === 'invalid') &&
      status.revision === revision &&
      (status.state === 'invalid' || !raCredentials())
    )
      return status
    runRevision = revision
    const creds = raCredentials()
    if (!creds) {
      profile = null
      clearRetro()
      syncedFor = ''
      recentReadFor = ''
      return setStatus({ state: 'signed-out' })
    }
    const key = credentialKey(creds)
    // A different account: the previous one's counts must not stay on the cards meanwhile.
    if (syncedFor && syncedFor !== key) clearRetro()
    const fresh = syncedFor !== key || !profile
    if (mode === 'full' || fresh) {
      // A re-check of the same account keeps showing it; a new one shows nobody until RetroAchievements answers.
      setStatus(
        syncedFor === key
          ? { ...status, state: 'checking', message: undefined }
          : { state: 'checking' }
      )
      try {
        profile = await fetchRaProfile(creds)
      } catch (err) {
        if (err instanceof RaAuthError) {
          profile = null
          return setStatus({
            state: 'invalid',
            message: tMain('mainApp.ra.keyRejected')
          })
        }
        if (mode === 'due') retroRunner.pause(askedWait(err))
        return setStatus({
          state: 'error',
          message: tMain('mainApp.ra.unreachable', { error: describeError(err) })
        })
      }
      if (!profile) {
        return setStatus({
          state: 'invalid',
          message: tMain('mainApp.ra.noUser', { user: creds.username })
        })
      }
    }
    const current: RaProfile = profile!
    const signedIn: Omit<RetroAchievementsStatus, 'revision'> = {
      state: 'signed-in',
      user: current.user,
      avatar: current.avatar,
      points: current.points,
      softcorePoints: current.softcorePoints
    }
    const roms = library.games().filter(isRom)
    const hostRoms = await remoteRoms()
    const table = await raRecord.load()
    if (disposed) return status
    const account = creds.username.toLowerCase()
    const now = Date.now()
    const sessions = lastSessionTimes(library.allSessions())
    const byId = new Map<string, Game>([...roms, ...hostRoms].map((g) => [g.id, g]))
    const candidates = [...roms.map(localCandidate), ...hostRoms.map(remoteCandidate)]
    /**
     * Due: never read with this account, matched from another file since, played after its last read, or matched with
     * no game while a newer list of its console has come in since (a set may have been added; no request for it).
     */
    const due =
      mode === 'full'
        ? candidates
        : candidates.filter((c) => {
            const entry = entryFor(table, c.id, account)
            if (!entry || entry.from !== fromOf(c)) return true
            if (!entry.raId && !entry.none && entry.at !== undefined && !entry.retryAt) {
              const consoleId = raConsoleFor(c.platformId)
              const newer = consoleId !== null ? listFetchedAt.get(consoleId) : undefined
              if (newer !== undefined && newer > (entry.listAt ?? 0)) return true
            }
            const game = byId.get(c.id)!
            return scanDue(entry, now, (since) =>
              playedAfter(game, entry, since, sessions.get(c.id))
            )
          })
    // ROMs whose last read failed and still wait: the scan comes back for the first of them (a timer may fire a little
    // early, before its wait is over).
    const dueIds = new Set(due.map((c) => c.id))
    let waitingUntil = Number.POSITIVE_INFINITY
    for (const c of candidates) {
      const retryAt = entryFor(table, c.id, account)?.retryAt
      if (!dueIds.has(c.id) && retryAt && retryAt > now)
        waitingUntil = Math.min(waitingUntil, retryAt)
    }
    if (Number.isFinite(waitingUntil)) retroRunner.schedule(waitingUntil - Date.now() + 1)
    const readRecent = mode === 'due' && recentReadFor !== key
    if (mode === 'due' && !fresh && !due.length && !readRecent) return status
    if (mode === 'full' || fresh) setStatus({ ...signedIn, state: 'checking', roms: roms.length })
    /** Due ROMs already matched with this account: only their counts are read again. */
    const known = new Map<string, number>()
    const toMatch: RomCandidate[] = []
    for (const c of due) {
      const entry = entryFor(table, c.id, account)
      if (mode === 'due' && entry?.raId && entry.from === fromOf(c)) known.set(c.id, entry.raId)
      else toMatch.push(c)
    }
    let matched: MatchResult
    const none = new Set<string>()
    const progress = new Map<number, { unlocked: number; total: number }>()
    /** RetroAchievements games whose own read failed (that game only): their ROMs wait and are asked again. */
    const failedRa = new Set<number>()
    let failure: unknown = null
    let recent: RaRecentGame[] = []
    let recentRead = false
    const asked = Date.now()
    try {
      // The background pass stops when a game starts (no ROM is hashed while one runs); its end picks it up.
      matched = await matchRoms(toMatch, creds, none, mode === 'due' ? gameRunning : undefined)
      if (matched.stopped) {
        retroDeferred = true
        return setStatus({ ...signedIn, roms: roms.length })
      }
      const wanted = new Set([...[...matched.matches.values()].map((g) => g.id), ...known.values()])
      if (wanted.size && (mode === 'full' || wanted.size > RA_PER_GAME_MAX)) {
        for (const p of await fetchRaCompletion(creds)) progress.set(p.gameId, p)
      } else {
        // A few games (new, or played since): one request each gives their exact counts. One game's failure is that
        // game's: the others' answers are kept (a rate limit or no network stops the pass).
        for (const raId of wanted) {
          try {
            const info = await fetchRaGame(raId, creds)
            progress.set(raId, { unlocked: info?.unlocked ?? 0, total: info?.total ?? 0 })
          } catch (err) {
            if (err instanceof RaAuthError || sharedFailure(err)) throw err
            failedRa.add(raId)
            failure = err
            log.warn(`retroachievements: game ${raId} could not be read: ${describeError(err)}`)
          }
        }
      }
    } catch (err) {
      if (err instanceof RaAuthError)
        return setStatus({
          state: 'invalid',
          message: tMain('mainApp.ra.keyRejected')
        })
      log.warn(`retroachievements: sync failed: ${describeError(err)}`)
      // The due ROMs stay due; the scan waits a while (longer each failure in a row) before it asks again.
      if (mode === 'due') retroRunner.pause(askedWait(err))
      return setStatus({
        ...signedIn,
        roms: roms.length,
        message: tMain('mainApp.ra.syncFailed', { error: describeError(err) })
      })
    }
    // The recently played list on its own: its failure keeps what the pass found (it is asked again next pass).
    if (readRecent) {
      try {
        recent = await fetchRaRecent(creds)
        recentRead = true
      } catch (err) {
        if (err instanceof RaAuthError)
          return setStatus({ state: 'invalid', message: tMain('mainApp.ra.keyRejected') })
        log.warn(
          `retroachievements: the recently played list could not be read: ${describeError(err)}`
        )
      }
    }
    // Signed out or switched accounts meanwhile: these answers belong to nobody on screen now.
    if (disposed || credentialKey(raCredentials()) !== key) return status
    if (recentRead) recentReadFor = key
    const { matches } = matched
    /** ROMs that could not be told this pass: their game's read failed, or their console's list did. */
    const failedIds = new Set<string>(matched.unsure)
    for (const [romId, game] of matches) if (failedRa.has(game.id)) failedIds.add(romId)
    for (const [romId, raId] of known) if (failedRa.has(raId)) failedIds.add(romId)
    const changed: string[] = []
    /** What this pass found for each ROM: its RetroAchievements game, and its counts when read. */
    const found = new Map<string, RomFound>()
    for (const [romId, game] of matches) {
      if (failedIds.has(romId)) continue
      const p = progress.get(game.id)
      const total = p?.total || game.achievements
      if (total <= 0) {
        none.add(romId)
        continue
      }
      found.set(romId, {
        raId: game.id,
        counts: { unlocked: Math.min(p?.unlocked ?? 0, total), total }
      })
    }
    for (const [romId, raId] of known) {
      if (failedIds.has(romId)) continue
      const p = progress.get(raId)
      found.set(romId, p && p.total > 0 ? { raId, counts: clampCounts(p) } : { raId })
    }
    // Played lately on any device: the counts of every ROM of that game the scan matched, not only the due ones.
    const recentById = new Map(recent.map((r) => [r.gameId, r]))
    if (recentById.size) {
      for (const c of candidates) {
        if (found.has(c.id) || none.has(c.id) || failedIds.has(c.id)) continue
        const entry = entryFor(table, c.id, account)
        const r = entry?.raId ? recentById.get(entry.raId) : undefined
        if (!entry?.raId || !r || r.total <= 0) continue
        const playedAt = r.lastPlayed ? Date.parse(r.lastPlayed) : Number.NaN
        if (Number.isFinite(playedAt) && entry.at !== undefined && playedAt <= entry.at) continue
        found.set(c.id, { raId: entry.raId, counts: clampCounts(r) })
      }
    }
    for (const [romId, f] of found) {
      if (!isRemoteId(romId) && f.counts) {
        if (writeCounts(romId, f.counts, { sources: { [RA_SOURCE]: String(f.raId) } }))
          changed.push(romId)
      }
      cache.delete(romId)
    }
    // What the sync found without achievements is marked (the game page leaves its section out). A mark stays until a
    // sync matches the ROM (its counts and game id replace it): a sync that could not tell does not undo it.
    for (const id of none) if (!isRemoteId(id)) markNone(id, changed)
    // The record: when each ROM was read, and for a host's ROM what this account found. The ROMs that could not be
    // told are not read yet: each waits out a growing pause (scan-scheduler.ts failEntries) and is asked again.
    let hostChanged = false
    const recorded = new Set([...due.map((c) => c.id), ...found.keys()])
    for (const c of candidates) {
      if (failedIds.has(c.id)) {
        const before = entryFor(table, c.id, account)
        table[c.id] = { ...(before?.from === fromOf(c) ? before : {}), account, from: fromOf(c) }
        continue
      }
      if (!recorded.has(c.id)) continue
      const game = byId.get(c.id)!
      const before = entryFor(table, c.id, account)
      const f = found.get(c.id)
      const entry: RaScanEntry = {
        ...readEntry(game, before, asked),
        account,
        from: fromOf(c),
        ...(f
          ? { raId: f.raId }
          : none.has(c.id)
            ? { none: true }
            : { listAt: matched.listAt.get(c.id) ?? before?.listAt ?? 0 })
      }
      if (isRemoteId(c.id)) {
        const counts =
          f?.counts ??
          (f && before?.raId === f.raId && before.total
            ? { unlocked: before.unlocked ?? 0, total: before.total }
            : undefined)
        if (counts) Object.assign(entry, counts)
        if (
          before?.raId !== entry.raId ||
          before?.none !== entry.none ||
          before?.unlocked !== entry.unlocked ||
          before?.total !== entry.total
        )
          hostChanged = true
      }
      table[c.id] = entry
    }
    const retry = failedIds.size
      ? failEntries(table, [...failedIds], options.raBackoffMs ?? RA_BACKOFF_MS, failure)
      : Number.POSITIVE_INFINITY
    await raRecord.save()
    announce(changed)
    if (hostChanged) remoteSource?.changed()
    syncedFor = key
    const localMatched =
      mode === 'full'
        ? [...matches.keys()].filter((id) => !isRemoteId(id) && !failedIds.has(id)).length
        : roms.filter((g) => entryFor(table, g.id, account)?.raId).length
    log.info(
      `retroachievements: ${current.user}, ${localMatched} of ${roms.length} ROM(s) matched, ${due.length} read, ${changed.length} changed` +
        (failedIds.size ? `, ${failedIds.size} to ask again` : '') +
        (hostRoms.length ? `; ${hostRoms.length} host ROM(s)` : '')
    )
    if (Number.isFinite(retry)) retroRunner.schedule(retry - Date.now())
    retroRunner.passed()
    return setStatus({
      ...signedIn,
      roms: roms.length,
      matched: localMatched,
      syncedAt: new Date().toISOString()
    })
  }

  /** One pass at a time; a full pass asked for during one runs after it (a due pass asked then is part of it). */
  function queueRetro(mode: RetroMode): Promise<RetroAchievementsStatus> {
    if (disposed) return Promise.resolve(status)
    if (retroRun) {
      if (mode === 'full' || !retroAgain) retroAgain = mode
      return retroRun
    }
    retroRun = (async () => {
      try {
        let next = mode
        let result: RetroAchievementsStatus
        for (;;) {
          retroAgain = null
          result = await runRetroSync(next)
          if (!retroAgain || disposed) break
          next = retroAgain
        }
        return result
      } finally {
        retroRun = null
      }
    })()
    return retroRun
  }

  function syncRetro(): Promise<RetroAchievementsStatus> {
    return queueRetro('full')
  }

  /** A play session of a ROM ended (here, or a host's ROM streamed): the scan reads it again. */
  function retroPlayed(gameId: string, endedAt: string): void {
    if (disposed) return
    const game = library.getGame(gameId)
    if (!(game && isRom(game)) && !isRemoteId(gameId)) {
      // Another game ended: a pass (or hashing) held back while it ran goes on.
      if (retroDeferred) retroRunner.kick()
      if (hashDeferred) hashRunner.kick()
      return
    }
    const ended = Date.parse(endedAt)
    cache.delete(gameId)
    void raRecord
      .load()
      .then(async (table) => {
        if (table[gameId])
          table[gameId] = {
            ...table[gameId],
            playedAt: Number.isFinite(ended) ? ended : Date.now()
          }
        await raRecord.save()
        retroRunner.kick()
      })
      .catch((err) =>
        log.warn(`retroachievements: could not note a play session: ${describeError(err)}`)
      )
  }

  /** A paired host's ROM: this PC's own RetroAchievements counts of it (ra-scans.json), when this account read it. */
  function remoteRetro(gameId: string): RemoteRetroCounts | undefined {
    const creds = raCredentials()
    const table = raRecord.loaded()
    if (!creds || !table) return undefined
    const entry = entryFor(table, gameId, creds.username.toLowerCase())
    if (!entry || entry.at === undefined) return undefined
    if (entry.none) return { none: true }
    if (!entry.raId || !entry.total) return undefined
    return {
      raId: entry.raId,
      unlocked: Math.min(entry.unlocked ?? 0, entry.total),
      total: entry.total,
      updatedAt: new Date(entry.at).toISOString()
    }
  }

  /** A paired host's ROM's list with this PC's account: by the game the scan matched, or matched now. */
  async function loadRemoteRom(gameId: string): Promise<RemoteRomRead> {
    const creds = raCredentials()
    if (!creds) return { kind: 'host' }
    const game = (await remoteRoms()).find((g) => g.id === gameId)
    if (!game) return { kind: 'host' }
    const asked = credentialKey(creds)
    const account = creds.username.toLowerCase()
    const table = await raRecord.load()
    const candidate = remoteCandidate(game)
    const entry = entryFor(table, gameId, account)
    const sameFile = entry?.from === fromOf(candidate)
    let raId = sameFile ? entry?.raId : undefined
    if (!raId) {
      // This account found no achievements for it: the card shows none either, so no other account's list does.
      if (sameFile && entry?.none) return { kind: 'none' }
      const match = (await matchRoms([candidate], creds)).matches.get(gameId)
      // RetroAchievements does not know it (by the host's hash or its title): the host's list is all there may be.
      if (!match) return { kind: 'host' }
      raId = match.id
    }
    const at = Date.now()
    const info = await fetchRaGame(raId, creds)
    if (credentialKey(raCredentials()) !== asked) return { kind: 'host' }
    const next: RaScanEntry = {
      ...readEntry(game, entry, at),
      account,
      from: fromOf(candidate),
      raId,
      ...(info && info.total > 0 ? { unlocked: info.unlocked, total: info.total } : {})
    }
    table[gameId] = next
    await raRecord.save()
    if (
      entry?.raId !== next.raId ||
      entry?.unlocked !== next.unlocked ||
      entry?.total !== next.total
    )
      remoteSource?.changed()
    return info ? { kind: 'list', info } : { kind: 'host' }
  }

  // A new username or key (typed in Settings > Emulators) is checked once the typing settles; a new Steam Web API
  // key (Settings > Metadata) fills the Steam games the same way.
  const steamKey = (): string => {
    const c = keyCredential()
    return c && 'key' in c ? `${c.steamId64}\n${c.key}` : ''
  }
  let lastCreds = credentialKey(raCredentials())
  let lastSteamKey = steamKey()
  let settingsTimer: NodeJS.Timeout | null = null
  let steamTimer: NodeJS.Timeout | null = null
  const offSettings = settings.onChange(() => {
    const nextSteam = steamKey()
    if (nextSteam !== lastSteamKey) {
      lastSteamKey = nextSteam
      // Counts read with the old key (or its SteamID64) are not this one's; the account or new key refills them.
      resetSteam()
      if (steamTimer) clearTimeout(steamTimer)
      steamTimer = setTimeout(() => {
        steamTimer = null
        void syncSteam()
      }, options.settingsDelayMs ?? RA_SETTINGS_DELAY_MS)
      steamTimer.unref?.()
    }
    const next = credentialKey(raCredentials())
    if (next === lastCreds) return
    lastCreds = next
    revision++
    for (const [id, entry] of cache) if (entry.key !== 'steam') cache.delete(id)
    if (settingsTimer) clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => {
      settingsTimer = null
      void syncRetro()
    }, options.settingsDelayMs ?? RA_SETTINGS_DELAY_MS)
    settingsTimer.unref?.()
  })

  // --- GOG -------------------------------------------------------------------------
  // A GOG game's achievements, read with the GOG account signed in to PlayOut (gog.ts), scheduled like the Steam scan
  // (store-scan.ts). A GOG game PlayOut knows a Steam app id of keeps Steam's (shared/store-achievements.ts).

  let gogAccount: (() => Promise<GogAccountCredential | null>) | null = null
  const gogLocale = (): string => (mainLanguage() === 'es' ? 'es-ES' : 'en-US')
  const gogScan = createStoreScan(
    {
      id: 'gog',
      source: GOG_ACHIEVEMENTS_SOURCE,
      keyOf: (game) => {
        if (!storeAchievementsSource(game)) return null
        const id = String(game.extra?.gogProductId ?? game.externalId).trim()
        return /^\d+$/.test(id) ? id : null
      },
      read: (_game, productId, priority) =>
        options.gogRead
          ? options.gogRead(productId, priority)
          : readGogAchievements(
              productId,
              {
                account: () => gogAccount?.() ?? Promise.resolve(null),
                locale: gogLocale
              },
              priority
            ),
      isAuthError: (err) => err instanceof GogAuthError
    },
    {
      library,
      log,
      cacheDir: deps.cacheDir,
      write: (file, value) => writeJson(file, value),
      writeCounts,
      announce,
      gameRunning,
      startDelayMs: options.storeStartDelayMs ?? STORE_START_DELAY_MS,
      kickDelayMs: options.steamKickDelayMs ?? STEAM_KICK_DELAY_MS,
      gapMs: options.storeScanGapMs ?? STORE_SCAN_GAP_MS,
      backoffMs: steamBackoffMs
    }
  )

  // --- recompilations -------------------------------------------------------------

  /** The cache key of a recompilation's list (its texts follow the UI language). */
  const recompKey = (recompId: string): string => `recomp:${recompId}:${mainLanguage()}`

  /** Whether a card carries counts from a recompilation that no longer gives them. */
  function staleRecomp(game: Game): boolean {
    const from = game.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE]
    return !!from && !game.remote && recompAchievementsFor(game) !== from
  }

  function forgetStaleRecomp(): void {
    if (disposed) return
    const ids = library
      .games()
      .filter(staleRecomp)
      .map((g) => g.id)
    if (!ids.length) return
    for (const id of ids) cache.delete(id)
    announce(library.clearAchievements(ids, RECOMP_ACHIEVEMENTS_SOURCE))
  }

  // --- one game -------------------------------------------------------------------

  /** A recompilation's achievements (the one Play starts), its counts written to the card when it has a list. */
  async function loadRecomp(game: Game, recompId: string): Promise<AchievementsInfo | null> {
    if (!recompReader) return null
    const info = await recompReader.read(game, recompId)
    if (
      info &&
      info.total > 0 &&
      writeCounts(
        game.id,
        { unlocked: info.unlocked, total: info.total },
        { sources: { [RECOMP_ACHIEVEMENTS_SOURCE]: recompId } }
      )
    )
      announce([game.id])
    return info
  }

  async function load(game: Game): Promise<AchievementsInfo | null> {
    // Play starts a recompilation PlayOut reads achievements of: its achievements, not RetroAchievements'.
    const recompId = recompAchievementsFor(game)
    if (recompId) return loadRecomp(game, recompId)
    // Counts left from a recompilation no longer installed (or no longer the one Play starts) go first.
    if (staleRecomp(game))
      announce(library.clearAchievements([game.id], RECOMP_ACHIEVEMENTS_SOURCE))
    if (game.source === 'rom') {
      const creds = raCredentials()
      if (!creds) return null
      const asked = credentialKey(creds)
      let raId = Number(game.metadata.sources?.[RA_SOURCE])
      if (!Number.isInteger(raId) || raId <= 0) {
        const match = (await matchRoms([localCandidate(game)], creds)).matches.get(game.id)
        if (!match) return null
        raId = match.id
      }
      const info = await fetchRaGame(raId, creds)
      // Signed out or switched accounts meanwhile: this answer belongs to nobody on screen now.
      if (credentialKey(raCredentials()) !== asked) return null
      if (
        info &&
        writeCounts(
          game.id,
          { unlocked: info.unlocked, total: info.total },
          { sources: { [RA_SOURCE]: String(raId) } }
        )
      )
        announce([game.id])
      return info
    }
    // A GOG game without a Steam app id: GOG's own achievements, with the GOG account signed in to PlayOut.
    if (gogScan.handles(game)) return gogScan.load(game)
    const appId = steamAppIdOf(game)
    if (!appId) return null
    // Steam said the game has none: nothing to ask (the Steam scan asks again once it is played).
    if (knownWithoutSteamAchievements(game)) return null
    const scanned = scanAppId(game)
    const entry = scanned ? (await loadScans())[game.id] : undefined
    // A new metadata match dropped the mark, but nothing changed since Steam said "none": it goes back on.
    if (
      entry?.none &&
      !game.metadata.achievements &&
      !steamDue(game, entry, Date.now(), lastSessions(game.id).get(game.id))
    ) {
      const restored: string[] = []
      if (restoreNone(game, entry, restored)) {
        announce(restored)
        return null
      }
    }
    const generation = steamGeneration
    const asked = Date.now()
    const info = await withSteam((credential) => fetchSteamGame(appId, credential))
    if (generation !== steamGeneration) return null
    if (info) {
      const changed: string[] = []
      writeSteamCounts(game.id, { unlocked: info.unlocked, total: info.total }, changed)
      announce(changed)
      if (scanned) void noteSteamRead(game.id, asked)
      return info
    }
    // Nothing with the account (or no account): Steam's own list, read without one, says whether the game has
    // achievements at all. Only its "none" is kept; signed out or a failed request leave the page as it was.
    // A check that found achievements is not repeated on every open while the game is not played.
    const checked = keylessChecked.get(appId)
    if (checked !== undefined && Date.now() - checked < KEYLESS_CHECK_TTL_MS) return null
    let total: number | null
    try {
      total = await fetchSteamCount(appId)
    } catch (err) {
      log.debug(`steam: could not check whether ${appId} has achievements: ${describeError(err)}`)
      return null
    }
    if (generation !== steamGeneration) return null
    if (total === 0 && !game.remote) {
      const changed: string[] = []
      markSteamNone(game.id, changed)
      announce(changed)
      if (scanned) void noteSteamRead(game.id, asked, true)
    } else if (total) {
      // Remembered here only: the scan still reads the game's counts once an account can.
      keylessChecked.set(appId, Date.now())
    }
    return null
  }

  async function get(gameId: string): Promise<AchievementsInfo | null> {
    const game = library.getGame(gameId)
    if (!game) return null
    const recompId = recompAchievementsFor(game)
    const key = recompId
      ? recompKey(recompId)
      : game.source === 'rom'
        ? credentialKey(raCredentials())
        : gogScan.handles(game)
          ? `gog:${mainLanguage()}`
          : 'steam'
    const cached = cache.get(gameId)
    if (cached && cached.key === key && Date.now() - cached.at < LIVE_TTL_MS) return cached.info
    const running = inflight.get(gameId)
    if (running) return running
    const task = (async (): Promise<AchievementsInfo | null> => {
      try {
        const info = await load(game)
        // Only answers are kept: "nothing" may just mean not signed in yet, and the next open asks again.
        if (info) cache.set(gameId, { at: Date.now(), key, info })
        return info
      } catch (err) {
        // Not cached: the next open tries again.
        log.warn(`achievements for ${gameId} failed: ${describeError(err)}`)
        return null
      } finally {
        inflight.delete(gameId)
      }
    })()
    inflight.set(gameId, task)
    return task
  }

  /**
   * A paired host's ROM's list with this PC's account, cached like a game of this PC's. A failed read throws when this
   * PC's counts of the ROM are on its card (the host's list would show another account's unlocks under them); with
   * none on the card the host's list is asked instead, as it is for a ROM this PC cannot read.
   */
  async function getRemote(gameId: string): Promise<RemoteRomRead> {
    if (!isRemoteId(gameId) || !raCredentials()) return { kind: 'host' }
    const key = `ra:${credentialKey(raCredentials())}`
    const cached = cache.get(gameId)
    if (cached && cached.key === key && Date.now() - cached.at < LIVE_TTL_MS)
      return { kind: 'list', info: cached.info }
    const running = remoteInflight.get(gameId)
    if (running) return running
    const task = (async (): Promise<RemoteRomRead> => {
      try {
        const read = await loadRemoteRom(gameId)
        if (read.kind === 'list') cache.set(gameId, { at: Date.now(), key, info: read.info })
        return read
      } catch (err) {
        log.warn(`achievements for ${gameId} failed: ${describeError(err)}`)
        if (remoteRetro(gameId) !== undefined) throw err
        return { kind: 'host' }
      } finally {
        remoteInflight.delete(gameId)
      }
    })()
    remoteInflight.set(gameId, task)
    return task
  }
  const remoteInflight = new Map<string, Promise<RemoteRomRead>>()

  // Recompilations read once that gave no achievements (no list yet, or none): not read again on every start, only
  // when `recomp:changed` names them or they are played. recomp-achievements-tried.json: game id -> recompilation id.
  const recompTriedFile = join(deps.cacheDir, 'recomp-achievements-tried.json')
  let recompTried: Record<string, string> | null = null
  /** The start-up read waits for a game to end. */
  let recompStartPending = false

  async function loadRecompTried(): Promise<Record<string, string>> {
    if (recompTried) return recompTried
    try {
      const parsed = JSON.parse(await readFile(recompTriedFile, 'utf8')) as unknown
      recompTried =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {}
    } catch {
      recompTried = {}
    }
    return recompTried
  }

  async function saveRecompTried(): Promise<void> {
    if (!recompTried) return
    for (const id of Object.keys(recompTried)) if (!library.getGame(id)) delete recompTried[id]
    await writeJson(recompTriedFile, recompTried).catch((err) =>
      log.warn(`recomp achievements: could not save what was read: ${describeError(err)}`)
    )
  }

  /** Read a recompilation's achievements for a game; a read that gave no counts is remembered (see above). */
  async function readRecompOnce(game: Game, recompId: string): Promise<boolean> {
    const tried = await loadRecompTried()
    let dirty = false
    try {
      const info = await loadRecomp(game, recompId)
      if (info) cache.set(game.id, { at: Date.now(), key: recompKey(recompId), info })
      if (!info || info.total <= 0) {
        dirty = tried[game.id] !== recompId
        tried[game.id] = recompId
      } else if (tried[game.id] !== undefined) {
        delete tried[game.id]
        dirty = true
      }
    } catch (err) {
      log.warn(`achievements for ${game.id} from ${recompId} failed: ${describeError(err)}`)
    }
    return dirty
  }

  /**
   * `ids`: these recompilations changed (`recomp:changed`), read again for their games without counts. None: the
   * start-up read (after a short wait, never while a game runs) of the installed recompilations whose games have no
   * counts of theirs yet and were not read before.
   */
  async function recompChanged(ids?: string[]): Promise<void> {
    if (disposed || !recompReader) return
    if (!ids) {
      const delay = options.recompStartDelayMs ?? RECOMP_START_DELAY_MS
      if (delay > 0) await new Promise((r) => setTimeout(r, delay).unref?.())
      if (disposed) return
      if (gameRunning()) {
        recompStartPending = true
        return
      }
      recompStartPending = false
    }
    const wanted = ids ? new Set(ids) : null
    const tried = await loadRecompTried()
    let dirty = false
    if (wanted) {
      for (const [gameId, recompId] of Object.entries(tried)) {
        if (!wanted.has(recompId)) continue
        delete tried[gameId]
        dirty = true
      }
    }
    for (const game of library.games()) {
      if (disposed) return
      const recompId = recompAchievementsFor(game)
      if (!recompId || (wanted && !wanted.has(recompId))) continue
      // Already read for this recompilation: the play sessions keep it current (recompPlayed).
      if (game.metadata.sources?.[RECOMP_ACHIEVEMENTS_SOURCE] === recompId) continue
      if (!wanted && tried[game.id] === recompId) continue
      if (!wanted && gameRunning()) {
        recompStartPending = true
        break
      }
      if (await readRecompOnce(game, recompId)) dirty = true
    }
    if (dirty) await saveRecompTried()
  }

  return {
    useSteamAccount(credential) {
      steamAccount = credential
      steamAuthBlocked = false
    },
    useRecomp(reader) {
      recompReader = reader
    },
    async recompPlayed(recompId) {
      if (disposed) return
      // The unlock file may have just appeared (the first unlock), and a game executable may have been put in place.
      recompReader?.played(recompId)
      let dirty = false
      for (const game of library.games()) {
        if (recompAchievementsFor(game) !== recompId) continue
        cache.delete(game.id)
        if (await readRecompOnce(game, recompId)) dirty = true
      }
      if (dirty) await saveRecompTried()
    },
    forgetStaleRecomp,
    get,
    syncSteam,
    kickSteam,
    steamPlayed,
    steamSignedOut,
    syncRetro,
    retroStatus: () => status,
    kickRetro(delayMs) {
      if (disposed) return
      if (delayMs === 0) void retroRunner.run()
      else retroRunner.kick()
    },
    played(gameId, endedAt) {
      steamPlayed(gameId, endedAt)
      retroPlayed(gameId, endedAt)
      gogScan.played(gameId, endedAt)
      // The start-up read of the recompilations waited for this game to end.
      if (recompStartPending) void recompChanged()
    },
    kick() {
      kickSteam()
      gogScan.kick()
    },
    useRemote(source) {
      remoteSource = source
    },
    getRemote,
    remoteRetro,
    raHashOf,
    useGogAccount(credential) {
      gogAccount = credential
    },
    syncStore() {
      return gogScan.sync()
    },
    storeSignedOut() {
      forgetGogTokens()
      for (const [id, entry] of cache) if (entry.key.startsWith('gog:')) cache.delete(id)
      gogScan.signedOut()
    },
    recompChanged,
    dispose() {
      disposed = true
      offSettings()
      if (settingsTimer) clearTimeout(settingsTimer)
      if (steamTimer) clearTimeout(steamTimer)
      steamRunner.dispose()
      retroRunner.dispose()
      hashRunner.dispose()
      gogScan.dispose()
    }
  }
}
