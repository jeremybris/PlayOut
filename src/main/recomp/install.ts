// Installing, updating and removing a recompilation: the release's Windows file is downloaded (checked against
// decomp-buddy's scanned checksum or GitHub's digest when either is published), unpacked into a staging folder and
// moved into <root>/<name (id)>. An update lays the new release over the old one: the release's own files are
// replaced, files the player made (saves, settings, their game files) are never touched, and files the old release
// shipped but the new one does not are removed unless the player changed them. Player files are zipped into
// <root>/.playout/backups/<id>/ before an update or an uninstall. Installer downloads (setup.exe / .msi) are never
// run silently: they are saved into the install folder for the player to run.
import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { pipeline } from 'stream/promises'
import { crc32, deflateRawSync } from 'zlib'
import type { InstalledRecomp, RecompEntry, RecompProgress } from '../../shared/recomp'
import { detectArchive, extractArchive, flattenSingleRoot } from '../emulator-setup/archive'
import { downloadFile, safeFileName, type HttpDeps } from '../emulator-setup/download'
import type { Logger, Runner } from '../emulator-setup/types'
import { renameRetry, RM_RETRY } from '../util/fs'
import { isInside, normalizePath } from '../util/paths'
import { isSidePiece, pickWindowsAsset } from './assets'
import { sha256FromDigest, type GhRelease } from './releases'
import { defaultCloudState, recompBackupsDir } from './state'
import { tMain } from '../i18n'

export interface InstallDeps {
  /** The Recompilations folder (installs live in <root>/<safeRecompFolder>). */
  root: string
  /** Downloads go to <cacheDir>/downloads/<id>/ and are removed once installed. */
  cacheDir: string
  http: HttpDeps
  /** The path of 7zr.exe (downloaded on first use: ensureSevenZip). */
  sevenZip: () => Promise<string>
  run: Runner
  log: Logger
  onProgress: (p: RecompProgress) => void
  now?: () => Date
  /** Free bytes on the volume holding `dir` (tests); default fs.statfs. Null = unknown (not checked). */
  freeSpace?: (dir: string) => Promise<number | null>
}

export const unverifiedWarning = (): string => tMain('mainRecomp.install.unverified')

/** A player file larger than this is not backed up (game data, not a save). */
const BACKUP_FILE_MAX = 16 * 1024 * 1024
const BACKUP_TOTAL_MAX = 512 * 1024 * 1024
const BACKUP_MAX_FILES = 8000
const BACKUP_KEEP = 5
/** Big game data the player put in the folder (disc images, ROMs, archives): never worth a backup. */
const DATA_EXTENSIONS = new Set([
  '.iso',
  '.bin',
  '.cue',
  '.img',
  '.chd',
  '.cso',
  '.rvz',
  '.wbfs',
  '.gcm',
  '.gcz',
  '.xex',
  '.xiso',
  '.zar',
  '.z64',
  '.n64',
  '.v64',
  '.nds',
  '.3ds',
  '.cia',
  '.xci',
  '.nsp',
  '.pkg',
  '.gdi',
  '.cdi',
  '.zip',
  '.7z',
  '.rar',
  '.exe',
  '.dll'
])
/** Folders of caches, logs and copied game data, skipped by the backup. */
const DATA_DIRS = new Set([
  'cache',
  'caches',
  'logs',
  'log',
  'shadercache',
  'shader_cache',
  'shaders_cache',
  'crashdumps',
  'ps3_game',
  'usrdir'
])
/** Runtime installers shipped next to a game (Visual C++, DirectX, .NET, OpenAL, PhysX). */
const RUNTIME_INSTALLER =
  /^(vc_?redist.*|vcredist.*|dxsetup|dxwebsetup|.*runtime.*|dotnet.*|ndp\d.*|oalinst|physx.*)\.exe$/
