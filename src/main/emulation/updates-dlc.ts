// A game's updates and DLC in Emulation\Updates and DLC (ps3-hdd.ts), for "Delete from this PC" to offer along with
// the game:
// - PS3: the folders in the PS3 HDD's dev_hdd0\game named after the game's serial (its update, DLC, a PSN install,
//   its data folders). The licenses in exdata are kept (the user's choice), and so are the saves (in saves\rpcs3).
// - Switch and Xbox 360: the files and folders in Updates and DLC\Switch / \Xbox360 that belong to the game: by title
//   id when both names carry one (Switch 0100XXXXXXXXX..., an Xbox 360 title id), else by a similar name ("Zelda BOTW
//   [Update v1.6.0].nsp" for "Zelda BOTW.xci"). An entry several library games match goes to the closest name only, and
//   never to two games.

import type { Dirent } from 'fs'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { activePs3HddDir, isPs3GameFolderOf, ps3TitleIds, updatesDlcDir } from './ps3-hdd'

/** A game as this needs it: its system and its ROM's path (file or folder). */
export interface UpdatesDlcGame {
  id: string
  systemId: string
  romPath: string
}

/** One update or DLC of a game: what goes to the Recycle Bin, and its size when known. */
export interface UpdatesDlcItem {
  path: string
  bytes: number | null
}

/** Systems with an Updates and DLC folder: its name there. */
const CONSOLE_FOLDER: Record<string, string> = {
  switch: 'Switch',
  ps3: 'PS3',
  xbox360: 'Xbox360'
}

export function hasUpdatesDlc(systemId: string): boolean {
  return systemId in CONSOLE_FOLDER
}

/** A Switch title id (16 hex digits, 0100...) in a name, upper case. */
function switchTitleId(name: string): string | null {
  return /(?:^|[^0-9a-f])(01[0-9a-f]{14})(?![0-9a-f])/i.exec(name)?.[1]?.toUpperCase() ?? null
}

/**
 * The base game a Switch title id belongs to: the id with its low 13 bits cleared (an update is the base id + 0x800,
 * a DLC base + 0x1000 + n with n up to 0xFFF; the bits above stay the game's own, so 0100ABCD12342000 is another game
 * than 0100ABCD12340000).
 */
export function switchGameKey(tid: string): string {
  const last = parseInt(tid[12]!, 16) & 0xe
  return `${tid.slice(0, 12)}${last.toString(16).toUpperCase()}000`
}

/** An Xbox 360 title id (8 hex digits with a letter, e.g. 4D5307E6) in a name, upper case. */
function xboxTitleId(name: string): string | null {
  for (const m of name.matchAll(/(?:^|[^0-9a-f])([0-9a-f]{8})(?![0-9a-f])/gi)) {
    const id = m[1]!.toUpperCase()
    // A bare number (a date, a size) is not a title id: those have letters.
    if (/[A-F]/.test(id)) return id
  }
  return null
}

const NOISE_WORDS = new Set([
  'update',
  'updates',
  'upd',
  'dlc',
  'patch',
  'tu',
  'title',
  'the',
  'base'
])

/**
 * A name reduced to the words that name the game: no extension, no [..] / (..) / {..} tags, no version numbers
 * ("v1.6.0", "v65536"), no "Update" / "DLC" words, lower case, accents and punctuation gone.
 */
export function gameWords(name: string, isFile: boolean): string[] {
  let n = isFile ? basename(name, extname(name)) : basename(name)
  n = n
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    // Versions ("v1.6.0", "1.0.2", "v65536"): not part of the game's name; a lone number ("Halo 3") is.
    .replace(/\bv?\d+(?:\.\d+)+\b|\bv\d+\b/gi, ' ')
  n = n.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[_.]+/g, ' ')
  return n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NOISE_WORDS.has(w))
}

