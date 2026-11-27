// Epic Games Store provider. Installed games come from the launcher's on-disk install records (no sign-in);
// launches go through the com.epicgames.launcher:// protocol so the launcher handles auth, updates and EOS.
// Recipes: docs/research/playnite-stores.md §4.2 and §6 (Epic).
import { basename, isAbsolute, join } from 'path'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { ClientInfo, ScannedGame } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import {
  readRegistryKey,
  registryValue,
  type RegistryHive,
  type RegistryValue,
  type RegistryView
} from '../system/registry'
import { isDirectory, isFile, listDir, readTextIfExists } from '../util/fs'
import { knownFolders, normalizePath } from '../util/paths'
import type { GameProvider } from './types'

const log = createLogger('epic')

const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const UNINSTALL_HIVES: { hive: RegistryHive; view: RegistryView }[] = [
  { hive: 'HKLM', view: 'x64' },
  { hive: 'HKLM', view: 'x86' },
  { hive: 'HKCU', view: 'default' }
]
const PROTOCOL_COMMAND_KEY = 'SOFTWARE\\Classes\\com.epicgames.launcher\\shell\\open\\command'
const LAUNCHER_DISPLAY_NAME = 'Epic Games Launcher'

export interface EpicPaths {
  /** Legacy launcher: one JSON `.item` manifest per installed app. */
  manifestsDir: string
  /** Legacy launcher: `{ InstallationList: [{ AppName, InstallLocation }] }`. */
  launcherInstalledPath: string
  /** New ("V2") launcher executable; when it exists the V2 data files below are read as well. */
  v2Exe: string
  /** V2: JSON Lines of every installation, past and present; the first line is version info. */
  v2InstallationsPath: string
  /** V2: `{ items: { key: { item: { id, title, namespace, releaseInfo: [{ appId }] } } } }`. */
  v2CatalogCachePath: string
}

export function defaultEpicPaths(): EpicPaths {
  const { programData, localAppData } = knownFolders()
  return {
    manifestsDir: join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    launcherInstalledPath: join(
      programData,
      'Epic',
      'UnrealEngineLauncher',
      'LauncherInstalled.dat'
    ),
    v2Exe: join(localAppData, 'Epic Games', 'Launcher', 'EpicGamesLauncher.exe'),
    v2InstallationsPath: join(localAppData, 'com.epicgames.eglv2', 'installations.jsonl'),
    v2CatalogCachePath: join(
      localAppData,
      'com.epicgames.eglv2',
      'cache',
      'prod',
      'catalog-cache.json'
    )
  }
}

function defaultLauncherRoots(): string[] {
  const { programFiles, programFilesX86 } = knownFolders()
  return [join(programFilesX86, 'Epic Games'), join(programFiles, 'Epic Games')]
}

// ---------------------------------------------------------------------------
// Legacy launcher: %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
// ---------------------------------------------------------------------------

/** The fields of a legacy `.item` manifest PlayOut reads (Playnite `Models/LauncherInstalled.cs`). */
export interface EpicManifest {
  AppName: string
  DisplayName?: string
  InstallLocation?: string
  /** Relative to InstallLocation, e.g. `Binaries\Win64\Game.exe`. */
  LaunchExecutable?: string
  CatalogNamespace?: string
  CatalogItemId?: string
  /** AppName of the base game (equals AppName for base games). */
  MainGameAppName?: string
  TechnicalType?: string
  AppCategories: string[]
  CompatibleApps: string[]
  bIsIncompleteInstall: boolean
  /** Bytes on disk once installed, as the launcher recorded it. */
  InstallSize?: number
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Case-insensitive registry value lookup as a trimmed string (undefined when missing or empty). */
function regString(values: Record<string, RegistryValue>, name: string): string | undefined {
  const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase())
  if (key === undefined) return undefined
  const value = values[key]
  if (value === null || value === undefined) return undefined
  return (Array.isArray(value) ? value.join('\n') : String(value)).trim() || undefined
}

