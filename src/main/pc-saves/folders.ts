// Which folders may be a PC game's save folder (PC Saves). The copy restores into this folder and, on a restore, deletes
// the files in it the copy does not have, so anything broader than one game's saves is refused: drive roots and the
// folders right below them, the profile (and other users' profiles), AppData and its Local / Roaming / LocalLow,
// Documents, Saved Games, My Games, Desktop, Downloads, Pictures, Videos, Music and OneDrive themselves (and anything
// above them), network, device and stream paths (\\server\share, \\?\C:\..., C:\folder::$INDEX_ALLOCATION: aliases the
// path rules cannot see through), a folder holding the game's programs, links and junctions (the folder itself, one
// above it or one inside it), PlayOut's own folders, and a folder another game already copies. Sizes are checked here
// too (and again on every copy, by cloud.ts).
import { promises as fs } from 'fs'
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from 'path'
import { isWritableSaveRoot, MAX_SYNC_BYTES } from '../recomp/cloud'
import { isSafeSaveRoot, listSaveFiles, MAX_SAVE_FILES, type SaveFile } from '../recomp/saves'
import { isInside, normalizePath, type KnownFolders } from '../util/paths'
import { tMain } from '../i18n'

export interface SaveFolderRules {
  folders: KnownFolders
  /** The user's Documents folder (it may be redirected to OneDrive). */
  documents?: string
  /** The game's install folder (or its program's folder). */
  install: string | null
  /** The game's program. */
  exePath: string | null
  /** PlayOut's own folders: the Emulation folder, its data folder, its install folder, Recompilations, Emulators. */
  own: string[]
  /** The save folders other games use already. */
  others: { title: string; folder: string }[]
}

/** Files that make a folder a program's, not a save folder. */
const PROGRAM_EXT = new Set(['.exe', '.dll'])

const overlaps = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a)

/** The profile's personal folders, never one game's saves (each refused itself, and anything above it). */
const PERSONAL = [
  'Desktop',
  'Downloads',
  'Pictures',
  'Videos',
  'Music',
  'OneDrive',
  'Favorites',
  'Contacts',
  'Links',
  'Searches'
]

function personalFolders(rules: SaveFolderRules): string[] {
  const home = rules.folders.userProfile
  const out = PERSONAL.map((n) => join(home, n))
  const env = process.env
  for (const od of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]) {
    if (!od || !isAbsolute(od)) continue
    out.push(od, ...['Documents', 'Desktop', 'Pictures', 'Music', 'Videos'].map((n) => join(od, n)))
  }
  return out
}

/** Why `path` cannot be a save folder (a translated sentence), or null. Only checks the path itself (no disk). */
export function refusePath(path: string, rules: SaveFolderRules): string | null {
  // \\server\share (\\localhost\C$ is C:\ again), \\?\ and \\.\ device paths, and "folder::$INDEX_ALLOCATION" streams
  // name folders the rules below would not recognise.
  if (/^[\\/]{2}/.test(path) || path.indexOf(':', 2) !== -1)
    return tMain('mainPcSaves.folder.notPlain')
  if (!isAbsolute(path)) return tMain('mainPcSaves.folder.notAbsolute')
  const p = resolve(path)
  const ctx = { install: rules.install ?? '', folders: rules.folders, documents: rules.documents }
  if (!isSafeSaveRoot(p, ctx) || !isWritableSaveRoot(p)) return tMain('mainPcSaves.folder.tooBroad')
  if (personalFolders(rules).some((g) => isInside(p, g)))
    return tMain('mainPcSaves.folder.tooBroad')
  // A folder right below a drive root (D:\Stuff), or another user's profile.
  const parent = dirname(p)
  if (parent === parse(p).root) return tMain('mainPcSaves.folder.tooBroad')
  if (normalizePath(parent) === normalizePath(dirname(resolve(rules.folders.userProfile))))
    return tMain('mainPcSaves.folder.tooBroad')
  if (rules.exePath && isInside(p, rules.exePath)) return tMain('mainPcSaves.folder.holdsGame')
  if (rules.own.some((o) => o && overlaps(o, p))) return tMain('mainPcSaves.folder.ownFolder')
  const other = rules.others.find((o) => overlaps(o.folder, p))
  if (other) return tMain('mainPcSaves.folder.usedBy', { title: other.title })
  return null
}

