// A game's updates and DLC in Emulation\Updates and DLC (ps3-hdd.ts), for "Delete from this PC" to offer along with
// the game:
// - PS3: the folders in the PS3 HDD's dev_hdd0\game named after the game's serial (its update, DLC, a PSN install,
//   its data folders). The licenses in exdata are kept (the user's choice), and so are the saves (in saves\rpcs3).
// - Switch and Xbox 360: the files and folders in Updates and DLC\Switch / \Xbox360 that belong to the game: by title
//   id when both names carry one (Switch 0100XXXXXXXXX..., an Xbox 360 title id), else by a similar name ("Zelda BOTW
//   [Update v1.6.0].nsp" for "Zelda BOTW.xci"). An entry several library games match goes to the closest name only, and
//   never to two games (copies of one game, the same title id, share it: sent with each, deleted with none). Plain
//   organizing subfolders (Switch\Updates, Switch\DLC\Part 1) are looked into, a few levels deep.
// - "Delete from this PC" takes only the exact matches (the same title id, the same name); the looser ones (a subtitle,
//   a DLC named after the game with its own name after it) only ever go with a host's download, never deleted.
// A host's ROM download sends the same Switch / Xbox 360 entries along with the game (updatesDlcEntriesFor, used by
// streaming-service.ts), so the client gets them in its own Updates and DLC\Switch / \Xbox360.

