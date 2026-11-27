// "Delete the original disc image?" with a test run (main/recomp/service.ts): a Delete answer does not send the disc
// image (or the unpacked game folder) to the Recycle Bin at once. It is first moved aside, by a rename, into a hidden
// holding folder right beside it — <its folder>\.playout-held\<hold id>\<its name> — and PlayOut starts the
// recompilation to see whether it runs without it. Only then does it go to the Recycle Bin (the test passed or the
// player said Delete anyway), or back to where it was (Restore). A rename inside the file's own folder never crosses a
// volume, takes no extra space and is instant; nothing is ever moved outside the file's own folder.
//
// Every scan and walker skips the holding folder (isHeldDirName): the ROM scanner, ROM transfers, Trim Games, the
// Emulation folder sync, Delete from this PC's folder checks.
import { promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { renameRetry } from '../util/fs'
import { normalizePath } from '../util/paths'
import { tMain } from '../i18n'

/** The hidden holding folder's name (a dot name: every scan already passes it by; isHeldDirName says so outright). */
export const HELD_DIR = '.playout-held'

/** Whether a folder name is a holding folder (never scanned, listed, synced, converted or sent). */
export function isHeldDirName(name: string): boolean {
  return name.toLowerCase() === HELD_DIR
}

/** One file (or folder) moved aside: where it was and where it waits. */
export interface HeldEntry {
  original: string
  held: string
}

/** Hold ids are PlayOut's own (newHoldId): letters, digits and dashes only, so a path is never built from anything else. */
export function validHoldId(id: string): boolean {
  return /^[a-z0-9-]{6,64}$/i.test(id)
}

/** A new hold id: the time and a random part ("m3x9k2-4f7a1c"). */
export function newHoldId(now: number = Date.now(), random: () => number = Math.random): string {
  const rand = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  return `${now.toString(36)}-${rand}`
}

/** Where `original` waits while held: <its folder>\.playout-held\<holdId>\<its name>. */
export function heldPathFor(original: string, holdId: string): string {
  const full = resolve(original)
  return join(dirname(full), HELD_DIR, holdId, basename(full))
}

/** The folder a hold keeps its files in beside `original` (<its folder>\.playout-held\<holdId>). */
const holdDirFor = (original: string, holdId: string): string =>
  join(dirname(resolve(original)), HELD_DIR, holdId)

/**
 * Whether a stored entry is one PlayOut made for `holdId`: an absolute original whose held path is exactly
 * heldPathFor (a manifest edited by hand never makes PlayOut rename or trash anything else).
 */
export function heldEntryValid(entry: HeldEntry, holdId: string): boolean {
  return (
    validHoldId(holdId) &&
    isAbsolute(entry.original) &&
    basename(entry.original) !== '' &&
    // Never a file already inside a holding folder (a hold of a hold).
    !resolve(entry.original)
      .split(/[\\/]/)
      .some((part) => isHeldDirName(part)) &&
    normalizePath(entry.held) === normalizePath(heldPathFor(entry.original, holdId))
  )
}

/** The file work, injectable for tests. */
export interface HeldIo {
  rename(from: string, to: string): Promise<void>
  /** Create a folder and its parents. */
  mkdir(dir: string): Promise<void>
  /** Remove an empty folder (rejects when it is not empty: never removes anything else). */
  rmdir(dir: string): Promise<void>
  /** Whether something (a file, folder or link) is at `path`. */
  exists(path: string): Promise<boolean>
  /** Move to the Recycle Bin (electron's shell.trashItem; never deletes for good). */
  trash(path: string): Promise<void>
}

export const defaultHeldIo: Omit<HeldIo, 'trash'> = {
  rename: (from, to) => renameRetry(from, to),
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true })
  },
  rmdir: (dir) => fs.rmdir(dir),
  exists: (path) =>
    fs.lstat(path).then(
      () => true,
      () => false
    )
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Remove the hold's folders when empty (<dir>\.playout-held\<id>, then <dir>\.playout-held); never anything else. */
export async function cleanupHoldDirs(
  entries: readonly HeldEntry[],
  holdId: string,
  io: Pick<HeldIo, 'rmdir'>
): Promise<void> {
  const dirs = new Map<string, string>()
  for (const e of entries) {
    const d = holdDirFor(e.original, holdId)
    dirs.set(normalizePath(d), d)
  }
  for (const d of dirs.values()) {
    await io.rmdir(d).catch(() => {})
    await io.rmdir(dirname(d)).catch(() => {})
  }
}

export type MoveAsideResult =
  | { ok: true }
  /** `stuck`: entries that could not be put back after a failure (they are still held: keep the record). */
  | { ok: false; message: string; stuck: HeldEntry[] }

/**
 * Move every entry aside, in order. On a failure the ones moved go back (reverse order) and nothing is held; when one
 * of those cannot go back it is listed in `stuck` (still held, for the player to restore).
 */
