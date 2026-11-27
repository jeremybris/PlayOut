import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs, type Stats } from 'fs'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { renameRetry } from '../util/fs'
import { comparable, isSameOrInside, realPathOf } from './emulation-location'

/**
 * Moving the Emulation folder to another place (Settings › Library). On one drive the folder is renamed (instant);
 * on another it is copied to `<new place>.playout-new` (file times kept, so the two-way Emulation sync, newer wins,
 * does not take every file for a change), checked file by file, renamed into place, and only then is the setting
 * switched and the old folder deleted. Into a folder that already holds files ('merge') every file is copied: one
 * missing there is added, an older one there is replaced (kept beside it as *.playout-old), a newer one (or one as
 * new) is kept and the old copy stays in the old folder. A failure or Cancel before the switch puts everything back:
 * the old folder and the setting are as they were.
 *
 * Junctions and links are never followed: each is made again at the new place, a link into the folder itself pointing
 * at the same place in the new folder (RPCS3's savedata and trophy links), any other at its old target.
 *
 * Nothing written to the old folder during a copy is lost: every file's size and time are noted when it is copied;
 * before the switch, files that changed since (or appeared) are copied again; after it, an old file is deleted only
 * while it is still exactly as it was copied (a file up to 64 MB, or one written right before or during the move,
 * whose time a write may not change, only when its bytes are those of the copy; it is renamed aside for that last
 * check, so a write by its name lands in a new file), and one that changed stays in the old folder (leftInOld).
 * A folder of the old place that is (through a junction) the new place itself, or inside it, is never copied.
 */

export type MovePhase = 'moving' | 'copying' | 'verifying' | 'switching' | 'cleaning'

export interface MoveProgressTick {
  phase: MovePhase
  bytesDone: number
  filesDone: number
  current?: string
}

export interface MoveJournal {
  /** Records how far the move got (startup recovery: recoverEmulationMove). */
  write(phase: JournalPhase, copy?: CopyTotals): Promise<void>
  /**
   * A merge is about to rename the new place's file `path` to `backup` (then put the old folder's copy at `path`):
   * recorded first, so a PlayOut closed before the switch gets the file back under its name.
   */
  replacing?(path: string, backup: string): Promise<void>
}

/** renamed: a move on one drive, recorded right before the rename (the whole folder may stand at the new place while
 * the setting still names the old one); copying: the copy is under way in the staging folder; copied: it stands
 * complete at the new place, setting not switched yet; rolling-back: the switch failed, the copy at the new place is
 * being removed (the old folder is whole); cleaning: the setting is switched, the old folder is being removed;
 * merging: a merge before its switch. */
export type JournalPhase =
  'renamed' | 'copying' | 'copied' | 'rolling-back' | 'cleaning' | 'merging'

/** What the complete copy at the new place holds (journal 'copied': recovery checks it is still whole). */
export interface CopyTotals {
  files: number
  bytes: number
}

export interface MoveFolderOptions {
  mode: 'move' | 'merge'
  signal?: AbortSignal
  onProgress?: (tick: MoveProgressTick) => void
  /**
   * Switches the setting once the files stand complete at the new place (checking first that nothing is busy). A
   * failure puts everything back; it must leave the setting as it was.
   */
  commit: () => Promise<void>
  journal?: MoveJournal
  /** fs.rename with retries (tests inject an EXDEV to act out another drive). */
  rename?: (from: string, to: string) => Promise<void>
  warn?: (message: string) => void
  /**
   * When the move began (Date.now()). A file last written later than FRESH_MS before it may be written again within
   * the same file-time step (NTFS times come from a coarse clock, FAT has a 2 s step): its size and time cannot tell
   * whether it changed after it was copied, so its bytes are compared before the old copy is deleted.
   */
  since?: number
  /**
   * A move on one drive: a link inside the folder that cannot be pointed at the new place (a file link needs Developer
   * Mode or administrator rights) is only warned about and left as it is, instead of putting the folder back. The
   * default (false) puts it back. Pointing the links back after a failed switch is always strict.
   */
  lenientRelink?: boolean
}

export interface MoveOutcome {
  /** One rename moved the whole folder. */
  renamed: boolean
  /** Files left in the old folder (a merge kept a newer copy at the new place, or they could not be removed). */
  leftInOld: number
  /** Older files of the new place replaced by a merge, kept beside them as *.playout-old. */
  keptOlder: number
  /** The setting switched, but removing the old folder did not finish (an error): the journal stays 'cleaning'. */
  cleanupUnfinished?: boolean
}

/**
 * A move on one drive whose switch failed and whose folder could not be renamed back: every file stands at `dir`
 * (the new place) while the setting still names the old one. The service switches the setting to `dir`.
 */
/**
 * A failure before the switch whose undo did not finish (a file of the new place could not be put back under its name,
 * a link not pointed back): the setting is as it was, but the journal must stay so the next start finishes the undo.
 */
export class RollbackUnfinished extends Error {
  constructor(readonly original: unknown) {
    super((original as Error)?.message ?? String(original))
    this.name = 'RollbackUnfinished'
  }
}

export class StrandedMove extends Error {
  constructor(
    readonly dir: string,
    readonly original: unknown,
    readonly putBack: unknown
  ) {
    super((original as Error)?.message ?? String(original))
    this.name = 'StrandedMove'
  }
}