import type { Dirent } from 'fs'
import { promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { activePs3HddDir, isPs3GameFolderOf, ps3TitleIds, updatesDlcDir } from './ps3-hdd'

/** A game as this needs it: its system and its ROM's path (file or folder). */
export interface UpdatesDlcGame {
  id: string
  systemId: string
  romPath: string
  /**
   * Other names of the game (its card title, the title the user gave it): an entry may match any of them as well as
   * the ROM's file name ("The Legend of Zelda: Tears of the Kingdom" for "TotK [0100F2C0115B6000].xci").
   */
  titles?: readonly string[]
  /** Title ids already known for the game (read from its image, its folder): matched like the ids in its names. */
  ids?: readonly string[]
}

/** One entry of Updates and DLC\<Console> that belongs to a game. */
export interface UpdatesDlcEntry {
  /** Its absolute path. */
  path: string
  /** Its path in the console folder, '/'-separated ('Game [Update].nsp', 'Updates/Game [Update].nsp'). */
  name: string
  isFile: boolean
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

/**
 * An Xbox 360 title id (8 hex digits with a letter, e.g. 4D5307E6) in a name, upper case. A collection's CRC tag
 * ("[AB12CD34]") looks the same: matchScore lets the names decide when two such ids differ.
 */
function xboxTitleId(name: string): string | null {
  for (const m of name.matchAll(/(?:^|[^0-9a-f])([0-9a-f]{8})(?![0-9a-f])/gi)) {
    const id = m[1]!.toUpperCase()
    // A bare number (a date, a size) is not a title id: those have letters.
    if (/[A-F]/.test(id)) return id
  }
  return null
}

/** The title id reader of a system (Switch, Xbox 360), or null. */
function idReaderOf(systemId: string): ((name: string) => string | null) | null {
  return systemId === 'switch' ? switchTitleId : systemId === 'xbox360' ? xboxTitleId : null
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
 * ("v1.6.0", "v65536"), no numbered update ("TU2", "Title Update 2"), no "Update" / "DLC" words, lower case, accents
 * and punctuation gone.
 */
export function gameWords(name: string, isFile: boolean): string[] {
  let n = isFile ? basename(name, extname(name)) : basename(name)
  n = n
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    // A numbered update or DLC ("TU2", "TU 2", "Title Update 2", "Update 3", "Patch 1", "DLC 2"): the number is the
    // update's, not the game's.
    .replace(
      /(?<![a-z0-9])(?:tu|title[\s_.-]*update|update|upd|patch|dlc)[\s_.-]*\d+(?![a-z0-9.])/gi,
      ' '
    )
    // Versions ("v1.6.0", "1.0.2", "v65536"): not part of the game's name; a lone number ("Halo 3") is.
    .replace(/\bv?\d+(?:\.\d+)+\b|\bv\d+\b/gi, ' ')
  n = n.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[_.]+/g, ' ')
  return n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NOISE_WORDS.has(w))
}

/**
 * Words that may stand next to a game's name in an update's or DLC's file name without making it another game's: the
 * region, the language, the format, where it came from ("Tears of the Kingdom US NSP nsw2u com"). Left out of both
 * names for the "similar" comparisons below; never for the exact one.
 */
const EXTRA_WORDS = new Set([
  'us',
  'usa',
  'na',
  'eu',
  'eur',
  'europe',
  'uk',
  'jp',
  'jpn',
  'japan',
  'asia',
  'world',
  'en',
  'eng',
  'english',
  'multi',
  'nsw',
  'switch',
  'nsp',
  'nsz',
  'xci',
  'xcz',
  'xbox',
  'xbox360',
  'version',
  'ver',
  'rev',
  'latest',
  'nsw2u',
  'www',
  'com',
  'net',
  'org'
])

/** A name's words for the similar comparisons: gameWords without the EXTRA_WORDS. */
function looseWords(words: readonly string[]): string[] {
  return words.filter((w) => !EXTRA_WORDS.has(w))
}

/** Whether `run` is the first words of `words` (and shorter). */
function startsWith(words: readonly string[], run: readonly string[]): boolean {
  return run.length < words.length && run.every((w, i) => words[i] === w)
}

/** A run of words long enough to name one game on its own ("tears of kingdom"; never "mario party"). */
function distinctive(run: readonly string[]): boolean {
  return run.length >= 3 && run.join('').length >= 10
}

/** A DLC's own marker in a name: the word "DLC" or "Add-on" ("Xenoblade Chronicles 3 Future Redeemed DLC"). */
function hasDlcMarker(name: string): boolean {
  return /(?<![a-z0-9])(?:dlc|add[\s_-]?ons?)(?![a-z])/i.test(name)
}

/**
 * The words of a name's subtitle: what follows its first ": " / " - " ("Tears of the Kingdom" in "The Legend of
 * Zelda: Tears of the Kingdom"); null without one.
 */
function subtitleWords(name: string, isFile: boolean): string[] | null {
  const base = isFile ? basename(name, extname(name)) : basename(name)
  const at = /:\s|\s[-–—]\s/.exec(base)
  if (!at) return null
  const words = looseWords(gameWords(base.slice(at.index + at[0].length), false))
  return words.length ? words : null
}

/** An exact match (the same id, the same name): below it, a looser one a download sends but a delete never takes. */
export const EXACT_MATCH = 90
const ID_MATCH = 1000

/**
 * How closely an entry's name matches one of a game's names (0 = not at all), from the closest down:
 * - 100+: the same words once tags, versions and "Update" / "DLC" are left out ("Metroid Dread [Update v2.1.0].nsp").
 * - 90+: the same once the region, language and format words are left out too ("Metroid Dread US NSP Update.nsp").
 * - 60+ (sent only): a DLC named after the game with its own name after it, carrying "DLC" ("Xenoblade Chronicles 3
 *   Future Redeemed DLC.nsp" for "Xenoblade Chronicles 3"), when the game's name is three words or more.
 * - 50+ (sent only): the game's name without its series in front, when the game's name has a subtitle and what is
 *   left is at least that subtitle ("Tears of the Kingdom Update.nsp", "Zelda - Tears of the Kingdom DLC.nsp" for
 *   "The Legend of Zelda: Tears of the Kingdom").
 * Never with other words in front: "Street Fighter IV" never claims "Super Street Fighter IV [TU1]", nor "Doom"
 * "DOOM Eternal [Update]" (a game that may not be in the library to stand up for its own files); nor with other
 * words after it without "DLC": "Halo 3" never claims "Halo 3 ODST [TU2]", nor "Mario Kart 8" "Mario Kart 8 Deluxe".
 */
function nameScore(
  game: { name: string; isFile: boolean },
  entry: { name: string; isFile: boolean }
): number {
  const g = gameWords(game.name, game.isFile)
  const e = gameWords(entry.name, entry.isFile)
  // A name too short to tell games apart ("DLC.nsp", one letter) matches nothing.
  if (g.join('').length < 3 || e.join('').length < 3) return 0
  if (e.length === g.length && g.every((w, i) => e[i] === w)) return 100 + g.length * 10
  const gl = looseWords(g)
  const el = looseWords(e)
  if (gl.join('').length < 3 || el.join('').length < 3) return 0
  if (el.length === gl.length && gl.every((w, i) => el[i] === w)) return EXACT_MATCH + gl.length
  if (distinctive(gl) && startsWith(el, gl) && hasDlcMarker(entry.name)) return 60 + gl.length
  const sub = subtitleWords(game.name, game.isFile)
  if (
    sub &&
    distinctive(sub) &&
    el.length >= sub.length &&
    el.length < gl.length &&
    el.every((w, i) => gl[gl.length - el.length + i] === w)
  )
    return 50 + el.length
  return 0
}

/** A game as it is matched: its names (the ROM's file or folder name first) and the title ids known for it. */
interface Matchable {
  names: readonly string[]
  isFile: boolean
  ids: readonly string[]
}

/** How closely an entry matches a game (0 = not at all): title ids first, else the closest of its names. */
function matchScore(
  systemId: string,
  game: Matchable,
  entry: { name: string; isFile: boolean }
): number {
  const idOf = idReaderOf(systemId)
  let idsDiffer = false
  if (idOf) {
    const b = idOf(entry.name)
    if (b && game.ids.length) {
      const key = (id: string): string => (systemId === 'switch' ? switchGameKey(id) : id)
      if (game.ids.some((a) => key(a) === key(b))) return ID_MATCH
      idsDiffer = true
    }
  }
  let best = 0
  game.names.forEach((name, i) => {
    // Only the ROM's own name (the first) is a file name with an extension.
    const score = nameScore({ name, isFile: i === 0 && game.isFile }, entry)
    if (score > best) best = score
  })
  // Two different title ids: a Switch id decides alone (the same name with another id is another region's, or another
  // game's). An Xbox 360 "id" may be a collection's CRC tag on the ROM: only the very same name still matches then.
  if (idsDiffer) return systemId === 'xbox360' && best >= 100 ? best : 0
  return best
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
 * The updates and DLC of `game` in `emulationDir`\Updates and DLC (see the top of this file), for "Delete from this
 * PC": exact matches only. `others`: the other library games, so an entry two games could claim goes to the closest
 * one only, and an entry or a PS3 serial another game shares (a copy of this one) is left alone. Never throws: an
 * unreadable folder lists nothing.
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
    const entries = await updatesDlcEntriesFor(game, emulationDir, others, { purpose: 'delete' })
    for (const e of entries) out.push({ path: e.path, bytes: await sizeOf(e.path) })
  } catch {
    return out
  }
  return out
}

