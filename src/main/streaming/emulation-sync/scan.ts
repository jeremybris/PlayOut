import { createHash } from 'crypto'
import { createReadStream, promises as fs, type Dirent } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { renameRetry } from '../../util/fs'
import { isExcluded, syncKey, type SyncScope } from './rules'
import { isHeldDirName } from '../../services/held-files'
import { tMain } from '../../i18n'

/**
 * The Emulation folder as the sync sees it: every file not excluded, with its size, modified time and SHA-1. Hashing
 * is the slow part, so hashes are kept in an index file and reused while a file's size and modified time stay the
 * same. A folder that cannot be listed stops the scan (ScanError): read as empty, it would look like everything in it
 * was deleted. Links (junctions, symbolic links, and the reparse points Windows reports as links, such as cloud
 * placeholders) are never followed: they are reported, and the sync leaves everything at and under them alone.
 */

export interface SyncFile {
  /** Relative path, forward slashes, as on disk. */
  path: string
  size: number
  /** Modified time, ms, at full precision. */
  mtimeMs: number
  /** SHA-1, hex. */
  hash: string
}

export class ScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScanError'
  }
}

/**
 * Far more files than any Emulation folder outside roms holds (and its list still fits what a host may send); past it
 * the sync stops rather than run for hours.
 */
export const MAX_SYNC_FILES = 100_000
/** While hashing, the remembered hashes are written down this often (a stopped scan keeps its work). */
const INDEX_SAVE_MS = 15_000

interface Listed {
  path: string
  size: number
  mtimeMs: number
}

export interface Tree {
  files: Map<string, Listed>
  /** Keys of links (and so of everything under them). */
  linked: string[]
}

/** Every file under `root` (not excluded, no links), by sync key. Throws ScanError when a folder cannot be read. */
export async function listTree(root: string, scope: SyncScope): Promise<Tree> {
  const st = await fs.stat(root).catch(() => null)
  if (!st?.isDirectory())
    throw new ScanError(tMain('mainStreaming.emuSync.folderMissing', { folder: root }))
  const files = new Map<string, Listed>()
  const linked: string[] = []
  const stack: string[] = ['']
  while (stack.length) {
    const rel = stack.pop()!
    const dir = rel ? join(root, ...rel.split('/')) : root
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      throw new ScanError(
        tMain('mainStreaming.emuSync.folderUnreadable', {
          folder: dir,
          error: (err as Error).message
        })
      )
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (isExcluded(childRel, scope)) continue
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        // Windows lists every reparse point as a link, cloud files (OneDrive) too: lstat tells the real links apart.
        const lst = await fs.lstat(join(dir, entry.name)).catch(() => null)
        if (!lst || lst.isSymbolicLink()) {
          linked.push(syncKey(childRel))
          continue
        }
        isDir = lst.isDirectory()
        isFile = lst.isFile()
      }
      if (isDir) {
        // A disc image or folder moved aside while a recompilation is tested (services/held-files.ts): never synced.
        if (isHeldDirName(entry.name)) continue
        stack.push(childRel)
        continue
      }
      if (!isFile) continue
      const fst = await fs.lstat(join(dir, entry.name)).catch(() => null)
      // Gone between the listing and now (an emulator replacing a file): the next pass sees it.
      if (!fst?.isFile()) continue
      files.set(syncKey(childRel), { path: childRel, size: fst.size, mtimeMs: fst.mtimeMs })
      if (files.size > MAX_SYNC_FILES)
        throw new ScanError(tMain('mainStreaming.emuSync.tooManyFiles', { max: MAX_SYNC_FILES }))
    }
  }
  return { files, linked }
}

export async function sha1File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha1')
  await pipeline(createReadStream(path), hash, { signal })
  return hash.digest('hex')
}

interface IndexFile {
  version: 1
  root: string
  files: Record<string, { size: number; mtimeMs: number; hash: string }>
}

let tmpCounter = 0

/** Write JSON to `file` through a temp file of its own (writers never share one). */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`
  await fs.mkdir(join(file, '..'), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(data))
  await renameRetry(tmp, file)
}

/** Hashes remembered between scans (one index file per role and folder). */
export class HashIndex {
  private files = new Map<string, { size: number; mtimeMs: number; hash: string }>()
  private dirty = false
  private root: string | null = null
  private lastSave = 0

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  /** Loaded for `root` (from disk the first time, or when the folder changed). */
  async use(root: string): Promise<void> {
    if (this.root !== null && this.root.toLowerCase() === root.toLowerCase()) return
    this.root = root
    this.files.clear()
    this.dirty = false
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as IndexFile
      if (data.version === 1 && data.root.toLowerCase() === root.toLowerCase())
        for (const [k, v] of Object.entries(data.files)) this.files.set(k, v)
    } catch {
      /* none yet, or unreadable: hashes are computed again */
    }
  }

  get(key: string, size: number, mtimeMs: number): string | null {
    const f = this.files.get(key)
    return f && f.size === size && f.mtimeMs === mtimeMs ? f.hash : null
  }

  set(key: string, size: number, mtimeMs: number, hash: string): void {
    this.files.set(key, { size, mtimeMs, hash })
    this.dirty = true
  }

  /** Forget files no longer there. */
  keepOnly(keys: Set<string>): void {
    for (const k of this.files.keys())
      if (!keys.has(k)) {
        this.files.delete(k)
        this.dirty = true
      }
  }

  async save(): Promise<void> {
    if (!this.dirty || this.root === null) return
    this.dirty = false
    this.lastSave = this.now()
    const data: IndexFile = { version: 1, root: this.root, files: Object.fromEntries(this.files) }
    await writeJsonAtomic(this.file, data).catch((err) => {
      this.dirty = true
      throw err
    })
  }

  /** Save when the last save is older than `ms`. */
  async saveIfDue(ms = INDEX_SAVE_MS): Promise<void> {
    if (this.dirty && this.now() - this.lastSave >= ms) await this.save().catch(() => {})
  }
}

export interface ScanResult {
  files: Map<string, SyncFile>
  /**
   * Keys of files that are there but could not be read whole (locked by an emulator, changing while read): this pass
   * leaves them alone, so they never count as deleted.
   */
  unsettled: Set<string>
  /** Keys of links: everything at or under them is left alone. */
  linked: string[]
}

/** The folder's files with their hashes. */
export async function scanFolder(
  root: string,
  scope: SyncScope,
  index: HashIndex,
  signal?: AbortSignal
): Promise<ScanResult> {
  await index.use(root)
  const tree = await listTree(root, scope)
  const out = new Map<string, SyncFile>()
  const unsettled = new Set<string>()
  for (const [key, f] of tree.files) {
    if (signal?.aborted) {
      await index.save().catch(() => {})
      throw signal.reason ?? new Error('Cancelled')
    }
    let hash = index.get(key, f.size, f.mtimeMs)
    if (!hash) {
      const path = join(root, ...f.path.split('/'))
      try {
        hash = await sha1File(path, signal)
        const after = await fs.lstat(path)
        if (after.size !== f.size || after.mtimeMs !== f.mtimeMs) {
          unsettled.add(key)
          continue
        }
      } catch (err) {
        if (signal?.aborted) {
          await index.save().catch(() => {})
          throw err
        }
        unsettled.add(key)
        continue
      }
      index.set(key, f.size, f.mtimeMs, hash)
      await index.saveIfDue()
    }
    out.set(key, { ...f, hash })
  }
  index.keepOnly(new Set(tree.files.keys()))
  await index.save().catch(() => {})
  return { files: out, unsettled, linked: tree.linked }
}