/** The staging folder of a copy to another drive. */
export function stagingDir(to: string): string {
  return `${to}.playout-new`
}

/** Files above this size are copied as a stream, reporting their bytes as they go. */
const STREAM_ABOVE = 32 * 1024 * 1024
/** File times on FAT and exFAT drives have a 2 s step: closer than this counts as the same time. */
const SAME_TIME_MS = 2000
/** A file written closer than this before the move began is "fresh" (see MoveFolderOptions.since). */
export const FRESH_MS = 10_000

/**
 * Files up to this size (saves, memory cards, BIOS files, small ROMs) are always byte-compared with their copy before
 * the old one is deleted: an app may also write one and set its time back (a sync or cloud client keeping the file
 * times). Larger ones (disc images) only when fresh: reading every one again would cost as long as the copy.
 */
const COMPARE_UP_TO = 64 * 1024 * 1024

/**
 * True when a file's size and time cannot prove it unchanged since a copy made after `since` (written later than
 * FRESH_MS before it, or `since` unknown), or it is small enough to be compared anyway: its bytes then decide.
 */
function mustCompareBytes(st: Stats, since: number | undefined): boolean {
  return since === undefined || st.size <= COMPARE_UP_TO || st.mtimeMs >= since - FRESH_MS
}

/** Longest file name NTFS allows. */
const MAX_NAME = 255

/**
 * `<path><suffix>`, a temporary or backup name beside `path`; a name that would grow past 255 characters is cut and
 * marked with a short hash of the full name (~xxxxxxxx), so a long name never makes a move impossible.
 */
export function besideName(path: string, suffix: string): string {
  const name = basename(path)
  if (name.length + suffix.length <= MAX_NAME) return `${path}${suffix}`
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
  return join(dirname(path), `${name.slice(0, MAX_NAME - suffix.length - 9)}~${hash}${suffix}`)
}
/** A base name besideName cut (it ends in ~ and 8 hex digits): it cannot be mapped back to the full name. */
export const CUT_NAME = /~[0-9a-f]{8}$/i

/**
 * Puts `from` at `path` over what stands there. Windows refuses to rename over a read-only file (a copy keeps the
 * read-only mark of a read-only save), so `path`, which is about to be replaced, is made writable first.
 */
export async function renameOver(
  from: string,
  path: string,
  rename: (from: string, to: string) => Promise<void> = renameRetry
): Promise<void> {
  await fs.chmod(path, 0o666).catch(() => undefined)
  await rename(from, path)
}

export class MoveCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'AbortError'
  }
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MoveCancelled()
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Removes a junction or symlink itself, never what it points at. */
export async function removeLink(path: string): Promise<void> {
  try {
    await fs.unlink(path)
  } catch {
    await fs.rmdir(path)
  }
}

/** Bytes and files under `dir` (links not followed, not counted). */
export async function measureTree(
  dir: string,
  signal?: AbortSignal
): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const visit = async (path: string): Promise<void> => {
    checkAbort(signal)
    const st = await lstatOrNull(path)
    if (!st || st.isSymbolicLink()) return
    if (st.isDirectory()) {
      for (const name of await fs.readdir(path).catch(() => [] as string[]))
        await visit(join(path, name))
    } else if (st.isFile()) {
      bytes += st.size
      files++
    }
  }
  await visit(dir)
  return { bytes, files }
}

/**
 * Deletes a tree: links first, as links (nothing is ever deleted through one), then files and folders. Returns the
 * number of files that could not be removed (in use); their folders stay.
 */
export async function removeTree(path: string): Promise<number> {
  const st = await lstatOrNull(path)
  if (!st) return 0
  if (st.isSymbolicLink()) {
    await removeLink(path).catch(() => undefined)
    return 0
  }
  if (!st.isDirectory()) {
    try {
      await fs.rm(path, { force: true, maxRetries: 5, retryDelay: 200 })
      return 0
    } catch {
      return 1
    }
  }
  let left = 0
  for (const name of await fs.readdir(path).catch(() => [] as string[]))
    left += await removeTree(join(path, name))
  await fs.rmdir(path).catch(() => undefined)
  return left
}

/** Removes the empty folders under `dir` (and `dir` when it ends up empty). Links are left alone. */
async function removeEmptyFolders(dir: string): Promise<void> {
  const st = await lstatOrNull(dir)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return
  for (const name of await fs.readdir(dir).catch(() => [] as string[]))
    await removeEmptyFolders(join(dir, name))
  await fs.rmdir(dir).catch(() => undefined)
}

/** `path` moved from under `from` to under `to`. */
function rebase(path: string, from: string, to: string): string {
  const rel = relative(resolve(from), resolve(path))
  return rel ? join(resolve(to), rel) : resolve(to)
}

/** Where a link points (absolute, without the \\?\ prefix). */
async function linkTarget(link: string): Promise<string> {
  const raw = (await fs.readlink(link)).replace(/^\\\\\?\\|^\\\?\?\\/, '')
  return isAbsolute(raw) ? raw : resolve(dirname(link), raw)
}

/** Where a link like `src` points at the new place (into the folder being moved: the same place under `to`). */
async function newLinkTarget(src: string, from: string, to: string): Promise<string> {
  const target = await linkTarget(src)
  return isSameOrInside(from, target) ? rebase(target, from, to) : target
}