/** The names a game is matched by (its ROM's file or folder name first, then its titles), and its title ids. */
async function namesOf(game: UpdatesDlcGame): Promise<Matchable> {
  const names = [basename(game.romPath)]
  for (const t of game.titles ?? []) if (t && !names.includes(t)) names.push(t)
  const ids = new Set<string>((game.ids ?? []).map((id) => id.toUpperCase()))
  const idOf = idReaderOf(game.systemId)
  if (idOf) {
    const own = idOf(names[0]!)
    if (own) ids.add(own)
    // Its folder's name ("Zelda TotK [0100F2C0115B6000]\game.xci"): a Switch id anywhere in it, an Xbox 360 id only as
    // the whole name (a folder's other 8-digit tags are not ids).
    const folder = basename(dirname(game.romPath))
    const inFolder = idOf(folder)
    if (inFolder && (game.systemId === 'switch' || inFolder === folder.toUpperCase()))
      ids.add(inFolder)
  }
  return { names, isFile: await isFile(game.romPath), ids: [...ids] }
}

/** How deep plain organizing subfolders (Switch\Updates\Part 1) are looked into. */
const MAX_FOLDER_DEPTH = 3
/** At most this many names are looked at in one console folder (a stray huge tree is not walked whole). */
const MAX_LISTED = 20_000

/** PlayOut's own copies in progress or set aside, and half-downloaded files: never matched or sent. */
const IN_PROGRESS = /\.(playout-(new|old(-\d+)?|part)|part)$/i

/**
 * The entries of Updates and DLC\Switch or \Xbox360 (files or folders) that belong to a Switch or Xbox 360 `game`
 * (see the top of this file); [] for other systems. A subfolder that names no game and has no title id (an organizing
 * folder: "Updates", "DLC", "Part 1") is looked into, MAX_FOLDER_DEPTH levels deep. `others`: the other library games
 * of the system, so an entry two games could claim goes to the closest one only, and to none on a tie, except copies
 * of one game (the same title id): `purpose` 'send' gives it to each, 'delete' to none (the other copy still needs
 * it). 'delete' also takes only exact matches (EXACT_MATCH). Never throws: an unreadable folder lists nothing.
 */
