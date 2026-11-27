import { promises as fs } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { renameRetry, RM_RETRY } from '../util/fs'
import { tMain } from '../i18n'

/**
 * Puts a newer build over an installed emulator folder, the way the emulators' own updaters do: every file of the new
 * build replaces the installed one, and everything else in the folder (settings, saves, the junctions into the data
 * Emulation folder) stays. docs/emulator-setup.md, "Updates".
 *
 * - A file listed by `keep` that is already installed is not replaced (the user's settings shipped as defaults).
 * - A folder or file that is a junction or symbolic link in the installed folder is never written through: it points
 *   into the data Emulation folder (saves, BIOS), so the build's files under it are left out.
 * - Each replaced file is first moved into `backupDir` (same volume: a rename), so `undo` puts the folder back exactly
 *   as it was when a step fails; `commit` deletes the backup.
 * - Every step is written to a journal (`<backupDir>.journal`) before it is made. PlayOut closed half-way leaves the
 *   journal and the backup: `recoverOverlay` puts the folder back from them (at the next start, and before the next
 *   update of that folder). A backup is never deleted while one of its files could not be put back.
 */

export interface OverlayOptions {
  /** Relative paths (with `\` or `/`, any case) not replaced when they are already installed. */
  keep?: (rel: string) => boolean
  /** Where replaced files are moved until commit or undo. */
  backupDir: string
}

export interface Overlay {
  /** Files that replaced an installed one, and new files. */
  replaced: number
  added: number
  /** Relative paths left out: kept settings and paths under a link. */
  skipped: string[]
  /**
   * Puts the folder back as it was. True when every file went back (the backup is then deleted); false when one could
   * not (the backup and its journal are kept, for recoverOverlay). Never throws.
   */
  undo(): Promise<boolean>
  /**
   * Keeps the new build: deletes the journal, then the backup. Throws (keeping both) when the journal can be neither
   * deleted nor emptied; the caller then undoes.
   */
  commit(): Promise<void>
}

/** The journal of an overlay into `backupDir`. */
export const journalOf = (backupDir: string): string => `${backupDir}.journal`

