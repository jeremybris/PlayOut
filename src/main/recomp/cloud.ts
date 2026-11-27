// Copies of recompilation saves in the Emulation folder, without a server: each recomp's saves are copied into
//   <Emulation>/Recompilations Saves/<name>/current/<root index>/<rel...>   the newest saves
//   <Emulation>/Recompilations Saves/<name>/meta.json                       {hash, at, machine, roots, history}
// (<name> is readable: "Zelda 64 Recompiled (zelda64recomp-zelda64recomp)", see service.ts). The Emulation folder is
// what PlayOut's streaming sync shares between PCs (and it may itself sit in a cloud app's folder), so the copy is how
// saves reach other PCs. It is kept in step with RecompLauncher's three-way rule (local hash L, copy hash C, hash when
// last synced S): equal = in sync; only one side moved from S = that side wins and the other is backed up first; both
// moved = a conflict the user resolves, nothing overwritten meanwhile. Saves gone from a PC that synced them before
// are asked about too ("Restore from the Emulation folder" / "Start fresh"), never copied back silently; a PC that
// never synced the game takes the copy (first-time setup). Backups never go into the Emulation folder
// (they would be synced to every PC): both sides' backups are zips in <recomp root>/.playout/save-backups/<id>/.
//
// Work in progress inside the Emulation folder carries the ".playout-new" / ".playout-old" suffixes the Emulation
// folder sync leaves out (streaming/emulation-sync/rules.ts), so a half-written copy never travels.
//
// Safety: files are only ever deleted inside a save root (and only files the save listing itself reports, never
// through a link) or inside this recomp's copy folder; every deletion is checked with isInside.
import { randomBytes } from 'crypto'
import { promises as fs, type Dirent } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { deflateRawSync } from 'zlib'
import { OLD_RECOMP_CLOUD_FOLDER, type RecompCloudState } from '../../shared/recomp'
import type { Logger } from '../logger'
import { isInside, knownFolders, normalizePath } from '../util/paths'
import { hashSaves, listSaveFiles, type SaveFile } from './saves'
import { tMain } from '../i18n'

/** Backups of replaced Emulation-folder copies, and of this PC's saves, kept per recompilation (both on this PC). */
export const KEEP_CLOUD_BACKUPS = 10
export const KEEP_LOCAL_BACKUPS = 10
/** Saves bigger than this are not copied (the Emulation folder is no place for a mis-detected game folder). */
export const MAX_SYNC_BYTES = 512 * 1024 * 1024

async function isDir(p: string, timeoutMs = 1500): Promise<boolean> {
  // A disconnected drive (an Emulation folder on a USB or network drive) can take long to answer: give up after a moment.
  const check = fs.stat(p).then(
    (st) => st.isDirectory(),
    () => false
  )
  const timeout = new Promise<boolean>((ok) => setTimeout(() => ok(false), timeoutMs).unref?.())
  return Promise.race([check, timeout])
}

// ---------------------------------------------------------------------------------------------------------------
// Layout

/**
 * A recompilation id as a folder name: "github:Mr-Wiseguy/Zelda64Recomp#mm" → "github-mr-wiseguy-zelda64recomp-mm"
 * (the local backups' folder, and the copy's folder in the old cloud folder).
 */
export function cloudSaveKey(entryId: string): string {
  const s = entryId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120)
  return s || 'recomp'
}

/** This recompilation's copy in the cloud folder older PlayOut versions used (adopted once, never changed). */
export function oldCloudSaveDir(cloudDir: string, entryId: string): string {
  return join(cloudDir, OLD_RECOMP_CLOUD_FOLDER, cloudSaveKey(entryId))
}

export interface CloudMeta {
  /** savesHash of `current/`. */
  hash: string
  /** When these saves were uploaded (ISO). */
  at: string
  /** The PC that uploaded them (its name, shown to the user). */
  machine: string
  /**
   * The uploading PlayOut install's own random id (CloudSyncDeps.machineId): tells this PC's copies from another PC's
   * with the same name (cloned images, two PCs both called GAMING-PC). Absent in copies written by older versions.
   */
  machineId?: string
  /** The save folders as templates, in root-index order. */
  roots: string[]
  /**
   * The hashes this copy replaced, newest first (its ancestry, at most MAX_COPY_HISTORY): a PC whose last-synced hash
   * is among them only fell behind and may take the copy; one whose hash is not there did not sync from this line of
   * copies (two PCs uploaded from the same saves, then the Emulation folder sync merged their copies): a conflict.
   * Absent in copies written by older versions (then any copy newer than the last sync is taken, as before).
   */
  history?: string[]
  /**
   * What the copy is of, for other PCs to recognise it (PC Saves: the game's title and stable key). Recompilation
   * copies have none.
   */
  extra?: Record<string, string>
}

/** Hashes kept in a copy's meta.json history. */
export const MAX_COPY_HISTORY = 100

/**
 * The copy's meta.json, telling "not there" (an empty copy, or one whose meta.json has not arrived yet) from "there
 * but unreadable" (an online-only placeholder that fails to open, half-written, corrupt).
 */
function loadCloudMeta(
  base: string
): Promise<{ state: 'missing' | 'unreadable' | 'ok'; meta: CloudMeta | null }> {
  return loadMetaFile(join(base, 'meta.json'))
}

/** A meta.json, or a pending one ("meta.json.<hex>.playout-new", see upload), read from `file`. */
async function loadMetaFile(
  file: string
): Promise<{ state: 'missing' | 'unreadable' | 'ok'; meta: CloudMeta | null }> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { state: code === 'ENOENT' ? 'missing' : 'unreadable', meta: null }
  }
  try {
    const m = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as CloudMeta
    if (typeof m?.hash !== 'string' || !Array.isArray(m.roots))
      return { state: 'unreadable', meta: null }
    return {
      state: 'ok',
      meta: {
        hash: m.hash,
        at: typeof m.at === 'string' ? m.at : new Date(0).toISOString(),
        machine: typeof m.machine === 'string' ? m.machine : 'another PC',
        ...(typeof m.machineId === 'string' && m.machineId ? { machineId: m.machineId } : {}),
        roots: m.roots.filter((r): r is string => typeof r === 'string'),
        ...(Array.isArray(m.history)
          ? {
              history: (m.history as unknown[])
                .filter((h): h is string => typeof h === 'string')
                .slice(0, MAX_COPY_HISTORY)
            }
          : {}),
        ...(stringRecord(m.extra) ? { extra: stringRecord(m.extra)! } : {})
      }
    }
  } catch {
    return { state: 'unreadable', meta: null }
  }
}

