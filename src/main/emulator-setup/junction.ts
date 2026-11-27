import { promises as fs } from 'fs'
import type { Stats } from 'fs'
import { dirname, join, resolve } from 'path'
import type { Logger } from '../logger'
import { renameRetry } from '../util/fs'
import { tMain } from '../i18n'

/**
 * NTFS directory junctions for the emulator setup (docs/emulator-setup.md, "General rules"). A junction is used where a
 * partial config would lose the emulator's defaults: the emulator keeps writing into its own folder, and the folder is
 * a link into the data Emulation folder.
 *
 * Safety: a junction is only ever removed as a link (unlink/rmdir of the link itself), never recursively, so nothing is
 * deleted through it.
 */

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Normalises a path for comparison: no \\?\ or \??\ prefix, resolved, no trailing separator, lower case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    resolve(p.replace(/^\\\\\?\\|^\\\?\?\\/, ''))
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

/** True when `path` is a junction (or a directory symlink): Node reports junctions as symbolic links on Windows. */
export async function isJunction(path: string): Promise<boolean> {
  const st = await lstatOrNull(path)
  return st !== null && st.isSymbolicLink()
}

/** Removes a junction or symlink itself (never what it points at). */
async function removeLink(path: string): Promise<void> {
  try {
    await fs.unlink(path)
  } catch {
    // Some Windows builds refuse unlink on a directory reparse point; rmdir (without recursion) removes only the link.
    await fs.rmdir(path)
  }
}

/**
 * Moves one entry, copying then removing it when source and destination are on different volumes. The copy goes to
 * `<to>.playout-new` first and is renamed into place when complete, so a copy cut short (PlayOut closed meanwhile)
 * never stands at `to` as if it were whole: the next move starts that copy over.
 */
export async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    const partial = `${to}.playout-new`
    await fs.rm(partial, { recursive: true, force: true })
    try {
      await fs.cp(from, partial, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true
      })
      // An antivirus scan of the files just written can hold the folder for a moment.
      await renameRetry(partial, to)
    } catch (copyErr) {
      await fs.rm(partial, { recursive: true, force: true }).catch(() => {})
      throw copyErr
    }
    await fs.rm(from, { recursive: true, force: true })
  }
}

async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null
}

/** How a mergeFolderInto went. */
export interface MergeResult {
  /** Files already in `to`, whose copy in `from` was set aside in <from>.playout-old (`to`'s copy wins). */
  conflicts: number
  /**
   * Entries that could not be moved (held open past the retries, a full disk) or showed up while it ran: they stay in
   * `from`, which is then neither removed nor set aside, so a later run moves them. 0 = `from` is gone.
   */
  left: number
}

/** Renames, riding out the short locks Windows puts on a file (antivirus, Explorer's previews) with a few retries. */
const renameBriefly = (from: string, to: string): Promise<void> =>
  renameRetry(from, to, { attempts: 6 })

/**
 * Moves what `from` (a real folder) holds into `to`. When `to` is missing and both are on one volume, the folder is
 * renamed whole (its links move with it, as links). Else entry by entry: names missing in `to` are moved (a folder is
 * renamed whole on one volume, else walked), folders present in both are merged (a real folder into a link's target
 * too: saves RPCS3 wrote to a real savedata folder join the saves the link points at), and a file already in `to`
 * wins. Links met in the walk (the savedata and trophy junctions) are never copied: they are removed (never what they
 * point at), since each configure makes its own at `to`. Renames ride out short locks; an entry that still cannot be
 * moved is logged and the rest still moves.
 *
 * Afterwards `from` is never deleted wholesale: only its empty folders are removed (a file written into it meanwhile,
 * by a download say, is never lost). What is left is either only `from`'s copies of files `to` already had (set aside
 * as <from>.playout-old) or something not moved yet (left in `from` for the next run; `left` > 0). A junction or a
 * missing `from` is left alone. `label` starts the log lines ("RPCS3", "PS3 HDD").
 */
