import { promises as fs } from 'fs'
import { basename, dirname, join, parse, resolve } from 'path'
import { FOLDER_ID_FILE } from '../streaming/emulation-sync/rules'
import { oldDefaultInstallDir } from '../util/install-move'
import { generatedFolderPath } from './generated-folders'

/**
 * Where the Emulation folder may be. It holds the user's saves, BIOS files and ROMs, so it must outlive PlayOut: it is
 * never inside PlayOut's install folder (the uninstaller and every update empty that folder) nor inside PlayOut's data
 * folder (%APPDATA%\playout, which a reinstall on a clean profile does not have). Its default is Documents\Emulation.
 */

/** The default Emulation folder: Documents\Emulation. */
export function documentsEmulationDir(documents: string): string {
  return join(documents, 'Emulation')
}

export type ForbiddenKind = 'install' | 'data'

export interface ForbiddenRoot {
  path: string
  kind: ForbiddenKind
}

export interface ForbiddenRootsInput {
  /** The folder PlayOut.exe runs from (only an installed, packaged PlayOut: a dev run's is node_modules). */
  exeDir: string | null
  /** The install folder the installer recorded (HKCU\Software\PlayOut InstallDir), when known. */
  installDir?: string | null
  /** %LOCALAPPDATA%: PlayOut's per-user install folder before 0.9.21 (Programs\PlayOut). */
  localAppData?: string | null
  /** PlayOut's data folder (userData). */
  userData: string
}

/** The folders the Emulation folder must stay out of, without duplicates. */
export function forbiddenRoots(input: ForbiddenRootsInput): ForbiddenRoot[] {
  const out: ForbiddenRoot[] = []
  const add = (path: string | null | undefined, kind: ForbiddenKind): void => {
    if (!path) return
    const key = comparable(path)
    if (!out.some((r) => comparable(r.path) === key)) out.push({ path: resolve(path), kind })
  }
  add(input.exeDir, 'install')
  add(input.installDir, 'install')
  if (input.localAppData) add(oldDefaultInstallDir(input.localAppData), 'install')
  add(input.userData, 'data')
  return out
}

/** A path for comparisons: no \\?\ prefix, resolved, no trailing separator, lower case. */
export function comparable(path: string): string {
  const raw = path.replace(/^\\\\\?\\|^\\\?\?\\/, '')
  const resolved = resolve(raw)
  const root = parse(resolved).root
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved
  return trimmed.replace(/\//g, '\\').toLowerCase()
}

/** True when `child` is `parent` or inside it (case-insensitive, slashes and trailing separators ignored). */
export function isSameOrInside(parent: string, child: string): boolean {
  const a = comparable(parent)
  const b = comparable(child)
  if (a === b) return true
  return b.startsWith(a.endsWith('\\') ? a : `${a}\\`)
}

/**
 * The real path of `path`: its deepest existing folder resolved through junctions and links, with the missing rest
 * added back. A folder reached through a junction into the install folder counts as inside it.
 */
export async function realPathOf(path: string): Promise<string> {
  let existing = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(existing)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolve(path)
      rest.push(basename(existing))
      existing = parent
    }
  }
}

/** Which forbidden folder `dir` is in (itself or below it, also through links), or null when it may be used. */
export async function forbiddenKindOf(
  dir: string,
  roots: ForbiddenRoot[]
): Promise<ForbiddenKind | null> {
  const real = await realPathOf(dir)
  for (const root of roots) {
    const rootReal = await realPathOf(root.path)
    for (const candidate of new Set([resolve(dir), real]))
      for (const base of new Set([root.path, rootReal]))
        if (isSameOrInside(base, candidate)) return root.kind
  }
  return null
}

/** Same check, synchronous and without resolving links (settings patches). */
export function forbiddenKindOfSync(dir: string, roots: ForbiddenRoot[]): ForbiddenKind | null {
  for (const root of roots) if (isSameOrInside(root.path, dir)) return root.kind
  return null
}

/** The folders an Emulation folder has at its top (EmuDeck's layout), any of which marks a folder as one. */
const EMULATION_MARKERS = ['roms', 'bios', 'saves', 'Updates and DLC', FOLDER_ID_FILE]

/** Whether `dir` is laid out like an Emulation folder. */
export async function looksLikeEmulationFolder(dir: string): Promise<boolean> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const lower = new Set(names.map((n) => n.toLowerCase()))
  return EMULATION_MARKERS.some((m) => lower.has(m.toLowerCase()))
}

/** Whether `dir` exists and holds anything. */
export async function hasContent(dir: string): Promise<boolean> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  return names.length > 0
}

/**
 * The Emulation folder a pick names. 'generate': an Emulation folder inside it (the picked folder itself when it is
 * named Emulation). 'choose': the picked folder when it is named Emulation, looks like one, or is empty; else an
 * Emulation folder inside it, so a move never pours the Emulation folder's contents into a folder of other things.
 */
export async function targetForPick(kind: 'choose' | 'generate', picked: string): Promise<string> {
  const generated = generatedFolderPath('emulation', picked)
  if (kind === 'generate' || generated === picked) return generated
  // A drive's root is never the Emulation folder itself.
  if (parse(resolve(picked)).root === resolve(picked)) return generated
  if ((await looksLikeEmulationFolder(picked)) || !(await hasContent(picked))) return picked
  return generated
}
