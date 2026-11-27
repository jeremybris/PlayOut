import { mkdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { RECOMP_SAVES_FOLDER } from '../../shared/recomp'
import { EMULATION_FOLDERS, EMUDECK_ROM_SUBFOLDERS, EMUDECK_ROM_SYSTEMS } from './emulation-folders'
import { UPDATES_DLC_FOLDERS } from './ps3-hdd'

/**
 * What Settings › Library can generate: the ROM folder (one folder per ES-DE system) or an Emulation folder (the
 * bios / hdpacks / roms / saves / storage / texturepacks / tools layout EmuDeck sets up for ES-DE).
 */
export type GeneratedFolderKind = 'roms' | 'emulation'

/** The folder Generate makes in the picked folder. */
export const GENERATED_FOLDER_NAMES: Record<GeneratedFolderKind, string> = {
  roms: 'roms',
  emulation: 'Emulation'
}

/** The ROM folder's system folders: ES-DE's systems, plus EmuDeck's extra ones for the Emulation folder. */
function romSystems(kind: GeneratedFolderKind, systemIds: readonly string[]): string[] {
  const out = [...systemIds]
  if (kind === 'emulation')
    for (const id of EMUDECK_ROM_SYSTEMS) if (!out.includes(id)) out.push(id)
  return out
}

/**
 * Every folder to create, relative to the generated folder (forward slashes become the platform's separator).
 * roms: one folder per system, named by its ES-DE id (snes, psx, n64, …). Emulation: EmuDeck's folders, with
 * roms/<system> for every ES-DE and EmuDeck system, "Updates and DLC" (Switch, Xbox360, and PS3 with RPCS3's
 * dev_hdd0), and PlayOut's own "Recompilations Saves" (copies of recompilation saves, src/main/recomp/cloud.ts).
 */
export function generatedFolderPlan(
  kind: GeneratedFolderKind,
  systemIds: readonly string[]
): string[] {
  const systems = romSystems(kind, systemIds)
  if (kind === 'roms') return systems
  const out = [...EMULATION_FOLDERS, 'roms', ...systems.map((id) => `roms/${id}`)]
  out.push(...EMUDECK_ROM_SUBFOLDERS)
  // Games' updates and DLC per console; the PS3's is RPCS3's hard drive (Updates and DLC/PS3/dev_hdd0).
  out.push(...UPDATES_DLC_FOLDERS)
  // PlayOut's copies of recompilation saves (they reach other PCs with the Emulation folder sync).
  out.push(RECOMP_SAVES_FOLDER)
  return out.map((path) => join(...path.split('/')))
}

/**
 * The folder generated inside `parent`: `parent` itself when it is already named like it (case-insensitive: a
 * picked "D:\ROMS" is the ROM folder), else a "roms" / "Emulation" folder in it.
 */
export function generatedFolderPath(kind: GeneratedFolderKind, parent: string): string {
  const name = GENERATED_FOLDER_NAMES[kind]
  return basename(parent).toLowerCase() === name.toLowerCase() ? parent : join(parent, name)
}

export interface GeneratedFolders {
  /** The roms or Emulation folder that was generated. */
  path: string
  /** Folders made now. */
  created: number
  /** Folders that were already there (kept as they were, with whatever they hold). */
  existing: number
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Create the empty roms or Emulation folder structure inside `parent`. Only creates folders: nothing that exists
 * is changed, moved or deleted. Throws when a folder cannot be created (no permission, a file in the way).
 */
export async function generateFolders(
  kind: GeneratedFolderKind,
  parent: string,
  systemIds: readonly string[]
): Promise<GeneratedFolders> {
  return generateFoldersAt(kind, generatedFolderPath(kind, parent), systemIds)
}

/**
 * The same folders made in `root` itself, whatever its name (an Emulation folder the user moved to a folder named
 * otherwise). Only creates folders.
 */
export async function generateFoldersAt(
  kind: GeneratedFolderKind,
  root: string,
  systemIds: readonly string[]
): Promise<GeneratedFolders> {
  let created = 0
  let existing = 0
  for (const relative of ['', ...generatedFolderPlan(kind, systemIds)]) {
    const dir = relative ? join(root, relative) : root
    if (await isDirectory(dir)) {
      existing++
      continue
    }
    await mkdir(dir, { recursive: true })
    created++
  }
  return { path: root, created, existing }
}