/** How closely an entry's name matches a game's (0 = not at all): title ids first, else whole words from the start. */
function matchScore(
  systemId: string,
  game: { name: string; isFile: boolean },
  entry: { name: string; isFile: boolean }
): number {
  if (systemId === 'switch') {
    const a = switchTitleId(game.name)
    const b = switchTitleId(entry.name)
    if (a && b) return switchGameKey(a) === switchGameKey(b) ? 1000 : 0
  } else if (systemId === 'xbox360') {
    const a = xboxTitleId(game.name)
    const b = xboxTitleId(entry.name)
    if (a && b) return a === b ? 1000 : 0
  }
  const g = gameWords(game.name, game.isFile)
  const e = gameWords(entry.name, entry.isFile)
  // A name too short to tell games apart ("DLC.nsp", one letter) matches nothing. Otherwise the names must be the
  // same once tags, versions and "Update" / "DLC" are left out: "Doom" never claims "DOOM Eternal [Update]" (a game
  // that may not be in the library to stand up for its own files).
  if (g.join('').length < 3 || e.length !== g.length) return 0
  for (let i = 0; i < g.length; i++) if (g[i] !== e[i]) return 0
  return 100 + g.length * 10
}

async function entriesOf(dir: string): Promise<Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
}

/** Bytes under a path (links not followed); null when unreadable. */
async function sizeOf(path: string): Promise<number | null> {
  try {
    const st = await fs.lstat(path)
    if (st.isSymbolicLink()) return 0
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const e of await entriesOf(path)) {
      const s = await sizeOf(join(path, e.name))
      if (s === null) return null
      total += s
    }
    return total
  } catch {
    return null
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await fs.stat(path).catch(() => null))?.isFile() ?? false
}

/**
 * The updates and DLC of `game` in `emulationDir`\Updates and DLC (see the top of this file). `others`: the other
 * library games, so an entry two games could claim goes to the closest one only, and a PS3 serial another game shares
 * is left alone. Never throws: an unreadable folder lists nothing.
 */
export async function updatesDlcOf(
  game: UpdatesDlcGame,
  emulationDir: string,
  others: readonly UpdatesDlcGame[]
): Promise<UpdatesDlcItem[]> {
  const folder = CONSOLE_FOLDER[game.systemId]
  if (!folder) return []
  const out: UpdatesDlcItem[] = []
  try {
    if (game.systemId === 'ps3') {
      const ids = (await ps3TitleIds(game.romPath)).map((id) => id.toUpperCase())
      if (!ids.length) return []
      // A serial another PS3 game of the library has too (two copies of one game) keeps its folders.
      const shared = new Set<string>()
      for (const o of others)
        if (o.systemId === 'ps3' && o.id !== game.id)
          for (const id of await ps3TitleIds(o.romPath))
            if (ids.includes(id.toUpperCase())) shared.add(id.toUpperCase())
      const own = ids.filter((id) => !shared.has(id))
      if (!own.length) return []
      const gameDir = join(await activePs3HddDir(emulationDir), 'dev_hdd0', 'game')
      for (const e of await entriesOf(gameDir)) {
        if (!e.isDirectory() || e.isSymbolicLink() || !isPs3GameFolderOf(e.name, own)) continue
        const path = join(gameDir, e.name)
        out.push({ path, bytes: await sizeOf(path) })
      }
      return out
    }
    const dir = join(updatesDlcDir(emulationDir), folder)
    const self = { name: basename(game.romPath), isFile: await isFile(game.romPath) }
    const rivals = await Promise.all(
      others
        .filter((o) => o.systemId === game.systemId && o.id !== game.id)
        .map(async (o) => ({ name: basename(o.romPath), isFile: await isFile(o.romPath) }))
    )
    for (const e of await entriesOf(dir)) {
      if (e.isSymbolicLink() || /\.playout-(new|old(-\d+)?|part)$/i.test(e.name)) continue
      const entry = { name: e.name, isFile: e.isFile() }
      const mine = matchScore(game.systemId, self, entry)
      if (!mine) continue
      // Another game that matches as well or better keeps it out (never deleted with the wrong game).
      if (rivals.some((r) => matchScore(game.systemId, r, entry) >= mine)) continue
      const path = join(dir, e.name)
      out.push({ path, bytes: await sizeOf(path) })
    }
  } catch {
    return out
  }
  return out
}