/** Validate a parsed `.item` file; null when it is not a manifest (no AppName). */
export function parseEpicManifest(raw: unknown): EpicManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const appName = optionalString(r.AppName)
  if (!appName) return null
  return {
    AppName: appName,
    DisplayName: optionalString(r.DisplayName),
    InstallLocation: optionalString(r.InstallLocation),
    LaunchExecutable: optionalString(r.LaunchExecutable),
    CatalogNamespace: optionalString(r.CatalogNamespace),
    CatalogItemId: optionalString(r.CatalogItemId),
    MainGameAppName: optionalString(r.MainGameAppName),
    TechnicalType: optionalString(r.TechnicalType),
    AppCategories: stringArray(r.AppCategories),
    CompatibleApps: stringArray(r.CompatibleApps),
    bIsIncompleteInstall: r.bIsIncompleteInstall === true,
    InstallSize:
      typeof r.InstallSize === 'number' && Number.isFinite(r.InstallSize) && r.InstallSize > 0
        ? r.InstallSize
        : undefined
  }
}

/**
 * Why a manifest is not a launchable, fully installed game (null when it is). The add-on and plugin rules are
 * Playnite's (EpicLibrary.cs); incomplete installs and Unreal Engine builds are skipped on top of that.
 */
export function epicSkipReason(manifest: EpicManifest): string | null {
  if (manifest.bIsIncompleteInstall) return 'incomplete install'
  const categories = manifest.AppCategories.map((c) => c.toLowerCase())
  if (categories.includes('addons') && !categories.includes('addons/launchable'))
    return 'add-on / DLC'
  if (categories.includes('plugins') || categories.includes('plugins/engine')) {
    return 'Unreal Engine plugin'
  }
  if (manifest.CompatibleApps.some((app) => app.toUpperCase().startsWith('UE_'))) {
    return 'Unreal Engine plugin'
  }
  if (manifest.TechnicalType?.toLowerCase().includes('plugins/engine'))
    return 'Unreal Engine plugin'
  if (categories.includes('engines')) return 'Unreal Engine build'
  return null
}

/**
 * Launch URI understood by both launcher generations. The namespace:item:app triple is separated by literal
 * `%3A` (Playnite's verified format); without catalog ids the older app-name-only form is used.
 */
export function epicLaunchUri(appName: string, namespace?: string, catalogItemId?: string): string {
  const target =
    namespace && catalogItemId
      ? [namespace, catalogItemId, appName].map(encodeURIComponent).join('%3A')
      : encodeURIComponent(appName)
  return `com.epicgames.launcher://apps/${target}?action=launch&silent=true`
}

async function readJsonFile(file: string): Promise<unknown> {
  const text = await readTextIfExists(file)
  if (text === null) throw new Error('cannot read file')
  const body = text.replace(/^\uFEFF/, '').trim()
  if (!body) throw new Error('empty file')
  return JSON.parse(body) as unknown
}

/** LauncherInstalled.dat: AppName (lower-case) -> InstallLocation. */
async function readInstallList(file: string, log: Logger): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const text = await readTextIfExists(file)
  if (text === null) {
    log.debug(`epic: no install list at ${file}`)
    return map
  }
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    log.warn(`epic: ${file}: ${(err as Error).message}, ignored`)
    return map
  }
  const list = (data as { InstallationList?: unknown } | null)?.InstallationList
  for (const entry of Array.isArray(list) ? list : []) {
    const r = entry as Record<string, unknown> | null
    const appName = optionalString(r?.AppName)
    const location = optionalString(r?.InstallLocation)
    if (appName && location) map.set(appName.toLowerCase(), location)
  }
  return map
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '') || path
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

async function firstExistingDir(candidates: (string | undefined)[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue
    const dir = trimSeparators(candidate)
    if (await isDirectory(dir)) return dir
  }
  return null
}