/** The folder's saves: their size and count, or a translated refusal. */
export interface FolderMeasure {
  files: SaveFile[]
  bytes: number
}

/** Entries looked at for links before giving up (the file count limit refuses such a folder anyway). */
const MAX_LINK_SCAN = MAX_SAVE_FILES * 2

/**
 * The first link or junction inside `dir` (its path below `dir`), or null. The save listing skips links, so saves
 * behind one would never be copied, and a restore would write through it into another folder.
 */
export async function findLinkInside(dir: string): Promise<string | null> {
  const stack = [dir]
  let seen = 0
  while (stack.length) {
    const d = stack.pop()!
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (++seen > MAX_LINK_SCAN) return null
      const p = join(d, e.name)
      if (e.isSymbolicLink()) return relative(dir, p)
      if (e.isDirectory()) stack.push(p)
    }
  }
  return null
}

/**
 * Check `path` on disk: a real folder (not a link or junction, nor reached through one, nor holding one, which a
 * restore would write through), not holding programs, at most MAX_SAVE_FILES files and MAX_SYNC_BYTES. Throws a
 * translated error when refused. Run when the folder is chosen and again before every copy.
 */
export async function checkSaveFolder(
  path: string,
  rules: SaveFolderRules
): Promise<FolderMeasure> {
  const refused = refusePath(path, rules)
  if (refused) throw new Error(refused)
  const p = resolve(path)
  let st: Awaited<ReturnType<typeof fs.lstat>>
  try {
    st = await fs.lstat(p)
  } catch {
    throw new Error(tMain('mainPcSaves.folder.notFolder', { path: p }))
  }
  if (st.isSymbolicLink()) throw new Error(tMain('mainPcSaves.folder.link'))
  if (!st.isDirectory()) throw new Error(tMain('mainPcSaves.folder.notFolder', { path: p }))
  // A folder reached through a junction, a mapped or substituted drive above it is another folder than it says
  // (fs.promises.realpath is the native call: it sees through all of them).
  const real = await fs.realpath(p).catch(() => p)
  if (normalizePath(real) !== normalizePath(p)) throw new Error(tMain('mainPcSaves.folder.link'))
  const link = await findLinkInside(p)
  if (link) throw new Error(tMain('mainPcSaves.folder.holdsLink', { name: link }))
  let files: SaveFile[]
  try {
    files = await listSaveFiles([p])
  } catch (err) {
    const tooMany = tMain('mainRecomp.saves.tooManyFiles', { folder: p, max: MAX_SAVE_FILES })
    if (err instanceof Error && err.message === tooMany)
      throw new Error(tMain('mainPcSaves.folder.tooManyFiles', { max: MAX_SAVE_FILES }), {
        cause: err
      })
    throw err
  }
  if (files.some((f) => PROGRAM_EXT.has(extname(f.rel).toLowerCase())))
    throw new Error(tMain('mainPcSaves.folder.holdsPrograms'))
  const bytes = files.reduce((n, f) => n + f.size, 0)
  if (bytes > MAX_SYNC_BYTES)
    throw new Error(
      tMain('mainPcSaves.folder.tooLarge', {
        size: Math.round(bytes / 1048576),
        max: MAX_SYNC_BYTES / 1048576
      })
    )
  return { files, bytes }
}

/**
 * Whether the folder that holds a save folder that is gone is still there, as itself (not through a link): then the
 * game has only not made its save folder (again), and it may be made. Otherwise the folder moved (the game with it).
 */
export async function parentStillThere(folder: string): Promise<boolean> {
  const parent = dirname(resolve(folder))
  const st = await fs.lstat(parent).catch(() => null)
  if (!st?.isDirectory() || st.isSymbolicLink()) return false
  const real = await fs.realpath(parent).catch(() => null)
  return real !== null && normalizePath(real) === normalizePath(parent)
}
