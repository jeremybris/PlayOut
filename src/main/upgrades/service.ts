// The game page's Upgrade menu (PC games): the service behind upgradeStatus / runUpgrade / cancelUpgrade. It puts the
// six upgrade modules together (docs/research/upgrades/DESIGN.md, MODULE-REPORTS.md): what each upgrade can do for an
// installed PC game now, and running one action per game at a time with 'upgrades:progress' events.
//
// Where things live:
// - `Upgrades\` beside PlayOut.exe (kept by the installer, build/installer.nsh) holds the downloaded tools and files:
//   DLLs\ (the vendors' upscaler files), OptiScaler\ (the extracted release), SCSKiller\, DLSS-AiO-Swapper\ and Tools\
//   (7-Zip's extractor). When that folder cannot be written, userData\Upgrades is used instead.
// - userData\upgrades.json keeps the per-game facts: when the shaders were precompiled (or that SCSKiller cannot do the
//   game), when and with which algorithm the game was compressed, the last folder measure and the last DLL update; and
//   CompactGUI's per-game savings estimates (refreshed weekly).
//
// Speed of upgradeStatus: it never downloads a tool. The newest versions (vendor DLLs, OptiScaler) are looked up at
// most every 12 hours and CompactGUI's database weekly; a lookup gets a couple of seconds and otherwise finishes in the
// background (the menu shows "not known yet" meanwhile). The GPU is detected once per app run. Measuring a game folder
// (size, bytes on disk, compression state) can take long on a huge game, so the last measure is kept per game: a
// measure older than half an hour (or of another folder) is started again in the background and waited for only
// briefly, so a small game shows fresh numbers at once and a huge one shows the last ones until the next opening.
// The folder walks (upscaler files, anti-cheat, OptiScaler's manifests) get 3 seconds each and are kept for a few
// minutes per game; a walk that takes longer shows the last result (anti-cheat "unknown" when there is none).
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { basename, join, resolve } from 'path'
import { pipeline } from 'stream/promises'
import { StringDecoder } from 'string_decoder'
import type { Game } from '../../shared/types'
import {
  UPGRADES_FOLDER,
  upgradeOf,
  type CompressAlgorithm,
  type CompressState,
  type DllKindSummary,
  type FoundUpscalerDll,
  type GpuInfo,
  type UpgradeAction,
  type UpgradeId,
  type UpgradeProgress,
  type UpgradeRisk,
  type UpgradeStatus,
  type UpscalerDllKind
} from '../../shared/upgrades'
import type { ResolvedDownload } from '../emulator-setup/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { steamAppIdOf } from '../scrapers/steam-store'
import { JsonStore } from '../store/json-store'
import type { PsRunner } from '../system/ps-worker'
import { psQuote } from '../system/powershell'
import {
  AIO_FOLDER,
  ensureAioSwapper,
  latestAioSwapper,
  openAioSwapper,
  type AioRelease,
  type SpawnDetached
} from './aio'
import { AntiCheatScanError, gameRiskTags, scanAntiCheat } from './anticheat'
import {
  compressFolder,
  compressUnavailable,
  measureFolderScript,
  parseCompactDatabase,
  parseFolderMeasure,
  parseVolumeInfo,
  uncompressFolder,
  volumeInfoScript,
  type CompactSpawn
} from './compress'
import {
  compareVersions,
  ensureVendorDll,
  fsrDisplayVersion,
  isNewerDll,
  latestVendorDlls,
  restoreDlls,
  scanUpscalerDlls,
  swapDlls,
  type VendorDll
} from './dlls'
import { VIDEO_CONTROLLER_SCRIPT, parseVideoControllers, primaryGpu } from './gpu'
import {
  ensureOptiScaler,
  findOptiScalerInstall,
  installOptiScaler,
  latestOptiScaler,
  optiScalerFiles,
  pickExeDir,
  removeOptiScaler,
  type OptiScalerRelease
} from './optiscaler'
import {
  SCSKILLER_FOLDER,
  compileShaders,
  disableRecorder,
  ensureScsKiller,
  latestScsKiller,
  scsKillerDataDir,
  scsKillerExe,
  type ScsKillerRelease,
  type SpawnTool
} from './scskiller'
import { tMain } from '../i18n'

/** CompactGUI's community database (per Steam game: how much each algorithm saved). */
export const COMPACT_DATABASE_URL =
  'https://raw.githubusercontent.com/IridiumIO/CompactGUI/database/database.json'

/** The newest versions (vendor DLLs, OptiScaler, SCSKiller, DLSS AiO Swapper) are looked up again after this long. */
const RELEASE_MAX_AGE_MS = 12 * 60 * 60_000
/** CompactGUI's database is fetched again after this long. */
const DATABASE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** A lookup that failed is not tried again for this long (no hammering while offline). */
const LOOKUP_RETRY_MS = 10 * 60_000
/** How long upgradeStatus waits for a lookup before answering without it (it goes on in the background). */
const STATUS_LOOKUP_WAIT_MS = 2500
/** A game folder's measure is started again when older than this. */
const MEASURE_MAX_AGE_MS = 30 * 60_000
/** How long upgradeStatus waits for a folder measure before showing the last one. */
const STATUS_MEASURE_WAIT_MS = 1500
/** A folder measure (PowerShell walking every file) may take this long on a huge game. */
const MEASURE_TIMEOUT_MS = 20 * 60_000
/** The GPU script loads the PnP module (about a second, more on a slow PC). */
const GPU_TIMEOUT_MS = 30_000
/** Quick PowerShell checks (drive, free space, signature). */
const QUICK_PS_TIMEOUT_MS = 20_000
/** Running progress events are sent at most this often (compression reports every file). */
const PROGRESS_THROTTLE_MS = 200
/** How long upgradeStatus waits for each of its folder walks (upscaler files, anti-cheat, OptiScaler). */
const STATUS_SCAN_WAIT_MS = 3000
/** A folder walk's result is used again for this long (an action on the game drops it sooner). */
const WALK_MAX_AGE_MS = 5 * 60_000

/** What the menu shows for anti-cheat when the folder could not be checked (so the ban warning still shows). */
export function antiCheatUnknown(): string {
  return tMain('mainUpgrades.antiCheatUnknown')
}

/** The module calls the service makes (tests replace some with fakes; the real ones are the default). */
const realModules = {
  scanDlls: scanUpscalerDlls,
  latestVendorDlls,
  ensureVendorDll,
  swapDlls,
  restoreDlls,
  scanAntiCheat,
  findOptiScalerInstall,
  optiScalerFiles,
  latestOptiScaler,
  ensureOptiScaler,
  pickExeDir,
  installOptiScaler,
  removeOptiScaler,
  latestScsKiller,
  ensureScsKiller,
  disableRecorder,
  compileShaders,
  latestAioSwapper,
  ensureAioSwapper,
  openAioSwapper,
  compressFolder,
  uncompressFolder,
  compressUnavailable
}

/** The upgrade modules' functions, as the service calls them. */
export type UpgradeModules = typeof realModules

