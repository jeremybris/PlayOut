import { promises as fs } from 'fs'
import { dirname, join, parse } from 'path'
import type {
  EmulationFolderOffer,
  EmulationMoveMode,
  EmulationMovePlan,
  EmulationMoveProgress,
  EmulationMoveRequest,
  EmulationMoveResult
} from '../../shared/emulation-move'
import type { Settings, SettingsPatch } from '../../shared/types'
import { tMain } from '../i18n'
import type { Logger } from '../logger'
import { emulationDirOf } from './emulation-dir'
import {
  comparable,
  documentsEmulationDir,
  forbiddenKindOf,
  forbiddenKindOfSync,
  hasContent,
  isSameOrInside,
  looksLikeEmulationFolder,
  realPathOf,
  targetForPick,
  type ForbiddenKind,
  type ForbiddenRoot
} from './emulation-location'
import { renameRetry } from '../util/fs'
import {
  copiedTo,
  CUT_NAME,
  measureTree,
  moveEmulationFolder,
  relinkTree,
  removeCopiedTree,
  removeTree,
  renameOver,
  RollbackUnfinished,
  stagingDir,
  StrandedMove,
  type CopyTotals,
  type JournalPhase,
  type MoveProgressTick
} from './emulation-move'

/** Room kept free on the new place's drive beyond what the move brings. */
export const SPACE_HEADROOM = 1024 ** 3

/** The move under way, recorded for the next start (a PlayOut closed or crashed mid-move). */
interface JournalRecord {
  from: string
  to: string
  mode: 'move' | 'merge'
  phase: JournalPhase
  /** Phase 'copied': what the complete copy held (recovery switches to it only while it still does). */
  copy?: CopyTotals
  /**
   * Phase 'copied': recovery switched to the copy but could not write settings.json; the copy was in use that session
   * (it may hold files the old folder does not), so the next start switches to it again, never removes it.
   */
  adopted?: boolean
  /** Phase 'merging': files of the new place a merge renamed to a backup to replace them (recovery puts them back). */
  replaced?: { path: string; backup: string }[]
  /** When the move began (Date.now()): recovery trusts an equal size and time only for files older than that. */
  since?: number
}

export const JOURNAL_FILE = 'emulation-move.json'
/** Written once the "move it out of the install folder?" question was answered. */
export const OFFER_ANSWERED_FILE = 'emulation-folder-offer.json'

export interface EmulationMoveServiceDeps {
  settings: {
    get(): Settings
    update(patch: SettingsPatch): unknown
    /** Writes settings.json now; false when the write failed (SettingsStore.tryFlush). */
    tryFlush(): Promise<boolean>
  }
  userData: string
  /** Documents (app.getPath('documents')): the default Emulation folder is Documents\Emulation. */
  documents: string
  /** PlayOut's install and data folders (emulation-location.ts forbiddenRoots). */
  forbidden: () => ForbiddenRoot[]
  /** Why nothing may move now (a game or an emulator running…), translated; null when it may. */
  busy: (from: string) => Promise<string | null>
  /** Pauses the Emulation folder sync for the move; returns the function that resumes it. */
  holdSync?: () => () => void
  /** Right before the setting switches (the files stand at the new place). */
  beforeSwitch?: (from: string, to: string) => Promise<void>
  /** After the switch: missing folders made, other settings paths under the old folder rebased. Never fails the move. */
  afterSwitch?: (from: string, to: string) => Promise<void>
  emit: (progress: EmulationMoveProgress) => void
  log: Logger
  /** Tests: another drive acted out by a rename that throws EXDEV, the free space and drive check. */
  rename?: (from: string, to: string) => Promise<void>
  freeBytes?: (dir: string) => Promise<number | null>
  sameDrive?: (a: string, b: string) => Promise<boolean>
  /** Progress events at most this often (ms). */
  progressEveryMs?: number
}

