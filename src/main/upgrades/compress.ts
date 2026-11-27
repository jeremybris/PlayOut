import { promises as fs, type Dirent } from 'fs'
import { isAbsolute, join, parse as parsePath, relative, resolve } from 'path'
import { psQuote } from '../system/powershell'
import type { CompressAlgorithm, CompressState } from '../../shared/upgrades'
import { tMain } from '../i18n'

// Compression upgrade: a game folder compressed by Windows (WOF, the same API CompactGUI uses) through compact.exe, or
// uncompressed again. The spec is docs/research/upgrades/aio-compact.md (part B). compact.exe runs on lists of files
// PlayOut walked itself (relative to the game folder), so links are never followed, the file types CompactGUI leaves
// alone are skipped, and progress is exact. Every outside effect goes through the injected deps.

/** Where Windows keeps compact.exe. */
export const COMPACT_EXE = 'C:\\Windows\\System32\\compact.exe'

/** The algorithm used when none is chosen (the spec's recommendation: a balance of speed and saving). */
export const DEFAULT_COMPRESS_ALGORITHM: CompressAlgorithm = 'xpress8k'

/**
 * File types that hardly shrink (already-compressed media and archives): CompactGUI's "non-compressible" list
 * (Settings.cs nonCompressableList). PlayOut leaves them alone when compressing.
 */
export const SKIPPED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.dl_',
  '.gif',
  '.jpg',
  '.jpeg',
  '.png',
  '.wmf',
  '.mkv',
  '.mp4',
  '.wmv',
  '.avi',
  '.bik',
  '.bk2',
  '.flv',
  '.ogg',
  '.mpg',
  '.m2v',
  '.m4v',
  '.vob',
  '.mp3',
  '.aac',
  '.wma',
  '.flac',
  '.zip',
  '.xap',
  '.rar',
  '.7z',
  '.cab',
  '.lzx',
  '.docx',
  '.xlsx',
  '.pptx',
  '.vssx',
  '.vstx',
  '.onepkg',
  '.tar',
  '.gz',
  '.dmg',
  '.bz2',
  '.tgz',
  '.lz',
  '.xz',
  '.txz'
])

/** Files this small (one NTFS cluster) cannot take less space, so they are not compressed (as in CompactGUI). */
export const MIN_COMPRESSIBLE_SIZE = 4096

/** Folders deeper than this inside the game are not walked. */
const MAX_DEPTH = 32
/** At most this many files are walked in one game folder. */
const MAX_FILES = 1_000_000
/** A compact.exe command line stays under this many characters (Windows allows 32,767). */
const MAX_COMMAND_CHARS = 30_000
/** Files measured at the same time by measureFolder. */
const MEASURE_CONCURRENCY = 16

const ALGORITHM_SWITCH: Record<CompressAlgorithm, string> = {
  xpress4k: 'XPRESS4K',
  xpress8k: 'XPRESS8K',
  xpress16k: 'XPRESS16K',
  lzx: 'LZX'
}

/** CompactGUI's database CompType numbers (0 XPRESS4K, 1 XPRESS8K, 2 XPRESS16K, 3 LZX). */
const DATABASE_COMP_TYPE: Record<CompressAlgorithm, number> = {
  xpress4k: 0,
  xpress8k: 1,
  xpress16k: 2,
  lzx: 3
}

/** One progress report of a compression run (0..1 when known, and one line for the player). */
export type CompressProgress = (p: { progress: number | null; message: string }) => void

/** What compressFolder / uncompressFolder give the spawn dep for one compact.exe run. */
export interface CompactSpawnOptions {
  /** The game folder: the file arguments are relative to it. */
  cwd: string
  /** Aborted when the player stops the run: the dep must then end compact.exe. */
  signal: AbortSignal
  /**
   * compact.exe's output as it arrives. The dep should decode it with the OEM code page (437 on en-US Windows);
   * progress only counts lines, so a wrongly decoded file name does no harm.
   */
  onStdout: (text: string) => void
}

/** Runs compact.exe without a shell and resolves with its exit code (null when it could not run or was killed). */
export type CompactSpawn = (
  file: string,
  args: string[],
  options: CompactSpawnOptions
) => Promise<{ code: number | null }>