/**
 * The kind of link to make for what `via` reaches: a file gets a file link, a folder (or a target that is gone) a
 * junction, which needs no administrator rights. Any other error is thrown: a junction to a file cannot be read, so
 * the kind is never guessed.
 */
async function linkKind(via: string): Promise<'file' | 'junction'> {
  try {
    return (await fs.stat(via)).isFile() ? 'file' : 'junction'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'junction'
    throw err
  }
}

/** Makes at `dst` a link like `src` (of its kind), pointing at `next` (newLinkTarget). */
async function makeLinkLike(src: string, dst: string, next: string): Promise<void> {
  await fs.symlink(next, dst, await linkKind(src))
}

/** relinkTree's temporary names: the new link is made as <name>.playout-link, the old one renamed to this. */
const LINK_ASIDE = '.playout-link-old'
const STRAY_LINK = /^(.+?)\.playout-link(?:-old)?$/i
const okay = (): boolean => true
const notOkay = (): boolean => false

/**
 * After a rename: the links inside the moved folder that still point into its old place are pointed at the same
 * place in the new one. Never follows a link. Each link keeps its kind (a link to a file stays a file link, a folder
 * gets a junction), and is replaced only once its new one stands. `strict`: a link that could not be read or replaced
 * fails the walk after every other link was done (a move then puts the folder back); else it is only warned about.
 */
export async function relinkTree(
  root: string,
  from: string,
  to: string,
  warn?: (message: string) => void,
  strict = false
): Promise<number> {
  let fixed = 0
  let failed = 0
  const fail = (message: string): void => {
    failed++
    warn?.(message)
  }
  const relink = async (path: string): Promise<void> => {
    let target: string
    try {
      target = await linkTarget(path)
    } catch (err) {
      fail(`link ${path} could not be read: ${(err as Error).message}`)
      return
    }
    if (!isSameOrInside(from, target)) return
    const next = rebase(target, from, to)
    // A junction to a file cannot be read: a file target gets a file link, a folder (or one that is gone) a junction.
    // Made beside it first: the old link goes only once its replacement stands, so a failure never loses it.
    const fresh = besideName(path, '.playout-link')
    let type: 'file' | 'junction'
    try {
      type = await linkKind(next)
      await removeLink(fresh).catch(() => undefined)
      await fs.symlink(next, fresh, type)
    } catch (err) {
      fail(`link ${path} could not be pointed at the new folder: ${(err as Error).message}`)
      return
    }
    // The old link is renamed aside, never removed first: at every moment the link stands under its own name or
    // under one of the two temporary names, which a later walk (startup recovery) puts back (repairStrays).
    const aside = besideName(path, LINK_ASIDE)
    try {
      await removeLink(aside).catch(() => undefined)
      await fs.rename(path, aside)
    } catch (err) {
      await removeLink(fresh).catch(() => undefined)
      fail(`link ${path} could not be replaced: ${(err as Error).message}`)
      return
    }
    try {
      await fs.rename(fresh, path)
    } catch (err) {
      // The old link comes back under its name; failing that, the new one is made there. Failing both, the two stay
      // under their temporary names for the next walk.
      if (await fs.rename(aside, path).then(okay, notOkay)) {
        await removeLink(fresh).catch(() => undefined)
      } else if (await fs.symlink(next, path, type).then(okay, notOkay)) {
        await removeLink(fresh).catch(() => undefined)
        await removeLink(aside).catch(() => undefined)
        fixed++
        return
      }
      fail(`link ${path} could not be replaced: ${(err as Error).message}`)
      return
    }
    // The old link (now only a leftover) goes; one try more after a short lock.
    if (!(await removeLink(aside).then(okay, notOkay))) {
      await new Promise((r) => setTimeout(r, 200))
      await removeLink(aside).catch((err: unknown) =>
        warn?.(`leftover link ${aside} could not be removed: ${(err as Error).message}`)
      )
    }
    fixed++
  }
  /**
   * Links a walk cut short left under a temporary name: one whose own name is free goes back to it (the old link or its
   * replacement, both are whole links; the walk then points it where it belongs), any other is a leftover and goes.
   */
  const repairStrays = async (dir: string, names: string[]): Promise<void> => {
    for (const name of names) {
      const m = STRAY_LINK.exec(name)
      // A cut name (besideName) cannot be mapped back to its link's name: left as it is.
      if (!m || CUT_NAME.test(m[1])) continue
      const path = join(dir, name)
      try {
        if (!(await lstatOrNull(path))?.isSymbolicLink()) continue
        const base = join(dir, m[1])
        if (await lstatOrNull(base)) await removeLink(path)
        else await fs.rename(path, base)
      } catch (err) {
        fail(`link ${path} could not be put back: ${(err as Error).message}`)
      }
    }
  }
  const visit = async (path: string): Promise<void> => {
    // An entry or folder that cannot be read counts as a failure (strict: the walk fails once every other link was
    // done; a move then puts the folder back or keeps its journal), and never stops the rest of the walk.
    let st: Stats | null
    try {
      st = await lstatOrNull(path)
    } catch (err) {
      fail(`${path} could not be read: ${(err as Error).message}`)
      return
    }
    if (!st) return
    // A link that could not be put back under its name is left as it is (never pointed elsewhere under a temporary one).
    if (st.isSymbolicLink()) return STRAY_LINK.test(basename(path)) ? undefined : relink(path)
    if (st.isDirectory()) {
      let names: string[]
      try {
        names = await fs.readdir(path)
      } catch (err) {
        fail(`folder ${path} could not be read: ${(err as Error).message}`)
        return
      }
      if (names.some((name) => STRAY_LINK.test(name))) {
        await repairStrays(path, names)
        // Read again: links may be back under their own names.
        names = await fs.readdir(path).catch(() => names)
      }
      for (const name of names) await visit(join(path, name))
    }
  }
  await visit(root)
  if (strict && failed) throw new Error(`${failed} links could not be pointed at ${to}`)
  return fixed
}