/** Asset extractors and other tools that come with a port (Ship of Harkinian's ZAPD, Doom 64 EX's wadgen). */
const HELPER_TOOL = /^(zapd|wadgen|.*extract.*|.*tool.*|notification_helper|elevate)\.exe$/
/** Folders whose programs are tools or runtime installers, not the game. */
const HELPER_FOLDERS = new Set([
  'tools',
  'tool',
  'extractor',
  'extractors',
  'utils',
  'utilities',
  'redist',
  'redists',
  'redistributables',
  '_commonredist',
  'prereqs',
  'prerequisites'
])
/** 7-Zip SFX stubs are well under this: the archive's signature is searched for in the first bytes. */
const SFX_SCAN_BYTES = 4 * 1024 * 1024
const SEVEN_ZIP_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
const EXTRACT_TIMEOUT_MS = 30 * 60_000
const PROGRESS_INTERVAL_MS = 250

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A recompilation id as a file name: "github:Zelda64Recomp/Zelda64Recomp" -> "zelda64recomp-zelda64recomp". */
export function safeRecompId(id: string): string {
  const clean = id
    .toLowerCase()
    .replace(/^github:/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (clean.length <= 80) return clean || 'recomp'
  return `${clean.slice(0, 70)}-${createHash('sha1').update(id).digest('hex').slice(0, 8)}`
}

/** The install folder's name: "Zelda 64 Recompiled (zelda64recomp-zelda64recomp)", filesystem-safe and unique per id. */
export function safeRecompFolder(entry: Pick<RecompEntry, 'id' | 'name'>): string {
  const name = entry.name
    .replace(/[<>:"/\\|?*]/g, ' ')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[.\s]+$/, '')
  const id = safeRecompId(entry.id)
  return name ? `${name} (${id})` : id
}

/** A file under a folder: its path relative to the folder (native separators) and its comparison key. */
export interface FileInfo {
  rel: string
  /** Lowercase, '/' separators (InstalledRecomp.releaseFiles). */
  key: string
  path: string
  size: number
  mtimeMs: number
}

export const keyOf = (rel: string): string =>
  rel
    .split(/[\\/]+/)
    .join('/')
    .toLowerCase()

/**
 * Every file under `dir` (links and junctions are neither listed nor entered). `enter` may skip a folder (its name
 * and depth below `dir`); `maxDepth` caps the depth (0 = `dir`'s own files).
 */
export async function listFiles(
  dir: string,
  opts: { maxDepth?: number; enter?: (name: string, depth: number) => boolean } = {}
): Promise<FileInfo[]> {
  const out: FileInfo[] = []
  const queue: { path: string; depth: number }[] = [{ path: dir, depth: 0 }]
  while (queue.length) {
    const { path, depth } = queue.shift()!
    const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = join(path, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (depth < (opts.maxDepth ?? 64) && (opts.enter?.(e.name, depth) ?? true))
          queue.push({ path: full, depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      const st = await fs.lstat(full).catch(() => null)
      if (!st) continue
      const rel = relative(dir, full)
      out.push({ rel, key: keyOf(rel), path: full, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

/** Bytes of every file under `dir` (links are not followed); 0 for a missing folder. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const f of await listFiles(dir)) total += f.size
  return total
}

/** Removes links and junctions an archive placed (they could point anywhere on the disk). */
export async function dropLinks(dir: string, log: Logger): Promise<void> {
  const queue = [dir]
  while (queue.length) {
    const path = queue.shift()!
    for (const e of await fs.readdir(path, { withFileTypes: true }).catch(() => [])) {
      const full = join(path, e.name)
      if (e.isSymbolicLink()) {
        log.warn(`${full}: the download contained a link; removed`)
        await fs.unlink(full).catch(() => fs.rmdir(full).catch(() => undefined))
      } else if (e.isDirectory()) queue.push(full)
    }
  }
}

/** The real path of `key` (lowercase, '/') under `dir`, matching names case-insensitively; null when missing or behind a link. */
async function resolveKey(dir: string, key: string): Promise<string | null> {
  let current = dir
  const parts = key.split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const names = await fs.readdir(current).catch(() => null)
    const name = names?.find((n) => n.toLowerCase() === parts[i])
    if (!name) return null
    current = join(current, name)
    const st = await fs.lstat(current).catch(() => null)
    if (!st || st.isSymbolicLink()) return null
    if (i < parts.length - 1 && !st.isDirectory()) return null
  }
  return current
}

/** Moves a file, copying when the two paths are on different volumes. */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await renameRetry(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.copyFile(from, to)
    await fs.rm(from, { force: true })
  }
}

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

export async function defaultFreeSpace(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** The hosts a project's downloads may come from (its own host; the redirect to GitHub's file storage follows). */
export function checkAssetHost(entry: Pick<RecompEntry, 'host'>, url: string): void {
  const allowed = { github: 'github.com', gitlab: 'gitlab.com', codeberg: 'codeberg.org' }[
    entry.host
  ]
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    /* not a URL */
  }
  if (host !== allowed && !host.endsWith(`.${allowed}`))
    throw new Error(
      `refusing a download from ${host || url}: not on the project's own site (${allowed})`
    )
}

/** Whether a file holds a 7z archive behind a program (a 7-Zip self-extractor). */
async function hasSevenZipInside(file: string): Promise<boolean> {
  const handle = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(SFX_SCAN_BYTES)
    const { bytesRead } = await handle.read(buf, 0, SFX_SCAN_BYTES, 0)
    return buf.subarray(0, bytesRead).indexOf(SEVEN_ZIP_SIGNATURE, 2) >= 0
  } finally {
    await handle.close()
  }
}

/**
 * Unpack the download into `staging`: zip and 7z through the emulator setup's extractor (zip-slip guarded; a single
 * top folder removed). A program is opened with 7-Zip only when it is a 7-Zip self-extractor; any other program is
 * the game itself (a portable .exe) and is placed as it is. Nothing downloaded is ever run here.
 */
async function unpack(
  file: string,
  staging: string,
  assetName: string,
  deps: InstallDeps
): Promise<void> {
  await fs.rm(staging, RM_RETRY)
  const kind = await detectArchive(file)
  if (kind === 'zip' || kind === '7z') {
    await extractArchive(file, staging, { sevenZip: deps.sevenZip, run: deps.run, log: deps.log })
    return
  }
  if (kind !== 'sfx')
    throw new Error(tMain('mainRecomp.install.notInstallable', { file: assetName }))
  await fs.mkdir(staging, { recursive: true })
  if (await hasSevenZipInside(file)) {
    try {
      const exe = await deps.sevenZip()
      const result = await deps.run(exe, ['x', '-y', '-bd', `-o${staging}`, file], {
        timeoutMs: EXTRACT_TIMEOUT_MS
      })
      if ((result.code === 0 || result.code === 1) && (await fs.readdir(staging)).length) {
        await flattenSingleRoot(staging)
        return
      }
      deps.log.warn(`${assetName}: 7-Zip exit ${result.code}; installing the program as it is`)
    } catch (err) {
      deps.log.warn(
        `${assetName}: 7-Zip could not open it (${message(err)}); installing the program as it is`
      )
    }
    await fs.rm(staging, RM_RETRY)
    await fs.mkdir(staging, { recursive: true })
  }
  await fs.copyFile(file, join(staging, safeFileName(assetName)))
}

/** Whether each existing folder on the way to `relDir` under `dir` is a real folder (not a link the player made). */
async function realParents(
  dir: string,
  relDir: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  if (!relDir || relDir === '.') return true
  let current = dir
  for (const part of relDir.split(/[\\/]+/)) {
    current = join(current, part)
    const key = current.toLowerCase()
    let ok = cache.get(key)
    if (ok === undefined) {
      const st = await fs.lstat(current).catch(() => null)
      ok = !st || (st.isDirectory() && !st.isSymbolicLink())
      cache.set(key, ok)
    }
    if (!ok) return false
  }
  return true
}

/**
 * Moves the staged release over `dir`: same-named files are replaced, everything else in `dir` stays. A file
 * `setAside` says to keep (the player's own, not in the backup zip) is renamed to "<name>.playout-old" instead of
 * being deleted.
 */
export async function overlay(
  staging: string,
  dir: string,
  files: FileInfo[],
  log: Logger,
  setAside: (key: string, st: { mtimeMs: number }) => boolean = () => false
): Promise<void> {
  const parents = new Map<string, boolean>()
  for (const f of files) {
    const dest = join(dir, f.rel)
    if (!(await realParents(dir, dirname(f.rel), parents))) {
      log.warn(`${dest}: a link or a file is in the way of the release's folder; left as it is`)
      continue
    }
    const st = await fs.lstat(dest).catch(() => null)
    if (st?.isDirectory() && !st.isSymbolicLink()) {
      log.warn(`${dest}: a folder has the release file's name; left as it is`)
      continue
    }
    await fs.mkdir(dirname(dest), { recursive: true })
    if (st && !st.isSymbolicLink() && setAside(f.key, st)) {
      const aside = `${dest}.playout-old`
      await renameRetry(dest, aside)
      log.warn(`${dest}: the new release ships a file of this name; yours was kept as ${aside}`)
    } else if (st) {
      await fs.unlink(dest).catch(() => fs.rm(dest, { force: true }))
    }
    await renameRetry(join(staging, f.rel), dest)
  }
}

/**
 * Removes the files the previous release shipped and the new one does not, unless the player changed them after the
 * previous install (`sinceMs`) or they are `keep` (the program in use). Folders left empty go too.
 */
export async function removeDropped(
  dir: string,
  previousFiles: string[],
  newKeys: Set<string>,
  keep: Set<string>,
  sinceMs: number,
  log: Logger
): Promise<void> {
  for (const key of previousFiles) {
    if (newKeys.has(key) || keep.has(key)) continue
    const path = await resolveKey(dir, key)
    if (!path) continue
    const st = await fs.lstat(path).catch(() => null)
    if (!st?.isFile()) continue
    if (Number.isFinite(sinceMs) && st.mtimeMs > sinceMs) {
      log.info(`${path}: changed since the last install; kept although the new release dropped it`)
      continue
    }
    await fs.rm(path, { force: true })
    // Empty folders up to the install folder go with it.
    for (
      let parent = dirname(path);
      isInside(dir, parent) && normalizePath(parent) !== normalizePath(dir);
      parent = dirname(parent)
    ) {
      try {
        await fs.rmdir(parent)
      } catch {
        break
      }
    }
  }
}

const DOS_EPOCH_YEAR = 1980

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms)
  const year = Math.max(d.getFullYear(), DOS_EPOCH_YEAR)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/**
 * Write a zip of `entries` (name inside the zip with '/' separators, the file on disk) to `file`: deflated when that
 * is smaller, else stored; UTF-8 names; no zip64 (backups stay far below 4 GB). Written to a temp file first.
 */
export async function writeZip(
  file: string,
  entries: { name: string; path: string }[]
): Promise<void> {
  if (entries.length > 0xffff) throw new Error('too many files for a zip')
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const handle = await fs.open(tmp, 'w')
  const central: Buffer[] = []
  let offset = 0
  try {
    for (const entry of entries) {
      const data = await fs.readFile(entry.path)
      const st = await fs.stat(entry.path)
      const deflated = deflateRawSync(data)
      const stored = deflated.length >= data.length
      const body = stored ? data : deflated
      const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
      const crc = crc32(data) >>> 0
      const { time, date } = dosDateTime(st.mtimeMs)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(stored ? 0 : 8, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(body.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      await handle.write(Buffer.concat([local, name, body]))
      const head = Buffer.alloc(46)
      head.writeUInt32LE(0x02014b50, 0)
      head.writeUInt16LE(20, 4)
      head.writeUInt16LE(20, 6)
      head.writeUInt16LE(0x0800, 8)
      head.writeUInt16LE(stored ? 0 : 8, 10)
      head.writeUInt16LE(time, 12)
      head.writeUInt16LE(date, 14)
      head.writeUInt32LE(crc, 16)
      head.writeUInt32LE(body.length, 20)
      head.writeUInt32LE(data.length, 24)
      head.writeUInt16LE(name.length, 28)
      head.writeUInt32LE(offset, 42)
      central.push(head, name)
      offset += local.length + name.length + body.length
      if (offset > 0xffffffff) throw new Error('the backup is too large for a zip')
    }
    const dirBuf = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(dirBuf.length, 12)
    end.writeUInt32LE(offset, 16)
    await handle.write(Buffer.concat([dirBuf, end]))
  } catch (err) {
    await handle.close().catch(() => undefined)
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  await handle.close()
  await renameRetry(tmp, file)
}

/**
 * The player's files in an install folder: everything not in `releaseFiles`, without links, cache/log folders,
 * game data (disc images, ROMs, archives, programs), files over 16 MB, and stopping at 512 MB / 8,000 files. Release
 * files the player changed after `changedSinceMs` (the last install: an edited config the release ships) count too.
 */
export async function playerFiles(
  dir: string,
  releaseFiles: string[],
  changedSinceMs = NaN
): Promise<FileInfo[]> {
  const release = new Set(releaseFiles)
  const all = await listFiles(dir, {
    maxDepth: 12,
    enter: (name) => !DATA_DIRS.has(name.toLowerCase())
  })
  const out: FileInfo[] = []
  let total = 0
  for (const f of all.sort((a, b) => a.key.localeCompare(b.key))) {
    if (release.has(f.key) && !(Number.isFinite(changedSinceMs) && f.mtimeMs > changedSinceMs))
      continue
    const dot = f.key.lastIndexOf('.')
    if (dot > f.key.lastIndexOf('/') && DATA_EXTENSIONS.has(f.key.slice(dot))) continue
    if (f.size > BACKUP_FILE_MAX || total + f.size > BACKUP_TOTAL_MAX) continue
    out.push(f)
    total += f.size
    if (out.length >= BACKUP_MAX_FILES) break
  }
  return out
}

/**
 * Zips the player's files of `dir` into `backupsDir/<ISO time>.zip` and keeps the newest five. Returns the zip, or
 * null when there was nothing to keep. `changedSinceMs`: see playerFiles.
 */
export async function backupPlayerFiles(
  dir: string,
  releaseFiles: string[],
  backupsDir: string,
  at: Date,
  changedSinceMs = NaN
): Promise<string | null> {
  return (await backupPlayerFilesListed(dir, releaseFiles, backupsDir, at, changedSinceMs)).zip
}

/** backupPlayerFiles, also saying which files (keys) the zip holds. */
export async function backupPlayerFilesListed(
  dir: string,
  releaseFiles: string[],
  backupsDir: string,
  at: Date,
  changedSinceMs = NaN
): Promise<{ zip: string | null; keys: Set<string> }> {
  const files = await playerFiles(dir, releaseFiles, changedSinceMs)
  const keys = new Set(files.map((f) => f.key))
  if (!files.length) return { zip: null, keys }
  const zip = join(backupsDir, `${at.toISOString().replace(/:/g, '-')}.zip`)
  await writeZip(
    zip,
    files.map((f) => ({ name: f.rel.split(sep).join('/'), path: f.path }))
  )
  const zips = (await fs.readdir(backupsDir).catch(() => [] as string[]))
    .filter((n) => n.toLowerCase().endsWith('.zip'))
    .sort()
    .reverse()
  for (const old of zips.slice(BACKUP_KEEP)) await fs.rm(join(backupsDir, old), { force: true })
  return { zip, keys }
}

/** Name tokens of the project and game for telling the game's program from the others. */
function nameTokens(entry: Pick<RecompEntry, 'name' | 'game' | 'repo'>): {
  compact: string[]
  words: string[]
} {
  const repoName = entry.repo.split('/').pop() ?? ''
  const sources = [entry.name, entry.game, repoName]
  const compact = sources
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((s) => s.length >= 4)
  const stop = new Set(['the', 'and', 'for', 'game', 'port', 'native', 'edition'])
  const words = [
    ...new Set(
      sources
        .flatMap((s) =>
          s
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
        )
        .filter((w) => w.length >= 3 && !stop.has(w))
    )
  ]
  return { compact, words }
}

/**
 * Why a program (`name`: a file name, or a path relative to the install folder) is probably not the game, in words;
 * null = it could be the game. Programs in a tools/extractor/redist-style folder are helpers.
 */
export function notGameReason(name: string): string | null {
  const parts = name.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  const n = parts.pop() ?? ''
  if (!n.endsWith('.exe')) return tMain('mainRecomp.programs.notProgram')
  if (/^(unins\d*|uninstall.*)\.exe$/.test(n)) return tMain('mainRecomp.programs.uninstaller')
  if (n.includes('crash')) return tMain('mainRecomp.programs.crashReporter')
  if (RUNTIME_INSTALLER.test(n)) return tMain('mainRecomp.programs.runtimeInstaller')
  if (n.includes('updater')) return tMain('mainRecomp.programs.updater')
  if (/setup|installer/.test(n)) return tMain('mainRecomp.programs.setup')
  if (/^7z[ar]?\.exe$/.test(n)) return tMain('mainRecomp.programs.archiveTool')
  if (HELPER_TOOL.test(n) || parts.some((p) => HELPER_FOLDERS.has(p)))
    return tMain('mainRecomp.programs.helper')
  return null
}

const depthOf = (f: FileInfo): number => f.key.split('/').length - 1
const byDepth = (a: FileInfo, b: FileInfo): number =>
  depthOf(a) - depthOf(b) || a.key.length - b.key.length || a.key.localeCompare(b.key)

/**
 * Every .exe of `files`, the most likely game first: the ones that are not an uninstaller, crash handler, runtime or
 * setup program, by how much their name is like the project's or the game's (shallowest first), then the others
 * (shallowest first) with why they are probably not the game. Nothing is left out.
 */
export function rankExes(
  files: FileInfo[],
  entry: Pick<RecompEntry, 'name' | 'game' | 'repo'>
): { file: FileInfo; note: string | null }[] {
  const exes = files.filter((f) => f.key.endsWith('.exe'))
  const games = exes.filter((f) => notGameReason(f.key) === null)
  const others = exes.filter((f) => notGameReason(f.key) !== null)
  const { compact, words } = nameTokens(entry)
  const score = (f: FileInfo): number => {
    const stem = basename(f.key, '.exe').replace(/[^a-z0-9]/g, '')
    let s = 0
    if (compact.some((c) => stem === c)) s += 20
    else if (compact.some((c) => stem.includes(c) || (stem.length >= 4 && c.includes(stem))))
      s += 10
    s += words.filter((w) => stem.includes(w)).length * 2
    return s - depthOf(f)
  }
  return [
    ...[...games]
      .sort((a, b) => score(b) - score(a) || byDepth(a, b))
      .map((file) => ({ file, note: null })),
    ...[...others].sort(byDepth).map((file) => ({ file, note: notGameReason(file.key) }))
  ]
}

/**
 * The program to start, relative to `dir`: the hint (a relative path, or a bare name searched up to three folders
 * deep), else the one .exe that is not an uninstaller, crash handler, runtime or setup program; of several, the one
 * whose name is most like the project's or the game's (shallowest first).
 */
export async function findExe(
  dir: string,
  hint: string | null,
  entry: Pick<RecompEntry, 'name' | 'game' | 'repo'>
): Promise<string | null> {
  const files = await listFiles(dir, { maxDepth: 3 })
  const clean = hint?.trim().replace(/^[\\/]+/, '')
  if (clean) {
    const key = keyOf(clean)
    const exact = files.find((f) => f.key === key)
    if (exact) return exact.rel
    const base = key.split('/').pop()!
    const named = files.filter((f) => basename(f.key) === base).sort(byDepth)
    if (named.length) return named[0]!.rel
  }
  const best = rankExes(files, entry)[0]
  return best && best.note === null ? best.file.rel : null
}

const sameTag = (a: string, b: string): boolean =>
  a
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, '') ===
  b
    .trim()
    .toLowerCase()
    .replace(/^v(?=\d)/, '')

/**
 * Download and install `release` of `entry` (an update when `previous` is given; its folder is reused). Reports
 * progress through `deps.onProgress` (ending with 'done', or 'failed' before the error is rethrown). Returns the new
 * installed record, carrying the player's choices over from `previous`.
 */
export async function installRecomp(
  entry: RecompEntry,
  release: GhRelease,
  previous: InstalledRecomp | null,
  deps: InstallDeps
): Promise<InstalledRecomp> {
  const now = (): Date => deps.now?.() ?? new Date()
  let warning: string | null = null
  const emit = (phase: RecompProgress['phase'], extra: Partial<RecompProgress> = {}): void =>
    deps.onProgress({
      id: entry.id,
      phase,
      progress: null,
      bytes: null,
      total: null,
      message: null,
      warning,
      ...extra
    })
  const dir = resolve(previous?.dir ?? join(deps.root, safeRecompFolder(entry)))
  const staging = `${dir}.staging`
  const downloadDir = join(deps.cacheDir, 'downloads', safeRecompId(entry.id))
  try {
    emit('checking', {
      message: tMain('mainRecomp.install.gettingReady', {
        name: entry.name,
        version: release.tag_name
      })
    })
    const picked = pickWindowsAsset(release.assets, {
      pattern: entry.assetPattern,
      previousName: previous?.asset ?? null,
      previousTag: previous?.tag ?? null,
      tag: release.tag_name
    })
    if (!picked)
      throw new Error(
        tMain('mainRecomp.install.noWindowsDownload', { name: entry.name, tag: release.tag_name })
      )
    const { asset, installer } = picked
    checkAssetHost(entry, asset.browser_download_url)

    await fs.mkdir(deps.root, { recursive: true })
    if (asset.size > 0) {
      const free = await (deps.freeSpace ?? defaultFreeSpace)(deps.root)
      if (free !== null && free < asset.size * 3)
        throw new Error(
          tMain('mainRecomp.install.noSpace', {
            name: entry.name,
            needed: formatBytes(asset.size * 3),
            free: formatBytes(free)
          })
        )
    }

    // decomp-buddy's checksum is of the virus-scanned file: only for exactly that release's file — the one the catalog
    // names (assetPattern is often a wildcard pattern), else an exact assetPattern.
    const scannedFor =
      entry.scannedAsset ??
      (entry.assetPattern && !/[*?]/.test(entry.assetPattern) ? entry.assetPattern : null)
    const scanned =
      entry.scannedSha256 &&
      entry.latestTag &&
      sameTag(entry.latestTag, release.tag_name) &&
      scannedFor &&
      scannedFor.toLowerCase() === asset.name.toLowerCase()
        ? entry.scannedSha256.toLowerCase()
        : null
    const digest = sha256FromDigest(asset.digest)
    const expected = scanned ?? digest
    if (!expected) warning = unverifiedWarning()

    let last = 0
    emit('downloading', { progress: 0, bytes: 0, total: asset.size || null })
    const file = await downloadFile(
      {
        version: release.tag_name,
        url: asset.browser_download_url,
        fileName: asset.name,
        sha256: expected ?? undefined,
        size: asset.size > 0 ? asset.size : undefined
      },
      downloadDir,
      deps.http,
      (done, total) => {
        const t = Date.now()
        if (t - last < PROGRESS_INTERVAL_MS && done < total) return
        last = t
        emit('downloading', {
          progress: total ? Math.min(1, done / total) : null,
          bytes: done,
          total: total || null
        })
      }
    )

    const downloadBytes = (await fs.stat(file)).size
    emit('verifying')
    // downloadFile has checked `expected`; GitHub's digest must agree too when both are published.
    if (scanned && digest && scanned !== digest)
      throw new Error(tMain('mainRecomp.install.checksumMismatch', { file: asset.name }))
    const sha256 = expected ?? (await sha256Of(file))
    const verified: InstalledRecomp['verified'] = scanned
      ? 'scanned'
      : digest
        ? 'github'
        : 'unverified'
    if (!expected)
      deps.log.warn(`${entry.id} ${release.tag_name}: ${asset.name} has no published checksum`)

    const sinceMs = previous ? Date.parse(previous.updatedAt) : NaN
    // PlayOut's own pick before (a program the user chose instead is kept by the service when it is still there).
    // None when the game replaces a side piece installed before (its server, an editor: a catalog's mistake), whose
    // program is not the game's.
    const replacesSide =
      !!previous?.asset && isSidePiece(previous.asset) && !isSidePiece(asset.name)
    const previousExe = replacesSide
      ? null
      : previous?.exeChosen === 'user'
        ? (previous.autoExe ?? null)
        : (previous?.exe ?? null)
    const keep = new Set(previousExe && !isAbsolute(previousExe) ? [keyOf(previousExe)] : [])
    let releaseFiles: string[]
    let exe: string | null
    if (installer) {
      // Never run silently: saved into the install folder for the player to run (the page says so).
      emit('installing', { message: tMain('mainRecomp.install.savingSetup') })
      await fs.mkdir(dir, { recursive: true })
      const name = safeFileName(asset.name)
      const target = join(dir, name)
      await fs.rm(target, { force: true })
      await moveFile(file, target)
      releaseFiles = [keyOf(name)]
      if (previous)
        await removeDropped(
          dir,
          previous.releaseFiles,
          new Set(releaseFiles),
          new Set(),
          sinceMs,
          deps.log
        )
      exe = name
    } else {
      emit('extracting', { message: tMain('mainRecomp.install.unpacking', { file: asset.name }) })
      await unpack(file, staging, asset.name, deps)
      await dropLinks(staging, deps.log)
      const staged = await listFiles(staging)
      if (!staged.length) throw new Error(tMain('mainRecomp.install.empty', { file: asset.name }))
      releaseFiles = [...new Set(staged.map((f) => f.key))].sort()
      emit('installing', {
        message: previous
          ? tMain('mainRecomp.install.updatingTo', { tag: release.tag_name })
          : tMain('mainRecomp.install.installing')
      })
      const existing = await fs.readdir(dir).catch(() => [] as string[])
      if (!existing.length) {
        await fs.rm(dir, RM_RETRY)
        await fs.mkdir(dirname(dir), { recursive: true })
        await renameRetry(staging, dir)
      } else {
        // The update replaces files: without the backup, nothing is touched.
        let backedUp: Set<string>
        try {
          const done = await backupPlayerFilesListed(
            dir,
            previous?.releaseFiles ?? [],
            recompBackupsDir(deps.root, safeRecompId(entry.id)),
            now(),
            sinceMs
          )
          backedUp = done.keys
          if (done.zip) deps.log.info(`${entry.id}: player files backed up to ${done.zip}`)
        } catch (err) {
          throw new Error(
            tMain('mainRecomp.install.backupFailed', { name: entry.name, error: message(err) }),
            { cause: err }
          )
        }
        const shipped = new Set(previous?.releaseFiles ?? [])
        // The player's own file (not shipped before, or changed since the last install) that the backup left out
        // (game data, too big, a cache folder): kept beside the new one rather than lost.
        const setAside = (key: string, st: { mtimeMs: number }): boolean =>
          !backedUp.has(key) &&
          (!shipped.has(key) || (Number.isFinite(sinceMs) && st.mtimeMs > sinceMs))
        await overlay(staging, dir, staged, deps.log, setAside)
        if (previous)
          await removeDropped(
            dir,
            previous.releaseFiles,
            new Set(releaseFiles),
            keep,
            sinceMs,
            deps.log
          )
        await fs.rm(staging, RM_RETRY)
      }
      exe = await findExe(dir, entry.exe ?? previousExe, entry)
    }
    await fs.rm(downloadDir, RM_RETRY).catch(() => undefined)

    const at = now().toISOString()
    const record: InstalledRecomp = {
      id: entry.id,
      dir,
      tag: release.tag_name,
      publishedAt: release.published_at,
      asset: asset.name,
      downloadBytes,
      diskBytes: await dirSize(dir),
      sha256,
      verified,
      exe,
      installedAt: previous?.installedAt ?? at,
      updatedAt: at,
      releaseFiles,
      autoUpdate: previous?.autoUpdate ?? false,
      gameFiles: previous?.gameFiles ?? {},
      savePaths: previous?.savePaths ?? [],
      saveSource: previous?.saveSource ?? null,
      cloud: previous?.cloud ?? defaultCloudState(),
      prevTag: previous
        ? sameTag(previous.tag, release.tag_name)
          ? previous.prevTag
          : previous.tag
        : null,
      // The service sets the pin from the release chosen; install() keeps what was there.
      pinnedTag: previous?.pinnedTag ?? null
    }
    if (!exe) deps.log.warn(`${entry.id}: no program to start was found in ${dir}`)
    deps.log.info(
      `${entry.id}: ${previous ? 'updated' : 'installed'} ${release.tag_name} (${asset.name}, ${verified})`
    )
    emit('done', {
      progress: 1,
      message: tMain('mainRecomp.install.installed', { name: entry.name, tag: release.tag_name })
    })
    return record
  } catch (err) {
    await fs.rm(staging, RM_RETRY).catch(() => undefined)
    await fs.rm(downloadDir, RM_RETRY).catch(() => undefined)
    deps.log.warn(`${entry.id}: install of ${release.tag_name} failed: ${message(err)}`)
    emit('failed', { message: message(err) })
    throw err
  }
}

/**
 * Remove an installed recompilation: its player files are backed up first (as before an update), then the folder and
 * any leftover download go. Only a folder inside the Recompilations folder is ever deleted.
 */
export async function uninstallRecomp(
  installed: InstalledRecomp,
  deps: Pick<InstallDeps, 'root' | 'cacheDir' | 'log' | 'now'>
): Promise<void> {
  const dir = resolve(installed.dir)
  if (!isInside(deps.root, dir) || normalizePath(dir) === normalizePath(resolve(deps.root)))
    throw new Error(tMain('mainRecomp.install.outsideFolder', { folder: dir }))
  try {
    const zip = await backupPlayerFiles(
      dir,
      installed.releaseFiles,
      recompBackupsDir(deps.root, safeRecompId(installed.id)),
      deps.now?.() ?? new Date(),
      Date.parse(installed.updatedAt)
    )
    if (zip) deps.log.info(`${installed.id}: player files backed up to ${zip} before uninstalling`)
  } catch (err) {
    deps.log.warn(`${installed.id}: player files could not be backed up (${message(err)})`)
  }
  await fs.rm(dir, RM_RETRY)
  await fs.rm(`${dir}.staging`, RM_RETRY).catch(() => undefined)
  await fs
    .rm(join(deps.cacheDir, 'downloads', safeRecompId(installed.id)), RM_RETRY)
    .catch(() => undefined)
  deps.log.info(`${installed.id}: uninstalled from ${dir}`)
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}