export async function mergeFolderInto(
  from: string,
  to: string,
  log: Logger,
  label: string
): Promise<MergeResult> {
  const st = await lstatOrNull(from)
  if (!st?.isDirectory() || st.isSymbolicLink()) return { conflicts: 0, left: 0 }
  if (!(await exists(to))) {
    await fs.mkdir(dirname(to), { recursive: true })
    try {
      await renameBriefly(from, to)
      log.info(`${label}: moved ${from} to ${to}`)
      return { conflicts: 0, left: 0 }
    } catch (err) {
      // Another volume (a roms junction to another drive), or something in it held open: entry by entry below.
      log.info(`${label}: ${from} is moved entry by entry (${(err as Error).message})`)
      await fs.mkdir(to, { recursive: true })
    }
  }
  let conflicts = 0
  let failed = 0
  const merge = async (src: string, dest: string): Promise<void> => {
    let names: string[]
    try {
      names = await fs.readdir(src)
    } catch (err) {
      log.warn(`${label}: ${src} could not be read (${(err as Error).message}); it is kept`)
      failed++
      return
    }
    for (const name of names) {
      const s = join(src, name)
      const d = join(dest, name)
      try {
        const sst = await fs.lstat(s)
        if (sst.isSymbolicLink()) {
          await removeLink(s)
          continue
        }
        // Followed: a link at `d` stands for the folder it points at.
        const there = await fs.stat(d).catch(() => null)
        if (!there && !(await lstatOrNull(d))) {
          await fs.mkdir(dest, { recursive: true })
          if (sst.isDirectory()) {
            try {
              await renameBriefly(s, d)
            } catch {
              // Another volume, or a file in it held open: walked, so only what is really stuck stays (and the links
              // inside are dropped, never copied).
              await fs.mkdir(d, { recursive: true })
              await merge(s, d)
            }
          } else await moveEntry(s, d)
        } else if (sst.isDirectory() && there?.isDirectory()) await merge(s, d)
        else conflicts++
      } catch (err) {
        log.warn(`${label}: ${s} could not be moved (${(err as Error).message}); it is kept`)
        failed++
      }
    }
  }
  await merge(from, to)
  await removeEmptyFolders(from)
  if (!(await exists(from))) {
    log.info(`${label}: moved ${from} into ${to}`)
    return { conflicts, left: 0 }
  }
  if (failed === 0 && conflicts > 0) {
    // Files `to` already had are left (its copies win): set aside.
    const old = await freeOldName(from)
    try {
      await renameBriefly(from, old)
      log.warn(
        `${label}: moved ${from} into ${to}; ${conflicts} file(s) already there were kept in ${old}`
      )
      return { conflicts, left: 0 }
    } catch (err) {
      log.warn(`${label}: ${from} could not be set aside (${(err as Error).message})`)
      return { conflicts, left: 1 }
    }
  }
  // Something could not be moved, or was written into `from` while this ran: left there for the next run.
  log.warn(
    `${label}: moved ${from} into ${to} but for what is still in it, left there for the next try`
  )
  return { conflicts, left: Math.max(failed, 1) }
}

/** Removes the empty folders under `dir` (and `dir` itself when it ends up empty); files and links are kept. */
async function removeEmptyFolders(dir: string): Promise<void> {
  const st = await lstatOrNull(dir).catch(() => null)
  if (!st?.isDirectory() || st.isSymbolicLink()) return
  for (const name of await fs.readdir(dir).catch(() => [] as string[]))
    await removeEmptyFolders(join(dir, name))
  // rmdir only removes an empty folder: anything still in it keeps it.
  await fs.rmdir(dir).catch(() => undefined)
}

/** A free name `<base>.playout-old`, `<base>.playout-old-2`, ... */
async function freeOldName(base: string): Promise<string> {
  let name = `${base}.playout-old`
  for (let n = 2; await exists(name); n++) name = `${base}.playout-old-${n}`
  return name
}

/** File-system calls link() makes that can fail on a host that cannot hold junctions; tests replace them. */
export interface JunctionFs {
  symlink: (target: string, path: string, type: 'junction') => Promise<void>
  stat: (path: string) => Promise<Stats>
  realpath: (path: string) => Promise<string>
}

const realFs: JunctionFs = {
  symlink: (target, path, type) => fs.symlink(target, path, type),
  stat: (path) => fs.stat(path),
  realpath: (path) => fs.realpath(path)
}