async function legacyGame(
  manifest: EpicManifest,
  installDir: string,
  log: Logger
): Promise<ScannedGame> {
  const title = manifest.DisplayName ?? basename(installDir)
  let exePath: string | undefined
  if (manifest.LaunchExecutable) {
    const candidate = isAbsolute(manifest.LaunchExecutable)
      ? manifest.LaunchExecutable
      : join(installDir, manifest.LaunchExecutable)
    if (await isFile(candidate)) exePath = candidate
    else log.debug(`epic: ${manifest.AppName}: LaunchExecutable not found at ${candidate}`)
  }
  if (!manifest.CatalogNamespace || !manifest.CatalogItemId) {
    log.warn(
      `epic: ${manifest.AppName}: no CatalogNamespace/CatalogItemId, launch URI uses the app name only`
    )
  }
  const extra: Record<string, string | number> = { epicAppName: manifest.AppName }
  if (manifest.CatalogNamespace) extra.epicNamespace = manifest.CatalogNamespace
  if (manifest.CatalogItemId) extra.epicCatalogItemId = manifest.CatalogItemId
  // Always written (0 = unknown): scans merge extra, so a stale size must be overwritten, not left behind.
  extra.epicInstallSize = manifest.InstallSize ?? 0
  return {
    source: 'epic',
    externalId: manifest.AppName,
    platformId: STORE_PLATFORMS.epic.id,
    title,
    installDir,
    exePath,
    launch: {
      kind: 'uri',
      uri: epicLaunchUri(manifest.AppName, manifest.CatalogNamespace, manifest.CatalogItemId)
    },
    tracking: { mode: 'installDir', installDir },
    extra
  }
}

interface ManifestCandidate {
  manifest: EpicManifest
  installDir: string
  file: string
}

/**
 * Installed games of the legacy launcher: every `.item` manifest that passes the filters and whose install folder
 * (from the manifest, else from LauncherInstalled.dat) exists. Bad files are logged and skipped.
 */
export async function scanLegacyManifests(paths: EpicPaths, log: Logger): Promise<ScannedGame[]> {
  if (!(await isDirectory(paths.manifestsDir))) {
    log.debug(`epic: no manifests folder at ${paths.manifestsDir}`)
    return []
  }
  const installList = await readInstallList(paths.launcherInstalledPath, log)
  const entries = (await listDir(paths.manifestsDir))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.item'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const chosen = new Map<string, ManifestCandidate>()
  for (const entry of entries) {
    const file = join(paths.manifestsDir, entry.name)
    try {
      const manifest = parseEpicManifest(await readJsonFile(file))
      if (!manifest) {
        log.warn(`epic: ${entry.name}: not an app manifest (no AppName), skipped`)
        continue
      }
      const reason = epicSkipReason(manifest)
      if (reason) {
        log.debug(`epic: ${manifest.AppName} (${entry.name}): ${reason}, skipped`)
        continue
      }
      const listed = installList.get(manifest.AppName.toLowerCase())
      const installDir = await firstExistingDir([manifest.InstallLocation, listed])
      if (!installDir) {
        const tried =
          [manifest.InstallLocation, listed].filter(Boolean).join(' | ') || 'no InstallLocation'
        log.warn(`epic: ${manifest.AppName}: install folder missing (${tried}), skipped`)
        continue
      }
      const key = manifest.AppName.toLowerCase()
      const previous = chosen.get(key)
      // Duplicate manifests for one app: the one at the location LauncherInstalled.dat records wins.
      if (previous && !(listed && samePath(installDir, listed))) {
        log.debug(
          `epic: ${manifest.AppName}: duplicate ${entry.name} ignored, keeping ${basename(previous.file)}`
        )
        continue
      }
      chosen.set(key, { manifest, installDir, file })
    } catch (err) {
      log.warn(`epic: ${entry.name}: ${(err as Error).message}, skipped`)
    }
  }
  const games: ScannedGame[] = []
  for (const candidate of chosen.values()) {
    games.push(await legacyGame(candidate.manifest, candidate.installDir, log))
  }
  return games
}

// ---------------------------------------------------------------------------
// V2 launcher: %LOCALAPPDATA%\com.epicgames.eglv2\installations.jsonl + catalog-cache.json
// ---------------------------------------------------------------------------

interface V2Installation {
  installationId: string
  complete: boolean
  dir: string
  itemId?: string
  /** The app name; same id space as the legacy AppName. */
  artifactId: string
}

interface V2CatalogItem {
  id: string
  title?: string
  namespace?: string
  appIds: string[]
}

