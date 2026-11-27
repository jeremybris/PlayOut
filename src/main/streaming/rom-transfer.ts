import { promises as fs } from 'fs'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import type { Game } from '../../shared/types'
import {
  isGameFolderExecutableName,
  parseCueFiles,
  parseM3u,
  romGameFolder
} from '../emulation/rom-scanner'
import { renameRetry, RM_RETRY } from '../util/fs'
import { ROM_DOWNLOAD_STREAMS } from './host-server'
import { safeEntryPath } from '../util/zip'
import { isHeldDirName } from '../services/held-files'
import { tMain } from '../i18n'

/**
 * ROM transfer between two PlayOut PCs. The host turns one ROM game into its whole file set (a .cue needs its tracks,
 * an .m3u its discs, a game folder everything under it) and only ever serves files of that set; the client downloads
 * the set into its own ROM folder at the same relative paths, so the rescan gives the game the same id as on the host.
 */

/** One file of a ROM set: its path relative to the ROM root ('/'-separated) and its size in bytes. */
export interface RomFile {
  path: string
  size: number
  /**
   * Last modified (ms), for files that change in place (a PS3 game's updates and DLC): a copy already on the client is
   * kept only when it has this time too, and a downloaded one gets it. Without it, a copy of the right size is kept.
   */
  mtimeMs?: number
}

export interface RomFileSet {
  files: RomFile[]
  totalBytes: number
}

/**
 * A folder outside the ROM folder whose files travel with a game under a fixed first path segment, `name`: the PS3
 * HDD (Emulation\Updates and DLC\PS3, named "PS3 HDD" on the wire), whose updates and DLC go along with a PS3 game.
 * Each PC maps the segment to its own folder, so the files land in the client's Updates and DLC\PS3\dev_hdd0 wherever
 * its ROM folder is.
 */
export interface RomArea {
  name: string
  dir: string
  /**
   * The paths this area takes, as their segments after `name` (the PS3 HDD: a game's own folders and its licenses,
   * never the savedata or trophy junctions). Others are refused, on both PCs. Default: any.
   */
  allows?: (segments: string[]) => boolean
  /**
   * A file of this area already on this PC is kept whatever its size or time, never replaced (the texture packs: a
   * client's own edits of a pack stay). Default: replaced when it is not the host's copy.
   */
  keepExisting?: boolean
  /**
   * A file of this area already on this PC with the host's size is kept whatever its time (a Switch update copied
   * here by hand); otherwise the file's time decides as usual (a newer copy kept, an older one replaced).
   */
  keepSameSize?: boolean
  /** The folder's name in a "not enough free space" message (default: `name`). */
  label?: string
  /**
   * Extras of the game (a Switch game's updates and DLC): fetched after the game's own files, and a file that cannot be
   * fetched (the host still writing it, no room left for it) is skipped (onSkipped) instead of failing the download.
   */
  optional?: boolean
}

/**
 * Where a set's relative path is on this PC: under the area its first segment names, else under `root`. Null for a
 * path that is unsafe, or that would be the folder itself or leave it.
 */
export function romTarget(
  root: string,
  relPath: string,
  areas: readonly RomArea[] = []
): string | null {
  const safe = safeEntryPath(relPath)
  if (!safe) return null
  const [first, ...rest] = safe.split(sep)
  const area = areas.find((a) => a.name.toLowerCase() === first.toLowerCase())
  if (area?.allows && !area.allows(rest)) return null
  const base = resolve(area ? area.dir : root)
  const target = area ? join(base, ...rest) : join(base, safe)
  if (!isInside(base, target) || target === base) return null
  return target
}

/**
 * The part of a Game the host needs to find its files: `platformId` and `extra` tell a dumped game folder (a PS4
 * game's eboot.bin, see romGameFolder) from a lone file.
 */
export type RomGameRef = Pick<Game, 'externalId'> &
  Partial<Pick<Game, 'romPath' | 'platformId' | 'extra'>>

