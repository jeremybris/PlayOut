// Steam provider: locates the client through the registry, enumerates every library's appmanifest_*.acf, reads play
// time from the active user's localconfig.vdf and picks up Steam's own cached artwork.
// Recipes: docs/research/playnite-stores.md §4.1 and docs/research/metadata-apis.md §5.4.
import { promises as fs, type Dirent } from 'fs'
import { basename, dirname, join } from 'path'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { ClientInfo, ScannedGame } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { readRegistryKey, type RegistryValue } from '../system/registry'
import { isDirectory, isFile, listDir, readTextIfExists, statSafe } from '../util/fs'
import { knownFolders, normalizePath } from '../util/paths'
import { parseVdf, vdfGet, vdfNumber, vdfString, type VdfObject, type VdfValue } from '../util/vdf'
import type { GameProvider, ScanContext } from './types'
import { tMain } from '../i18n'

const log = createLogger('steam')

/** steamid64 = STEAM_ID64_BASE + accountid. The 64-bit ids do not fit a double, hence BigInt. */
const STEAM_ID64_BASE = BigInt('76561197960265728')
/** AppState.StateFlags bit for FullyInstalled (Playnite's AppStateFlags). */
const STATE_FULLY_INSTALLED = 4
/** The scan service detects the client right before scanning; a fresh detection is reused for this long. */
const DETECT_CACHE_MS = 60_000
const MANIFEST_RE = /^appmanifest_(\d+)\.acf$/i
const SHA1_NAME_RE = /^[0-9a-f]{40}$/i
const ICON_FILE_RE = /^[0-9a-f]{40}\.(jpg|jpeg|png|ico)$/i

const COVER_FILES = ['library_600x900_2x.jpg', 'library_600x900.jpg', 'library_capsule.jpg']
const HERO_FILES = ['library_hero.jpg']
const LOGO_FILES = ['logo.png']

export interface SteamAppManifest {
  appId: number
  /** Display name without trademark symbols; empty when the manifest carries no name. */
  name: string
  /** Folder name under steamapps\common (a name, not a path); empty when missing. */
  installDir: string
  stateFlags: number
  /** Unix seconds; 0 when the app was never played on this machine. */
  lastPlayed: number
  /** Bytes; 0 when unknown. */
  sizeOnDisk: number
  /** Installed build; 0 until Steam commits a fresh install (the manifest then describes a download in progress). */
  buildId: number
}

export interface SteamAppStats {
  playtimeMinutes?: number
  /** Unix seconds. */
  lastPlayed?: number
}

export interface SteamLoginUser {
  steamId64: string
  /** The userdata\<accountId> folder name. */
  accountId: string
  accountName: string
  mostRecent: boolean
  autoLogin: boolean
  timestamp: number
}

export type SteamLocalMedia = Partial<Record<'cover' | 'hero' | 'logo' | 'icon', string>>

export interface SteamDetection {
  info: ClientInfo
  /** Steam install directory (backslashes, no trailing separator); null when not installed. */
  root: string | null
  /** HKCU AutoLoginUser account name; helps pick the userdata folder that holds play time. */
  autoLoginUser?: string
}

export interface SteamScanOptions {
  autoLoginUser?: string
}

export interface SteamScanResult {
  games: ScannedGame[]
  /**
   * Libraries of libraryfolders.vdf this scan could not look into (an unplugged or sleeping drive, an unreadable
   * steamapps folder). Nothing is known about their games: they are neither installed nor uninstalled by this scan.
   */
  unreachableLibraries: string[]
}

// ---------------------------------------------------------------------------
// Non-game manifests
// ---------------------------------------------------------------------------

/**
 * Tools, runtimes and helper apps that ship with their own appmanifest but are not games. The research only names
 * 228980 (Playnite's single exclusion); the others are Valve's well-known tool app ids plus 4099820, which Ubisoft
 * titles install next to themselves (verified on the development machine).
 */