interface CopyState {
  bytesDone: number
  filesDone: number
}

/** A source file as it was when copied (size and modified time): deleted later only while it is still so. */
type CopyManifest = Map<string, { size: number; mtimeMs: number }>

function manifestKey(path: string): string {
  return resolve(path).toLowerCase()
}

function noteCopied(manifest: CopyManifest | undefined, src: string, st: Stats): void {
  manifest?.set(manifestKey(src), { size: st.size, mtimeMs: st.mtimeMs })
}

function unchangedSince(manifest: CopyManifest, src: string, st: Stats): boolean {
  const was = manifest.get(manifestKey(src))
  return !!was && was.size === st.size && was.mtimeMs === st.mtimeMs
}

/** True when the folder `src` really is (through a junction or link on its way) one of `targets` or inside one. */
async function reachesTarget(src: string, targets: string[]): Promise<boolean> {
  const real = await fs.realpath(src).catch(() => resolve(src))
  return targets.some((t) => isSameOrInside(t, real) || isSameOrInside(t, src))
}

/** The real paths a copy writes to (the new place, and its staging folder), for reachesTarget. */
async function targetsOf(...paths: string[]): Promise<string[]> {
  return Promise.all(paths.map((p) => realPathOf(p)))
}

/** Copies one file with its times; checks the copy's size. */
async function copyFileKeepingTimes(
  src: string,
  dst: string,
  st: Stats,
  state: CopyState,
  options: MoveFolderOptions,
  current: string,
  manifest?: CopyManifest
): Promise<void> {
  checkAbort(options.signal)
  if (st.size > STREAM_ABOVE) {
    const tick = (): void =>
      options.onProgress?.({
        phase: 'copying',
        bytesDone: state.bytesDone,
        filesDone: state.filesDone,
        current
      })
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        state.bytesDone += chunk.length
        tick()
        done(null, chunk)
      }
    })
    await pipeline(
      createReadStream(src),
      counter,
      createWriteStream(dst),
      options.signal ? { signal: options.signal } : {}
    ).catch((err: unknown) => {
      if (options.signal?.aborted) throw new MoveCancelled()
      throw err
    })
  } else {
    await fs.copyFile(src, dst)
    state.bytesDone += st.size
  }
  await fs.utimes(dst, st.atime, st.mtime)
  const out = await fs.stat(dst)
  if (out.size !== st.size)
    throw new Error(`the copy of ${src} is incomplete (${out.size} of ${st.size} bytes)`)
  noteCopied(manifest, src, st)
  state.filesDone++
  options.onProgress?.({
    phase: 'copying',
    bytesDone: state.bytesDone,
    filesDone: state.filesDone,
    current
  })
}

/**
 * Copies `from` into the folder `dst`: files with their times, links made again. `onlyChanged` (a catch-up pass):
 * only files missing from the manifest or changed since they were noted, and links missing at `dst`. Returns the
 * number of files copied.
 */
async function copyTree(
  from: string,
  to: string,
  dst: string,
  options: MoveFolderOptions,
  state: CopyState,
  manifest: CopyManifest,
  targets: string[],
  onlyChanged = false
): Promise<number> {
  let copied = 0
  const visit = async (src: string, out: string): Promise<void> => {
    checkAbort(options.signal)
    const st = await lstatOrNull(src)
    if (!st) return
    if (st.isSymbolicLink()) {
      if (onlyChanged && (await lstatOrNull(out))) return
      // A link that cannot be read fails the copy (nothing is switched): whether it points into the folder, whose
      // files it would then need, is unknown.
      const next = await newLinkTarget(src, from, to)
      try {
        await makeLinkLike(src, out, next)
        // Noted as made again: only such a link is removed from the old folder after the switch.
        manifest.set(manifestKey(src), { size: -1, mtimeMs: -1 })
      } catch (err) {
        // It stays in the old folder, and so does what it points at there (removeCopiedTree).
        options.warn?.(`link ${src} could not be made again: ${(err as Error).message}`)
      }
      return
    }
    if (st.isDirectory()) {
      // The new place itself, reached through a junction inside the old one: never copied into itself.
      if (await reachesTarget(src, targets)) {
        options.warn?.(`${src} is the new place itself (through a junction): not copied`)
        return
      }
      await fs.mkdir(out, { recursive: true })
      for (const name of await fs.readdir(src)) await visit(join(src, name), join(out, name))
      await fs.utimes(out, st.atime, st.mtime).catch(() => undefined)
      return
    }
    if (!st.isFile()) return
    if (onlyChanged) {
      if (unchangedSince(manifest, src, st)) return
      const there = await lstatOrNull(out)
      if (there?.isSymbolicLink()) await removeLink(out)
      else if (there) await fs.rm(out, { force: true, maxRetries: 5, retryDelay: 200 })
    }
    await copyFileKeepingTimes(src, out, st, state, options, relative(from, src), manifest)
    copied++
  }
  await visit(from, dst)
  return copied
}

