import { promises as fs } from 'fs'
import { join } from 'path'
import { normalizeGameId, type GameIdKind } from '../emulation/disc-id'
import { safeEntryPath } from '../util/zip'

/**
 * A ROM game's texture packs go with its download from a host: the folders in the host's Emulation\texturepacks
 * named after the game's serial or id (texturepacks\pcsx2\SLUS-20777, texturepacks\dolphin\GALE01) travel as
 * 'Texture Packs/<emulator>/<folder>/...' (TEXTURE_AREA), and land in the client's own Emulation\texturepacks.
 */

/** The first path segment of a set's texture pack files on the wire. */
export const TEXTURE_AREA = 'Texture Packs'

/** The texture packs folder of an Emulation folder (where the emulators' texture folders point). */
export function texturePacksDir(emulationDir: string): string {
  return join(emulationDir, 'texturepacks')
}

export interface TexturePackEmulator {
  /** Its folder in texturepacks (emulator-setup/configure.ts links the emulator's own texture folder there). */
  folder: string
  /** The ROM systems (systems.json ids) whose games it plays. */
  systems: readonly string[]
  /** The kind of id its per-game folders are named after. */
  kind: GameIdKind
  /** Where the per-game folders are inside its folder (Azahar: textures\<title id>); default: right in it. */
  parent?: string
  /**
   * Folders at the top of a game's texture folder that the emulator writes itself (its texture dumps), not part of a
   * pack: never sent (case-insensitive).
   */
  skip?: readonly string[]
}

/** Every emulator folder in texturepacks that holds per-game texture packs, by the systems it plays. */
export const TEXTURE_PACK_EMULATORS: readonly TexturePackEmulator[] = [
  // PCSX2: textures\SLUS-20777\replacements
  { folder: 'pcsx2', systems: ['ps2'], kind: 'serial', skip: ['dumps'] },
  // DuckStation: textures\SLUS-00594
  { folder: 'duckstation', systems: ['psx'], kind: 'serial', skip: ['dumps'] },
  // PPSSPP: TEXTURES\ULUS10336 (its own dumps in ULUS10336\new)
  { folder: 'ppsspp', systems: ['psp'], kind: 'serial', skip: ['new'] },
  // Dolphin: Load\Textures\GALE01 (or the three-letter GAL for every region)
  { folder: 'dolphin', systems: ['gc', 'wii'], kind: 'gamecube' },
  // Flycast: textures\<product number>
  { folder: 'flycast', systems: ['dreamcast'], kind: 'dreamcast' },
  // Azahar: load\textures\<title id>
  { folder: 'azahar', systems: ['n3ds'], kind: '3ds', parent: 'textures' },
  // Ryujinx: mods\contents\<title id>
  { folder: 'ryujinx', systems: ['switch'], kind: 'switch', parent: 'contents' }
]

/** The texture pack emulators of a ROM system (none for most). */
export function texturePackEmulatorsFor(systemId: string): TexturePackEmulator[] {
  return TEXTURE_PACK_EMULATORS.filter((e) => e.systems.includes(systemId))
}

/** The kind of id a system's games are matched by, or null when no emulator folder takes its texture packs. */
export function gameIdKindOf(systemId: string): GameIdKind | null {
  return texturePackEmulatorsFor(systemId)[0]?.kind ?? null
}

/** Ids shorter than this (normalized) never match a folder: too likely to be the start of something else. */
const MIN_ID_LENGTH = 6

/**
 * Whether a per-game texture folder belongs to a game with these ids: its normalized name (normalizeGameId) is an id,
 * or starts with one not followed by another character of the id (SLUS-20777, SLUS_20777 HD, SLUS-20777 - God of War;
 * not SLUS-207771). A Dolphin folder may also be the three-letter id prefix all regions share (GAL for GALE01).
 * No title matching: a folder without the id in its name is not taken.
 */
