// What Compress games automatically (auto-compress.ts) asks of the rest of PlayOut before and while it compresses a
// game: whether anything else is busy, whether the game's store is still writing it, and how its folder changes.
// Built from injected parts so the wiring in index.ts can be tested.
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Game } from '../../shared/types'
import { acfShowsDownload } from '../steam-dlc/acf'
import { tMain } from '../i18n'
import type { FolderActivity } from './auto-compress'

export interface AutoCompressCheckDeps {
  /** The game PlayOut runs now, if any (launcher.running()). */
  runningGameId(): string | null
  /** Game ids the install tracker watches or the install queue holds (installs.trackedGameIds()). */
  trackedGameIds(): string[]
  /** Game ids the install queue downloads now (its 'active' entries). */
  downloadingGameIds(): string[]
  /** The Emulation folder moves (emulationMove.moving()). */
  emulationMoving(): boolean
  /** An Upgrade menu action runs for any game (upgrades.anyBusy()). */
  upgradeRunning(): boolean
  /** A Convert run (or Trim Games) is under way (convert.status().running). */
  convertRunning(): Promise<boolean>
  /** The Steam app id of a Steam game, else null. */
  steamAppId(game: Game): string | number | null
  readFile?: (path: string) => Promise<string>
}

export interface AutoCompressChecks {
  /** Why no game can be compressed now (the same for every game), else null. */
  busyReason(): Promise<string | null>
  /** Why this game cannot be compressed yet (its install still tracked or downloading, Steam writing it), else null. */
  gameWaitReason(game: Game): Promise<string | null>
  /** While the game is compressed: why to stop and try again later (a game started, Steam writes into it), else null. */
  stopReason(game: Game): Promise<string | null>
}

/**
 * The appmanifest of a Steam game's install folder: `<library>\steamapps\common\<game>` ->
 * `<library>\steamapps\appmanifest_<appid>.acf`.
 */
export function steamManifestPath(installDir: string, appId: string): string {
  return join(dirname(dirname(installDir)), `appmanifest_${appId}.acf`)
}

/** StateFlags bits that leave a game alone: 4 fully installed, 2 an update waits (Steam may defer it for long). */
const STEAM_IDLE_BITS = 2 | 4

/**
 * Whether an appmanifest shows Steam busy with the game: downloading or updating it (acfShowsDownload), an update
 * paused part way (its files half rewritten), validating, or any other state than installed (with an update maybe
 * waiting). A manifest without StateFlags tells nothing: not busy.
 */
export function steamManifestBusy(text: string): boolean {
  if (acfShowsDownload(text)) return true
  const flags = /"StateFlags"\s+"(\d+)"/i.exec(text)
  return flags ? (Number(flags[1]) & ~STEAM_IDLE_BITS) !== 0 : false
}

export function createAutoCompressChecks(deps: AutoCompressCheckDeps): AutoCompressChecks {
  const readFile = deps.readFile ?? ((path: string) => fs.readFile(path, 'utf8'))

  /** A Steam game whose appmanifest shows Steam busy with it (downloading, updating, paused part way, validating...). */
  const steamWriting = async (game: Game): Promise<boolean> => {
    if (game.source !== 'steam' || !game.installDir) return false
    const appId = deps.steamAppId(game)
    if (!appId) return false
    const text = await readFile(steamManifestPath(game.installDir, String(appId))).catch(() => null)
    return text !== null && steamManifestBusy(text)
  }

  return {
    async busyReason() {
      if (deps.runningGameId()) return tMain('mainApp.autoCompressWait.gameRunning')
      if (deps.emulationMoving()) return tMain('mainApp.autoCompressWait.emulationMoving')
      if (deps.upgradeRunning()) return tMain('mainApp.autoCompressWait.upgradeRunning')
      if (await deps.convertRunning()) return tMain('mainApp.autoCompressWait.convertRunning')
      return null
    },
    async gameWaitReason(game) {
      if (deps.trackedGameIds().includes(game.id))
        return tMain('mainApp.autoCompressWait.installTracked')
      if (deps.downloadingGameIds().includes(game.id))
        return tMain('mainApp.autoCompressWait.downloading')
      if (await steamWriting(game)) return tMain('mainApp.autoCompressWait.steamWriting')
      return null
    },
    async stopReason(game) {
      if (deps.runningGameId()) return tMain('mainApp.autoCompressWait.gameRunning')
      if (await steamWriting(game)) return tMain('mainApp.autoCompressWait.steamWriting')
      return null
    }
  }
}

/**
 * How many files the folder holds, their bytes and the newest change among them (a store still writing the game
 * changes these); null when the folder cannot be read. Reparse points (junctions, links) are not followed.
 */
export async function folderActivity(dir: string): Promise<FolderActivity | null> {
  const result: FolderActivity = { files: 0, bytes: 0, newest: 0 }
  const walk = async (folder: string, top: boolean): Promise<boolean> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(folder, { withFileTypes: true })
    } catch {
      return !top
    }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        await walk(path, false)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(path).catch(() => null)
      if (!stat) continue
      result.files++
      result.bytes += stat.size
      result.newest = Math.max(result.newest, stat.mtimeMs)
    }
    return true
  }
  return (await walk(dir, true)) ? result : null
}

/** When the folder was made (ms since 1970), null when unknown. */
export async function folderCreatedAt(dir: string): Promise<number | null> {
  const stat = await fs.stat(dir).catch(() => null)
  return stat && stat.birthtimeMs > 0 ? stat.birthtimeMs : null
}