function parseV2Installation(raw: unknown): V2Installation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const artifactId = optionalString(r.artifactId)
  if (!artifactId) return null
  return {
    installationId: optionalString(r.installationId) ?? '',
    complete: r.complete === true,
    dir: optionalString(r.dir) ?? '',
    itemId: optionalString(r.itemId),
    artifactId
  }
}

async function readV2Catalog(file: string, log: Logger): Promise<Map<string, V2CatalogItem>> {
  const byId = new Map<string, V2CatalogItem>()
  const text = await readTextIfExists(file)
  if (text === null) {
    log.debug(`epic: no catalog cache at ${file}; titles fall back to folder names`)
    return byId
  }
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    log.warn(`epic: ${file}: ${(err as Error).message}, ignored`)
    return byId
  }
  const items = (data as { items?: unknown } | null)?.items
  if (!items || typeof items !== 'object') return byId
  for (const wrapper of Object.values(items as Record<string, unknown>)) {
    const item = (wrapper as { item?: unknown } | null)?.item
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = optionalString(r.id)
    if (!id) continue
    const releaseInfo = Array.isArray(r.releaseInfo) ? r.releaseInfo : []
    const appIds = releaseInfo
      .map((release) => optionalString((release as { appId?: unknown } | null)?.appId))
      .filter((appId): appId is string => appId !== undefined)
    byId.set(id, {
      id,
      title: optionalString(r.title),
      namespace: optionalString(r.namespace),
      appIds
    })
  }
  return byId
}

function v2Game(
  inst: V2Installation,
  catalog: Map<string, V2CatalogItem>,
  log: Logger
): ScannedGame {
  const appName = inst.artifactId
  let item = inst.itemId ? catalog.get(inst.itemId) : undefined
  if (!item) {
    item = [...catalog.values()].find((c) =>
      c.appIds.some((appId) => appId.toLowerCase() === appName.toLowerCase())
    )
  }
  const title = item?.title ?? basename(inst.dir)
  if (!item) log.warn(`epic: ${appName}: not in the catalog cache, using folder name "${title}"`)
  // The V2 install list records no size: 0 replaces any size an older manifest left (install-size.ts walks the folder).
  const extra: Record<string, string | number> = { epicAppName: appName, epicInstallSize: 0 }
  if (item?.namespace) extra.epicNamespace = item.namespace
  if (item) extra.epicCatalogItemId = item.id
  return {
    source: 'epic',
    externalId: appName,
    platformId: STORE_PLATFORMS.epic.id,
    title,
    installDir: inst.dir,
    launch: { kind: 'uri', uri: epicLaunchUri(appName, item?.namespace, item?.id) },
    tracking: { mode: 'installDir', installDir: inst.dir },
    extra
  }
}

/**
 * Installed games of the V2 launcher. installations.jsonl lists every installation ever made, so per artifactId
 * the first complete entry whose folder and `.egstore\<installationId>.manifest` still exist is taken.
 */
export async function scanV2Installations(paths: EpicPaths, log: Logger): Promise<ScannedGame[]> {
  const text = await readTextIfExists(paths.v2InstallationsPath)
  if (text === null) {
    log.debug(`epic: no V2 installation list at ${paths.v2InstallationsPath}`)
    return []
  }
  const catalog = await readV2Catalog(paths.v2CatalogCachePath, log)
  const chosen = new Map<string, V2Installation>()
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    let inst: V2Installation | null
    try {
      inst = parseV2Installation(JSON.parse(line))
    } catch (err) {
      log.warn(`epic: installations.jsonl line ${index + 1}: ${(err as Error).message}, skipped`)
      continue
    }
    if (!inst) {
      log.debug(`epic: installations.jsonl line ${index + 1}: no artifactId, skipped`)
      continue
    }
    const key = inst.artifactId.toLowerCase()
    if (chosen.has(key) || !inst.complete || !inst.dir || !inst.installationId) continue
    inst.dir = trimSeparators(inst.dir)
    if (!(await isDirectory(inst.dir))) continue
    if (!(await isFile(join(inst.dir, '.egstore', `${inst.installationId}.manifest`)))) continue
    chosen.set(key, inst)
  }
  return [...chosen.values()].map((inst) => v2Game(inst, catalog, log))
}

