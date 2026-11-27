// Settings › Recompilations › Import (import.ts finds the folders): the preview of what was found, then moving each
// confirmed folder into the Recompilations folder and writing PlayOut's install record for it, so the game shows the
// recompilation as installed.
//
// The move is the Emulation folder's (emulation/emulation-move.ts): one rename on the same drive; on another drive a
// copy beside the target that is checked, renamed into place, and only then is the record written and the old files
// deleted (a file written meanwhile stays in the old folder). Any failure before the record is written puts
// everything back: the folder stays where it was. A journal (<root>\.playout\import-journal.json) records each move
// before it starts, so a PlayOut closed half-way finishes or undoes it at the next start (recover). An import waits
// for that recovery, and the recovery only removes the journal entries it finished.
//
// Never: a folder not in the last preview, a folder that is a link, a folder PlayOut or Windows needs where it is (the
// Emulation folder, PlayOut's own folders, the user's profile folders, a drive), a recompilation already installed or
// being installed, updated, started or played, a target that holds something, a folder a running program was started
// from (or while the running programs cannot be listed), or while the other launcher is open. The other launcher's
// own records are not touched (it simply finds the folder gone). Saves in the folder move with it; saves elsewhere
// stay where they are (the save search finds them).
import { promises as fs } from 'fs'
import { basename, join, parse, relative, resolve } from 'path'
import type {
  InstalledRecomp,
  RecompEntry,
  RecompImportChoice,
  RecompImportItem,
  RecompImportLauncher,
  RecompImportProgress,
  RecompImportRequest,
  RecompImportResult,
  RecompImportScan
} from '../../shared/recomp'
import type { Logger } from '../logger'
import { tMain } from '../i18n'
import { isInside, normalizePath } from '../util/paths'
import {
  copiedTo,
  measureTree,
  moveEmulationFolder,
  relinkTree,
  removeCopiedTree,
  removeTree,
  stagingDir,
  MoveCancelled,
  RollbackUnfinished,
  StrandedMove,
  type JournalPhase
} from '../emulation/emulation-move'
import { renameRetry } from '../util/fs'
import type { RecompCatalog } from './catalog'
import type { DeveloperProfile } from './gamefiles'
import {
  defaultFreeSpace,
  dirSize,
  findExe,
  formatBytes,
  listFiles,
  safeRecompFolder
} from './install'
import {
  detectImport,
  matchCandidate,
  onlyLauncherLeftovers,
  rebaseInto,
  rewriteOldPaths,
  type ImportCandidate
} from './import'
import { sameTag, sha256FromDigest, type GhRelease } from './releases'
import { defaultCloudState, recompPlayoutDir, type RecompState } from './state'
import { normalizeGameTitle } from './titles'

/** A process as the process monitor lists it (only what the checks need). */
export interface ImportProcess {
  name: string
  path: string | null
}

/** Folders an import never takes (ImportRunDeps.protectedDirs). */
export interface ImportProtectedDirs {
  /** Never a folder that is, holds or is inside one of these (the Emulation folder, PlayOut's own folders). */
  inside: string[]
  /** Never a folder that is or holds one of these (the user's profile, Documents, Desktop, Downloads). */
  holds: string[]
}

export interface ImportRunDeps {
  root(): Promise<string>
  state(): Promise<RecompState>
  catalog(): RecompCatalog | null
  /** Installing, updating, being played or started in PlayOut. */
  busy(id: string): boolean
  /**
   * Every running process (absent: not checked). A list that cannot be read (it throws) stops the move: whether a
   * program runs from the folder is then unknown.
   */
  processes?(): Promise<ImportProcess[]>
  /** Folders never taken (a drive's top folder never is either). Absent: only the drive rule. */
  protectedDirs?(): Promise<ImportProtectedDirs>
  /** The catalog loaded (recovery may need a recompilation's entry); absent: the catalog as it is. */
  ready?(): Promise<void>
  releasesOf(entry: RecompEntry): Promise<GhRelease[]>
  readProfile(dir: string): Promise<DeveloperProfile | null>
  /** After the imports: look for the saves, match the library again, tell the renderer. */
  afterImport(ids: string[]): Promise<void>
  emit(p: RecompImportProgress): void
  log: Logger
  now?: () => Date
  /** Seams (tests): fs.rename with retries (an EXDEV acts out another drive), the free space of a drive. */
  rename?: (from: string, to: string) => Promise<void>
  freeSpace?: (dir: string) => Promise<number | null>
}

