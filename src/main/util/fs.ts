import { promises as fs, type Dirent, type Stats } from 'fs'
import { join } from 'path'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function statSafe(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  const s = await statSafe(path)
  return !!s && s.isDirectory()
}

export async function isFile(path: string): Promise<boolean> {
  const s = await statSafe(path)
  return !!s && s.isFile()
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readTextIfExists(path)
  if (text === null) return null
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T
  } catch {
    return null
  }
}

export async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

export interface WalkOptions {
  /** Maximum depth below `root` (0 = root entries only). Default 8. */
  maxDepth?: number
  /** Return false to skip a directory (and its subtree). */
  enterDir?: (path: string, name: string, depth: number) => boolean
  /** Skip entries whose name starts with '.' (default true). */
  skipHidden?: boolean
}

export interface WalkEntry {
  path: string
  name: string
  depth: number
  isDirectory: boolean
}

/** Breadth-first directory walk that never throws on unreadable folders. */
export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const maxDepth = options.maxDepth ?? 8
  const skipHidden = options.skipHidden ?? true
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length) {
    const { dir, depth } = queue.shift()!
    for (const entry of await listDir(dir)) {
      if (skipHidden && entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const isDir = entry.isDirectory()
      yield { path, name: entry.name, depth, isDirectory: isDir }
      if (isDir && depth < maxDepth && (options.enterDir?.(path, entry.name, depth) ?? true)) {
        queue.push({ dir: path, depth: depth + 1 })
      }
    }
  }
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * fs.rename with retries on Windows: an antivirus scanner (Defender) opens freshly written files without
 * FILE_SHARE_DELETE, so renaming them, or a folder holding them, fails with EPERM / EACCES / EBUSY for a moment.
 * Other errors, and every error elsewhere, are thrown at once.
 */
export async function renameRetry(
  from: string,
  to: string,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; platform?: string } = {}
): Promise<void> {
  const attempts = options.attempts ?? 20
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const platform = options.platform ?? process.platform
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (platform !== 'win32' || !BUSY_CODES.has(code) || i + 1 >= attempts) throw err
      await sleep(Math.min(100 * (i + 1), 1000))
    }
  }
}

/** fs.rm options that ride out the same short antivirus locks (Node retries EBUSY / EPERM / ENOTEMPTY itself). */
export const RM_RETRY = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const
