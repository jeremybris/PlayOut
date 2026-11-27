// Install sizes (ARCHITECTURE.md §4.11). An installed game's size comes from its client's own record when there is
// one (Steam's SizeOnDisk, Epic's InstallSize), from the file for a ROM (with the discs a playlist or cue sheet names),
// or from adding up its install folder; a game that is not installed shows the store's disk space requirement
// (Steam's "Storage: 8 GB") as an estimate.
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, parse, resolve } from 'node:path'
import { recompInPlaceOf } from '../../shared/recomp-play'
import type { Game, GameMetadata } from '../../shared/types'
import { parseCueFiles, parseM3u, romGameFolder } from '../emulation/rom-scanner'
import type { Logger } from '../logger'
import {
  describeError,
  loadSteamAppDetails,
  parseSteamReleaseDate,
  steamAppIdOf,
  steamStorageRequirement,
  type SteamAppDetails
} from '../scrapers/steam-store'
import {
  gogInstallSize,
  sameGameKey,
  steamAppIdByTitle,
  steamcmdInstallSize
} from '../scrapers/store-sizes'
import { epicInstallSize, type EpicBuildSize, type EpicGameRef } from '../scrapers/epic-sizes'
import type { EventBus } from '../events'
import { HttpError, RateLimiter } from '../scrapers/http'
import { NO_DIAG, type DiagLog } from '../diag-log'
import type { LibraryService } from './library-service'
import { createSizeCache, type SizeCache } from './size-cache'

/** A folder measurement is redone after this long (a patch, a mod, a DLC); so is a failed one. */
const FOLDER_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * The version of the rules that turn Steam's depots into a size (store-sizes.ts steamInstallBytes). 2: Steam Deck
 * builds and other copies of the game (Black Desert's regional clients) are left out. A Steam size found under older
 * rules is looked up once more, past the size cache (its key carries the version).
 */
export const STEAM_SIZE_RULES = 2

/** A Steam size worked out under older depot rules: looked up again. */
function steamSizeStale(storage: NonNullable<GameMetadata['storage']>): boolean {
  return (
    (storage.how === 'steam' || storage.how === 'steam-match') &&
    (storage.steamRules ?? 1) < STEAM_SIZE_RULES
  )
}

/** The store requirement is checked again after this long. */
const STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** The background pass stops after this many games in a row that no store could answer (offline, rate limited). */
const FILL_GIVE_UP = 5
/** ... and tries again after this long. */
const FILL_RETRY_MS = 15 * 60_000
/** A game whose Epic lookup failed is not asked again before this long (its Steam match stands meanwhile). */
const EPIC_RETRY_MS = 60 * 60_000
/** After this many Epic lookups in a row fail (Epic down, the token refused), Epic is left alone for FILL_RETRY_MS. */
const EPIC_GIVE_UP = 5
/** Epic's part of a game's lookup gives up after this long (the lane's GAME_TIMEOUT_MS leaves room for Steam's). */
const EPIC_STEP_MS = 30_000
/** One ask for the Epic token stands this long (well inside the token's own expiry margin of a minute). */
const EPIC_TOKEN_MEMO_MS = 30_000

/** Epic's figure for a build: bytes undefined = no Windows build; approximate = optional content counted in. */
type EpicAnswer = { bytes: number | undefined; approximate: boolean }
/** A lookup that needs Steam's store, handed from the fast lane to the store lane. */
const DEFERRED = Symbol('deferred')

/** A game the background pass has waited on this long is left behind (logged), so one lookup cannot stall the scan. */
const GAME_TIMEOUT_MS = 60_000
/** A step running longer than this is named in the status line. */
const SLOW_STEP_MS = 20_000
/** The status line's interval while a pass runs. */
const HEARTBEAT_MS = 10_000

/** Store lookups of the background pass in flight. */
const FILL_CONCURRENCY = 4
/** 'install-size:progress' at most this often. */
const PROGRESS_INTERVAL_MS = 500

/** A store size found while another source failed is asked again after this long. */
const PARTIAL_TTL_MS = 24 * 60 * 60 * 1000
/** A folder with more entries than this is not a game install (a drive root, a whole Program Files): no size. */
const MAX_ENTRIES = 400_000
/** A walk that takes longer than this (a sleeping network drive) gives up, so the games behind it are not stuck. */
const WALK_DEADLINE_MS = 3 * 60_000
/** Stats in flight per folder walk: about libuv's thread pool, so other file work in the main process keeps moving. */
const STAT_BATCH = 8
/** Sizes are written to the library this many games at a time, so the panel fills while a big library is measured. */
const WRITE_BATCH = 25

type Size = NonNullable<Game['installSize']>

export interface InstallSizeDeps {
  library: Pick<
    LibraryService,
    'games' | 'getGame' | 'setInstallSizes' | 'applyMetadata' | 'clearInstallSize'
  >
  log: Logger
  /** The local cache of store sizes (size-cache.ts); absent = no cache (and no Steam store pacing: tests). */
  cacheFile?: string
  /** For 'install-size:progress' (the Library header's "sizes N left"). */
  events?: Pick<EventBus, 'emit'>
  /** The diagnostic log (logs/install-size.log): every game, every slow step, a status line every 10 s. */
  trace?: DiagLog
  /**
   * The install folder of a recompilation (main recomp/), by its id: a game whose recompilation stands in for its
   * deleted or moved disc image (shared/recomp-play recompInPlaceOf) is sized by that folder. Absent or null: such a
   * game keeps no size of its own. undefined: not known yet (the recompilations are still loading).
   */
  recompDir?: (recompId: string) => Promise<string | null | undefined>
}

/** Disk and network access, injectable for tests. */
export interface InstallSizeOptions {
  folderSize?: (dir: string) => Promise<number | null>
  /** Size of a ROM path: a file's length (with what a playlist or cue sheet names), a folder's total; null when gone. */
  pathSize?: (path: string) => Promise<{ bytes: number; folder: boolean } | null>
  steamDetails?: (appId: number) => Promise<SteamAppDetails | null>
  /** What Steam would install (api.steamcmd.net). */
  steamInstallSize?: (appId: number) => Promise<number | undefined>
  /** A GOG product's installer size. */
  gogInstallSize?: (productId: string) => Promise<number | undefined>
  /** The Steam app with exactly this title (Steam's store search). */
  steamAppIdByTitle?: (title: string) => Promise<number | undefined>
  /** What the Epic Games Launcher installs (the build manifest), with the signed-in account's access token. */
  epicInstallSize?: (accessToken: string, game: EpicGameRef) => Promise<EpicBuildSize | undefined>
  /** How long Epic's part of a lookup may take (EPIC_STEP_MS; shorter in tests). */
  epicTimeoutMs?: number
}

/** The ids Epic's assets API needs for a game (an Epic game imported from the account or found installed). */
export function epicRefOf(game: Game): EpicGameRef | null {
  if (game.source !== 'epic') return null
  const appName = game.extra?.epicAppName
  const namespace = game.extra?.epicNamespace
  const catalogItemId = game.extra?.epicCatalogItemId
  if (
    typeof appName !== 'string' ||
    typeof namespace !== 'string' ||
    typeof catalogItemId !== 'string'
  )
    return null
  if (!appName || !namespace || !catalogItemId) return null
  return { appName, namespace, catalogItemId }
}

export interface InstallSizeService {
  /** Measure the installed games (all of them when `gameIds` is omitted) in the background, one at a time. */
  measure(gameIds?: string[]): Promise<void>
  /**
   * The game panel opened: an installed game without a current size is measured now; one that is not installed gets
   * the store's storage requirement. Resolves with the game as it is afterwards.
   */
  refresh(gameId: string): Promise<Game | null>
  /**
   * Fill the store size of every game that is not installed (and of installed games that cannot be measured) in the
   * background, one at a time, so the Library can sort and filter by size. Resolves when the pass is done.
   */
  fillStoreSizes(): Promise<void>
  /**
   * The one full scan of a run (at startup): every installed game measured again (a game updated since the last run
   * has a new size) and every game that is not installed looked up again, once each; later scans, imports and panel
   * opens only fill what this run has not done yet.
   */
  scanAll(): Promise<void>
  /**
   * The signed-in Epic account's access token (null when signed out): Epic games are then sized from Epic's own build
   * manifests, exactly, before any Steam match.
   */
  useEpicAccount(accessToken: (refresh?: boolean) => Promise<string | null>): void
  /** Stop the background work and write the size cache. */
  dispose(): Promise<void>
}

/**
 * Total bytes of the files under `dir`, links and junctions not followed; null when the folder is unreadable, holds
 * more than MAX_ENTRIES entries, or takes longer than the deadline to walk.
 */
export async function folderSize(
  dir: string,
  options: { deadlineMs?: number } = {}
): Promise<number | null> {
  const deadline = Date.now() + (options.deadlineMs ?? WALK_DEADLINE_MS)
  let total = 0
  let entries = 0
  const pending = [dir]
  while (pending.length) {
    if (Date.now() > deadline) return null
    const current = pending.pop() as string
    let list
    try {
      list = await readdir(current, { withFileTypes: true })
    } catch {
      if (current === dir) return null
      continue
    }
    entries += list.length
    if (entries > MAX_ENTRIES) return null
    const files: string[] = []
    for (const entry of list) {
      if (entry.isSymbolicLink()) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const sizes = await Promise.all(
        files.slice(i, i + STAT_BATCH).map((p) =>
          lstat(p).then(
            (s) => s.size,
            () => 0
          )
        )
      )
      for (const s of sizes) total += s
    }
  }
  return total
}

const fileBytes = (path: string): Promise<number> =>
  stat(path).then(
    (s) => (s.isFile() ? s.size : 0),
    () => 0
  )

/**
 * A disc game's playlist or cue sheet is a few bytes; the game is the files it names. An .m3u's .cue entries name
 * their own data tracks in turn.
 */
async function sheetBytes(path: string, depth = 0): Promise<number> {
  const ext = extname(path).toLowerCase()
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return 0
  }
  const own = await fileBytes(path)
  const named = ext === '.m3u' ? parseM3u(text, dirname(path)) : parseCueFiles(text, dirname(path))
  let total = own
  for (const file of new Set(named)) {
    const sub = extname(file).toLowerCase()
    total +=
      depth === 0 && (sub === '.cue' || sub === '.m3u')
        ? await sheetBytes(file, 1)
        : await fileBytes(file)
  }
  return total
}