export interface EmulationMoveService {
  /** The Emulation folder in use. */
  current(): string
  plan(request: EmulationMoveRequest): Promise<EmulationMovePlan>
  /** Moves (or switches) to `to` (a plan's `to`). Rejects with a translated message; Cancel rejects too. */
  start(to: string, mode: EmulationMoveMode): Promise<EmulationMoveResult>
  cancel(): void
  /**
   * A move is under way: whatever writes into the Emulation folder (a game or emulator launch, emulator setup and
   * updates, conversions, recompilation installs and save syncs, ROM downloads, the favourites file) waits or refuses.
   */
  moving(): boolean
  /**
   * Finishes or undoes a move a closed PlayOut left half done (startup, before the Emulation folder is used). While it
   * runs, moving() is true and start() and offer() wait for it.
   */
  recover(): Promise<void>
  /** Resolves once no move (and no recovery) is under way (closing PlayOut waits for it after cancel()). */
  idle(): Promise<void>
  /** The folder in use is inside PlayOut's install folder and the user was not asked yet: the offer to move it. */
  offer(): Promise<EmulationFolderOffer | null>
  /** The offer was answered (moved or declined): not asked again. */
  answerOffer(): Promise<void>
  /** Throws (translated) when `dir` may not be the Emulation folder (settings patches from the renderer). */
  validate(dir: string | null): void
}

function blockedText(kind: ForbiddenKind): string {
  return kind === 'install'
    ? tMain('mainEmulationMove.blocked.install')
    : tMain('mainEmulationMove.blocked.data')
}

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  let probe = dir
  for (;;) {
    const st = await fs.statfs(probe).catch(() => null)
    if (st) return st.bavail * st.bsize
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
}

async function defaultSameDrive(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([realPathOf(a), realPathOf(b)])
  return parse(ra).root.toLowerCase() === parse(rb).root.toLowerCase()
}

