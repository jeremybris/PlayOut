// Folder-size probe shared by the state-only stores (Epic, Xbox, Ubisoft): the install folder's growth is the only
// progress signal they offer. Bounded depth, never throws on an unreadable folder.
import { join } from 'path'
import { listDir, statSafe } from '../util/fs'

export interface DirSizeOptions {
  /** Top-level entry names to skip (Epic's `.egstore`). */
  exclude?: string[]
  /** Maximum depth below the root (default 12). */
  maxDepth?: number
  /** Stop counting after this many files (default 200 000) so a huge tree cannot stall a probe. */
  maxFiles?: number
}

/** Total size in bytes of the files under `root`, 0 when it does not exist. */
export async function dirSize(root: string, options: DirSizeOptions = {}): Promise<number> {
  const exclude = new Set((options.exclude ?? []).map((n) => n.toLowerCase()))
  const maxDepth = options.maxDepth ?? 12
  const maxFiles = options.maxFiles ?? 200_000
  let total = 0
  let files = 0
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length && files < maxFiles) {
    const { dir, depth } = queue.shift()!
    for (const entry of await listDir(dir)) {
      if (depth === 0 && exclude.has(entry.name.toLowerCase())) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: path, depth: depth + 1 })
      } else if (entry.isFile()) {
        files++
        total += (await statSafe(path))?.size ?? 0
        if (files >= maxFiles) break
      }
    }
  }
  return total
}