/** Removes a stale probe left by an interrupted run: only a junction or an empty folder, never anything with data. */
async function clearProbe(probe: string): Promise<void> {
  const st = await lstatOrNull(probe)
  if (!st) return
  if (st.isSymbolicLink()) return removeLink(probe)
  if (st.isDirectory() && (await fs.readdir(probe)).length === 0) return fs.rmdir(probe)
  throw new Error(tMain('mainEmulatorSetup.junction.inTheWay', { path: probe }))
}

/**
 * Creates the junction at the temporary sibling `probe` and confirms it resolves to `target`. Throws (with the probe
 * removed) when the volume cannot hold junctions: a UNC data folder, an exFAT/FAT32 drive, an unreachable mapped drive.
 */
async function probeJunction(
  probe: string,
  linkPath: string,
  target: string,
  jfs: JunctionFs
): Promise<void> {
  try {
    await clearProbe(probe)
    await jfs.symlink(resolve(target), probe, 'junction')
    await jfs.stat(probe)
    const [got, want] = await Promise.all([jfs.realpath(probe), jfs.realpath(target)])
    if (!samePath(got, want)) throw new Error(`it resolves to ${got}`)
  } catch (err) {
    if (await isJunction(probe)) await removeLink(probe).catch(() => undefined)
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      tMain('mainEmulatorSetup.junction.failed', { link: linkPath, target, reason }),
      { cause: err }
    )
  }
}

/**
 * Makes `linkPath` a directory junction to `target`:
 * - creates `target` and the parent folders of `linkPath`;
 * - an existing junction is kept when it already points at `target`, otherwise only the link is removed and remade;
 * - the new junction is first made at `<linkPath>.playout-new` and checked to resolve to `target`; when that fails
 *   (UNC or non-NTFS data folder, unreachable drive) nothing at `linkPath` is touched and a clear error is thrown;
 * - a real folder at `linkPath` then has its entries moved into `target` (names already in `target` are not
 *   overwritten); leftovers are kept in `<linkPath>.playout-old` and logged, and the emptied folder is removed;
 * - the checked junction is renamed into place;
 * - a file at `linkPath` is an error.
 *
 * `jfs` replaces the junction calls in tests.
 */
export async function link(
  linkPath: string,
  target: string,
  log: Logger,
  jfs: JunctionFs = realFs
): Promise<void> {
  await fs.mkdir(target, { recursive: true })
  await fs.mkdir(dirname(linkPath), { recursive: true })

  const st = await lstatOrNull(linkPath)
  if (st?.isSymbolicLink()) {
    const current = await fs.readlink(linkPath).catch(() => null)
    if (current !== null && samePath(current, target)) return
  } else if (st?.isDirectory()) {
    if (samePath(linkPath, target))
      throw new Error(tMain('mainEmulatorSetup.junction.self', { link: linkPath }))
  } else if (st) {
    throw new Error(tMain('mainEmulatorSetup.junction.fileInTheWay', { link: linkPath }))
  }

  // Nothing at linkPath changes until a junction to target is known to work on this volume.
  const probe = `${linkPath}.playout-new`
  await probeJunction(probe, linkPath, target, jfs)

  if (st?.isSymbolicLink()) {
    const current = await fs.readlink(linkPath).catch(() => null)
    log.info(`Re-pointing ${linkPath} from ${current ?? '?'} to ${target}`)
    await removeLink(linkPath)
  } else if (st?.isDirectory()) {
    const leftovers: string[] = []
    for (const name of await fs.readdir(linkPath)) {
      const dest = join(target, name)
      if (await exists(dest)) {
        leftovers.push(name)
        continue
      }
      await moveEntry(join(linkPath, name), dest)
    }
    if (leftovers.length > 0) {
      const old = await freeOldName(linkPath)
      await fs.rename(linkPath, old)
      log.warn(
        `Kept ${leftovers.length} item(s) from ${linkPath} that already exist in ${target} in ${old}: ${leftovers.join(', ')}`
      )
    } else {
      await fs.rmdir(linkPath)
    }
  }

  // Renaming a junction moves the link itself; if that is refused, make the link in place instead.
  try {
    await fs.rename(probe, linkPath)
  } catch {
    await removeLink(probe)
    await jfs.symlink(resolve(target), linkPath, 'junction')
  }
}
