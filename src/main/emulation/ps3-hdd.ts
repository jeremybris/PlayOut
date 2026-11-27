import { promises as fs } from 'fs'
import { basename, extname, join, parse } from 'path'
import type { Logger } from '../logger'
import { mergeFolderInto } from '../emulator-setup/junction'
import { rpcs3Target, type ReadShortcut } from './launch-command'
import { readSmall, sfoString } from './sfo'
import { tMain } from '../i18n'

export { sfoFileString, sfoString } from './sfo'

/**
 * Games' updates and DLC: Emulation\Updates and DLC, one folder per console (Switch, PS3, Xbox360). It is left out of
 * the Emulation folder sync; a game downloaded from a host brings its own part instead (ps3HddFiles for the PS3).
 *
 * The PS3 hard drive RPCS3 uses is Emulation\Updates and DLC\PS3\dev_hdd0 (RPCS3's vfs.yml points /dev_hdd0/ at it).
 * It holds what RPCS3 installs for a game: its updates and DLC (dev_hdd0\game\<serial>, a PSN game itself too) and
 * their licenses (exdata). Before 0.1.120 it was Emulation\roms\PS3 HDD; movePs3HddToUpdates moves it.
 */

/** The folder in the Emulation folder that holds games' updates and DLC. */
export const UPDATES_DLC_FOLDER = 'Updates and DLC'

/** Its folder per console. */
export const UPDATES_DLC_CONSOLES = ['Switch', 'PS3', 'Xbox360'] as const

/** The PS3 HDD's folder in Updates and DLC (it holds dev_hdd0). */
export const PS3_HDD_FOLDER = 'PS3'

/**
 * The name a PS3 game's HDD files carry in a host's download list ('PS3 HDD/dev_hdd0/...'): a name on the wire, kept
 * from when the folder had it, so PlayOut versions before and after the move understand each other.
 */
export const PS3_HDD_AREA = 'PS3 HDD'

/** Where the PS3 HDD was before 0.1.120, relative to the Emulation folder ('/'-separated). */
export const OLD_PS3_HDD_FOLDER = 'roms/PS3 HDD'

/** Updates and DLC with its console folders and the PS3 HDD, relative to the Emulation folder ('/'-separated). */
export const UPDATES_DLC_FOLDERS: readonly string[] = [
  UPDATES_DLC_FOLDER,
  ...UPDATES_DLC_CONSOLES.map((c) => `${UPDATES_DLC_FOLDER}/${c}`),
  `${UPDATES_DLC_FOLDER}/${PS3_HDD_FOLDER}/dev_hdd0`,
  `${UPDATES_DLC_FOLDER}/${PS3_HDD_FOLDER}/dev_hdd0/game`,
  `${UPDATES_DLC_FOLDER}/${PS3_HDD_FOLDER}/dev_hdd0/home`,
  `${UPDATES_DLC_FOLDER}/${PS3_HDD_FOLDER}/dev_hdd0/home/00000001`
]

/** Emulation\Updates and DLC. */
export function updatesDlcDir(emulationDir: string): string {
  return join(emulationDir, UPDATES_DLC_FOLDER)
}

/** Emulation\Updates and DLC\PS3. */
export function ps3HddDir(emulationDir: string): string {
  return join(updatesDlcDir(emulationDir), PS3_HDD_FOLDER)
}

/** Emulation\Updates and DLC\PS3\dev_hdd0. */
export function ps3Dev0Dir(emulationDir: string): string {
  return join(ps3HddDir(emulationDir), 'dev_hdd0')
}

/** Makes Updates and DLC, its console folders and the PS3 HDD folders (only the missing ones). */
export async function ensurePs3Hdd(emulationDir: string): Promise<void> {
  for (const rel of UPDATES_DLC_FOLDERS)
    await fs.mkdir(join(emulationDir, ...rel.split('/')), { recursive: true })
}

/** How the PS3 HDD's move went (movePs3HddToUpdates). */
export interface Ps3HddMove {
  /** 'none': there was no old folder; 'moved': all of it is in the new place (files the new place had win). */
  /** 'failed': it threw before moving (configure's own outcome for that). */
  outcome: 'none' | 'moved' | 'partial' | 'no-space' | 'failed'
  /** What is still in the old folder ('partial'), or why nothing moved ('no-space'). */
  message?: string
}

