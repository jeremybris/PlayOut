// GOG provider. Installed games come from the registry keys GOG's installers write (Galaxy installs and offline
// installers alike); launches go through GOG Galaxy when it is installed, else the game executable runs directly.
// Recipes: docs/research/playnite-stores.md §4.3 and §6 (GOG); docs/research/metadata-apis.md §7.4 (local keys).
import { basename, dirname, isAbsolute, join } from 'path'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { LaunchSpec, ScannedGame } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { readRegistryKey, type RegistryKey, type RegistryValue } from '../system/registry'
import { isDirectory, isFile } from '../util/fs'
import { knownFolders } from '../util/paths'
import type { GameProvider } from './types'

const log = createLogger('gog')

/** Read with view 'x86' these resolve to HKLM\SOFTWARE\WOW6432Node\GOG.com\... */
const GALAXY_KEY = 'SOFTWARE\\GOG.com\\GalaxyClient'
const GAMES_KEY = 'SOFTWARE\\GOG.com\\Games'
const GALAXY_EXE = 'GalaxyClient.exe'
const CLIENT_CACHE_MS = 30_000

export interface GalaxyClient {
  dir: string
  exe: string
  version?: string
}

export type RegistryReader = typeof readRegistryKey

export interface GogProviderOptions {
  readKey?: RegistryReader
  /** Where Galaxy lives when the registry does not say (default: Program Files (x86)\GOG Galaxy). */
  galaxyDefaultDir?: string
}

/** Case-insensitive registry value lookup as a trimmed string (undefined when missing or empty). */
export function regString(
  values: Record<string, RegistryValue> | undefined,
  name: string
): string | undefined {
  if (!values) return undefined
  const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase())
  if (key === undefined) return undefined
  const value = values[key]
  if (value === null || value === undefined) return undefined
  return (Array.isArray(value) ? value.join('\n') : String(value)).trim() || undefined
}

/**
 * Split a Windows command line tail into argv the way CommandLineToArgvW does: whitespace separates, double
 * quotes group, backslashes are literal unless they precede a quote (2n -> n backslashes, 2n+1 -> n + a quote).
 */
export function tokenizeArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuotes = false
  let hasToken = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === '\\') {
      let count = 0
      while (input[i] === '\\') {
        count++
        i++
      }
      if (input[i] === '"') {
        current += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          current += '"'
          i++
        }
      } else {
        current += '\\'.repeat(count)
      }
      hasToken = true
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      hasToken = true
      i++
      continue
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (hasToken) {
        args.push(current)
        current = ''
        hasToken = false
      }
      i++
      continue
    }
    current += ch
    hasToken = true
    i++
  }
  if (hasToken) args.push(current)
  return args
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '') || path
}

/** Locate GOG Galaxy: `GalaxyClient\paths\client` in the 32-bit view, then the 64-bit view, then the default folder. */
export async function detectGalaxy(
  readKey: RegistryReader,
  defaultDir: string,
  log: Logger
): Promise<GalaxyClient | null> {
  for (const view of ['x86', 'x64'] as const) {
    const key = await readKey('HKLM', GALAXY_KEY, { view, depth: 1 })
    if (!key) continue
    const paths = key.subkeys.find((sub) => sub.leaf.toLowerCase() === 'paths')
    const dir = regString(paths?.values, 'client')
    if (!dir) {
      log.debug(`gog: ${key.name} has no paths\\client value`)
      continue
    }
    const clientDir = trimSeparators(dir)
    const exe = join(clientDir, regString(key.values, 'clientExecutable') ?? GALAXY_EXE)
    if (await isFile(exe)) return { dir: clientDir, exe, version: regString(key.values, 'version') }
    log.warn(`gog: registry says GOG Galaxy is in ${clientDir} but ${basename(exe)} is not there`)
  }
  const exe = join(defaultDir, GALAXY_EXE)
  if (await isFile(exe)) return { dir: defaultDir, exe }
  return null
}

function resolveExe(values: Record<string, RegistryValue>, installDir: string): string | undefined {
  const exe = regString(values, 'exe')
  if (exe) return isAbsolute(exe) ? exe : join(installDir, exe)
  const exeFile = regString(values, 'exeFile')
  if (exeFile) return join(installDir, exeFile)
  const command = tokenizeArgs(regString(values, 'launchCommand') ?? '')[0]
  if (command) return isAbsolute(command) ? command : join(installDir, command)
  return undefined
}