/** What the upgrades service needs from the app. */
export interface UpgradesServiceDeps {
  library: { getGame(id: string): Game | undefined }
  /** The game is running now (upgrades are refused meanwhile). */
  isGameRunning: (gameId: string) => boolean
  events: Pick<EventBus, 'emit'>
  log: Logger
  paths: {
    /** `<folder of PlayOut.exe>\Upgrades` (UPGRADES_FOLDER). */
    upgradesDir: string
    /** Used when `upgradesDir` cannot be written (PlayOut in a protected folder): userData\Upgrades. */
    fallbackUpgradesDir?: string
    /** userData\upgrades.json: the per-game facts. */
    factsFile: string
  }
  /** HTTPS through the emulator setup's helpers (User-Agent, retries, https only, size and SHA-256 checks). */
  http: {
    fetchJson(url: string): Promise<unknown>
    fetchText(url: string): Promise<string>
    /**
     * Downloads `d` into `dir` as `<dir>/<d.fileName>` (checked against d.size and d.sha256); returns its path.
     * `signal` stops it (the player stopped the upgrade).
     */
    download(d: ResolvedDownload, dir: string, signal?: AbortSignal): Promise<string>
  }
  /** Quick PowerShell scripts (GPU, drive, free space, signatures). */
  powershell: PsRunner
  /**
   * Folder measures (they can take minutes); default `powershell`. The app passes a small pool (ps-pool), so the quick
   * checks stay quick and one game's measure never waits behind another's.
   */
  measurePowershell?: PsRunner
  /** Unpacks a zip or 7z archive into `destDir` (extractArchive with 7-Zip's extractor). */
  archive: {
    /** Unpacks `file` into `destDir`; 7-Zip's extractor is kept in `toolsDir` (UpgradesTools). */
    extract(file: string, destDir: string, toolsDir: string): Promise<void>
  }
  /** SCSKiller's command line (scskiller spawnTool). */
  spawnTool: SpawnTool
  /** DLSS AiO Swapper's start (aio spawnDetached). */
  spawnDetached: SpawnDetached
  /** compact.exe with its output streamed and a kill on abort (spawnCompact). */
  spawnCompact: CompactSpawn
  /** True when the file carries a valid Authenticode signature by `expectedSigner` (verifySigner). */
  verifySigner(path: string, expectedSigner: string, companyName?: string): Promise<boolean>
  /** Whether a program (by its file name, "x.exe") is running; lets DLSS AiO Swapper's library be updated. */
  isProcessRunning?: (imageName: string) => Promise<boolean>
  /** SHA-256 of a file (lower-case hex); default: streamed with Node's crypto. */
  sha256File?: (file: string) => Promise<string>
  /** Free bytes on a folder's drive; default: a PowerShell DriveInfo query. */
  freeSpace?: (dir: string) => Promise<number | null>
  now?: () => number
  /** Tests: module functions to replace. */
  modules?: Partial<UpgradeModules>
  /** Tests: how long upgradeStatus waits for a lookup / a measure / a folder walk. */
  lookupWaitMs?: number
  measureWaitMs?: number
  scanWaitMs?: number
}

export interface UpgradesService {
  /**
   * The game's Upgrade menu status. `freshMeasure`: the compression state comes from a measure of the folder now, never
   * from a kept one (Compress games automatically: a game reinstalled since PlayOut compressed it).
   */
  upgradeStatus(gameId: string, opts?: { freshMeasure?: boolean }): Promise<UpgradeStatus>
  /** Starts an action (progress comes as 'upgrades:progress') and returns the status with it running. */
  runUpgrade(gameId: string, action: UpgradeAction): Promise<UpgradeStatus>
  cancelUpgrade(gameId: string): Promise<void>
  /**
   * The upgrade running for the game now, else null. While one runs it may be rewriting the game's files: Play, Co-Op
   * and deleting the game are refused meanwhile (UPGRADE_RUNNING_MESSAGE).
   */
  busyFor(gameId: string): UpgradeId | null
  /** Whether an upgrade runs for any game now (Compress games automatically waits meanwhile). */
  anyBusy(): boolean
  /** Stops running actions and saves the facts file. */
  dispose(): Promise<void>
}

/** The newest vendor files, and whether every vendor answered (a partial answer is asked again soon). */
interface VendorLookup {
  files: Partial<Record<UpscalerDllKind, VendorDll>>
  complete: boolean
}

/** A folder measure kept per game. */
interface Measure {
  /** The folder measured (a moved game is measured again). */
  dir: string
  size: number
  onDisk: number
  state: CompressState['state']
  /** When (ms since 1970). */
  at: number
}

/** What PlayOut remembers about one game's upgrades. */
interface GameFacts {
  /** When the shaders were last precompiled (ISO). */
  compiledAt?: string
  /** Why SCSKiller could not precompile this game the last time (shown as a note; a successful run clears it). */
  shadersUnsupported?: string
  /** When PlayOut last compressed the game (ms since 1970). */
  compressedAt?: number
  /** The algorithm it was compressed with. */
  compressAlgorithm?: CompressAlgorithm
  measure?: Measure
  /** When the DLLs were last updated (ISO). */
  dllsUpdatedAt?: string
}

interface FactsFile {
  version: 1
  games: Record<string, GameFacts>
  /** CompactGUI's estimates by Steam app id (0..1 of the size) and when they were fetched. */
  compactDb?: { fetchedAt: number; savings: Record<string, number> }
}

const ALGORITHMS: readonly CompressAlgorithm[] = ['xpress4k', 'xpress8k', 'xpress16k', 'lzx']

function normalizeFacts(raw: unknown): FactsFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const games: Record<string, GameFacts> = {}
  if (r.games && typeof r.games === 'object' && !Array.isArray(r.games)) {
    for (const [id, value] of Object.entries(r.games as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      const f: GameFacts = {}
      if (typeof v.compiledAt === 'string') f.compiledAt = v.compiledAt
      if (typeof v.shadersUnsupported === 'string') f.shadersUnsupported = v.shadersUnsupported
      if (typeof v.compressedAt === 'number' && Number.isFinite(v.compressedAt))
        f.compressedAt = v.compressedAt
      if (ALGORITHMS.includes(v.compressAlgorithm as CompressAlgorithm))
        f.compressAlgorithm = v.compressAlgorithm as CompressAlgorithm
      if (typeof v.dllsUpdatedAt === 'string') f.dllsUpdatedAt = v.dllsUpdatedAt
      const m = v.measure as Record<string, unknown> | undefined
      if (
        m &&
        typeof m.dir === 'string' &&
        typeof m.size === 'number' &&
        typeof m.onDisk === 'number' &&
        typeof m.at === 'number' &&
        (m.state === 'none' || m.state === 'partial' || m.state === 'compressed')
      )
        f.measure = { dir: m.dir, size: m.size, onDisk: m.onDisk, state: m.state, at: m.at }
      games[id] = f
    }
  }
  const out: FactsFile = { version: 1, games }
  const db = r.compactDb as Record<string, unknown> | undefined
  if (db && typeof db.fetchedAt === 'number' && db.savings && typeof db.savings === 'object')
    out.compactDb = {
      fetchedAt: db.fetchedAt,
      savings: Object.fromEntries(
        Object.entries(db.savings as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === 'number'
        )
      )
    }
  return out
}

/** A value looked up on the internet: kept for `maxAgeMs`, refreshed in the background, never hammered. */
interface Lookup<T> {
  /** The value, waiting at most `waitMs` for a refresh when it is stale (then the stale value or null). */
  get(waitMs: number): Promise<T | null>
  /** The value, waiting for a refresh when it is stale (actions); the stale value or null when that fails. */
  current(): Promise<T | null>
}