/** Sheets whose referenced files are part of the game (each also kept itself). */
const SHEET_EXTENSIONS = new Set(['.cue', '.m3u', '.gdi', '.ccd'])

/** Files a single game folder may hold before we call it something else than a game. */
const MAX_DIRECTORY_FILES = 20_000
/**
 * The same for a dumped game folder (a PS4 game launched through its eboot.bin): a dump is commonly a few thousand
 * files, but a game shipping loose assets can hold tens of thousands. Still a cap: a list this long stays well inside
 * the client's 32 MB answer limit (about 100 bytes per file), and a folder past it is not one game.
 */
export const MAX_GAME_FOLDER_FILES = 100_000

/** `child` is `root` itself or below it (case-insensitive on Windows, like the file system). */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function relativeKey(path: string): string {
  return path.toLowerCase()
}

/** Tracks of a Dreamcast .gdi sheet: a count line, then `n lba type sector file offset` (file may be quoted). */
export function parseGdiFiles(text: string, baseDir: string): string[] {
  const files: string[] = []
  const lines = text.split(/\r?\n/).slice(1)
  for (const line of lines) {
    const match = /^\s*\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))/.exec(line)
    if (match) files.push(resolve(baseDir, match[1] ?? match[2]))
  }
  return files
}

/** CloneCD keeps its image and subchannel data next to the .ccd with the same stem. */
function ccdCompanions(ccdPath: string): string[] {
  const stem = ccdPath.slice(0, ccdPath.length - extname(ccdPath).length)
  return ['.img', '.sub'].map((ext) => stem + ext)
}

async function statFile(path: string): Promise<{ size: number; dir: boolean } | null> {
  try {
    const st = await fs.stat(path)
    return { size: st.size, dir: st.isDirectory() }
  } catch {
    return null
  }
}

/** The absolute path of a ROM game on this PC: its romPath, else the ROM root plus its relative externalId. */
export function romGamePath(game: RomGameRef, romsRoot: string): string {
  return resolve(game.romPath ?? join(romsRoot, game.externalId))
}

/**
 * Every file of one ROM game, relative to `romsRoot` with forward slashes. The game's own file must exist and be inside
 * the root (throws otherwise); files a sheet references that are missing or outside the ROM root are left out (the
 * game still plays from what is there on the host, and nothing outside the ROM folder is ever offered). A dumped PS4
 * game is its main file (eboot.bin, listed first) plus everything else in its folder. `limits` lowers the file caps
 * (tests).
 */