/** Room kept free on the new place's drive beyond what a move across drives brings. */
const SPACE_HEADROOM = 1024 ** 3

/** Bytes of the files under `dir` (links not followed). */
async function treeBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await treeBytes(p)
    else if (entry.isFile()) total += (await fs.lstat(p).catch(() => null))?.size ?? 0
  }
  return total
}

/** The volume a path is on (its real path's root, e.g. "d:\"), or null when it cannot be read. */
async function volumeOf(path: string): Promise<string | null> {
  const real = await fs.realpath(path).catch(() => null)
  return real ? parse(real).root.toLowerCase() : null
}

/**
 * Moves the PS3 HDD from where PlayOut kept it before 0.1.120 (Emulation\roms\PS3 HDD) to Updates and DLC\PS3,
 * losing nothing (mergeFolderInto): what is not in the new place yet is moved, folders in both are merged, a file
 * already in the new place wins and the old copy is kept in roms\PS3 HDD.playout-old, and what cannot be moved now
 * stays in the old folder for the next try ('partial'). Its savedata and trophy junctions are not copied; RPCS3's
 * configure makes them again in the new place. Across drives (roms on another drive) it only moves when the new
 * place's drive has room for all of it ('no-space' otherwise: nothing moves). Only RPCS3's configure calls it: RPCS3
 * is not running then, and vfs.yml is repointed right after.
 */
