import { promises as fs } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { Logger } from '../logger'
import { iniSectionOf, readIniSection, replaceIniSection, setIniValues } from './ini'
import { addBindings } from './presets/pad-bindings'
import type { HiddenProcess } from './presets/types'

/**
 * PCSX2's game list for the games PlayOut launches (docs/emulator-setup.md, "PCSX2's game list").
 *
 * Big Picture's "Game Properties" opens only for a game in PCSX2's game list (FullscreenUI::SwitchToGameSettings looks
 * the running disc up by path, then by serial and CRC, and does nothing without an entry). PlayOut starts PCSX2 with
 * `-batch`, and in batch mode PCSX2 only loads its game list cache (GameList::Refresh(false, true)): a game it never
 * scanned, or whose file changed since (the cached modification time must match), is not listed. So:
 * 1. the game's folder becomes a `[GameList] Paths` entry unless a Paths or RecursivePaths entry already covers it
 *    (also right before a launch: it is cheap);
 * 2. when `gamelist.cache` has no up-to-date record of the game, PCSX2 is started once without a window and without
 *    -batch (it then scans its folders), until the record is there, and asked to close (it saves and exits). The
 *    service runs that in the background ("pre-warm"): a launch never waits for it. Two settings are off for that run
 *    and put back after PCSX2 exited (PCSX2 writes the whole PCSX2.ini when it exits): Big Picture (its window would
 *    show) and the update check at startup (its dialog would). A marker file keeps the values to put back if PlayOut
 *    stops in between.
 * 3. each image a scan that ran to its end did not list gets one more attempt counted (with its size and
 *    modification time); after UNLISTED_ATTEMPTS such scans it is not scanned again until the file or PCSX2 changes,
 *    or UNLISTED_TTL_MS after its last attempt. A scan that was stopped counts nothing.
 *
 * The steady state (folder covered, record current) is read-only: no process list is taken. Whether PCSX2 runs is
 * asked only before something is written.
 */

/** How long the hidden scan may take, closing included (ensurePcsx2GameListed's default; the pre-warm's). */
export const SCAN_TIMEOUT_MS = 20_000
export const BACKGROUND_SCAN_TIMEOUT_MS = 60_000
const POLL_MS = 250
/** A poll's sleep that took this long means the PC slept (or stalled): the run stops and records nothing. */
export const SUSPEND_GAP_MS = 5_000
/** How often a running scan checks whether another PCSX2 (one the user started) runs. */
export const OTHERS_CHECK_MS = 2_000
/** A game file whose stat takes longer (an offline share, a sleeping drive) is skipped for this pass. */
export const STAT_TIMEOUT_MS = 2_000
/** Scans that ran to their end without listing an image before it is no longer scanned. */
export const UNLISTED_ATTEMPTS = 2
/** An image's attempts are forgotten this long after its last one (and all of them once PCSX2 itself changed). */
export const UNLISTED_TTL_MS = 14 * 24 * 60 * 60 * 1000
/**
 * The shorter wait for images whose last attempt ended with PCSX2 quitting by itself (it crashed on an image, or could
 * not run at all: blocked by Windows security, a missing runtime): the cause may be fixed without PCSX2 changing.
 */
export const UNLISTED_EXIT_TTL_MS = 24 * 60 * 60 * 1000
/** Left next to PCSX2 during a hidden scan: the settings to put back (JSON). */
export const RESTORE_MARKER = '.playout-scan-restore.json'
/** Images scans did not list, with their attempts (JSON), next to PCSX2. */
export const UNLISTED_FILE = '.playout-unlisted.json'
/** At most this many are remembered (the oldest go first). */
export const UNLISTED_MAX = 500

/** The files PCSX2's game list holds (GameList::IsScannableFilename: disc images and ELFs, suffix, any case). */
const SCANNABLE = ['.iso', '.bin', '.img', '.mdf', '.gz', '.cso', '.zso', '.chd', '.elf']
export const pcsx2Scannable = (rom: string): boolean =>
  SCANNABLE.some((e) => rom.toLowerCase().endsWith(e))