export async function moveAside(
  entries: readonly HeldEntry[],
  holdId: string,
  io: Omit<HeldIo, 'trash'>
): Promise<MoveAsideResult> {
  const moved: HeldEntry[] = []
  let failure: string | null = null
  for (const e of entries) {
    if (!heldEntryValid(e, holdId)) {
      failure = tMain('mainDelete.held.cannotMoveAside', { path: e.original })
      break
    }
    try {
      if (await io.exists(e.held)) throw new Error(`${e.held} exists already`)
      await io.mkdir(dirname(e.held))
      await io.rename(e.original, e.held)
      moved.push(e)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      failure =
        code === 'EXDEV'
          ? tMain('mainDelete.held.otherDrive', { file: basename(e.original) })
          : tMain('mainDelete.held.couldNotMoveAside', {
              file: basename(e.original),
              error: message(err)
            })
      break
    }
  }
  if (failure === null) return { ok: true }
  const stuck: HeldEntry[] = []
  for (const e of [...moved].reverse()) {
    try {
      await io.rename(e.held, e.original)
    } catch {
      stuck.push(e)
    }
  }
  await cleanupHoldDirs(entries, holdId, io)
  return { ok: false, message: failure, stuck }
}

export interface PutBackResult {
  ok: boolean
  message: string
  /** Entries back at their original path (now or already). */
  restored: HeldEntry[]
  /** Entries still held (a rename failed, or nothing was moved because of a conflict). */
  left: HeldEntry[]
}

/**
 * Put every entry back at its exact original path. Nothing is overwritten: when something is at an original path
 * while its file is still held, nothing moves and the message says which path is in the way. An entry already back
 * (or never moved) counts as restored; one found in neither place is reported as missing.
 */
export async function putBack(
  entries: readonly HeldEntry[],
  holdId: string,
  io: Omit<HeldIo, 'trash'>
): Promise<PutBackResult> {
  const plan: { e: HeldEntry; held: boolean; there: boolean }[] = []
  for (const e of entries) {
    if (!heldEntryValid(e, holdId))
      return {
        ok: false,
        message: tMain('mainDelete.held.notMovedByPlayOut', { path: e.original }),
        restored: [],
        left: [...entries]
      }
    plan.push({ e, held: await io.exists(e.held), there: await io.exists(e.original) })
  }
  const blocked = plan.find((p) => p.held && p.there)
  if (blocked)
    return {
      ok: false,
      message: tMain('mainDelete.held.blocked', { path: blocked.e.original }),
      restored: [],
      left: [...entries]
    }
  const restored: HeldEntry[] = []
  const left: HeldEntry[] = []
  const missing: string[] = []
  let failure: string | null = null
  // Back in the reverse order: the card's own file (moved last) first, then the sheets, then the files they list, so a
  // restore that stops part way never leaves a track that shows up as a game of its own at the next scan.
  for (const p of [...plan].reverse()) {
    if (!p.held) {
      if (p.there) restored.push(p.e)
      else missing.push(basename(p.e.original))
      continue
    }
    try {
      await io.mkdir(dirname(p.e.original))
      await io.rename(p.e.held, p.e.original)
      restored.push(p.e)
    } catch (err) {
      failure ??= tMain('mainDelete.held.couldNotPutBack', {
        file: basename(p.e.original),
        error: message(err)
      })
      left.push(p.e)
    }
  }
  if (!left.length) await cleanupHoldDirs(entries, holdId, io)
  if (failure)
    return {
      ok: false,
      message: tMain('mainDelete.held.stillAside', { error: failure }),
      restored,
      left
    }
  return {
    ok: true,
    message: missing.length
      ? tMain('mainDelete.held.restoredMissing', { files: missing.join(', ') })
      : 'Restored',
    restored,
    left
  }
}

export interface TrashHeldResult {
  ok: boolean
  message: string
  /** Entries still held (their move to the Recycle Bin failed). */
  left: HeldEntry[]
}

/**
 * Move the held entries to the Recycle Bin, in order (from where they wait: the hidden folder beside their original
 * place). An entry no longer held (put back by hand) is left alone. Stops at the first failure: the rest stay held.
 */
export async function trashHeld(
  entries: readonly HeldEntry[],
  holdId: string,
  io: HeldIo
): Promise<TrashHeldResult> {
  for (const [i, e] of entries.entries()) {
    if (!heldEntryValid(e, holdId))
      return {
        ok: false,
        message: tMain('mainDelete.held.notMovedByPlayOutDelete', { path: e.held }),
        left: entries.slice(i)
      }
    if (!(await io.exists(e.held))) continue
    try {
      await io.trash(e.held)
    } catch (err) {
      return {
        ok: false,
        message: tMain('mainDelete.held.recycleFailed', {
          file: basename(e.original),
          error: message(err)
        }),
        left: entries.slice(i)
      }
    }
  }
  await cleanupHoldDirs(entries, holdId, io)
  return { ok: true, message: tMain('mainDelete.held.moved'), left: [] }
}