/** The file system calls of this module (tests may pass fakes; the default is Node's fs). */
export interface CompressIo {
  readdir(dir: string): Promise<Dirent[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean }>
}

/** Node's file system. */
export const nodeCompressIo: CompressIo = {
  readdir: (dir) => fs.readdir(dir, { withFileTypes: true }),
  stat: (path) => fs.stat(path)
}

/** What compressFolder and uncompressFolder need from outside. */
export interface CompactDeps {
  spawn: CompactSpawn
  /** Default COMPACT_EXE (the service may pass %SystemRoot%\System32\compact.exe). */
  compactExe?: string
  io?: CompressIo
  /**
   * Free bytes on the game's drive. When given, compression refuses to start with less than twice the largest file
   * free, and uncompressing with less than (size - bytes on disk) + the largest file free (CompactGUI's guards).
   */
  freeSpace?: (dir: string) => Promise<number | null>
  /**
   * The bytes a file takes on disk (GetCompressedFileSizeW), used by uncompressFolder's free-space guard. Without it
   * the guard uses `options.onDisk` (the last measured total) when given.
   */
  compressedSize?: (file: string) => Promise<number>
}

/** One file of a game folder found by the walk. */
export interface FolderFile {
  /** Path inside the game folder ("Engine\\Binaries\\game.exe"). */
  relPath: string
  size: number
  mtimeMs: number
}

function trimTrailingSeparators(dir: string): string {
  const root = parsePath(dir).root
  let out = dir
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1)
  return out
}

/**
 * The compact.exe arguments for a whole folder (recursing with /S): compress with WOF (/EXE, the algorithm given or
 * XPRESS8K; `force` adds /F so files compressed with another algorithm are redone), uncompress (/U /EXE, which WOF
 * files need), or query (/Q, the per-folder summary). /I keeps going after errors, /A includes hidden and system
 * files. The folder travels as one "/S:dir" argument without a trailing backslash (it would break Windows quoting).
 */
export function compactArgs(
  action: 'compress' | 'uncompress' | 'query',
  dir: string,
  algorithm?: CompressAlgorithm,
  force = false
): string[] {
  const s = `/S:${trimTrailingSeparators(dir)}`
  switch (action) {
    case 'compress':
      return [
        '/C',
        s,
        '/A',
        '/I',
        `/EXE:${ALGORITHM_SWITCH[algorithm ?? DEFAULT_COMPRESS_ALGORITHM]}`,
        ...(force ? ['/F'] : [])
      ]
    case 'uncompress':
      return ['/U', s, '/A', '/I', '/EXE']
    case 'query':
      return ['/Q', s, '/A']
  }
}

/** The compact.exe switches (before the file names) for one batch of files. */
function fileSwitches(
  action: 'compress' | 'uncompress',
  algorithm: CompressAlgorithm,
  force: boolean
): string[] {
  return action === 'compress'
    ? ['/C', '/A', '/I', `/EXE:${ALGORITHM_SWITCH[algorithm]}`, ...(force ? ['/F'] : [])]
    : ['/U', '/A', '/I', '/EXE']
}

/** How many characters an argument takes on the Windows command line (quotes when it has spaces). */
function commandChars(arg: string): number {
  return arg.length + 1 + (/[\s"]/.test(arg) ? 2 + (arg.match(/"/g)?.length ?? 0) : 0)
}

/**
 * Split files into compact.exe runs whose command lines stay under the Windows limit: each batch is the arguments
 * of one run (switches first, then the files, relative to the game folder).
 */
export function compactFileBatches(
  action: 'compress' | 'uncompress',
  files: readonly string[],
  algorithm: CompressAlgorithm = DEFAULT_COMPRESS_ALGORITHM,
  force = false,
  exe: string = COMPACT_EXE
): string[][] {
  const switches = fileSwitches(action, algorithm, force)
  const base = commandChars(exe) + switches.reduce((n, a) => n + commandChars(a), 0)
  const batches: string[][] = []
  let current: string[] = []
  let chars = base
  for (const file of files) {
    const n = commandChars(file)
    if (current.length > 0 && chars + n > MAX_COMMAND_CHARS) {
      batches.push([...switches, ...current])
      current = []
      chars = base
    }
    current.push(file)
    chars += n
  }
  if (current.length > 0) batches.push([...switches, ...current])
  return batches
}