export interface Pcsx2GameListDeps {
  /** The PCSX2 folder PlayOut installed (portable: inis\PCSX2.ini). */
  emuDir: string
  exe: string
  /** The game's file. */
  rom: string
  log: Logger
  startHidden(file: string, args: string[], options: { cwd: string }): HiddenProcess
  /**
   * Whether a PCSX2 process is running. Asked only before a write (two instances would share the files, and a running
   * one writes its own settings over them when it exits); nothing is written while one runs.
   */
  isRunning(): Promise<boolean>
  /** false (a launch): never scan; the folder is still added, and 'pending' says a scan is needed. Default true. */
  scan?: boolean
  /** Asked while the hidden scan runs: true closes it (settings put back), with the result 'aborted'. */
  shouldStop?: () => boolean
  /**
   * Whether a PCSX2 process other than `exceptPid` (the hidden one) runs. Asked about every OTHERS_CHECK_MS while the
   * hidden scan runs: one the user started stops the scan (both would write the same files).
   */
  othersRunning?: (exceptPid?: number) => Promise<boolean>
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /** A monotonic clock in ms (default performance.now). */
  now?: () => number
  /** The wall clock, for the age of remembered unlisted images (default Date.now). */
  wallNow?: () => number
  /** A game file's size and modification time (tests); bounded by statTimeoutMs. */
  stat?: (file: string) => Promise<FileStamp | null>
  statTimeoutMs?: number
}

/**
 * What a game list step did: 'listed' (a current record), 'scanned' (now listed), 'pending' (a scan is needed, not
 * run), 'unlisted' (UNLISTED_ATTEMPTS earlier scans did not list it), 'timeout' (scanned, not listed), 'aborted' (the scan
 * was stopped), 'skipped' (a file PCSX2 never lists, no settings yet, PCSX2 running, or an error).
 */
export type GameListResult =
  'listed' | 'scanned' | 'pending' | 'unlisted' | 'timeout' | 'aborted' | 'skipped'

/** A path as PCSX2 may have written it, for comparing: one backslash per separator, no trailing one, any case. */
const canon = (p: string): string =>
  p
    .replace(/[\\/]+/g, '\\')
    .replace(/\\$/, '')
    .toLowerCase()
const norm = (p: string): string => canon(resolve(p))

/** Every value of a repeated key in a section (PCSX2 reads repeated keys as a list). */
function values(lines: string[] | null, key: string): string[] {
  const out: string[] = []
  for (const line of lines ?? []) {
    const m = /^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && m[1].toLowerCase() === key.toLowerCase() && m[2] !== '') out.push(m[2])
  }
  return out
}

/** Whether `folder` is one of `paths`, or inside one of `recursive`. */
export function folderCovered(folder: string, paths: string[], recursive: string[]): boolean {
  const f = norm(folder)
  if (paths.some((p) => norm(p) === f)) return true
  return recursive.some((r) => {
    const root = norm(r)
    return f === root || f.startsWith(`${root}\\`)
  })
}

/**
 * The modification time (Unix seconds) of the cache's newest record of `rom`, or null. The cache (PCSX2 2.8.2
 * GameList.cpp WriteEntryToCache) is u32 signature, u32 version, then per record five strings (u32 length + UTF-8:
 * path, serial, title, title_sort, title_en), u8 type, u8 region, u64 size, u64 modification time, u32 CRC,
 * u8 compatibility. A later record of a path replaces an earlier one, as PCSX2 reads it.
 */
export function cachedModified(cache: Buffer | null, rom: string): number | null {
  return cachedRecord(cache, rom)?.modified ?? null
}

/** What the cache's newest record of a game holds that PlayOut uses. */
export interface CachedGame {
  /** Modification time of the file when PCSX2 scanned it (Unix seconds). */
  modified: number
  /** The disc's serial ("SLUS-21282"; empty for an ELF). */
  serial: string
  /** The boot ELF's CRC. */
  crc: number
}

