// Achievements for the whole library (ARCHITECTURE.md §4.10): Steam games from the Steam Web API, ROMs from
// RetroAchievements. Steam games are read in the background once when they join the library and again only after
// they were played since their last read (the Steam scan below); a pass after every ROM scan fills the ROMs. The
// counts show on the cards and the game detail screen; a game's full list is fetched when it is opened.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AchievementsInfo, Game, RetroAchievementsStatus } from '../../shared/types'
import type { EventBus } from '../events'
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
  RaAuthError,
  type RaCredentials,
  type RaGame,
  type RaProfile,
  type RaProgress
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
/** A failed Steam scan step waits this long, doubled each failure in a row, up to STEAM_BACKOFF_MAX_MS. */
const STEAM_BACKOFF_MS = 2 * 60 * 1000
const STEAM_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
/** A game whose read failed this many times in a row is no longer retried on a timer (only after a play, etc.). */
const STEAM_PARK_AFTER = 5
/** The one-game reads of a pass write their marks and the record this often (games, or ms), not after every game. */
const STEAM_FLUSH_EVERY = 25
const STEAM_FLUSH_MS = 5 * 1000
/** A page open's keyless check that found achievements is not repeated for this long (unless the game is played). */
const KEYLESS_CHECK_TTL_MS = 6 * 60 * 60 * 1000
/** A Settings edit settles before the account is checked again. */
const RA_SETTINGS_DELAY_MS = 800
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
  dispose(): void
}

interface HashCacheEntry {
  size: number
  mtimeMs: number
  consoleId: number
  hash: string | null
}

/** A console's games with achievements; `whole` unless a failed download left an older or no list. */
interface ConsoleList {
  games: RaGame[]
  whole: boolean
}

interface ListCacheFile {
  fetchedAt: number
  games: RaGame[]
}

const isRom = (g: Game): boolean => g.source === 'rom' && !!g.romPath

/** A Steam game's line in steam-scans.json: when the Steam scan last read it. */
interface SteamScanEntry {
  /** When Steam last answered for the game (epoch ms); absent while its reads only failed. */
  at?: number
  /** The game's last played then (null: none): a later one since = played since (through Steam, a paired PC). */
  seen?: string | null
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
  /** When a PlayOut play session of the game ended (epoch ms): after `at` = read again. */
  playedAt?: number
  /** Failed reads in a row, and when the next one may run. */
  fails?: number
  retryAt?: number
  /** Failed STEAM_PARK_AFTER times in a row (epoch ms): no timed retry, only after a play, an import or a restart. */
  parkedAt?: number
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
  // was played after its last read. Never on a timer otherwise: a failed read waits out a growing pause and, after
  // STEAM_PARK_AFTER failures in a row, waits for a play, an owned import or sign-in, or the next start; games waiting
  // for a Steam account (or for one Steam accepts) wait for the next sign-in, owned import or Settings key. Nothing is
  // read while a game runs.

  const steamStartDelayMs = options.steamStartDelayMs ?? STEAM_START_DELAY_MS
  const steamKickDelayMs = options.steamKickDelayMs ?? STEAM_KICK_DELAY_MS
  const steamScanGapMs = options.steamScanGapMs ?? STEAM_SCAN_GAP_MS
  const steamBackoffMs = options.steamBackoffMs ?? STEAM_BACKOFF_MS
  const gameRunning = (): boolean => deps.gameRunning?.() ?? false
  /** Until the start-up delay has passed, the scan waits (the delay's pass reads whatever is due). */
  let steamStarted = steamStartDelayMs <= 0
  let steamStartTimer: NodeJS.Timeout | null = null
  let steamScanTimer: NodeJS.Timeout | null = null
  /** When steamScanTimer fires (epoch ms). */
  let steamScanAt = 0
  /** No Steam request of the scan before this (epoch ms): its last step failed. */
  let steamPausedUntil = 0
  let steamPauseFails = 0
  /** Steam refused every credential: nothing is read until the credential changes (or an import / sign-in). */
  let steamAuthBlocked = false
  /** A pass stopped for a running game: the next session change (or play) picks it up. */
  let steamDeferred = false
  /** An owned import or sign-in asked: parked games get one more try. */
  let steamUnparkPending = false
  /** Page opens whose keyless check found achievements this account has no progress in: app id -> when. */
  const keylessChecked = new Map<number, number>()