export async function updatesDlcEntriesFor(
  game: UpdatesDlcGame,
  emulationDir: string,
  others: readonly UpdatesDlcGame[],
  options: { purpose?: 'send' | 'delete' } = {}
): Promise<UpdatesDlcEntry[]> {
  const folder = CONSOLE_FOLDER[game.systemId]
  if (!folder || game.systemId === 'ps3') return []
  const purpose = options.purpose ?? 'send'
  const out: UpdatesDlcEntry[] = []
  try {
    const root = join(updatesDlcDir(emulationDir), folder)
    const top = await entriesOf(root)
    if (!top.length) return out
    const self = await namesOf(game)
    const rivals = await Promise.all(
      others.filter((o) => o.systemId === game.systemId && o.id !== game.id).map(namesOf)
    )
    const idOf = idReaderOf(game.systemId)
    let listed = 0
    const walk = async (dir: string, rel: string, list: Dirent[], depth: number): Promise<void> => {
      for (const e of list) {
        if (++listed > MAX_LISTED) return
        if (e.isSymbolicLink() || IN_PROGRESS.test(e.name)) continue
        if (!e.isFile() && !e.isDirectory()) continue
        const entry = { name: e.name, isFile: e.isFile() }
        const name = rel ? `${rel}/${e.name}` : e.name
        const mine = matchScore(game.systemId, self, entry)
        const theirs = rivals.map((r) => matchScore(game.systemId, r, entry))
        if (!mine) {
          // A folder that names no game and carries no title id: an organizing folder, looked into.
          if (
            e.isDirectory() &&
            depth < MAX_FOLDER_DEPTH &&
            !idOf?.(e.name) &&
            theirs.every((s) => !s)
          ) {
            const path = join(dir, e.name)
            await walk(path, name, await entriesOf(path), depth + 1)
          }
          continue
        }
        if (purpose === 'delete' && mine < EXACT_MATCH) continue
        // Another game that matches as well or better keeps it out (never deleted or sent with the wrong game), except
        // another copy of this game (the same title id) when sending: each copy gets it.
        const sameGame = (s: number): boolean =>
          purpose === 'send' && mine === ID_MATCH && s === ID_MATCH
        if (theirs.some((s) => s >= mine && !sameGame(s))) continue
        out.push({ path: join(dir, e.name), name, isFile: entry.isFile })
      }
    }
    await walk(root, '', top, 0)
  } catch {
    return out
  }
  return out
}

/**
 * The name a game's Switch / Xbox 360 updates and DLC carry in a host's download list ('Updates and DLC/Switch/...'):
 * the client puts them in its own Emulation\Updates and DLC. (A PS3 game's go as 'PS3 HDD/...', ps3-hdd.ts.)
 */
export const UPDATES_DLC_AREA = 'Updates and DLC'

/** The console folders whose entries travel with a game (PS3's dev_hdd0 has its own area). */
const TRANSFER_FOLDERS = ['switch', 'xbox360']

/**
 * The paths a download may carry in Updates and DLC, as segments below it: Switch/<entry>[/...] or
 * Xbox360/<entry>[/...]. Anything else (the PS3 HDD, a file at the top) is refused on both PCs.
 */
export function isUpdatesDlcTransferPath(segments: readonly string[]): boolean {
  return (
    segments.length >= 2 &&
    TRANSFER_FOLDERS.includes(segments[0]!.toLowerCase()) &&
    segments.every((s) => s.length > 0)
  )
}

/** One file of a game's Switch / Xbox 360 updates and DLC to send with it. */
export interface UpdatesDlcFile {
  /** Below Updates and DLC, '/'-separated ('Switch/Game [Update].nsp', 'Xbox360/4D5307E6/000B0000/TU.bin'). */
  path: string
  size: number
  /** Last modified (ms): a newer copy already on the client is kept. */
  mtimeMs: number
}

/** More than any game's updates and DLC hold: an entry that would go past it is left out whole, with a warning. */
const MAX_TRANSFER_FILES = 50_000

/**
 * The files of a Switch or Xbox 360 game's updates and DLC (updatesDlcEntriesFor), whole folders included, for a
 * host to send with the game. Links are never followed; PlayOut's own copies in progress are left out. An entry whose
 * files would go past `maxFiles` is left out whole (never half a folder), and `warn` says so.
 */
export async function updatesDlcFiles(
  game: UpdatesDlcGame,
  emulationDir: string,
  others: readonly UpdatesDlcGame[],
  warn?: (message: string) => void,
  maxFiles = MAX_TRANSFER_FILES
): Promise<UpdatesDlcFile[]> {
  const files: UpdatesDlcFile[] = []
  const folder = CONSOLE_FOLDER[game.systemId]
  if (!folder) return files
  for (const e of await updatesDlcEntriesFor(game, emulationDir, others)) {
    const own: UpdatesDlcFile[] = []
    let over = false
    const add = async (abs: string, rel: string): Promise<void> => {
      if (over) return
      const st = await fs.lstat(abs).catch(() => null)
      if (!st || st.isSymbolicLink()) return
      if (st.isFile()) {
        if (files.length + own.length >= maxFiles) over = true
        else own.push({ path: rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
        return
      }
      if (!st.isDirectory()) return
      for (const c of await entriesOf(abs)) {
        // A half-downloaded file (<name>.part, <name>.t<time>.part: rom-transfer.ts) is not one to send.
        if (IN_PROGRESS.test(c.name)) continue
        await add(join(abs, c.name), `${rel}/${c.name}`)
      }
    }
    await add(e.path, `${folder}/${e.name}`)
    if (over) {
      warn?.(`${folder}/${e.name} has too many files (over ${maxFiles} in all): left out`)
      continue
    }
    files.push(...own)
  }
  return files
}
