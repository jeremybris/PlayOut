import { constants as fsConstants, promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { ConvertRequest, ConvertStatus } from '../../shared/convert'
import type { Game } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import type { ConvertService } from './convert-service'
import { m3uFiles, sourceFiles } from './sources'
import {
  PARTIAL_MARKER,
  xboxImageInfo,
  type HelperRun,
  type XboxImageInfo,
  type XboxImageRejected
} from './xbox-helper'
import { isHeldDirName } from '../services/held-files'
import { tMain } from '../i18n'

/**
 * Trim Games (Settings › Library): every ROM game new to the library is converted to its smaller format through
 * Settings › Convert's runs, one direction at a time. PS2 ISO → CHD, Xbox and Xbox 360 full dumps → XISO (PlayOut's Xbox helper), PlayStation CUE/BIN → CHD,
 * PSP ISO → CSO, PS3 disc folder → ISO, Wii and GameCube ISO → RVZ. The convert service verifies each result before
 * the original goes to the Recycle Bin and moves the game's library record to the new file.
 */

/** One game's conversion: the Convert direction (forward) and the files it takes. */
export interface TrimPlan {
  platformId: string
  pairId: string
  paths: string[]
}

/**
 * A plan, a reason the game stays as it is (logged), a reason to look again later (the Xbox helper failed on the
 * image for a passing reason: an I/O error), or null when there is nothing to trim (already small).
 */
export type TrimPlanResult = TrimPlan | { skip: string } | { retry: string } | null

/** The Convert direction per ROM system. */
export const TRIM_PAIRS: Readonly<Record<string, string>> = {
  ps2: 'ps2-iso-chd',
  xbox: 'xbox-iso-xiso',
  xbox360: 'x360-iso-xiso',
  psx: 'psx-cue-chd',
  psp: 'psp-iso-cso',
  ps3: 'ps3-folder-iso',
  wii: 'wii-iso-rvz',
  gc: 'gc-iso-rvz'
}

/** XDVDFS's volume descriptor: at 0x10000 of a trimmed XISO (a full dump has it after its video partition). */
const XDVDFS_MAGIC = 'MICROSOFT*XBOX*MEDIA'
const XDVDFS_OFFSET = 0x10000

async function statSafe(path: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

/** The Xbox image is already a trimmed XISO (named so, or its file system starts at 0x10000). */
export async function isXiso(path: string): Promise<boolean> {
  if (basename(path).toLowerCase().endsWith('.xiso.iso')) return true
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(path, 'r')
    const buf = Buffer.alloc(XDVDFS_MAGIC.length)
    const { bytesRead } = await handle.read(buf, 0, buf.length, XDVDFS_OFFSET)
    return bytesRead === buf.length && buf.toString('latin1') === XDVDFS_MAGIC
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** A path inside a PS3 HDD (updates, DLC and PSN games): never a disc. */
function inPs3Hdd(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .some((s) => s === 'updates and dlc' || s === 'dev_hdd0' || s === 'ps3 hdd')
}

/** The Xbox helper ran but failed on the image for a reason that may pass (an I/O error, the file locked): why. */
export interface XboxImageFailed {
  failed: string
}

/**
 * What the Xbox helper's `info` says about an image: `{ rejected }` when it refused the image, `{ failed }` when it
 * failed for another reason (looked at again later, never remembered), null when it cannot tell (helper missing or
 * not starting: then the file itself is looked at).
 */
export type XboxInfo = (
  path: string
) => Promise<XboxImageInfo | XboxImageRejected | XboxImageFailed | null>

/**
 * Trim Games' look at Xbox images through the helper at `exe`. A helper that does not answer in `timeoutMs`
 * (xboxImageInfo's own limit when left out) is a failure: the image is looked at again later, not trimmed blind.
 */
export function helperXboxInfo(exe: string, run?: HelperRun, timeoutMs?: number): XboxInfo {
  return async (path) => {
    let failed: string | undefined
    const info = await xboxImageInfo(exe, path, run, (message) => (failed = message), timeoutMs)
    return info ?? (failed !== undefined ? { failed } : null)
  }
}

/** Look at Xbox images later: the plan is made from the path alone (after the settle checks, it is made again). */
export const XBOX_LATER = 'later' as const

/** An Xbox or Xbox 360 ISO: trimmed unless it is an optimized XISO already. */
async function planXbox(
  path: string,
  platformId: 'xbox' | 'xbox360',
  plan: TrimPlan,
  xboxInfo?: XboxInfo | typeof XBOX_LATER
): Promise<TrimPlanResult> {
  if (xboxInfo === XBOX_LATER) return plan
  const info = xboxInfo ? await xboxInfo(path).catch(() => null) : null
  if (info && 'rejected' in info) return { skip: `${basename(path)}: ${info.rejected}` }
  if (info && 'failed' in info) return { retry: `${basename(path)}: ${info.failed}` }
  if (!info) return (await isXiso(path)) ? null : plan
  if (info.optimized) return null
  if (info.format !== 'redump' && info.format !== 'xiso')
    return {
      skip: tMain('mainConvert.trim.notDiscImage', { file: basename(path), format: info.format })
    }
  if (info.platform && info.platform !== platformId)
    return {
      skip: tMain('mainConvert.trim.wrongPlatform', {
        file: basename(path),
        platform: info.platform === 'xbox' ? 'Xbox' : 'Xbox 360'
      })
    }
  return plan
}

/** What Trim Games does with a ROM game: from its system and its file (or folder). */
export async function planTrim(
  game: Pick<Game, 'source' | 'platformId' | 'romPath'>,
  xboxInfo?: XboxInfo | typeof XBOX_LATER
): Promise<TrimPlanResult> {
  if (game.source !== 'rom' || !game.romPath) return null
  // An unfinished conversion of the Xbox helper (removed when PlayOut starts), never a game.
  if (game.romPath.toLowerCase().includes(PARTIAL_MARKER)) return null
  const platformId = game.platformId
  const pairId = TRIM_PAIRS[platformId]
  if (!pairId) return null
  const path = game.romPath
  const ext = extname(path).toLowerCase()
  const plan = (paths: string[]): TrimPlan => ({ platformId, pairId, paths })
  switch (platformId) {
    case 'ps2':
    case 'psp':
      return ext === '.iso' ? plan([path]) : null
    case 'xbox':
    case 'xbox360':
      return ext === '.iso' ? planXbox(path, platformId, plan([path]), xboxInfo) : null
    case 'wii':
    case 'gc':
      return ext === '.iso' || ext === '.gcm' ? plan([path]) : null
    case 'ps3': {
      if (inPs3Hdd(path)) return null
      if (!(await statSafe(path))?.isDirectory()) return null
      // A disc game (JB folder) holds PS3_GAME; a PSN or HDD game (USRDIR at its top) stays a folder.
      return (await statSafe(join(path, 'PS3_GAME')))?.isDirectory() ? plan([path]) : null
    }
    case 'psx': {
      if (ext === '.cue') return plan([path])
      if (ext === '.bin') {
        const cue = join(dirname(path), `${basename(path, extname(path))}.cue`)
        if ((await statSafe(cue))?.isFile()) return plan([cue])
        return { skip: tMain('mainConvert.trim.noCue', { file: basename(path) }) }
      }
      if (ext === '.m3u') {
        const text = await fs.readFile(path, 'utf8').catch(() => '')
        const cues: string[] = []
        for (const disc of m3uFiles(text, dirname(path)))
          if (extname(disc).toLowerCase() === '.cue' && (await statSafe(disc))?.isFile())
            cues.push(disc)
        // Discs that are CHDs already need nothing; BIN-only discs cannot go.
        return cues.length ? plan(cues) : null
      }
      return null
    }
    default:
      return null
  }
}

/** Files a fingerprint or an in-use look reads at most per plan file: a huge PS3 folder is not walked to its end. */
const WALK_CAP = 20_000

/** Every file of a path: itself, or what a folder holds (capped walk, in readdir order). */
async function walkFiles(path: string, budget = { files: WALK_CAP }): Promise<string[]> {
  const stat = await statSafe(path)
  if (!stat) return []
  if (!stat.isDirectory()) return [path]
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (budget.files-- <= 0) break
    const child = join(path, e.name)
    // A disc image moved aside while its recompilation is tested (services/held-files.ts) is never trimmed.
    if (e.isDirectory() && isHeldDirName(e.name)) continue
    if (e.isDirectory()) out.push(...(await walkFiles(child, budget)))
    else out.push(child)
  }
  return out
}

/** Size and modification time of a file, or of everything inside a folder (capped walk). */
async function fingerprintOf(path: string, budget = { files: WALK_CAP }): Promise<string> {
  const stat = await statSafe(path)
  if (!stat) return 'gone'
  if (!stat.isDirectory()) return `${stat.size}:${stat.mtimeMs}`
  let entries: import('fs').Dirent[] = []
  try {
    entries = await fs.readdir(path, { withFileTypes: true })
  } catch {
    /* unreadable: its own stamp only */
  }
  const parts = [String(stat.mtimeMs)]
  for (const e of entries) {
    if (budget.files-- <= 0) break
    parts.push(`${e.name}=${await fingerprintOf(join(path, e.name), budget)}`)
  }
  return parts.join('|')
}

/**
 * libuv's exclusive-open flag (Windows: share mode 0, so opening fails while any other handle to the file is open).
 * Node does not list it in fs.constants on Windows, so libuv's own value (uv/win.h) stands in.
 */
const EXLOCK =
  (fsConstants as { UV_FS_O_EXLOCK?: number }).UV_FS_O_EXLOCK ??
  (process.platform === 'win32' ? 0x10000000 : undefined)

/**
 * Another program has the file open (a copy into the ROM folder still going, an emulator playing it). On Windows an
 * exclusive open fails while any other handle exists; elsewhere a read-write open refused as busy is the sign.
 */
export async function fileInUse(path: string): Promise<boolean> {
  if (!(await statSafe(path))?.isFile()) return false
  const exclusive = process.platform === 'win32' && EXLOCK !== undefined && EXLOCK !== 0
  try {
    const handle = await fs.open(path, exclusive ? fsConstants.O_RDONLY | EXLOCK! : 'r+')
    await handle.close()
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return exclusive ? code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' : code === 'EBUSY'
  }
}

/** Whether any of these paths (files, or every file of a folder) is open elsewhere. */
async function anyInUse(
  paths: string[],
  check: (file: string) => Promise<boolean>
): Promise<boolean> {
  for (const p of paths) for (const f of await walkFiles(p)) if (await check(f)) return true
  return false
}

/** The files a plan converts, as far as they exist (a .cue's BINs, a playlist's discs; a folder itself). */
async function planFiles(plan: TrimPlan): Promise<string[]> {
  const out: string[] = []
  for (const p of plan.paths) out.push(...(await sourceFiles(p).catch(() => [p])))
  return out
}

async function fingerprintFiles(files: string[]): Promise<string> {
  return (await Promise.all(files.map((f) => fingerprintOf(f)))).join('\n')
}

/** A start() refusal that names one of these paths ("Game.iso is not a PS2 ISO file."): about a game, not the run. */
function aboutAPath(message: string, paths: string[]): boolean {
  return paths.some((p) => message.startsWith(`${basename(p)} is not `))
}

/** Times a game is put back after start() failed for a reason not its own, before it is skipped. */
const MAX_RUN_FAILURES = 3

/**
 * Games per Convert run at most: between runs every gate is looked at again (a game started, a file opened, a ROM
 * download began), so switching Trim Games on with a large library does not hold one run for hours.
 */
const MAX_BATCH = 3

/** Entries the remembered lists (results, host downloads) keep at most: the newest ones. */
const MEMORY_CAP = 5000

/** What Trim Games remembers across restarts (`<userData>\trim-games.json`). */
interface TrimMemory {
  /** Every Convert result (lower case paths): never trimmed back. */
  outputs: string[]
  /** Games downloaded from a paired PC: their ids, and their files (lower case). */
  hostGames: string[]
  hostPaths: string[]
}

export interface AutoTrimDeps {
  enabled: () => boolean
  library: { games(): Game[] }
  convert: Pick<ConvertService, 'start' | 'status' | 'check'>
  /** Why converting has to wait now (a game is running, a ROM is downloading from another PC), or null. */
  waitReason: () => string | null
  events: Pick<EventBus, 'emit'>
  log: Logger
  /**
   * A game's files must stay unchanged (size and time) this long after it was first looked at, and none may be open
   * elsewhere, before it is converted: a game still being copied in waits (default 2 minutes; tests 0).
   */
  settleMs?: number
  /** How often a waiting queue looks again (default 5 s). */
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Tests: whether a file is open elsewhere (default: an exclusive open on Windows). */
  inUse?: (file: string) => Promise<boolean>
  /** The Xbox helper's look at an Xbox / Xbox 360 image (already trimmed?); without it the file's header is read. */
  xboxInfo?: XboxInfo
  /**
   * Where what must never be trimmed is remembered across restarts (Convert's results, host downloads): a small JSON
   * file. Without it (tests) they are remembered while PlayOut runs.
   */
  stateFile?: string
  /** Games per Convert run at most (default 3). */
  maxBatch?: number
}

export interface AutoTrimService {
  /** Games new to the library (ids from a scan): planned and converted when Trim Games is on. */
  add(gameIds: string[]): void
  /**
   * Trim Games was just switched on: every ROM game already in the library is looked at once (the same gates as a
   * new game). Called only on that switch, never at start-up.
   */
  checkLibrary(): void
  /** Every Convert run's status (Settings › Convert's own runs too): what they made is never trimmed back. */
  noteConvertStatus(status: ConvertStatus): void
  /** A game downloaded from a paired PC: left as it is (the host's file name is how the two PCs know it). */
  markHostDownload(gameId: string): void
  /** Tests: resolves once the queue is empty, nothing runs and what is remembered is saved. */
  idle(): Promise<void>
  dispose(): void
}

/** One game of a batch: its plan's paths, and its files as they were when they had settled. */
interface BatchEntry {
  game: Game
  paths: string[]
  files: string[]
  fingerprint: string
  since: number
  /** Queued by the switch-on look at the library (not a game new to it). */
  fromLibrary: boolean
}

interface Batch {
  plan: Omit<TrimPlan, 'paths'>
  entries: BatchEntry[]
}

const batchPaths = (entries: BatchEntry[]): string[] => [
  ...new Set(entries.flatMap((e) => e.paths))
]

export function createAutoTrimService(deps: AutoTrimDeps): AutoTrimService {
  const { log } = deps
  const settleMs = deps.settleMs ?? 120_000
  const pollMs = deps.pollMs ?? 5_000
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const inUse = deps.inUse ?? fileInUse
  const maxBatch = Math.max(1, deps.maxBatch ?? MAX_BATCH)
  /** Queued game ids, in the order they came. */
  const pending: string[] = []
  /** Games downloaded from a paired PC (ids), and their files (lower case). */
  const hostDownloads = new Set<string>()
  const hostPaths = new Set<string>()
  /** What Convert runs made (lower case), Trim's and the user's: never a source again. */
  const outputs = new Set<string>()
  /** Games queued by the switch-on look at the whole library (not new to it). */
  const sweep = new Set<string>()
  /** Each queued game's files as last seen, and since when they look like that. */
  const seen = new Map<string, { fingerprint: string; since: number }>()
  /** Games put back after start() failed for a reason not their own. */
  const failures = new Map<string, number>()
  let pumping: Promise<void> | null = null
  let disposed = false

  const gameById = (id: string): Game | undefined => deps.library.games().find((g) => g.id === id)

  /** The helper's answer per image (lower case path), for as long as its size and time stay the same. */
  const xboxAnswers = new Map<string, { key: string; info: Awaited<ReturnType<XboxInfo>> }>()
  const cachedXboxInfo: XboxInfo | undefined = deps.xboxInfo
    ? async (path) => {
        const stat = await statSafe(path)
        if (!stat) return deps.xboxInfo!(path)
        const key = `${stat.size}:${stat.mtimeMs}`
        const at = path.toLowerCase()
        const known = xboxAnswers.get(at)
        if (known?.key === key) return known.info
        const info = await deps.xboxInfo!(path)
        // No answer (helper missing) and a failure that may pass (an I/O error) are asked again next time.
        if (info && !('failed' in info)) {
          xboxAnswers.delete(at)
          xboxAnswers.set(at, { key, info })
          if (xboxAnswers.size > MEMORY_CAP) xboxAnswers.delete(xboxAnswers.keys().next().value!)
        }
        return info
      }
    : undefined

  /** The newest `MEMORY_CAP` of a set (sets keep insertion order). */
  const newest = (set: Set<string>): string[] => [...set].slice(-MEMORY_CAP)

  // What was remembered before this start joins what this run notes meanwhile (nothing is decided before it is in).
  const ready: Promise<void> = (async () => {
    if (!deps.stateFile) return
    let text: string
    try {
      text = await fs.readFile(deps.stateFile, 'utf8')
    } catch {
      return
    }
    try {
      const memory = JSON.parse(text) as Partial<TrimMemory>
      const take = (list: unknown, into: Set<string>): void => {
        if (Array.isArray(list))
          for (const v of list) if (typeof v === 'string' && v) into.add(v.toLowerCase())
      }
      take(memory.outputs, outputs)
      take(memory.hostPaths, hostPaths)
      if (Array.isArray(memory.hostGames))
        for (const id of memory.hostGames) if (typeof id === 'string' && id) hostDownloads.add(id)
    } catch (err) {
      log.warn(`Trim Games: ${deps.stateFile} could not be read: ${(err as Error).message}`)
    }
  })()

  let saving: Promise<void> = Promise.resolve()
  function save(): void {
    const file = deps.stateFile
    if (!file) return
    saving = saving
      .then(() => ready)
      .then(async () => {
        const memory: TrimMemory = {
          outputs: newest(outputs),
          hostGames: newest(hostDownloads),
          hostPaths: newest(hostPaths)
        }
        await fs.mkdir(dirname(file), { recursive: true })
        const temp = `${file}.tmp`
        await fs.writeFile(temp, JSON.stringify(memory))
        await fs.rename(temp, file)
      })
      .catch((err: Error) =>
        log.warn(`Trim Games: what it remembers was not saved: ${err.message}`)
      )
  }

  function noteOutputs(status: ConvertStatus): void {
    let added = false
    for (const item of status.items) {
      const out = item.output?.toLowerCase()
      if (out && !outputs.has(out)) {
        outputs.add(out)
        added = true
      }
    }
    if (added) save()
  }

  /** A game Trim Games must leave as it is: a Convert result, or downloaded from another PC. */
  function keepsFormat(game: Game): boolean {
    const path = game.romPath?.toLowerCase()
    return hostDownloads.has(game.id) || (!!path && (outputs.has(path) || hostPaths.has(path)))
  }

  async function waitConvertIdle(): Promise<void> {
    for (;;) {
      if (disposed) return
      const status = await deps.convert.status()
      noteOutputs(status)
      if (!status.running) return
      await sleep(pollMs)
    }
  }

  function skipped(game: Game, reason: string): void {
    log.info(`Trim Games: ${game.title} left as it is: ${reason}`)
    deps.events.emit('trim:skipped', { title: game.title, reason })
  }

  /** Games left as they are for one reason (a missing key): logged each, one toast for them all. */
  function skippedAll(games: Game[], reason: string): void {
    if (games.length === 1) return skipped(games[0]!, reason)
    for (const game of games) log.info(`Trim Games: ${game.title} left as it is: ${reason}`)
    deps.events.emit('trim:skipped', {
      title: games.map((g) => g.title).join(', '),
      reason,
      count: games.length
    })
  }

  /** Games of a batch back at the front of the queue, keeping how long their files have been settled. */
  function requeue(entries: BatchEntry[]): void {
    const ids = entries.map((e) => e.game.id).filter((id) => !pending.includes(id))
    pending.unshift(...ids)
    for (const e of entries) {
      if (!seen.has(e.game.id)) seen.set(e.game.id, { fingerprint: e.fingerprint, since: e.since })
      if (e.fromLibrary) sweep.add(e.game.id)
    }
  }

  /** The next group of games of one direction that can go now; games that cannot go at all leave the queue. */
  async function nextBatch(): Promise<Batch | 'wait' | null> {
    let batch: Batch | null = null
    let unsettled = false
    for (const id of [...pending]) {
      const drop = (): void => {
        const at = pending.indexOf(id)
        if (at >= 0) pending.splice(at, 1)
        seen.delete(id)
        sweep.delete(id)
      }
      const game = gameById(id)
      if (game?.romPath && basename(game.romPath).toLowerCase().includes(PARTIAL_MARKER)) {
        drop()
        continue
      }
      if (!game || !game.installed || keepsFormat(game)) {
        if (game && (hostDownloads.has(id) || hostPaths.has(game.romPath?.toLowerCase() ?? '')))
          log.info(`Trim Games: ${game.title} came from another PC and keeps its format`)
        drop()
        continue
      }
      if (batch && TRIM_PAIRS[game.platformId] !== batch.plan.pairId) continue
      // An Xbox image is looked at by the helper only once its file has settled (below), not on every poll.
      const xbox = game.platformId === 'xbox' || game.platformId === 'xbox360'
      const planned = (info?: XboxInfo | typeof XBOX_LATER): Promise<TrimPlanResult> =>
        planTrim(game, info).catch((err: Error) => ({ skip: err.message }))
      const settled = (result: TrimPlanResult): result is TrimPlan => {
        if (!result) {
          drop()
          return false
        }
        if ('skip' in result) {
          log.info(`Trim Games: ${game.title} skipped: ${result.skip}`)
          drop()
          return false
        }
        if ('retry' in result) {
          // The helper could not look at it now (an I/O error): it stays queued, skipped after a few such tries.
          const n = (failures.get(id) ?? 0) + 1
          if (n >= MAX_RUN_FAILURES) {
            failures.delete(id)
            drop()
            skipped(game, result.retry)
          } else {
            failures.set(id, n)
            log.info(`Trim Games: ${game.title} is looked at again later: ${result.retry}`)
            unsettled = true
          }
          return false
        }
        return true
      }
      let result = await planned(xbox ? XBOX_LATER : deps.xboxInfo)
      if (!settled(result)) continue
      // A file gone meanwhile (moved or deleted): nothing to convert.
      if ((await Promise.all(result.paths.map(statSafe))).some((s) => !s)) {
        drop()
        continue
      }
      // A file still being copied into the ROM folder (or open elsewhere) waits until it has stopped changing.
      const files = await planFiles(result)
      const fingerprint = await fingerprintFiles(files)
      const last = seen.get(id)
      const since = last && last.fingerprint === fingerprint ? last.since : now()
      seen.set(id, { fingerprint, since })
      if (now() - since < settleMs || (await anyInUse(files, inUse))) {
        unsettled = true
        continue
      }
      if (xbox) {
        result = await planned(cachedXboxInfo)
        if (!settled(result)) continue
      }
      const fromLibrary = sweep.has(id)
      drop()
      batch ??= { plan: { platformId: result.platformId, pairId: result.pairId }, entries: [] }
      batch.entries.push({ game, paths: result.paths, files, fingerprint, since, fromLibrary })
      if (batch.entries.length >= maxBatch) break
    }
    return batch ?? (unsettled ? 'wait' : null)
  }

  /**
   * The gates again, right before start(): the games that go on, or false when the batch went
   * back to the queue (or was dropped) and pump should look again.
   */
  async function gate(batch: Batch): Promise<BatchEntry[] | false> {
    if (disposed) return false
    if (!deps.enabled()) {
      for (const e of batch.entries) seen.delete(e.game.id)
      return false
    }
    // Paths gone meanwhile: their games leave the batch.
    const present: BatchEntry[] = []
    for (const e of batch.entries) {
      if ((await Promise.all(e.paths.map(statSafe))).every(Boolean)) present.push(e)
      else log.info(`Trim Games: ${e.game.title} is gone and is not converted`)
    }
    if (!present.length) return false
    if (deps.waitReason()) {
      requeue(present)
      return false
    }
    for (const e of present)
      if ((await fingerprintFiles(e.files)) !== e.fingerprint) {
        // Changed since it had settled: every game goes back through all the gates.
        requeue(present)
        return false
      }
    // Opened meanwhile (an emulator started it, a copy over it began): back to the queue until it is closed.
    for (const e of present)
      if (await anyInUse(e.files, inUse)) {
        log.info(`Trim Games: ${e.game.title} is open in another program and waits`)
        requeue(present)
        return false
      }
    return present
  }

  async function runBatch(batch: Batch): Promise<void> {
    const check: ConvertRequest = {
      ...batch.plan,
      reversed: false,
      paths: batchPaths(batch.entries)
    }
    const missing = await deps.convert.check(check).catch((err: Error) => {
      log.warn(`Trim Games: could not check ${batch.plan.pairId}: ${err.message}`)
      return []
    })
    const blocking = missing.find((m) => m.blocking)
    if (blocking) {
      skippedAll(
        batch.entries.map((e) => e.game),
        blocking.message
      )
      return
    }
    for (;;) {
      await waitConvertIdle()
      const entries = await gate(batch)
      if (!entries) return
      const request: ConvertRequest = { ...batch.plan, reversed: false, paths: batchPaths(entries) }
      // PlayOut began closing while the gates were looked at: nothing starts.
      if (disposed) return
      let status: ConvertStatus
      try {
        status = await deps.convert.start(request)
      } catch (err) {
        const message = (err as Error).message
        // Convert's own refusals carry a code (their words follow PlayOut's language); the English words are the
        // fallback for a refusal without one.
        const code = (err as { code?: unknown }).code
        // A manual Convert run started meanwhile: wait for it, then look at every gate again.
        if (code === 'convert-busy' || /already running/i.test(message)) {
          await sleep(pollMs)
          continue
        }
        if (code === 'convert-path' || aboutAPath(message, request.paths)) {
          if (entries.length === 1) {
            skipped(entries[0].game, message)
            return
          }
          // One bad path must not sink the others: each game on its own.
          for (const e of entries) await runBatch({ plan: batch.plan, entries: [e] })
          return
        }
        // Not about one game: back to the queue (skipped after a few such failures).
        const again: BatchEntry[] = []
        for (const e of entries) {
          const n = (failures.get(e.game.id) ?? 0) + 1
          if (n >= MAX_RUN_FAILURES) {
            failures.delete(e.game.id)
            skipped(e.game, message)
          } else {
            failures.set(e.game.id, n)
            again.push(e)
          }
        }
        log.warn(`Trim Games: ${batch.plan.pairId} could not start: ${message}`)
        requeue(again)
        await sleep(pollMs)
        return
      }
      for (const e of entries) failures.delete(e.game.id)
      const titles = entries.map((e) => e.game.title)
      log.info(`Trim Games: ${batch.plan.pairId} for ${titles.join(', ')}`)
      deps.events.emit('trim:started', {
        count: entries.length,
        titles,
        fromLibrary: entries.some((e) => e.fromLibrary)
      })
      noteOutputs(status)
      await waitConvertIdle()
      return
    }
  }

  async function pump(): Promise<void> {
    await ready
    while (!disposed && pending.length) {
      if (!deps.enabled()) {
        pending.length = 0
        seen.clear()
        failures.clear()
        sweep.clear()
        return
      }
      const reason = deps.waitReason()
      const current = await deps.convert.status()
      noteOutputs(current)
      if (reason || current.running) {
        await sleep(pollMs)
        continue
      }
      const batch = await nextBatch()
      if (batch === 'wait') {
        await sleep(pollMs)
        continue
      }
      if (!batch) continue
      await runBatch(batch)
    }
  }

  function kick(): void {
    if (pumping || disposed) return
    pumping = pump()
      .catch((err) => log.error('Trim Games failed', err))
      .finally(() => {
        pumping = null
        // Games queued while the last look ended.
        if (pending.length && !disposed && deps.enabled()) kick()
      })
  }

  function enqueue(gameIds: string[]): void {
    if (disposed || !deps.enabled()) return
    for (const id of gameIds) if (!pending.includes(id)) pending.push(id)
    if (pending.length) kick()
  }

  return {
    add: enqueue,
    checkLibrary() {
      const ids = deps.library
        .games()
        .filter((g) => g.source === 'rom' && g.installed && g.romPath && TRIM_PAIRS[g.platformId])
        .map((g) => g.id)
      if (!deps.enabled()) return
      log.info(`Trim Games: checking ${ids.length} ROM games in the library`)
      for (const id of ids) if (!pending.includes(id)) sweep.add(id)
      enqueue(ids)
    },
    noteConvertStatus: noteOutputs,
    markHostDownload(gameId) {
      hostDownloads.add(gameId)
      const path = gameById(gameId)?.romPath?.toLowerCase()
      if (path) hostPaths.add(path)
      save()
    },
    async idle() {
      while (pumping) await pumping
      await saving
    },
    dispose() {
      disposed = true
      pending.length = 0
      seen.clear()
      failures.clear()
      sweep.clear()
    }
  }
}