export interface RecompImporter {
  scan(picked: string[]): Promise<RecompImportScan>
  run(items: RecompImportRequest[]): Promise<RecompImportResult>
  /** Stop after the folder being moved (a copy to another drive stops at once and is undone). */
  cancel(): void
  running(): boolean
  /** Being imported now (from its checks until it is recorded or put back): install, update, start wait. */
  importing(id: string): boolean
  /** At start: finish or undo the moves a closed PlayOut left half-way. */
  recover(): Promise<void>
}

const LAUNCHER_PROCESS: Record<RecompImportLauncher, RegExp> = {
  quiver: /^(quiverlauncher|githublauncher)\.exe$/i,
  recomplauncher: /^recomp[\s_-]*launcher.*\.exe$/i,
  decompbuddy: /^decomp[\s_-]*buddy.*\.exe$/i
}

export function launcherName(l: RecompImportLauncher): string {
  return tMain(`mainRecomp.import.launcher.${l}`)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Whether `a` is `b` or inside it (paths compared as Windows does). */
const sameOrInside = (b: string, a: string): boolean =>
  normalizePath(a) === normalizePath(b) || isInside(b, a)

/** The words of a name (normalized), for telling whether two names speak of the same game. */
function wordsOf(name: string): Set<string> {
  return new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((w) => normalizeGameTitle(w))
      .filter(
        (w) => w.length >= 3 && !/^(the|and|of|for|pc|port|recomp|recompiled|native)$/.test(w)
      )
  )
}

// --- journal ------------------------------------------------------------------------------------------------------

interface JournalEntry {
  from: string
  to: string
  recompId: string
  phase: JournalPhase
  since: number
  /** What was read from the folder (the install record is made from it, should the folder be left at `to`). */
  candidate?: ImportCandidate
}

function journalPath(root: string): string {
  return join(recompPlayoutDir(root), 'import-journal.json')
}

async function readJournal(root: string): Promise<JournalEntry[]> {
  try {
    const data = JSON.parse(await fs.readFile(journalPath(root), 'utf8')) as unknown
    const list = Array.isArray((data as { entries?: unknown })?.entries)
      ? (data as { entries: unknown[] }).entries
      : []
    return list.filter(
      (e): e is JournalEntry =>
        !!e &&
        typeof (e as JournalEntry).from === 'string' &&
        typeof (e as JournalEntry).to === 'string' &&
        typeof (e as JournalEntry).recompId === 'string' &&
        typeof (e as JournalEntry).phase === 'string'
    )
  } catch {
    return []
  }
}