const NON_GAME_APP_IDS = new Map<number, string>([
  [228980, 'Steamworks Common Redistributables'],
  [1007, 'Steamworks SDK Redist'],
  [250820, 'SteamVR'],
  [323910, 'SteamVR Performance Test'],
  [1070560, 'Steam Linux Runtime 1.0 (scout)'],
  [1391110, 'Steam Linux Runtime 2.0 (soldier)'],
  [1628350, 'Steam Linux Runtime 3.0 (sniper)'],
  [858280, 'Proton 3.7'],
  [930400, 'Proton 3.7 Beta'],
  [961940, 'Proton 3.16'],
  [996510, 'Proton 3.16 Beta'],
  [1054830, 'Proton 4.2'],
  [1113280, 'Proton 4.11'],
  [1245040, 'Proton 5.0'],
  [1420170, 'Proton 5.13'],
  [1580130, 'Proton 6.3'],
  [1887720, 'Proton 7.0'],
  [2348590, 'Proton 8.0'],
  [2805730, 'Proton 9.0'],
  [1493710, 'Proton Experimental'],
  [2180100, 'Proton Hotfix'],
  [1826330, 'Proton EasyAntiCheat Runtime'],
  [1161040, 'Proton BattlEye Runtime'],
  [4099820, 'Ubisoft Connect Services']
])

/**
 * Valve's Proton tools are named "Proton <major>.<minor>", "Proton Experimental", "Proton Hotfix",
 * "Proton EasyAntiCheat Runtime" and "Proton BattlEye Runtime" (install folder "Proton - Experimental"). A bare
 * /^proton\b/ would also drop real games such as "Proton Pulse" (appid 295070).
 */
const PROTON_TOOL_PATTERN =
  /^proton (?:- )?(?:\d+\.\d+|experimental|hotfix|easyanticheat runtime|battleye runtime)\b/i

const NON_GAME_NAME_RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: PROTON_TOOL_PATTERN, reason: 'Proton compatibility tool' },
  { pattern: /^steam linux runtime\b/i, reason: 'Steam Linux Runtime' },
  { pattern: /^steamworks\b/i, reason: 'Steamworks tool' },
  { pattern: /^steamvr\b/i, reason: 'SteamVR tool' },
  { pattern: /\bredistributables?\b/i, reason: 'redistributable package' },
  { pattern: /\bdedicated server\b/i, reason: 'dedicated server' },
  {
    pattern:
      /\b(sdk|authoring tools|developer tools|dev tools|mod(?:ding)? tools|workshop tools|creation kit)\b/i,
    reason: 'development tool'
  },
  { pattern: /\b(soundtrack|original score|ost)$/i, reason: 'soundtrack' },
  { pattern: /^ubisoft connect services$/i, reason: 'launcher helper' }
]

/** Fallback when a manifest has no name: Valve's tool install folders follow fixed patterns. */
const NON_GAME_INSTALLDIR_RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /^steamlinuxruntime/i, reason: 'Steam Linux Runtime' },
  { pattern: PROTON_TOOL_PATTERN, reason: 'Proton compatibility tool' },
  { pattern: /^steamworks shared$/i, reason: 'Steamworks Common Redistributables' }
]

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested with inline fixtures)
// ---------------------------------------------------------------------------

/**
 * parseVdf from src/main/util/vdf.ts rejects a quoted value that is not closed before the end of the text
 * (@node-steam/vdf would loop forever on it). Steam writes manifests via .tmp + rename, but a crash can still
 * leave a half-written .acf and one such file must not freeze the main process.
 */
export function parseSteamVdf(text: string): VdfObject {
  return parseVdf(text)
}