  const scanFile = join(deps.cacheDir, 'steam-scans.json')
  let scans: Record<string, SteamScanEntry> | null = null
  let scansLoading: Promise<Record<string, SteamScanEntry>> | null = null
  /** A reset (sign-out, another key) came before the record was read: applied to it once read. */
  let scansResetPending = false

  function loadScans(): Promise<Record<string, SteamScanEntry>> {
    if (scans) return Promise.resolve(scans)
    scansLoading ??= (async () => {
      let table: Record<string, SteamScanEntry> = {}
      try {
        const parsed = JSON.parse(await readFile(scanFile, 'utf8')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          table = parsed as Record<string, SteamScanEntry>
      } catch {
        // No record yet: every Steam game is new to the scan.
      }
      // A new start: games parked after failing again and again get one more try.
      for (const entry of Object.values(table)) unpark(entry)
      scans = table
      if (scansResetPending) {
        scansResetPending = false
        forgetSteamScans(table)
      }
      return table
    })()
    return scansLoading
  }

  function unpark(entry: SteamScanEntry): void {
    if (entry.parkedAt === undefined) return
    delete entry.parkedAt
    delete entry.fails
  }

  async function saveScans(): Promise<void> {
    if (!scans) return
    // Games that left the library leave the record: one added again is new to the scan.
    for (const id of Object.keys(scans)) if (!library.getGame(id)) delete scans[id]
    await writeJson(scanFile, scans).catch((err) =>
      log.warn(`steam: could not save the achievements scan record: ${describeError(err)}`)
    )
  }

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

  /**
   * When each game's newest play session reached this PC (epoch ms, this PC's clock): a session from a paired PC
   * counts from when it was synced here, one played here from its end.
   */
  function lastSessions(gameId?: string): Map<string, number> {
    const out = new Map<string, number>()
    const sessions = gameId ? library.getSessions(gameId) : library.allSessions()
    for (const s of sessions) {
      const when = Date.parse(s.syncedAt ?? s.endedAt ?? '')
      if (!Number.isFinite(when)) continue
      if (when > (out.get(s.gameId) ?? 0)) out.set(s.gameId, when)
    }
    return out
  }

  /**
   * Played after `since`: a PlayOut session ended (or a paired PC's session arrived) after it, Steam's last played
   * changed to a later time than the one seen at the last read and after it (compared with the value seen, so a
   * clock ahead of this PC's cannot keep the game due), or Steam's playtime grew (not when that only caught up with
   * the PlayOut session the last read already followed).
   */
  function playedSince(
    game: Game,
    entry: SteamScanEntry,
    since: number,
    lastSession: number | undefined
  ): boolean {
    if (entry.playedAt && entry.playedAt > since) return true
    if (lastSession !== undefined && lastSession > since) return true
    const lastPlayed = game.lastPlayed ? Date.parse(game.lastPlayed) : Number.NaN
    if (
      Number.isFinite(lastPlayed) &&
      lastPlayed > since &&
      (game.lastPlayed ?? null) !== (entry.seen ?? null)
    ) {
      const seen = entry.seen ? Date.parse(entry.seen) : Number.NaN
      if (!Number.isFinite(seen) || lastPlayed > seen) return true
    }
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
    if (!entry) return true
    if (entry.appId !== undefined && entry.appId !== scanAppId(game)) return true
    if (entry.parkedAt !== undefined)
      return playedSince(game, entry, Math.max(entry.parkedAt, entry.at ?? 0), lastSession)
    if (entry.retryAt && now < entry.retryAt) return false
    if (entry.at === undefined) return true
    return playedSince(game, entry, entry.at, lastSession)
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
        at,
        seen: game.lastPlayed ?? null,
        storeMinutes: game.storePlaytimeMinutes ?? 0,
        ...(appId ? { appId } : {}),
        ...(none ? { none: true } : {}),
        // This read followed a PlayOut session: Steam's playtime catching up with it later is no new play.
        ...(playedAt && playedAt <= at ? { afterSession: true } : {}),
        ...(playedAt && playedAt > at ? { playedAt } : {})
      }
    }
  }

  const backoff = (fails: number): number =>
    Math.min(steamBackoffMs * 2 ** Math.max(0, fails - 1), STEAM_BACKOFF_MAX_MS)

  /** A rate limit, a network failure or a Retry-After: everything waits, not just the game asked about. */
  const sharedFailure = (err: unknown): boolean =>
    err instanceof HttpError &&
    (err.status === 429 || err.status === 0 || err.retryAfterMs !== undefined)

  /**
   * A scan step failed. Steam refusing the credential stops the scan until the credential changes (no game is held
   * back for it). Otherwise its games wait, longer after each failure in a row, and after STEAM_PARK_AFTER failures
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
    const asked = err instanceof HttpError ? (err.retryAfterMs ?? 0) : 0
    let retry = Number.POSITIVE_INFINITY
    for (const id of ids) {
      const entry: SteamScanEntry = { ...table[id] }
      const fails = (entry.fails ?? 0) + 1
      delete entry.retryAt
      if (fails >= STEAM_PARK_AFTER) {
        table[id] = { ...entry, fails, parkedAt: now }
        continue
      }
      const retryAt = now + Math.max(backoff(fails), asked)
      table[id] = { ...entry, fails, retryAt }
      retry = Math.min(retry, retryAt)
    }
    const limited = err instanceof HttpError && err.status === 429
    if (!everyone && !sharedFailure(err)) {
      log.warn(`steam: achievements of ${ids.join(', ')} could not be read: ${describeError(err)}`)
      // Only these games wait; the scan reads them once their wait is over.
      if (Number.isFinite(retry)) scheduleSteam(retry - now)
      return
    }
    steamPauseFails++
    const wait = Math.max(backoff(steamPauseFails), asked)
    steamPausedUntil = now + wait
    log.warn(
      `steam: achievements scan ${limited ? 'rate limited' : 'failed'} (${describeError(err)}); next try in ${Math.round(wait / 1000)} s`
    )
    scheduleSteam(wait)
  }

  /** Run the scan in `ms`, unless it is already set to run sooner. */
  function scheduleSteam(ms: number): void {
    if (disposed || !steamStarted) return
    const fireAt = Date.now() + Math.max(0, ms)
    if (steamScanTimer && steamScanAt <= fireAt) return
    if (steamScanTimer) clearTimeout(steamScanTimer)
    steamScanAt = fireAt
    steamScanTimer = setTimeout(
      () => {
        steamScanTimer = null
        void runSteam()
      },
      Math.max(0, ms)
    )
    steamScanTimer.unref?.()
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
    if (now < steamPausedUntil) {
      scheduleSteam(steamPausedUntil - now)
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
    if (Number.isFinite(nextRetry)) scheduleSteam(nextRetry - Date.now())
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
    steamPauseFails = 0
    log.info(
      `steam: achievements scan read ${byApp.size} game(s): ${counted} with counts, ${none} without achievements`
    )
    return true
  }

  let steamRun: Promise<void> | null = null
  let steamAgain = false

  function runSteam(): Promise<void> {
    if (disposed) return Promise.resolve()
    // Before the start-up delay is over: its pass reads what is due.
    if (!steamStarted) return Promise.resolve()
    if (steamRun) {
      steamAgain = true
      return steamRun
    }
    steamRun = (async () => {
      try {
        do {
          steamAgain = false
          try {
            await runSteamScan()
          } catch (err) {
            log.warn(`steam: achievements scan failed: ${describeError(err)}`)
          }
        } while (steamAgain && !disposed)
      } finally {
        steamRun = null
      }
    })()
    return steamRun
  }

  /** An owned import or a sign-in: a refused credential and parked games get another try. */
  function syncSteam(): Promise<void> {
    steamAuthBlocked = false
    steamUnparkPending = true
    return runSteam()
  }

  function kickSteam(): void {
    if (disposed || !steamStarted) return
    // A pause after a failure is not cut short.
    scheduleSteam(Math.max(steamKickDelayMs, steamPausedUntil - Date.now()))
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
    steamPausedUntil = 0
    steamPauseFails = 0
    if (scans) {
      forgetSteamScans(scans)
      void saveScans()
    } else scansResetPending = true
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

  async function romHash(path: string, consoleId: number): Promise<string | null> {
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
      known.consoleId === consoleId
    )
      return known.hash
    let hash: string | null
    try {
      hash = await hashRom(path, consoleId)
    } catch (err) {
      // A locked file or a sleeping drive: try again next time instead of remembering "no hash".
      log.debug(`retroachievements: could not hash ${path}: ${describeError(err)}`)
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
    if (cached && Array.isArray(cached.games) && Date.now() - cached.fetchedAt < RA_LIST_TTL_MS)
      return { games: cached.games, whole: Date.now() - cached.fetchedAt < RA_LIST_WHOLE_MS }
    try {
      const games = await fetchRaGameList(consoleId, creds)
      await writeJson(file, { fetchedAt: Date.now(), games } satisfies ListCacheFile).catch((err) =>
        log.warn(`retroachievements: could not cache console ${consoleId}: ${describeError(err)}`)
      )
      return { games, whole: true }
    } catch (err) {
      if (err instanceof RaAuthError) throw err
      log.warn(`retroachievements: game list ${consoleId} failed: ${describeError(err)}`)
      return { games: Array.isArray(cached?.games) ? cached.games : [], whole: false }
    }
  }

  /**
   * Find each ROM's RetroAchievements game: by hash, else by a title that only one game of the console has. `none`
   * collects the ROMs certainly without achievements: hashed as RetroAchievements does (raHashTrusted), found in no
   * game of a whole list (a list has only games with achievements) and matched by no title either.
   */
  async function matchRoms(
    roms: Game[],
    creds: RaCredentials,
    none?: Set<string>
  ): Promise<Map<string, RaGame>> {
    const byConsole = new Map<number, Game[]>()
    for (const rom of roms) {
      const consoleId = raConsoleFor(rom.platformId)
      if (consoleId === null) continue
      const list = byConsole.get(consoleId) ?? []
      list.push(rom)
      byConsole.set(consoleId, list)
    }
    const matches = new Map<string, RaGame>()
    for (const [consoleId, consoleRoms] of byConsole) {
      if (disposed) break
      const { games, whole } = await consoleGames(consoleId, creds)
      if (!games.length) continue
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
        const hash = rom.romPath ? await romHash(rom.romPath, consoleId) : null
        const file = rom.romPath ? basename(rom.romPath, extname(rom.romPath)) : ''
        const match =
          (hash ? byHash.get(hash) : undefined) ??
          byTitle.get(matchTitle(rom.title)) ??
          (file ? byTitle.get(matchTitle(file)) : undefined)
        if (match) matches.set(rom.id, match)
        // A zip's ROM is its first file that is not a manual or an image: another file in it may have given the hash.
        else if (
          hash &&
          whole &&
          raHashTrusted(rom.platformId) &&
          (consoleId === RA_CONSOLE.arcade || extname(rom.romPath!).toLowerCase() !== '.zip')
        )
          none?.add(rom.id)
      }
    }
    if (hashesDirty && hashes) {
      hashesDirty = false
      await writeJson(hashFile, hashes).catch((err) =>
        log.warn(`retroachievements: could not save ROM hashes: ${describeError(err)}`)
      )
    }
    return matches
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
  }

  let retroRun: Promise<RetroAchievementsStatus> | null = null
  let retroAgain = false
  let syncedFor = ''

  async function runRetroSync(): Promise<RetroAchievementsStatus> {
    runRevision = revision
    const creds = raCredentials()
    if (!creds) {
      profile = null
      clearRetro()
      syncedFor = ''
      return setStatus({ state: 'signed-out' })
    }
    const key = credentialKey(creds)
    // A different account: the previous one's counts must not stay on the cards meanwhile.
    if (syncedFor && syncedFor !== key) clearRetro()
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
    const signedIn: Omit<RetroAchievementsStatus, 'revision'> = {
      state: 'signed-in',
      user: profile.user,
      avatar: profile.avatar,
      points: profile.points,
      softcorePoints: profile.softcorePoints
    }
    const roms = library.games().filter(isRom)
    setStatus({ ...signedIn, state: 'checking', roms: roms.length })
    let matches: Map<string, RaGame>
    const none = new Set<string>()
    let progress: RaProgress[]
    try {
      matches = await matchRoms(roms, creds, none)
      progress = matches.size ? await fetchRaCompletion(creds) : []
    } catch (err) {
      if (err instanceof RaAuthError)
        return setStatus({
          state: 'invalid',
          message: tMain('mainApp.ra.keyRejected')
        })
      log.warn(`retroachievements: sync failed: ${describeError(err)}`)
      return setStatus({
        ...signedIn,
        roms: roms.length,
        message: tMain('mainApp.ra.syncFailed', { error: describeError(err) })
      })
    }
    if (disposed) return status
    const byGame = new Map(progress.map((p) => [p.gameId, p]))
    const changed: string[] = []
    for (const [romId, game] of matches) {
      const p = byGame.get(game.id)
      const total = p?.total || game.achievements
      if (total <= 0) {
        none.add(romId)
        continue
      }
      const counts = { unlocked: Math.min(p?.unlocked ?? 0, total), total }
      if (writeCounts(romId, counts, { sources: { [RA_SOURCE]: String(game.id) } }))
        changed.push(romId)
    }
    // What the sync found without achievements is marked (the game page leaves its section out). A mark stays until a
    // sync matches the ROM (its counts and game id replace it): a sync that could not tell does not undo it.
    for (const id of none) markNone(id, changed)
    announce(changed)
    syncedFor = key
    log.info(
      `retroachievements: ${profile.user}, ${matches.size} of ${roms.length} ROM(s) matched, ${changed.length} changed`
    )
    return setStatus({
      ...signedIn,
      roms: roms.length,
      matched: matches.size,
      syncedAt: new Date().toISOString()
    })
  }

  function syncRetro(): Promise<RetroAchievementsStatus> {
    if (disposed) return Promise.resolve(status)
    if (retroRun) {
      retroAgain = true
      return retroRun
    }
    retroRun = (async () => {
      try {
        let result: RetroAchievementsStatus
        do {
          retroAgain = false
          result = await runRetroSync()
        } while (retroAgain && !disposed)
        return result
      } finally {
        retroRun = null
      }
    })()
    return retroRun
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
        const match = (await matchRoms([game], creds)).get(game.id)
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

  // The Steam scan's first pass waits for the start-up work (the library scans, the store imports) to settle.
  if (!steamStarted) {
    steamStartTimer = setTimeout(() => {
      steamStartTimer = null
      steamStarted = true
      void runSteam()
    }, steamStartDelayMs)
    steamStartTimer.unref?.()
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
      for (const game of library.games()) {
        if (recompAchievementsFor(game) !== recompId) continue
        cache.delete(game.id)
        try {
          const info = await loadRecomp(game, recompId)
          if (info) cache.set(game.id, { at: Date.now(), key: recompKey(recompId), info })
        } catch (err) {
          log.warn(
            `achievements for ${game.id} after playing ${recompId} failed: ${describeError(err)}`
          )
        }
      }
    },
    forgetStaleRecomp,
    get,
    syncSteam,
    kickSteam,
    steamPlayed,
    steamSignedOut,
    syncRetro,
    retroStatus: () => status,
    dispose() {
      disposed = true
      offSettings()
      if (settingsTimer) clearTimeout(settingsTimer)
      if (steamTimer) clearTimeout(steamTimer)
      if (steamStartTimer) clearTimeout(steamStartTimer)
      if (steamScanTimer) clearTimeout(steamScanTimer)
    }
  }
}