export async function movePs3HddToUpdates(emulationDir: string, log: Logger): Promise<Ps3HddMove> {
  const from = oldPs3HddDir(emulationDir)
  const st = await fs.lstat(from).catch(() => null)
  if (!st?.isDirectory() || st.isSymbolicLink()) return { outcome: 'none' }
  const to = ps3HddDir(emulationDir)
  const updates = updatesDlcDir(emulationDir)
  await fs.mkdir(updates, { recursive: true })
  const [a, b] = await Promise.all([volumeOf(from), volumeOf(updates)])
  if (a && b && a !== b) {
    const need = await treeBytes(from)
    const stats = await fs.statfs(updates).catch(() => null)
    const free = stats ? stats.bavail * stats.bsize : Infinity
    if (need + SPACE_HEADROOM > free) {
      const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`
      const message = tMain('mainEmulation.hdd.doesNotFit', {
        size: gb(need),
        folder: updates,
        free: gb(free)
      })
      log.warn(`PS3 HDD: not moved: ${message}`)
      return { outcome: 'no-space', message }
    }
  }
  const result = await mergeFolderInto(from, to, log, 'PS3 HDD')
  return result.left
    ? { outcome: 'partial', message: tMain('mainEmulation.hdd.partial', { folder: from }) }
    : { outcome: 'moved' }
}

/** Emulation\roms\PS3 HDD: where the PS3 HDD was before 0.1.120. */
export function oldPs3HddDir(emulationDir: string): string {
  return join(emulationDir, ...OLD_PS3_HDD_FOLDER.split('/'))
}

/**
 * Written in Updates and DLC\PS3 once RPCS3's vfs.yml points at it (configure): from then on it is the PS3 HDD in use,
 * whatever is left of the old folder. Each PC writes its own (Updates and DLC is never synced).
 */
export const PS3_HDD_IN_USE_MARKER = '.playout-rpcs3-dev_hdd0'

/** Records that RPCS3 now uses Updates and DLC\PS3\dev_hdd0 (PS3_HDD_IN_USE_MARKER). */
export async function markPs3HddInUse(emulationDir: string): Promise<void> {
  await fs.mkdir(ps3HddDir(emulationDir), { recursive: true })
  await fs.writeFile(
    join(ps3HddDir(emulationDir), PS3_HDD_IN_USE_MARKER),
    'RPCS3 uses dev_hdd0 in this folder (PlayOut).\r\n'
  )
}

/**
 * The PS3 HDD RPCS3 uses: Updates and DLC\PS3 once RPCS3 was pointed at it (PS3_HDD_IN_USE_MARKER), or when there is
 * no old folder; else the old roms\PS3 HDD (a real folder holding dev_hdd0: RPCS3's configure has not moved it yet,
 * or RPCS3 is not set up by PlayOut). A host offers a PS3 game's updates and DLC from it and a client puts them in it,
 * so neither misses them before the move; the move then carries them along.
 */
export async function activePs3HddDir(emulationDir: string): Promise<string> {
  const now = ps3HddDir(emulationDir)
  if (await fs.lstat(join(now, PS3_HDD_IN_USE_MARKER)).catch(() => null)) return now
  const old = oldPs3HddDir(emulationDir)
  const oldSt = await fs.lstat(old).catch(() => null)
  const dev0 = await fs.lstat(join(old, 'dev_hdd0')).catch(() => null)
  return oldSt?.isDirectory() && !oldSt.isSymbolicLink() && dev0?.isDirectory() ? old : now
}

/** A PS3 serial: four letters and five digits (BLUS30443, NPUB30024), with or without a dash. */
const SERIAL_IN_TEXT = /(?<![A-Z0-9])([A-Z]{4})-?(\d{5})(?!\d)/i
const SERIAL = /^[A-Z]{4}\d{5}$/

function serialOf(text: string | undefined | null): string | null {
  const match = text ? SERIAL_IN_TEXT.exec(text) : null
  return match ? `${match[1]}${match[2]}`.toUpperCase() : null
}

/** TITLE_ID of a PARAM.SFO; null when it is not one or has none. */
export function sfoTitleId(data: Buffer): string | null {
  const value = sfoString(data, 'TITLE_ID')?.toUpperCase() ?? null
  return value && SERIAL.test(value) ? value : null
}

async function sfoFile(path: string): Promise<string | null> {
  const data = await readSmall(path, 64 * 1024)
  return data ? sfoTitleId(data) : null
}

const SECTOR = 2048

/**
 * TITLE_ID of a PS3 disc image: PS3_GAME\PARAM.SFO through its ISO 9660 file system, else the serial in the
 * disc header (sector 1: "PlayStation3", then the product code such as BLUS-30443).
 */
export async function isoTitleId(path: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(path, 'r')
    const file = handle
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await file.read(buf, 0, length, offset)
      return buf.subarray(0, bytesRead)
    }
    /** Entries of a directory extent: name (without ;1, upper case), extent and size. */
    const list = async (
      lba: number,
      size: number
    ): Promise<Map<string, { lba: number; size: number }>> => {
      const out = new Map<string, { lba: number; size: number }>()
      const data = await read(lba * SECTOR, Math.min(size, 1024 * 1024))
      let at = 0
      while (at < data.length) {
        const len = data[at]
        if (len === 0) {
          // Records never cross a sector; the rest of this one is padding.
          at = (Math.floor(at / SECTOR) + 1) * SECTOR
          continue
        }
        if (at + 33 > data.length) break
        const nameLen = data[at + 32]
        const name = data
          .toString('latin1', at + 33, at + 33 + nameLen)
          .replace(/;\d+$/, '')
          .toUpperCase()
        out.set(name, { lba: data.readUInt32LE(at + 2), size: data.readUInt32LE(at + 10) })
        at += len
      }
      return out
    }
    const pvd = await read(16 * SECTOR, SECTOR)
    if (pvd.length === SECTOR && pvd[0] === 1 && pvd.toString('latin1', 1, 6) === 'CD001') {
      const root = await list(pvd.readUInt32LE(156 + 2), pvd.readUInt32LE(156 + 10))
      const game = root.get('PS3_GAME')
      if (game) {
        const sfo = (await list(game.lba, game.size)).get('PARAM.SFO')
        if (sfo && sfo.size <= 64 * 1024) {
          const id = sfoTitleId(await read(sfo.lba * SECTOR, sfo.size))
          if (id) return id
        }
      }
    }
    const header = await read(SECTOR, 64)
    if (header.toString('latin1', 0, 12) === 'PlayStation3')
      return serialOf(header.toString('latin1', 16, 48))
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * The serials (title ids) of a PS3 ROM, which name its folders in dev_hdd0\game: a game folder's PARAM.SFO, a
 * disc image's, the serial a .ps3 file or an RPCS3 shortcut holds, else one in the file or folder name. Empty when
 * none is found.
 */
export async function ps3TitleIds(romPath: string, readShortcut?: ReadShortcut): Promise<string[]> {
  const ids = new Set<string>()
  const add = (id: string | null): void => {
    if (id) ids.add(id)
  }
  const st = await fs.stat(romPath).catch(() => null)
  if (st?.isDirectory()) {
    add(await sfoFile(join(romPath, 'PS3_GAME', 'PARAM.SFO')))
    add(await sfoFile(join(romPath, 'PARAM.SFO')))
    // ES-DE's Game Serial layout as a folder: Game.ps3\Game.ps3 holds the serial.
    const inner = await readSmall(join(romPath, basename(romPath)), 4096)
    if (inner) add(serialOf(inner.toString('utf8')))
  } else if (st?.isFile()) {
    const ext = extname(romPath).toLowerCase()
    if (ext === '.iso') add(await isoTitleId(romPath))
    else if (ext === '.ps3' || ext === '.lnk') {
      const target = await rpcs3Target(romPath, false, readShortcut)
      if (target.ok) {
        const serial = /^%RPCS3_GAMEID%:(\w+)$/.exec(target.value)
        if (serial) add(serial[1].toUpperCase())
        else if (target.value !== romPath) for (const id of await ps3TitleIds(target.value)) add(id)
      }
    } else if (/^(eboot\.bin)$/i.test(basename(romPath))) {
      // PS3_GAME\USRDIR\EBOOT.BIN or USRDIR\EBOOT.BIN: the PARAM.SFO is one or two folders up.
      add(await sfoFile(join(romPath, '..', '..', 'PARAM.SFO')))
    }
  }
  if (!ids.size) add(serialOf(basename(romPath)))
  return [...ids]
}

/**
 * The PS3 HDD paths a game's download may carry, as segments below the PS3 HDD folder (what ps3HddFiles lists):
 * dev_hdd0/game/<folder>/..., dev_hdd0/exdata/<file> and dev_hdd0/home/<user>/exdata/<file>. Anything else (the
 * savedata and trophy junctions into the saves folder, say) is refused on both PCs.
 */
export function isPs3HddTransferPath(segments: readonly string[]): boolean {
  const s = segments.map((p) => p.toLowerCase())
  if (s[0] !== 'dev_hdd0') return false
  if (s[1] === 'game') return s.length >= 4
  if (s[1] === 'exdata') return s.length === 3
  return s[1] === 'home' && s.length === 5 && s[3] === 'exdata'
}

/**
 * Whether a dev_hdd0\game folder belongs to the games `ids` (upper-case serials): named after a serial (BLUS30443,
 * an update or PSN install), or starting with one not followed by another digit (BLUS30443DATA, BLES00932GAMEDATA).
 * PlayOut's own copies in progress and set-aside folders (.playout-new, .playout-old) are not.
 */
export function isPs3GameFolderOf(name: string, ids: readonly string[]): boolean {
  if (/\.playout-(new|old(-\d+)?)$/i.test(name)) return false
  const upper = name.toUpperCase()
  return ids.some((id) => upper.startsWith(id) && !/^\d/.test(upper.slice(id.length)))
}

/** A PS3 content id: XX0000-XXXX00000_00-XXXXXXXXXXXXXXXX (publisher, serial, label). */
const CONTENT_ID = /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}$/

/**
 * The content id an EDAT file (a DLC's or game's licensed data) is licensed by: its NPD header ("NPD\0" at 0, the
 * content id at 0x10, 0x30 bytes). Its license is <content id>.rap in exdata. Null when it is not one.
 */
export async function edatContentId(path: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(path, 'r')
    const buf = Buffer.alloc(0x40)
    const { bytesRead } = await handle.read(buf, 0, 0x40, 0)
    if (bytesRead < 0x40 || buf.toString('latin1', 0, 4) !== 'NPD\0') return null
    const id = buf.toString('latin1', 0x10, 0x40).replace(/\0+$/, '').trim().toUpperCase()
    return CONTENT_ID.test(id) ? id : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** One file of the PS3 HDD to send with a game: its path relative to the PS3 HDD folder ('/'-separated) and size. */
export interface Ps3HddFile {
  path: string
  size: number
  /** Last modified (ms): an update rewrites files in place, often at the same size. */
  mtimeMs: number
}

/** More than any game's updates and DLC hold; past it the rest is left out. */
const MAX_HDD_FILES = 50_000

/**
 * The files of the PS3 HDD (`hddDir`, Emulation\Updates and DLC\PS3) that belong to the games `titleIds`: everything in
 * dev_hdd0\game\<serial> (updates, DLC, a PSN game itself) and in its data folders named after the serial
 * (<serial>DATA, <serial>GAMEDATA, ...), and the licenses of their content in
 * dev_hdd0\home\<user>\exdata and dev_hdd0\exdata (named by content id, e.g. UP0001-BLUS30443_00-...rap). Links are
 * never followed (savedata and trophy are junctions into the saves folder, which the Emulation sync covers).
 */
export async function ps3HddFiles(
  hddDir: string,
  titleIds: readonly string[]
): Promise<Ps3HddFile[]> {
  const files: Ps3HddFile[] = []
  const ids = titleIds.map((id) => id.toUpperCase()).filter((id) => SERIAL.test(id))
  if (!ids.length) return files
  const dev0 = join(hddDir, 'dev_hdd0')
  const entries = async (dir: string): Promise<import('fs').Dirent[]> =>
    fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const addFile = async (abs: string, rel: string): Promise<void> => {
    if (files.length >= MAX_HDD_FILES) return
    const st = await fs.lstat(abs).catch(() => null)
    if (st?.isFile()) files.push({ path: rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs) })
  }
  /** Content ids the game's own EDAT files are licensed by (its DLC may carry another serial than the game). */
  const contentIds = new Set<string>()
  const addTree = async (abs: string, rel: string): Promise<void> => {
    for (const entry of await entries(abs)) {
      if (entry.isSymbolicLink()) continue
      const childAbs = join(abs, entry.name)
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) await addTree(childAbs, childRel)
      else if (entry.isFile()) {
        await addFile(childAbs, childRel)
        if (/\.edat$/i.test(entry.name)) {
          const id = await edatContentId(childAbs)
          if (id) contentIds.add(id)
        }
      }
    }
  }

  // dev_hdd0\game\<serial>, and the game's data folders named after it (BLES00932GAMEDATA, BLUS30443DATA): a folder
  // whose name starts with the serial (not followed by another digit). Matched without regard to case.
  const ownFolder = (name: string): boolean => isPs3GameFolderOf(name, ids)
  for (const entry of await entries(join(dev0, 'game'))) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && ownFolder(entry.name))
      await addTree(join(dev0, 'game', entry.name), `dev_hdd0/game/${entry.name}`)
  }

  // A license is named after the content it unlocks (UP0001-BLUS30443_00-DLCPACK0000001.rap): one with the game's
  // serial in it, or the content id one of the game's EDAT files names (DLC filed under another serial, e.g. NPUB...).
  const isLicense = (name: string): boolean => {
    const upper = name.toUpperCase()
    if (ids.some((id) => upper.includes(`-${id}_`))) return true
    const base = upper.replace(/\.(RAP|EDAT)$/, '')
    return contentIds.has(base)
  }
  const addLicenses = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await entries(dir))
      if (entry.isFile() && isLicense(entry.name))
        await addFile(join(dir, entry.name), `${rel}/${entry.name}`)
  }
  await addLicenses(join(dev0, 'exdata'), 'dev_hdd0/exdata')
  for (const user of await entries(join(dev0, 'home'))) {
    if (!user.isDirectory() || user.isSymbolicLink()) continue
    await addLicenses(join(dev0, 'home', user.name, 'exdata'), `dev_hdd0/home/${user.name}/exdata`)
  }
  return files
}
