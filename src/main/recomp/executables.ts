// The program a recompilation starts (the Recompilation page's Program picker). PlayOut picks one itself when it
// installs (install.ts findExe; a release's recomplauncher.json names its own), and the user may choose another: a
// program in the install folder (stored relative to it) or anywhere else (stored as a full path: a setup-program
// port puts the game where it chooses). A choice must be an existing .exe file; it survives updates while its file
// is still there and "Automatic" goes back to PlayOut's pick.
import { promises as fs } from 'fs'
import { basename, extname, isAbsolute, relative, resolve } from 'path'
import type {
  InstalledRecomp,
  RecompEntry,
  RecompExecutable,
  RecompExecutables
} from '../../shared/recomp'
import type { Logger } from '../logger'
import { isInside, normalizePath } from '../util/paths'
import { keyOf, listFiles, rankExes } from './install'
import { tMain } from '../i18n'

/** How deep the install folder is searched for programs, and how many are listed at most. */
export const EXE_LIST_DEPTH = 4
export const EXE_LIST_MAX = 60

/** The user chose the program (on the Recompilation page). */
export function isUserExe(rec: Pick<InstalledRecomp, 'exe' | 'exeChosen'>): boolean {
  return rec.exeChosen === 'user' && !!rec.exe
}

/** The full path of a stored program (relative to the install folder, or a full path). */
export function exeFullPath(rec: Pick<InstalledRecomp, 'dir'>, exe: string): string {
  return isAbsolute(exe) ? resolve(exe) : resolve(rec.dir, exe)
}

/** PlayOut's own pick ("Automatic"): the release's recomplauncher.json program, else the one found at install. */
export function autoProgram(rec: InstalledRecomp, profileProgram: string | null): string | null {
  return profileProgram ?? (rec.exeChosen === 'user' ? (rec.autoExe ?? null) : rec.exe)
}

/** The program a start runs, and who chose it: the user's choice, else PlayOut's pick. */
export function programOf(
  rec: InstalledRecomp,
  profileProgram: string | null
): { program: string | null; source: RecompExecutables['source'] } {
  if (isUserExe(rec)) return { program: rec.exe, source: 'user' }
  if (profileProgram) return { program: profileProgram, source: 'developer' }
  return { program: rec.exe, source: 'auto' }
}

/** Whether `file` is an existing .exe file. */
export async function isExeFile(file: string): Promise<boolean> {
  if (extname(file).toLowerCase() !== '.exe') return false
  return !!(await fs.stat(file).catch(() => null))?.isFile()
}

/**
 * A program the user chose, as it is stored: relative to the install folder when inside it, else the full path.
 * Throws (in words) unless it is an existing .exe file; a relative path must stay inside the install folder.
 */
export async function checkExeChoice(
  rec: Pick<InstalledRecomp, 'dir'>,
  path: string
): Promise<string> {
  const raw = path.trim()
  if (!raw) throw new Error(tMain('mainRecomp.programs.choose'))
  const dir = resolve(rec.dir)
  const full = isAbsolute(raw) ? resolve(raw) : resolve(dir, raw)
  if (!isAbsolute(raw) && !isInside(dir, full))
    throw new Error(tMain('mainRecomp.programs.notInFolder', { file: raw }))
  if (extname(full).toLowerCase() !== '.exe')
    throw new Error(tMain('mainRecomp.programs.notExe', { file: basename(full) }))
  if (!(await isExeFile(full)))
    throw new Error(tMain('mainRecomp.programs.notFound', { file: full }))
  return isInside(dir, full) ? relative(dir, full) : full
}

/** Make `exe` (as checkExeChoice returned it) the user's choice (mutates `rec`; PlayOut's pick is kept aside). */
export function chooseExe(rec: InstalledRecomp, exe: string): void {
  if (rec.exeChosen !== 'user') rec.autoExe = rec.exe
  rec.exe = exe
  rec.exeChosen = 'user'
}

/**
 * Back to PlayOut's own pick (mutates `rec`); `fallback` when the pick before the choice is not known. The player
 * chose Automatic, so the pick counts as confirmed: UP starts it without asking.
 */
export function automaticExe(rec: InstalledRecomp, fallback: string | null): void {
  if (rec.exeChosen === 'user') rec.exe = rec.autoExe ?? fallback
  rec.exeChosen = 'confirmed'
  delete rec.autoExe
}

/** PlayOut's own pick has started the game: it counts as confirmed (mutates `rec`; a user's choice is kept). */
export function confirmExe(rec: InstalledRecomp): void {
  if (rec.exeChosen === undefined) rec.exeChosen = 'confirmed'
}