async function writeJournal(root: string, entries: JournalEntry[]): Promise<void> {
  const file = journalPath(root)
  if (!entries.length) {
    await fs.rm(file, { force: true })
    return
  }
  await fs.mkdir(recompPlayoutDir(root), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
  await renameRetry(tmp, file)
}

const journalKey = (e: Pick<JournalEntry, 'from' | 'to'>): string =>
  `${normalizePath(e.from)}|${normalizePath(e.to)}`

// --- the importer -------------------------------------------------------------------------------------------------

export function createRecompImporter(deps: ImportRunDeps): RecompImporter {
  const now = (): Date => deps.now?.() ?? new Date()
  const rename = deps.rename ?? renameRetry
  /** The last preview's folders (only these may be moved), by normalized path. */
  let scanned = new Map<string, ImportCandidate>()
  let active: AbortController | null = null
  let cancelled = false
  /** Recompilations being imported now (importing()). */
  const importingIds = new Set<string>()
  /** The start-up recovery while it runs: an import waits for it. */
  let recovering: Promise<void> | null = null
  /** Serializes journal writes. */
  let journalTail: Promise<void> = Promise.resolve()

  const updateJournal = (
    root: string,
    fn: (list: JournalEntry[]) => JournalEntry[]
  ): Promise<void> => {
    const next = journalTail.then(async () => writeJournal(root, fn(await readJournal(root))))
    journalTail = next.catch(() => undefined)
    return next
  }

  const entryOf = (id: string): RecompEntry | null => deps.catalog()?.entries.get(id) ?? null

  /** The running programs; null when they cannot be listed. */
  async function processes(): Promise<ImportProcess[] | null> {
    if (!deps.processes) return []
    try {
      return await deps.processes()
    } catch (err) {
      deps.log.warn(`recomp import: the running programs could not be listed (${message(err)})`)
      return null
    }
  }

  /** The programs (.exe names, lowercase) in a folder: a process whose path is unknown is matched by its name. */
  async function exeNames(folder: string): Promise<Set<string>> {
    const files = await listFiles(folder, { maxDepth: 6 }).catch(() => [])
    return new Set(
      files.filter((f) => /\.exe$/i.test(f.key)).map((f) => basename(f.key).toLowerCase())
    )
  }

  /**
   * Why a folder cannot move now: the running programs cannot be listed, a program started from it (or, its path
   * unknown, one of the same name as a program in it), or the launcher that made it, is running.
   */
  async function runningReason(
    c: Pick<ImportCandidate, 'folder' | 'launcher'>,
    list: ImportProcess[] | null
  ): Promise<string | null> {
    if (!list) return tMain('mainRecomp.import.processesUnknown')
    const inside = list.find((p) => p.path && isInside(c.folder, p.path))
    if (inside)
      return tMain('mainRecomp.import.running', { program: inside.name || basename(inside.path!) })
    const unknownPath = list.filter((p) => !p.path && p.name)
    if (unknownPath.length) {
      const names = await exeNames(c.folder)
      const hit = unknownPath.find((p) => names.has(basename(p.name).toLowerCase()))
      if (hit) return tMain('mainRecomp.import.running', { program: hit.name })
    }
    if (list.some((p) => LAUNCHER_PROCESS[c.launcher].test(p.name || basename(p.path ?? ''))))
      return tMain('mainRecomp.import.launcherRunning', { launcher: launcherName(c.launcher) })
    return null
  }

  /** Why a folder is never taken (a folder PlayOut or Windows needs where it is), else null. */
  async function protectedReason(folder: string): Promise<string | null> {
    const dir = resolve(folder)
    const refuse = tMain('mainRecomp.import.protected', { path: dir })
    if (normalizePath(parse(dir).root) === normalizePath(dir)) return refuse
    const dirs = await deps.protectedDirs?.().catch((err: unknown) => {
      deps.log.warn(`recomp import: the protected folders could not be read (${message(err)})`)
      return null
    })
    if (deps.protectedDirs && !dirs) return refuse
    for (const p of dirs?.inside ?? [])
      if (p && (sameOrInside(p, dir) || isInside(dir, p))) return refuse
    for (const p of dirs?.holds ?? []) if (p && sameOrInside(dir, p)) return refuse
    return null
  }

  async function takenNames(root: string): Promise<Set<string>> {
    return new Set((await fs.readdir(root).catch(() => [] as string[])).map((n) => n.toLowerCase()))
  }

  /** Whether something is in the way at `target` (a file, a folder that is not empty). */
  async function targetTaken(target: string): Promise<boolean> {
    const there = await fs.lstat(target).catch(() => null)
    return (
      !!there && (!there.isDirectory() || (await fs.readdir(target).catch(() => ['?'])).length > 0)
    )
  }

  async function choiceOf(
    id: string,
    root: string,
    installed: Record<string, InstalledRecomp>
  ): Promise<RecompImportChoice | null> {
    const e = entryOf(id)
    if (!e) return null
    const target = join(root, safeRecompFolder(e))
    return {
      id,
      name: e.name,
      game: e.game,
      console: e.console,
      installed: !!installed[id],
      target,
      targetTaken: await targetTaken(target)
    }
  }

  function notesOf(c: ImportCandidate): string[] {
    const notes: string[] = []
    if (!c.tag) notes.push(tMain('mainRecomp.import.noteVersionUnknown'))
    if (c.installerOnly) notes.push(tMain('mainRecomp.import.noteInstaller'))
    if (c.readsGameInPlace) notes.push(tMain('mainRecomp.import.noteGameInPlace'))
    if (c.launcherBackups)
      notes.push(tMain('mainRecomp.import.noteBackups', { path: c.launcherBackups }))
    return notes
  }

  /** Whether `dir` is, holds or is inside the Recompilations folder (never taken). */
  const touchesRoot = (root: string, dir: string): boolean =>
    isInside(root, dir) || isInside(dir, root)

  /** A repository's recompilation of several (a multi-game repository) named as the other launcher names it. */
  function namedChoice(c: ImportCandidate, choices: RecompImportChoice[]): string | null {
    const names = [c.name, ...c.otherNames].map(normalizeGameTitle).filter((n) => n.length >= 3)
    const named = (n: string): boolean => {
      const norm = normalizeGameTitle(n)
      return names.some((w) => norm === w || (w.length >= 6 && norm.endsWith(w)))
    }
    // By the game first (the games of one repository share the project's name), then by the recompilation's name.
    for (const pickOf of [
      (ch: RecompImportChoice) => ch.game,
      (ch: RecompImportChoice) => ch.name
    ]) {
      const hits = choices.filter((ch) => named(pickOf(ch)))
      if (hits.length) return hits.length === 1 ? hits[0]!.id : null
    }
    return null
  }

  async function scan(picked: string[]): Promise<RecompImportScan> {
    const root = resolve(await deps.root())
    const m = await (await deps.state()).read()
    const installedDirs = Object.values(m.installed).map((r) => r.dir)
    const detection = await detectImport(
      picked,
      (dir) =>
        isInside(root, dir) || installedDirs.some((d) => isInside(d, dir) || isInside(dir, d))
    )
    const list = await processes()
    const catalog = deps.catalog()
    const items: RecompImportItem[] = []
    const found: { item: RecompImportItem; c: ImportCandidate }[] = []
    const next = new Map<string, ImportCandidate>()
    for (const c of detection.candidates) {
      if (touchesRoot(root, c.folder)) continue
      const match = matchCandidate(c, catalog)
      const choices: RecompImportChoice[] = []
      for (const id of match.ids) {
        const choice = await choiceOf(id, root, m.installed)
        if (choice) choices.push(choice)
      }
      // One sure match is the pick; several (a multi-game repository): the one the other launcher names, else the
      // user picks; a match by name only: the user confirms it.
      const free = choices.filter((ch) => !ch.installed && !ch.targetTaken)
      const pick =
        match.match === 'title'
          ? (free[0]?.id ?? choices[0]?.id ?? null)
          : choices.length === 1
            ? choices[0]!.id
            : namedChoice(c, choices)
      if (pick && choices.length > 1) {
        const at = choices.findIndex((ch) => ch.id === pick)
        choices.unshift(...choices.splice(at, 1))
      }
      const self = await fs.lstat(c.folder).catch(() => null)
      const blocked =
        c.refused === 'not-windows'
          ? tMain('mainRecomp.import.notWindows')
          : self?.isSymbolicLink()
            ? tMain('mainRecomp.import.isLink')
            : ((await protectedReason(c.folder)) ?? (await runningReason(c, list)))
      const notes = notesOf(c)
      const sure = match.match === 'repo' || match.match === 'launcher-id'
      const picked0 = choices.find((ch) => ch.id === pick)
      // A launcher's own name for it that shares no word with the recompilation's game: worth a look.
      if (sure && picked0 && c.name !== basename(c.folder)) {
        const own = wordsOf(c.name)
        const theirs = new Set([...wordsOf(picked0.game), ...wordsOf(picked0.name)])
        if (own.size && ![...own].some((w) => theirs.has(w)))
          notes.push(
            tMain('mainRecomp.import.noteNameDiffers', {
              launcher: launcherName(c.launcher),
              name: c.name,
              game: picked0.game || picked0.name
            })
          )
      }
      const item: RecompImportItem = {
        folder: c.folder,
        // A folder the launcher gave no name (RecompLauncher's app id) shows the recompilation it surely is.
        name:
          sure && picked0 && c.name === basename(c.folder) ? picked0.game || picked0.name : c.name,
        launcher: c.launcher,
        bytes: await dirSize(c.folder).catch(() => null),
        match: choices.length ? match.match : 'none',
        recompId: pick,
        choices,
        version: c.tag,
        blocked,
        notes
      }
      items.push(item)
      found.push({ item, c })
      next.set(normalizePath(c.folder), c)
    }
    // Two folders of the same recompilation (installed with both launchers): only one starts chosen, the one with
    // the game in it (not only a setup program) and a known version; the other starts at Skip and says so.
    const sureOf = (i: RecompImportItem): boolean =>
      !i.blocked && !!i.recompId && (i.match === 'repo' || i.match === 'launcher-id')
    const byId = new Map<string, { item: RecompImportItem; c: ImportCandidate }[]>()
    for (const f of found)
      if (sureOf(f.item)) byId.set(f.item.recompId!, [...(byId.get(f.item.recompId!) ?? []), f])
    for (const group of byId.values()) {
      if (group.length < 2) continue
      const score = (f: { c: ImportCandidate }): number =>
        (f.c.installerOnly ? 0 : 2) + (f.c.tag ? 1 : 0)
      const best = group.reduce((a, b) => (score(b) > score(a) ? b : a))
      for (const f of group) {
        if (f === best) continue
        f.item.recompId = null
        f.item.notes.unshift(
          tMain('mainRecomp.import.noteDuplicate', {
            launcher: launcherName(best.c.launcher),
            folder: best.c.folder
          })
        )
      }
    }
    scanned = next
    const taken = await takenNames(root)
    const all: RecompImportScan['catalog'] = []
    if (catalog)
      for (const e of catalog.entries.values()) {
        const folder = safeRecompFolder(e)
        const target = join(root, folder)
        all.push({
          id: e.id,
          name: e.name,
          game: e.game,
          console: e.console,
          installed: !!m.installed[e.id],
          target,
          // Only a name that is there needs a look (an empty folder is not in the way).
          targetTaken: taken.has(folder.toLowerCase()) ? await targetTaken(target) : false
        })
      }
    all.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    deps.log.info(
      `recomp import: ${items.length} app folder(s) found in ${picked.join(', ')} (${detection.ignored} other folder(s))`
    )
    return { picked, items, ignored: detection.ignored, catalog: all }
  }

  /** What the releases say of the version the other launcher installed: its release, when PlayOut finds it. */
  async function releaseOf(entry: RecompEntry, c: ImportCandidate): Promise<GhRelease | null> {
    if (!c.tag) return null
    try {
      const releases = await deps.releasesOf(entry)
      return releases.find((r) => sameTag(r.tag_name, c.tag!)) ?? null
    } catch (err) {
      deps.log.warn(
        `recomp import: the releases of ${entry.id} could not be read (${message(err)})`
      )
      return null
    }
  }

  /** The install record of the folder now at `dir`. */
  async function recordFor(
    entry: RecompEntry,
    c: ImportCandidate,
    dir: string,
    release: GhRelease | null
  ): Promise<InstalledRecomp> {
    const at = now().toISOString()
    const profile = await deps.readProfile(dir).catch(() => null)
    const auto = await findExe(dir, c.exeHint ?? profile?.start?.program ?? entry.exe, entry)
    const asset = c.asset ? release?.assets.find((a) => a.name === c.asset) : undefined
    const digest = sha256FromDigest(asset?.digest)
    const rec: InstalledRecomp = {
      id: entry.id,
      dir,
      tag: release?.tag_name ?? c.tag ?? '',
      publishedAt: release?.published_at ?? null,
      asset: c.asset ?? '',
      downloadBytes: asset?.size ?? 0,
      diskBytes: await dirSize(dir).catch(() => null),
      sha256: c.sha256 ?? '',
      verified: digest && c.sha256 && digest === c.sha256 ? 'github' : 'unverified',
      exe: auto,
      installedAt: c.installedAt ?? at,
      updatedAt: at,
      // Only Decomp Buddy lists what the release shipped. Anything else counts as the player's (never deleted by
      // an update; overwritten files are kept beside as *.playout-old).
      releaseFiles: c.releaseFiles,
      autoUpdate: false,
      gameFiles: {},
      savePaths: [],
      saveSource: null,
      cloud: defaultCloudState(),
      prevTag: null,
      pinnedTag: null,
      imported: { from: c.launcher, at, fromDir: c.folder, versionKnown: !!release }
    }
    // The program the player chose in the other launcher (Quiver): at the same place in the new folder, or where it
    // is (a setup program's game installed elsewhere), while the file is there.
    if (c.userExe) {
      const moved = rebaseInto(c.userExe, c.folder, dir)
      const full = moved ?? resolve(c.userExe)
      if ((await fs.stat(full).catch(() => null))?.isFile()) {
        rec.autoExe = auto
        rec.exe = moved ? relative(dir, full) : full
        rec.exeChosen = 'user'
      }
    }
    return rec
  }

  /**
   * A folder left at `dir` (its old place could not take it back): recorded as installed there, so it is not lost.
   * False when it cannot be (the recompilation is unknown, or installed already).
   */
  async function recordStranded(
    entry: RecompEntry | null,
    c: ImportCandidate | undefined,
    dir: string
  ): Promise<boolean> {
    if (!entry || !c) return false
    const st = await deps.state()
    const rec = await recordFor(entry, c, dir, null)
    let done = false
    await st.update((m) => {
      if (m.installed[entry.id]) return
      m.installed[entry.id] = rec
      done = true
    })
    if (done) deps.log.warn(`recomp import: ${c.folder} is now ${dir}, recorded as ${entry.id}`)
    return done
  }

  /** Stops a move of a recompilation PlayOut started installing, updating or starting meanwhile. */
  function checkNotBusy(entry: RecompEntry): void {
    if (deps.busy(entry.id)) throw new Error(tMain('mainRecomp.import.recompBusy'))
  }

  async function importOne(
    req: RecompImportRequest,
    index: number,
    total: number,
    root: string,
    chosen: Set<string>
  ): Promise<RecompImportResult['imported'][number]> {
    const c = scanned.get(normalizePath(req.folder))
    if (!c) throw new Error(tMain('mainRecomp.import.notScanned'))
    const entry = entryOf(req.recompId)
    if (!entry) throw new Error(tMain('mainRecomp.notInCatalog'))
    if (chosen.has(entry.id))
      throw new Error(tMain('mainRecomp.import.chosenTwice', { name: entry.name }))
    // Checked and taken in one step: from here an install, update or start of it waits (importing()), and the import
    // checks again before the folder moves and before it is recorded.
    checkNotBusy(entry)
    if (importingIds.has(entry.id)) throw new Error(tMain('mainRecomp.import.recompBusy'))
    importingIds.add(entry.id)
    try {
      return await importTaken(c, entry, index, total, root, chosen)
    } finally {
      importingIds.delete(entry.id)
    }
  }

  async function importTaken(
    c: ImportCandidate,
    entry: RecompEntry,
    index: number,
    total: number,
    root: string,
    chosen: Set<string>
  ): Promise<RecompImportResult['imported'][number]> {
    chosen.add(entry.id)
    const progress = (
      phase: RecompImportProgress['phase'],
      bytesDone = 0,
      bytesTotal: number | null = null
    ): void =>
      deps.emit({ index, total, folder: c.folder, name: entry.name, phase, bytesDone, bytesTotal })
    progress('checking')

    if (c.refused === 'not-windows') throw new Error(tMain('mainRecomp.import.notWindows'))
    const self = await fs.lstat(c.folder).catch(() => null)
    if (!self) throw new Error(tMain('mainRecomp.import.gone'))
    if (self.isSymbolicLink() || !self.isDirectory())
      throw new Error(tMain('mainRecomp.import.isLink'))
    if (touchesRoot(root, c.folder)) throw new Error(tMain('mainRecomp.import.notScanned'))
    const guarded = await protectedReason(c.folder)
    if (guarded) throw new Error(guarded)
    const st = await deps.state()
    if ((await st.read()).installed[entry.id])
      throw new Error(tMain('mainRecomp.import.alreadyInstalled', { name: entry.name }))
    const reason = await runningReason(c, await processes())
    if (reason) throw new Error(reason)
    const target = join(root, safeRecompFolder(entry))
    if (await targetTaken(target))
      throw new Error(tMain('mainRecomp.import.targetTaken', { path: target }))

    const size = await measureTree(c.folder)
    const release = await releaseOf(entry, c)
    if (active?.signal.aborted) throw new MoveCancelled()
    checkNotBusy(entry)

    const since = Date.now()
    const journal = {
      write: (phase: JournalPhase): Promise<void> =>
        updateJournal(root, (list) => [
          ...list.filter((e) => normalizePath(e.to) !== normalizePath(target)),
          { from: c.folder, to: target, recompId: entry.id, phase, since, candidate: c }
        ])
    }
    let record: InstalledRecomp | null = null
    let checkedSpace = false
    let moved = false
    let linksNotFixed = 0
    const warn = (w: string): void => {
      if (/^link .* could not be (pointed at the new folder|replaced)/.test(w)) linksNotFixed++
      deps.log.warn(`recomp import: ${w}`)
    }
    let outcome: Awaited<ReturnType<typeof moveEmulationFolder>>
    try {
      outcome = await moveEmulationFolder(c.folder, target, {
        mode: 'move',
        since,
        signal: active?.signal,
        journal,
        warn,
        // A link that cannot be pointed at the new folder (a file link needs Developer Mode) is reported, not a
        // reason to put the whole app back.
        lenientRelink: true,
        rename: async (from, to) => {
          // Right before the folder itself moves: nothing of it started in PlayOut meanwhile.
          if (from === c.folder) checkNotBusy(entry)
          // Another drive: room for a full copy first (a rename needs none).
          try {
            await rename(from, to)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EXDEV' && !checkedSpace) {
              checkedSpace = true
              const free = await (deps.freeSpace ?? defaultFreeSpace)(root)
              if (free !== null && free < size.bytes + 512 * 1024 * 1024)
                throw new Error(
                  tMain('mainRecomp.import.noSpace', {
                    needed: formatBytes(size.bytes),
                    free: formatBytes(free)
                  }),
                  { cause: err }
                )
            }
            throw err
          }
        },
        onProgress: (tick) => progress(tick.phase, tick.bytesDone, size.bytes),
        commit: async () => {
          checkNotBusy(entry)
          record = await recordFor(entry, c, target, release)
          await st.update((m) => {
            if (m.installed[entry.id])
              throw new Error(tMain('mainRecomp.import.alreadyInstalled', { name: entry.name }))
            m.installed[entry.id] = record!
          })
          moved = true
        }
      })
    } catch (err) {
      // The folder could not go back (something made its old place again): it is recorded where it is now.
      if (err instanceof StrandedMove && !moved && (await recordStranded(entry, c, err.dir))) {
        await updateJournal(root, (list) =>
          list.filter((e) => normalizePath(e.to) !== normalizePath(err.dir))
        ).catch(() => undefined)
        scanned.delete(normalizePath(c.folder))
        const rec = (await st.read()).installed[entry.id]
        return {
          folder: c.folder,
          recompId: entry.id,
          name: entry.name,
          dir: err.dir,
          renamed: true,
          leftInOld: 0,
          linksNotFixed,
          versionKnown: !!rec?.imported?.versionKnown
        }
      }
      throw err
    }
    // Moved and recorded: nothing from here on fails the import (a failure is only warned about).
    let rewritten: string[] = []
    try {
      // The old folder's path in the app's own settings files is the new one.
      rewritten = await rewriteOldPaths(target, c.folder, target)
    } catch (err) {
      deps.log.warn(`recomp import: settings in ${target} could not be updated (${message(err)})`)
    }
    try {
      if (!outcome.cleanupUnfinished)
        await updateJournal(root, (list) =>
          list.filter((e) => normalizePath(e.to) !== normalizePath(target))
        )
    } catch (err) {
      deps.log.warn(`recomp import: the import journal could not be updated (${message(err)})`)
    }
    scanned.delete(normalizePath(c.folder))
    try {
      deps.log.info(
        `recomp import: ${c.folder} (${c.launcher}) -> ${target} as ${entry.id} at ${(record as InstalledRecomp | null)?.tag || 'an unknown version'}` +
          `${outcome.renamed ? ' (renamed)' : ' (copied)'}${outcome.leftInOld ? `, ${outcome.leftInOld} file(s) left in the old folder` : ''}` +
          `${rewritten.length ? `, ${rewritten.length} settings file(s) updated` : ''}` +
          `${linksNotFixed ? `, ${linksNotFixed} link(s) not pointed at the new folder` : ''}`
      )
      progress('done', size.bytes, size.bytes)
    } catch {
      // Only words.
    }
    return {
      folder: c.folder,
      recompId: entry.id,
      name: entry.name,
      dir: target,
      renamed: outcome.renamed,
      leftInOld: outcome.leftInOld,
      linksNotFixed,
      versionKnown: !!release
    }
  }

  /** A move's error in words for the summary. */
  function failureText(err: unknown, c: ImportCandidate | undefined): string {
    if (err instanceof StrandedMove) return tMain('mainRecomp.import.stranded', { path: err.dir })
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')
      return tMain('mainRecomp.import.inUse', {
        launcher: c ? launcherName(c.launcher) : ''
      })
    return message(err)
  }

  async function run(items: RecompImportRequest[]): Promise<RecompImportResult> {
    if (active) throw new Error(tMain('mainRecomp.import.busy'))
    active = new AbortController()
    cancelled = false
    const result: RecompImportResult = { imported: [], failed: [], notStarted: [] }
    const chosen = new Set<string>()
    try {
      // The start-up recovery first: it finishes what an earlier PlayOut left, and never touches this run's moves.
      if (recovering) await recovering.catch(() => undefined)
      const root = resolve(await deps.root())
      for (let i = 0; i < items.length; i++) {
        const req = items[i]!
        if (cancelled) {
          result.notStarted.push(req.folder)
          continue
        }
        try {
          result.imported.push(await importOne(req, i + 1, items.length, root, chosen))
        } catch (err) {
          if (err instanceof MoveCancelled) {
            result.notStarted.push(req.folder)
            continue
          }
          const c = scanned.get(normalizePath(req.folder))
          // Undone (the folder is where it was): nothing to finish at the next start.
          if (!(err instanceof StrandedMove) && !(err instanceof RollbackUnfinished))
            await updateJournal(root, (list) =>
              list.filter((e) => normalizePath(e.from) !== normalizePath(req.folder))
            ).catch(() => undefined)
          deps.log.warn(`recomp import: ${req.folder} as ${req.recompId} failed (${message(err)})`)
          result.failed.push({
            folder: req.folder,
            recompId: req.recompId,
            message: failureText(err, c)
          })
        }
      }
    } finally {
      active = null
    }
    if (result.imported.length)
      await deps
        .afterImport(result.imported.map((r) => r.recompId))
        .catch((err) => deps.log.warn(`recomp import: after the import (${message(err)})`))
    return result
  }

  /** Finishes or undoes one interrupted move; true when its journal entry can go. */
  async function recoverOne(
    e: JournalEntry,
    m: { installed: Record<string, InstalledRecomp> }
  ): Promise<boolean> {
    const exists = async (p: string): Promise<boolean> => !!(await fs.lstat(p).catch(() => null))
    const warn = (w: string): void => deps.log.warn(`recomp import: ${w}`)
    const rec = m.installed[e.recompId]
    const committed = !!rec && normalizePath(rec.dir) === normalizePath(e.to)
    if (committed) {
      // The record is written: what is still in the old folder exactly as copied goes (only after a copy).
      if (e.phase !== 'renamed' && (await exists(e.from)) && (await exists(e.to)))
        await removeCopiedTree(e.from, copiedTo(e.from, e.to, e.since))
      return true
    }
    if (e.phase === 'renamed') {
      if (!(await exists(e.to))) return true
      // Renamed, the record not written: the folder goes back. Its old place made again by the launcher (Quiver's
      // placeholder): that goes first.
      if ((await exists(e.from)) && (await onlyLauncherLeftovers(e.from))) {
        await removeTree(e.from)
        if (await exists(e.from)) throw new Error(`${e.from} could not be cleared`)
      }
      if (!(await exists(e.from))) {
        await rename(e.to, e.from)
        // Links in it that were pointed at the new place point back (strict: else the entry stays for a next try).
        await relinkTree(e.from, e.to, e.from, warn, true)
        return true
      }
      // Something else is at the old place now: the folder stays where it is and is recorded there.
      await deps.ready?.().catch(() => undefined)
      if (await recordStranded(entryOf(e.recompId), e.candidate, e.to)) return true
      warn(`${e.to} (from ${e.from}) is left in the Recompilations folder; ${e.from} is taken`)
      return false
    }
    if (e.phase === 'copying') {
      // A copy not finished: the old folder is whole; the partial copy goes.
      await removeTree(stagingDir(e.to))
      return true
    }
    if (e.phase === 'copied' || e.phase === 'rolling-back') {
      // Copied but not recorded: the old folder is whole; the copy goes.
      if ((await exists(e.from)) && (await exists(e.to))) await removeTree(e.to)
      return true
    }
    return true
  }

  async function recoverNow(): Promise<void> {
    const root = resolve(await deps.root())
    const entries = await readJournal(root)
    if (!entries.length) return
    const m = await (await deps.state()).read()
    const handled = new Set<string>()
    for (const e of entries) {
      try {
        if (await recoverOne(e, m)) {
          handled.add(journalKey(e))
          deps.log.info(`recomp import: finished the interrupted import of ${e.from} (${e.phase})`)
        }
      } catch (err) {
        deps.log.warn(`recomp import: the interrupted import of ${e.from} (${message(err)})`)
      }
    }
    // Only what was finished here goes (an entry kept is tried again at the next start).
    await updateJournal(root, (list) => list.filter((e) => !handled.has(journalKey(e))))
  }

  function recover(): Promise<void> {
    // Never beside an import (it waits for this; one already running has its own entries in the journal).
    if (active) return Promise.resolve()
    if (recovering) return recovering
    const job = recoverNow().finally(() => {
      if (recovering === job) recovering = null
    })
    recovering = job
    return job
  }

  return {
    scan,
    run,
    cancel() {
      if (!active) return
      cancelled = true
      active.abort()
    },
    running: () => active !== null,
    importing: (id) => importingIds.has(id),
    recover
  }
}