/** Catch-up passes at most: a file still being written to after them is left to the after-switch check. */
const CATCH_UP_PASSES = 3

/**
 * Deletes the old folder after a copy: a link (as a link) only while `isCopied` says it was made again at the new
 * place; a file only while `isCopied` says it is still as it was copied, any other (written meanwhile) stays, and so do
 * its folders. A link that stays and points inside the folder keeps what it points at too (it would dangle). Returns
 * the number of files and links left. Throws (nothing removed) when a link that stays cannot be read.
 */
export async function removeCopiedTree(
  root: string,
  isCopied: (src: string, st: Stats, at?: string) => Promise<boolean>
): Promise<number> {
  /** What links that stay point at inside `root`. */
  const kept: string[] = []
  const scan = async (path: string): Promise<void> => {
    const st = await lstatOrNull(path)
    if (!st) return
    if (st.isSymbolicLink()) {
      if (await isCopied(path, st)) return
      const target = await linkTarget(path)
      if (isSameOrInside(root, target)) kept.push(target)
    } else if (st.isDirectory())
      for (const name of await fs.readdir(path)) await scan(join(path, name))
  }
  await scan(root)
  const visit = async (path: string): Promise<number> => {
    const st = await lstatOrNull(path)
    if (!st) return 0
    if (kept.some((target) => isSameOrInside(target, path)))
      return st.isDirectory() && !st.isSymbolicLink() ? (await measureTree(path)).files || 1 : 1
    if (st.isSymbolicLink()) {
      // A link that could not be made at the new place (a FAT32 drive, no rights) stays here, never lost.
      if (!(await isCopied(path, st))) return 1
      await removeLink(path).catch(() => undefined)
      return 0
    }
    if (st.isDirectory()) {
      let names = await fs.readdir(path).catch(() => [] as string[])
      if (names.some((name) => DELETING_NAME.test(name))) {
        // A removal cut short (PlayOut closed): the file goes back under its name first, then is checked again.
        for (const name of names) {
          const m = DELETING_NAME.exec(name)
          if (m && !CUT_NAME.test(m[1])) await putBack(join(path, name), join(path, m[1]))
        }
        names = await fs.readdir(path).catch(() => names)
      }
      let left = 0
      for (const name of names) left += await visit(join(path, name))
      await fs.rmdir(path).catch(() => undefined)
      return left
    }
    if (!st.isFile() || DELETING_NAME.test(basename(path)) || !(await isCopied(path, st))) return 1
    return (await removedForGood(path, (at, now) => isCopied(path, now, at))) ? 0 : 1
  }
  return visit(root)
}

/** removeIfUnchanged's temporary name. */
const DELETING = '.playout-del'
const DELETING_NAME = /^(.+)\.playout-del$/i

/**
 * `aside` back under its name `path`, never over a file made there meanwhile (it then stays under its own name). A
 * hard link and an unlink, which fail when the name is taken; a drive without hard links (FAT): a rename while the
 * name is free.
 */
async function putBack(aside: string, path: string): Promise<void> {
  try {
    await fs.link(aside, path)
    await fs.unlink(aside).catch(() => undefined)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
  }
  if (!(await lstatOrNull(path).catch(() => true)))
    await fs.rename(aside, path).catch(() => undefined)
}

/**
 * Deletes the old file `path` only while `check(at, st)` (reading it at `at`) holds: it is renamed aside first, so an
 * app that writes to it by its name after the check makes a new file, never writes into the one deleted (a file open
 * in an app cannot be renamed, and stays). One that no longer passes goes back under its name. True when deleted.
 */
async function removeIfUnchanged(
  path: string,
  check: (at: string, st: Stats) => Promise<boolean>
): Promise<boolean> {
  const aside = besideName(path, DELETING)
  if (await lstatOrNull(aside).catch(() => true)) return false
  try {
    await fs.rename(path, aside)
  } catch {
    return false
  }
  try {
    const st = await lstatOrNull(aside)
    if (st?.isFile() && (await check(aside, st))) {
      await fs.rm(aside, { force: true, maxRetries: 5, retryDelay: 200 })
      return true
    }
  } catch {
    // put back below
  }
  await putBack(aside, path)
  return false
}

/** removeIfUnchanged, false also when an app made the file again under its name meanwhile (it is left). */
async function removedForGood(
  path: string,
  check: (at: string, st: Stats) => Promise<boolean>
): Promise<boolean> {
  return (await removeIfUnchanged(path, check)) && !(await lstatOrNull(path).catch(() => true))
}

/**
 * Startup recovery (no manifest): an old file counts as copied when the new place has a clearly newer one (written
 * there since), or one with the same size and the same modified time (the copy keeps file times) while that time is
 * older than FRESH_MS before the move began (`since`, from the journal; unknown: never). Any other (within FAT's 2 s
 * step, the old file newer, or written right before or during the move, when a write may keep the time) counts only
 * when the bytes are the same: a save written again is not the copy.
 */