export async function romFileSet(
  game: RomGameRef,
  romsRoot: string,
  limits: { directoryFiles?: number; gameFolderFiles?: number } = {}
): Promise<RomFileSet> {
  const root = resolve(romsRoot)
  const main = romGamePath(game, root)
  if (!isInside(root, main) || main === root) throw new Error(tMain('mainStreaming.rom.outside'))
  const mainStat = await statFile(main)
  if (!mainStat) throw new Error(tMain('mainStreaming.rom.gone'))
  // A dumped game (PS4) is its whole folder, not just the eboot.bin it is launched through.
  const gameFolder = mainStat.dir ? null : romGameFolder(main, game)
  const folder = gameFolder && isInside(root, gameFolder) && gameFolder !== root ? gameFolder : null
  const maxFiles = folder
    ? (limits.gameFolderFiles ?? MAX_GAME_FOLDER_FILES)
    : (limits.directoryFiles ?? MAX_DIRECTORY_FILES)

  const files: RomFile[] = []
  const seen = new Set<string>()
  // Work guards, separate from `seen`: sheets that list themselves or each other must be read once, not once per
  // mention (a self-listing playlist would otherwise cost N^depth reads), and a folder reached twice walked once.
  const expanded = new Set<string>()
  const walked = new Set<string>()

  const add = (abs: string, size: number): void => {
    if (!isInside(root, abs)) return
    const rel = relative(root, abs).split(sep).join('/')
    // A name the client would refuse (':' in a folder name, say) is not worth offering.
    if (!rel || !safeEntryPath(rel)) return
    const key = relativeKey(rel)
    if (seen.has(key)) return
    seen.add(key)
    files.push({ path: rel, size })
    // Counted here so files a sheet pulls in hit the cap too, not only folder walks.
    if (files.length > maxFiles) throw new Error(tMain('mainStreaming.rom.tooManyFiles'))
  }

  const addTree = async (dir: string): Promise<void> => {
    const dirKey = dir.toLowerCase()
    if (walked.has(dirKey)) return
    walked.add(dirKey)
    const stack = [dir]
    while (stack.length) {
      const current = stack.pop() as string
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const abs = join(current, entry.name)
        // Links could point anywhere on the disk; a game folder never needs them.
        if (entry.isSymbolicLink()) continue
        // A disc image moved aside while its recompilation is tested (services/held-files.ts) is never sent.
        if (entry.isDirectory()) {
          if (!isHeldDirName(entry.name)) stack.push(abs)
        } else if (entry.isFile()) {
          const st = await statFile(abs)
          if (st) add(abs, st.size)
        }
      }
    }
  }

  // Sheets can reference sheets (.m3u -> .cue -> .bin); each sheet is read once, and the depth guard bounds the chain.
  const addFile = async (abs: string, depth: number): Promise<void> => {
    if (!isInside(root, abs)) return
    const st = await statFile(abs)
    if (!st) return
    if (st.dir) {
      await addTree(abs)
      return
    }
    add(abs, st.size)
    const ext = extname(abs).toLowerCase()
    if (depth > 3 || !SHEET_EXTENSIONS.has(ext)) return
    const sheetKey = abs.toLowerCase()
    if (expanded.has(sheetKey)) return
    expanded.add(sheetKey)
    let referenced: string[]
    if (ext === '.ccd') referenced = ccdCompanions(abs)
    else {
      let text: string
      try {
        text = await fs.readFile(abs, 'utf8')
      } catch {
        return
      }
      const base = dirname(abs)
      referenced =
        ext === '.cue'
          ? parseCueFiles(text, base)
          : ext === '.gdi'
            ? parseGdiFiles(text, base)
            : parseM3u(text, base)
    }
    for (const ref of referenced) await addFile(ref, depth + 1)
  }

  // The main file first (the client finds the downloaded game by it), then the rest of a game folder.
  await addFile(main, 0)
  if (folder) await addTree(folder)
  if (!files.length) throw new Error(tMain('mainStreaming.rom.noFiles'))
  return { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }
}

/**
 * A set's files by their lower-cased path, built once per set (the host keeps its sets a while: a game with a large
 * texture pack is asked for thousands of files, each looked up here).
 */
const fileIndexes = new WeakMap<
  RomFileSet,
  { files: RomFile[]; count: number; index: Map<string, RomFile> }
>()
function fileIndex(set: RomFileSet): Map<string, RomFile> {
  const known = fileIndexes.get(set)
  // Built again only if the set's list was replaced or grew since.
  if (known && known.files === set.files && known.count === set.files.length) return known.index
  const index = new Map<string, RomFile>()
  for (const f of set.files) {
    const key = relativeKey(f.path)
    if (!index.has(key)) index.set(key, f)
  }
  fileIndexes.set(set, { files: set.files, count: set.files.length, index })
  return index
}

/**
 * Check that `relPath` is a file of the game's set and return where it is on disk. The host serves only these paths, so
 * a paired client cannot read anything else from the ROM folder (or outside it). Pass `set` when it is already known.
 */
export async function openRomFile(
  game: RomGameRef,
  romsRoot: string,
  relPath: string,
  set?: RomFileSet,
  areas: readonly RomArea[] = []
): Promise<{ path: string; size: number }> {
  const files = set ?? (await romFileSet(game, romsRoot))
  const wanted = relPath.replace(/\\/g, '/')
  const file = fileIndex(files).get(relativeKey(wanted))
  const abs = file && romTarget(romsRoot, file.path, areas)
  if (!abs) throw new Error('Not a file of this ROM')
  const st = await statFile(abs)
  if (!st || st.dir) throw new Error(tMain('mainStreaming.rom.fileGone'))
  return { path: abs, size: st.size }
}