const samePath = (a: string | null, b: string | null): boolean =>
  !!a && !!b && normalizePath(a) === normalizePath(b)

/**
 * After an update or a reinstall: the user's choice in `prior` carries over to the new `record` while its file is
 * still there (a program inside the install folder: at the same relative path); else PlayOut's new pick is used and
 * that is logged.
 */
export async function carryExeChoice(
  record: InstalledRecomp,
  prior: InstalledRecomp | null,
  log: Pick<Logger, 'warn'>
): Promise<void> {
  if (!prior || record.exeChosen === 'user') return
  // PlayOut's pick was confirmed and the update did not change it: still confirmed.
  if (prior.exeChosen === 'confirmed') {
    if (samePath(record.exe, prior.exe)) record.exeChosen = 'confirmed'
    return
  }
  if (!isUserExe(prior)) return
  const chosen = prior.exe!
  const full = exeFullPath(record, chosen)
  const placed = isAbsolute(chosen) || isInside(resolve(record.dir), full)
  if (placed && (await isExeFile(full))) {
    record.autoExe = record.exe
    record.exe = chosen
    record.exeChosen = 'user'
    return
  }
  log.warn(
    `recomp: ${record.id}: the program chosen for it (${chosen}) is not there after the update; using PlayOut's pick (${record.exe ?? 'none'})`
  )
}

/**
 * The program `rec` starts and the programs in its install folder (EXE_LIST_DEPTH folders deep), the most likely
 * game first and the ones that are not the game last (marked, never left out); at most EXE_LIST_MAX, always with the
 * current program and PlayOut's pick among them when they are in the folder.
 */
export async function listExecutables(
  rec: InstalledRecomp,
  entry: Pick<RecompEntry, 'name' | 'game' | 'repo'>,
  profileProgram: string | null
): Promise<RecompExecutables> {
  const { program, source } = programOf(rec, profileProgram)
  const currentFull = program ? exeFullPath(rec, program) : null
  const auto = autoProgram(rec, profileProgram)
  const autoFull = auto ? exeFullPath(rec, auto) : null
  const ranked = rankExes(await listFiles(rec.dir, { maxDepth: EXE_LIST_DEPTH }), entry)
  const toItem = ({ file, note }: (typeof ranked)[number]): RecompExecutable => ({
    path: file.rel,
    full: file.path,
    note,
    current: samePath(file.path, currentFull),
    auto: samePath(file.path, autoFull)
  })
  const shown = ranked.slice(0, EXE_LIST_MAX)
  for (const r of ranked.slice(EXE_LIST_MAX))
    if (samePath(r.file.path, currentFull) || samePath(r.file.path, autoFull)) shown.push(r)
  const dir = resolve(rec.dir)
  return {
    id: rec.id,
    dir: rec.dir,
    current: program,
    currentFull,
    source,
    auto,
    outside: !!currentFull && !isInside(dir, currentFull),
    // (Any file: PlayOut's pick may be a setup .msi.)
    missing: !!currentFull && !(await fs.stat(currentFull).catch(() => null))?.isFile(),
    candidates: shown.map(toItem),
    truncated: ranked.length > shown.length
  }
}

/** Folders deeper than this are not searched for the program PlayOut picks (install.ts findExe). */
const UNCLEAR_MAX_DEPTH = 3

/**
 * Whether the program to start is unclear, so the UP button asks the player which one starts the game (once: the
 * pick is saved as the user's choice). Clear when the user chose it, the developer's recomplauncher.json names it,
 * the player accepted PlayOut's pick (`exeChosen` 'confirmed': Automatic, or it has started the game), the record is
 * a setup program (UP runs the setup, as before), or the install folder has at most one program that could be the
 * game. Not counted: uninstallers, crash reporters, runtimes, updaters, setup programs and tools (`note`), programs
 * deeper than PlayOut looks for its pick, and files the release did not ship (game files PlayOut copied into the
 * folder, the user's own files; only when the release's files are known).
 */
export function exeUnclear(
  view: Pick<RecompExecutables, 'source' | 'candidates'>,
  rec: Pick<InstalledRecomp, 'exeChosen' | 'releaseFiles'>,
  setupProgram: boolean
): boolean {
  if (view.source !== 'auto' || rec.exeChosen || setupProgram) return false
  const shipped = rec.releaseFiles.length ? new Set(rec.releaseFiles) : null
  const games = view.candidates.filter((c) => {
    if (c.note !== null || isAbsolute(c.path)) return false
    const key = keyOf(c.path)
    return key.split('/').length - 1 <= UNCLEAR_MAX_DEPTH && (!shipped || shipped.has(key))
  })
  return games.length > 1
}