/** Every record of the cache (layout above) by compared path; the newest record of a path wins. */
export function cachedRecords(cache: Buffer | null): Map<string, CachedGame> {
  const found = new Map<string, CachedGame>()
  if (!cache || cache.length < 8) return found
  let off = 8
  try {
    while (off < cache.length) {
      let path = ''
      let serial = ''
      for (let i = 0; i < 5; i++) {
        const len = cache.readUInt32LE(off)
        off += 4
        if (off + len > cache.length) return found
        if (i === 0) path = cache.toString('utf8', off, off + len)
        if (i === 1) serial = cache.toString('utf8', off, off + len)
        off += len
      }
      off += 2 + 8
      if (off + 8 + 4 + 1 > cache.length) return found
      const modified = Number(cache.readBigUInt64LE(off))
      const crc = cache.readUInt32LE(off + 8)
      off += 8 + 4 + 1
      found.set(canon(path), { modified, serial, crc })
    }
  } catch {
    // A record cut short (PCSX2 still writing): what was read so far stands.
  }
  return found
}

/** The cache's newest record of `rom` (layout above), or null. */
export function cachedRecord(cache: Buffer | null, rom: string): CachedGame | null {
  return cachedRecords(cache).get(norm(rom)) ?? null
}

/** The cache file named by PCSX2.ini's `[Folders]` (`Cache`, relative to PCSX2's folder unless absolute). */
function cacheFileOf(emuDir: string, folders: string[] | null): string {
  const cacheDir = values(folders, 'Cache')[0] ?? 'cache'
  return join(isAbsolute(cacheDir) ? cacheDir : join(emuDir, cacheDir), 'gamelist.cache')
}

/** PCSX2's game list cache file (`[Folders] Cache`, relative to PCSX2's folder unless absolute). */
export async function pcsx2CacheFile(emuDir: string): Promise<string> {
  return cacheFileOf(emuDir, await readIniSection(join(emuDir, 'inis', 'PCSX2.ini'), 'Folders'))
}

/** A file's modification time as PCSX2 caches it (whole seconds, ConvertFileTimeToUnixTime), and its size. */
export interface FileStamp {
  modified: number
  size: number
}

async function stampOf(file: string): Promise<FileStamp | null> {
  try {
    const st = await fs.stat(file)
    return { modified: Math.floor(st.mtimeMs / 1000), size: st.size }
  } catch {
    return null
  }
}

/** stampOf bounded in time: 'slow' when it takes longer than `ms`. */
async function stampWithin(
  stat: (file: string) => Promise<FileStamp | null>,
  file: string,
  ms: number
): Promise<FileStamp | null | 'slow'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<'slow'>((r) => (timer = setTimeout(() => r('slow'), ms)))
  try {
    return await Promise.race([stat(file).catch(() => null), slow])
  } finally {
    clearTimeout(timer)
  }
}

function sameStamp(a: FileStamp | null | undefined, b: FileStamp | null): boolean {
  if (!a || !b) return !a && !b
  return a.modified === b.modified && a.size === b.size
}

/** Whether the cache has a record of `rom` PCSX2 will use in batch mode: same file, same modification time. */
export async function cacheIsCurrent(cache: Buffer | null, rom: string): Promise<boolean> {
  const modified = cachedModified(cache, rom)
  if (modified === null) return false
  return (await stampOf(rom))?.modified === modified
}

async function readFileOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file)
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

// --- images PCSX2 does not list ------------------------------------------------------------------------------------

interface UnlistedImage {
  /** The compared full path. */
  path: string
  modified: number
  size: number
  /** Scans that ran to their end without listing this very file. */
  attempts: number
  /** The last of them (wall clock, ms). */
  at: number
  /** That last attempt ended with PCSX2 quitting by itself: kept UNLISTED_EXIT_TTL_MS, not UNLISTED_TTL_MS. */
  exited?: boolean
}

/** The file: the PCSX2 executable the scans ran with (an update may read the images), and the images. */
interface UnlistedFile {
  exe: FileStamp | null
  images: UnlistedImage[]
}

/**
 * The entries still valid: last attempt less than UNLISTED_TTL_MS ago, by the same PCSX2 executable (same size and
 * modification time; a PCSX2 update forgets them all).
 */
async function readUnlisted(
  emuDir: string,
  exe: FileStamp | null,
  wallNow: number
): Promise<UnlistedImage[]> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(join(emuDir, UNLISTED_FILE), 'utf8')
    ) as Partial<UnlistedFile> | null
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.images)) return []
    if (!sameStamp(parsed.exe, exe)) return []
    return parsed.images.filter(
      (e): e is UnlistedImage =>
        !!e &&
        typeof e.path === 'string' &&
        typeof e.modified === 'number' &&
        typeof e.size === 'number' &&
        typeof e.attempts === 'number' &&
        typeof e.at === 'number' &&
        Math.abs(wallNow - e.at) < (e.exited ? UNLISTED_EXIT_TTL_MS : UNLISTED_TTL_MS)
    )
  } catch {
    return []
  }
}