// ---------------------------------------------------------------------------
// Client: download a set into the ROM folder

export interface RomFetchRequest {
  /** The file's path relative to the host's ROM root, as the host listed it. */
  path: string
  /** Where to append the bytes (`<final>.part`); it already holds `from` bytes. */
  dest: string
  /** Byte offset to resume from (`Range: bytes=<from>-`). */
  from: number
  /**
   * The whole file's size as the host listed it. The fetcher must stop and reject once `from` plus what it wrote would
   * pass it, and reject a full (200) reply to a ranged request with `from` > 0, so a broken or hostile host cannot fill
   * the drive. downloadRomSet also aborts `signal` itself when the reported bytes pass it.
   */
  size: number
  /** Report bytes appended since the last call (a delta, not a running total). */
  onBytes: (bytes: number) => void
  signal?: AbortSignal
}

export interface RomDownloadStep {
  bytesDone: number
  bytesTotal: number
  /** 0-100 */
  percent: number
  /** The file being fetched (relative path), when one is. */
  file?: string
  fileIndex: number
  fileCount: number
}

export interface DownloadRomSetOptions {
  files: RomFile[]
  /** This PC's ROM root. */
  destRoot: string
  /** Folders outside the ROM root that paths starting with their name go to (romTarget). */
  areas?: readonly RomArea[]
  /** Fetch one file (or its rest) and append it to `dest`; resolve when the host finished sending. */
  fetchFile: (request: RomFetchRequest) => Promise<void>
  onProgress?: (step: RomDownloadStep) => void
  signal?: AbortSignal
  /** Delete the .part files when the download is cancelled (default: keep them so it can resume). */
  removePartsOnCancel?: boolean
  /** Clock for the progress throttle (tests). */
  now?: () => number
  /** Free space check (bytes free on the drive holding `dir`); null when unknown. Defaults to fs.statfs. */
  freeBytes?: (dir: string) => Promise<number | null>
  /**
   * How many small files (SMALL_FILE_BYTES or less) are fetched at once (default ROM_DOWNLOAD_STREAMS, one short of the
   * host's per-client limit; 1: one after another).
   */
  concurrency?: number
  /** A file of an `optional` area that was not fetched, and why; the download goes on without it. */
  onSkipped?: (path: string, reason: string) => void
}

/** Files this small (texture pack images, a game folder's data) are fetched several at once. */
export const SMALL_FILE_BYTES = 8 * 1024 * 1024

/** Progress is throttled to at most four updates a second; the first and the last always go out. */
const PROGRESS_INTERVAL_MS = 250