export function copiedTo(
  from: string,
  to: string,
  since?: number
): (src: string, st: Stats, at?: string) => Promise<boolean> {
  return async (src, st, at = src) => {
    const dst = rebase(src, from, to)
    const there = await lstatOrNull(dst)
    if (st.isSymbolicLink()) return !!there?.isSymbolicLink()
    if (!there || !there.isFile() || there.isSymbolicLink() || there.size !== st.size) return false
    if (there.mtimeMs - st.mtimeMs > SAME_TIME_MS) return true
    if (there.mtimeMs === st.mtimeMs && !mustCompareBytes(st, since)) return true
    return sameContent(at, dst).catch(() => false)
  }
}

/** A free "<path>.playout-old" name (then -2, -3…). */
async function freeOldName(path: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = besideName(path, i === 1 ? '.playout-old' : `.playout-old-${i}`)
    if (!(await lstatOrNull(name))) return name
  }
}

/** Moves the Emulation folder `from` to `to`; see the module comment. */
export async function moveEmulationFolder(
  from: string,
  to: string,
  options: MoveFolderOptions
): Promise<MoveOutcome> {
  // Never a folder that is itself a link: only the link would move, the files would stay where it points.
  if ((await lstatOrNull(from))?.isSymbolicLink())
    throw new Error(`${from} is a link, not the folder itself`)
  const withSince = { ...options, since: options.since ?? Date.now() }
  return options.mode === 'merge' ? mergeInto(from, to, withSince) : moveWhole(from, to, withSince)
}

async function moveWhole(
  from: string,
  to: string,
  options: MoveFolderOptions
): Promise<MoveOutcome> {
  const rename = options.rename ?? renameRetry
  const existing = await lstatOrNull(to)
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`${to} is in the way`)
    if ((await fs.readdir(to)).length) throw new Error(`${to} is not empty`)
    await fs.rmdir(to)
  }
  await fs.mkdir(dirname(to), { recursive: true })
  checkAbort(options.signal)
  options.onProgress?.({ phase: 'moving', bytesDone: 0, filesDone: 0 })

  // Recorded before the rename: a PlayOut closed while the whole folder stands at the new place (setting not switched
  // yet) finds it at the next start. Another drive overwrites this with 'copying'.
  await options.journal?.write('renamed')
  let renamed = false
  try {
    await rename(from, to)
    renamed = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
      if (existing) await fs.mkdir(to).catch(() => undefined)
      throw err
    }
  }

  if (renamed) {
    try {
      await relinkTree(to, from, to, options.warn, !options.lenientRelink)
      options.onProgress?.({ phase: 'switching', bytesDone: 0, filesDone: 0 })
      await options.commit()
    } catch (err) {
      // Put the folder back where it was, links included. When that fails too (something made the old folder again,
      // a handle open in the new one), every file stands at `to`: the caller switches the setting there.
      try {
        await rename(to, from)
      } catch (putBack) {
        throw new StrandedMove(to, err, putBack)
      }
      // A link not pointed back would point into the new place, which is gone: the journal ('renamed') then stays,
      // and the next start points it back.
      const linksBack = await relinkTree(from, to, from, options.warn, true).then(
        okay,
        (e: unknown) => {
          options.warn?.(`links in ${from} could not be pointed back: ${(e as Error).message}`)
          return false
        }
      )
      throw linksBack ? err : new RollbackUnfinished(err)
    }
    return { renamed: true, leftInOld: 0, keptOlder: 0 }
  }

  // Another drive: copy, check, put in place, switch, then remove the old folder.
  const stage = stagingDir(to)
  await removeTree(stage)
  await options.journal?.write('copying')
  const state: CopyState = { bytesDone: 0, filesDone: 0 }
  const manifest: CopyManifest = new Map()
  const targets = await targetsOf(to, stage)
  let totals: CopyTotals
  try {
    await copyTree(from, to, stage, options, state, manifest, targets)
    options.onProgress?.({ phase: 'verifying', ...state })
    // Files written to the old folder while the copy ran (a save, a download) are copied again.
    for (let pass = 0; pass < CATCH_UP_PASSES; pass++)
      if (!(await copyTree(from, to, stage, options, state, manifest, targets, true))) break
    const source = await measureTree(from)
    totals = await measureTree(stage)
    if (source.files !== totals.files || source.bytes !== totals.bytes)
      throw new Error(
        `the copy does not match the folder (${totals.files} of ${source.files} files, ${totals.bytes} of ${source.bytes} bytes)`
      )
    checkAbort(options.signal)
    await rename(stage, to)
  } catch (err) {
    await removeTree(stage)
    throw err
  }
  try {
    await options.journal?.write('copied', totals)
    options.onProgress?.({ phase: 'switching', ...state })
    await options.commit()
  } catch (err) {
    // Recorded first: a PlayOut closed during this removal keeps the old folder, never the half-removed copy. (A
    // journal that cannot be written does not stop the removal: the old folder is whole and still in use.)
    await options.journal
      ?.write('rolling-back')
      .catch((journalErr: unknown) =>
        options.warn?.(`move journal not written: ${(journalErr as Error).message}`)
      )
    await removeTree(to)
    throw err
  }
  // The setting is switched: from here on nothing fails the move (the old folder is only being emptied).
  return {
    renamed: false,
    keptOlder: 0,
    ...(await cleanAfterSwitch(from, options, state, async (src, st, at = src) => {
      if (st.isSymbolicLink()) return manifest.has(manifestKey(src))
      if (!unchangedSince(manifest, src, st)) return false
      // Written right before or during the move, a file may have changed without its time: only the same bytes.
      return (
        !mustCompareBytes(st, options.since) ||
        (await sameContent(at, rebase(src, from, to)).catch(() => false))
      )
    }))
  }
}

