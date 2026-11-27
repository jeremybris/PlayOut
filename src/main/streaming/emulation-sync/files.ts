import { promises as fs, realpath } from 'fs'
import { promisify } from 'util'
import { dirname, join } from 'path'
import { renameRetry, RM_RETRY } from '../../util/fs'

/** Move a file, across drives too (rename where it can, else copy then delete). */
export async function moveFile(from: string, to: string): Promise<void> {
  await fs.mkdir(dirname(to), { recursive: true })
  try {
    await renameRetry(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.copyFile(from, to)
    await fs.rm(from, RM_RETRY)
  }
}

const exists = (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  )

const realpathNative = promisify(realpath.native)

/**
 * Whether `relative` under `root` really is there: no junction, link or short (8.3) name anywhere on the way. The
 * deepest part that exists must resolve to the same place by its real path; the parts after it are made fresh.
 */
export async function realInside(root: string, relative: string): Promise<boolean> {
  const parts = relative.split('/')
  const realRoot = await realpathNative(root).catch(() => null)
  // Some drives (RAM disks, virtual or cloud drives) cannot tell real paths: there, every part on the way that exists
  // must simply not be a link.
  if (!realRoot) return noLinkOnTheWay(root, parts)
  for (let k = parts.length; k > 0; k--) {
    const path = join(root, ...parts.slice(0, k))
    const real = await realpathNative(path).catch(() => null)
    if (real === null) continue
    return real.toLowerCase() === join(realRoot, ...parts.slice(0, k)).toLowerCase()
  }
  return true
}

async function noLinkOnTheWay(root: string, parts: string[]): Promise<boolean> {
  if (
    !(await fs.stat(root).then(
      (st) => st.isDirectory(),
      () => false
    ))
  )
    return false
  for (let k = 1; k <= parts.length; k++) {
    const st = await fs.lstat(join(root, ...parts.slice(0, k))).catch(() => null)
    if (!st) return true
    if (st.isSymbolicLink()) return false
  }
  return true
}

/** Backups of replaced and deleted files are kept this long. */
export const BACKUP_DAYS = 30

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/**
 * The sync's backups: `<stateDir>\backups\<date and time>\<path in the Emulation folder>`, outside the Emulation
 * folder so they are never synced themselves. A file replaced by the other PC's copy in a conflict, or deleted
 * because the other PC deleted it, goes here first.
 */
export class Backups {
  /** The content last backed up for each path (by hash), so a replace that keeps failing copies it once. */
  private readonly copied = new Map<string, string>()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  /** Move `file` (at `relative` in the Emulation folder) into today's backup; the path it went to. */
  async keep(file: string, relative: string): Promise<string> {
    const target = join(this.dir, stamp(this.now()).slice(0, 19), ...relative.split('/'))
    let dest = target
    for (
      let i = 2;
      await fs.stat(dest).then(
        () => true,
        () => false
      );
      i++
    )
      dest = `${target}.${i}`
    await moveFile(file, dest)
    return dest
  }

  /**
   * Copy `file` into today's backup, leaving it where it is (it is replaced in one step afterwards). `hash` is its
   * content: a copy of the same content made before (the replace failed then) is not made again.
   */
  async copy(file: string, relative: string, hash: string): Promise<string | null> {
    const key = relative.toLowerCase()
    if (this.copied.get(key) === hash) return null
    const target = join(this.dir, stamp(this.now()).slice(0, 19), ...relative.split('/'))
    let dest = target
    for (let i = 2; await exists(dest); i++) dest = `${target}.${i}`
    await fs.mkdir(dirname(dest), { recursive: true })
    await fs.copyFile(file, dest)
    this.copied.set(key, hash)
    return dest
  }

  /** Delete backup folders older than BACKUP_DAYS. */
  async prune(): Promise<void> {
    const cutoff = this.now() - BACKUP_DAYS * 86_400_000
    const names = await fs.readdir(this.dir).catch(() => [] as string[])
    for (const name of names) {
      const when = Date.parse(
        name.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/, '$1T$2:$3:$4Z')
      )
      if (Number.isFinite(when) && when < cutoff)
        await fs.rm(join(this.dir, name), RM_RETRY).catch(() => {})
    }
  }
}