/** An object's string values (meta.json's `extra`), else null. */
function stringRecord(v: unknown): Record<string, string> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
  return out
}

/** The meta.json of the copy in `dir` (null when there is none or it is unreadable). */
export async function readCopyMeta(dir: string): Promise<CloudMeta | null> {
  return (await loadCloudMeta(dir)).meta
}

/** The `current/<i>` folders of a copy whose meta.json is missing or unreadable (index-numbered folders). */
async function currentRoots(base: string): Promise<string[]> {
  const current = join(base, 'current')
  let names: Dirent[]
  try {
    names = await fs.readdir(current, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  let max = -1
  for (const d of names) {
    if (d.isDirectory() && /^\d{1,3}$/.test(d.name)) max = Math.max(max, Number(d.name))
  }
  return Array.from({ length: max + 1 }, (_, i) => join(current, String(i)))
}

/** A save-folder template compared across PCs: '/' separators, no trailing one, case-insensitive. */
function templateKey(t: string): string {
  return t
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

/**
 * For each copied root (meta.roots order), the index of this PC's save folder with the same template; null when the
 * two sets of save folders are not the same (a positional guess could write one folder's saves into another).
 */
export function matchSaveRoots(cloudRoots: string[], localTemplates: string[]): number[] | null {
  if (cloudRoots.length !== localTemplates.length) return null
  const used = new Set<number>()
  const out: number[] = []
  for (const r of cloudRoots) {
    const key = templateKey(r)
    const j = localTemplates.findIndex((t, i) => !used.has(i) && templateKey(t) === key)
    if (j < 0) return null
    used.add(j)
    out.push(j)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Zip writing (backups): stored/deflated entries, no zip64 (save backups are far below 4 GB; refused otherwise)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

/** Write a zip of `entries` (name '/'-separated → file on disk, or a Buffer) to `dest` (via a temp file). */
export async function writeZip(
  dest: string,
  entries: { name: string; from: string | Buffer }[]
): Promise<void> {
  await fs.mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${randomBytes(4).toString('hex')}.tmp`
  const handle = await fs.open(tmp, 'w')
  const central: Buffer[] = []
  let offset = 0
  try {
    for (const e of entries) {
      const data = typeof e.from === 'string' ? await fs.readFile(e.from) : e.from
      const mtime = typeof e.from === 'string' ? (await fs.stat(e.from)).mtime : new Date()
      const deflated = deflateRawSync(data)
      const useDeflate = deflated.length < data.length
      const body = useDeflate ? deflated : data
      const name = Buffer.from(e.name, 'utf8')
      const crc = crc32(data)
      const { time, date } = dosTime(mtime)
      if (offset + 30 + name.length + body.length > 0xfffffff0)
        throw new Error(tMain('mainRecomp.saves.backupTooLarge'))
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6) // UTF-8 names
      local.writeUInt16LE(useDeflate ? 8 : 0, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(body.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      await handle.write(local)
      await handle.write(name)
      await handle.write(body)
      const cen = Buffer.alloc(46)
      cen.writeUInt32LE(0x02014b50, 0)
      cen.writeUInt16LE(20, 4)
      cen.writeUInt16LE(20, 6)
      cen.writeUInt16LE(0x0800, 8)
      cen.writeUInt16LE(useDeflate ? 8 : 0, 10)
      cen.writeUInt16LE(time, 12)
      cen.writeUInt16LE(date, 14)
      cen.writeUInt32LE(crc, 16)
      cen.writeUInt32LE(body.length, 20)
      cen.writeUInt32LE(data.length, 24)
      cen.writeUInt16LE(name.length, 28)
      cen.writeUInt32LE(offset, 42)
      central.push(cen, name)
      offset += local.length + name.length + body.length
    }
    const dir = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(dir.length, 12)
    end.writeUInt32LE(offset, 16)
    await handle.write(dir)
    await handle.write(end)
  } catch (err) {
    await handle.close().catch(() => undefined)
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  await handle.close()
  await renameRetry(tmp, dest)
}

// ---------------------------------------------------------------------------------------------------------------
// File helpers

const delay = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

/** Rename, retrying a few times: sync and cloud clients and antivirus hold files open for a moment. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await delay(150 * (i + 1))
    }
  }
}

/** Remove `target` (file or folder) only when it is strictly inside `within`; anything else is a bug and throws. */
async function removeInside(within: string, target: string): Promise<void> {
  const w = resolve(within)
  const t = resolve(target)
  if (normalizePath(w) === normalizePath(t) || !isInside(w, t)) {
    throw new Error(`Refusing to delete ${t}: it is not inside ${w}.`)
  }
  for (let i = 0; ; i++) {
    try {
      await fs.rm(t, { recursive: true, force: true })
      return
    } catch (err) {
      if (i >= 4) throw err
      await delay(150 * (i + 1))
    }
  }
}

/**
 * A save root PlayOut may write into and delete from: absolute, not a drive root, and not the user's profile, a
 * known folder (AppData, Documents, Program Files...) or anything above one. saves.ts' isSafeSaveRoot is stricter
 * (it knows the install folder); this is the last line of defence inside the sync itself.
 */
export function isWritableSaveRoot(path: string): boolean {
  if (!isAbsolute(path)) return false
  const p = resolve(path)
  if (dirname(p) === p) return false
  const f = knownFolders()
  const home = homedir()
  const guarded = [
    home,
    f.userProfile,
    f.appData,
    f.localAppData,
    join(f.userProfile, 'AppData'),
    join(f.userProfile, 'AppData', 'LocalLow'),
    join(f.userProfile, 'Documents'),
    join(f.userProfile, 'Saved Games'),
    f.programData,
    f.programFiles,
    f.programFilesX86,
    f.publicDir
  ]
  if (guarded.some((g) => g && isInside(p, g))) return false
  // Never Windows itself, the Start Menu / Startup folders, or a dot-folder of the profile (.ssh, .aws, .gnupg).
  const windir = process.env.SystemRoot || process.env.windir || join(f.systemDrive, 'Windows')
  if (isInside(windir, p)) return false
  if (p.split(/[\\/]+/).some((part) => /^(start menu|startup)$/i.test(part))) return false
  for (const h of [home, f.userProfile]) {
    if (!h || !isInside(h, p)) continue
    const first = resolve(p)
      .slice(resolve(h).length)
      .split(/[\\/]+/)
      .find(Boolean)
    if (first?.startsWith('.')) return false
  }
  return true
}

/** Whether a file's read-only attribute is set (on Windows: no write bit). */
const readOnly = (mode: number): boolean => (mode & 0o200) === 0

/**
 * Copy a file via a temp file next to the target, keeping its modification time and its read-only attribute. A
 * read-only target is made writable first: Windows refuses to rename over a read-only file.
 */
async function copyFileAtomic(from: string, to: string): Promise<void> {
  await fs.mkdir(dirname(to), { recursive: true })
  const tmp = `${to}.playout-${randomBytes(3).toString('hex')}.tmp`
  try {
    await fs.copyFile(from, tmp)
    const st = await fs.stat(from)
    const ro = readOnly(st.mode)
    if (ro) await fs.chmod(tmp, 0o666).catch(() => undefined)
    await fs.utimes(tmp, st.atime, st.mtime).catch(() => undefined)
    if (ro) await fs.chmod(tmp, 0o444).catch(() => undefined)
    const target = await fs.lstat(to).catch(() => null)
    if (target?.isFile() && readOnly(target.mode)) await fs.chmod(to, 0o666)
    await renameRetry(tmp, to)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

async function pruneBackups(dir: string, keep: number): Promise<void> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.zip'))
  } catch {
    return
  }
  // Names start with the ISO time, so name order is age order.
  names.sort()
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    await removeInside(dir, join(dir, n)).catch(() => undefined)
  }
}

function stamp(d: Date): string {
  // ISO time with ':' replaced (not allowed in Windows file names).
  return d
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, 'Z')
}

function safeName(s: string): string {
  // eslint-disable-next-line no-control-regex -- control characters cannot be in a file name
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').slice(0, 60) || 'PC'
}

/** Zip a set of save files (as `<root>/<rel>`) plus a playout-saves.json describing them. */
async function zipSaves(
  dest: string,
  files: SaveFile[],
  info: { at: string; machine: string; hash: string | null; roots: string[]; reason: string }
): Promise<void> {
  await writeZip(dest, [
    { name: 'playout-saves.json', from: Buffer.from(JSON.stringify(info, null, 2)) },
    ...files.map((f) => ({ name: `${f.root}/${f.rel}`, from: f.abs }))
  ])
}

// ---------------------------------------------------------------------------------------------------------------
// Sync

export interface CloudSyncDeps {
  /** The Emulation folder: it must be reachable (a chosen folder on a disconnected drive is waited for, not made). */
  rootDir: string
  /** This recompilation's copy folder, inside `rootDir` (<Emulation>/Recompilations Saves/<name>). */
  dir: string
  /** This PC's name (meta.json, backup names, the conflict prompt). */
  machine: string
  /**
   * This PlayOut install's own random id (save-copy/shared.ts machineIdOf), written into meta.json: "this PC's own
   * copy" is told by it, not by the name, which two PCs can share. Absent: by the name (as older versions did).
   */
  machineId?: string
  log: Logger
  now?: () => Date
  /**
   * Local backups folder (never inside the Emulation folder): backups of this PC's saves go to <backupsDir>/<safe id>/,
   * replaced copies from the Emulation folder to <backupsDir>/<safe id>/replaced copies/.
   */
  backupsDir: string
  /** The save folders as templates (index-aligned with savePaths), recorded in meta.json for other PCs. */
  templates?: string[]
  /** The log lines' prefix (default 'recomp saves'). */
  logTag?: string
  /** Written into meta.json's `extra` by every upload (what the copy is of; see CloudMeta.extra). */
  extraMeta?: Record<string, string>
  /**
   * The save folders are the user's own choice on each PC (PC Saves): copied root i goes into save folder i whenever
   * both have as many, whatever their templates. Absent: roots are matched by template (recompilations).
   */
  rootsByPosition?: boolean
}

const tag = (deps: Pick<CloudSyncDeps, 'logTag'>): string => deps.logTag ?? 'recomp saves'

class CloudUnavailable extends Error {}

interface Sides {
  base: string
  /**
   * This PC's save folders and their templates in sync order: the copy's root order when its templates are
   * this PC's (in any order), else this PC's own order. Local file root indexes refer to this order.
   */
  paths: string[]
  templates: string[]
  /** Whether this PC's save folders are the copy's (false: restoring would put saves in the wrong folders). */
  rootsMatch: boolean
  local: { hash: string | null; files: SaveFile[]; bytes: number; newest: number }
  /** `intact` false: a copy is there but cannot be used yet (still syncing, meta.json unreadable or missing). */
  cloud: { hash: string | null; meta: CloudMeta | null; files: SaveFile[]; intact: boolean }
}

async function readSides(savePaths: string[], deps: CloudSyncDeps): Promise<Sides> {
  if (!(await isDir(deps.rootDir, 5000))) {
    throw new CloudUnavailable(
      tMain('mainRecomp.saves.emulationUnreachable', { folder: deps.rootDir })
    )
  }
  if (
    normalizePath(deps.rootDir) === normalizePath(deps.dir) ||
    !isInside(deps.rootDir, deps.dir)
  ) {
    throw new Error(`${deps.dir} is not inside the Emulation folder ${deps.rootDir}.`)
  }
  for (const p of savePaths) {
    if (!isWritableSaveRoot(p)) throw new Error(`${p} is not a folder PlayOut syncs saves from.`)
  }
  const base = resolve(deps.dir)
  const read = await loadCloudMeta(base)
  const meta = read.meta
  const localTemplates =
    deps.templates && deps.templates.length === savePaths.length ? deps.templates : savePaths
  let order = savePaths.map((_, i) => i)
  let rootsMatch = true
  if (meta && !(deps.rootsByPosition && meta.roots.length === savePaths.length)) {
    const matched = matchSaveRoots(meta.roots, localTemplates)
    if (matched) order = matched
    else rootsMatch = false
  }
  const paths = order.map((j) => savePaths[j])
  const templates = order.map((j) => localTemplates[j])

  const localFiles = await listSaveFiles(paths)
  const bytes = localFiles.reduce((n, f) => n + f.size, 0)
  if (bytes > MAX_SYNC_BYTES) {
    throw new Error(
      tMain('mainRecomp.saves.tooLarge', {
        size: Math.round(bytes / 1048576),
        max: MAX_SYNC_BYTES / 1048576
      })
    )
  }
  const local = await hashSaves(paths)
  let cloudFiles: SaveFile[]
  let cloudHash: string | null = null
  let intact = true
  if (meta) {
    const roots = meta.roots.map((_, i) => join(base, 'current', String(i)))
    cloudFiles = await listSaveFiles(roots)
    const computed = (await hashSaves(roots)).hash
    // The Emulation folder sync (or a cloud app) may have delivered meta.json before the files, or the other way
    // round: not usable yet.
    intact = computed === meta.hash
    cloudHash = meta.hash
  } else {
    // No usable meta.json. An unreadable one, or files in current/ without one (the files arrived first, or meta.json
    // is still an online-only placeholder), is a copy that is not usable yet — never an empty copy an upload may
    // replace.
    cloudFiles = await listSaveFiles(await currentRoots(base))
    if (read.state === 'unreadable' || cloudFiles.length) intact = false
  }
  return {
    base,
    paths,
    templates,
    rootsMatch,
    local: {
      hash: local.hash,
      files: localFiles,
      bytes,
      newest: Math.max(0, ...localFiles.map((f) => f.mtimeMs))
    },
    cloud: { hash: cloudHash, meta, files: cloudFiles, intact }
  }
}

/**
 * readSides, after finishing or undoing this PC's own interrupted upload when the copy is not whole. `finished`: the
 * hash of the upload finished (these saves were this PC's when it copied them: what it last synced with).
 */
async function readSidesRecovered(
  entryId: string,
  savePaths: string[],
  deps: CloudSyncDeps
): Promise<{ sides: Sides; finished: string | null }> {
  const sides = await readSides(savePaths, deps)
  if (sides.cloud.intact) return { sides, finished: null }
  let recovered: Recovered = null
  try {
    recovered = await recoverOwnUpload(entryId, sides.base, deps)
  } catch (err) {
    deps.log.warn(`${tag(deps)}: ${entryId} this PC's interrupted copy could not be recovered`, err)
  }
  if (!recovered) return { sides, finished: null }
  return { sides: await readSides(savePaths, deps), finished: recovered.finished }
}

/** Back up this PC's saves into <backupsDir>/<safe id>/<ISO> <reason>.zip (10 kept). */
async function backupLocal(
  entryId: string,
  sides: Sides,
  deps: CloudSyncDeps,
  reason: string
): Promise<void> {
  if (!sides.local.files.length) return
  const now = (deps.now ?? (() => new Date()))()
  const dir = join(deps.backupsDir, cloudSaveKey(entryId))
  await zipSaves(join(dir, `${stamp(now)} ${safeName(reason)}.zip`), sides.local.files, {
    at: now.toISOString(),
    machine: deps.machine,
    hash: sides.local.hash,
    roots: sides.templates,
    reason
  })
  await pruneBackups(dir, KEEP_LOCAL_BACKUPS)
}

/**
 * Back up the Emulation folder's current copy into <backupsDir>/<safe id>/replaced copies/<ISO> <machine>.zip (10
 * kept) on this PC — also when its meta.json is missing or unreadable (then named after the time of the backup and
 * "unknown PC"). Not in the Emulation folder: backups there would be synced to every PC.
 */
async function backupCloud(entryId: string, sides: Sides, deps: CloudSyncDeps): Promise<void> {
  if (!sides.cloud.files.length) return
  const meta = sides.cloud.meta
  const now = (deps.now ?? (() => new Date()))()
  const dir = join(deps.backupsDir, cloudSaveKey(entryId), 'replaced copies')
  const at = meta ? new Date(meta.at) : now
  const when = Number.isNaN(at.getTime()) ? now : at
  const machine = meta?.machine ?? 'unknown PC'
  await zipSaves(join(dir, `${stamp(when)} ${safeName(machine)}.zip`), sides.cloud.files, {
    at: meta?.at ?? now.toISOString(),
    machine,
    hash: meta?.hash ?? null,
    roots: meta?.roots ?? [],
    reason: meta ? 'replaced' : 'replaced (its meta.json was missing or unreadable)'
  })
  await pruneBackups(dir, KEEP_CLOUD_BACKUPS)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** A name for work in progress in the copy folder that the Emulation folder sync leaves out (".playout-new/-old"). */
const inProgress = (name: string, kind: 'new' | 'old'): string =>
  `${name}.${randomBytes(4).toString('hex')}.playout-${kind}`

/**
 * Adopt the copy an older PlayOut kept in the cloud folder (`oldBase` = <cloudDir>/PlayOut Recomp Saves/<key>): when
 * `newBase` (<Emulation>/Recompilations Saves/<name>) has no copy yet and the old one is whole (meta.json readable and
 * its hash matching current/), its current/ and meta.json are copied over. The old copy is never changed. Returns
 * whether a copy was adopted; never throws (a cloud folder that cannot be reached adopts nothing).
 */
export async function adoptOldCopy(
  oldBase: string,
  newBase: string,
  log: Logger
): Promise<boolean> {
  try {
    if (normalizePath(resolve(oldBase)) === normalizePath(resolve(newBase))) return false
    if (
      (await pathExists(join(newBase, 'meta.json'))) ||
      (await pathExists(join(newBase, 'current')))
    )
      return false
    if (!(await isDir(oldBase, 3000))) return false
    const read = await loadCloudMeta(oldBase)
    if (!read.meta) return false
    const roots = read.meta.roots.map((_, i) => join(oldBase, 'current', String(i)))
    if ((await hashSaves(roots)).hash !== read.meta.hash) return false
    const files = await listSaveFiles(roots)
    await fs.mkdir(newBase, { recursive: true })
    const tmp = join(newBase, inProgress('current', 'new'))
    const metaTmp = join(newBase, inProgress('meta.json', 'new'))
    let placed = false
    try {
      for (const f of files)
        await copyFileAtomic(f.abs, join(tmp, String(f.root), ...f.rel.split('/')))
      for (let i = 0; i < roots.length; i++)
        await fs.mkdir(join(tmp, String(i)), { recursive: true })
      if ((await hashSaves(roots.map((_, i) => join(tmp, String(i))))).hash !== read.meta.hash)
        throw new Error('the old copy changed while it was being copied')
      await fs.writeFile(metaTmp, JSON.stringify(read.meta, null, 2))
      await renameRetry(tmp, join(newBase, 'current'))
      placed = true
      await renameRetry(metaTmp, join(newBase, 'meta.json'))
    } catch (err) {
      // Nothing half-adopted stays: a current/ without its meta.json would read as a copy still arriving.
      if (placed) await removeInside(newBase, join(newBase, 'current')).catch(() => undefined)
      await removeInside(newBase, tmp).catch(() => undefined)
      await removeInside(newBase, metaTmp).catch(() => undefined)
      throw err
    }
    log.info(`recomp saves: adopted the copy in ${oldBase} into ${newBase}`)
    return true
  } catch (err) {
    log.warn(`recomp saves: the old copy in ${oldBase} could not be adopted`, err)
    return false
  }
}

/** Whether this PC wrote the copy `meta` describes: by install id when both have one, else by the PC's name. */
export function isOwnCopy(
  meta: Pick<CloudMeta, 'machine' | 'machineId'>,
  deps: Pick<CloudSyncDeps, 'machine' | 'machineId'>
): boolean {
  if (deps.machineId && meta.machineId) return meta.machineId === deps.machineId
  return meta.machine === deps.machine
}

/** A pending meta.json an upload writes before it swaps current/ (renamed into place once the swap is done). */
const PENDING_META = /^meta\.json\.[0-9a-f]{8}\.playout-new$/i
/** The previous current/ an upload set aside while it swapped the new one in. */
const SET_ASIDE = /^current\.[0-9a-f]{8}\.playout-old$/i
/** Any work in progress an upload leaves in the copy folder. */
const LEFTOVER = /\.playout-(new|old)$/i

/** What recoverOwnUpload did: null nothing; `finished` the hash of the upload it finished (null: it undid one). */
type Recovered = { finished: string | null } | null

/** The saves hash of a copy's `count` roots under `dir` (<dir>/0, <dir>/1...). */
async function rootsHash(dir: string, count: number): Promise<string | null> {
  return (await hashSaves(Array.from({ length: count }, (_, i) => join(dir, String(i))))).hash
}

/** Remove the work in progress earlier uploads left in the copy folder (the copy itself is whole again). */
async function removeLeftovers(base: string, deps: CloudSyncDeps): Promise<void> {
  const names = await fs.readdir(base).catch(() => [] as string[])
  for (const n of names.filter((x) => LEFTOVER.test(x)))
    await removeInside(base, join(base, n)).catch((err) =>
      deps.log.warn(`${tag(deps)}: left over in the copy folder:`, join(base, n), err)
    )
}

/**
 * Finish or undo this PC's own upload that was cut off between swapping current/ and writing meta.json (PlayOut
 * closed, the PC lost power, or a sync client or antivirus held meta.json): current/ then holds the new saves while
 * meta.json still names the previous ones, which every PC reads as a copy still arriving, for good.
 * - A pending meta.json this PC wrote whose hash is current/'s is put in place (the upload is finished).
 * - Else, with meta.json this PC's and current/ not matching it, the previous current/ this PC set aside is put back
 *   when it matches meta.json (the upload is undone; what current/ held is backed up first).
 * Set-aside folders and pending meta.json files exist only on the PC that made them (the Emulation folder sync leaves
 * them out). Returns what was done (null: nothing), with the hash of an upload it finished.
 */
async function recoverOwnUpload(
  entryId: string,
  base: string,
  deps: CloudSyncDeps
): Promise<Recovered> {
  let names: string[]
  try {
    names = await fs.readdir(base)
  } catch {
    return null
  }
  const current = join(base, 'current')
  for (const n of names.filter((x) => PENDING_META.test(x)).sort()) {
    const pending = (await loadMetaFile(join(base, n))).meta
    if (!pending || !isOwnCopy(pending, deps)) continue
    if ((await rootsHash(current, pending.roots.length)) !== pending.hash) continue
    await renameRetry(join(base, n), join(base, 'meta.json'))
    deps.log.info(`${tag(deps)}: ${entryId} finished this PC's interrupted copy in ${base}`)
    await removeLeftovers(base, deps)
    return { finished: pending.hash }
  }
  const meta = (await loadCloudMeta(base)).meta
  if (!meta || !isOwnCopy(meta, deps)) return null
  const count = meta.roots.length
  if ((await rootsHash(current, count)) === meta.hash) return null
  for (const n of names.filter((x) => SET_ASIDE.test(x)).sort()) {
    const old = join(base, n)
    if ((await rootsHash(old, count)) !== meta.hash) continue
    if (await pathExists(current)) {
      const files = await listSaveFiles(await currentRoots(base))
      if (files.length) {
        const now = (deps.now ?? (() => new Date()))()
        const dir = join(deps.backupsDir, cloudSaveKey(entryId), 'replaced copies')
        await zipSaves(join(dir, `${stamp(now)} unfinished copy.zip`), files, {
          at: now.toISOString(),
          machine: deps.machine,
          hash: null,
          roots: meta.roots,
          reason: 'an unfinished copy, taken out'
        })
        await pruneBackups(dir, KEEP_CLOUD_BACKUPS)
      }
      await renameRetry(current, join(base, inProgress('current.failed', 'old')))
    }
    await renameRetry(old, current)
    deps.log.info(`${tag(deps)}: ${entryId} undid this PC's interrupted copy in ${base}`)
    await removeLeftovers(base, deps)
    return { finished: null }
  }
  return null
}

/**
 * Copy this PC's saves to the Emulation folder: a fresh copy in a temp folder, the current copy backed up (unless it
 * is these very saves), a pending meta.json written, current/ swapped in, then the pending meta.json renamed into
 * place. A failure part way puts the previous copy back, so current/ and meta.json agree again; when even that fails
 * (or PlayOut stops part way), the pending meta.json and the set-aside copy stay for recoverOwnUpload.
 */
/**
 * The history an upload records: `replaced` is the copy hash the uploader knowingly replaces (the copy it last synced
 * with, or the one the user chose to overwrite); null when it replaces no copy it knows of.
 */
function nextHistory(sides: Sides, replaced: string | null): string[] {
  if (replaced === null) return []
  const meta = sides.cloud.meta
  if (meta && meta.hash === replaced) return [replaced, ...(meta.history ?? [])]
  return [replaced]
}

async function upload(
  entryId: string,
  sides: Sides,
  deps: CloudSyncDeps,
  history: string[]
): Promise<string | null> {
  const now = (deps.now ?? (() => new Date()))()
  const base = sides.base
  const paths = sides.paths
  await fs.mkdir(base, { recursive: true })
  const tmp = join(base, inProgress('current', 'new'))
  const current = join(base, 'current')
  const old = join(base, inProgress('current', 'old'))
  const metaTmp = join(base, inProgress('meta.json', 'new'))
  let movedOld = false
  let swapped = false
  try {
    for (const f of sides.local.files)
      await copyFileAtomic(f.abs, join(tmp, String(f.root), ...f.rel.split('/')))
    for (let i = 0; i < paths.length; i++) await fs.mkdir(join(tmp, String(i)), { recursive: true })
    // The copy must be what was hashed (a save written meanwhile would make the copy inconsistent).
    const copied = await hashSaves(paths.map((_, i) => join(tmp, String(i))))
    if (copied.hash !== sides.local.hash)
      throw new Error(tMain('mainRecomp.saves.changedWhileCopying'))
    // Whatever is replaced is kept first (a backup failure stops the upload: nothing is replaced unsaved).
    if (sides.cloud.hash !== sides.local.hash) await backupCloud(entryId, sides, deps)
    const meta: CloudMeta = {
      hash: sides.local.hash ?? '',
      at: now.toISOString(),
      machine: deps.machine,
      ...(deps.machineId ? { machineId: deps.machineId } : {}),
      roots: sides.templates,
      history: history.filter((h) => h !== sides.local.hash).slice(0, MAX_COPY_HISTORY),
      ...(deps.extraMeta ? { extra: { ...deps.extraMeta } } : {})
    }
    // Written before the swap: should PlayOut stop between the swap and meta.json, it finishes the copy later.
    await fs.writeFile(metaTmp, JSON.stringify(meta, null, 2))
    try {
      await renameRetry(current, old)
      movedOld = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await renameRetry(tmp, current)
    swapped = true
    await renameRetry(metaTmp, join(base, 'meta.json'))
    swapped = false
  } catch (err) {
    let newInPlace = swapped
    if (swapped) {
      // meta.json still describes the previous copy: take the new one out again.
      const discard = join(base, inProgress('current.failed', 'old'))
      try {
        await renameRetry(current, discard)
        newInPlace = false
        await removeInside(base, discard).catch(() => undefined)
      } catch (e) {
        deps.log.warn(`${tag(deps)}: the new copy could not be taken out again`, e)
      }
    }
    if (movedOld && !(await pathExists(current).catch(() => true))) {
      await renameRetry(old, current).catch((e) =>
        deps.log.warn(`${tag(deps)}: the previous copy could not be put back from`, old, e)
      )
    }
    // The new copy still in place: its pending meta.json stays, and the next copy finishes it (recoverOwnUpload).
    if (!newInPlace) await fs.rm(metaTmp, { force: true }).catch(() => undefined)
    await removeInside(base, tmp).catch(() => undefined)
    throw err
  }
  if (movedOld)
    await removeInside(base, old).catch((err) =>
      deps.log.warn(`${tag(deps)}: old copy left`, old, err)
    )
  await removeLeftovers(base, deps)
  return sides.local.hash
}

/**
 * Make this PC's save folders hold exactly the copy: its files written (each via a temp file), local files the copy
 * does not have deleted — only files the save listing reports, inside their root. Copied root i goes into the local
 * folder with the same template (sides.paths is in the copy's order); different folders are refused.
 */
function checkRestorable(sides: Sides): void {
  const meta = sides.cloud.meta
  if (meta && (!sides.rootsMatch || meta.roots.length !== sides.paths.length)) {
    const none = tMain('mainRecomp.saves.noFolders')
    throw new Error(
      tMain('mainRecomp.saves.foldersDiffer', {
        copy: meta.roots.join(', ') || none,
        here: sides.templates.join(', ') || none
      })
    )
  }
}

/**
 * restore, all or nothing: every file it replaces or deletes is first copied aside (into this recompilation's local
 * backups folder, never the Emulation folder), and a failure part way puts them back and takes out the files it
 * added, so this PC never keeps a mix of its saves and the copy's.
 */
async function restore(entryId: string, sides: Sides, deps: CloudSyncDeps): Promise<string | null> {
  const meta = sides.cloud.meta
  if (!meta) return null
  checkRestorable(sides)
  const backups = join(deps.backupsDir, cloudSaveKey(entryId))
  const stash = join(backups, inProgress('restore', 'old'))
  /** Each change made, in order: the file, the folder it may be deleted from, and where its old content is kept. */
  const done: { target: string; within: string; kept: string | null }[] = []
  const keep = async (target: string, within: string): Promise<void> => {
    const kept = (await pathExists(target)) ? join(stash, String(done.length)) : null
    if (kept) await copyFileAtomic(target, kept)
    done.push({ target, within, kept })
  }
  try {
    const hash = await restoreFiles(sides, meta, keep)
    await removeInside(backups, stash).catch(() => undefined)
    return hash
  } catch (err) {
    let whole = true
    for (const d of done.reverse()) {
      try {
        if (d.kept) await copyFileAtomic(d.kept, d.target)
        else await removeInside(d.within, d.target)
      } catch (e) {
        whole = false
        deps.log.warn(`${tag(deps)}: ${entryId} could not put ${d.target} back`, e)
      }
    }
    if (whole) await removeInside(backups, stash).catch(() => undefined)
    else
      deps.log.warn(
        `${tag(deps)}: ${entryId} this PC's saves before the restore are kept in`,
        stash
      )
    throw err
  }
}

async function restoreFiles(
  sides: Sides,
  meta: CloudMeta,
  keep: (target: string, within: string) => Promise<void>
): Promise<string | null> {
  const savePaths = sides.paths
  // A root that is a single file (the copy keeps it as current/<i>/<its name>): a file here, or — when missing
  // here — a copied root holding just one file of that name.
  const fileRoot: boolean[] = []
  for (let i = 0; i < savePaths.length; i++) {
    const st = await fs.stat(savePaths[i]).catch(() => null)
    const inCloud = sides.cloud.files.filter((f) => f.root === i)
    fileRoot[i] = st
      ? st.isFile()
      : inCloud.length === 1 &&
        inCloud[0].rel.toLowerCase() === basename(savePaths[i]).toLowerCase()
  }
  const want = new Set<string>()
  for (const f of sides.cloud.files) {
    const root = savePaths[f.root]
    if (root === undefined) continue
    const target = fileRoot[f.root] ? root : join(root, ...f.rel.split('/'))
    if (!isInside(root, target)) throw new Error(`Refusing to write ${target} outside ${root}.`)
    want.add(normalizePath(target))
    await keep(target, fileRoot[f.root] ? dirname(root) : root)
    await copyFileAtomic(f.abs, target)
  }
  for (const f of sides.local.files) {
    if (want.has(normalizePath(f.abs))) continue
    const root = savePaths[f.root]
    // A single-file root the copy does not have: only its parent may hold it, delete just that file.
    const within = normalizePath(root) === normalizePath(f.abs) ? dirname(root) : root
    await keep(f.abs, within)
    await removeInside(within, f.abs)
  }
  const after = await hashSaves(savePaths)
  if (after.hash !== meta.hash) throw new Error(tMain('mainRecomp.saves.copyMismatch'))
  return after.hash
}

function synced(state: RecompCloudState, hash: string | null, now: Date): RecompCloudState {
  const out: RecompCloudState = {
    ...state,
    syncedHash: hash,
    localHash: hash,
    syncedAt: now.toISOString(),
    pending: false,
    error: null,
    conflict: null
  }
  // Both sides are the same again: a "Start fresh" answered before is done with.
  delete out.freshStart
  return out
}

function failed(
  state: RecompCloudState,
  err: unknown,
  localHash?: string | null
): RecompCloudState {
  return {
    ...state,
    localHash: localHash === undefined ? state.localHash : localHash,
    pending: true,
    error: err instanceof Error ? err.message : String(err)
  }
}

/**
 * Bring this recompilation's saves and its copy in the Emulation folder in step (see the file comment for the rule).
 * Never throws: a problem (the Emulation folder's drive offline, a locked file) comes back as `pending` + `error`, and
 * playing goes on.
 * `savePaths` are real folders (expanded templates), index-aligned with `deps.templates`.
 */
export async function syncSaves(
  entryId: string,
  savePaths: string[],
  state: RecompCloudState,
  deps: CloudSyncDeps,
  direction: 'before-play' | 'after-play' | 'manual'
): Promise<RecompCloudState> {
  if (!state.enabled) return state
  const now = (deps.now ?? (() => new Date()))()
  if (!savePaths.length) {
    return {
      ...state,
      pending: false,
      error: tMain('mainRecomp.saves.unknownLocationShort')
    }
  }
  let sides: Sides
  let finished: string | null
  try {
    ;({ sides, finished } = await readSidesRecovered(entryId, savePaths, deps))
  } catch (err) {
    deps.log.warn(`${tag(deps)}: ${entryId} (${direction}) cannot sync:`, err)
    return failed(state, err)
  }
  // An upload of this PC's finished just now: what this PC last synced with, as if it had not been cut off.
  if (finished) state = { ...state, syncedHash: finished }
  const L = sides.local.hash
  const C = sides.cloud.hash
  const S = state.syncedHash
  try {
    if (!sides.cloud.intact) {
      // Our own interrupted upload, with the local saves unchanged since: write it again. Anyone else's: wait.
      const meta = sides.cloud.meta
      if (meta && isOwnCopy(meta, deps) && L !== null && L === S) {
        // This PC's own copy keeps its history (or, when its meta.json is behind these saves, replaces it).
        const history = meta.hash === L ? (meta.history ?? []) : nextHistory(sides, meta.hash)
        await upload(entryId, sides, deps, history)
        return synced(state, L, now)
      }
      return failed(
        state,
        new Error(
          meta
            ? tMain('mainRecomp.saves.stillArriving')
            : tMain('mainRecomp.saves.stillArrivingMeta')
        ),
        L
      )
    }
    if (C === L) {
      return L === null
        ? { ...state, localHash: null, pending: false, error: null, conflict: null }
        : synced(state, L, now)
    }
    if (C === null) {
      deps.log.info(
        `${tag(deps)}: ${entryId} copying to the Emulation folder (${direction}, no copy there)`
      )
      return synced(state, await upload(entryId, sides, deps, []), now)
    }
    if (L === null) {
      if (S !== null) {
        // The player chose "Start fresh": no saves here is what they asked for, and the copy waits for this PC's
        // next saves (the upload after play replaces it, backed up first). A copy that moved on since asks again.
        if (state.freshStart && C === S)
          return { ...state, localHash: null, pending: false, error: null, conflict: null }
        // This PC synced the game before and its saves are gone (deleted, or the game reset them): never copied back
        // silently, the player is asked (Restore from the Emulation folder / Start fresh).
        deps.log.info(`${tag(deps)}: ${entryId} saves gone from this PC, asking (${direction})`)
        return {
          ...state,
          localHash: null,
          pending: false,
          error: null,
          conflict: {
            localAt: now.toISOString(),
            cloudAt: sides.cloud.meta?.at ?? now.toISOString(),
            cloudDevice: sides.cloud.meta?.machine ?? 'another PC',
            gone: true
          }
        }
      }
      // Never synced here: a first-time setup on this PC takes the copy.
      deps.log.info(
        `${tag(deps)}: ${entryId} copying back from the Emulation folder (${direction}, nothing here)`
      )
      return synced(state, await restore(entryId, sides, deps), now)
    }
    // "The saves are gone" still unanswered while saves came back (a paired PC's stream started the game meanwhile):
    // neither side is taken over the other, the player picks between both.
    const unanswered = state.conflict?.gone === true
    // Only a copy that moved on from this PC's last sync is taken (its history reaches S). One that did not is a
    // conflict although this PC's saves did not change: two PCs uploaded from the same saves and the Emulation folder
    // sync kept the other's copy.
    const history = sides.cloud.meta?.history
    if (
      !unanswered &&
      L === S &&
      C !== S &&
      (history === undefined || (S !== null && history.includes(S)))
    ) {
      deps.log.info(
        `${tag(deps)}: ${entryId} copy newer (${sides.cloud.meta?.machine}), copying back (${direction})`
      )
      checkRestorable(sides)
      await backupLocal(entryId, sides, deps, 'before restore')
      return synced(state, await restore(entryId, sides, deps), now)
    }
    if (!unanswered && C === S && L !== S) {
      deps.log.info(
        `${tag(deps)}: ${entryId} local newer, copying to the Emulation folder (${direction})`
      )
      return synced(state, await upload(entryId, sides, deps, nextHistory(sides, C)), now)
    }
    // Both changed since the last sync (or never synced and different): the user decides.
    deps.log.info(`${tag(deps)}: ${entryId} conflict (${direction})`)
    return {
      ...state,
      localHash: L,
      pending: false,
      error: null,
      conflict: {
        localAt: new Date(sides.local.newest || now.getTime()).toISOString(),
        cloudAt: sides.cloud.meta?.at ?? now.toISOString(),
        cloudDevice: sides.cloud.meta?.machine ?? 'another PC'
      }
    }
  } catch (err) {
    deps.log.warn(`${tag(deps)}: ${entryId} (${direction}) sync failed:`, err)
    return failed(state, err, L)
  }
}

/**
 * An answer to a save conflict: 'local' keeps this PC's saves, 'cloud' the Emulation folder's copy (Restore, when the
 * saves are gone), 'fresh' starts fresh (only to "the saves are gone from this PC").
 */
export type SaveConflictAnswer = 'local' | 'cloud' | 'fresh'

/** Start fresh was pressed on a question that no longer stands (the saves came back): nothing was changed. */
export class FreshChangedError extends Error {
  constructor() {
    super(tMain('mainRecomp.saves.freshChanged'))
    this.name = 'FreshChangedError'
  }
}

/**
 * The user's answer to a conflict: keep this PC's saves (the Emulation folder's copy is backed up on this PC, then
 * replaced) or the copy's (this PC's saves are backed up, then replaced). Never throws, except FreshChangedError (the
 * state is left as it was: the caller reads the question again).
 * To "the saves are gone from this PC" (conflict.gone): 'cloud' restores them from the copy, 'fresh' starts fresh —
 * the game starts with no saves, nothing is deleted, and this PC's next saves count as newer than the copy (the upload
 * after play replaces it, backed up into "replaced copies" first).
 */
export async function resolveConflict(
  entryId: string,
  savePaths: string[],
  state: RecompCloudState,
  keep: SaveConflictAnswer,
  deps: CloudSyncDeps
): Promise<RecompCloudState> {
  const now = (deps.now ?? (() => new Date()))()
  let sides: Sides
  try {
    if (!savePaths.length) throw new Error(tMain('mainRecomp.saves.unknownLocationShort'))
    sides = (await readSidesRecovered(entryId, savePaths, deps)).sides
  } catch (err) {
    return failed(state, err)
  }
  try {
    if (keep === 'fresh') {
      // Only while the saves are still gone: saves that came back meanwhile (a paired PC's stream) are never
      // uploaded over the copy by a Start fresh pressed on the older question.
      if (sides.local.hash !== null || !state.conflict?.gone || sides.cloud.hash === null)
        throw new FreshChangedError()
      deps.log.info(`${tag(deps)}: ${entryId} starts fresh (the copy stays until the next upload)`)
      return {
        ...state,
        // What this PC last synced with is the copy as it is now: this PC's next saves are newer than it.
        syncedHash: sides.cloud.hash,
        localHash: null,
        freshStart: true,
        pending: false,
        error: null,
        conflict: null
      }
    }
    if (keep === 'local') {
      if (sides.local.hash === null) throw new Error(tMain('mainRecomp.saves.noLocal'))
      const replaced = sides.cloud.meta?.hash ?? null
      return synced(state, await upload(entryId, sides, deps, nextHistory(sides, replaced)), now)
    }
    if (!sides.cloud.meta || sides.cloud.hash === null)
      throw new Error(tMain('mainRecomp.saves.noCloud'))
    if (!sides.cloud.intact) throw new Error(tMain('mainRecomp.saves.stillArrivingRetry'))
    if (sides.local.hash !== sides.cloud.hash) {
      checkRestorable(sides)
      await backupLocal(entryId, sides, deps, 'before restore')
      return synced(state, await restore(entryId, sides, deps), now)
    }
    return synced(state, sides.local.hash, now)
  } catch (err) {
    if (err instanceof FreshChangedError) throw err
    deps.log.warn(`${tag(deps)}: ${entryId} resolving the conflict (${keep}) failed:`, err)
    return failed(state, err, sides.local.hash)
  }
}
