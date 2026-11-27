import { basename, extname, join } from 'path'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { ClientInfo, ScannedGame } from '../../shared/types'
import { createLogger } from '../logger'
import { readRegistryKey, type RegistryKey, type RegistryView } from '../system/registry'
import { isDirectory, isFile } from '../util/fs'
import { normalizePath } from '../util/paths'
import { displayIconPath, removeTrademarks } from '../util/text'
import type { GameProvider, ScanContext } from './types'

const log = createLogger('providers:ubisoft')

const LAUNCHER_KEY = 'SOFTWARE\\Ubisoft\\Launcher'
const INSTALLS_KEY = 'SOFTWARE\\Ubisoft\\Launcher\\Installs'
const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const CLIENT_EXES = ['UbisoftConnect.exe', 'upc.exe', 'Uplay.exe']

function str(key: RegistryKey, name: string): string {
  const v = key.values[name]
  if (v === undefined || v === null) return ''
  return Array.isArray(v) ? v.join(' ') : String(v)
}

function cleanDir(path: string): string {
  return path.replace(/\//g, '\\').replace(/[\\]+$/, '')
}

// ---------------------------------------------------------------------------
// Client: HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher InstallDir
// ---------------------------------------------------------------------------

export function clientDirFromKey(key: RegistryKey | null): string | null {
  if (!key) return null
  const dir = str(key, 'InstallDir').trim()
  return dir ? cleanDir(dir) : null
}

async function findClientExe(): Promise<string | null> {
  for (const view of ['x86', 'default'] as RegistryView[]) {
    const dir = clientDirFromKey(await readRegistryKey('HKLM', LAUNCHER_KEY, { view, depth: 0 }))
    if (!dir) continue
    for (const exe of CLIENT_EXES) {
      const candidate = join(dir, exe)
      if (await isFile(candidate)) return candidate
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Installed games: HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id> InstallDir
// Titles: Uninstall\Uplay Install <id> DisplayName, else the folder name.
// ---------------------------------------------------------------------------

export interface UbisoftInstall {
  id: string
  installDir: string
}

export interface UbisoftUninstallInfo {
  displayName: string
  displayIcon: string
}

export function installsFromKey(key: RegistryKey | null): UbisoftInstall[] {
  if (!key) return []
  const out: UbisoftInstall[] = []
  for (const sub of key.subkeys) {
    const id = sub.leaf.trim()
    const dir = str(sub, 'InstallDir').trim()
    if (!id || !dir) continue
    out.push({ id, installDir: cleanDir(dir) })
  }
  return out
}

/** `Uplay Install <id>` Uninstall rows by product id. */
export function uplayUninstallInfo(
  uninstallKey: RegistryKey | null
): Map<string, UbisoftUninstallInfo> {
  const map = new Map<string, UbisoftUninstallInfo>()
  if (!uninstallKey) return map
  for (const sub of uninstallKey.subkeys) {
    const m = sub.leaf.match(/^Uplay Install (\S+)$/i)
    if (!m) continue
    map.set(m[1], {
      displayName: str(sub, 'DisplayName').trim(),
      displayIcon: displayIconPath(str(sub, 'DisplayIcon'))
    })
  }
  return map
}

export function buildScannedGame(
  install: UbisoftInstall,
  info: UbisoftUninstallInfo | undefined,
  iconPath?: string
): ScannedGame {
  const title = removeTrademarks(info?.displayName || basename(install.installDir))
  const game: ScannedGame = {
    source: 'ubisoft',
    externalId: install.id,
    platformId: 'ubisoft',
    title,
    installDir: install.installDir,
    launch: { kind: 'uri', uri: `uplay://launch/${install.id}/0` },
    tracking: { mode: 'installDir', installDir: install.installDir },
    extra: { ubisoftId: install.id }
  }
  if (iconPath) game.localMedia = { icon: iconPath }
  return game
}

/** Merge the 32-bit and 64-bit Installs trees (32-bit first, like Playnite), one entry per id. */
export function mergeInstalls(lists: UbisoftInstall[][]): UbisoftInstall[] {
  const seen = new Set<string>()
  const out: UbisoftInstall[] = []
  for (const list of lists) {
    for (const i of list) {
      if (seen.has(i.id)) continue
      seen.add(i.id)
      out.push(i)
    }
  }
  return out
}

async function scan(ctx: ScanContext): Promise<ScannedGame[]> {
  const [installs32, installs64, uninstall] = await Promise.all([
    readRegistryKey('HKLM', INSTALLS_KEY, { view: 'x86', depth: 1 }),
    readRegistryKey('HKLM', INSTALLS_KEY, { view: 'x64', depth: 1 }),
    readRegistryKey('HKLM', UNINSTALL_KEY, { view: 'x86', depth: 1, timeoutMs: 30_000 })
  ])
  const installs = mergeInstalls([installsFromKey(installs32), installsFromKey(installs64)])
  const info = uplayUninstallInfo(uninstall)
  ctx.log.debug(
    `ubisoft: ${installs.length} Installs entries, ${info.size} Uplay Install uninstall rows`
  )

  const games: ScannedGame[] = []
  const seenDirs = new Set<string>()
  for (const install of installs) {
    try {
      if (!(await isDirectory(install.installDir))) {
        ctx.log.debug(`ubisoft: ${install.id} install dir missing: ${install.installDir}`)
        continue
      }
      const dirKey = normalizePath(install.installDir)
      if (seenDirs.has(dirKey)) {
        // Several ids can point at one folder (editions, DLC registrations); the first one is the game.
        ctx.log.debug(
          `ubisoft: ${install.id} shares ${install.installDir} with an earlier id, skipped`
        )
        continue
      }
      seenDirs.add(dirKey)
      const row = info.get(install.id)
      let iconPath: string | undefined
      if (
        row?.displayIcon &&
        ['.ico', '.png'].includes(extname(row.displayIcon).toLowerCase()) &&
        (await isFile(row.displayIcon))
      ) {
        iconPath = row.displayIcon
      }
      const game = buildScannedGame(install, row, iconPath)
      games.push(game)
      ctx.progress(games.length, game.title)
    } catch (err) {
      ctx.log.warn(`ubisoft: skipping ${install.id}: ${(err as Error).message}`)
    }
  }
  ctx.log.info(`ubisoft: ${games.length} game(s)`)
  return games
}

export const ubisoftProvider: GameProvider = {
  id: 'ubisoft',
  name: 'Ubisoft Connect',
  platforms: () => [STORE_PLATFORMS.ubisoft],
  async detectClient(): Promise<ClientInfo> {
    try {
      const exe = await findClientExe()
      return exe ? { installed: true, path: exe } : { installed: false }
    } catch (err) {
      log.warn(`detectClient failed: ${(err as Error).message}`)
      return { installed: false }
    }
  },
  async scanInstalled(ctx) {
    try {
      return await scan(ctx)
    } catch (err) {
      ctx.log.error('ubisoft: scan failed', err)
      return []
    }
  }
}