export class RomDownloadCancelled extends Error {
  constructor() {
    super(tMain('mainStreaming.download.cancelled'))
    this.name = 'AbortError'
  }
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const st = await fs.stat(path)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

/**
 * The size of a file already at `target`, or null when there is none worth keeping: for a file the host gives a time
 * (one that changes in place), a copy of another time does not count, so it is fetched again.
 */
async function currentSize(target: string, file: RomFile): Promise<number | null> {
  if (file.mtimeMs === undefined) return sizeOf(target)
  try {
    const st = await fs.stat(target)
    if (!st.isFile()) return null
    // The same time (FAT drives keep local time in 2 s steps, and read back an hour off after a daylight saving
    // change), or a newer copy (an update installed on this PC itself): kept. Only an older copy is replaced.
    const off = Math.abs(st.mtimeMs - file.mtimeMs)
    const same = off < 2000 || Math.abs(off - 3_600_000) < 2000
    if (same) return st.size
    // Newer: done, whatever its size (an update of another size installed here must not be downgraded).
    return st.mtimeMs > file.mtimeMs ? file.size : null
  } catch {
    return null
  }
}

/**
 * The partial file of a download: `<file>.part`, or for a file the host gives a time `<file>.t<time>.part`, so a part
 * of another version of it (the host updated the game meanwhile) is never resumed with this version's bytes.
 */
function partOf(target: string, file: RomFile): string {
  return file.mtimeMs === undefined
    ? `${target}.part`
    : `${target}.t${Math.floor(file.mtimeMs)}.part`
}

/** Parts of other versions of `target` (partOf) are of no use once another version is downloaded. */
async function removeOtherParts(target: string, keep: string): Promise<void> {
  const name = basename(target).toLowerCase()
  const names = await fs.readdir(dirname(target)).catch(() => [] as string[])
  for (const other of names) {
    const lower = other.toLowerCase()
    const isPart =
      lower === `${name}.part` ||
      (lower.startsWith(`${name}.t`) && /^\.t\d+\.part$/.test(lower.slice(name.length)))
    if (isPart && join(dirname(target), other).toLowerCase() !== keep.toLowerCase())
      await fs.rm(join(dirname(target), other), { force: true })
  }
}

/** The nearest folder that exists, for the free space check before anything is created. */
async function existingAncestor(dir: string): Promise<string> {
  let current = resolve(dir)
  for (;;) {
    try {
      if ((await fs.stat(current)).isDirectory()) return current
    } catch {
      // keep walking up
    }
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/**
 * The order to write a set in: the sheets (.cue, .gdi, .m3u, .ccd) after everything they reference, the game's own
 * file (first in a romFileSet list) last. A ROM scan that runs mid-download imports a sheet as a game; with its tracks
 * not there yet it would be a broken game, and the host-only entry (with its Download action) would fold into it.
 */
export function writeOrder(files: RomFile[]): RomFile[] {
  const isSheet = (f: RomFile): boolean => SHEET_EXTENSIONS.has(extname(f.path).toLowerCase())
  const sheets = files.filter(isSheet).reverse()
  // A PS4 dump's eboot.bin makes its folder a game to the scan: it comes after the rest of the folder.
  const rest = files.filter((f) => !isSheet(f))
  const executables = rest.filter(isExecutable)
  return [...rest.filter((f) => !isExecutable(f)), ...executables, ...sheets]
}

/** A dumped game's executable (eboot.bin): written last, never alongside other files. */
function isExecutable(f: RomFile): boolean {
  return isGameFolderExecutableName(basename(f.path))
}

/**
 * Download every file of a ROM set into `destRoot` at the same relative paths. Each file goes to `<file>.part` first,
 * resumes from what the .part already holds, and is renamed when its size matches; files already there with the right
 * size are skipped. Paths that would leave `destRoot` are refused before anything is written. Returns the absolute
 * paths of every file of the set (downloaded now or already present).
 */
export async function downloadRomSet(options: DownloadRomSetOptions): Promise<string[]> {
  const { fetchFile, onProgress, signal } = options
  // An area's files (a PS3 game's updates and DLC) first: the game itself, which a ROM scan picks up, comes once its
  // updates are in place, so a download stopped half-way never leaves a playable game without them.
  const ordered = writeOrder(options.files)
  const areaOf = (f: RomFile): RomArea | undefined => {
    const first = f.path.replace(/\\/g, '/').split('/')[0]?.toLowerCase()
    return (options.areas ?? []).find((a) => a.name.toLowerCase() === first)
  }
  const inArea = (f: RomFile): boolean => areaOf(f) !== undefined
  const isOptional = (f: RomFile): boolean => areaOf(f)?.optional === true
  // ...but an optional area's files (extras: a Switch game's updates) after the game, so they never hold it up.
  const files = [
    ...ordered.filter((f) => inArea(f) && !isOptional(f)),
    ...ordered.filter((f) => !inArea(f)),
    ...ordered.filter(isOptional)
  ]
  const now = options.now ?? Date.now
  const root = resolve(options.destRoot)

  // Validate the whole list first: a bad entry must not leave half a game behind.
  const plan: { file: RomFile; target: string }[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const target = romTarget(root, file.path, options.areas)
    if (!target) throw new Error(`Unsafe file path from the host: ${file.path}`)
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error(`Bad file size from the host: ${file.path}`)
    if (file.mtimeMs !== undefined && !(Number.isFinite(file.mtimeMs) && file.mtimeMs >= 0))
      throw new Error(`Bad file time from the host: ${file.path}`)
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    plan.push({ file, target })
  }

  const bytesTotal = plan.reduce((sum, p) => sum + p.file.size, 0)
  let bytesDone = 0
  let lastEmit = -Infinity
  const emit = (fileIndex: number, file: string | undefined, force: boolean): void => {
    if (!onProgress) return
    const t = now()
    if (!force && t - lastEmit < PROGRESS_INTERVAL_MS) return
    lastEmit = t
    const done = Math.min(bytesDone, bytesTotal)
    onProgress({
      bytesDone: done,
      bytesTotal,
      percent: bytesTotal > 0 ? Math.floor((done / bytesTotal) * 100) : 100,
      file,
      fileIndex,
      fileCount: plan.length
    })
  }
  const checkAbort = (): void => {
    if (signal?.aborted) throw new RomDownloadCancelled()
  }

  try {
    checkAbort()
    // What is already on disk (finished or partial) counts as done, so resuming shows the right percent.
    const present: (number | null)[] = []
    const partial: number[] = []
    for (const { file, target } of plan) {
      // A file of a keep-existing area (a texture pack) already here is this PC's own: kept as it is.
      if (areaOf(file)?.keepExisting && (await sizeOf(target)) !== null) {
        present.push(file.size)
        partial.push(0)
        bytesDone += file.size
        continue
      }
      const existing =
        areaOf(file)?.keepSameSize && (await sizeOf(target)) === file.size
          ? file.size
          : await currentSize(target, file)
      present.push(existing)
      const part = existing === file.size ? 0 : ((await sizeOf(partOf(target, file))) ?? 0)
      partial.push(part <= file.size ? part : 0)
      bytesDone += existing === file.size ? file.size : part <= file.size ? part : 0
    }

    // Checked per drive: the PS3 HDD (an area) may be on another drive than the ROM folder. The optional files are
    // checked after the others: when they do not fit as well, they are skipped, never the game.
    const skipped = new Set<number>()
    const skip = (i: number, reason: string): void => {
      skipped.add(i)
      options.onSkipped?.(plan[i].file.path, reason)
    }
    const byDrive = new Map<string, { needed: number; dir: string; label: string }>()
    const optionalByDrive = new Map<
      string,
      { needed: number; dir: string; label: string; at: number[] }
    >()
    for (let i = 0; i < plan.length; i++) {
      const { file, target } = plan[i]
      const missing = present[i] === file.size ? 0 : file.size - partial[i]
      if (missing <= 0) continue
      if (isOptional(file)) {
        const area = areaOf(file)!
        const dir = resolve(area.dir)
        const drive = parse(dir).root.toLowerCase()
        const at = optionalByDrive.get(drive) ?? {
          needed: 0,
          dir,
          label: area.label ?? area.name,
          at: []
        }
        at.needed += missing
        at.at.push(i)
        optionalByDrive.set(drive, at)
        continue
      }
      const area = options.areas?.find((a) => isInside(resolve(a.dir), target))
      const dir = area ? resolve(area.dir) : root
      const drive = parse(dir).root.toLowerCase()
      const at = byDrive.get(drive) ?? {
        needed: 0,
        dir,
        label: area ? (area.label ?? area.name) : tMain('mainStreaming.download.romFolder')
      }
      at.needed += missing
      byDrive.set(drive, at)
    }
    for (const { needed, dir, label } of byDrive.values()) {
      const free = await (options.freeBytes ?? defaultFreeBytes)(await existingAncestor(dir))
      if (free !== null && free < needed)
        throw new Error(
          tMain('mainStreaming.download.noSpace', {
            place: label,
            needed: formatBytes(needed),
            free: formatBytes(free)
          })
        )
    }
    for (const [drive, extra] of optionalByDrive) {
      const free = await (options.freeBytes ?? defaultFreeBytes)(await existingAncestor(extra.dir))
      const needed = (byDrive.get(drive)?.needed ?? 0) + extra.needed
      if (free !== null && free < needed) {
        const reason = tMain('mainStreaming.download.noSpace', {
          place: extra.label,
          needed: formatBytes(needed),
          free: formatBytes(free)
        })
        for (const i of extra.at) skip(i, reason)
      }
    }
    // A dumped game's executable (eboot.bin) already here while the rest of its folder is not: moved aside to its part
    // name before anything is fetched, and put back in place last (it counts as done, nothing is fetched again). A ROM
    // scan while this download runs, after it stopped or after it failed must never see eboot.bin in a half-copied
    // folder: it would import the folder as a game.
    const aside = new Set<number>()
    if (plan.some(({ file }, i) => present[i] !== file.size)) {
      for (let i = 0; i < plan.length; i++) {
        const { file, target } = plan[i]
        if (!isExecutable(file) || present[i] !== file.size || areaOf(file)?.keepExisting) continue
        const part = partOf(target, file)
        await fs.rm(part, RM_RETRY)
        await renameRetry(target, part)
        aside.add(i)
      }
    }
    emit(0, plan[0]?.file.path, true)

    const result: string[] = new Array<string>(plan.length)
    /** One file, under `sig` (the download's signal, or a batch's that also stops when a sibling failed). */
    const fetchOne = async (i: number, sig: AbortSignal | undefined): Promise<void> => {
      if (skipped.has(i)) return
      if (!isOptional(plan[i].file)) return fetchFileAt(i, sig)
      try {
        await fetchFileAt(i, sig)
      } catch (err) {
        // An extra that failed (not a cancel) is skipped: the game itself still comes.
        if (sig?.aborted || signal?.aborted || err instanceof RomDownloadCancelled) throw err
        skip(i, err instanceof Error ? err.message : String(err))
      }
    }
    const fetchFileAt = async (i: number, sig: AbortSignal | undefined): Promise<void> => {
      const { file, target } = plan[i]
      if (sig?.aborted) throw new RomDownloadCancelled()
      if (aside.has(i)) {
        // Already whole (moved aside above): back in place, its own time kept.
        await fs.rm(target, RM_RETRY)
        await renameRetry(partOf(target, file), target)
        result[i] = target
        return
      }
      if (present[i] === file.size) {
        result[i] = target
        return
      }
      const part = partOf(target, file)
      if (file.mtimeMs !== undefined) await removeOtherParts(target, part)
      await fs.mkdir(dirname(target), { recursive: true })
      const from = partial[i]
      if (from === 0) {
        // A .part bigger than the file is from a different version of it: start over.
        await fs.rm(part, { force: true })
        await fs.writeFile(part, '')
      }
      // A big file's start always shows; a small one's (a texture pack's thousands) only within the throttle.
      emit(i, file.path, file.size > SMALL_FILE_BYTES)
      let reported = 0
      if (from < file.size) {
        // Our own limit on top of the fetcher's: once the host has sent more than the listed size, stop it here rather
        // than after it finished (it might never finish, and the free space check only covered the listed sizes).
        const limit = new AbortController()
        let overflow = false
        const forward = (): void => limit.abort()
        sig?.addEventListener('abort', forward, { once: true })
        if (sig?.aborted) limit.abort()
        try {
          await fetchFile({
            path: file.path,
            dest: part,
            from,
            size: file.size,
            signal: limit.signal,
            onBytes: (n) => {
              if (!(n > 0)) return
              reported += n
              bytesDone += n
              if (from + reported > file.size && !overflow) {
                overflow = true
                limit.abort()
              }
              emit(i, file.path, false)
            }
          })
        } catch (err) {
          // The fetcher rejects when we abort it for overflow; that is reported below, not as a cancel.
          if (!overflow || sig?.aborted) throw err
        } finally {
          sig?.removeEventListener('abort', forward)
        }
        if (sig?.aborted) throw new RomDownloadCancelled()
        if (overflow) {
          bytesDone -= reported
          await fs.rm(part, { force: true })
          throw new Error(
            tMain('mainStreaming.download.tooMuchDataFor', { file: basename(file.path) })
          )
        }
      }
      // Trust the disk rather than the byte reports (a fetcher may report nothing, or report twice): the .part size
      // decides whether the file is complete, and corrects the running total for the next file's percent.
      const got = (await sizeOf(part)) ?? 0
      bytesDone += got - from - reported
      if (got > file.size) {
        await fs.rm(part, { force: true })
        throw new Error(
          tMain('mainStreaming.download.tooMuchDataFor', { file: basename(file.path) })
        )
      }
      if (got < file.size)
        throw new Error(tMain('mainStreaming.download.stoppedEarly', { file: basename(file.path) }))
      // An antivirus scan of the just-closed file can hold it for a moment.
      await fs.rm(target, RM_RETRY)
      await renameRetry(part, target)
      if (file.mtimeMs !== undefined) {
        const t = file.mtimeMs / 1000
        await fs.utimes(target, t, t).catch(() => {})
      }
      result[i] = target
    }

    // Small files of one group (an area, or the ROM folder) go a few at once; anything else, and a group boundary,
    // waits for what came before, so an area's files are all in place before the game's own, and sheets come last.
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? ROM_DOWNLOAD_STREAMS))
    const isSheet = (f: RomFile): boolean => SHEET_EXTENSIONS.has(extname(f.path).toLowerCase())
    const batchable = (k: number): boolean =>
      concurrency > 1 &&
      plan[k].file.size <= SMALL_FILE_BYTES &&
      !isSheet(plan[k].file) &&
      !isExecutable(plan[k].file)
    const groupOf = (k: number): string => areaOf(plan[k].file)?.name.toLowerCase() ?? ''
    const runBatch = async (from: number, to: number): Promise<void> => {
      const batch = new AbortController()
      const forward = (): void => batch.abort()
      signal?.addEventListener('abort', forward, { once: true })
      if (signal?.aborted) batch.abort()
      let next = from
      let failure: { err: unknown } | null = null
      const worker = async (): Promise<void> => {
        while (!failure && next < to) {
          const k = next++
          try {
            await fetchOne(k, batch.signal)
          } catch (err) {
            // The first failure speaks for the batch; the others it stops end with an abort, not reported.
            if (!failure) {
              failure = { err }
              batch.abort()
            }
          }
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(concurrency, to - from) }, worker))
      } finally {
        signal?.removeEventListener('abort', forward)
      }
      if (failure) throw (failure as { err: unknown }).err
    }
    for (let i = 0; i < plan.length;) {
      checkAbort()
      if (!batchable(i)) {
        await fetchOne(i, signal)
        i++
        continue
      }
      let end = i + 1
      while (end < plan.length && batchable(end) && groupOf(end) === groupOf(i)) end++
      if (end - i === 1) await fetchOne(i, signal)
      else await runBatch(i, end)
      i = end
    }
    bytesDone = bytesTotal
    emit(plan.length, undefined, true)
    return skipped.size ? result.filter((_, i) => !skipped.has(i)) : result
  } catch (err) {
    if (signal?.aborted && options.removePartsOnCancel)
      await Promise.all(
        plan.map(({ file, target }) => fs.rm(partOf(target, file), { force: true }))
      )
    if (signal?.aborted && !(err instanceof RomDownloadCancelled)) throw new RomDownloadCancelled()
    throw err
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.ceil(bytes / 1024)} KB`
}