/** The entry of this very file (same path, size and modification time), if any. */
function entryOf(
  list: UnlistedImage[],
  rom: string,
  stamp: FileStamp | null
): UnlistedImage | undefined {
  if (!stamp) return undefined
  const path = norm(rom)
  return list.find((e) => e.path === path && e.modified === stamp.modified && e.size === stamp.size)
}

/** Whether UNLISTED_ATTEMPTS scans did not list this very file: it is not scanned again. */
const knownUnlisted = (list: UnlistedImage[], rom: string, stamp: FileStamp | null): boolean =>
  (entryOf(list, rom, stamp)?.attempts ?? 0) >= UNLISTED_ATTEMPTS

/**
 * After a scan that ran to its end (not stopped): one more attempt for each game it did not list (a changed file starts
 * again at one), and the listed ones forgotten. Keeps the newest UNLISTED_MAX. Returns the games now given up on.
 */
async function recordAttempts(
  emuDir: string,
  exe: FileStamp | null,
  missing: Look[],
  listed: Look[],
  wallNow: number,
  log: Logger,
  exited = false
): Promise<Look[]> {
  const before = await readUnlisted(emuDir, exe, wallNow)
  const fresh: UnlistedImage[] = []
  const givenUp: Look[] = []
  for (const l of missing) {
    if (!l.stamp) continue
    const attempts = (entryOf(before, l.rom, l.stamp)?.attempts ?? 0) + 1
    fresh.push({
      path: norm(l.rom),
      ...l.stamp,
      attempts,
      at: wallNow,
      ...(exited ? { exited } : {})
    })
    if (attempts >= UNLISTED_ATTEMPTS) givenUp.push(l)
  }
  const drop = new Set([...missing, ...listed].map((l) => norm(l.rom)))
  const kept = before.filter((e) => !drop.has(e.path))
  if (!fresh.length && kept.length === before.length) return givenUp
  const file: UnlistedFile = { exe, images: [...kept, ...fresh].slice(-UNLISTED_MAX) }
  try {
    await fs.writeFile(join(emuDir, UNLISTED_FILE), JSON.stringify(file))
  } catch (err) {
    log.warn(`PCSX2: the list of unlisted images could not be saved: ${(err as Error).message}`)
  }
  return givenUp
}

// --- settings of the hidden scan -----------------------------------------------------------------------------------

interface RestoreRecord {
  /** StartBigPictureMode was on. */
  bigPicture: boolean
  /** [AutoUpdater] CheckAtStartup before the run (null: absent, PCSX2's default true). */
  checkAtStartup: string | null
}

async function putBack(ini: string, record: RestoreRecord): Promise<void> {
  if (record.bigPicture) await setIniValues(ini, 'UI', { StartBigPictureMode: 'true' })
  await setIniValues(ini, 'AutoUpdater', { CheckAtStartup: record.checkAtStartup ?? 'true' })
}

/**
 * Puts back the settings of a hidden scan PlayOut could not finish (the marker is still there). Call only while no
 * PCSX2 runs: a running one would write its own values over them when it exits.
 */
export async function restoreAfterScan(emuDir: string, log: Logger): Promise<void> {
  const marker = join(emuDir, RESTORE_MARKER)
  let record: RestoreRecord
  try {
    record = JSON.parse(await fs.readFile(marker, 'utf8')) as RestoreRecord
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    record = { bigPicture: true, checkAtStartup: null }
  }
  await putBack(join(emuDir, 'inis', 'PCSX2.ini'), record)
  await fs.rm(marker, { force: true })
  log.info('PCSX2: settings put back after an unfinished game list scan')
}

/** Whether a hidden scan's settings still wait to be put back (its marker is there). */
export const pcsx2RestorePending = (emuDir: string): Promise<boolean> =>
  exists(join(emuDir, RESTORE_MARKER))