export function isTextureFolderOf(name: string, ids: readonly string[], kind: GameIdKind): boolean {
  const folder = normalizeGameId(name)
  if (!folder) return false
  const next = kind === '3ds' || kind === 'switch' ? /^[0-9A-F]/ : /^\d/
  for (const raw of ids) {
    const id = normalizeGameId(raw)
    if (kind === 'gamecube' && id.length === 6 && folder === id.slice(0, 3)) return true
    if (id.length < MIN_ID_LENGTH) continue
    if (folder.startsWith(id) && !next.test(folder.slice(id.length))) return true
  }
  return false
}

/**
 * The paths the texture pack area takes, as segments after TEXTURE_AREA: <emulator>/[<parent>/]<game folder>/<file...>
 * for a known emulator folder, at least one file deep. Others are refused on both PCs.
 */
export function isTexturePackTransferPath(segments: readonly string[]): boolean {
  const emulator = TEXTURE_PACK_EMULATORS.find(
    (e) => e.folder.toLowerCase() === segments[0]?.toLowerCase()
  )
  if (!emulator) return false
  let at = 1
  if (emulator.parent) {
    if (segments[1]?.toLowerCase() !== emulator.parent.toLowerCase()) return false
    at = 2
  }
  // The game folder, then at least one more segment (the file).
  return segments.length >= at + 2 && segments.every((s) => s.length > 0)
}

/** One texture pack file: its path relative to texturepacks ('/'-separated) and its size. */
export interface TexturePackFile {
  path: string
  size: number
}

/** More files than any texture pack holds; past it the rest is left out. */
const MAX_TEXTURE_FILES = 200_000
/** Folder depth inside a game's texture folder. */
const MAX_DEPTH = 24

/**
 * The texture pack files of a game in `texDir` (Emulation\texturepacks): every file under each per-game folder that
 * isTextureFolderOf matches, in the folders of the emulators that play `systemId`. Links (symbolic links, junctions)
 * are never followed, and names a client would refuse are left out.
 */
export async function texturePackFiles(
  texDir: string,
  systemId: string,
  ids: readonly string[]
): Promise<TexturePackFile[]> {
  const files: TexturePackFile[] = []
  if (!ids.length) return files
  const entries = async (dir: string): Promise<import('fs').Dirent[]> =>
    fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const addTree = async (
    abs: string,
    rel: string,
    depth: number,
    skip: readonly string[]
  ): Promise<void> => {
    for (const entry of await entries(abs)) {
      if (files.length >= MAX_TEXTURE_FILES) return
      if (entry.isSymbolicLink()) continue
      const childAbs = join(abs, entry.name)
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        // The emulator's own texture dumps at the top of the game's folder stay on the host.
        if (depth === 0 && skip.includes(entry.name.toLowerCase())) continue
        if (depth < MAX_DEPTH) await addTree(childAbs, childRel, depth + 1, skip)
      } else if (entry.isFile() && safeEntryPath(childRel)) {
        const st = await fs.lstat(childAbs).catch(() => null)
        if (st?.isFile()) files.push({ path: childRel, size: st.size })
      }
    }
  }
  for (const emulator of texturePackEmulatorsFor(systemId)) {
    // The emulator's folder is found whatever its case (PPSSPP's TEXTURES, say, if a user made it).
    const top = (await entries(texDir)).find(
      (e) => e.isDirectory() && !e.isSymbolicLink() && e.name.toLowerCase() === emulator.folder
    )
    if (!top) continue
    let base = join(texDir, top.name)
    let rel = emulator.folder
    if (emulator.parent) {
      const parent = (await entries(base)).find(
        (e) =>
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          e.name.toLowerCase() === emulator.parent!.toLowerCase()
      )
      if (!parent) continue
      base = join(base, parent.name)
      rel = `${rel}/${emulator.parent}`
    }
    for (const entry of await entries(base)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (!isTextureFolderOf(entry.name, ids, emulator.kind)) continue
      await addTree(join(base, entry.name), `${rel}/${entry.name}`, 0, emulator.skip ?? [])
    }
  }
  return files
}