// ---------------------------------------------------------------------------
// Client detection
// ---------------------------------------------------------------------------

interface UninstallEntry {
  key: string
  displayName?: string
  installLocation?: string
  displayVersion?: string
}

/** First Add/Remove Programs entry matching `match`, from the 64-bit, 32-bit and per-user views in that order. */
async function findUninstallEntry(
  match: (entry: UninstallEntry) => boolean
): Promise<UninstallEntry | null> {
  for (const { hive, view } of UNINSTALL_HIVES) {
    const key = await readRegistryKey(hive, UNINSTALL_KEY, { view, depth: 1 })
    for (const sub of key?.subkeys ?? []) {
      const entry: UninstallEntry = {
        key: sub.leaf,
        displayName: regString(sub.values, 'DisplayName'),
        installLocation: regString(sub.values, 'InstallLocation'),
        displayVersion: regString(sub.values, 'DisplayVersion')
      }
      if (match(entry)) return entry
    }
  }
  return null
}

/** `"C:\...\EpicGamesLauncher.exe" %1` -> the executable. */
function exeFromCommand(command: string): string | null {
  const quoted = command.match(/^\s*"([^"]+)"/)
  if (quoted) return quoted[1]
  return command.trim().split(/\s+/)[0] || null
}

/** The launcher exe under an install root; Win32 is preferred over Win64 as in Playnite (issue #1552). */
async function findLauncherExe(roots: string[]): Promise<string | null> {
  for (const root of roots) {
    for (const arch of ['Win32', 'Win64']) {
      const exe = join(
        trimSeparators(root),
        'Launcher',
        'Portal',
        'Binaries',
        arch,
        'EpicGamesLauncher.exe'
      )
      if (await isFile(exe)) return exe
    }
  }
  return null
}

export interface EpicProviderOptions {
  paths?: EpicPaths
  /** Launcher install roots tried after the registry (default: Program Files (x86) and Program Files\Epic Games). */
  launcherRoots?: string[]
  /** Set false to skip registry lookups (fixture tests). */
  useRegistry?: boolean
}

export function createEpicProvider(options: EpicProviderOptions = {}): GameProvider {
  const paths = options.paths ?? defaultEpicPaths()
  const launcherRoots = options.launcherRoots ?? defaultLauncherRoots()
  const useRegistry = options.useRegistry ?? true

  async function detectClient(): Promise<ClientInfo> {
    if (await isFile(paths.v2Exe)) return { installed: true, path: paths.v2Exe }
    if (useRegistry) {
      const entry = await findUninstallEntry((e) => e.displayName === LAUNCHER_DISPLAY_NAME)
      if (entry?.installLocation) {
        const exe = await findLauncherExe([entry.installLocation])
        if (exe) return { installed: true, path: exe, version: entry.displayVersion }
        log.warn(
          `epic: uninstall entry points to ${entry.installLocation} but no launcher exe is there`
        )
      }
      const command = await registryValue('HKLM', PROTOCOL_COMMAND_KEY, '')
      const fromProtocol = command ? exeFromCommand(command) : null
      if (fromProtocol && (await isFile(fromProtocol)))
        return { installed: true, path: fromProtocol }
    }
    const exe = await findLauncherExe(launcherRoots)
    return exe ? { installed: true, path: exe } : { installed: false }
  }

  return {
    id: 'epic',
    name: 'Epic Games',
    platforms: () => [STORE_PLATFORMS.epic],
    detectClient,
    async scanInstalled(ctx) {
      const games = new Map<string, ScannedGame>()
      const add = (game: ScannedGame): void => {
        const key = game.externalId.toLowerCase()
        if (games.has(key)) return
        games.set(key, game)
        ctx.progress(games.size, game.title)
      }
      for (const game of await scanLegacyManifests(paths, ctx.log)) add(game)
      if (await isFile(paths.v2Exe)) {
        for (const game of await scanV2Installations(paths, ctx.log)) add(game)
      }
      ctx.log.info(`epic: ${games.size} installed game(s)`)
      return [...games.values()]
    }
  }
}

export const epicProvider = createEpicProvider()