/** Moves a file, riding out short antivirus locks; copies when a rename is refused (another volume). */
async function move(from: string, to: string): Promise<void> {
  try {
    await renameRetry(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.copyFile(from, to)
    await fs.rm(from, { force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function lstatSafe(path: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.lstat(path)
  } catch {
    return null
  }
}

/** The steps of a journal: 'B' a file moved into the backup, 'C' a file put into the folder, 'D' a folder made. */
type Step = { kind: 'B' | 'C' | 'D'; rel: string }

function parseJournal(text: string, target: string): Step[] {
  const steps: Step[] = []
  const root = resolve(target).toLowerCase() + sep
  // Only whole lines: a last line cut short (power loss) could name another file.
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)
  for (const line of whole.split('\n')) {
    const m = /^([BCD])\t(.+)$/.exec(line.replace(/\r$/, ''))
    if (!m) continue
    const rel = m[2]!
    // Only relative paths inside the folder (a damaged journal must not reach outside it).
    if (/(^|[\\/])\.\.([\\/]|$)/.test(rel) || /^([a-z]:|[\\/])/i.test(rel)) continue
    if (!resolve(target, rel).toLowerCase().startsWith(root)) continue
    steps.push({ kind: m[1] as Step['kind'], rel })
  }
  return steps
}

/**
 * Undo `steps` in `target`: new files removed, replaced files moved back from `backupDir`, new folders removed when
 * empty. True when every backed-up file that is in the backup went back. The backup and journal are deleted only then.
 */
async function undoSteps(target: string, backupDir: string, steps: Step[]): Promise<boolean> {
  let ok = true
  const backedUp = new Set(steps.filter((s) => s.kind === 'B').map((s) => s.rel))
  for (const s of [...steps].reverse()) {
    if (s.kind !== 'C') continue
    // A replaced file's new copy goes when its backup comes back (below); a new file goes now.
    if (backedUp.has(s.rel)) continue
    try {
      await fs.rm(join(target, s.rel), { force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A stray new file is harmless next to the old build.
    }
  }
  for (const rel of [...backedUp].reverse()) {
    const back = join(backupDir, rel)
    if (!(await lstatSafe(back))) continue // never moved (closed before it was): the installed file is still there
    try {
      await fs.rm(join(target, rel), { force: true, maxRetries: 5, retryDelay: 200 })
      await move(back, join(target, rel))
    } catch {
      ok = false
    }
  }
  for (const s of [...steps].reverse())
    if (s.kind === 'D') await fs.rmdir(join(target, s.rel)).catch(() => undefined)
  if (ok) {
    // Every file is back: the journal can go, then the backup (now empty of files that matter).
    await fs.rm(journalOf(backupDir), { force: true }).catch(() => undefined)
    await fs.rm(backupDir, RM_RETRY).catch(() => undefined)
  }
  return ok
}

/**
 * An overlay into `target` that PlayOut did not finish (closed half-way, or an undo that could not put everything
 * back): puts the folder back from the journal and the backup. Returns 'none' when there was nothing to do,
 * 'restored', or 'incomplete' (some files could not be put back; the backup is kept). A backup without a journal (from
 * a commit that was cut short) is deleted: its overlay finished. Never throws.
 */
export async function recoverOverlay(
  target: string,
  backupDir: string
): Promise<'none' | 'restored' | 'incomplete'> {
  let text: string | null = null
  try {
    text = await fs.readFile(journalOf(backupDir), 'utf8')
  } catch (err) {
    // Only a journal that is not there means "nothing to undo"; one that cannot be read (locked) is left, and so is
    // its backup, for the next try.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'incomplete'
  }
  if (text === null) {
    // commit deletes the journal first: a backup left without one belongs to an overlay that was kept.
    if (await lstatSafe(backupDir)) await fs.rm(backupDir, RM_RETRY).catch(() => undefined)
    return 'none'
  }
  return (await undoSteps(target, backupDir, parseJournal(text, target)))
    ? 'restored'
    : 'incomplete'
}

/**
 * Copy (move) every file of `source` over `target`. On an error the folder is put back first, then it throws. Throws
 * at once, touching nothing, when an earlier overlay of this folder left a backup it could not put back.
 */
export async function overlayFolder(
  source: string,
  target: string,
  options: OverlayOptions
): Promise<Overlay> {
  const keep = options.keep ?? (() => false)
  const backupDir = options.backupDir
  const journal = journalOf(backupDir)
  if ((await recoverOverlay(target, backupDir)) === 'incomplete')
    throw new Error(tMain('mainEmulatorSetup.update.earlierKept', { folder: backupDir }))
  await fs.mkdir(dirname(journal), { recursive: true })
  await fs.writeFile(journal, '')
  const steps: Step[] = []
  const record = async (kind: Step['kind'], rel: string): Promise<void> => {
    steps.push({ kind, rel })
    await fs.appendFile(journal, `${kind}\t${rel}\n`)
  }
  const skipped: string[] = []
  let replaced = 0
  let added = 0

  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(join(source, rel), { withFileTypes: true })
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name
      const from = join(source, childRel)
      const to = join(target, childRel)
      const there = await lstatSafe(to)
      if (there?.isSymbolicLink()) {
        // A junction or link (into the data Emulation folder): never written through.
        skipped.push(childRel)
        continue
      }
      if (entry.isDirectory()) {
        if (!there) {
          await record('D', childRel)
          await fs.mkdir(to)
        } else if (!there.isDirectory()) {
          skipped.push(childRel)
          continue
        }
        await walk(childRel)
      } else if (entry.isFile()) {
        if (there && (!there.isFile() || keep(childRel))) {
          skipped.push(childRel)
          continue
        }
        if (there) {
          const back = join(backupDir, childRel)
          await fs.mkdir(dirname(back), { recursive: true })
          await record('B', childRel)
          await move(to, back)
          replaced++
        } else {
          added++
        }
        // Recorded before the move: a half-written file is removed by undo too.
        await record('C', childRel)
        await move(from, to)
      }
    }
  }

  const undo = (): Promise<boolean> => undoSteps(target, backupDir, steps)
  try {
    await walk('')
  } catch (err) {
    const back = await undo()
    if (!back)
      throw new Error(
        tMain('mainEmulatorSetup.update.notPutBack', {
          error: err instanceof Error ? err.message : String(err),
          folder: backupDir
        }),
        { cause: err }
      )
    throw err
  }
  return {
    replaced,
    added,
    skipped,
    undo,
    commit: async () => {
      // The journal goes first: a commit cut short leaves a backup without one, which recoverOverlay just deletes
      // (undoing from a journal whose backup is half gone would remove the new build's files). A journal that cannot
      // be deleted is emptied (an empty journal undoes nothing); one that cannot be emptied either throws, keeping
      // the backup, so the overlay can still be undone.
      try {
        await fs.rm(journal, { force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        await fs.writeFile(journal, '')
      }
      await fs.rm(backupDir, RM_RETRY).catch(() => undefined)
    }
  }
}

/**
 * A keep rule from patterns: a pattern ending in `/` keeps every file under that folder, otherwise it names one file.
 * Case-insensitive; `\` and `/` are the same.
 */
export function keepRule(patterns: readonly string[]): (rel: string) => boolean {
  const norm = (p: string): string =>
    p
      .replace(/[\\/]+/g, '/')
      .replace(/^\//, '')
      .toLowerCase()
  const dirs = patterns.filter((p) => /[\\/]$/.test(p)).map(norm)
  const files = new Set(patterns.filter((p) => !/[\\/]$/.test(p)).map(norm))
  return (rel) => {
    const r = norm(rel.split(sep).join('/'))
    return files.has(r) || dirs.some((d) => r.startsWith(d))
  }
}
