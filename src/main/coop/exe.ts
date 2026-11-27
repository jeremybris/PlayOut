import type { CoopHandlerEntry, Game } from '@shared/types'
import { promises as fs } from 'fs'
import { basename, dirname, join, sep } from 'path'

/**
 * The game exe a Co-Op handler runs. PlayOut already knows the exe of many games (Game.exePath); when that is the
 * handler's exe it is used. Otherwise (Steam and Ubisoft games have no exePath, and a store's exe may be a launcher)
 * the install folder is searched for the handler's ExecutableName, preferring the one under its BinariesFolder.
 */

/** Folders that hold installers and redistributables, never the game. */
/** Also never the instance folders Co-Op makes ("PlayOut Co-Op" on the game's drive). */
const SKIP_DIRS =
  /^(_commonredist|__installer|redist|redistributables?|directx|vcredist|dotnet|support|\$recycle\.bin|playout co-op)$/i
const MAX_DEPTH = 8
const MAX_DIRS = 5_000

export interface ExeSearchIo {
  readdir(dir: string): Promise<{ name: string; isDirectory: boolean }[]>
  exists(path: string): Promise<boolean>
}

export const nodeExeSearchIo: ExeSearchIo = {
  async readdir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  },
  exists: (path) =>
    fs.access(path).then(
      () => true,
      () => false
    )
}

/** The exe names a handler accepts, lowercased. */
export function handlerExeNames(entry: Pick<CoopHandlerEntry, 'exeName' | 'exeNames'>): string[] {
  return [
    ...new Set([entry.exeName, ...entry.exeNames].filter(Boolean).map((n) => n!.toLowerCase()))
  ]
}

/** Whether a handler's ExecutableContext files are next to `exePath` (all of them; none required = true). */
export async function contextPresent(
  entry: Pick<CoopHandlerEntry, 'exeContext'>,
  exePath: string,
  io: ExeSearchIo = nodeExeSearchIo
): Promise<boolean> {
  for (const rel of entry.exeContext)
    if (!(await io.exists(join(dirname(exePath), rel.replace(/[\\/]+/g, sep))))) return false
  return true
}

/** Every file under `root` named one of `names` (lowercase), breadth first, bounded. */
export async function findExes(
  root: string,
  names: readonly string[],
  io: ExeSearchIo = nodeExeSearchIo
): Promise<string[]> {
  const wanted = new Set(names)
  const found: string[] = []
  let queue: string[] = [root]
  let dirs = 0
  for (let depth = 0; depth <= MAX_DEPTH && queue.length && dirs < MAX_DIRS; depth++) {
    const next: string[] = []
    for (const dir of queue) {
      if (++dirs > MAX_DIRS) break
      let entries: { name: string; isDirectory: boolean }[]
      try {
        entries = await io.readdir(dir)
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.isDirectory) {
          if (!SKIP_DIRS.test(e.name)) next.push(join(dir, e.name))
        } else if (wanted.has(e.name.toLowerCase())) found.push(join(dir, e.name))
      }
    }
    queue = next
  }
  return found
}

/** Best first: under the handler's BinariesFolder, then the shallowest, then by path. */
export function rankExes(paths: readonly string[], binariesFolder: string | undefined): string[] {
  const bin = binariesFolder
    ?.replace(/[\\/]+/g, sep)
    .replace(/^[\\/]+|[\\/]+$/g, '')
    .toLowerCase()
  const underBin = (p: string): boolean =>
    !!bin &&
    dirname(p)
      .toLowerCase()
      .endsWith(sep + bin)
  return [...paths].sort(
    (a, b) =>
      Number(underBin(b)) - Number(underBin(a)) ||
      a.split(sep).length - b.split(sep).length ||
      a.localeCompare(b)
  )
}

/**
 * The exe to run and the other candidates. `chosen` is the user's pick (Co-Op setup), used while it exists. null
 * when the game is not installed where PlayOut knows or the handler's exe is not in it.
 */
export async function resolveCoopExe(
  game: Pick<Game, 'exePath' | 'installDir'>,
  entry: Pick<CoopHandlerEntry, 'exeName' | 'exeNames' | 'exeContext' | 'binariesFolder'>,
  chosen?: string,
  io: ExeSearchIo = nodeExeSearchIo
): Promise<{ exePath: string | null; choices: string[] }> {
  const names = handlerExeNames(entry)
  const roots = [
    ...new Set([game.installDir, game.exePath ? dirname(game.exePath) : undefined].filter(Boolean))
  ] as string[]
  const found: string[] = []
  if (
    game.exePath &&
    names.includes(basename(game.exePath).toLowerCase()) &&
    (await io.exists(game.exePath))
  )
    found.push(game.exePath)
  for (const root of roots) for (const p of await findExes(root, names, io)) found.push(p)
  const unique = [...new Map(found.map((p) => [p.toLowerCase(), p])).values()]
  const withContext: string[] = []
  for (const p of unique) if (await contextPresent(entry, p, io)) withContext.push(p)
  const ranked = rankExes(withContext.length ? withContext : unique, entry.binariesFolder)
  // The exe PlayOut already knows for the game comes first when it is the handler's.
  const known = game.exePath && ranked.find((p) => p.toLowerCase() === game.exePath!.toLowerCase())
  const choices = known ? [known, ...ranked.filter((p) => p !== known)] : ranked
  if (chosen && (await io.exists(chosen)))
    return { exePath: chosen, choices: [...new Set([chosen, ...choices])] }
  return { exePath: choices[0] ?? null, choices }
}
