import { promises as fs } from 'fs'
import { basename, isAbsolute, join, resolve } from 'path'
import type { Game } from '../../shared/types'
import { collectExecutables, rankCandidates } from '../providers/manual'
import {
  isInsideDir,
  isNotGameExe,
  nodeOptiScalerIo,
  pickShippingExe,
  type OptiScalerIo
} from '../upgrades/optiscaler'

/**
 * The program PeerParty starts for a game: PeerParty takes the game's exe on its command line (an Xbox app game: any
 * exe in its package folder; PeerParty finds the package from it).
 */

/** The file operations resolvePeerPartyExe uses (tests pass a fake). */
export interface ExeIo {
  readdir: OptiScalerIo['readdir']
  /** Whether a path is a file. */
  isFile(path: string): Promise<boolean>
  /** A small text file, or null when it cannot be read. */
  readText(path: string): Promise<string | null>
  /** The ranked exes near the top of a folder (default: providers/manual's scan). */
  rankedExes?(dir: string): Promise<string[]>
}

export const nodeExeIo: ExeIo = {
  readdir: nodeOptiScalerIo.readdir,
  async isFile(path) {
    return fs.stat(path).then(
      (s) => s.isFile(),
      () => false
    )
  },
  async readText(path) {
    try {
      return await fs.readFile(path, 'utf8')
    } catch {
      return null
    }
  },
  async rankedExes(dir) {
    return rankCandidates(basename(dir), await collectExecutables(dir, 3)).map((c) => c.path)
  }
}

/** The `Executable Name="…"` of a MicrosoftGame.config (the first one), as PeerParty's packaged.rs reads it. */
export function gameConfigExecutable(text: string): string | null {
  const m = /<Executable\b[^>]*\bName\s*=\s*"([^"]+)"/i.exec(text)
  return m ? m[1]!.trim() : null
}

/**
 * The absolute path of the program PeerParty should start, always inside the game's folder, or null:
 * 1. an Xbox app game: MicrosoftGame.config's Executable, else its known exe;
 * 2. the game's known exe (Epic's LaunchExecutable, GOG, a manual game) when it is not a launcher;
 * 3. the file of an exec launch;
 * 4. Unreal's `*-Win64-Shipping.exe` under Binaries (not under Engine);
 * 5. the most likely exe near the top of the folder.
 */
export async function resolvePeerPartyExe(
  game: Pick<Game, 'source' | 'installDir' | 'exePath' | 'launch'>,
  io: ExeIo = nodeExeIo
): Promise<string | null> {
  const dir = game.installDir
  if (!dir) return null
  const inside = async (path: string | undefined): Promise<string | null> => {
    if (!path) return null
    const full = isAbsolute(path) ? resolve(path) : resolve(dir, path)
    return /\.exe$/i.test(full) && isInsideDir(dir, full) && (await io.isFile(full)) ? full : null
  }

  if (game.source === 'xbox') {
    const config = await io.readText(join(dir, 'MicrosoftGame.config'))
    const named = config ? gameConfigExecutable(config) : null
    const fromConfig = await inside(named ?? undefined)
    if (fromConfig) return fromConfig
    const known = await inside(game.exePath)
    if (known) return known
  }
  if (game.exePath && !isNotGameExe(basename(game.exePath))) {
    const known = await inside(game.exePath)
    if (known) return known
  }
  if (game.launch.kind === 'exec') {
    const file = await inside(game.launch.file)
    if (file && !isNotGameExe(basename(file))) return file
  }
  const shipping = await pickShippingExe(dir, { readdir: io.readdir })
  if (shipping && isInsideDir(dir, shipping)) return shipping
  const ranked = (await (io.rankedExes ?? nodeExeIo.rankedExes!)(dir)).filter((p) =>
    isInsideDir(dir, p)
  )
  return ranked[0] ?? null
}