/**
 * After the switch, the old folder emptied of what the new place holds (only what is still as it was copied goes; a
 * file written meanwhile stays). Never throws: an error leaves the rest in the old folder and is reported as
 * `cleanupUnfinished` (the journal stays 'cleaning' for the next start).
 */
async function cleanAfterSwitch(
  from: string,
  options: MoveFolderOptions,
  state: CopyState,
  isCopied: (src: string, st: Stats, at?: string) => Promise<boolean>
): Promise<{ leftInOld: number; cleanupUnfinished?: boolean }> {
  try {
    await options.journal?.write('cleaning')
  } catch (err) {
    options.warn?.(`move journal not written: ${(err as Error).message}`)
  }
  options.onProgress?.({ phase: 'cleaning', ...state })
  try {
    const leftInOld = await removeCopiedTree(from, isCopied)
    return { leftInOld }
  } catch (err) {
    options.warn?.(`the old folder ${from} could not be emptied: ${(err as Error).message}`)
    const left = await measureTree(from).catch(() => ({ files: 0 }))
    return { leftInOld: left.files, cleanupUnfinished: true }
  }
}

type Undo =
  | { kind: 'created'; path: string; link?: boolean; dir?: boolean }
  | { kind: 'replaced'; path: string; backup: string }

/** Byte for byte the same (two files of the same size). */
async function sameContent(a: string, b: string): Promise<boolean> {
  // Opened one after the other: a file that cannot be opened never leaves the other one's handle open.
  const ha = await fs.open(a, 'r')
  let hb: Awaited<ReturnType<typeof fs.open>>
  try {
    hb = await fs.open(b, 'r')
  } catch (err) {
    await ha.close()
    throw err
  }
  try {
    const size = 1024 * 1024
    const ba = Buffer.alloc(size)
    const bb = Buffer.alloc(size)
    for (let pos = 0; ; pos += size) {
      const [ra, rb] = await Promise.all([ha.read(ba, 0, size, pos), hb.read(bb, 0, size, pos)])
      if (ra.bytesRead !== rb.bytesRead) return false
      if (ra.bytesRead === 0) return true
      if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false
    }
  } finally {
    await Promise.all([ha.close(), hb.close()]).catch(() => undefined)
  }
}