/**
 * Every file in a game folder, links and junctions never followed (neither files nor folders), hidden files included.
 * Unreadable folders are skipped. Folders deeper than MAX_DEPTH levels are not read (measureFolderScript uses the
 * same limit), and the whole walk ends at MAX_FILES files or as soon as `signal` is aborted (the list is then
 * incomplete: callers check the signal).
 */
export async function listFolderFiles(
  dir: string,
  io: CompressIo = nodeCompressIo,
  signal?: AbortSignal
): Promise<FolderFile[]> {
  const out: FolderFile[] = []
  const stopped = (): boolean => out.length >= MAX_FILES || signal?.aborted === true
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (stopped()) return
    let entries: Dirent[]
    try {
      entries = await io.readdir(abs)
    } catch {
      return
    }
    for (const entry of entries) {
      if (stopped()) return
      if (entry.isSymbolicLink()) continue
      const childAbs = join(abs, entry.name)
      const childRel = rel ? `${rel}\\${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(childAbs, childRel, depth + 1)
      } else if (entry.isFile()) {
        try {
          const st = await io.stat(childAbs)
          out.push({ relPath: childRel, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          /* vanished or unreadable: leave it out */
        }
      }
    }
  }
  await walk(dir, '', 0)
  return out
}

/** Whether compression is worth trying on a file: bigger than one cluster and not a type CompactGUI skips. */
export function isCompressibleFile(relPath: string, size: number): boolean {
  if (size <= MIN_COMPRESSIBLE_SIZE) return false
  const name = relPath.slice(relPath.lastIndexOf('\\') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 || !SKIPPED_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * Counts compact.exe's per-file lines in streamed output. A file line does not start with a space (folder headers
 * do) and ends with a bracketed result ("a1.txt  300000 :  12288 = 24.4 to 1 [OK]"); the summary lines do not. No
 * English word is matched, so it works in every Windows language.
 */
export class CompactLineCounter {
  private rest = ''
  /** File lines seen so far. */
  count = 0

  /** Feed the next piece of output; returns the new count. */
  push(text: string): number {
    const lines = (this.rest + text).split(/\r?\n/)
    this.rest = lines.pop() ?? ''
    for (const line of lines) this.countLine(line)
    return this.count
  }

  /** Count a last line that had no line break. */
  end(): number {
    this.countLine(this.rest)
    this.rest = ''
    return this.count
  }

  private countLine(raw: string): void {
    const line = raw.replace(/\r$/, '')
    if (line.trim() && !/^\s/.test(line) && /\]\s*$/.test(line)) this.count++
  }
}

async function runBatches(
  dir: string,
  action: 'compress' | 'uncompress',
  files: string[],
  algorithm: CompressAlgorithm,
  force: boolean,
  onProgress: CompressProgress,
  signal: AbortSignal,
  deps: CompactDeps
): Promise<{ failedRuns: number; stopped: boolean; processed: number }> {
  const exe = deps.compactExe ?? COMPACT_EXE
  const total = files.length
  let done = 0
  let processed = 0
  let failedRuns = 0
  let lastReported = -1
  const report = (n: number): void => {
    const shown = Math.min(n, total)
    if (shown === lastReported) return
    lastReported = shown
    onProgress({
      progress: total > 0 ? shown / total : null,
      message: tMain(
        action === 'compress'
          ? 'mainUpgrades.compress.progress'
          : 'mainUpgrades.uncompress.progress',
        { done: shown.toLocaleString('en-US'), total: total.toLocaleString('en-US'), count: total }
      )
    })
  }
  report(0)
  for (const args of compactFileBatches(action, files, algorithm, force, exe)) {
    if (signal.aborted) return { failedRuns, stopped: true, processed }
    const batchSize = args.length - fileSwitches(action, algorithm, force).length
    const counter = new CompactLineCounter()
    let result: { code: number | null }
    try {
      result = await deps.spawn(exe, args, {
        cwd: dir,
        signal,
        onStdout: (text) => report(done + Math.min(counter.push(text), batchSize))
      })
    } catch {
      result = { code: null }
    }
    processed += Math.min(counter.end(), batchSize)
    if (signal.aborted) return { failedRuns, stopped: true, processed }
    if (result.code !== 0) failedRuns++
    // Files compact.exe skipped silently (already compressed) count as done once their run ends.
    done += batchSize
    report(done)
  }
  return { failedRuns, stopped: false, processed }
}

/**
 * Compress a game folder with Windows compression (compact.exe /C /EXE:<algorithm>). The files are listed first
 * (links never followed), files of one cluster or less and the types CompactGUI skips are left alone, and the rest go
 * to compact.exe in runs that fit the command line, with progress per file. compact.exe leaves files that are already
 * compressed as they are, whatever their algorithm, so switching algorithm needs /F: it is added when
 * `options.previousAlgorithm` (the algorithm the folder was last compressed with, if known) differs from `algorithm`,
 * or when `options.force` is set (slower: every file is redone). The message says how many files compact.exe really
 * compressed. Stopping (the signal) ends compact.exe; files done so far stay compressed. Never rejects.
 */
export async function compressFolder(
  dir: string,
  algorithm: CompressAlgorithm,
  onProgress: CompressProgress,
  signal: AbortSignal,
  deps: CompactDeps,
  options: { force?: boolean; previousAlgorithm?: CompressAlgorithm | null } = {}
): Promise<{ ok: boolean; message: string }> {
  onProgress({ progress: null, message: tMain('mainUpgrades.compress.counting') })
  const all = await listFolderFiles(dir, deps.io, signal)
  if (signal.aborted) return { ok: false, message: tMain('mainUpgrades.compress.stopped') }
  const files = all.filter((f) => isCompressibleFile(f.relPath, f.size))
  if (files.length === 0) return { ok: true, message: tMain('mainUpgrades.compress.nothing') }
  if (deps.freeSpace) {
    const largest = files.reduce((m, f) => Math.max(m, f.size), 0)
    const free = await deps.freeSpace(dir).catch(() => null)
    if (free !== null && free < largest * 2) {
      return {
        ok: false,
        message: tMain('mainUpgrades.compress.noSpace')
      }
    }
  }
  const previous = options.previousAlgorithm ?? null
  const force = (options.force ?? false) || (previous !== null && previous !== algorithm)
  const { failedRuns, stopped, processed } = await runBatches(
    dir,
    'compress',
    files.map((f) => f.relPath),
    algorithm,
    force,
    onProgress,
    signal,
    deps
  )
  if (stopped) return { ok: false, message: tMain('mainUpgrades.compress.stopped') }
  if (failedRuns > 0) {
    return {
      ok: false,
      message: tMain('mainUpgrades.compress.someFailed')
    }
  }
  if (processed === 0) {
    return {
      ok: true,
      message: tMain('mainUpgrades.compress.alreadyCompressed')
    }
  }
  if (processed < files.length) {
    return {
      ok: true,
      message: tMain('mainUpgrades.compress.someAlready', {
        count: processed,
        files: processed.toLocaleString('en-US')
      })
    }
  }
  return {
    ok: true,
    message: tMain('mainUpgrades.compress.doneFiles', {
      count: processed,
      files: processed.toLocaleString('en-US')
    })
  }
}

/** The bytes the files take on disk now, asking compressedSize for each (a file it fails on counts at its size). */
async function bytesOnDisk(
  dir: string,
  files: readonly FolderFile[],
  compressedSize: (file: string) => Promise<number>,
  signal?: AbortSignal
): Promise<number> {
  let total = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length && !signal?.aborted) {
      const file = files[next++]
      let disk: number
      try {
        disk = await compressedSize(join(dir, file.relPath))
        if (!Number.isFinite(disk) || disk < 0) disk = file.size
      } catch {
        disk = file.size
      }
      total += Math.min(disk, file.size)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, files.length) }, worker))
  return total
}

/**
 * Uncompress a game folder (compact.exe /U /EXE: every file, whatever compressed it). Same listing, runs, progress
 * and stopping as compressFolder. With deps.freeSpace it first refuses when the drive has less free than the space the
 * files will grow by plus the largest file (CompactGUI's guard); how much they take now comes from
 * deps.compressedSize, else from `options.onDisk` (the last measured total), else is not known (then only the largest
 * file is required). Never rejects.
 */
export async function uncompressFolder(
  dir: string,
  onProgress: CompressProgress,
  signal: AbortSignal,
  deps: CompactDeps,
  options: { onDisk?: number | null } = {}
): Promise<{ ok: boolean; message: string }> {
  onProgress({ progress: null, message: tMain('mainUpgrades.compress.counting') })
  const files = await listFolderFiles(dir, deps.io, signal)
  if (signal.aborted) return { ok: false, message: tMain('mainUpgrades.uncompress.stopped') }
  if (files.length === 0) return { ok: true, message: tMain('mainUpgrades.uncompress.nothing') }
  if (deps.freeSpace) {
    const size = files.reduce((n, f) => n + f.size, 0)
    const largest = files.reduce((m, f) => Math.max(m, f.size), 0)
    let onDisk: number | null = null
    if (deps.compressedSize) {
      onProgress({ progress: null, message: tMain('mainUpgrades.uncompress.checkingSpace') })
      onDisk = await bytesOnDisk(dir, files, deps.compressedSize, signal)
      if (signal.aborted) return { ok: false, message: tMain('mainUpgrades.uncompress.stopped') }
    } else if (typeof options.onDisk === 'number' && Number.isFinite(options.onDisk)) {
      onDisk = Math.min(Math.max(options.onDisk, 0), size)
    }
    const needed = (onDisk === null ? 0 : size - onDisk) + largest
    const free = await deps.freeSpace(dir).catch(() => null)
    if (free !== null && free < needed) {
      return {
        ok: false,
        message: tMain('mainUpgrades.uncompress.noSpace')
      }
    }
  }
  const { failedRuns, stopped } = await runBatches(
    dir,
    'uncompress',
    files.map((f) => f.relPath),
    DEFAULT_COMPRESS_ALGORITHM,
    false,
    onProgress,
    signal,
    deps
  )
  if (stopped) return { ok: false, message: tMain('mainUpgrades.uncompress.stopped') }
  if (failedRuns > 0) {
    return {
      ok: false,
      message: tMain('mainUpgrades.uncompress.someFailed')
    }
  }
  return {
    ok: true,
    message: tMain('mainUpgrades.uncompress.doneFiles', {
      count: files.length,
      files: files.length.toLocaleString('en-US')
    })
  }
}

/** File counts behind a folder's compression state. */
export interface CompressCounts {
  /** Files Windows stores in less space than their size (any type). */
  compressedFiles: number
  /** Files worth compressing (isCompressibleFile). */
  eligible: number
  /** Of those, the ones stored compressed. */
  eligibleCompressed: number
  /**
   * Of the eligible files not stored compressed, the ones changed after the folder was compressed (a game update
   * rewrote them); null when the time of the compression is not known.
   */
  changed: number | null
}

/**
 * The folder's state from its counts: 'none' when no file is stored compressed. When the time of the last
 * compression is known, 'partial' means files were rewritten since (files compact.exe tried but could not shrink do
 * not count); otherwise 'partial' means some worthwhile files are not compressed (such files then also count).
 */
export function compressStateOf(counts: CompressCounts): CompressState['state'] {
  if (counts.compressedFiles === 0) return 'none'
  if (counts.changed !== null) return counts.changed > 0 ? 'partial' : 'compressed'
  return counts.eligibleCompressed < counts.eligible ? 'partial' : 'compressed'
}

/** What measureFolder needs from outside. */
export interface MeasureDeps {
  /** The bytes a file takes on disk (GetCompressedFileSizeW); the file's size when it is not compressed. */
  compressedSize(file: string): Promise<number>
  /** When PlayOut last compressed the folder (ms since 1970), to tell a game update apart from incompressible files. */
  compressedAt?: number | null
  io?: CompressIo
}

/**
 * Measure a game folder: the size of its files, what they take on disk now, and its compression state (see
 * compressStateOf). Asks deps.compressedSize for every file (a file it fails on counts at its size). For big games
 * prefer one PowerShell call: measureFolderScript + parseFolderMeasure.
 */
export async function measureFolder(
  dir: string,
  deps: MeasureDeps
): Promise<{ size: number; onDisk: number; state: CompressState['state'] }> {
  const files = await listFolderFiles(dir, deps.io)
  const since = deps.compressedAt ?? null
  let size = 0
  let onDisk = 0
  const counts: CompressCounts = {
    compressedFiles: 0,
    eligible: 0,
    eligibleCompressed: 0,
    changed: since === null ? null : 0
  }
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++]
      let disk: number
      try {
        disk = await deps.compressedSize(join(dir, file.relPath))
        if (!Number.isFinite(disk) || disk < 0) disk = file.size
      } catch {
        disk = file.size
      }
      size += file.size
      onDisk += disk
      const packed = disk < file.size
      if (packed) counts.compressedFiles++
      if (isCompressibleFile(file.relPath, file.size)) {
        counts.eligible++
        if (packed) counts.eligibleCompressed++
        else if (since !== null && file.mtimeMs > since) counts.changed = (counts.changed ?? 0) + 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, files.length) }, worker))
  return { size, onDisk, state: compressStateOf(counts) }
}

/**
 * A PowerShell script (for the PowerShell worker, which converts its result to JSON) that measures a whole folder in
 * one call with GetCompressedFileSizeW: it walks the folder without following links or junctions and returns
 * { size, onDisk, files, compressedFiles, eligible, eligibleCompressed, changed }, with the same rules and limits
 * (MAX_DEPTH, MAX_FILES) as measureFolder. Files NTFS (LZNT1) compressed count in onDisk but not as compressed, since
 * PlayOut did not compress them. `compressedAt` (ms since 1970) is when PlayOut last compressed the folder, if known. Big games take
 * a while: give the worker a long timeout.
 */
export function measureFolderScript(dir: string, compressedAt?: number | null): string {
  const skip = [...SKIPPED_EXTENSIONS].map((e) => `'${e}'`).join(',')
  const since = compressedAt && compressedAt > 0 ? Math.floor(compressedAt) : 0
  return [
    `$dir = ${psQuote(dir)}`,
    `$sinceMs = [double]${since}`,
    "if (-not ('PlayOutWof.Size' -as [type])) {",
    '  Add-Type -Namespace PlayOutWof -Name Size -MemberDefinition \'[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetCompressedFileSizeW(string lpFileName, out uint lpFileSizeHigh);\'',
    '}',
    '$skip = @{}',
    `foreach ($e in @(${skip})) { $skip[$e] = $true }`,
    '$since = $null',
    'if ($sinceMs -gt 0) { $since = (New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)).AddMilliseconds($sinceMs) }',
    '$size = [double]0; $onDisk = [double]0',
    '$files = 0; $compressedFiles = 0; $eligible = 0; $eligibleCompressed = 0; $changed = 0',
    '$stack = New-Object System.Collections.Stack',
    '$stack.Push([pscustomobject]@{ d = (New-Object System.IO.DirectoryInfo $dir); depth = 0 })',
    '$full = $false',
    'while ($stack.Count -gt 0 -and -not $full) {',
    '  $top = $stack.Pop()',
    '  $d = $top.d',
    '  try { $items = $d.GetFileSystemInfos() } catch { continue }',
    '  foreach ($i in $items) {',
    '    if (($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }',
    `    if ($i -is [System.IO.DirectoryInfo]) { if ($top.depth -lt ${MAX_DEPTH}) { $stack.Push([pscustomobject]@{ d = $i; depth = $top.depth + 1 }) }; continue }`,
    `    if ($files -ge ${MAX_FILES}) { $full = $true; break }`,
    '    $files++',
    '    $len = [double]$i.Length',
    '    $hi = [uint32]0',
    '    $lo = [PlayOutWof.Size]::GetCompressedFileSizeW($i.FullName, [ref]$hi)',
    '    if ($lo -eq [uint32]::MaxValue -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 0) { $disk = $len }',
    '    else { $disk = [double]$hi * 4294967296 + [double]$lo }',
    '    $size += $len; $onDisk += $disk',
    '    $lznt1 = ($i.Attributes -band [System.IO.FileAttributes]::Compressed) -ne 0',
    '    $packed = ($disk -lt $len) -and -not $lznt1',
    '    if ($packed) { $compressedFiles++ }',
    `    if ($len -gt ${MIN_COMPRESSIBLE_SIZE} -and -not $skip.ContainsKey($i.Extension.ToLowerInvariant())) {`,
    '      $eligible++',
    '      if ($packed) { $eligibleCompressed++ }',
    '      elseif ($since -ne $null -and $i.LastWriteTimeUtc -gt $since) { $changed++ }',
    '    }',
    '  }',
    '}',
    '[pscustomobject]@{ size = $size; onDisk = $onDisk; files = $files; compressedFiles = $compressedFiles; eligible = $eligible; eligibleCompressed = $eligibleCompressed; changed = $(if ($since -ne $null) { $changed } else { $null }) }'
  ].join('\n')
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Read measureFolderScript's result (the parsed object, or its JSON text) into the size, the bytes on disk and the
 * compression state; null when it is not that shape.
 */
export function parseFolderMeasure(
  value: unknown
): { size: number; onDisk: number; state: CompressState['state'] } | null {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const size = num(o.size)
  const onDisk = num(o.onDisk)
  const compressedFiles = num(o.compressedFiles)
  const eligible = num(o.eligible)
  const eligibleCompressed = num(o.eligibleCompressed)
  if (
    size === null ||
    onDisk === null ||
    compressedFiles === null ||
    eligible === null ||
    eligibleCompressed === null
  ) {
    return null
  }
  const changed = o.changed === null || o.changed === undefined ? null : num(o.changed)
  return {
    size,
    onDisk,
    state: compressStateOf({ compressedFiles, eligible, eligibleCompressed, changed })
  }
}

/**
 * Read CompactGUI's community database (database.json: an array of { SteamID, CompressionResults: [{ CompType,
 * BeforeBytes, AfterBytes, TotalResults }] }) into Steam app id -> estimated saving (0..1 of the size). The estimate
 * is CompactGUI's: the after/before ratios weighted by their number of results, over every algorithm, or only the
 * one given. Results with a zero size and games without results are left out; text that is not the database gives
 * an empty map.
 */
export function parseCompactDatabase(
  json: string,
  algorithm?: CompressAlgorithm
): Map<string, number> {
  const out = new Map<string, number>()
  let data: unknown
  try {
    data = JSON.parse(json) as unknown
  } catch {
    return out
  }
  if (!Array.isArray(data)) return out
  const wanted = algorithm === undefined ? null : DATABASE_COMP_TYPE[algorithm]
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id =
      typeof e.SteamID === 'number' || typeof e.SteamID === 'string' ? String(e.SteamID) : ''
    if (!/^\d+$/.test(id) || id === '0' || !Array.isArray(e.CompressionResults)) continue
    let weighted = 0
    let weights = 0
    for (const r of e.CompressionResults as unknown[]) {
      if (!r || typeof r !== 'object') continue
      const res = r as Record<string, unknown>
      if (wanted !== null && res.CompType !== wanted) continue
      const before = num(res.BeforeBytes)
      const after = num(res.AfterBytes)
      const results = num(res.TotalResults)
      if (!before || !after || !results) continue
      weighted += (after / before) * results
      weights += results
    }
    if (weights === 0) continue
    out.set(id, Math.min(1, Math.max(0, 1 - weighted / weights)))
  }
  return out
}

/** The file system and drive type of a folder's volume. */
export interface VolumeInfo {
  /** "NTFS", "exFAT", "FAT32", "ReFS"…; null when unknown. */
  fileSystem: string | null
  /** A network drive. */
  network: boolean
  /**
   * The folder itself has the NTFS (LZNT1) Compressed attribute ("compress contents to save disk space"); false when
   * unknown.
   */
  folderCompressed?: boolean
}

/**
 * A PowerShell script (for the PowerShell worker) returning { fileSystem, network, folderCompressed } for a folder:
 * its drive's file system and type, and whether the folder has the NTFS (LZNT1) Compressed attribute.
 */
export function volumeInfoScript(dir: string): string {
  return [
    `$dir = ${psQuote(dir)}`,
    '$lznt1 = $false',
    'try { $lznt1 = ([System.IO.File]::GetAttributes($dir) -band [System.IO.FileAttributes]::Compressed) -ne 0 } catch { }',
    'try {',
    '  $drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($dir))',
    '  [pscustomobject]@{ fileSystem = $drive.DriveFormat; network = ($drive.DriveType -eq [System.IO.DriveType]::Network); folderCompressed = $lznt1 }',
    '} catch {',
    '  [pscustomobject]@{ fileSystem = $null; network = $false; folderCompressed = $lznt1 }',
    '}'
  ].join('\n')
}

/** Read volumeInfoScript's result (the parsed object or its JSON text); null when it is not that shape. */
export function parseVolumeInfo(value: unknown): VolumeInfo | null {
  let v = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return {
    fileSystem: typeof o.fileSystem === 'string' && o.fileSystem ? o.fileSystem : null,
    network: o.network === true,
    folderCompressed: o.folderCompressed === true
  }
}

/** What compressUnavailable needs from outside. */
export interface UnavailableDeps {
  /** The folder's drive (volumeInfoScript + parseVolumeInfo); null when it cannot be read. */
  volumeInfo(dir: string): Promise<VolumeInfo | null>
  /** The Windows folder (%WINDIR%), refused like CompactGUI does. Default C:\Windows. */
  windowsDir?: string
  io?: CompressIo
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent.toLowerCase(), child.toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * A path without the Windows long-path prefix: "\\?\D:\X" and "\\.\D:\X" become "D:\X", "\\?\UNC\server\share"
 * becomes "\\server\share". Other paths are returned as they are.
 */
function stripLongPathPrefix(dir: string): string {
  const unc = /^[\\/]{2}[?.][\\/]UNC[\\/]/i.exec(dir)
  if (unc) return `\\\\${dir.slice(unc[0].length)}`
  const local = /^[\\/]{2}[?.][\\/](?=[a-z]:)/i.exec(dir)
  return local ? dir.slice(local[0].length) : dir
}

/**
 * Why a game folder cannot be compressed here, or null when it can: a protected folder (WindowsApps), a missing
 * folder, a whole drive, the Windows folder, a OneDrive folder, a network drive (a UNC path or a network drive
 * letter), a drive that is not NTFS, or a folder NTFS-compressed (LZNT1) already, which CompactGUI also leaves alone.
 * A long-path prefix ("\\?\") is ignored. When the drive cannot be read, compression is allowed (compact.exe then
 * reports its own failure).
 */
export async function compressUnavailable(
  dir: string,
  deps: UnavailableDeps
): Promise<string | null> {
  const full = resolve(stripLongPathPrefix(dir))
  const segments = full.toLowerCase().split(/[\\/]+/)
  if (segments.includes('windowsapps')) {
    return tMain('mainUpgrades.compress.protected')
  }
  try {
    const st = await (deps.io ?? nodeCompressIo).stat(full)
    if (!st.isDirectory()) return tMain('mainUpgrades.compress.folderMissing')
  } catch {
    return tMain('mainUpgrades.compress.folderMissing')
  }
  if (trimTrailingSeparators(full).length <= parsePath(full).root.length) {
    return tMain('mainUpgrades.compress.wholeDrive')
  }
  if (isInside(full, deps.windowsDir ?? 'C:\\Windows')) {
    return tMain('mainUpgrades.compress.windows')
  }
  if (segments.some((s) => s === 'onedrive' || s.startsWith('onedrive - '))) {
    return tMain('mainUpgrades.compress.oneDrive')
  }
  if (/^[\\/]{2}/.test(full)) return tMain('mainUpgrades.compress.network')
  const volume = await deps.volumeInfo(full).catch(() => null)
  if (volume?.network) return tMain('mainUpgrades.compress.network')
  if (volume?.fileSystem && volume.fileSystem.toUpperCase() !== 'NTFS') {
    return tMain('mainUpgrades.compress.notNtfs', { fileSystem: volume.fileSystem })
  }
  if (volume?.folderCompressed) {
    return tMain('mainUpgrades.compress.ntfsCompressed')
  }
  return null
}