async function defaultPathSize(path: string): Promise<{ bytes: number; folder: boolean } | null> {
  try {
    const info = await stat(path)
    if (info.isFile()) {
      const ext = extname(path).toLowerCase()
      const bytes = ext === '.m3u' || ext === '.cue' ? await sheetBytes(path) : info.size
      return { bytes, folder: false }
    }
    if (!info.isDirectory()) return null
    const bytes = await folderSize(path)
    return bytes === null ? null : { bytes, folder: true }
  } catch {
    return null
  }
}

/**
 * Folders that hold far more than one game: a drive root, the user's own folders, Program Files, Windows and the
 * app-data folders. A manual game whose exe sits in one of them (a game on the Desktop, a tool in System32) has no
 * install folder of its own to add up.
 */
export function isSharedFolder(dir: string): boolean {
  const norm = (p: string): string =>
    resolve(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  const target = norm(dir)
  if (target === norm(parse(resolve(dir)).root)) return true
  const env = process.env
  // Anything inside Windows itself.
  const windows = env['SystemRoot'] ?? env['windir']
  if (windows) {
    const root = norm(windows)
    if (target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`))
      return true
  }
  const home = homedir()
  const shared = [
    home,
    join(home, 'Desktop'),
    join(home, 'Downloads'),
    join(home, 'Documents'),
    join(home, 'OneDrive'),
    join(home, 'OneDrive', 'Desktop'),
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['ProgramW6432'],
    env['ProgramData'],
    env['APPDATA'],
    env['LOCALAPPDATA'],
    env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'Programs') : undefined,
    env['PUBLIC'],
    env['PUBLIC'] ? join(env['PUBLIC'], 'Desktop') : undefined
  ]
  return shared.some((p) => !!p && norm(p) === target)
}

/** A folder with game folders in it (two or more subfolders with an exe of their own), or a Steam library root. */
async function holdsSeveralGames(dir: string): Promise<boolean> {
  const name = dir.replace(/[\\/]+$/, '').toLowerCase()
  if (name.endsWith('steamapps') || /steamapps[\\/]common$/.test(name)) return true
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  let games = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    try {
      const inner = await readdir(join(dir, entry.name))
      if (inner.some((n) => n.toLowerCase().endsWith('.exe')) && ++games >= 2) return true
    } catch {
      // unreadable subfolder: not counted
    }
  }
  return false
}

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/** The size the game's client recorded (Steam, Epic); undefined when it has none. */
function recordedSize(game: Game): number | undefined {
  if (game.source === 'steam') return positive(game.extra?.sizeOnDisk)
  if (game.source === 'epic') return positive(game.extra?.epicInstallSize)
  return undefined
}

/**
 * What is measured for the game: its ROM path (a dumped PS4 game: its whole folder, not the eboot.bin it starts from),
 * or its install folder. A size stored for another path is measured again, so a PS4 game sized by its eboot.bin before
 * is corrected by the next pass.
 */
/**
 * A game this PC can size: an installed game, or one whose recompilation stands in for its disc image (it is played
 * from the recompilation's folder).
 */
function sizable(game: Game | undefined): boolean {
  return !!game && (game.installed || recompInPlaceOf(game) !== null)
}

function measuredPath(game: Game): string | undefined {
  if (game.source !== 'rom') return game.installDir
  return (game.romPath && romGameFolder(game.romPath, game)) || game.romPath
}

/**
 * The title a not-installed game is matched to Steam by (another store's game; never a Steam game, a ROM or a manual
 * game); undefined when it is not matched by title at all.
 */
function matchKeyOf(game: Game): string | undefined {
  if (game.source === 'steam' || game.source === 'rom' || game.source === 'manual') return undefined
  return sameGameKey(game.user.titleOverride?.trim() || game.title) || undefined
}

/** True when measuring needs a walk or a read (anything but the client's own record). */
const needsDisk = (game: Game): boolean => recordedSize(game) === undefined

export function createInstallSizeService(
  deps: InstallSizeDeps,
  options: InstallSizeOptions = {}
): InstallSizeService {
  const { library, log } = deps
  const measureFolder = options.folderSize ?? ((dir: string) => folderSize(dir))
  const measurePath = options.pathSize ?? defaultPathSize
  const steamDetails = options.steamDetails ?? loadSteamAppDetails
  // Every store answer goes through the local cache: a re-import, a second copy or a reset library asks no store.
  // Without a file (tests), no cache at all: every lookup reaches the injected fetchers.
  const cache: SizeCache = deps.cacheFile
    ? createSizeCache(deps.cacheFile, log)
    : { get: (_key, fetch) => fetch(), flush: async () => undefined }
  const rawExact = options.steamInstallSize ?? steamcmdInstallSize
  const rawGog = options.gogInstallSize ?? gogInstallSize
  const rawSearch = options.steamAppIdByTitle ?? steamAppIdByTitle
  const rawEpic = options.epicInstallSize ?? epicInstallSize
  const epicTimeoutMs = options.epicTimeoutMs ?? EPIC_STEP_MS
  let epicToken: (refresh?: boolean) => Promise<string | null> = async () => null
  /** Whether the last ask for the Epic token found one: Epic games then go to the fast lane. */
  let epicSignedIn = false
  /**
   * The answer of the last token ask, kept EPIC_TOKEN_MEMO_MS: a whole pass of Epic games asks once, and a refresh
   * that keeps failing (Epic's account service down) is not retried for every game.
   */
  let tokenMemo: { at: number; value: Promise<string | null> } | null = null
  function epicTokenNow(refresh = false): Promise<string | null> {
    if (!refresh && tokenMemo && Date.now() - tokenMemo.at < EPIC_TOKEN_MEMO_MS)
      return tokenMemo.value
    const value = (async (): Promise<string | null> => {
      let token: string | null = null
      try {
        token = await epicToken(refresh)
      } catch (err) {
        log.debug(`epic token failed: ${describeError(err)}`)
      }
      epicSignedIn = !!token
      return token
    })()
    tokenMemo = { at: Date.now(), value }
    return value
  }
  /** Games whose Epic lookup failed this run, and when Epic may be asked about them again. */
  const epicRetryAt = new Map<string, number>()
  /** Epic lookups that failed in a row: at EPIC_GIVE_UP, Epic is left alone until `epicPausedUntil`. */
  let epicFailsInRow = 0
  let epicPausedUntil = 0
  // Steam's store (search, appdetails) allows about 200 calls per 5 minutes per IP and the metadata scraper uses it
  // too: the size lookups that need it go one at a time, 2.5 s apart. api.steamcmd.net and GOG have their own,
  // faster limiters (store-sizes.ts).
  const storeGate = deps.cacheFile ? new RateLimiter(0.4, 1) : null
  const viaStore = async <T>(fn: () => Promise<T>): Promise<T> => {
    await storeGate?.take()
    return fn()
  }
  /** scanAll ran this session (one start-up scan per run). */
  let scannedAll = false
  const steamExact = (appId: number): Promise<number | undefined> =>
    cache.get(`steam:v${STEAM_SIZE_RULES}:${appId}`, () => rawExact(appId))
  const gogSize = (productId: string): Promise<number | undefined> =>
    cache.get(`gog:${productId}`, () => rawGog(productId))
  /** A build's size, and whether optional (tagged) content makes it an upper bound: two cache entries, one fetch. */
  async function epicSize(token: string, ref: EpicGameRef): Promise<EpicAnswer> {
    let optional: number | undefined
    const bytes = await cache.get(`epic:${ref.appName}`, async () => {
      const found = await rawEpic(token, ref)
      optional = found?.optional
      return found?.bytes
    })
    const extra = await cache.get(`epic-optional:${ref.appName}`, async () => optional ?? 0)
    return { bytes, approximate: !!extra }
  }
  /**
   * Epic's answer for this game is on record: a size found is kept, an answer of "none" (no Windows build) stands
   * for a month, like the other stores' "none".
   */
  const epicAnswered = (game: Game): boolean => {
    const storage = game.metadata.storage
    if (!storage?.epicChecked) return false
    return storage.how === 'epic' || Date.now() - Date.parse(storage.checkedAt) < STORAGE_TTL_MS
  }
  /** Epic should be asked about this game now (it failed recently, or Epic is not answering: not yet). */
  const epicDue = (game: Game): boolean =>
    !!epicRefOf(game) &&
    !epicAnswered(game) &&
    (epicRetryAt.get(game.id) ?? 0) <= Date.now() &&
    epicPausedUntil <= Date.now()
  /**
   * Epic's figure for a game (bytes undefined: no Windows build); 'failed' when Epic could not answer in time (the
   * game is then left alone for EPIC_RETRY_MS, and a run of failures pauses Epic); null when signed out of Epic.
   */
  async function askEpic(game: Game, ref: EpicGameRef): Promise<EpicAnswer | 'failed' | null> {
    step(game.id, 'epic')
    const failed = (err: unknown): 'failed' => {
      log.debug(`epic size of ${game.id} failed: ${describeError(err)}`)
      trace.line(`${game.id} "${game.title}": epic failed: ${describeError(err)}`)
      // The Steam match still gives the game a size meanwhile.
      epicRetryAt.set(game.id, Date.now() + EPIC_RETRY_MS)
      if (++epicFailsInRow >= EPIC_GIVE_UP) {
        epicPausedUntil = Date.now() + FILL_RETRY_MS
        epicFailsInRow = 0
        trace.line(`epic: ${EPIC_GIVE_UP} lookups failed in a row; Epic left alone for 15 min`)
      }
      return 'failed'
    }
    // The token (a refresh, when it is about to expire) counts toward Epic's budget too.
    const lookup = (async (): Promise<EpicAnswer | null> => {
      const token = await epicTokenNow()
      if (!token) return null
      try {
        return await epicSize(token, ref)
      } catch (err) {
        // Epic refused the token before it expired (revoked, signed out elsewhere): one refresh, one more try.
        if (!(err instanceof HttpError && err.status === 401)) throw err
        const fresh = await epicTokenNow(true)
        if (!fresh)
          throw new Error('Epic refused the sign-in and it could not be renewed', { cause: err })
        return await epicSize(fresh, ref)
      }
    })()
    // Epic's step has its own budget, well inside the lane's minute per game: a silent Epic is an Epic failure (and
    // the Steam match goes on), never a timed-out game that counts toward stopping the lane.
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), epicTimeoutMs)
      timer.unref?.()
    })
    try {
      const answer = await Promise.race([lookup, timeout])
      if (answer === 'timeout') {
        lookup.catch(() => undefined)
        return failed(new Error(`no answer within ${epicTimeoutMs / 1000} s`))
      }
      // Signed out: not an Epic failure.
      if (answer === null) return null
      epicFailsInRow = 0
      epicRetryAt.delete(game.id)
      return answer
    } catch (err) {
      return failed(err)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  /** An Epic game whose own manifest was not asked yet while signed in (its size so far, if any, is a Steam match). */
  const wantsEpic = (game: Game): boolean => epicSignedIn && epicDue(game)
  /** Games the fast lane asked Epic about before handing them to the store lane: not asked twice. */
  const epicAsked = new Set<string>()
  // Title matches and requirements do not change with an update: the month-long cache stands.
  const steamSearch = (title: string): Promise<number | undefined> =>
    cache.get(`search:${sameGameKey(title)}`, () => viaStore(() => rawSearch(title)))
  const steamRequirement = (appId: number): Promise<number | undefined> =>
    cache.get(`req:${appId}`, () =>
      viaStore(async () => {
        const details: SteamAppDetails | null = await steamDetails(appId)
        return details ? steamStorageRequirement(details) : undefined
      })
    )
  let disposed = false
  const trace = deps.trace ?? NO_DIAG

  // What each game in flight is doing (a lookup, a folder walk), for the status line and the slow-step report.
  const inflight = new Map<
    string,
    { title: string; step: string; since: number; started: number }
  >()
  const begin = (game: Game): void => {
    const now = Date.now()
    inflight.set(game.id, { title: game.title, step: 'start', since: now, started: now })
  }
  const step = (gameId: string, what: string): void => {
    const entry = inflight.get(gameId)
    if (entry) {
      entry.step = what
      entry.since = Date.now()
    }
  }
  const end = (gameId: string, result: string): void => {
    const entry = inflight.get(gameId)
    inflight.delete(gameId)
    if (entry)
      trace.line(`${gameId} "${entry.title}": ${result} (${Date.now() - entry.started} ms)`)
  }
  const describeSize = (bytes: number | undefined): string =>
    bytes === undefined ? 'no size' : `${(bytes / 1024 ** 3).toFixed(2)} GB`

  // A status line every HEARTBEAT_MS while anything runs: the counts, and every step that has taken too long.
  let heartbeat: NodeJS.Timeout | null = null
  const startHeartbeat = (): void => {
    if (heartbeat) return
    heartbeat = setInterval(() => {
      const measuring = counts.measure.total
        ? ` measure ${counts.measure.done}/${counts.measure.total}`
        : ''
      const looking = counts.fill.total ? ` lookups ${counts.fill.done}/${counts.fill.total}` : ''
      const now = Date.now()
      const slow = [...inflight.entries()]
        .filter(([, e]) => now - e.since >= SLOW_STEP_MS)
        .map(
          ([id, e]) => `${id} "${e.title}" ${e.step} for ${Math.round((now - e.since) / 1000)} s`
        )
      trace.line(
        `status:${measuring}${looking}, ${inflight.size} in flight${slow.length ? `; slow: ${slow.join('; ')}` : ''}`
      )
      if (!running && !filling && heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  /**
   * The stored size still describes the game: the client's current record, or a measurement of the same path. A found
   * size is kept for good (measured again only when the game moves or is installed anew); a folder that could not be
   * added up is tried again weekly.
   */
  function current(game: Game): boolean {
    const size = game.installSize
    if (!size) return false
    // Played from its recompilation: its folder's measure stands (a panel open checks the folder is still there).
    if (recompInPlaceOf(game))
      return (
        size.how === 'folder' &&
        (!size.unmeasurable || Date.now() - Date.parse(size.measuredAt) < FOLDER_TTL_MS)
      )
    const recorded = recordedSize(game)
    if (recorded !== undefined) return size.how === 'store' && size.bytes === recorded
    if (size.how === 'store' || size.path !== measuredPath(game)) return false
    return !size.unmeasurable || Date.now() - Date.parse(size.measuredAt) < FOLDER_TTL_MS
  }

  /**
   * The game's size now; null when it is not installed or has nothing at all to measure. A game whose folder cannot
   * be added up (a shared folder, too many files, unreadable) gets an `unmeasurable` entry, tried again in a week.
   */
  /** One measurement per game at a time: the pass and a panel open (or the store lane) share it. */
  const sizing = new Map<string, Promise<Size | null>>()
  function sizeOf(game: Game): Promise<Size | null> {
    const running = sizing.get(game.id)
    if (running) return running
    const task = measureGame(game).finally(() => sizing.delete(game.id))
    sizing.set(game.id, task)
    return task
  }

  async function measureGame(game: Game): Promise<Size | null> {
    // A recompilation standing in for the game: the recompilation's folder is what it takes on disk now.
    const recompId = recompInPlaceOf(game)
    if (recompId) return measureRecomp(game, recompId)
    if (!game.installed) return null
    if (current(game)) return game.installSize ?? null
    const measuredAt = new Date().toISOString()
    const recorded = recordedSize(game)
    if (recorded) return { bytes: recorded, how: 'store', path: game.installDir, measuredAt }
    const path = measuredPath(game)
    if (!path) return null
    step(game.id, `walk ${path}`)
    // The bar names this game while it is measured, wherever the measuring was started from (a pass, a panel open).
    walking.set(game.id, game.title)
    report(true)
    try {
      const unmeasurable: Size = { bytes: 0, how: 'folder', path, measuredAt, unmeasurable: true }
      if (game.source === 'rom') {
        const found = await measurePath(path)
        if (!found) return unmeasurable
        return { bytes: found.bytes, how: found.folder ? 'folder' : 'file', path, measuredAt }
      }
      if (isSharedFolder(path)) return unmeasurable
      // A manual game's folder is its exe's folder, which can be a whole games folder: adding that up is not its size.
      if (game.source === 'manual' && (await holdsSeveralGames(path))) return unmeasurable
      const bytes = await measureFolder(path)
      return bytes === null ? unmeasurable : { bytes, how: 'folder', path, measuredAt }
    } finally {
      walking.delete(game.id)
      report(true)
    }
  }

  /** The size of a game played from its recompilation: that recompilation's install folder, kept until it moves. */
  async function measureRecomp(game: Game, recompId: string): Promise<Size | null> {
    const path = deps.recompDir ? await deps.recompDir(recompId).catch(() => undefined) : undefined
    if (path === undefined) return null
    if (path === null) {
      // The recompilation is gone (deleted): its folder's size no longer describes the game. The disc image's last
      // size (romRemoved) is shown again.
      if (game.installSize?.how === 'folder') library.clearInstallSize(game.id)
      return null
    }
    const size = game.installSize
    if (
      size &&
      size.how === 'folder' &&
      size.path === path &&
      (!size.unmeasurable || Date.now() - Date.parse(size.measuredAt) < FOLDER_TTL_MS)
    )
      return size
    const measuredAt = new Date().toISOString()
    step(game.id, `walk ${path} (recompilation)`)
    walking.set(game.id, game.title)
    report(true)
    try {
      const found = await measurePath(path)
      if (!found) return { bytes: 0, how: 'folder', path, measuredAt, unmeasurable: true }
      return { bytes: found.bytes, how: 'folder', path, measuredAt }
    } finally {
      walking.delete(game.id)
      report(true)
    }
  }

  /** Games of the running measure / lookup pass, for 'install-size:progress'. */
  const counts = { measure: { done: 0, total: 0 }, fill: { done: 0, total: 0 } }

  // One pass at a time; ids asked for while it runs join the next one.
  let running: Promise<void> | null = null
  let queued: Set<string> | 'all' | null = null

  async function pass(ids: Set<string> | 'all'): Promise<void> {
    const games = library.games().filter((g) => sizable(g) && (ids === 'all' || ids.has(g.id)))
    // The client records first (instant, batched), then the walks, each written as soon as it is done: a 150 GB
    // modded install must not hold back the sizes of the games behind it.
    const records = games.filter((g) => !needsDisk(g))
    const ordered = [...records, ...games.filter(needsDisk)]
    let batch: { id: string; size: Size }[] = []
    const flush = (): void => {
      if (batch.length) library.setInstallSizes(batch)
      batch = []
    }
    let measured = 0
    // Only games without a current size count on the bar (new, moved, or never measured): a library whose sizes are all
    // known shows no bar at all.
    const work = new Set(ordered.filter((g) => !current(g)).map((g) => g.id))
    let worked = 0
    counts.measure = { done: 0, total: work.size }
    if (work.size) report(true)
    trace.line(`measure: ${ordered.length} installed game(s), ${work.size} without a current size`)
    startHeartbeat()
    try {
      for (const [index, game] of ordered.entries()) {
        if (work.has(game.id)) {
          counts.measure.done = worked++
          report()
        }
        if (disposed) return
        // The records are on the cards before the first walk starts.
        if (index === records.length) flush()
        let size: Size | null
        begin(game)
        try {
          size = await sizeOf(game)
        } catch (err) {
          log.debug(`install size of ${game.id} failed: ${describeError(err)}`)
          end(game.id, `measure error: ${describeError(err)}`)
          continue
        }
        // Client records are instant and many: only the folder walks are logged one by one.
        if (needsDisk(game) && work.has(game.id))
          end(
            game.id,
            size?.unmeasurable
              ? 'folder could not be measured'
              : `measured ${describeSize(size?.bytes)}`
          )
        else inflight.delete(game.id)
        // Uninstalled or removed while the folder was being walked.
        if (!size || !sizable(library.getGame(game.id))) continue
        batch.push({ id: game.id, size })
        if (!size.unmeasurable) measured++
        if (needsDisk(game) || batch.length >= WRITE_BATCH) flush()
      }
      flush()
    } finally {
      counts.measure = { done: 0, total: 0 }
      report(true)
    }
    log.info(`install sizes: ${measured} of ${games.length} installed game(s)`)
    trace.line(`measure done: ${measured} of ${games.length} installed game(s) have a size`)
  }

  function measure(gameIds?: string[]): Promise<void> {
    if (disposed) return Promise.resolve()
    const wanted: Set<string> | 'all' = gameIds ? new Set(gameIds) : 'all'
    if (running) {
      if (wanted === 'all' || queued === 'all') queued = 'all'
      else queued = new Set([...(queued ?? []), ...wanted])
      return running
    }
    running = (async () => {
      try {
        let next: Set<string> | 'all' | null = wanted
        while (next && !disposed) {
          queued = null
          await pass(next)
          next = queued
        }
      } finally {
        running = null
      }
    })()
    return running
  }

  const refreshing = new Map<string, Promise<Game | null>>()
  /** What the fast lane already learned about the games it handed to the store lane. */
  const handedOver = new Map<string, { answered: boolean; failed: boolean }>()

  /**
   * `storeOk` false: the fast lane, which must never wait on Steam's store (2.5 s a call): a game that needs the store
   * (a title search, a release year, the storage requirement) comes back DEFERRED for the store lane.
   */
  async function refreshOne(
    gameId: string,
    opts: { storeOk: boolean } = { storeOk: true }
  ): Promise<Game | null | typeof DEFERRED> {
    const game = library.getGame(gameId)
    if (!game) return null
    if (recompInPlaceOf(game)) {
      // Played from its recompilation: that folder's size (no store figure: the recompilation is not the store's game).
      const size = await sizeOf(game).catch(() => null)
      if (size && sizable(library.getGame(gameId))) library.setInstallSizes([{ id: gameId, size }])
      return library.getGame(gameId) ?? null
    }
    if (game.installed) {
      // Installed since the last measurement, moved, or updated by its client: measured again.
      if (!current(game)) {
        const size = await sizeOf(game).catch(() => null)
        if (size && library.getGame(gameId)?.installed)
          library.setInstallSizes([{ id: gameId, size }])
      }
      const after = library.getGame(gameId)
      // A folder that cannot be added up still gets the store's figure, like a game that is not installed.
      if (!after?.installSize?.unmeasurable) return after ?? null
      return storageFor(after, opts)
    }
    return storageFor(game, opts)
  }

  /** The store's size of the game in metadata.storage, unless it was checked within the month. */
  async function storageFor(
    game: Game,
    opts: { storeOk: boolean } = { storeOk: true }
  ): Promise<Game | null | typeof DEFERRED> {
    const gameId = game.id
    const storage = game.metadata.storage
    // A partial answer (a source failed) is asked again the next day; a title change asks again at once, because the
    // Steam match was made by title.
    const ttl = storage?.partial ? PARTIAL_TTL_MS : STORAGE_TTL_MS
    const sameTitle = !storage?.matchKey || storage.matchKey === matchKeyOf(game)
    // A panel opened before any pass: whether Epic is signed in is not known yet (an Epic game only).
    if (!epicSignedIn && epicDue(game)) await epicTokenNow()
    // A size found is kept for good (a title change aside); a check that found none is tried again after its TTL.
    if (
      storage &&
      sameTitle &&
      !wantsEpic(game) &&
      !steamSizeStale(storage) &&
      (storage.bytes || Date.now() - Date.parse(storage.checkedAt) < ttl)
    )
      return game
    let found: Omit<NonNullable<GameMetadata['storage']>, 'checkedAt'> | null | typeof DEFERRED
    // An Epic game, signed in to Epic: what the Launcher installs, read from the game's build manifest (exact).
    const ref = epicRefOf(game)
    const askedBefore = epicAsked.delete(gameId)
    let epicChecked = askedBefore || epicAnswered(game)
    let fromEpic: EpicAnswer | undefined
    if (ref && !epicChecked && epicDue(game)) {
      const answer = await askEpic(game, ref)
      if (answer && answer !== 'failed') {
        fromEpic = answer
        epicChecked = true
      }
    }
    if (fromEpic?.bytes)
      found = {
        bytes: fromEpic.bytes,
        how: 'epic',
        epicChecked: true,
        ...(fromEpic.approximate ? { approximate: true as const } : {})
      }
    else if (storage?.bytes && sameTitle && !steamSizeStale(storage)) {
      // A game re-checked only for Epic's figure (it has a size already): Epic gave none, so the size it has stands.
      // The Steam lookup is not redone, where a passing failure could swap an exact match for an estimate.
      if (!epicChecked) return game
      found = { ...storage, epicChecked: true }
    } else if (storage?.bytes && sameTitle && steamSizeStale(storage)) {
      // An exact Steam size from older depot rules: worked out again from Steam's depots only. A failed lookup keeps
      // the size it has (not recorded, so it is tried again), never the store page's estimate in its place.
      const fresh = await restaleSteamSize(game, storage)
      if (!fresh) return game
      found = epicChecked ? { ...fresh, epicChecked: true } : fresh
    } else {
      found = await storeSize(game, opts)
      if (found === DEFERRED) {
        // The store lane finishes it without asking Epic again.
        if (epicChecked) epicAsked.add(gameId)
        return DEFERRED
      }
      // Epic has no Windows build of it (or no size): a Steam match stands, and Epic is not asked again this month.
      if (found && epicChecked) found = { ...found, epicChecked: true }
    }
    // Every source failed (offline, rate limited): not recorded, so the next open asks again.
    if (found === null) return game
    const latest = library.getGame(gameId)
    if (!latest) return null
    // The same answer as last time (the full scan re-asks every game): written quietly, no library:changed for the
    // renderer to refetch thousands of unchanged games.
    const before = latest.metadata.storage
    const same =
      !!before &&
      before.bytes === found.bytes &&
      before.how === found.how &&
      before.steamAppId === found.steamAppId &&
      before.partial === found.partial &&
      before.matchKey === found.matchKey &&
      before.epicChecked === found.epicChecked &&
      before.approximate === found.approximate
    return library.applyMetadata(
      gameId,
      { metadata: { storage: { ...found, checkedAt: new Date().toISOString() } } },
      { overwrite: true, quiet: same }
    )
  }

  /**
   * A Steam size worked out by older depot rules, worked out again by the current ones from the same Steam app. The
   * stored record with the new size (or the same one, when Steam lists no size now) and the current rules; null when
   * the lookup failed or there is no app to ask, so the stored size stands and is tried again later.
   */
  async function restaleSteamSize(
    game: Game,
    storage: NonNullable<GameMetadata['storage']>
  ): Promise<Omit<NonNullable<GameMetadata['storage']>, 'checkedAt'> | null> {
    const appId = storage.how === 'steam-match' ? storage.steamAppId : steamAppIdOf(game)
    if (!appId) return null
    let exact: number | undefined
    try {
      step(game.id, 'steam')
      exact = await steamExact(appId)
    } catch (err) {
      log.debug(`steam size of ${game.id} (older rules) failed: ${describeError(err)}`)
      trace.line(`${game.id} "${game.title}": steam (older rules) failed: ${describeError(err)}`)
      return null
    }
    const { checkedAt: _checked, ...rest } = storage
    void _checked
    return { ...rest, ...(exact ? { bytes: exact } : {}), steamRules: STEAM_SIZE_RULES }
  }

  /**
   * A not-installed game's size from its store: what Steam would install, else the GOG installer, else Steam's disk
   * space requirement. `{}` when the stores answered with none; null when none of them could be reached.
   */
  async function storeSize(
    game: Game,
    opts: { storeOk: boolean } = { storeOk: true }
  ): Promise<Omit<NonNullable<GameMetadata['storage']>, 'checkedAt'> | null | typeof DEFERRED> {
    // A game the fast lane handed over: its steamcmd / GOG answers are known (and failed or empty); not asked twice.
    const carried = opts.storeOk ? handedOver.get(game.id) : undefined
    if (carried) handedOver.delete(game.id)
    let answered = carried?.answered ?? false
    let failed = carried?.failed ?? false
    const defer = (): typeof DEFERRED => {
      handedOver.set(game.id, { answered, failed })
      return DEFERRED
    }
    const attempt = async (
      what: string,
      fn: () => Promise<number | undefined>
    ): Promise<number | undefined> => {
      try {
        step(game.id, what)
        const bytes = await fn()
        answered = true
        return bytes
      } catch (err) {
        log.debug(`${what} size of ${game.id} failed: ${describeError(err)}`)
        trace.line(`${game.id} "${game.title}": ${what} failed: ${describeError(err)}`)
        failed = true
        return undefined
      }
    }
    // The game's own Steam app (a Steam game, or one the scrapers matched to Steam): what Steam installs.
    const own = steamAppIdOf(game)
    if (own && !carried) {
      const exact = await attempt('steam', () => steamExact(own))
      if (exact) return { bytes: exact, how: 'steam', steamRules: STEAM_SIZE_RULES }
    }
    const gogId =
      game.source === 'gog' ? String(game.extra?.gogProductId ?? game.externalId) : undefined
    if (gogId && !carried) {
      const installer = await attempt('gog', () => gogSize(gogId))
      if (installer) return { bytes: installer, how: 'gog' }
    }
    // Another store's game with no size of its own: the same game on Steam (a Steam copy in the library, else the
    // Steam game with exactly this title) is about the same install.
    // Manual games are titled from exe and folder names, which match unrelated Steam games too easily.
    let matched: number | undefined
    const matchKey = matchKeyOf(game)
    if (!own && matchKey) {
      const title = game.user.titleOverride?.trim() || game.title
      const copies = library
        .games()
        .filter(
          (g) => g.source === 'steam' && g.id !== game.id && sameGameKey(g.title) === matchKey
        )
      // Two Steam games of that name in the library (a remake and its original): neither is known to be this one.
      if (copies.length === 1) matched = steamAppIdOf(copies[0]) ?? undefined
      else if (copies.length === 0) {
        if (!opts.storeOk) return defer()
        matched = await attempt('steam match', () => steamSearch(title))
      }
      // A remake can be the only Steam game of that name ("Dead Space" 2023 for the 2008 game): when both release
      // years are known they must agree, give or take a year.
      const year = Number(game.metadata.releaseDate?.slice(0, 4))
      if (matched && year > 0) {
        if (!opts.storeOk) return defer()
        const appId = matched
        let steamYear: number | undefined
        try {
          // Cached like the sizes: a re-run of the pass does not ask the store for every year again.
          steamYear = await cache.get(`year:${appId}`, () =>
            viaStore(async () => {
              const details = await steamDetails(appId)
              return (
                Number(parseSteamReleaseDate(details?.release_date?.date)?.slice(0, 4)) || undefined
              )
            })
          )
        } catch (err) {
          log.debug(`steam release year of ${appId} failed: ${describeError(err)}`)
        }
        if (steamYear && Math.abs(steamYear - year) > 1) matched = undefined
      }
      if (matched) {
        const appId = matched
        const exact = await attempt('steam', () => steamExact(appId))
        if (exact)
          return {
            bytes: exact,
            how: 'steam-match',
            steamAppId: appId,
            matchKey,
            steamRules: STEAM_SIZE_RULES
          }
      }
    }
    const partial = (): { partial?: true; matchKey?: string } => ({
      ...(failed ? { partial: true as const } : {}),
      ...(matchKey ? { matchKey } : {})
    })
    const required = own ?? matched
    if (required) {
      if (!opts.storeOk) return defer()
      const bytes = await attempt('steam requirement', () => steamRequirement(required))
      if (bytes)
        return { bytes, how: 'requirement', ...(own ? {} : { steamAppId: required }), ...partial() }
    }
    if (game.source === 'rom') return {}
    // Not recorded only when every source asked threw; nothing to ask, or an answer of "none", is recorded.
    return failed && !answered ? null : partial()
  }

  function refresh(gameId: string): Promise<Game | null> {
    const existing = refreshing.get(gameId)
    if (existing) return existing
    // With the store allowed (the default), nothing is deferred: a game or null.
    const task = refreshOne(gameId)
      .then((game) => (game === DEFERRED ? null : game))
      .finally(() => refreshing.delete(gameId))
    refreshing.set(gameId, task)
    return task
  }

  /** Not installed (or not measurable) and no store size checked within its TTL: the background pass's work. */
  function needsStoreSize(game: Game): boolean {
    if (game.installed && !game.installSize?.unmeasurable) return false
    if (game.source === 'rom' || game.source === 'manual') return false
    const storage = game.metadata.storage
    if (!storage) return true
    if (storage.matchKey && storage.matchKey !== matchKeyOf(game)) return true
    // A Steam size from older depot rules (Black Desert counted nine copies of its client).
    if (steamSizeStale(storage)) return true
    // An Epic game, signed in: its exact size from Epic replaces a Steam match, once.
    if (wantsEpic(game)) return true
    // Found once, kept: only the games still without a size are looked up again (after their TTL).
    if (storage.bytes) return false
    const ttl = storage.partial ? PARTIAL_TTL_MS : STORAGE_TTL_MS
    return Date.now() - Date.parse(storage.checkedAt) >= ttl
  }

  let filling: Promise<void> | null = null
  let fillAgain = false

  /** Whether the last pass gave up (offline, rate limited): its retry is already scheduled. */
  let retryTimer: NodeJS.Timeout | null = null

  /**
   * One report for both passes (the measuring of installed games and the lookups of the others): the bottom bar and
   * the Library header show their sum. Throttled, except the first and last report of a pass.
   */
  let lastProgress = 0
  let paused = false
  /** Folders being added up right now, by game id (a big one takes a while): the latest is named on the bar. */
  const walking = new Map<string, string>()
  const measuringName = (): string | undefined => [...walking.values()].at(-1)
  function report(force = false): void {
    const now = Date.now()
    if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) return
    lastProgress = now
    const done = counts.measure.done + counts.fill.done
    const total = counts.measure.total + counts.fill.total
    if (!disposed)
      deps.events?.emit('install-size:progress', {
        remaining: total - done,
        done,
        total,
        ...(paused ? { paused: true } : {}),
        ...(walking.size && total > done ? { current: measuringName() } : {})
      })
  }

  /** Answered by api.steamcmd.net or GOG alone (an own Steam app or a GOG game); the rest need Steam's store. */
  const fastLane = (game: Game): boolean =>
    steamAppIdOf(game) !== null ||
    wantsEpic(game) ||
    (game.source === 'gog' && !!(game.extra?.gogProductId ?? game.externalId))

  /** Resolves false when a lane gave up after FILL_GIVE_UP games in a row could not be looked up. */
  async function fillPass(): Promise<boolean> {
    // Games without any size first: they are the ones missing from the Size filter and sort. Re-checks of known sizes
    // (the full scan) follow.
    // Signed in to Epic or not decides which Epic games are asked again and which lane they go to.
    await epicTokenNow()
    const all = library.games().filter(needsStoreSize)
    if (!all.length) return true
    const unknown = (g: Game): number => (g.metadata.storage?.bytes ? 1 : 0)
    const ordered = all
      .map((game, index) => ({ game, index }))
      .sort((a, b) => unknown(a.game) - unknown(b.game) || a.index - b.index)
      .map((entry) => entry.game)
    log.info(`install sizes: looking up ${ordered.length} game(s) that are not installed`)
    let found = 0
    let done = 0
    paused = false
    counts.fill = { done: 0, total: ordered.length }
    report(true)
    trace.line(
      `lookups: ${ordered.length} game(s) that are not installed, ${ordered.filter((g) => !g.metadata.storage?.bytes).length} without any size yet`
    )
    startHeartbeat()

    // Two lanes. The fast lane asks api.steamcmd.net and GOG only, FILL_CONCURRENCY at a time; a game that needs
    // Steam's store (no steamcmd size, a title match, a release year, the storage requirement) moves to the store lane,
    // which goes one game at a time behind the store's pacing. A slow store never holds up the fast lane.
    const storeQueue: Game[] = ordered.filter((g) => !fastLane(g))
    let fastFinished = false
    const lane = async (
      queue: Game[],
      workers: number,
      storeOk: boolean,
      waitForMore: () => boolean
    ): Promise<boolean> => {
      let failedInRow = 0
      let stop = false
      const worker = async (): Promise<void> => {
        while (!disposed && !stop) {
          const game = queue.shift()
          if (!game) {
            // The store lane keeps going while the fast lane may still hand it games.
            if (!waitForMore()) break
            await new Promise((resolve) => setTimeout(resolve, 200))
            continue
          }
          const current = library.getGame(game.id)
          if (current && needsStoreSize(current)) {
            if (storeOk) {
              if (inflight.has(game.id)) step(game.id, 'store lane')
              else begin(current)
            } else begin(current)
            try {
              // One game cannot hold up the rest: past GAME_TIMEOUT_MS the worker moves on (the lookup may still
              // land later) and the log names the step it was stuck in.
              let timer: NodeJS.Timeout | null = null
              const timeout = new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), GAME_TIMEOUT_MS)
                timer.unref?.()
              })
              const after = await Promise.race([
                storeOk ? refresh(game.id) : refreshOne(game.id, { storeOk: false }),
                timeout
              ])
              if (timer) clearTimeout(timer)
              if (after === DEFERRED) {
                // Needs Steam's store: the store lane finishes it; it is counted there.
                step(game.id, 'waiting for the store lane')
                storeQueue.push(game)
                continue
              }
              if (after === 'timeout') {
                const stuck = inflight.get(game.id)?.step ?? 'unknown step'
                end(game.id, `gave up after ${GAME_TIMEOUT_MS / 1000} s, stuck in: ${stuck}`)
                failedInRow++
              } else {
                const bytes = after?.metadata.storage?.bytes
                if (bytes) found++
                // Nothing recorded: every store it asked failed.
                const failedNow = !!after && needsStoreSize(after)
                failedInRow = failedNow ? failedInRow + 1 : 0
                end(
                  game.id,
                  failedNow
                    ? 'every store failed'
                    : `${describeSize(bytes)}${after?.metadata.storage?.how ? ` (${after.metadata.storage.how})` : ''}`
                )
              }
            } catch (err) {
              log.debug(`install size of ${game.id} failed: ${describeError(err)}`)
              end(game.id, `error: ${describeError(err)}`)
              failedInRow++
            }
            if (failedInRow >= FILL_GIVE_UP) stop = true
          }
          done++
          counts.fill.done = done
          report()
          // Answers from the cache take no time: let the event loop breathe between them.
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
      await Promise.all(Array.from({ length: workers }, worker))
      return !stop
    }
    const fastQueue = ordered.filter(fastLane)
    const [fastOk, slowOk] = await Promise.all([
      lane(fastQueue, FILL_CONCURRENCY, false, () => false).finally(() => {
        fastFinished = true
      }),
      lane(storeQueue, 1, true, () => !fastFinished)
    ])
    const gaveUp = !fastOk || !slowOk
    if (gaveUp) {
      // The count stays up while the retry waits: those games still have no fresh size.
      const left = library.games().filter(needsStoreSize).length
      paused = true
      counts.fill = { done: 0, total: left }
      report(true)
      log.info(
        `install sizes: the stores are not answering; trying again in ${FILL_RETRY_MS / 60_000} min`
      )
      trace.line(
        `lookups paused: ${left} game(s) left; the stores are not answering; retry in 15 min`
      )
      return false
    }
    counts.fill = { done: 0, total: 0 }
    report(true)
    log.info(
      `install sizes: ${found} of ${ordered.length} game(s) that are not installed have a size`
    )
    trace.line(`lookups done: ${found} of ${ordered.length} game(s) have a size`)
    return true
  }

  function fillStoreSizes(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (filling) {
      fillAgain = true
      return filling
    }
    filling = (async () => {
      try {
        let finished = true
        do {
          fillAgain = false
          finished = await fillPass()
        } while (finished && fillAgain && !disposed)
        // Gave up: one retry later, not an immediate re-run over the same failing games.
        if (!finished && !disposed && !retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null
            void fillStoreSizes()
          }, FILL_RETRY_MS)
          retryTimer.unref?.()
        }
      } finally {
        filling = null
      }
    })()
    return filling
  }

  /** The start-up scan: only what has no size yet (new games, moved installs, earlier failures). */
  function scanAll(): Promise<void> {
    if (scannedAll || disposed) return Promise.resolve()
    scannedAll = true
    void measure()
    return fillStoreSizes()
  }

  return {
    measure,
    refresh,
    fillStoreSizes,
    scanAll,
    useEpicAccount(accessToken) {
      epicToken = accessToken
    },
    async dispose() {
      disposed = true
      if (heartbeat) clearInterval(heartbeat)
      if (retryTimer) clearTimeout(retryTimer)
      await cache.flush()
    }
  }
}