/** @node-steam/vdf keeps backslash escapes verbatim; Valve's KeyValues text escapes \\, \", \n and \t. */
export function unescapeVdf(value: string): string {
  return value.replace(/\\([\\"nt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
}

/** Playnite's RemoveTrademarks plus whitespace cleanup. */
export function normalizeSteamTitle(name: string): string {
  return name.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim()
}

function vdfText(value: VdfValue | undefined): string | undefined {
  const text = vdfString(value)
  return text === undefined ? undefined : unescapeVdf(text)
}

/** Backslashes, no trailing separator, but keep the separator of a bare drive root ("D:\"). */
function toWindowsPath(path: string): string {
  const win = path
    .trim()
    .replace(/\//g, '\\')
    .replace(/[\\]+$/, '')
  return /^[a-zA-Z]:$/.test(win) ? `${win}\\` : win
}

/**
 * Library roots from steamapps\libraryfolders.vdf: numeric keys hold either a path string (old clients) or an object
 * with a `path` child. The Steam folder itself is always included because old clients did not list it.
 */
export function parseLibraryFolders(text: string, steamRoot: string): string[] {
  const folders = vdfGet(parseSteamVdf(text), 'libraryfolders')
  const paths: string[] = []
  if (folders && typeof folders === 'object') {
    for (const [key, value] of Object.entries(folders)) {
      if (!/^\d+$/.test(key)) continue
      const path = typeof value === 'object' ? vdfText(vdfGet(value, 'path')) : vdfText(value)
      if (path && path.trim()) paths.push(path)
    }
  }
  paths.push(steamRoot)
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const win = toWindowsPath(path)
    const key = normalizePath(win)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(win)
  }
  return out
}

/** Parse one appmanifest_<appid>.acf. Null when there is no AppState block or no usable app id. */
export function parseAppManifest(text: string): SteamAppManifest | null {
  const state = vdfGet(parseSteamVdf(text), 'AppState')
  if (!state || typeof state !== 'object') return null
  const appId = vdfNumber(vdfGet(state, 'appid'))
  if (appId === undefined || !Number.isInteger(appId) || appId <= 0) return null
  const name = vdfText(vdfGet(state, 'name')) ?? vdfText(vdfGet(state, 'UserConfig', 'name')) ?? ''
  const installDir = vdfText(vdfGet(state, 'installdir')) ?? ''
  return {
    appId,
    name: normalizeSteamTitle(name),
    installDir: installDir.trim(),
    stateFlags: vdfNumber(vdfGet(state, 'StateFlags')) ?? 0,
    lastPlayed: vdfNumber(vdfGet(state, 'LastPlayed')) ?? 0,
    sizeOnDisk: vdfNumber(vdfGet(state, 'SizeOnDisk')) ?? 0,
    buildId: vdfNumber(vdfGet(state, 'buildid')) ?? 0
  }
}

/**
 * StateFlags bits that mean Steam is writing the app right now (UpdateRunning, UpdateStarted, Preallocating,
 * Downloading, Staging, Committing). UpdateRequired (2) and UpdatePaused (512) are not among them: an installed game
 * with a pending update is still installed.
 */
const STATE_INSTALLING_BITS = 256 | 1024 | 524288 | 1048576 | 2097152 | 4194304

/**
 * Bit 4 (FullyInstalled), unless the manifest is a fresh install still in flight: Steam sets bit 4 early (StateFlags
 * 1030 / 1542 mid-download) but writes `buildid` only at the commit, so an installing bit together with `buildid 0`
 * is a download in progress, not an installed game. An installed game being updated keeps its old build id.
 */
export function isFullyInstalled(stateFlags: number, buildId = 1): boolean {
  if ((stateFlags & STATE_FULLY_INSTALLED) === 0) return false
  return !(buildId === 0 && (stateFlags & STATE_INSTALLING_BITS) !== 0)
}

/** Why a manifest is not a game (tool, runtime, redistributable, soundtrack...), or null when it is one. */
export function nonGameReason(
  manifest: Pick<SteamAppManifest, 'appId' | 'name' | 'installDir'>
): string | null {
  const known = NON_GAME_APP_IDS.get(manifest.appId)
  if (known) return known
  for (const rule of NON_GAME_NAME_RULES) if (rule.pattern.test(manifest.name)) return rule.reason
  for (const rule of NON_GAME_INSTALLDIR_RULES)
    if (rule.pattern.test(manifest.installDir)) return rule.reason
  return null
}

/**
 * Per-app play time from userdata\<accountid>\config\localconfig.vdf. Only the nested
 * UserLocalConfigStore > Software > Valve > Steam > apps block is read; the root-level "apps" block holds controller
 * settings. Mod entries ("70_1234") are ignored.
 */
export function parseLocalConfig(text: string): Map<number, SteamAppStats> {
  const stats = new Map<number, SteamAppStats>()
  const apps = vdfGet(
    parseSteamVdf(text),
    'UserLocalConfigStore',
    'Software',
    'Valve',
    'Steam',
    'apps'
  )
  if (!apps || typeof apps !== 'object') return stats
  for (const [key, value] of Object.entries(apps)) {
    if (!/^\d+$/.test(key) || !value || typeof value !== 'object') continue
    const playtime = vdfNumber(vdfGet(value, 'Playtime'))
    const disconnected = vdfNumber(vdfGet(value, 'PlaytimeDisconnected'))
    const lastPlayed = vdfNumber(vdfGet(value, 'LastPlayed'))
    const entry: SteamAppStats = {}
    if (playtime !== undefined || disconnected !== undefined) {
      // Steam's own total adds offline minutes to the synced ones (Playnite: playtime_forever + playtime_disconnected).
      entry.playtimeMinutes = Math.max(0, Math.round((playtime ?? 0) + (disconnected ?? 0)))
    }
    if (lastPlayed !== undefined && lastPlayed > 0) entry.lastPlayed = Math.floor(lastPlayed)
    if (entry.playtimeMinutes !== undefined || entry.lastPlayed !== undefined)
      stats.set(Number(key), entry)
  }
  return stats
}

/** Users from config\loginusers.vdf (keys are steamid64 values). */
export function parseLoginUsers(text: string): SteamLoginUser[] {
  const users = vdfGet(parseSteamVdf(text), 'users')
  const out: SteamLoginUser[] = []
  if (!users || typeof users !== 'object') return out
  for (const [steamId64, value] of Object.entries(users)) {
    if (!/^\d+$/.test(steamId64) || !value || typeof value !== 'object') continue
    const accountId = BigInt(steamId64) - STEAM_ID64_BASE
    if (accountId <= BigInt(0)) continue
    out.push({
      steamId64,
      accountId: accountId.toString(),
      accountName: vdfText(vdfGet(value, 'AccountName')) ?? '',
      mostRecent: vdfNumber(vdfGet(value, 'MostRecent')) === 1,
      autoLogin: vdfNumber(vdfGet(value, 'AutoLogin')) === 1,
      timestamp: vdfNumber(vdfGet(value, 'timestamp')) ?? 0
    })
  }
  return out
}

/**
 * Account ids to try for play time, most likely active user first: MostRecent "1" (older clients), the registry's
 * AutoLoginUser, AutoLogin "1", then the newest timestamp. userdata folders that loginusers.vdf does not mention come
 * last, in the order given.
 */
export function orderAccountCandidates(
  users: SteamLoginUser[],
  userdataFolders: string[],
  autoLoginUser?: string
): string[] {
  const byTime = [...users].sort((a, b) => b.timestamp - a.timestamp)
  const wanted = autoLoginUser?.trim().toLowerCase()
  const ordered = [
    ...byTime.filter((u) => u.mostRecent),
    ...byTime.filter((u) => !!wanted && u.accountName.toLowerCase() === wanted),
    ...byTime.filter((u) => u.autoLogin),
    ...byTime
  ].map((u) => u.accountId)
  const folders = userdataFolders.filter((f) => /^\d+$/.test(f))
  return [...new Set([...ordered, ...folders])]
}

// ---------------------------------------------------------------------------
// Local artwork
// ---------------------------------------------------------------------------

/**
 * Local art from appcache\librarycache. Current clients keep one folder per app (`<appid>\library_600x900.jpg`,
 * `logo.png`, `library_hero.jpg`, the icon as `<sha1>.jpg`, and `<sha1>\` subfolders with the newest assets, which
 * win over the top-level files only when those are missing); clients before mid-2024 used flat
 * `<appid>_library_600x900.jpg` style names. Returns absolute paths.
 */
export async function findLibraryCacheArt(
  cacheDir: string,
  appId: number
): Promise<SteamLocalMedia> {
  const media: SteamLocalMedia = {}
  const appDir = join(cacheDir, String(appId))
  const entries = await listDir(appDir)
  if (entries.length) {
    const subdirs = entries.filter((e) => e.isDirectory() && SHA1_NAME_RE.test(e.name))
    const dated = await Promise.all(
      subdirs.map(async (e) => {
        const path = join(appDir, e.name)
        return { path, mtime: (await statSafe(path))?.mtimeMs ?? 0 }
      })
    )
    dated.sort((a, b) => b.mtime - a.mtime)
    const dirs = [appDir, ...dated.map((d) => d.path)]
    for (const dir of dirs) {
      const files = dir === appDir ? entries : await listDir(dir)
      const names = new Map<string, string>()
      for (const f of files) if (f.isFile()) names.set(f.name.toLowerCase(), join(dir, f.name))
      // Only set a kind when a file was found: a key holding undefined would leak into ScannedGame.localMedia.
      const assign = (kind: keyof SteamLocalMedia, candidates: string[]): void => {
        if (media[kind]) return
        for (const c of candidates) {
          const path = names.get(c)
          if (path) {
            media[kind] = path
            return
          }
        }
      }
      assign('cover', COVER_FILES)
      assign('hero', HERO_FILES)
      assign('logo', LOGO_FILES)
      if (!media.icon) {
        for (const [name, path] of names) {
          if (ICON_FILE_RE.test(name)) {
            media.icon = path
            break
          }
        }
      }
    }
  }
  const flat: [keyof SteamLocalMedia, string][] = [
    ['cover', `${appId}_library_600x900.jpg`],
    ['hero', `${appId}_library_hero.jpg`],
    ['logo', `${appId}_logo.png`],
    ['icon', `${appId}_icon.jpg`]
  ]
  for (const [kind, name] of flat) {
    if (media[kind]) continue
    const path = join(cacheDir, name)
    if (await isFile(path)) media[kind] = path
  }
  return media
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function unixToIso(seconds: number | undefined): string | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * The libraries to scan and the ones that cannot be reached. A library whose own folder is gone (the drive is not
 * there) is unreachable; one whose folder is there without a steamapps folder is not a library any more (skipped).
 */
async function readLibraryFolders(
  root: string,
  logger: Logger
): Promise<{ existing: string[]; unreachable: string[] }> {
  const file = join(root, 'steamapps', 'libraryfolders.vdf')
  const text = await readTextIfExists(file)
  let libraries = [root]
  if (text === null) {
    logger.info(`steam: ${file} not found; scanning the Steam folder only`)
  } else {
    try {
      libraries = parseLibraryFolders(text, root)
    } catch (err) {
      logger.warn(
        `steam: cannot parse ${file}: ${(err as Error).message}; scanning the Steam folder only`
      )
    }
  }
  const existing: string[] = []
  const unreachable: string[] = []
  for (const library of libraries) {
    if (await isDirectory(join(library, 'steamapps'))) existing.push(library)
    else if (await isDirectory(library))
      logger.debug(`steam: library ${library} has no steamapps folder; skipped`)
    else {
      unreachable.push(library)
      logger.debug(`steam: library ${library} cannot be reached (unplugged drive?); games kept`)
    }
  }
  return { existing, unreachable }
}

/** The userdata account ids of this Steam install, most likely active user first. */
async function accountCandidates(
  root: string,
  autoLoginUser: string | undefined,
  logger: Logger
): Promise<string[]> {
  const loginFile = join(root, 'config', 'loginusers.vdf')
  const loginText = await readTextIfExists(loginFile)
  let users: SteamLoginUser[] = []
  if (loginText === null) {
    logger.debug(`steam: ${loginFile} not found`)
  } else {
    try {
      users = parseLoginUsers(loginText)
    } catch (err) {
      logger.warn(`steam: cannot parse ${loginFile}: ${(err as Error).message}`)
    }
  }
  const userdata = join(root, 'userdata')
  const folders = (await listDir(userdata)).filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
  // The active user's localconfig.vdf is rewritten on every Steam exit: newest first is the best fallback order.
  const dated = await Promise.all(
    folders.map(async (e) => ({
      name: e.name,
      mtime: (await statSafe(join(userdata, e.name, 'config', 'localconfig.vdf')))?.mtimeMs ?? 0
    }))
  )
  dated.sort((a, b) => b.mtime - a.mtime)
  return orderAccountCandidates(
    users,
    dated.map((d) => d.name),
    autoLoginUser
  )
}

/** Play time of the most likely active user; an empty map when no localconfig.vdf can be read. */
async function readUserStats(
  root: string,
  autoLoginUser: string | undefined,
  logger: Logger
): Promise<Map<number, SteamAppStats>> {
  const userdata = join(root, 'userdata')
  for (const accountId of await accountCandidates(root, autoLoginUser, logger)) {
    const file = join(userdata, accountId, 'config', 'localconfig.vdf')
    const text = await readTextIfExists(file)
    if (text === null) continue
    try {
      const stats = parseLocalConfig(text)
      logger.debug(`steam: play time from ${file} (${stats.size} apps)`)
      return stats
    } catch (err) {
      logger.warn(`steam: cannot parse ${file}: ${(err as Error).message}`)
    }
  }
  logger.info('steam: no readable localconfig.vdf; play time and last played are unavailable')
  return new Map()
}

function buildScannedGame(
  manifest: SteamAppManifest,
  installDir: string,
  media: SteamLocalMedia,
  stats: SteamAppStats | undefined
): ScannedGame {
  const appId = manifest.appId
  const lastPlayed =
    stats?.lastPlayed ?? (manifest.lastPlayed > 0 ? manifest.lastPlayed : undefined)
  const extra: Record<string, number> = { steamAppId: appId }
  // Always written (0 = unknown): scans merge extra, so a stale size must be overwritten, not left behind.
  extra.sizeOnDisk = manifest.sizeOnDisk > 0 ? manifest.sizeOnDisk : 0
  return {
    source: 'steam',
    externalId: String(appId),
    platformId: STORE_PLATFORMS.steam.id,
    title: manifest.name || manifest.installDir || `Steam app ${appId}`,
    installDir,
    launch: { kind: 'uri', uri: `steam://rungameid/${appId}` },
    tracking: { mode: 'installDir', installDir },
    storePlaytimeMinutes: stats?.playtimeMinutes,
    lastPlayed: unixToIso(lastPlayed),
    localMedia: Object.keys(media).length ? media : undefined,
    metadata: { links: { store: `https://store.steampowered.com/app/${appId}` } },
    extra
  }
}

/** `corrupt` marks a file that should not exist in that shape (unreadable, no AppState); routine skips stay at debug level. */
type ManifestOutcome =
  | { game: ScannedGame; skip?: undefined; corrupt?: undefined }
  | { game?: undefined; skip: string; corrupt?: boolean }

async function scanManifest(
  file: string,
  library: string,
  cacheDir: string,
  stats: Map<number, SteamAppStats>,
  seen: Set<number>
): Promise<ManifestOutcome> {
  const text = await readTextIfExists(file)
  if (text === null) return { skip: 'unreadable', corrupt: true }
  const manifest = parseAppManifest(text)
  if (!manifest) return { skip: 'no AppState block or app id', corrupt: true }
  if (seen.has(manifest.appId))
    return { skip: `app ${manifest.appId} already found in another library` }
  if (!isFullyInstalled(manifest.stateFlags, manifest.buildId)) {
    return {
      skip: `not fully installed (StateFlags ${manifest.stateFlags}, buildid ${manifest.buildId})`
    }
  }
  const reason = nonGameReason(manifest)
  if (reason) return { skip: `not a game: ${reason}` }
  const dir = manifest.installDir
  if (!dir || dir === '.' || dir === '..' || basename(dir) !== dir)
    return { skip: 'no usable installdir' }
  const installDir = join(library, 'steamapps', 'common', dir)
  if (!(await isDirectory(installDir))) {
    const soundtrack = await isDirectory(join(library, 'steamapps', 'music', dir))
    return { skip: soundtrack ? 'soundtrack' : `install folder missing: ${installDir}` }
  }
  const media = await findLibraryCacheArt(cacheDir, manifest.appId)
  return { game: buildScannedGame(manifest, installDir, media, stats.get(manifest.appId)) }
}

/** Scan every library of the Steam install at `root`. Exported so tests can run it on a fixture folder. */
export async function scanSteamRoot(
  root: string,
  ctx: ScanContext,
  options: SteamScanOptions = {}
): Promise<ScannedGame[]> {
  return (await scanSteamLibraries(root, ctx, options)).games
}

/** `scanSteamRoot` plus the libraries the scan could not reach (their games must not be marked uninstalled). */
export async function scanSteamLibraries(
  root: string,
  ctx: ScanContext,
  options: SteamScanOptions = {}
): Promise<SteamScanResult> {
  const logger = ctx.log
  const { existing: libraries, unreachable } = await readLibraryFolders(root, logger)
  const stats = await readUserStats(root, options.autoLoginUser, logger)
  const cacheDir = join(root, 'appcache', 'librarycache')
  const games: ScannedGame[] = []
  const seen = new Set<number>()
  let skipped = 0
  for (const library of libraries) {
    ctx.progress(games.length, tMain('mainApp.scan.steamLibrary', { folder: library }))
    const steamapps = join(library, 'steamapps')
    const manifests: { file: string; appId: number }[] = []
    // Not `listDir`: it answers an unreadable folder with an empty list, which would read as "nothing installed".
    let entries: Dirent[]
    try {
      entries = await fs.readdir(steamapps, { withFileTypes: true })
    } catch (err) {
      unreachable.push(library)
      logger.debug(
        `steam: library ${library} cannot be read (${(err as Error).message}); games kept`
      )
      continue
    }
    for (const entry of entries) {
      const match = MANIFEST_RE.exec(entry.name)
      if (match && entry.isFile())
        manifests.push({ file: join(steamapps, entry.name), appId: Number(match[1]) })
    }
    manifests.sort((a, b) => a.appId - b.appId)
    let found = 0
    for (const { file } of manifests) {
      try {
        const outcome = await scanManifest(file, library, cacheDir, stats, seen)
        if (outcome.game) {
          seen.add(Number(outcome.game.externalId))
          games.push(outcome.game)
          found++
        } else {
          skipped++
          if (outcome.corrupt) logger.warn(`steam: ${file}: skipped, ${outcome.skip}`)
          else logger.debug(`steam: ${file}: ${outcome.skip}`)
        }
      } catch (err) {
        skipped++
        logger.warn(`steam: ${file}: skipped, ${(err as Error).message}`)
      }
    }
    ctx.progress(
      games.length,
      tMain('mainApp.scan.steamLibraryFound', { folder: library, count: found })
    )
  }
  logger.info(
    `steam: ${games.length} installed games in ${libraries.length} ${libraries.length === 1 ? 'library' : 'libraries'}, ${skipped} manifests skipped`
  )
  if (unreachable.length)
    logger.info(`steam: unreachable library folders, games kept: ${unreachable.join(', ')}`)
  return { games, unreachableLibraries: unreachable }
}

// ---------------------------------------------------------------------------
// Client detection
// ---------------------------------------------------------------------------

function registryString(value: RegistryValue | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value[0]?.trim() || undefined
  return undefined
}

/**
 * Locate the Steam client: HKCU SteamPath / SteamExe, then the 32-bit HKLM InstallPath, then the default folder.
 * A candidate only counts when steam.exe exists in it.
 */
export async function detectSteam(logger: Logger = log): Promise<SteamDetection> {
  let autoLoginUser: string | undefined
  const sources: (() => Promise<string[]>)[] = [
    async () => {
      const key = await readRegistryKey('HKCU', 'Software\\Valve\\Steam', { depth: 0 })
      if (!key) return []
      autoLoginUser = registryString(key.values.AutoLoginUser)
      const steamPath = registryString(key.values.SteamPath)
      const steamExe = registryString(key.values.SteamExe)
      return [steamPath, steamExe ? dirname(steamExe) : undefined].filter((p): p is string => !!p)
    },
    async () => {
      const key = await readRegistryKey('HKLM', 'SOFTWARE\\WOW6432Node\\Valve\\Steam', { depth: 0 })
      const installPath = registryString(key?.values.InstallPath)
      return installPath ? [installPath] : []
    },
    async () => [join(knownFolders().programFilesX86, 'Steam')]
  ]
  for (const source of sources) {
    let candidates: string[] = []
    try {
      candidates = await source()
    } catch (err) {
      logger.warn(`steam: registry lookup failed: ${(err as Error).message}`)
    }
    for (const candidate of candidates) {
      const root = toWindowsPath(candidate)
      if (await isFile(join(root, 'steam.exe')))
        return { info: { installed: true, path: root }, root, autoLoginUser }
      logger.debug(`steam: no steam.exe in ${root}`)
    }
  }
  return { info: { installed: false }, root: null, autoLoginUser }
}

let lastDetection: { detection: SteamDetection; at: number } | null = null

async function detect(logger: Logger, maxAgeMs: number): Promise<SteamDetection> {
  if (lastDetection && Date.now() - lastDetection.at < maxAgeMs) return lastDetection.detection
  const detection = await detectSteam(logger)
  lastDetection = { detection, at: Date.now() }
  return detection
}

/**
 * The appids in the Hidden collection of Steam's cloud-storage file: a JSON array of `[key, { value, is_deleted }]`
 * whose `user-collections.hidden` value is itself JSON, `{ added: number[], removed: number[] }`. An account that never
 * hid a game has no such entry (an empty set). Null when the file cannot be understood, so a torn read while Steam
 * writes it never reads as "nothing is hidden".
 */
export function parseHiddenCollection(text: string): Set<number> | null {
  try {
    const entries: unknown = JSON.parse(text)
    if (!Array.isArray(entries)) return null
    const entry = entries.find((e) => Array.isArray(e) && e[0] === 'user-collections.hidden')
    const record = entry?.[1] as { value?: unknown; is_deleted?: unknown } | undefined
    if (!record || record.is_deleted === true) return new Set()
    if (typeof record.value !== 'string') return null
    const { added, removed } = JSON.parse(record.value) as { added?: unknown; removed?: unknown }
    if (!Array.isArray(added)) return null
    const gone = new Set(Array.isArray(removed) ? removed : [])
    return new Set(added.filter((id): id is number => Number.isInteger(id) && !gone.has(id)))
  } catch {
    return null
  }
}

/**
 * The games hidden in the Steam client by its most likely active user, read from the local disk, or null when that
 * cannot be told (no Steam, no account, unreadable file), which leaves the library as it is. sharedconfig.vdf also has `Hidden` flags, but they are stale
 * since Steam moved to collections, so they are not read.
 */
export async function readSteamHiddenApps(logger: Logger = log): Promise<Set<number> | null> {
  const detection = await detect(logger, DETECT_CACHE_MS)
  if (!detection.root) return null
  // The active user only: a locked file must not fall through to another account's list.
  const [accountId] = await accountCandidates(detection.root, detection.autoLoginUser, logger)
  if (!accountId) return null
  const file = join(
    detection.root,
    'userdata',
    accountId,
    'config',
    'cloudstorage',
    'cloud-storage-namespace-1.json'
  )
  const text = await readTextIfExists(file)
  if (text === null) return null
  const hidden = parseHiddenCollection(text)
  if (!hidden) logger.warn(`steam: cannot read the Hidden collection in ${file}`)
  return hidden
}

/** The libraries the last `scanInstalled` could not reach (GameProvider.unreachableRoots). */
let lastUnreachableLibraries: string[] = []

export const steamProvider: GameProvider = {
  id: 'steam',
  name: 'Steam',
  platforms: () => [STORE_PLATFORMS.steam],
  async detectClient() {
    return (await detect(log, 0)).info
  },
  async scanInstalled(ctx) {
    const detection = await detect(ctx.log, DETECT_CACHE_MS)
    // The scan service only calls this after a positive detection; a null root here means the lookup just failed.
    if (!detection.root) throw new Error('Steam client not found')
    // Cleared first: a scan that throws must not leave the previous scan's list behind.
    lastUnreachableLibraries = []
    const result = await scanSteamLibraries(detection.root, ctx, {
      autoLoginUser: detection.autoLoginUser
    })
    lastUnreachableLibraries = result.unreachableLibraries
    return result.games
  },
  unreachableRoots: () => [...lastUnreachableLibraries]
}