async function gameFromKey(
  sub: RegistryKey,
  galaxy: GalaxyClient | null,
  log: Logger
): Promise<ScannedGame | null> {
  const id = sub.leaf.trim()
  const values = sub.values
  const name = regString(values, 'gameName')
  const label = `${id} "${name ?? ''}"`
  if (!/^\d+$/.test(id)) {
    log.debug(`gog: ${sub.leaf}: not a product id, skipped`)
    return null
  }
  const dependsOn = regString(values, 'dependsOn')
  if (dependsOn) {
    log.debug(`gog: ${label}: DLC of ${dependsOn}, skipped`)
    return null
  }
  const path = regString(values, 'path')
  if (!path) {
    log.warn(`gog: ${label}: no install path in the registry, skipped`)
    return null
  }
  const installDir = trimSeparators(path)
  if (!(await isDirectory(installDir))) {
    log.warn(`gog: ${label}: install folder missing (${installDir}), skipped`)
    return null
  }
  const title = name ?? basename(installDir)
  const exePath = resolveExe(values, installDir)
  if (exePath && !(await isFile(exePath)))
    log.warn(`gog: ${label}: executable not found at ${exePath}`)

  let launch: LaunchSpec
  if (galaxy) {
    // Playnite's "start using Galaxy" command; /launchViaAutostart keeps the client in the tray.
    launch = {
      kind: 'exec',
      file: galaxy.exe,
      args: ['/launchViaAutostart', `/gameId=${id}`, '/command=runGame', `/path=${installDir}`],
      cwd: galaxy.dir
    }
  } else if (exePath) {
    const workingDir = regString(values, 'workingDir')
    const cwd =
      workingDir && (await isDirectory(trimSeparators(workingDir)))
        ? trimSeparators(workingDir)
        : dirname(exePath)
    launch = {
      kind: 'exec',
      file: exePath,
      args: tokenizeArgs(regString(values, 'launchParam') ?? ''),
      cwd
    }
  } else {
    log.warn(
      `gog: ${label}: no executable in the registry and GOG Galaxy is not installed, skipped`
    )
    return null
  }

  const game: ScannedGame = {
    source: 'gog',
    externalId: id,
    platformId: STORE_PLATFORMS.gog.id,
    title,
    installDir,
    exePath,
    launch,
    tracking: { mode: 'installDir', installDir },
    extra: { gogProductId: id }
  }
  const icon = join(installDir, `goggame-${id}.ico`)
  if (await isFile(icon)) game.localMedia = { icon }
  return game
}

export interface GogScanContext {
  log: Logger
  progress?: (found: number, message?: string) => void
}

/**
 * Map the `GOG.com\Games` key (read at depth 1) to games: one per numeric product subkey that is not DLC
 * (`dependsOn` set) and whose install folder still exists. Bad entries are logged and skipped.
 */
export async function gogGamesFromRegistry(
  games: RegistryKey,
  galaxy: GalaxyClient | null,
  ctx: GogScanContext
): Promise<ScannedGame[]> {
  const found: ScannedGame[] = []
  for (const sub of games.subkeys) {
    try {
      const game = await gameFromKey(sub, galaxy, ctx.log)
      if (!game) continue
      found.push(game)
      ctx.progress?.(found.length, game.title)
    } catch (err) {
      ctx.log.warn(`gog: ${sub.leaf}: ${(err as Error).message}, skipped`)
    }
  }
  return found
}

export function createGogProvider(options: GogProviderOptions = {}): GameProvider {
  const readKey = options.readKey ?? readRegistryKey
  const defaultDir = options.galaxyDefaultDir ?? join(knownFolders().programFilesX86, 'GOG Galaxy')
  let cached: { at: number; client: GalaxyClient | null } | null = null

  async function galaxy(force = false): Promise<GalaxyClient | null> {
    if (!force && cached && Date.now() - cached.at < CLIENT_CACHE_MS) return cached.client
    const client = await detectGalaxy(readKey, defaultDir, log)
    cached = { at: Date.now(), client }
    return client
  }

  async function readGamesKey(depth: number): Promise<RegistryKey | null> {
    return (
      (await readKey('HKLM', GAMES_KEY, { view: 'x86', depth })) ??
      (await readKey('HKLM', GAMES_KEY, { view: 'x64', depth }))
    )
  }

  return {
    id: 'gog',
    name: 'GOG',
    platforms: () => [STORE_PLATFORMS.gog],
    async detectClient() {
      const client = await galaxy(true)
      if (client) return { installed: true, path: client.exe, version: client.version }
      return { installed: false }
    },
    // Offline installers register games without Galaxy, so the scan runs regardless of the client.
    scansWithoutClient: true,
    async scanInstalled(ctx) {
      const client = await galaxy()
      const key = await readGamesKey(1)
      if (!key) {
        ctx.log.info('gog: no GOG.com\\Games registry key, no installed games')
        return []
      }
      const games = await gogGamesFromRegistry(key, client, ctx)
      const via = client
        ? 'launching via GOG Galaxy'
        : 'GOG Galaxy not installed, launching executables directly'
      ctx.log.info(
        `gog: ${games.length} installed game(s) from ${key.subkeys.length} registry entries (${via})`
      )
      return games
    }
  }
}

export const gogProvider = createGogProvider()