// --- the step --------------------------------------------------------------------------------------------------

/** One game as the read-only checks found it. */
interface Look {
  rom: string
  folder: string
  stamp: FileStamp | null
  current: boolean
  unlisted: boolean
}

/** What the read-only checks read once: PCSX2.ini, the parsed cache, the unlisted images. */
interface State {
  ini: string
  gameList: string[] | null
  cacheFile: string
  records: Map<string, CachedGame>
  unlisted: UnlistedImage[]
  /** The PCSX2 executable's stamp (the unlisted images are valid for it only). */
  exe: FileStamp | null
}

async function readState(emuDir: string, exe: string, wallNow: number): Promise<State | null> {
  const ini = join(emuDir, 'inis', 'PCSX2.ini')
  let text: string
  try {
    text = await fs.readFile(ini, 'utf8')
  } catch {
    return null
  }
  const cacheFile = cacheFileOf(emuDir, iniSectionOf(text, 'Folders'))
  const exeStamp = await stampOf(exe)
  return {
    ini,
    gameList: iniSectionOf(text, 'GameList'),
    cacheFile,
    records: cachedRecords(await readFileOrNull(cacheFile)),
    unlisted: await readUnlisted(emuDir, exeStamp, wallNow),
    exe: exeStamp
  }
}

/**
 * A game PCSX2 can list (scannable, not excluded) as it stands; null for one it never lists, and for one whose file
 * did not answer within `statMs` (skipped for this pass).
 */
async function look(
  state: State,
  file: string,
  stat: (file: string) => Promise<FileStamp | null>,
  statMs: number,
  log: Logger
): Promise<Look | null> {
  const rom = resolve(file)
  if (!pcsx2Scannable(rom)) return null
  // PCSX2 skips files under an excluded path (a plain, case-sensitive prefix, GameList.cpp IsPathExcluded).
  if (values(state.gameList, 'ExcludedPaths').some((e) => rom.startsWith(e))) return null
  const stamp = await stampWithin(stat, rom, statMs)
  if (stamp === 'slow') {
    log.info(`PCSX2: ${rom} did not answer within ${statMs} ms; skipped for now`)
    return null
  }
  const current = !!stamp && state.records.get(norm(rom))?.modified === stamp.modified
  return {
    rom,
    folder: dirname(rom),
    stamp,
    current,
    unlisted: !current && knownUnlisted(state.unlisted, rom, stamp)
  }
}

/** The games' folders no Paths or RecursivePaths entry covers yet (each once). */
function missingFolders(state: State, looks: Look[]): string[] {
  const out: string[] = []
  for (const l of looks) {
    if (out.some((f) => norm(f) === norm(l.folder))) continue
    const list = state.gameList
    if (!folderCovered(l.folder, values(list, 'Paths'), values(list, 'RecursivePaths')))
      out.push(l.folder)
  }
  return out
}

type ReadDeps = Pick<
  Pcsx2GameListDeps,
  'emuDir' | 'exe' | 'log' | 'shouldStop' | 'wallNow' | 'stat' | 'statTimeoutMs'
> & { roms: string[] }

/** The read-only phase: the state and each game's look; 'aborted' when shouldStop said so between two games. */
async function readLooks(
  deps: ReadDeps
): Promise<{ state: State; looks: Look[] } | null | 'aborted'> {
  const state = await readState(deps.emuDir, deps.exe, (deps.wallNow ?? Date.now)())
  if (!state) return null
  const looks: Look[] = []
  for (const rom of deps.roms) {
    if (deps.shouldStop?.()) return 'aborted'
    const l = await look(
      state,
      rom,
      deps.stat ?? stampOf,
      deps.statTimeoutMs ?? STAT_TIMEOUT_MS,
      deps.log
    )
    if (l) looks.push(l)
  }
  return { state, looks }
}

/**
 * The read-only part of listPcsx2Games for the background pre-warm, run outside the step chain (a launch never waits
 * for it): of `roms`, the ones that need a write (their folder is not in the game list) or a scan. 'aborted' when
 * shouldStop said so between two games. Never throws (an error: none).
 */