function createLookup<T>(
  /** Loads the value; `previous` is the one kept so far (null at first). */
  load: (previous: T | null) => Promise<T>,
  options: {
    maxAgeMs: number
    /** How long this value is kept, when it differs from `maxAgeMs` (a partial answer is asked again sooner). */
    maxAgeOf?: (value: T) => number
    now: () => number
    log: Logger
    name: string
    initial?: { value: T; at: number }
    onLoaded?: (value: T, at: number) => void
  }
): Lookup<T> {
  let value: T | null = options.initial?.value ?? null
  let at = options.initial?.at ?? 0
  let maxAge = options.maxAgeMs
  let failedAt = 0
  let pending: Promise<T | null> | null = null
  const fresh = (): boolean => at > 0 && options.now() - at < maxAge
  const refresh = (): Promise<T | null> => {
    pending ??= load(value)
      .then((v) => {
        value = v
        at = options.now()
        maxAge = options.maxAgeOf?.(v) ?? options.maxAgeMs
        options.onLoaded?.(v, at)
        return v
      })
      .catch((err: unknown) => {
        failedAt = options.now()
        options.log.warn(`${options.name}: lookup failed: ${errorText(err)}`)
        return value
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
  return {
    async get(waitMs) {
      if (fresh()) return value
      if (!pending && failedAt > 0 && options.now() - failedAt < LOOKUP_RETRY_MS) return value
      const p = refresh()
      return waitMs > 0 ? raceTimeout(p, waitMs, value) : value
    },
    async current() {
      if (fresh()) return value
      return refresh()
    }
  }
}

/** `promise`'s value, or `fallback` when it takes longer than `ms` (the promise goes on; its failure is ignored). */
function raceTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<F>((r) => {
      timer = setTimeout(() => r(fallback), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Bytes as the player reads them ("41.2 GB", "820 MB"). */
export function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

const DLL_NAMES: Record<UpscalerDllKind, string> = {
  dlss: 'DLSS',
  dlssg: 'DLSS Frame Generation',
  dlssd: 'DLSS Ray Reconstruction',
  'fsr-dx12': 'FSR',
  'fsr-vk': 'FSR (Vulkan)',
  xess: 'XeSS',
  'xess-dx11': 'XeSS (DirectX 11)',
  'xess-fg': 'XeSS Frame Generation',
  xell: 'XeLL'
}

/** A file version as the player knows it: FSR's own version, else without a trailing ".0" ("310.9.16"). */
export function displayVersion(kind: UpscalerDllKind, version: string): string {
  if (kind === 'fsr-dx12' || kind === 'fsr-vk') {
    const fsr = fsrDisplayVersion(version)
    if (fsr) return fsr
  }
  return version.replace(/\.0$/, '')
}

/** True when a found file can take the newest official one (DLSS 1 files and unreadable versions cannot). */
function canUpdate(f: FoundUpscalerDll, newest: VendorDll | undefined): boolean {
  if (!f.version || !newest) return false
  if (f.kind === 'dlss' && compareVersions(f.version, '2.0') < 0) return false
  return isNewerDll(f.kind, f.version, newest.version)
}

/**
 * The DLL row's summary per kind found (in the order found): the game's version (the oldest file that can be
 * updated, else the oldest readable one), the newest official one, both as the player knows them, and whether a file
 * can take it. Only `own` files (the game's, not OptiScaler's) count as updatable.
 */
export function dllKindSummaries(
  found: readonly FoundUpscalerDll[],
  own: readonly FoundUpscalerDll[],
  newest: Partial<Record<UpscalerDllKind, VendorDll>>
): DllKindSummary[] {
  const out: DllKindSummary[] = []
  const oldest = (files: readonly FoundUpscalerDll[]): string | null =>
    files
      .map((f) => f.version)
      .filter((v): v is string => !!v)
      .sort(compareVersions)[0] ?? null
  for (const kind of [...new Set(found.map((f) => f.kind))]) {
    const file = newest[kind]
    const updatable = own.filter((f) => f.kind === kind && canUpdate(f, file))
    const version = oldest(updatable) ?? oldest(found.filter((f) => f.kind === kind))
    out.push({
      kind,
      version: version ? displayVersion(kind, version) : null,
      latest: file ? displayVersion(kind, file.version) : null,
      updatable: updatable.length > 0
    })
  }
  return out
}

/** Parses a certificate subject ("CN=X, O=\"Y, Inc.\", C=US") into its parts (names upper-cased). */
export function parseSubject(subject: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let i = 0
  while (i < subject.length) {
    while (subject[i] === ' ' || subject[i] === ',') i++
    const eq = subject.indexOf('=', i)
    if (eq < 0) break
    const key = subject.slice(i, eq).trim().toUpperCase()
    i = eq + 1
    let value = ''
    if (subject[i] === '"') {
      i++
      while (i < subject.length) {
        if (subject[i] === '"' && subject[i + 1] === '"') {
          value += '"'
          i += 2
        } else if (subject[i] === '"') {
          i++
          break
        } else value += subject[i++]
      }
      while (i < subject.length && subject[i] !== ',') i++
    } else {
      const comma = subject.indexOf(',', i)
      const end = comma < 0 ? subject.length : comma
      value = subject.slice(i, end).trim()
      i = end
    }
    out.push([key, value])
  }
  return out
}

/** An organisation name compared loosely: case, spaces and a trailing ", Inc." do not matter. */
function orgKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s,]*\b(inc|incorporated)\.?$/, '')
    .replace(/[\s.,]+$/, '')
    .replace(/\s+/g, ' ')
}

/**
 * True when a signature check's result is a valid signature by `expectedSigner` (its certificate's O= or CN=) and,
 * when `companyName` is given, the file's CompanyName is that company. AMD signs as "Advanced Micro Devices" while
 * the pinned name is "Advanced Micro Devices, Inc.", so ", Inc." is ignored.
 */
export function signatureMatches(
  result: { status?: unknown; subject?: unknown; company?: unknown } | null,
  expectedSigner: string,
  companyName?: string
): boolean {
  if (!result || result.status !== 'Valid' || typeof result.subject !== 'string') return false
  const want = orgKey(expectedSigner)
  const signed = parseSubject(result.subject).some(
    ([k, v]) => (k === 'O' || k === 'CN') && orgKey(v) === want
  )
  if (!signed) return false
  if (companyName === undefined) return true
  return typeof result.company === 'string' && orgKey(result.company) === orgKey(companyName)
}

/** The PowerShell reading a file's Authenticode signature and CompanyName (the path travels single-quoted). */
export function signatureScript(path: string): string {
  const p = psQuote(path)
  return [
    `$s = Get-AuthenticodeSignature -LiteralPath ${p}`,
    '$company = $null',
    `try { $company = (Get-Item -LiteralPath ${p}).VersionInfo.CompanyName } catch { }`,
    '[pscustomobject]@{ status = [string]$s.Status; subject = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }); company = $company }'
  ].join('\n')
}

/**
 * The real verifySigner: Get-AuthenticodeSignature through `ps`, then signatureMatches. Never throws (a failed check
 * is false).
 */
export async function verifySigner(
  ps: PsRunner,
  path: string,
  expectedSigner: string,
  companyName?: string
): Promise<boolean> {
  try {
    const result = await ps.run<Record<string, unknown>>(signatureScript(path), {
      timeoutMs: QUICK_PS_TIMEOUT_MS
    })
    return signatureMatches(result, expectedSigner, companyName)
  } catch {
    return false
  }
}

/**
 * compact.exe for compressFolder / uncompressFolder: no shell, no window, its output handed over as it arrives
 * (decoded as Latin-1: only the lines are counted), killed when `signal` aborts (code null then).
 */
export const spawnCompact: CompactSpawn = (file, args, options) =>
  new Promise((resolveRun) => {
    if (options.signal.aborted) {
      resolveRun({ code: null })
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolveRun({ code: null })
      return
    }
    const decoder = new StringDecoder('latin1')
    child.stdout?.on('data', (chunk: Buffer) => options.onStdout(decoder.write(chunk)))
    child.stderr?.resume()
    const onAbort = (): void => {
      child.kill()
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      options.signal.removeEventListener('abort', onAbort)
      const rest = decoder.end()
      if (rest) options.onStdout(rest)
      resolveRun({ code: options.signal.aborted ? null : code })
    }
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function isDirectory(path: string): Promise<boolean> {
  return fs.stat(path).then(
    (s) => s.isDirectory(),
    () => false
  )
}

async function fileExists(path: string): Promise<boolean> {
  return fs.stat(path).then(
    (s) => s.isFile(),
    () => false
  )
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

/** A path inside the game compared loosely: either slash, any letter case. */
function relKey(relPath: string): string {
  return relPath
    .split(/[\\/]/)
    .filter((p) => p !== '' && p !== '.')
    .join('/')
    .toLowerCase()
}

/**
 * The found upscaler files that are the game's own, not files an OptiScaler install added or replaced (`theirs`,
 * from optiScalerFiles). The DLL update never touches OptiScaler's files: it would back them up as the game's own,
 * and removing OptiScaler and restoring the DLLs would then leave OptiScaler's files in the game.
 */
export function notOptiScalers<T extends { relPath: string }>(
  found: readonly T[],
  theirs: readonly string[]
): T[] {
  if (theirs.length === 0) return [...found]
  const keys = new Set(theirs.map(relKey))
  return found.filter((f) => !keys.has(relKey(f.relPath)))
}

/** A finished action: whether it worked and the one line for the player. */
interface Outcome {
  ok: boolean
  message: string
}

type Report = (progress: number | null, message: string) => void

/** A running action. */
interface Job {
  upgrade: UpgradeId
  controller: AbortController
  done: Promise<void>
}

/** Thrown inside an action when the player stopped it. */
class Stopped extends Error {}

export function createUpgradesService(deps: UpgradesServiceDeps): UpgradesService {
  const m: UpgradeModules = { ...realModules, ...deps.modules }
  const log = deps.log
  const now = deps.now ?? (() => Date.now())
  const measurePs = deps.measurePowershell ?? deps.powershell
  const lookupWait = deps.lookupWaitMs ?? STATUS_LOOKUP_WAIT_MS
  const measureWait = deps.measureWaitMs ?? STATUS_MEASURE_WAIT_MS
  const scanWait = deps.scanWaitMs ?? STATUS_SCAN_WAIT_MS
  const sha256File = deps.sha256File ?? sha256OfFile
  const jobs = new Map<string, Job>()
  const measures = new Map<string, Promise<Measure | null>>()
  let disposed = false

  const store = new JsonStore<FactsFile>({
    file: deps.paths.factsFile,
    defaults: () => ({ version: 1, games: {} }),
    normalize: normalizeFacts,
    debounceMs: 500
  })
  const loaded = store.load().catch((err: unknown) => {
    log.warn(`upgrades.json could not be read: ${errorText(err)}`)
    return store.get()
  })
  const factsOf = async (gameId: string): Promise<GameFacts> => {
    await loaded
    return store.get().games[gameId] ?? {}
  }
  const setFacts = async (gameId: string, change: (f: GameFacts) => void): Promise<void> => {
    await loaded
    store.set((d) => {
      const f = { ...(d.games[gameId] ?? {}) }
      change(f)
      d.games[gameId] = f
    })
  }

  // The tools folder: beside PlayOut.exe when it can be written, else under userData.
  let dirPromise: Promise<string> | null = null
  const upgradesDir = (): Promise<string> =>
    (dirPromise ??= (async () => {
      const preferred = deps.paths.upgradesDir
      try {
        await fs.mkdir(preferred, { recursive: true })
        const probe = join(preferred, `.playout-write-test-${process.pid}`)
        await fs.writeFile(probe, '')
        await fs.rm(probe, { force: true })
        return preferred
      } catch (err) {
        const fallback = deps.paths.fallbackUpgradesDir
        if (!fallback) throw err
        log.warn(`${preferred} cannot be written (${errorText(err)}); using ${fallback}`)
        await fs.mkdir(fallback, { recursive: true })
        return fallback
      }
    })().catch((err: unknown) => {
      dirPromise = null
      throw err
    }))

  // --- The graphics card (once per app run) ---
  let gpuPromise: Promise<GpuInfo | null> | null = null
  const detectGpu = (): Promise<GpuInfo | null> =>
    (gpuPromise ??= (async () => {
      const out = await deps.powershell.run<unknown>(VIDEO_CONTROLLER_SCRIPT, {
        timeoutMs: GPU_TIMEOUT_MS
      })
      // The exact array parseVideoControllers returns goes to primaryGpu (its ranking hints live on those objects).
      const gpu = primaryGpu(
        parseVideoControllers(typeof out === 'string' ? out : JSON.stringify(out ?? []))
      )
      log.info(`graphics card: ${gpu ? `${gpu.name} (${gpu.vendor})` : 'none found'}`)
      return gpu
    })().catch((err: unknown) => {
      log.warn(`the graphics card could not be detected: ${errorText(err)}`)
      gpuPromise = null // Tried again at the next status.
      return null
    }))

  // --- Lookups ---
  const lookupOptions = (
    name: string
  ): { maxAgeMs: number; now: () => number; log: Logger; name: string } => ({
    maxAgeMs: RELEASE_MAX_AGE_MS,
    now,
    log,
    name
  })
  const vendorDlls = createLookup<VendorLookup>(
    async (previous) => {
      const failed: string[] = []
      const files = await m.latestVendorDlls({
        fetchJson: <T>(url: string) => deps.http.fetchJson(url) as Promise<T>,
        onVendorFailed: (vendor, err) => {
          failed.push(vendor)
          log.warn(`vendor DLLs: ${vendor} could not be looked up: ${errorText(err)}`)
        }
      })
      // Every vendor failing (offline) is a failure, not "no files": tried again later.
      if (Object.keys(files).length === 0) throw new Error('no vendor could be reached')
      if (failed.length === 0) return { files, complete: true }
      // Some vendor failed: its files from the last answer stay (when there was one), and the answer is kept only
      // briefly, so that vendor is asked again soon instead of in 12 hours.
      return { files: { ...previous?.files, ...files }, complete: false }
    },
    {
      ...lookupOptions('vendor DLLs'),
      maxAgeOf: (v) => (v.complete ? RELEASE_MAX_AGE_MS : LOOKUP_RETRY_MS)
    }
  )
  const optiscalerRelease = createLookup<OptiScalerRelease | null>(
    () => m.latestOptiScaler({ fetchJson: deps.http.fetchJson }),
    lookupOptions('OptiScaler')
  )
  const scsKillerRelease = createLookup<ScsKillerRelease | null>(
    () => m.latestScsKiller({ fetchJson: deps.http.fetchJson }),
    lookupOptions('SCSKiller')
  )
  const aioRelease = createLookup<AioRelease | null>(
    () => m.latestAioSwapper({ fetchJson: deps.http.fetchJson }),
    lookupOptions('DLSS AiO Swapper')
  )
  let compactDbLookup: Lookup<Record<string, number>> | null = null
  const compactDb = async (): Promise<Lookup<Record<string, number>>> => {
    if (compactDbLookup) return compactDbLookup
    await loaded
    const saved = store.get().compactDb
    compactDbLookup = createLookup<Record<string, number>>(
      async () => {
        const text = await deps.http.fetchText(COMPACT_DATABASE_URL)
        // The menu compresses with XPRESS8K: its own results first, any algorithm's for games without them.
        const all = parseCompactDatabase(text)
        if (all.size === 0) throw new Error("CompactGUI's database could not be read")
        const out = Object.fromEntries(all)
        for (const [id, saving] of parseCompactDatabase(text, 'xpress8k')) out[id] = saving
        return out
      },
      {
        maxAgeMs: DATABASE_MAX_AGE_MS,
        now,
        log,
        name: "CompactGUI's database",
        initial: saved ? { value: saved.savings, at: saved.fetchedAt } : undefined,
        onLoaded: (savings, at) =>
          store.set((d) => {
            d.compactDb = { fetchedAt: at, savings }
          })
      }
    )
    return compactDbLookup
  }

  // --- PowerShell-backed checks ---
  const volumeInfo = async (dir: string): Promise<ReturnType<typeof parseVolumeInfo>> =>
    parseVolumeInfo(
      await deps.powershell.run(volumeInfoScript(dir), { timeoutMs: QUICK_PS_TIMEOUT_MS })
    )
  const freeSpace =
    deps.freeSpace ??
    (async (dir: string): Promise<number | null> => {
      const out = await deps.powershell.run<unknown>(
        `$d = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot(${psQuote(dir)}))\n[double]$d.AvailableFreeSpace`,
        { timeoutMs: QUICK_PS_TIMEOUT_MS }
      )
      const n = typeof out === 'number' ? out : Number(out)
      return Number.isFinite(n) && n >= 0 ? n : null
    })
  const unavailableToCompress = (dir: string): Promise<string | null> =>
    m.compressUnavailable(dir, {
      volumeInfo,
      windowsDir: process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    })

  /**
   * Bumped per game when its folder changed under a compress / uncompress: a measure started before that is
   * outdated when it ends, so it is not kept.
   */
  const measureGen = new Map<string, number>()

  /** Measures a game folder now (one PowerShell walk) and keeps the result; null when it fails. */
  const measureNow = async (gameId: string, dir: string, gen: number): Promise<Measure | null> => {
    const facts = await factsOf(gameId)
    try {
      const out = await measurePs.run<unknown>(
        measureFolderScript(dir, facts.compressedAt ?? null),
        {
          timeoutMs: MEASURE_TIMEOUT_MS
        }
      )
      const parsed = parseFolderMeasure(out)
      if (!parsed) throw new Error('the measure gave no usable answer')
      const measure: Measure = { dir, ...parsed, at: now() }
      if ((measureGen.get(gameId) ?? 0) === gen)
        await setFacts(gameId, (f) => {
          f.measure = measure
        })
      return measure
    } catch (err) {
      log.warn(`${dir}: could not be measured: ${errorText(err)}`)
      return null
    }
  }
  /** Starts a measure (after `after`, when given) as the game's running one. */
  const startMeasure = (
    gameId: string,
    dir: string,
    after?: Promise<unknown>
  ): Promise<Measure | null> => {
    const gen = measureGen.get(gameId) ?? 0
    const p: Promise<Measure | null> = (
      after
        ? after.then(
            () => measureNow(gameId, dir, gen),
            () => measureNow(gameId, dir, gen)
          )
        : measureNow(gameId, dir, gen)
    ).finally(() => {
      if (measures.get(gameId) === p) measures.delete(gameId)
    })
    measures.set(gameId, p)
    return p
  }
  /** One measure per game at a time; later callers share it. */
  const measure = (gameId: string, dir: string): Promise<Measure | null> =>
    measures.get(gameId) ?? startMeasure(gameId, dir)
  /**
   * After a compress or uncompress ended in any way (done, failed or stopped): the kept measure no longer tells the
   * folder's state, so it is dropped (the next status measures again) and a fresh measure starts, after any measure
   * already running (whose answer is then not kept). Resolves once the kept measure is dropped, with the fresh
   * measure still running in `measured` (which never rejects), so a caller can end its job without waiting for it.
   */
  /**
   * A compress or uncompress is about to change the game's files: a measure running now (started before) is not kept
   * when it ends, so numbers read part way through are never saved as the folder's state.
   */
  const folderChanging = (gameId: string): void => {
    measureGen.set(gameId, (measureGen.get(gameId) ?? 0) + 1)
  }
  const remeasure = async (
    gameId: string,
    dir: string
  ): Promise<{ measured: Promise<Measure | null> }> => {
    folderChanging(gameId)
    await setFacts(gameId, (f) => {
      delete f.measure
    })
    return { measured: startMeasure(gameId, dir, measures.get(gameId)) }
  }

  // --- DLSS AiO Swapper and SCSKiller already downloaded ---
  const findAioExe = async (): Promise<string | null> => {
    const dir = join(await upgradesDir(), AIO_FOLDER)
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const exes = names
      .map((name) => ({
        name,
        version: /^DLSS-AiO-Swapper-([\d.]+)-portable\.exe$/i.exec(name)?.[1]
      }))
      .filter((e): e is { name: string; version: string } => !!e.version)
      .sort((a, b) => compareVersions(b.version, a.version))
    for (const e of exes) if (await fileExists(join(dir, e.name))) return join(dir, e.name)
    return null
  }
  const findScsKillerExe = async (): Promise<string | null> => {
    const exe = scsKillerExe(join(await upgradesDir(), SCSKILLER_FOLDER))
    return (await fileExists(exe)) ? exe : null
  }

  // --- Status ---
  const gameOf = (gameId: string): Game => {
    const game = deps.library.getGame(gameId)
    if (!game) throw new Error('Unknown game')
    return game
  }

  /** Why upgrades cannot be used for the game at all (the running game included), else null. */
  const blockedReason = async (game: Game): Promise<string | null> => {
    if (game.remote) return tMain('mainUpgrades.blocked.otherPc')
    if (game.source === 'rom') return tMain('mainUpgrades.blocked.notPcGame')
    if (!game.installed || !game.installDir) return tMain('mainUpgrades.blocked.notInstalled')
    if (!(await isDirectory(game.installDir))) return tMain('mainUpgrades.blocked.folderMissing')
    if (deps.isGameRunning(game.id)) return tMain('mainUpgrades.blocked.closeGame')
    return null
  }

  const steamAppId = (game: Game): string | null => {
    if (game.source !== 'steam') return null
    const id = steamAppIdOf(game)
    return id ? String(id) : null
  }

  /** A part of the status that failed is logged and left at its "nothing known" value. */
  const safe = async <T>(what: string, work: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work
    } catch (err) {
      log.warn(`${what}: ${errorText(err)}`)
      return fallback
    }
  }

  // --- The status's folder walks (upscaler files, anti-cheat, OptiScaler's manifests), kept per game ---
  // A walk of a huge game can take long: upgradeStatus waits for one at most `scanWait`, then answers with the last
  // result (or none) while the walk goes on and keeps its result for the next opening. Results are kept for a few
  // minutes per game and folder, and dropped when an action starts or ends on the game (it may have changed files).
  interface WalkResult<T> {
    value: T
    dir: string
    gen: number
    at: number
  }
  const walkResults = new Map<string, WalkResult<unknown>>()
  const walksRunning = new Map<string, { dir: string; gen: number; promise: Promise<unknown> }>()
  /** Bumped per game by forgetWalks: a walk started before is not kept when it ends. */
  const walkGen = new Map<string, number>()
  const forgetWalks = (gameId: string): void => {
    walkGen.set(gameId, (walkGen.get(gameId) ?? 0) + 1)
    for (const key of [...walkResults.keys()])
      if (key.startsWith(`${gameId}\n`)) walkResults.delete(key)
  }
  /**
   * One folder walk of the status: the kept result when it is recent, else the walk (shared with a caller already
   * waiting for it) for at most `scanWait`. `timedOut` with the last result of this folder (or undefined) when the walk
   * takes longer. A failed walk rejects (the caller decides what that means).
   */
  const walk = async <T>(
    gameId: string,
    dir: string,
    part: string,
    load: () => Promise<T>
  ): Promise<{ value: T | undefined; timedOut: boolean }> => {
    const key = `${gameId}\n${part}`
    const gen = walkGen.get(gameId) ?? 0
    const kept = walkResults.get(key) as WalkResult<T> | undefined
    const last = kept && kept.gen === gen && samePath(kept.dir, dir) ? kept : undefined
    if (last && now() - last.at < WALK_MAX_AGE_MS) return { value: last.value, timedOut: false }
    let running = walksRunning.get(key)
    if (!running || running.gen !== gen || !samePath(running.dir, dir)) {
      const promise = load().then((value) => {
        if ((walkGen.get(gameId) ?? 0) === gen) walkResults.set(key, { value, dir, gen, at: now() })
        return value
      })
      const started = { dir, gen, promise }
      const done = (): void => {
        if (walksRunning.get(key) === started) walksRunning.delete(key)
      }
      // Also marks a failure that comes after the status stopped waiting as handled.
      promise.then(done, done)
      running = started
      walksRunning.set(key, running)
    }
    let timer: NodeJS.Timeout | undefined
    const late = Symbol('late')
    try {
      const out = await Promise.race([
        running.promise as Promise<T>,
        new Promise<typeof late>((r) => {
          timer = setTimeout(() => r(late), scanWait)
        })
      ])
      if (out === late) {
        log.info(`${dir}: ${part} takes long; showing the last result meanwhile`)
        return { value: last?.value, timedOut: true }
      }
      return { value: out, timedOut: false }
    } finally {
      clearTimeout(timer)
    }
  }

  /** The anti-cheat names a scan's result shows (an incomplete scan that found nothing proves nothing: unknown). */
  const antiCheatOf = (scan: Awaited<ReturnType<UpgradeModules['scanAntiCheat']>>): string[] =>
    !scan.complete && scan.names.length === 0 ? [antiCheatUnknown()] : scan.names

  const riskOf = async (game: Game, dir: string): Promise<UpgradeRisk> => {
    const tags = gameRiskTags(game)
    try {
      const scan = await walk(game.id, dir, 'anti-cheat', () => m.scanAntiCheat(dir))
      // Not checked in time and never checked before: unknown, so the warning still shows.
      return { tags, antiCheat: scan.value ? antiCheatOf(scan.value) : [antiCheatUnknown()] }
    } catch (err) {
      if (!(err instanceof AntiCheatScanError))
        log.warn(`${dir}: anti-cheat scan: ${errorText(err)}`)
      return { tags, antiCheat: [antiCheatUnknown()] }
    }
  }

  const emptyStatus = (gameId: string, gpu: GpuInfo | null, blocked: string): UpgradeStatus => ({
    gameId,
    gpu,
    risk: { tags: [], antiCheat: [] },
    blocked,
    dlls: { found: [], kinds: [], latest: {}, updatable: false, restorable: false },
    dlss5: { unavailable: blocked, appReady: false },
    shaders: { unavailable: blocked, compiledAt: null, note: null },
    optiscaler: { installed: null, latest: null, hasInputs: false },
    compress: {
      state: 'none',
      size: null,
      onDisk: null,
      estimatedSaving: null,
      unavailable: blocked
    },
    busy: jobs.get(gameId)?.upgrade ?? null,
    scanning: false
  })

  const dlss5Unavailable = (gpu: GpuInfo | null): string | null =>
    gpu?.vendor === 'nvidia' && gpu.rtxSeries !== null
      ? null
      : gpu
        ? tMain('mainUpgrades.gpu.needsRtx')
        : tMain('mainUpgrades.gpu.notDetected')

  /**
   * Only Intel graphics turn precompiling off. What SCSKiller last said it could not do for the game is a note, not a
   * lock: a later scan of SCSKiller's, a driver update or a recording can change it, so the player can always try again.
   */
  const shadersUnavailable = (gpu: GpuInfo | null): string | null =>
    gpu?.vendor === 'intel' ? tMain('mainUpgrades.gpu.notIntel') : null

  const statusOf = async (game: Game, freshMeasure = false): Promise<UpgradeStatus> => {
    const gpu = await detectGpu()
    const blocked = await blockedReason(game)
    // A running game still shows what it has; anything else that blocks shows nothing more.
    if (blocked && !deps.isGameRunning(game.id)) {
      const status = emptyStatus(game.id, gpu, blocked)
      status.risk.tags = gameRiskTags(game)
      return status
    }
    const dir = game.installDir!
    const facts = await factsOf(game.id)
    const appId = steamAppId(game)
    const busy = jobs.get(game.id)?.upgrade ?? null

    const measured = (async (): Promise<Measure | null> => {
      // A measure from before the last compression does not tell its state.
      const last =
        facts.measure &&
        samePath(facts.measure.dir, dir) &&
        facts.measure.at >= (facts.compressedAt ?? 0)
          ? facts.measure
          : null
      // While an action runs on the game its folder is changing: the action measures it when it ends.
      if (busy) return last
      // A measure of the folder as it is now, however long it takes (one already running is shared).
      if (freshMeasure) return measure(game.id, dir)
      if (last && now() - last.at < MEASURE_MAX_AGE_MS) return last
      return raceTimeout(measure(game.id, dir), measureWait, last).then((v) => v ?? last)
    })()

    // A walk that has not answered yet (no earlier result): the rows it feeds wait (`scanning`).
    let pending = false
    const [
      risk,
      found,
      installed,
      optiFiles,
      compressBlocked,
      vendor,
      opti,
      savings,
      measureNow,
      aioExe
    ] = await Promise.all([
      riskOf(game, dir),
      safe(
        'upscaler files',
        walk(game.id, dir, 'upscaler files', () => m.scanDlls(dir)).then((w) => {
          if (w.value === undefined) pending = true
          return w.value ?? []
        }),
        [] as Awaited<ReturnType<UpgradeModules['scanDlls']>>
      ),
      safe(
        'OptiScaler',
        walk(game.id, dir, 'OptiScaler', () => m.findOptiScalerInstall(dir)).then((w) => {
          if (w.value === undefined) pending = true
          return w.value ?? null
        }),
        null
      ),
      safe(
        "OptiScaler's files",
        walk(game.id, dir, "OptiScaler's files", () => m.optiScalerFiles(dir)).then(
          (w) => w.value ?? []
        ),
        [] as string[]
      ),
      safe('compression check', unavailableToCompress(dir), null),
      vendorDlls.get(lookupWait).then((v) => v?.files ?? null),
      optiscalerRelease.get(lookupWait),
      appId ? compactDb().then((db) => db.get(lookupWait)) : Promise.resolve(null),
      measured,
      safe('DLSS AiO Swapper', findAioExe(), null)
    ])

    const latest: UpgradeStatus['dlls']['latest'] = {}
    for (const f of found) latest[f.kind] = vendor?.[f.kind]?.version ?? null
    const cleanFound: FoundUpscalerDll[] = found.map((f) => ({
      kind: f.kind,
      relPath: f.relPath,
      version: f.version,
      swapped: f.swapped
    }))
    return {
      gameId: game.id,
      gpu,
      risk,
      blocked,
      dlls: {
        found: cleanFound,
        kinds: dllKindSummaries(found, notOptiScalers(found, optiFiles), vendor ?? {}),
        latest,
        updatable: notOptiScalers(found, optiFiles).some((f) => canUpdate(f, vendor?.[f.kind])),
        restorable: found.some((f) => f.swapped)
      },
      dlss5: { unavailable: dlss5Unavailable(gpu), appReady: aioExe !== null },
      shaders: {
        unavailable: shadersUnavailable(gpu),
        compiledAt: facts.compiledAt ?? null,
        note: facts.shadersUnsupported ?? null
      },
      optiscaler: {
        installed,
        latest: opti?.version ?? null,
        hasInputs: found.length > 0
      },
      compress: {
        state: measureNow?.state ?? (facts.compressedAt ? 'compressed' : 'none'),
        size: measureNow?.size ?? game.installSize?.bytes ?? null,
        onDisk: measureNow?.onDisk ?? null,
        estimatedSaving: appId ? (savings?.[appId] ?? null) : null,
        unavailable: compressBlocked
      },
      busy,
      scanning: pending
    }
  }

  // --- Actions ---
  const checkStop = (signal: AbortSignal): void => {
    if (signal.aborted) throw new Stopped(tMain('mainUpgrades.stopped'))
  }

  /** Downloads that stop with the action. */
  const downloader =
    (signal: AbortSignal) =>
    (d: ResolvedDownload, dir: string): Promise<string> =>
      deps.http.download(d, dir, signal)
  /** Unpacking with 7-Zip's extractor in UpgradesTools. */
  const extractor = async (): Promise<(file: string, destDir: string) => Promise<void>> => {
    const toolsDir = join(await upgradesDir(), 'Tools')
    return (file, destDir) => deps.archive.extract(file, destDir, toolsDir)
  }

  const updateDlls = async (
    game: Game,
    dir: string,
    report: Report,
    signal: AbortSignal
  ): Promise<Outcome> => {
    report(null, tMain('mainUpgrades.dlls.looking'))
    const scanned = await m.scanDlls(dir)
    if (scanned.length === 0)
      return { ok: false, message: tMain('mainUpgrades.dlls.none', { title: game.title }) }
    // OptiScaler's files are its own to remove; when its manifests cannot be read the update stops (nothing changed).
    const found = notOptiScalers(scanned, await m.optiScalerFiles(dir))
    report(null, tMain('mainUpgrades.dlls.lookingUp'))
    const latest = (await vendorDlls.current())?.files
    if (!latest)
      return {
        ok: false,
        message: tMain('mainUpgrades.dlls.lookupFailed')
      }
    const kinds = [...new Set(found.filter((f) => canUpdate(f, latest[f.kind])).map((f) => f.kind))]
    if (kinds.length === 0)
      return { ok: true, message: tMain('mainUpgrades.dlls.alreadyNewest', { title: game.title }) }
    const cacheDir = join(await upgradesDir(), 'DLLs')
    const files: Partial<Record<UpscalerDllKind, { path: string; version: string }>> = {}
    for (const [i, kind] of kinds.entries()) {
      checkStop(signal)
      const file = latest[kind]!
      report(
        i / (kinds.length + 1),
        tMain('mainUpgrades.dlls.downloading', {
          name: DLL_NAMES[kind],
          version: displayVersion(kind, file.version)
        })
      )
      const path = await m.ensureVendorDll(file, cacheDir, {
        download: downloader(signal),
        verifySigner: deps.verifySigner
      })
      files[kind] = { path, version: file.version }
    }
    checkStop(signal)
    report(kinds.length / (kinds.length + 1), tMain('mainUpgrades.dlls.replacing'))
    const { replaced, skipped } = await m.swapDlls(dir, found, files)
    if (replaced.length === 0) {
      const reason = skipped[0]?.reason
      return {
        ok: false,
        message: reason
          ? tMain('mainUpgrades.dlls.nothingReplacedWhy', { reason })
          : tMain('mainUpgrades.dlls.nothingReplaced')
      }
    }
    await setFacts(game.id, (f) => {
      f.dllsUpdatedAt = new Date(now()).toISOString()
    })
    const changes = new Map<UpscalerDllKind, string>()
    for (const rel of replaced) {
      const f = found.find((x) => x.relPath === rel)
      if (!f || changes.has(f.kind)) continue
      const to = displayVersion(f.kind, files[f.kind]!.version)
      changes.set(
        f.kind,
        `${DLL_NAMES[f.kind]} ${f.version ? `${displayVersion(f.kind, f.version)} → ` : ''}${to}`
      )
    }
    const vars = { title: game.title, changes: [...changes.values()].join(', ') }
    return {
      ok: true,
      message: skipped.length
        ? tMain('mainUpgrades.dlls.replacedSkipped', {
            ...vars,
            skipped: skipped.length,
            reason: skipped[0]!.reason
          })
        : tMain('mainUpgrades.dlls.replaced', vars)
    }
  }

  const restore = async (game: Game, dir: string, report: Report): Promise<Outcome> => {
    report(null, tMain('mainUpgrades.dlls.restoring'))
    const found = await m.scanDlls(dir)
    const { restored, failed } = await m.restoreDlls(dir, found)
    if (failed.length && restored.length === 0)
      return {
        ok: false,
        message: tMain('mainUpgrades.dlls.restoreFailed', { reason: failed[0]!.reason })
      }
    const vars = { title: game.title, count: restored.length }
    return {
      ok: true,
      message: failed.length
        ? tMain('mainUpgrades.dlls.restoredSomeFailed', {
            ...vars,
            failed: failed.length,
            reason: failed[0]!.reason
          })
        : tMain('mainUpgrades.dlls.restored', vars)
    }
  }

  const openDlss5 = async (
    game: Game,
    dir: string,
    report: Report,
    signal: AbortSignal
  ): Promise<Outcome> => {
    const unavailable = dlss5Unavailable(await detectGpu())
    if (unavailable)
      return {
        ok: false,
        message: tMain('mainUpgrades.dlss5.unavailable', { reason: unavailable })
      }
    let exe = await findAioExe()
    report(null, tMain('mainUpgrades.aio.lookingUp'))
    const release = await aioRelease.current()
    if (release && (!exe || basename(exe).toLowerCase() !== release.fileName.toLowerCase())) {
      checkStop(signal)
      report(null, tMain('mainUpgrades.aio.downloading', { version: release.version }))
      try {
        exe = await m.ensureAioSwapper(release, await upgradesDir(), {
          download: downloader(signal)
        })
      } catch (err) {
        if (!exe) throw err
        log.warn(
          `DLSS AiO Swapper ${release.version}: ${errorText(err)}; opening the copy already here`
        )
      }
    }
    if (!exe)
      return {
        ok: false,
        message: tMain('mainUpgrades.aio.downloadFailed')
      }
    checkStop(signal)
    const isRunning = deps.isProcessRunning
    const name = basename(exe)
    await m.openAioSwapper(exe, dir, {
      spawnDetached: deps.spawnDetached,
      isAppRunning: isRunning ? () => isRunning(name) : undefined
    })
    return { ok: true, message: tMain('mainUpgrades.aio.opened', { title: game.title }) }
  }

  const precompile = async (
    game: Game,
    dir: string,
    report: Report,
    signal: AbortSignal
  ): Promise<Outcome> => {
    const gpu = await detectGpu()
    if (gpu?.vendor === 'intel')
      return { ok: false, message: tMain('mainUpgrades.shaders.notIntel') }
    let exe = await findScsKillerExe()
    report(null, tMain('mainUpgrades.shaders.lookingUp'))
    const release = await scsKillerRelease.current()
    if (release) {
      checkStop(signal)
      report(
        null,
        exe
          ? tMain('mainUpgrades.shaders.gettingReady')
          : tMain('mainUpgrades.shaders.downloading', { version: release.version })
      )
      try {
        exe = await m.ensureScsKiller(release, await upgradesDir(), {
          download: downloader(signal),
          fetchText: deps.http.fetchText,
          extractZip: await extractor(),
          sha256: sha256File
        })
      } catch (err) {
        if (!exe) throw err
        log.warn(`SCSKiller ${release.version}: ${errorText(err)}; using the copy already here`)
      }
    }
    if (!exe)
      return {
        ok: false,
        message: tMain('mainUpgrades.shaders.downloadFailed')
      }
    checkStop(signal)
    await m.disableRecorder(scsKillerDataDir(exe))
    const appId = steamAppId(game)
    const result = await m.compileShaders(
      exe,
      {
        ...(appId ? { steamAppId: appId } : {}),
        installDir: dir,
        title: game.title,
        ...(game.exePath ? { exePath: game.exePath } : {})
      },
      ({ progress, message }) => report(progress, message),
      signal,
      { spawn: deps.spawnTool }
    )
    if (signal.aborted) throw new Stopped(tMain('mainUpgrades.stopped'))
    if (result.ok)
      await setFacts(game.id, (f) => {
        f.compiledAt = new Date(now()).toISOString()
        delete f.shadersUnsupported
      })
    else if (result.unsupported)
      await setFacts(game.id, (f) => {
        f.shadersUnsupported = result.message
      })
    return {
      ok: result.ok,
      message: tMain('mainUpgrades.titled', { title: game.title, message: result.message })
    }
  }

  const installOpti = async (
    game: Game,
    dir: string,
    report: Report,
    signal: AbortSignal
  ): Promise<Outcome> => {
    const found = await m.scanDlls(dir)
    if (found.length === 0)
      return {
        ok: false,
        message: tMain('mainUpgrades.opti.noUpscaler')
      }
    const exeDir = await m.pickExeDir(dir, game.exePath)
    if (!exeDir) return { ok: false, message: tMain('mainUpgrades.opti.noProgram') }
    report(null, tMain('mainUpgrades.opti.lookingUp'))
    const release = await optiscalerRelease.current()
    if (!release)
      return {
        ok: false,
        message: tMain('mainUpgrades.opti.lookupFailed')
      }
    checkStop(signal)
    report(null, tMain('mainUpgrades.opti.downloading', { version: release.version }))
    const packageDir = await m.ensureOptiScaler(release, join(await upgradesDir(), 'OptiScaler'), {
      download: (file, into) =>
        downloader(signal)(
          {
            version: release.version,
            url: file.url,
            fileName: file.fileName,
            ...(file.size > 0 ? { size: file.size } : {}),
            ...(file.sha256 ? { sha256: file.sha256 } : {})
          },
          into
        ),
      extract7z: await extractor(),
      verifySigner: deps.verifySigner
    })
    checkStop(signal)
    report(0.8, tMain('mainUpgrades.opti.installing'))
    const gpu = await detectGpu()
    const done = await m.installOptiScaler(exeDir, packageDir, {
      gpuVendor: gpu?.vendor ?? 'other',
      version: release.version,
      installDir: dir
    })
    return {
      ok: true,
      message: tMain('mainUpgrades.opti.installed', {
        title: game.title,
        version: done.version,
        file: done.asName
      })
    }
  }

  const removeOpti = async (game: Game, dir: string, report: Report): Promise<Outcome> => {
    report(null, tMain('mainUpgrades.opti.removing'))
    const left = await m.removeOptiScaler(dir)
    return {
      ok: true,
      message: left.length
        ? tMain('mainUpgrades.opti.removedKept', {
            title: game.title,
            count: left.length,
            files: left.slice(0, 3).join(', ')
          })
        : tMain('mainUpgrades.opti.removed', { title: game.title })
    }
  }

  const compressGame = async (
    game: Game,
    dir: string,
    algorithm: CompressAlgorithm,
    report: Report,
    signal: AbortSignal
  ): Promise<Outcome> => {
    report(null, tMain('mainUpgrades.compress.checkingDrive'))
    const unavailable = await unavailableToCompress(dir)
    if (unavailable) return { ok: false, message: unavailable }
    const facts = await factsOf(game.id)
    folderChanging(game.id)
    const result = await m
      .compressFolder(
        dir,
        algorithm,
        ({ progress, message }) => report(progress, message),
        signal,
        { spawn: deps.spawnCompact, freeSpace },
        { previousAlgorithm: facts.compressAlgorithm ?? null }
      )
      .catch(async (err: unknown) => {
        // Some files may have changed before the error: measured again in the background.
        await remeasure(game.id, dir)
        throw err
      })
    if (signal.aborted || !result.ok) {
      // Stopped or failed part way: the files done so far are compressed, the rest are not. The facts stay as they
      // were (the earlier compression time and algorithm, if any), so files the run did not reach are not taken for
      // compressed ones: a fresh measure reads a folder with uncompressed files as 'partial' and Compress again is
      // offered. The job ends now; the measure (minutes on a huge game) goes on in the background.
      await remeasure(game.id, dir)
      if (signal.aborted) throw new Stopped(tMain('mainUpgrades.compress.stopped'))
      return result
    }
    await setFacts(game.id, (f) => {
      f.compressedAt = now()
      f.compressAlgorithm = algorithm
    })
    report(null, tMain('mainUpgrades.compress.measuring'))
    const after = await (await remeasure(game.id, dir)).measured
    if (!after)
      return {
        ok: true,
        message: tMain('mainUpgrades.compress.done', { title: game.title, message: result.message })
      }
    return {
      ok: true,
      message: tMain('mainUpgrades.compress.doneSize', {
        title: game.title,
        before: formatSize(after.size),
        after: formatSize(after.onDisk)
      })
    }
  }

  const uncompressGame = async (
    game: Game,
    dir: string,
    report: Report,
    signal: AbortSignal
  ): Promise<Outcome> => {
    const facts = await factsOf(game.id)
    const before = facts.measure && samePath(facts.measure.dir, dir) ? facts.measure : null
    folderChanging(game.id)
    const result = await m
      .uncompressFolder(
        dir,
        ({ progress, message }) => report(progress, message),
        signal,
        { spawn: deps.spawnCompact, freeSpace },
        { onDisk: before?.onDisk ?? null }
      )
      .catch(async (err: unknown) => {
        await remeasure(game.id, dir)
        throw err
      })
    if (signal.aborted || !result.ok) {
      // Some files are uncompressed now: measured again in the background (the job ends at once).
      await remeasure(game.id, dir)
      if (signal.aborted) throw new Stopped(tMain('mainUpgrades.uncompress.stopped'))
      return result
    }
    await setFacts(game.id, (f) => {
      delete f.compressedAt
      delete f.compressAlgorithm
    })
    report(null, tMain('mainUpgrades.compress.measuring'))
    const after = await (await remeasure(game.id, dir)).measured
    if (!after)
      return {
        ok: true,
        message: tMain('mainUpgrades.uncompress.done', {
          title: game.title,
          message: result.message
        })
      }
    return {
      ok: true,
      message: before
        ? tMain('mainUpgrades.uncompress.doneSize', {
            title: game.title,
            before: formatSize(before.onDisk),
            after: formatSize(after.onDisk)
          })
        : tMain('mainUpgrades.uncompress.doneAfter', {
            title: game.title,
            after: formatSize(after.onDisk)
          })
    }
  }

  const perform = (
    game: Game,
    action: UpgradeAction,
    report: Report,
    signal: AbortSignal
  ): Promise<Outcome> => {
    const dir = game.installDir!
    switch (action.kind) {
      case 'dlls-update':
        return updateDlls(game, dir, report, signal)
      case 'dlls-restore':
        return restore(game, dir, report)
      case 'dlss5-open':
        return openDlss5(game, dir, report, signal)
      case 'shaders-compile':
        return precompile(game, dir, report, signal)
      case 'optiscaler-install':
        return installOpti(game, dir, report, signal)
      case 'optiscaler-remove':
        return removeOpti(game, dir, report)
      case 'compress':
        return compressGame(game, dir, action.algorithm, report, signal)
      case 'uncompress':
        return uncompressGame(game, dir, report, signal)
    }
  }

  const emit = (p: UpgradeProgress): void => {
    deps.events.emit('upgrades:progress', p)
  }

  return {
    async upgradeStatus(gameId, opts) {
      return statusOf(gameOf(gameId), opts?.freshMeasure === true)
    },

    async runUpgrade(gameId, action) {
      if (disposed) throw new Error(tMain('mainUpgrades.closing'))
      const game = gameOf(gameId)
      if (jobs.has(gameId)) throw new Error(tMain('mainUpgrades.alreadyRunning'))
      const blocked = await blockedReason(game)
      if (blocked) throw new Error(blocked)
      if (jobs.has(gameId)) throw new Error(tMain('mainUpgrades.alreadyRunning'))
      const upgrade = upgradeOf(action)
      const controller = new AbortController()
      // Running lines are sent at most every PROGRESS_THROTTLE_MS; one held back is sent when that time is up (or
      // before the final line), so the last running line always reaches the menu even when the action then pauses.
      let lastEmit = 0
      let held: { progress: number | null; message: string } | null = null
      let heldTimer: NodeJS.Timeout | undefined
      const send = (progress: number | null, message: string): void => {
        clearTimeout(heldTimer)
        heldTimer = undefined
        held = null
        lastEmit = now()
        emit({ gameId, upgrade, state: 'running', progress, message })
      }
      const flushHeld = (): void => {
        if (held) send(held.progress, held.message)
      }
      const report: Report = (progress, message) => {
        if (controller.signal.aborted) return
        const wait = PROGRESS_THROTTLE_MS - (now() - lastEmit)
        if (wait <= 0 || progress === null || progress >= 1) return send(progress, message)
        held = { progress, message }
        heldTimer ??= setTimeout(() => {
          heldTimer = undefined
          if (!controller.signal.aborted) flushHeld()
        }, wait)
      }
      log.info(
        `${game.title}: ${action.kind}${action.kind === 'compress' ? ` (${action.algorithm})` : ''}`
      )
      emit({
        gameId,
        upgrade,
        state: 'running',
        progress: null,
        message: tMain('mainUpgrades.starting')
      })
      lastEmit = now()
      const job: Job = { upgrade, controller, done: Promise.resolve() }
      jobs.set(gameId, job)
      // The action may change the files the status's folder walks read: they are walked again afterwards.
      forgetWalks(gameId)
      job.done = (async () => {
        let outcome: Outcome
        try {
          outcome = await perform(game, action, report, controller.signal)
        } catch (err) {
          outcome = {
            ok: false,
            message:
              err instanceof Stopped ? err.message : errorText(err) || tMain('mainUpgrades.failed')
          }
          if (!(err instanceof Stopped))
            log.warn(`${game.title}: ${action.kind} failed: ${errorText(err)}`)
        }
        // A running line held back by the throttle goes out before the final one (unless the player stopped it).
        if (!controller.signal.aborted) flushHeld()
        clearTimeout(heldTimer)
        forgetWalks(gameId)
        jobs.delete(gameId)
        log.info(`${game.title}: ${action.kind}: ${outcome.message}`)
        emit({
          gameId,
          upgrade,
          state: outcome.ok ? 'done' : 'failed',
          progress: outcome.ok ? 1 : null,
          message: outcome.message
        })
      })()
      return statusOf(game)
    },

    async cancelUpgrade(gameId) {
      const job = jobs.get(gameId)
      if (!job) return
      job.controller.abort()
    },

    busyFor(gameId) {
      return jobs.get(gameId)?.upgrade ?? null
    },

    anyBusy() {
      return jobs.size > 0
    },

    async dispose() {
      disposed = true
      const running = [...jobs.values()]
      for (const job of running) job.controller.abort()
      await raceTimeout(Promise.all(running.map((j) => j.done)), 5000, undefined)
      await loaded
      await store.flush()
    }
  }
}

/** `<exeDir>\Upgrades`: where the upgrades keep their tools (kept by the installer's update). */
export function upgradesDirBeside(exeDir: string): string {
  return join(exeDir, UPGRADES_FOLDER)
}
