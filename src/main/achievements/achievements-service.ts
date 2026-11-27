// Achievements for the whole library (ARCHITECTURE.md §4.10): Steam games from the Steam Web API, ROMs from
// RetroAchievements. A pass after every Steam owned import (sign-in included) and every ROM scan fills each game's
// unlocked / total counts, which the game detail screen shows; a game's full list is fetched when it is opened.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { AchievementsInfo, Game, RetroAchievementsStatus } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
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
  steamAchievementsProgress,
  steamGameAchievements,
  SteamAuthError,
  type SteamCredential,
  type SteamProgress
} from './steam'
import { mainLanguage, tMain } from '../i18n'
import { RECOMP_ACHIEVEMENTS_SOURCE, recompAchievementsFor } from '../../shared/recomp-play'
import type { RecompAchievementsReader } from '../recomp/achievements'

/** A game's list is fetched again after this long. */
const LIVE_TTL_MS = 10 * 60 * 1000
/** RetroAchievements game lists (with hashes) are refreshed weekly; new sets appear slowly. */
const RA_LIST_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * A cached list counts as whole (a ROM missing from it has no achievements) only this fresh: a set published since may
 * have the ROM's hash.
 */
const RA_LIST_WHOLE_MS = 24 * 60 * 60 * 1000
/** A Settings edit settles before the account is checked again. */
const RA_SETTINGS_DELAY_MS = 800
/** The `metadata.sources` key of a ROM's RetroAchievements game id. */
export const RA_SOURCE = 'retroachievements'

export interface AchievementsDeps {
  settings: Pick<SettingsStore, 'get' | 'onChange'>
  library: Pick<LibraryService, 'games' | 'getGame' | 'applyMetadata' | 'clearAchievements'>
  events: Pick<EventBus, 'emit'>
  log: Logger
  /** RetroAchievements' game lists and the ROM hash cache live in `<cacheDir>`. */
  cacheDir: string
}

/** Network calls, injectable for tests. */
export interface AchievementsOptions {
  steamProgress?: typeof steamAchievementsProgress
  steamGame?: typeof steamGameAchievements
  raProfile?: typeof raProfile
  raGameList?: typeof raGameList
  raCompletion?: typeof raCompletionProgress
  raGame?: typeof raGameProgress
  hashRom?: typeof raHashRom
  settingsDelayMs?: number
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
  /** Unlocked / total for every Steam game in the library. */
  syncSteam(): Promise<void>
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

export function createAchievementsService(
  deps: AchievementsDeps,
  options: AchievementsOptions = {}
): AchievementsService {
  const { library, settings, events, log } = deps
  const fetchSteamProgress = options.steamProgress ?? steamAchievementsProgress
  const fetchSteamGame = options.steamGame ?? steamGameAchievements
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

  let steamRun: Promise<void> | null = null
  let steamAgain = false

  async function runSteamSync(): Promise<void> {
    const byApp = new Map<number, string[]>()
    for (const game of library.games()) {
      if (game.source === 'rom') continue
      const appId = steamAppIdOf(game)
      if (!appId) continue
      const ids = byApp.get(appId) ?? []
      ids.push(game.id)
      byApp.set(appId, ids)
    }
    if (!byApp.size) return
    const generation = steamGeneration
    for (const [id, entry] of cache) if (entry.key === 'steam') cache.delete(id)
    let progress: Map<number, SteamProgress> | null
    try {
      progress = await withSteam((credential) => fetchSteamProgress([...byApp.keys()], credential))
    } catch (err) {
      log.warn(`steam: achievements sync failed: ${describeError(err)}`)
      return
    }
    if (!progress || disposed || generation !== steamGeneration) return
    const changed: string[] = []
    let withAchievements = 0
    for (const [appId, ids] of byApp) {
      const p = progress.get(appId)
      if (!p || p.total <= 0) continue
      withAchievements++
      for (const id of ids) if (writeCounts(id, p)) changed.push(id)
    }
    announce(changed)
    log.info(
      `steam: achievements for ${withAchievements} of ${byApp.size} game(s), ${changed.length} changed`
    )
  }

  function syncSteam(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (steamRun) {
      steamAgain = true
      return steamRun
    }
    steamRun = (async () => {
      try {
        do {
          steamAgain = false
          await runSteamSync()
        } while (steamAgain && !disposed)
      } finally {
        steamRun = null
      }
    })()
    return steamRun
  }

  /**
   * The credential the Steam counts were read with went away or changed: fence the work still running for it,
   * take its counts off the cards and read them again with whatever credential is left (none: they stay empty).
   */
  function resetSteam(): void {
    steamGeneration++
    for (const [id, entry] of cache) if (entry.key === 'steam') cache.delete(id)
    const ids = library
      .games()
      .filter((g) => g.source !== 'rom' && steamAppIdOf(g) && g.metadata.achievements)
      .map((g) => g.id)
    announce(library.clearAchievements(ids))
  }

  function steamSignedOut(): void {
    resetSteam()
    // The Settings key may still sign Steam in (for this account or another one): its own counts come back.
    if (keyCredential()) void syncSteam()
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
    const generation = steamGeneration
    const info = await withSteam((credential) => fetchSteamGame(appId, credential))
    if (generation !== steamGeneration) return null
    if (info && writeCounts(game.id, { unlocked: info.unlocked, total: info.total }))
      announce([game.id])
    return info
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

  return {
    useSteamAccount(credential) {
      steamAccount = credential
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
    steamSignedOut,
    syncRetro,
    retroStatus: () => status,
    dispose() {
      disposed = true
      offSettings()
      if (settingsTimer) clearTimeout(settingsTimer)
      if (steamTimer) clearTimeout(steamTimer)
    }
  }
}