async function mergeInto(
  from: string,
  to: string,
  options: MoveFolderOptions
): Promise<MoveOutcome> {
  const rename = options.rename ?? renameRetry
  await fs.mkdir(to, { recursive: true })
  await options.journal?.write('merging')
  const undo: Undo[] = []
  /**
   * Source entries whose content now stands at the new place: removed after the switch, a file only while it is
   * still as it was when copied (its size and time noted here).
   */
  const consumed: {
    path: string
    link: boolean
    /** Its copy at the new place (files). */
    dst?: string
    size?: number
    mtimeMs?: number
  }[] = []
  const state: CopyState = { bytesDone: 0, filesDone: 0 }
  const targets = await targetsOf(to)
  let keptOlder = 0
  /** Links that stay in the old folder (the new place has another entry of that name, or the link failed there). */
  let linksKept = 0
  /** What those links point at inside the old folder: it stays too, or they would dangle. */
  const keptTargets: string[] = []

  const visit = async (src: string, dst: string): Promise<void> => {
    checkAbort(options.signal)
    const st = await lstatOrNull(src)
    if (!st) return
    const there = await lstatOrNull(dst)
    if (st.isSymbolicLink()) {
      // A link that cannot be read fails the merge before the switch (everything is put back): whether it points into
      // the old folder, whose files it would then need, is unknown.
      const target = await linkTarget(src)
      const next = isSameOrInside(from, target) ? rebase(target, from, to) : target
      if (!there) {
        try {
          await makeLinkLike(src, dst, next)
          undo.push({ kind: 'created', path: dst, link: true })
          consumed.push({ path: src, link: true })
          return
        } catch (err) {
          options.warn?.(`link ${src} could not be made again: ${(err as Error).message}`)
        }
      } else if (
        // The new place already has this link (the same target): the old one can go. Anything else of that name
        // there is kept, and so is the old link, so what it points at stays reachable.
        there.isSymbolicLink() &&
        comparable(await linkTarget(dst).catch(() => '<none>')) === comparable(next)
      ) {
        consumed.push({ path: src, link: true })
        return
      }
      linksKept++
      if (isSameOrInside(from, target)) keptTargets.push(target)
      return
    }
    if (st.isDirectory()) {
      // The new place itself, reached through a junction inside the old one: never merged into itself.
      if (await reachesTarget(src, targets)) {
        options.warn?.(`${src} is the new place itself (through a junction): not merged`)
        return
      }
      if (!there) {
        await fs.mkdir(dst)
        undo.push({ kind: 'created', path: dst, dir: true })
      } else if (!there.isDirectory() || there.isSymbolicLink()) return
      for (const name of await fs.readdir(src)) await visit(join(src, name), join(dst, name))
      return
    }
    if (!st.isFile()) return
    const current = relative(from, src)
    const tmp = besideName(dst, '.playout-new')
    if (!there) {
      await removeTree(tmp)
      try {
        await copyFileKeepingTimes(src, tmp, st, state, options, current)
        await rename(tmp, dst)
      } catch (err) {
        await removeTree(tmp)
        throw err
      }
      undo.push({ kind: 'created', path: dst })
      consumed.push({ path: src, link: false, dst, size: st.size, mtimeMs: st.mtimeMs })
      return
    }
    if (!there.isFile() || there.isSymbolicLink()) return
    // The same file on both sides only when its bytes are: saves are often of a fixed size, and a different save of
    // the same size written within FAT's 2 s step is not the same file.
    const close = Math.abs(st.mtimeMs - there.mtimeMs) <= SAME_TIME_MS
    // An equal time proves nothing either (FAT's 2 s step, times kept from an archive): the bytes always decide.
    const same = st.size === there.size && close && (await sameContent(src, dst))
    if (same) {
      // Nothing to copy, and the old copy can go.
      state.bytesDone += st.size
      state.filesDone++
      consumed.push({ path: src, link: false, dst, size: st.size, mtimeMs: st.mtimeMs })
      return
    }
    // Different files: the newer wins, the other is kept (within the 2 s step the later time counts).
    const newer = close ? st.mtimeMs > there.mtimeMs : st.mtimeMs - there.mtimeMs > SAME_TIME_MS
    if (!newer) return // the new place's copy is newer: kept, the old one stays in the old folder
    await removeTree(tmp)
    try {
      await copyFileKeepingTimes(src, tmp, st, state, options, current)
    } catch (err) {
      await removeTree(tmp)
      throw err
    }
    let backup: string
    try {
      backup = await freeOldName(dst)
      await options.journal?.replacing?.(dst, backup)
      await rename(dst, backup)
    } catch (err) {
      await removeTree(tmp)
      throw err
    }
    undo.push({ kind: 'replaced', path: dst, backup })
    try {
      await rename(tmp, dst)
    } catch (err) {
      await removeTree(tmp)
      throw err
    }
    keptOlder++
    consumed.push({ path: src, link: false, dst, size: st.size, mtimeMs: st.mtimeMs })
  }

  try {
    await visit(from, to)
    options.onProgress?.({ phase: 'switching', ...state })
    await options.commit()
  } catch (err) {
    // Back as it was: what was added goes, what was replaced comes back.
    let undoFailed = 0
    for (const step of undo.reverse()) {
      try {
        // Renamed straight over the new copy (a rename replaces a file; a read-only copy is made writable first):
        // the target's own file is never left only under its *.playout-old name, even when this rename fails.
        if (step.kind === 'replaced') await renameOver(step.backup, step.path, rename)
        else if (step.link) await removeLink(step.path)
        else if (step.dir) await fs.rmdir(step.path).catch(() => undefined)
        else await fs.rm(step.path, { force: true })
      } catch (undoErr) {
        undoFailed++
        options.warn?.(`could not undo ${step.path}: ${(undoErr as Error).message}`)
      }
    }
    // The journal ('merging', with what was replaced) then stays: the next start puts the rest back.
    throw undoFailed ? new RollbackUnfinished(err) : err
  }

  // The setting is switched: from here on nothing fails the move (the old folder is only being emptied).
  try {
    await options.journal?.write('cleaning')
  } catch (err) {
    options.warn?.(`move journal not written: ${(err as Error).message}`)
  }
  options.onProgress?.({ phase: 'cleaning', ...state })
  let notRemoved = 0
  for (const entry of consumed) {
    try {
      // What a link that stays points at stays too.
      if (keptTargets.some((target) => isSameOrInside(target, entry.path))) {
        if (await lstatOrNull(entry.path)) notRemoved++
        continue
      }
      if (entry.link) await removeLink(entry.path)
      else {
        // Written to since it was copied (a save during the merge): that newer copy stays in the old folder. A file
        // written right before or during the merge may have changed without its time: removed only when its bytes
        // are those of the copy at the new place.
        if (!(await lstatOrNull(entry.path))) continue
        const unchanged = async (at: string, now: Stats): Promise<boolean> =>
          now.size === entry.size &&
          now.mtimeMs === entry.mtimeMs &&
          (!mustCompareBytes(now, options.since) ||
            (!!entry.dst && (await sameContent(at, entry.dst).catch(() => false))))
        if (!(await removedForGood(entry.path, unchanged))) notRemoved++
      }
    } catch {
      notRemoved++
    }
  }
  let left = notRemoved
  let cleanupUnfinished = false
  try {
    await removeEmptyFolders(from)
    if (await lstatOrNull(from)) left = Math.max(left, (await measureTree(from)).files)
  } catch (err) {
    options.warn?.(`the old folder ${from} could not be emptied: ${(err as Error).message}`)
    cleanupUnfinished = true
  }
  return {
    renamed: false,
    leftInOld: left + linksKept,
    keptOlder,
    ...(cleanupUnfinished ? { cleanupUnfinished } : {})
  }
}