export async function pcsx2GamesNeedingWork(deps: ReadDeps): Promise<string[] | 'aborted'> {
  try {
    const read = await readLooks(deps)
    if (read === 'aborted') return 'aborted'
    if (!read) return []
    const folders = new Set(missingFolders(read.state, read.looks).map(norm))
    return read.looks
      .filter((l) => (!l.current && !l.unlisted && l.stamp) || folders.has(norm(l.folder)))
      .map((l) => l.rom)
  } catch (err) {
    deps.log.warn(`PCSX2: game list check failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * Makes sure PCSX2 lists the game (see above): read-only while it does; adds its folder when needed; with `scan` (the
 * default) runs the hidden scan when the record is missing or stale. Never throws; returns what it did.
 */
export async function ensurePcsx2GameListed(deps: Pcsx2GameListDeps): Promise<GameListResult> {
  const { rom, ...rest } = deps
  return listPcsx2Games({ ...rest, roms: [rom] })
}

const STOP_REASON = {
  asked: '',
  other: ' (another PCSX2 started)',
  suspend: ' (the PC slept or stalled)'
} as const

/**
 * The step for several games at once (the pre-warm passes one batch: one hidden scan lists them all). For several
 * games the result is 'listed' when every one is, else 'pending' / 'unlisted' / the scan's.
 */
export async function listPcsx2Games(
  deps: Omit<Pcsx2GameListDeps, 'rom'> & { roms: string[] }
): Promise<GameListResult> {
  const { emuDir, log } = deps
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now ?? ((): number => performance.now())
  const marker = join(emuDir, RESTORE_MARKER)
  let proc: HiddenProcess | undefined
  try {
    // An unfinished scan's settings go back first (only while PCSX2 is closed: it writes them when it exits).
    if (await exists(marker)) {
      if (await deps.isRunning()) return 'skipped'
      await restoreAfterScan(emuDir, log)
    }
    // No settings yet: nothing to do.
    const read = await readLooks(deps)
    if (read === 'aborted') return 'aborted'
    if (!read) return 'skipped'
    const { state, looks } = read
    // Only files PCSX2 never lists (an .m3u, a .dump), excluded ones, or ones that did not answer.
    if (!looks.length) return 'skipped'
    const folders = missingFolders(state, looks)
    const toScan = looks.filter((l) => !l.current && !l.unlisted && l.stamp)
    const scan = deps.scan !== false && toScan.length > 0
    const summary = (): GameListResult =>
      looks.every((l) => l.current) ? 'listed' : toScan.length ? 'pending' : 'unlisted'
    // The steady state: nothing to write, so no process list either.
    if (!folders.length && !scan) return summary()

    if (await deps.isRunning()) return 'skipped'
    if (folders.length) {
      let list = state.gameList ?? []
      for (const folder of folders) list = addBindings(list, [['Paths', folder]])
      await replaceIniSection(state.ini, 'GameList', list)
      log.info(`PCSX2: added ${folders.join(', ')} to the game list folders`)
    }
    if (!scan) return summary()
    if (deps.shouldStop?.()) return 'aborted'

    // Hidden scan, with Big Picture (its own window) and the update check (its dialog) off for this run.
    const ini = state.ini
    const ui = await readIniSection(ini, 'UI')
    const updater = await readIniSection(ini, 'AutoUpdater')
    const record: RestoreRecord = {
      bigPicture: /^(true|1)$/i.test(values(ui, 'StartBigPictureMode')[0] ?? ''),
      checkAtStartup: values(updater, 'CheckAtStartup')[0] ?? null
    }
    await fs.writeFile(marker, JSON.stringify(record))
    if (record.bigPicture) await setIniValues(ini, 'UI', { StartBigPictureMode: 'false' })
    await setIniValues(ini, 'AutoUpdater', { CheckAtStartup: 'false' })

    const listedIn = (records: Map<string, CachedGame>): Look[] =>
      toScan.filter((l) => records.get(norm(l.rom))?.modified === l.stamp?.modified)
    const deadline = now() + (deps.timeoutMs ?? SCAN_TIMEOUT_MS)
    const started = deps.startHidden(deps.exe, [], { cwd: emuDir })
    proc = started
    let ended = false
    let endedAt = 0
    void started.exited.then(() => {
      ended = true
      endedAt = now()
    })
    /** Why the scan stopped early: asked (a launch, setup, quitting), another PCSX2, or the PC slept. */
    let stop: keyof typeof STOP_REASON | null = null
    let othersCheckedAt = now()
    // The closing below gets up to 10 s of its own; the scan uses what is left of the budget (at least 2 s).
    const scanFrom = now()
    const scanUntil = Math.max(deadline - 10_000, scanFrom + 2_000)
    // Runs to the time limit unless every game got listed (or PCSX2 exited by itself). Whether PCSX2 went through every
    // file cannot be told from outside, so the attempt counter (recordAttempts) decides what is not scanned again.
    while (!ended && now() < scanUntil) {
      if (deps.shouldStop?.()) {
        stop = 'asked'
        break
      }
      const before = now()
      await sleep(POLL_MS)
      // A sleep far longer than asked: the PC was suspended (or everything stalled). The run counts nothing.
      if (now() - before > SUSPEND_GAP_MS) {
        stop = 'suspend'
        break
      }
      const cache = await readFileOrNull(state.cacheFile)
      if (listedIn(cachedRecords(cache)).length === toScan.length) break
      if (deps.othersRunning && now() - othersCheckedAt >= OTHERS_CHECK_MS) {
        othersCheckedAt = now()
        if (await deps.othersRunning(started.pid)) {
          stop = 'other'
          break
        }
      }
    }
    // Whether PCSX2 quit by itself, read before the close below (which ends it too).
    const quitByItself = ended
    await (started.close ?? started.stop).call(started)
    proc = undefined
    // Another PCSX2 (one the user started) writes its own PCSX2.ini when it exits: the settings go back once it is
    // closed (the marker stays; restoreAfterScan runs at the next pass, launch or start while no PCSX2 runs, or at the
    // service's follow-up check). Nothing is counted.
    if (await deps.isRunning()) {
      log.info(
        'PCSX2: another PCSX2 runs; the game list scan settings are put back once it is closed'
      )
      return 'aborted'
    }
    await putBack(ini, record)
    await fs.rm(marker, { force: true })
    const listed = listedIn(cachedRecords(await readFileOrNull(state.cacheFile)))
    const missing = toScan.filter((l) => !listed.includes(l))
    const names = (ls: Look[]): string => ls.map((l) => l.rom).join(', ')
    // A stopped run proves nothing about the games it did not reach: nothing is counted.
    if (stop && missing.length) {
      log.info(
        `PCSX2: game list scan stopped before it listed ${names(missing)}${STOP_REASON[stop]}`
      )
      return 'aborted'
    }
    // Still listing games of this batch when time ran out (or PCSX2 quit): the rest may simply not be reached yet (a
    // large or slow library). Only a run that listed none of the batch counts an attempt for its games. A PCSX2 that
    // quit by itself and listed nothing (it crashed on an image, or could not run: blocked by Windows security, a
    // missing runtime) counts too, so it is not started again after every session, but those games are tried again
    // after a day (UNLISTED_EXIT_TTL_MS), not 14: the cause may be fixed without PCSX2 changing.
    const counted = listed.length ? [] : missing
    if (quitByItself && missing.length && !listed.length)
      log.warn(
        `PCSX2: the hidden game list scan quit by itself after ${Math.round((endedAt - scanFrom) / 1000)} s without listing ${names(missing)}`
      )
    const wallNow = (deps.wallNow ?? Date.now)()
    const givenUp = await recordAttempts(
      emuDir,
      state.exe,
      counted,
      listed,
      wallNow,
      log,
      quitByItself
    )
    if (!missing.length) {
      log.info(`PCSX2: scanned its game list for ${names(toScan)}`)
      return 'scanned'
    }
    log.info(
      `PCSX2: the game list scan did not list ${names(missing)}${givenUp.length ? `; not scanned again until the file or PCSX2 changes: ${names(givenUp)}` : ''}`
    )
    return 'timeout'
  } catch (err) {
    log.warn(`PCSX2: game list step failed: ${(err as Error).message}`)
    try {
      // Never left running hidden.
      if (proc) await proc.stop()
      if (!(await deps.isRunning())) await restoreAfterScan(emuDir, log)
    } catch {
      /* put back before the next launch or at the next start */
    }
    return 'skipped'
  }
}