export function createEmulationMoveService(deps: EmulationMoveServiceDeps): EmulationMoveService {
  const { log } = deps
  const journalFile = join(deps.userData, JOURNAL_FILE)
  const offerFile = join(deps.userData, OFFER_ANSWERED_FILE)
  const freeBytes = deps.freeBytes ?? defaultFreeBytes
  const sameDrive = deps.sameDrive ?? defaultSameDrive
  let running: AbortController | null = null
  /** The move under way (start), settled when it ends. */
  let runningTask: Promise<unknown> | null = null
  /** Startup recovery under way: a move, the offer and launches wait (or refuse) until it is done. */
  let recovering: Promise<void> | null = null

  const current = (): string => emulationDirOf(deps.settings.get(), deps.userData)

  /**
   * Written whole or not at all (a temporary file renamed over it): a PlayOut closed mid-write leaves the previous
   * record, never an empty or cut file.
   */
  async function writeJournal(record: JournalRecord | null): Promise<void> {
    const tmp = `${journalFile}.tmp`
    if (!record) {
      await fs.rm(journalFile, { force: true }).catch(() => undefined)
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      return
    }
    await fs.mkdir(deps.userData, { recursive: true })
    try {
      await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
      await renameRetry(tmp, journalFile)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  }

  /** Sets the Emulation folder setting and writes settings.json; put back as it was (and thrown) when that fails. */
  async function setSaved(dir: string | null, failText: string): Promise<void> {
    const before = deps.settings.get().library.emulationDir
    deps.settings.update({ library: { emulationDir: dir } })
    if (await deps.settings.tryFlush()) return
    deps.settings.update({ library: { emulationDir: before } })
    await deps.settings.tryFlush()
    throw new Error(failText)
  }

  /**
   * The move's commit: the setting switched to `to` and saved, or (any failure) left as it was. Nothing of the old
   * folder is touched before this succeeds.
   */
  async function switchTo(to: string, from: string): Promise<void> {
    await deps.beforeSwitch?.(from, to)
    try {
      await setSaved(to, tMain('mainEmulationMove.saveFailed'))
    } catch (err) {
      // What beforeSwitch noted follows the folder back.
      await deps.beforeSwitch?.(to, from).catch(() => undefined)
      throw err
    }
  }

  /** The same, after the files were moved: first a last check that nothing started meanwhile (a game, a setup). */
  async function commitMove(to: string, from: string): Promise<void> {
    const busy = await deps.busy(from)
    if (busy) throw new Error(busy)
    await switchTo(to, from)
  }

  /**
   * The files stand at `to` and cannot go back (a move on one drive whose rename back failed, or a recovery): the
   * setting follows them, whatever is busy. The in-memory setting names `to` even when settings.json cannot be
   * written (false then; the journal stays for the next start).
   */
  async function adopt(from: string, to: string): Promise<boolean> {
    await deps.beforeSwitch?.(from, to).catch((err) => log.warn('before the switch', err))
    deps.settings.update({ library: { emulationDir: to } })
    const saved = await deps.settings.tryFlush()
    await deps.afterSwitch?.(from, to).catch((err) => log.warn('after the switch', err))
    return saved
  }

  async function filesIn(dir: string): Promise<number> {
    return (await fs.lstat(dir).catch(() => null))
      ? (await measureTree(dir).catch(() => ({ files: 0 }))).files
      : 0
  }

  async function planFor(from: string, to: string): Promise<EmulationMovePlan> {
    const same = comparable(from) === comparable(to)
    let blocked: string | null = null
    // The folder in use itself is never refused (an older setup's may still be in a place a new one may not be).
    const kind = same ? null : await forbiddenKindOf(to, deps.forbidden())
    // Inside or around the folder in use, also through junctions on the way (never a move into itself).
    const [realFrom, realTo] = same
      ? [from, to]
      : await Promise.all([realPathOf(from), realPathOf(to)])
    const inside = (parent: string[], child: string[]): boolean =>
      parent.some((p) => child.some((c) => isSameOrInside(p, c)))
    // A folder in use that is itself a link (Documents\Emulation -> E:\Emulation) would move only the link while the
    // files stay where it points: refused, with the way out (choose the real folder first).
    const fromIsLink = !same && !!(await fs.lstat(from).catch(() => null))?.isSymbolicLink()
    if (kind) blocked = blockedText(kind)
    else if (fromIsLink) blocked = tMain('mainEmulationMove.blocked.currentIsLink')
    else if (!same && inside([from, realFrom], [to, realTo]))
      blocked = tMain('mainEmulationMove.blocked.insideCurrent')
    else if (!same && inside([to, realTo], [from, realFrom]))
      blocked = tMain('mainEmulationMove.blocked.containsCurrent')
    else {
      const st = await fs.lstat(to).catch(() => null)
      if (st && (!st.isDirectory() || st.isSymbolicLink()))
        blocked = tMain('mainEmulationMove.blocked.notFolder')
    }
    const fromHas = !same && (await hasContent(from))
    const size = fromHas ? await measureTree(from) : { bytes: 0, files: 0 }
    const targetHas = !same && (await hasContent(to))
    const targetIsEmulation = targetHas && (await looksLikeEmulationFolder(to))
    const drive = same || (await sameDrive(from, dirname(to)))
    // A merge copies every file; a move to another drive copies them all; a rename needs no room.
    const neededBytes = fromHas && (targetHas || !drive) ? size.bytes : 0
    const free = same ? null : await freeBytes(dirname(to))
    if (!blocked && neededBytes > 0 && free !== null && neededBytes + SPACE_HEADROOM > free)
      blocked = tMain('mainEmulationMove.blocked.noSpace', {
        size: gb(neededBytes),
        free: gb(free)
      })
    if (!blocked && !same && fromHas) blocked = await deps.busy(from)
    return {
      from,
      to,
      blocked,
      same,
      hasContent: fromHas,
      bytes: size.bytes,
      files: size.files,
      sameDrive: drive,
      freeBytes: free,
      neededBytes,
      targetHasContent: targetHas,
      targetIsEmulation
    }
  }

  return {
    current,

    async plan(request) {
      const from = current()
      let to: string
      if (request.kind === 'default') to = documentsEmulationDir(deps.documents)
      else {
        if (!request.picked) throw new Error('no folder picked')
        to = await targetForPick(request.kind, request.picked)
      }
      return planFor(from, to)
    },

    start(to, mode) {
      if (running) return Promise.reject(new Error(tMain('mainEmulationMove.alreadyRunning')))
      const controller = new AbortController()
      running = controller
      const task = runMove(to, mode, controller)
      runningTask = task
      return task
    },

    cancel() {
      running?.abort()
    },

    moving() {
      return running !== null || recovering !== null
    },

    recover() {
      if (!recovering)
        recovering = runRecovery().finally(() => {
          recovering = null
        })
      return recovering
    },

    async idle() {
      await recovering?.catch(() => undefined)
      await runningTask?.catch(() => undefined)
    },

    async offer() {
      // Asked only once a move PlayOut closed during is finished or undone (it may target the same folder).
      await recovering
      const dir = current()
      if ((await forbiddenKindOf(dir, deps.forbidden())) !== 'install') return null
      const answered = await fs.stat(offerFile).catch(() => null)
      if (answered) return null
      return { current: dir, suggested: documentsEmulationDir(deps.documents) }
    },

    async answerOffer() {
      await fs.mkdir(deps.userData, { recursive: true })
      await fs.writeFile(
        offerFile,
        JSON.stringify({ answeredAt: new Date().toISOString() }),
        'utf8'
      )
    },

    validate(dir) {
      if (!dir) return
      // The folder in use may stay (an older setup's, until it is moved); a new one may not be there.
      if (comparable(dir) === comparable(current())) return
      const kind = forbiddenKindOfSync(dir, deps.forbidden())
      if (kind) throw new Error(blockedText(kind))
    }
  }

  async function runMove(
    to: string,
    mode: EmulationMoveMode,
    controller: AbortController
  ): Promise<EmulationMoveResult> {
    // A move started while startup recovery runs waits for it: recovery decides on the folders as they are.
    await recovering
    const from = current()
    const release = deps.holdSync?.()
    const every = deps.progressEveryMs ?? 250
    /** The setting names `to` (the commit succeeded): from then on the move counts as done. */
    let switched = false
    try {
      const plan = await planFor(from, to)
      if (plan.blocked) throw new Error(plan.blocked)
      if (plan.same) return { dir: to, moved: false, leftInOld: 0, keptOlder: 0 }
      if (mode === 'switch' || !plan.hasContent) {
        await fs.mkdir(to, { recursive: true })
        await switchTo(to, from)
        await deps.afterSwitch?.(from, to).catch((err) => log.warn('after the switch', err))
        log.info(`Emulation folder switched from ${from} to ${to} (nothing moved)`)
        return { dir: to, moved: false, leftInOld: 0, keptOlder: 0 }
      }
      const effective = plan.targetHasContent ? 'merge' : mode === 'merge' ? 'merge' : 'move'
      if (effective === 'move' && plan.targetHasContent)
        throw new Error(tMain('mainEmulationMove.blocked.notEmpty'))
      let last = 0
      const total = { bytesTotal: plan.bytes, filesTotal: plan.files }
      const emit = (tick: MoveProgressTick, force = false): void => {
        const now = Date.now()
        if (!force && now - last < every) return
        last = now
        deps.emit({ ...tick, ...total })
      }
      deps.emit({ phase: 'measuring', bytesDone: 0, filesDone: 0, ...total })
      const replaced: { path: string; backup: string }[] = []
      const since = Date.now()
      const journal = {
        write: (phase: JournalPhase, copy?: CopyTotals) =>
          writeJournal({
            from,
            to,
            mode: effective,
            phase,
            since,
            ...(copy ? { copy } : {}),
            ...(phase === 'merging' && replaced.length ? { replaced } : {})
          }),
        replacing: async (path: string, backup: string) => {
          replaced.push({ path, backup })
          await journal.write('merging')
        }
      }
      log.info(
        `Emulation folder: ${effective} ${from} -> ${to} (${plan.files} files, ${plan.bytes} bytes)`
      )
      const outcome = await moveEmulationFolder(from, to, {
        mode: effective,
        since,
        signal: controller.signal,
        onProgress: (tick) => emit(tick, tick.phase !== 'copying'),
        commit: async () => {
          await commitMove(to, from)
          switched = true
        },
        journal,
        ...(deps.rename ? { rename: deps.rename } : {}),
        warn: (message) => log.warn(message)
      })
      // Removing the old folder did not finish: the journal ('cleaning') lets the next start finish it.
      if (!outcome.cleanupUnfinished) await writeJournal(null)
      await deps.afterSwitch?.(from, to).catch((err) => log.warn('after the switch', err))
      log.info(
        `Emulation folder moved to ${to}${outcome.renamed ? ' (renamed)' : ''}; left in the old folder: ${outcome.leftInOld}, older files kept: ${outcome.keptOlder}`
      )
      return { dir: to, moved: true, leftInOld: outcome.leftInOld, keptOlder: outcome.keptOlder }
    } catch (err) {
      if (err instanceof StrandedMove) return await strandedAt(from, err)
      if (switched) {
        // Failed after the switch (never expected: emulation-move.ts treats that part as best effort). The setting
        // names the new folder, which holds every file: the move is done, and the journal stays so the next start
        // finishes emptying the old folder.
        log.warn(`Emulation folder move to ${to}: after the switch: ${(err as Error).message}`)
        await deps.afterSwitch?.(from, to).catch((e) => log.warn('after the switch', e))
        return { dir: to, moved: true, leftInOld: await filesIn(from), keptOlder: 0 }
      }
      // A failure before the switch left the old folder and the setting as they were (emulation-move.ts). When its
      // undo did not finish (a file of the new place not put back, a link not pointed back), the journal stays and
      // the next start finishes it.
      const unfinished = err instanceof RollbackUnfinished
      const cause = unfinished ? err.original : err
      if (unfinished)
        log.warn(
          `Emulation folder move to ${to}: putting it back did not finish; the next start finishes it`
        )
      else await writeJournal(null)
      if (controller.signal.aborted)
        throw new Error(tMain('mainEmulationMove.cancelled'), { cause: err })
      log.warn(`Emulation folder move to ${to} failed: ${(cause as Error)?.message}`)
      throw cause
    } finally {
      running = null
      runningTask = null
      release?.()
      deps.emit({ phase: 'done', bytesDone: 0, filesDone: 0, bytesTotal: 0, filesTotal: 0 })
    }
  }

  /**
   * A move on one drive whose switch failed and whose folder could not be renamed back: every file stands at the new
   * place, so the setting follows it (the old place may hold a few files written meanwhile: left there).
   */
  async function strandedAt(from: string, err: StrandedMove): Promise<EmulationMoveResult> {
    const to = err.dir
    log.warn(
      `Emulation folder move to ${to}: the switch failed (${(err.original as Error)?.message}) and the folder could not be put back (${(err.putBack as Error)?.message}): ${to} is used now`
    )
    const linked = await relinkTree(to, from, to, (message) => log.warn(message), true).then(
      () => true,
      (e) => {
        log.warn('links in the moved folder', e)
        return false
      }
    )
    // settings.json not written: the journal ('renamed') stays, and the next start switches it again. A link not
    // pointed at the new place: it stays too, and the next start points it.
    if (!(await adopt(from, to))) throw err.original
    if (linked) await writeJournal(null)
    const leftInOld = await filesIn(from)
    log.info(`Emulation folder moved to ${to} (renamed); left in the old folder: ${leftInOld}`)
    return { dir: to, moved: true, leftInOld, keptOlder: 0 }
  }

  /** Old files (not links) the copy at `to` does not hold as they are: written after the copy, or missing there. */
  async function changedSinceCopy(from: string, to: string, since?: number): Promise<number> {
    const isCopied = copiedTo(from, to, since)
    let changed = 0
    const visit = async (path: string): Promise<void> => {
      const st = await fs.lstat(path).catch(() => null)
      if (!st || st.isSymbolicLink()) return
      if (st.isDirectory()) {
        for (const name of await fs.readdir(path)) await visit(join(path, name))
      } else if (st.isFile() && !(await isCopied(path, st))) changed++
    }
    await visit(from)
    return changed
  }

  /**
   * A merge cut short before its switch: a file of the new place that was being replaced comes back under its own name
   * (from its *.playout-old backup), and copies not put in place yet (*.playout-new) go. Every file is still in the
   * old folder.
   */
  async function repairMerge(
    to: string,
    replaced: { path: string; backup: string }[] = []
  ): Promise<number> {
    let repaired = 0
    /** Steps that failed: the rest is still done, then the repair throws (the journal stays for the next start). */
    let failed = 0
    const step = async (what: string, run: () => Promise<void>): Promise<boolean> => {
      try {
        await run()
        return true
      } catch (err) {
        failed++
        log.warn(`Emulation folder merge repair: ${what}: ${(err as Error).message}`)
        return false
      }
    }
    // Recorded replacements first (newest first): a backup still there goes back over whatever stands at its name
    // (the old folder's copy, which is still in the old folder; made writable first, as Windows refuses to rename
    // over a read-only file).
    for (const { path, backup } of [...replaced].reverse()) {
      if (typeof path !== 'string' || typeof backup !== 'string') continue
      if (!isSameOrInside(to, path) || !isSameOrInside(to, backup)) continue
      if (!(await fs.lstat(backup).catch(() => null))?.isFile()) continue
      if (await step(`${backup} not put back`, () => renameOver(backup, path))) repaired++
    }
    const visit = async (dir: string): Promise<void> => {
      const names = await fs.readdir(dir).catch(() => [] as string[])
      const lower = new Set(names.map((n) => n.toLowerCase()))
      /** base name -> its newest backup (the highest -N). */
      const backups = new Map<string, { name: string; n: number }>()
      for (const name of names) {
        const path = join(dir, name)
        const st = await fs.lstat(path).catch(() => null)
        if (!st) continue
        if (st.isDirectory() && !st.isSymbolicLink()) {
          await visit(path)
          continue
        }
        if (!st.isFile()) continue
        if (name.toLowerCase().endsWith('.playout-new')) {
          await step(`${path} not removed`, () => fs.rm(path, { force: true }))
          continue
        }
        const m = /^(.*)\.playout-old(?:-(\d+))?$/i.exec(name)
        // A cut name (a very long one) cannot be mapped back: left as it is.
        if (!m || CUT_NAME.test(m[1]) || lower.has(m[1].toLowerCase())) continue
        const n = m[2] ? Number(m[2]) : 1
        const was = backups.get(m[1])
        if (!was || n > was.n) backups.set(m[1], { name, n })
      }
      for (const [base, { name }] of backups)
        if (
          await step(`${join(dir, name)} not put back`, () =>
            renameRetry(join(dir, name), join(dir, base))
          )
        )
          repaired++
    }
    await visit(to)
    if (failed) throw new Error(`${failed} files of ${to} could not be put back`)
    return repaired
  }

  async function runRecovery(): Promise<void> {
    let text: string
    try {
      text = await fs.readFile(journalFile, 'utf8')
    } catch {
      return // no move was under way
    }
    let record: JournalRecord | null
    try {
      record = JSON.parse(text) as JournalRecord
    } catch {
      // Cannot be read (it is written whole, so this is damage from outside PlayOut): what it held is unknown, so
      // nothing is touched, and it is kept aside (never deleted) for a look.
      log.warn(
        `Emulation folder move journal ${journalFile} cannot be read: kept as ${journalFile}.unreadable`
      )
      await renameRetry(journalFile, `${journalFile}.unreadable`).catch(() => undefined)
      return
    }
    if (!record || typeof record.from !== 'string' || typeof record.to !== 'string') {
      await writeJournal(null)
      return
    }
    const { from, to, mode, phase } = record
    const since = typeof record.since === 'number' ? record.since : undefined
    // The folder in use, read again right before anything is removed (never decided once for the whole recovery).
    const inUse = (): string => comparable(current())
    const warn = (message: string): void => log.warn(message)
    /** The journal stays for the next start (this one could not finish). */
    let keep = false
    try {
      if (mode === 'move' && phase === 'renamed') {
        if (inUse() === comparable(from) && (await hasContent(to))) {
          // The rename went through and the setting did not follow: every file stands at `to`, which is used now. (A
          // link not pointed there keeps the journal: the next start points it, see below.)
          const linked = await relinkTree(to, from, to, warn, true).then(
            () => true,
            () => false
          )
          if (!(await adopt(from, to)) || !linked) keep = true
          const left = await filesIn(from)
          log.warn(
            `Emulation folder move to ${to} was cut short after the rename: ${to} is used now${left ? ` (${left} files written meanwhile stay in ${from})` : ''}`
          )
        } else if (inUse() === comparable(from) && (await fs.lstat(from).catch(() => null))) {
          // Never renamed, or renamed back: links that were pointed at `to` point back (one that fails: next start).
          await relinkTree(from, to, from, warn, true)
        } else if (inUse() === comparable(to) && (await fs.lstat(to).catch(() => null))) {
          // Switched (by a stranded move or an earlier start) with links left pointing at `from`: pointed now.
          await relinkTree(to, from, to, warn, true)
        }
      } else if (mode === 'move' && phase === 'copying') {
        // Cut short mid-copy: the old folder is whole and still in use; the partial copy goes.
        await removeTree(stagingDir(to))
        log.info(`Emulation folder move to ${to} was cut short: the partial copy was removed`)
      } else if (mode === 'move' && phase === 'rolling-back') {
        // The switch failed and the copy was being removed: the old folder is whole and in use; the rest goes.
        if (inUse() !== comparable(to) && (await fs.lstat(from).catch(() => null))) {
          await removeTree(to)
          log.info(`Emulation folder move to ${to} was undone: the copy was removed`)
        }
      } else if (mode === 'move' && (phase === 'copied' || phase === 'cleaning')) {
        let finish = true
        if (phase === 'copied' && inUse() === comparable(from) && record.adopted) {
          // Switched to at an earlier start whose settings.json could not be written: the copy was in use since.
          if (!(await adopt(from, to))) {
            finish = false
            keep = true
          }
        } else if (phase === 'copied' && inUse() === comparable(from)) {
          // The copy was complete and checked when recorded: switched to only while it still holds all of it (an
          // undo cut short may have removed part of it), and while the old folder, still in use while PlayOut was
          // closed, has nothing newer (a save played meanwhile).
          const expected = record.copy ?? (await measureTree(from))
          const copy = await measureTree(to)
          const changed =
            copy.files === expected.files && copy.bytes === expected.bytes
              ? await changedSinceCopy(from, to, since)
              : -1
          if (changed !== 0) {
            finish = false
            // Only what the old folder holds as it is goes (copies); anything else at the new place stays.
            const left =
              inUse() !== comparable(to) ? await removeCopiedTree(to, copiedTo(to, from, since)) : 0
            log.warn(
              `${
                changed < 0
                  ? `Emulation folder move to ${to} was cut short and its copy was not whole (${copy.files} of ${expected.files} files)`
                  : `Emulation folder move to ${to} was cut short and ${changed} files of ${from} changed since the copy`
              }: the copy was removed${left ? ` (${left} files not in ${from} stay in ${to})` : ''}, ${from} stays in use`
            )
          } else if (!(await adopt(from, to))) {
            finish = false
            keep = true
            await writeJournal({ ...record, adopted: true })
          }
        } else if (phase === 'cleaning' && inUse() === comparable(to))
          // Closed while the old folder was being emptied: what follows the switch may not have run either.
          await deps.afterSwitch?.(from, to).catch((err) => log.warn('after the switch', err))
        if (finish && inUse() === comparable(to) && comparable(from) !== comparable(to)) {
          // Only old files the new place holds as they are (and links made there); anything else stays.
          const left = await removeCopiedTree(from, copiedTo(from, to, since))
          log.info(
            `Emulation folder move to ${to} finished${left ? ` (${left} files left in ${from})` : ''}`
          )
        }
      } else if (mode === 'merge') {
        // Before the switch every file is still in the old folder (merges copy); after it, what was copied is in the
        // new one. Either way nothing is lost; the old folder is left for the user. A file of the new place that was
        // being replaced comes back under its own name.
        const repaired =
          phase === 'merging' && inUse() !== comparable(to)
            ? await repairMerge(to, Array.isArray(record.replaced) ? record.replaced : [])
            : 0
        log.warn(
          `Emulation folder merge into ${to} was cut short (${phase}); ${from} is left as it is${repaired ? ` (${repaired} files of ${to} put back)` : ''}`
        )
      }
    } catch (err) {
      // Tried again at the next start.
      keep = true
      log.warn(`Emulation folder move recovery failed: ${(err as Error).message}`)
    }
    if (!keep) await writeJournal(null)
  }
}
