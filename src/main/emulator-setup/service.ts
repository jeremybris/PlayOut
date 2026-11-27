import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'fs'
import { promises as fs } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import { z } from 'zod'
import type {
  EmulatorSetupItem,
  EmulatorSetupProgress,
  EmulatorSetupStatus,
  EmulatorUpdateItem,
  EmulatorUpdateReport,
  Settings,
  SettingsPatch
} from '../../shared/types'
import { emulationDirOf } from '../emulation/emulation-dir'
import { registryValue } from '../system/registry'
import { isFile, pathExists, renameRetry, RM_RETRY } from '../util/fs'
import { extractArchive as realExtractArchive } from './archive'
import { syncBios as realSyncBios } from './bios'
import { EMULATOR_CATALOG } from './catalog'
import {
  addModel2RomDir,
  configureVersionOf,
  configureEmulator as realConfigureEmulator,
  localizeRpcs3Vfs
} from './configure'
import { downloadFile as realDownloadFile, type HttpDeps } from './download'
import {
  DRIVE_MARKER,
  downloadDriveFolder as realDownloadDriveFolder,
  type DriveFolderSource
} from './drive-folder'
import { PRESETS, PRESETS_VERSION } from './presets'
import { refreshRyujinxControllers as realRefreshRyujinxControllers } from './presets/ryujinx'
import { PresetDeferredError, type ApplyPresets, type PresetContext } from './presets/types'
import {
  BACKGROUND_SCAN_TIMEOUT_MS,
  ensurePcsx2GameListed,
  listPcsx2Games,
  pcsx2GamesNeedingWork,
  pcsx2RestorePending,
  type GameListResult,
  pcsx2Scannable,
  restoreAfterScan
} from './pcsx2-game-list'
import { fixSharedMemoryCard } from './pcsx2-memory-cards'
import { runElevated as realRunElevated, runProcess, startHidden as realStartHidden } from './run'
import {
  ensureRuntimes as realEnsureRuntimes,
  runtimesMissing as realRuntimesMissing
} from './runtimes'
import type { RuntimeDeps } from './runtimes'
import { journalOf, keepRule, overlayFolder, recoverOverlay } from './overlay'
import { ensureSevenZip as realEnsureSevenZip } from './sevenzip'
import { resolveSource as realResolveSource } from './sources'
import type {
  EmulatorSpec,
  Logger,
  ResolvedDownload,
  Runner,
  RuntimeId,
  SetupManifest
} from './types'
import { tMain } from '../i18n'

/** The emulator setup: downloads, unpacks and sets up the catalog's emulators (docs/emulator-setup.md). */
export interface EmulatorSetupService {
  /**
   * At launch: first-time setup while the root's manifest is not completed, then reconfigure for a changed data folder
   * and sync BIOS files. Never throws.
   */
  startup(): Promise<void>
  status(): Promise<EmulatorSetupStatus>
  /** Install these emulators (every missing one when omitted); resolves when the run that covers them ends. */
  setup(ids?: string[]): Promise<EmulatorSetupStatus>
  /**
   * Update all emulators: every installed emulator to the newest build of its update channel (nightly where the project
   * publishes one). Runs after any setup run; a second call joins the running one. Resolves with the status (its
   * lastUpdate is the report).
   */
  update(): Promise<EmulatorSetupStatus>
  /**
   * The executable PlayOut installed for this find-rules id: from the manifest, else <root>\<folder>\<exe> when it
   * exists (an install the manifest lost). The caller checks a manifest path exists.
   */
  managedExe(id: string): string | null
  /**
   * The names of PlayOut's emulators running now (by their exe name; empty when the process list cannot be read):
   * the Emulation folder is not moved under them.
   */
  runningEmulators?(): Promise<string[]>
  /**
   * Just before PlayOut starts an emulator game (`exe`: the executable it starts). For the Ryujinx PlayOut installed,
   * the controller entries PlayOut wrote are matched to the pads connected now (at most 5 s); for PCSX2, a PCSX2 still
   * closing is waited for and the game list and memory card checks run (no scan: that is the background pre-warm's).
   * `context.endedMsAgo`: how long ago a game PlayOut started with the same emulator ended, `context.pid` that game's
   * process (the launcher tracks both). A background PCSX2 scan stops first. Never throws.
   */
  beforeLaunch(
    id: string,
    exe?: string,
    rom?: string,
    context?: { endedMsAgo?: number; pid?: number }
  ): Promise<void>
  /**
   * Asks for a background pass that lets PCSX2 scan the PS2 games it does not list yet (the library's, `pcsx2Roms`,
   * and the ones launched before they were listed). Debounced; it runs only while no game and no PCSX2 runs, one
   * hidden scan at a time, and stops when a game launches. Call after a session ends and when the library gained
   * games.
   */
  prewarmPcsx2(): void
  /**
   * Stops everything. Resolves once a background PCSX2 scan was closed and its settings put back, or after
   * DISPOSE_WAIT_MS (never rejects).
   */
  dispose(): Promise<void>
}

/** The module functions the service drives (injectable for tests). */
export interface EmulatorSetupModules {
  resolveSource: typeof realResolveSource
  downloadFile: typeof realDownloadFile
  /** Downloads a 'drive-folder' source (an unpacked emulator folder) file by file. */
  downloadDriveFolder: typeof realDownloadDriveFolder
  ensureSevenZip: typeof realEnsureSevenZip
  extractArchive: typeof realExtractArchive
  configureEmulator: typeof realConfigureEmulator
  syncBios: typeof realSyncBios
  ensureRuntimes: typeof realEnsureRuntimes
  runtimesMissing: typeof realRuntimesMissing
}

/** How long a PCSX2 launch waits for a PCSX2 that is still closing. */
export const PCSX2_CLOSE_WAIT_MS = 15_000

export interface EmulatorSetupDeps {
  settings: {
    get(): Settings
    update(patch: SettingsPatch): unknown
    onChange?(listener: (settings: Settings) => void): () => void
  }
  userData: string
  /** The folder of PlayOut.exe: PORTABLE_EXECUTABLE_DIR || dirname(process.execPath). */
  exeDir: string
  /**
   * The folders PlayOut ran from before, when it moved since (util/install-move.ts): emulator paths saved inside their
   * Emulators folder (Browse, RetroArch cores) follow to this one.
   */
  previousExeDirs?: string[]
  emit(progress: EmulatorSetupProgress): void
  log: Logger
  /** Called after a run installed at least one emulator (the emulator resolver drops its cache). */
  onInstalled?(): void
  /** The emulators to set up (tests); defaults to EMULATOR_CATALOG. */
  catalog?: readonly EmulatorSpec[]
  fetch?: typeof fetch
  run?: Runner
  runElevated?(file: string, args: string[]): Promise<number | null>
  readRegistry?(hive: 'HKLM' | 'HKCU', key: string, valueName: string): Promise<string | null>
  modules?: Partial<EmulatorSetupModules>
  /** Emulators set up at once (default 3). */
  concurrency?: number
  /** The fullscreen and controller presets per id (tests); defaults to presets/index.ts PRESETS. */
  presets?: Record<string, ApplyPresets>
  /** The presets version recorded in the manifest (tests); defaults to PRESETS_VERSION. */
  presetsVersion?: number
  /** Tests: the current configure version of an emulator (configure.ts configureVersionOf). */
  configureVersionOf?: (id: string) => number
  startHidden?: PresetContext['startHidden']
  refreshRyujinxControllers?: typeof realRefreshRyujinxControllers
  /** How long beforeLaunch may hold a launch (default 5000 ms). */
  beforeLaunchTimeoutMs?: number
  /** Waits between checks while a PCSX2 still closes (tests). */
  sleep?: (ms: number) => Promise<void>
  /** Delay before reconfiguring after the data folder changes (default 1500 ms). */
  debounceMs?: number
  /** Minimum gap between progress events (default 250 ms: at most 4 per second). */
  progressIntervalMs?: number
  now?: () => number
  /** The Program Files folders no root may be under (tests); defaults to %ProgramFiles%, %ProgramW6432%, %ProgramFiles(x86)%. */
  programFilesDirs?: string[]
  /** Whether a game session runs (the launcher's); the PCSX2 pre-warm waits while one does. */
  isGameRunning?: () => boolean
  /** The PS2 game files of the library, for the PCSX2 pre-warm. */
  pcsx2Roms?: () => string[]
  /** Whether a process lives (default: process.kill(pid, 0); EPERM counts as alive). */
  isPidAlive?: (pid: number) => boolean
  /** Delay before a pre-warm pass (default 5000 ms; debounces its triggers). */
  prewarmDelayMs?: number
  /** Time limit of a pre-warm's hidden scan, closing included (default BACKGROUND_SCAN_TIMEOUT_MS). */
  prewarmScanTimeoutMs?: number
  /**
   * How often, after a background scan stopped by another PCSX2, PlayOut checks whether PCSX2 is closed to put the
   * scan's settings back (default RESTORE_CHECK_MS).
   */
  restoreCheckMs?: number
}

/** No pre-warm scan starts this long after a launch began (its emulator may not show up as a session yet). */
export const PREWARM_QUIET_MS = 30_000
/** At most this many games go into one pre-warm scan (the rest wait for the next pass). */
export const PREWARM_BATCH = 300
/**
 * Update all emulators leaves an emulator alone when PlayOut began launching it this recently (the launch may not show
 * in the process list yet).
 */
export const LAUNCH_QUIET_MS = 15_000
/** dispose waits at most this long for a background PCSX2 scan to close and put its settings back. */
export const DISPOSE_WAIT_MS = 5_000
/** After a background scan another PCSX2 stopped: how often to check that PCSX2 is closed to put its settings back. */
export const RESTORE_CHECK_MS = 60_000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const manifestSchema = z.object({
  version: z.literal(1),
  installed: z.record(
    z.string(),
    z.object({
      version: z.string(),
      exe: z.string().min(1),
      installedAt: z.string(),
      source: z.literal('drive-folder').optional(),
      channel: z.string().max(40).optional(),
      updatedAt: z.string().optional()
    })
  ),
  configuredFor: z.string().nullable(),
  // Manifests written before configure versions: every emulator at version 1.
  configured: z.record(z.string(), z.number()).default({}),
  // Manifests written before the flag existed: not completed (startup's setup run then finds nothing missing).
  completed: z.boolean().default(false),
  // Manifests written before the presets existed: none applied (startup applies them to the installed emulators).
  presets: z.record(z.string(), z.number()).default({})
})

function emptyManifest(): SetupManifest {
  return {
    version: 1,
    installed: {},
    configuredFor: null,
    configured: {},
    completed: false,
    presets: {}
  }
}

function parseManifest(text: string): SetupManifest {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(text.replace(/^\uFEFF/, '')))
    return parsed.success ? parsed.data : emptyManifest()
  } catch {
    return emptyManifest()
  }
}

/** <root>\.playout: PlayOut's own files under the emulators root. */
function playoutDir(root: string): string {
  return join(root, '.playout')
}

function manifestPath(root: string): string {
  return join(playoutDir(root), 'emulators.json')
}

/** The two places the emulators root can be: next to PlayOut.exe, else in the settings folder. */
export function emulatorRootCandidates(exeDir: string, userData: string): [string, string] {
  return [join(exeDir, 'Emulators'), join(userData, 'Emulators')]
}

/** Where PlayOut 0.1.81 put the emulators: <PlayOut.exe folder>\Emulation. */
export function legacyEmulatorRoot(exeDir: string): string {
  return join(exeDir, 'Emulation')
}

/** `path` moved from under `from` to under `to` (case-insensitive prefix), or null when it is not under `from`. */
export function rebasePath(path: string, from: string, to: string): string | null {
  const a = resolve(path)
  const b = resolve(from)
  if (a.toLowerCase() === b.toLowerCase()) return resolve(to)
  if (!a.toLowerCase().startsWith((b + sep).toLowerCase())) return null
  return join(resolve(to), a.slice(b.length + 1))
}

/**
 * Move a 0.1.81 emulators root (<exeDir>\Emulation, recognised by its .playout\emulators.json) to <exeDir>\Emulators:
 * the folder is renamed when Emulators is absent (or empty), else its entries are moved one by one, skipping names
 * that already exist there. The manifest's exe paths are rewritten. Junctions inside the emulator folders point into
 * the data Emulation folder, so they move unchanged. Returns true when the manifest now lives in the new root; a
 * locked folder (an emulator running) leaves everything in place for the next launch.
 */
export function migrateLegacyRoot(exeDir: string, log: Logger): boolean {
  const legacy = legacyEmulatorRoot(exeDir)
  const target = join(exeDir, 'Emulators')
  if (!existsSync(manifestPath(legacy))) return false
  try {
    const targetEntries = existsSync(target) ? readdirSync(target) : null
    if (targetEntries === null || targetEntries.length === 0) {
      if (targetEntries) rmdirSync(target)
      renameSync(legacy, target)
    } else {
      for (const name of readdirSync(legacy)) {
        if (existsSync(join(target, name))) {
          log.warn(
            `emulators folder: ${join(legacy, name)} not moved, ${join(target, name)} exists`
          )
          continue
        }
        renameSync(join(legacy, name), join(target, name))
      }
      if (readdirSync(legacy).length === 0) rmdirSync(legacy)
    }
  } catch (err) {
    log.warn(`emulators folder could not be moved from ${legacy} to ${target} yet: ${message(err)}`)
  }
  const file = manifestPath(target)
  if (!existsSync(file)) return false
  try {
    const moved = parseManifest(readFileSync(file, 'utf8'))
    for (const entry of Object.values(moved.installed)) {
      const rebased = rebasePath(entry.exe, legacy, target)
      if (rebased && existsSync(rebased)) entry.exe = rebased
    }
    writeFileSync(file, JSON.stringify(moved, null, 2), 'utf8')
    log.info(`emulators folder moved from ${legacy} to ${target}`)
    return true
  } catch (err) {
    log.warn(`emulator manifest in ${target} could not be updated: ${message(err)}`)
    return false
  }
}

/** %ProgramFiles%, %ProgramW6432% and %ProgramFiles(x86)% (the ones that are set). */
function defaultProgramFilesDirs(): string[] {
  return [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env['ProgramFiles(x86)']
  ].filter((d): d is string => !!d)
}

/** True when `dir` is one of `parents` or inside one (resolved, case-insensitive: Windows paths). */
export function isUnder(dir: string, parents: readonly string[]): boolean {
  const child = resolve(dir).toLowerCase()
  return parents.some((p) => {
    const parent = resolve(p)
      .toLowerCase()
      .replace(/[\\/]+$/, '')
    return child === parent || child.startsWith(parent + sep)
  })
}

/** True when `dir` can be made and written (a small file is written and deleted). */
async function writable(dir: string): Promise<boolean> {
  const probe = join(dir, `.playout-write-test-${process.pid}-${Date.now()}`)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(probe, 'ok')
    await fs.rm(probe, { force: true })
    return true
  } catch {
    await fs.rm(probe, { force: true }).catch(() => undefined)
    return false
  }
}

/** True when `coresDir` holds at least one *_libretro.dll. */
async function hasLibretroCores(coresDir: string): Promise<boolean> {
  const names = await fs.readdir(coresDir).catch(() => [] as string[])
  return names.some((n) => /_libretro\.dll$/i.test(n))
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The Drive marker (drive-folder.ts DRIVE_MARKER) in an emulator folder: it was installed from a Drive folder. */
async function readDriveMarker(emuDir: string): Promise<{ version: string } | null> {
  const text = await fs.readFile(join(emuDir, DRIVE_MARKER), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version
    return { version: typeof version === 'string' && version ? version : 'drive' }
  } catch {
    return { version: 'drive' }
  }
}

/** Create the emulator setup service. Nothing runs until startup() or setup(). */
export function createEmulatorSetupService(deps: EmulatorSetupDeps): EmulatorSetupService {
  const log = deps.log
  const catalog = deps.catalog ?? EMULATOR_CATALOG
  const specById = new Map(catalog.map((s) => [s.id, s]))
  const m: EmulatorSetupModules = {
    resolveSource: realResolveSource,
    downloadFile: realDownloadFile,
    downloadDriveFolder: realDownloadDriveFolder,
    ensureSevenZip: realEnsureSevenZip,
    extractArchive: realExtractArchive,
    configureEmulator: realConfigureEmulator,
    syncBios: realSyncBios,
    ensureRuntimes: realEnsureRuntimes,
    runtimesMissing: realRuntimesMissing,
    ...deps.modules
  }
  const run: Runner = deps.run ?? runProcess
  const elevated =
    deps.runElevated ?? ((file: string, args: string[]) => realRunElevated(file, args, run))
  const readRegistry =
    deps.readRegistry ??
    ((hive: 'HKLM' | 'HKCU', key: string, valueName: string) => registryValue(hive, key, valueName))
  const concurrency = Math.max(1, deps.concurrency ?? 3)
  const debounceMs = deps.debounceMs ?? 1500
  const progressIntervalMs = deps.progressIntervalMs ?? 250
  const now = deps.now ?? Date.now
  const presets = deps.presets ?? PRESETS
  const presetsVersion = deps.presetsVersion ?? PRESETS_VERSION
  const versionOf = deps.configureVersionOf ?? configureVersionOf
  const startHidden = deps.startHidden ?? realStartHidden
  const refreshRyujinx = deps.refreshRyujinxControllers ?? realRefreshRyujinxControllers
  const beforeLaunchTimeoutMs = deps.beforeLaunchTimeoutMs ?? 5000

  const controller = new AbortController()
  let disposed = false
  /** The Ryujinx controller refreshes beforeLaunch is running (aborted on dispose). */
  const launchRefreshes = new Set<AbortController>()
  /**
   * PCSX2 game list steps run one at a time: a launch's step waits for a background scan to close PCSX2 and put its
   * settings back (the launch stops that scan first).
   */
  let pcsx2Step: Promise<unknown> = Promise.resolve()
  const isPidAlive = deps.isPidAlive ?? pidAlive
  const prewarmDelayMs = deps.prewarmDelayMs ?? 5000
  /** Games launched before PCSX2 listed them: the next pre-warm scans them (with the library's). */
  const prewarmRoms = new Set<string>()
  let prewarmTimer: ReturnType<typeof setTimeout> | null = null
  let prewarmRunning = false
  /** A pre-warm was asked for while a pass ran: another pass follows it. */
  let prewarmRerun = false
  /** Stops the pre-warm's running scan (a launch). */
  let prewarmAbort: AbortController | null = null
  /** When the last emulator launch began (no pre-warm scan starts for PREWARM_QUIET_MS after it). */
  let lastLaunchAt = Number.NEGATIVE_INFINITY
  /** The follow-up check that puts a stopped scan's settings back once no PCSX2 runs (cleared on dispose). */
  let restoreTimer: ReturnType<typeof setInterval> | null = null
  const http = (): HttpDeps => ({ fetch: deps.fetch, signal: controller.signal, log })
  const exeOf = (root: string, spec: EmulatorSpec): string => join(root, spec.folder, spec.exe)

  // --- root and manifest ---------------------------------------------------------------------------------------

  const programFiles = deps.programFilesDirs ?? defaultProgramFilesDirs()
  const [newRoot, fallbackRoot] = emulatorRootCandidates(deps.exeDir, deps.userData)
  const legacyRoot = legacyEmulatorRoot(deps.exeDir)
  migrateLegacyRoot(deps.exeDir, log)
  // A move that could not happen (an emulator running): this launch keeps using the 0.1.81 folder.
  const preferredRoot = existsSync(manifestPath(legacyRoot)) ? legacyRoot : newRoot
  if (preferredRoot === newRoot) {
    rebaseSettingsPaths(legacyRoot, newRoot)
    // The user moved the PlayOut folder (with its Emulators folder).
    for (const previous of deps.previousExeDirs ?? [])
      rebaseSettingsPaths(join(previous, 'Emulators'), newRoot)
  }

  /** Emulator paths the user set by hand inside the old folder (Browse, RetroArch cores) follow the move. */
  function rebaseSettingsPaths(from: string, to: string): void {
    try {
      const { overrides, coresDir } = deps.settings.get().emulators
      const nextOverrides: Record<string, string> = {}
      let changed = false
      for (const [id, path] of Object.entries(overrides)) {
        const moved = rebasePath(path, from, to)
        const rebased = moved && existsSync(moved) ? moved : null
        nextOverrides[id] = rebased ?? path
        if (rebased) changed = true
      }
      const movedCores = coresDir ? rebasePath(coresDir, from, to) : null
      const nextCores = movedCores && existsSync(movedCores) ? movedCores : null
      if (changed || nextCores)
        deps.settings.update({
          emulators: { overrides: nextOverrides, ...(nextCores ? { coresDir: nextCores } : {}) }
        })
    } catch (err) {
      log.warn(`emulator paths in settings could not be updated: ${message(err)}`)
    }
  }
  /**
   * The candidates a root may be: never one under Program Files (ScummVM turns portable mode off there, and a run
   * without elevation cannot write it).
   */
  const usableCandidates = (): string[] =>
    isUnder(preferredRoot, programFiles) ? [fallbackRoot] : [preferredRoot, fallbackRoot]

  /** True when `root`'s manifest records an emulator whose exe is still at <root>\<folder>\<exe>. */
  async function hasInstalledManifest(root: string): Promise<boolean> {
    const text = await fs.readFile(manifestPath(root), 'utf8').catch(() => null)
    if (text === null) return false
    for (const id of Object.keys(parseManifest(text).installed)) {
      const spec = specById.get(id)
      if (spec && (await isFile(exeOf(root, spec)))) return true
    }
    return false
  }

  /** The root once resolved (managedExe's fallback looks there; before that, at every usable candidate). */
  let resolvedRoot: string | null = null
  let rootPromise: Promise<string> | null = null
  function resolveRoot(): Promise<string> {
    rootPromise ??= (async () => {
      const candidates = usableCandidates()
      if (candidates[0] !== preferredRoot)
        log.info(`emulators root ${preferredRoot} is under Program Files, using ${fallbackRoot}`)
      // An existing install wins, even where it can no longer be written (the notices then report what failed).
      for (const candidate of candidates)
        if (await hasInstalledManifest(candidate)) return (resolvedRoot = candidate)
      const [first] = candidates
      if (first !== fallbackRoot && (await writable(first!))) return (resolvedRoot = first!)
      if (first !== fallbackRoot)
        log.info(`emulators root ${first} is not writable, using ${fallbackRoot}`)
      await fs.mkdir(fallbackRoot, { recursive: true }).catch(() => undefined)
      return (resolvedRoot = fallbackRoot)
    })()
    return rootPromise
  }

  /** The manifest in memory; read synchronously at creation so managedExe works before startup. */
  let manifestRoot: string | null = null
  let manifest: SetupManifest = (() => {
    for (const root of usableCandidates()) {
      try {
        const found = parseManifest(readFileSync(manifestPath(root), 'utf8'))
        if (Object.keys(found.installed).length) {
          manifestRoot = root
          return found
        }
      } catch {
        // not there
      }
    }
    return emptyManifest()
  })()
  healMovedExes(manifest, manifestRoot)
  let manifestLoaded = false

  /**
   * Emulators recorded at a path that is gone while the root holds them (the Emulators folder moved with PlayOut, or
   * by hand): the record points at the root's copy (Dolphin and Model 2 are found by nothing else). True when changed.
   */
  function healMovedExes(m: SetupManifest, root: string | null): boolean {
    if (!root) return false
    let changed = false
    for (const [id, entry] of Object.entries(m.installed)) {
      const spec = specById.get(id)
      if (!spec || !entry.exe || existsSync(entry.exe)) continue
      const here = exeOf(root, spec)
      if (!existsSync(here)) continue
      log.info(`emulator ${id}: ${entry.exe} is gone; it is ${here} now`)
      entry.exe = here
      changed = true
    }
    return changed
  }

  async function loadManifest(): Promise<SetupManifest> {
    if (manifestLoaded) return manifest
    const root = await resolveRoot()
    const text = await fs.readFile(manifestPath(root), 'utf8').catch(() => null)
    const loaded = text === null ? emptyManifest() : parseManifest(text)
    if (Object.keys(loaded.installed).length || !Object.keys(manifest.installed).length) {
      manifest = loaded
    } else if (manifestRoot !== root) {
      // The manifest found at creation belongs to another root: keep its entries (their exes still work), but this
      // root's setup is not done.
      manifest.completed = false
      manifest.configuredFor = null
    }
    manifestRoot = root
    manifestLoaded = true
    if (healMovedExes(manifest, root)) await saveManifest().catch(() => undefined)
    return manifest
  }

  let manifestWrite: Promise<void> = Promise.resolve()
  /** Write the in-memory manifest (serialized; written to a temp file and renamed). */
  function saveManifest(): Promise<void> {
    const task = manifestWrite.then(async () => {
      const root = await resolveRoot()
      const file = manifestPath(root)
      await fs.mkdir(playoutDir(root), { recursive: true })
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
      await renameRetry(tmp, file)
    })
    manifestWrite = task.catch((err) =>
      log.warn(`emulator manifest could not be saved: ${message(err)}`)
    )
    return manifestWrite
  }

  const dataDir = (): string => emulationDirOf(deps.settings.get(), deps.userData)

  /**
   * Record every catalog emulator whose exe is at <root>\<folder>\<exe> but missing from the manifest (PlayOut quit
   * between moving it into place and saving the manifest, or the manifest was lost), point it at `dir` and save.
   * Returns the adopted ids and how many could not be configured.
   */
  async function adoptOrphans(
    root: string,
    dir: string
  ): Promise<{ adopted: string[]; failures: number }> {
    const adopted: string[] = []
    let failures = 0
    const hadInstalled = Object.keys(manifest.installed).length > 0
    for (const spec of catalog) {
      if (manifest.installed[spec.id]) continue
      const exe = exeOf(root, spec)
      if (!(await isFile(exe))) continue
      const drive = await readDriveMarker(join(root, spec.folder))
      manifest.installed[spec.id] = {
        version: drive?.version ?? 'unknown',
        exe,
        installedAt: new Date(now()).toISOString(),
        ...(drive ? { source: 'drive-folder' as const } : {})
      }
      adopted.push(spec.id)
      try {
        await configureOne(spec.id, {
          emuDir: join(root, spec.folder),
          dataDir: dir,
          run,
          log
        })
      } catch (err) {
        failures++
        log.warn(`${spec.name} folders could not be set: ${message(err)}`)
      }
    }
    if (adopted.length) {
      log.info(`adopted emulators missing from the manifest: ${adopted.join(', ')}`)
      // Same rule as a setup run: record `dir` only when the earlier entries point there too.
      if (failures) manifest.configuredFor = null
      else if (!hadInstalled) manifest.configuredFor = dir
      await saveManifest()
    }
    return { adopted, failures }
  }

  // --- progress --------------------------------------------------------------------------------------------------

  let progress: EmulatorSetupProgress = { done: 0, total: 0 }
  const current = new Set<string>()
  const bytes = new Map<string, { done: number; total: number }>()
  /** Files of the Drive folders being downloaded (their sizes are not known up front), per emulator id. */
  const driveFiles = new Map<string, { done: number; total: number }>()
  let lastEmit = 0
  let emitTimer: ReturnType<typeof setTimeout> | null = null

  function snapshot(): EmulatorSetupProgress {
    if (!progress.total) return { done: 0, total: 0 }
    let bytesDone = 0
    let bytesTotal = 0
    for (const b of bytes.values()) {
      bytesDone += b.done
      bytesTotal += Math.max(b.total, b.done)
    }
    let filesDone = 0
    let filesTotal = 0
    for (const f of driveFiles.values()) {
      filesDone += f.done
      filesTotal += f.total
    }
    return {
      ...progress,
      current: [...current],
      ...(bytes.size ? { bytesDone, bytesTotal } : {}),
      ...(driveFiles.size ? { filesDone, filesTotal } : {})
    }
  }

  function emitNow(): void {
    if (emitTimer) clearTimeout(emitTimer)
    emitTimer = null
    lastEmit = now()
    try {
      deps.emit(snapshot())
    } catch (err) {
      log.warn(`emulator setup progress could not be sent: ${message(err)}`)
    }
  }

  /** Emit at once for stage changes (force), else at most every progressIntervalMs (a trailing emit is kept). */
  function emit(force = false): void {
    if (force || now() - lastEmit >= progressIntervalMs) return emitNow()
    if (!emitTimer)
      emitTimer = setTimeout(emitNow, Math.max(0, progressIntervalMs - (now() - lastEmit)))
  }

  // --- run state -------------------------------------------------------------------------------------------------

  const itemState = new Map<string, { state: 'installing' | 'failed'; error?: string }>()
  let notices: string[] = []
  /** Ids requested while a run was going on (processed after it). */
  const pending = new Set<string>()
  let draining: Promise<void> | null = null
  /** One thing at a time: a setup run, or a reconfigure after the data folder changed. */
  let exclusiveChain: Promise<unknown> = Promise.resolve()
  /** Setup runs and reconfigures queued or running: no pre-warm scan runs meanwhile. */
  let exclusiveBusy = 0
  /** A pre-warm pass was held back by them: it runs once they are done. */
  let prewarmAfterExclusive = false
  /**
   * One at a time. A pre-warm scan (it writes PCSX2.ini and runs a hidden PCSX2) is stopped first and its step waited
   * for (closed, settings put back), and none starts until the task is done.
   */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    exclusiveBusy++
    prewarmAbort?.abort()
    const guarded = async (): Promise<T> => {
      await pcsx2Step
      return task()
    }
    const next = exclusiveChain.then(guarded, guarded).finally(() => {
      exclusiveBusy--
      if (exclusiveBusy === 0 && prewarmAfterExclusive) {
        prewarmAfterExclusive = false
        schedulePrewarm()
      }
    })
    exclusiveChain = next.catch(() => undefined)
    return next
  }

  function addNotice(text: string): void {
    if (!notices.includes(text)) notices.push(text)
  }

  /** Set when a run synced the BIOS files (startup then does not sync them twice). */
  let biosSynced = false
  async function syncBiosNow(root: string, dir: string): Promise<void> {
    biosSynced = true
    const found = await m.syncBios({
      emuDirOf: (id) => {
        const spec = specById.get(id)
        if (!spec) return null
        return manifest.installed[id] || existsSync(exeOf(root, spec))
          ? join(root, spec.folder)
          : null
      },
      dataDir: dir,
      run,
      log
    })
    for (const notice of found) if (!notices.includes(notice)) notices.push(notice)
  }

  // --- fullscreen and controller presets ---------------------------------------------------------------------

  /**
   * Waits until no process with this image name runs (checked every 500 ms), or, given `pid`, until that process is
   * gone (probed without a process list). True once it is gone, or when the process list cannot be read; false after
   * `ms`.
   */
  async function waitUntilClosed(image: string, ms: number, pid?: number): Promise<boolean> {
    const sleep = deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)))
    // Bounded by the clock too: each process list read takes its own time.
    const until = now() + ms
    for (let waited = 0; ; waited += 500) {
      // The ended game's own process when the launcher knows it (no process list); else any process of that name.
      const gone = pid !== undefined ? !isPidAlive(pid) : !(await runningImages())?.has(image)
      if (gone) return true
      if (waited >= ms || now() >= until || disposed) return false
      await sleep(500)
    }
  }

  /**
   * The lower-case image names of the running processes (tasklist), or null when the list could not be read. Read
   * again for each emulator, right before and after its presets, so one started meanwhile is noticed.
   */
  async function runningImages(): Promise<Set<string> | null> {
    try {
      const r = await run('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 15_000 })
      if (r.code !== 0) return null
      const names = new Set<string>()
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = /^"([^"]+)"/.exec(line.trim())
        if (m) names.add(m[1].toLowerCase())
      }
      return names
    } catch {
      return null
    }
  }

  /**
   * Apply the fullscreen and controller presets to one installed emulator when the manifest does not record the
   * current PRESETS_VERSION for it. Skipped while a process with the emulator's exe name runs (checked right before and
   * again right after): the emulator would overwrite the files on exit. A failure becomes a notice. Either way the
   * version is not recorded, so the presets run again at PlayOut's next start (startup's reconfigure; a game launch
   * never applies them) or the next setup run; they are idempotent. A PresetDeferredError is retried the same way,
   * without a notice. A PCSX2 whose presets were recorded gets a pre-warm pass (its game list).
   */
  async function applyPresetsTo(root: string, dir: string, spec: EmulatorSpec): Promise<void> {
    const preset = presets[spec.id]
    if (!preset) return
    // A preconfigured install from a Drive folder keeps its own settings, now and after any later presets version.
    if (manifest.installed[spec.id]?.source === 'drive-folder') return
    const recorded = manifest.presets[spec.id]
    if (recorded !== undefined && recorded >= presetsVersion) return
    const exeName = basename(spec.exe).toLowerCase()
    const images = await runningImages()
    if (images?.has(exeName)) {
      log.info(
        `${spec.name} is running: fullscreen and controller presets wait for PlayOut's next start`
      )
      return
    }
    if (images === null) log.warn(`process list unavailable; applying ${spec.name} presets anyway`)
    try {
      await preset({
        emuDir: join(root, spec.folder),
        dataDir: dir,
        run,
        log,
        // 0 = a deferred run already applied the first-time settings (fullscreen): a retry must not apply them again.
        firstTime: recorded === undefined,
        previousVersion: recorded,
        startHidden
      })
      if ((await runningImages())?.has(exeName)) {
        log.info(
          `${spec.name} was started while its presets ran: they are applied again at PlayOut's next start`
        )
        return
      }
      manifest.presets[spec.id] = presetsVersion
      await saveManifest()
      log.info(`${spec.name} fullscreen and controller presets applied (version ${presetsVersion})`)
      if (spec.id === 'PCSX2') schedulePrewarm()
    } catch (err) {
      if (err instanceof PresetDeferredError) {
        log.info(`${spec.name} fullscreen and controller presets deferred: ${err.message}`)
        // Retried at the next start (0 < any version), but no longer as the first time.
        if (recorded === undefined) {
          manifest.presets[spec.id] = 0
          await saveManifest()
        }
        return
      }
      log.warn(`${spec.name} fullscreen and controller presets failed: ${message(err)}`)
      const notice = tMain('mainEmulatorSetup.presetsFailed', {
        name: spec.name,
        error: message(err)
      })
      if (!notices.includes(notice)) notices.push(notice)
    }
  }

  /** Apply the presets to every installed emulator that has not got the current version yet. */
  async function applyPendingPresets(root: string, dir: string): Promise<void> {
    // A PCSX2 game list scan cut short by a crash or a forced quit: its settings go back while PCSX2 is closed.
    const pcsx2 = manifest.installed.PCSX2?.exe
    if (pcsx2 && !(await runningImages())?.has(basename(pcsx2).toLowerCase())) {
      await restoreAfterScan(dirname(pcsx2), log).catch((err) =>
        log.warn(`PCSX2 settings could not be put back: ${message(err)}`)
      )
    }
    for (const spec of catalog) {
      if (disposed) return
      if (!manifest.installed[spec.id] || !(await isFile(exeOf(root, spec)))) continue
      await applyPresetsTo(root, dir, spec)
    }
  }

  // --- PCSX2 game list pre-warm ----------------------------------------------------------------------------------

  /** Whether a PCSX2 process (the installed exe's name) runs; false when the process list cannot be read. */
  async function pcsx2Running(exe: string): Promise<boolean> {
    return (await runningImages())?.has(basename(exe).toLowerCase()) ?? false
  }

  /**
   * Whether a PCSX2 process other than `exceptPid` (the hidden scan's) runs: a process list of that image only (the
   * background scan asks every couple of seconds). False when it cannot be read.
   */
  async function otherPcsx2Running(exe: string, exceptPid?: number): Promise<boolean> {
    const image = basename(exe).toLowerCase()
    const args = ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${basename(exe)}`]
    if (exceptPid !== undefined) args.push('/FI', `PID ne ${exceptPid}`)
    try {
      const r = await run('tasklist', args, { timeoutMs: 15_000 })
      if (r.code !== 0) return false
      return r.stdout.split(/\r?\n/).some((line) => {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
        return !!m && m[1].toLowerCase() === image && Number(m[2]) !== exceptPid
      })
    } catch {
      return false
    }
  }

  /** Why a pre-warm scan must not run now (null: it may). */
  function prewarmBlocked(): 'disposed' | 'setup' | 'game' | 'launch' | null {
    if (disposed) return 'disposed'
    if (exclusiveBusy > 0) return 'setup'
    if (deps.isGameRunning?.()) return 'game'
    if (now() - lastLaunchAt < PREWARM_QUIET_MS) return 'launch'
    return null
  }

  /**
   * A pass held back: tried again once a launch's quiet time is over, or once setup is done. A game: its session's end
   * asks again.
   */
  function holdBack(blocked: ReturnType<typeof prewarmBlocked>): void {
    if (blocked === 'launch') schedulePrewarm(PREWARM_QUIET_MS - (now() - lastLaunchAt))
    if (blocked === 'setup') prewarmAfterExclusive = true
  }

  /**
   * A background scan another PCSX2 stopped left its settings to put back (its marker): checked every
   * RESTORE_CHECK_MS; put back as soon as no PCSX2 runs (or the marker is gone), then the check stops.
   */
  function scheduleRestoreCheck(exe: string): void {
    if (disposed || restoreTimer) return
    const emuDir = dirname(exe)
    let checking = false
    restoreTimer = setInterval(() => {
      if (checking || disposed) return
      checking = true
      const stopChecking = (): void => {
        if (restoreTimer) clearInterval(restoreTimer)
        restoreTimer = null
      }
      const check = pcsx2Step.then(async () => {
        if (disposed) return
        if (!(await pcsx2RestorePending(emuDir))) return stopChecking()
        if (await pcsx2Running(exe)) return
        await restoreAfterScan(emuDir, log)
        stopChecking()
      })
      pcsx2Step = check.catch(() => undefined)
      void check
        .catch((err) => log.warn(`PCSX2 settings could not be put back: ${message(err)}`))
        .finally(() => (checking = false))
    }, deps.restoreCheckMs ?? RESTORE_CHECK_MS)
    restoreTimer.unref?.()
  }

  function schedulePrewarm(delay = prewarmDelayMs): void {
    if (disposed) return
    if (prewarmTimer) clearTimeout(prewarmTimer)
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null
      void runPrewarm().catch((err) => log.warn(`PCSX2 pre-warm failed: ${message(err)}`))
    }, delay)
  }

  /** One pass at a time; a request during a pass runs another one after it. */
  async function runPrewarm(): Promise<void> {
    if (prewarmRunning) {
      prewarmRerun = true
      return
    }
    prewarmRunning = true
    try {
      await prewarmPass()
    } finally {
      prewarmRunning = false
      if (prewarmRerun) {
        prewarmRerun = false
        schedulePrewarm()
      }
    }
  }

  /**
   * One pre-warm pass: first the settings of a scan left unfinished (put back while no PCSX2 runs); then the PS2 games
   * PCSX2 does not list yet, PREWARM_BATCH at a time. Each batch's read-only checks run outside pcsx2Step (a launch
   * never waits for them; they stop between two games when asked); only the games that need a write or a scan go into
   * the step, chained on pcsx2Step like a launch's, with one hidden scan. Stops (and keeps the launched games for the
   * next pass) when a game, a launch, setup, another PCSX2 or quitting comes along.
   */
  async function prewarmPass(): Promise<void> {
    const installed = manifest.installed.PCSX2?.exe
    if (!installed || !(await isFile(installed))) return
    const emuDir = dirname(installed)
    if (!prewarmBlocked() && (await pcsx2RestorePending(emuDir))) {
      const restore = pcsx2Step.then(async () => {
        if (!(await pcsx2Running(installed))) await restoreAfterScan(emuDir, log)
      })
      pcsx2Step = restore.catch(() => undefined)
      await restore.catch((err) =>
        log.warn(`PCSX2 settings could not be put back: ${message(err)}`)
      )
    }
    const seen = new Set<string>()
    const roms: string[] = []
    for (const rom of [...prewarmRoms, ...(deps.pcsx2Roms?.() ?? [])]) {
      const key = resolve(rom).toLowerCase()
      if (seen.has(key) || !pcsx2Scannable(rom)) continue
      seen.add(key)
      roms.push(rom)
    }
    for (let at = 0; at < roms.length; at += PREWARM_BATCH) {
      const blocked = prewarmBlocked()
      if (blocked) return holdBack(blocked)
      const batch = roms.slice(at, at + PREWARM_BATCH)
      const abort = new AbortController()
      prewarmAbort = abort
      const shouldStop = (): boolean => abort.signal.aborted || prewarmBlocked() !== null
      let result: GameListResult | 'aborted' = 'listed'
      try {
        const needing = await pcsx2GamesNeedingWork({
          emuDir,
          exe: installed,
          roms: batch,
          log,
          shouldStop
        })
        if (needing === 'aborted') result = 'aborted'
        else if (needing.length) {
          const step = pcsx2Step.then(async (): Promise<GameListResult> => {
            if (shouldStop()) return 'aborted'
            return listPcsx2Games({
              emuDir,
              exe: installed,
              roms: needing,
              log,
              startHidden,
              isRunning: () => pcsx2Running(installed),
              othersRunning: (pid) => otherPcsx2Running(installed, pid),
              timeoutMs: deps.prewarmScanTimeoutMs ?? BACKGROUND_SCAN_TIMEOUT_MS,
              shouldStop
            })
          })
          pcsx2Step = step.catch(() => undefined)
          result = await step
        }
      } finally {
        if (prewarmAbort === abort) prewarmAbort = null
      }
      if (result === 'aborted') {
        // Another PCSX2 kept the scan's settings from going back: they go back once it is closed.
        if (await pcsx2RestorePending(emuDir)) scheduleRestoreCheck(installed)
        const why = prewarmBlocked()
        log.info(`PCSX2 pre-warm stopped${why ? ` (${why})` : ''}`)
        holdBack(why)
        return
      }
      // The launched games of this batch are listed now, never will be, or come back at their next launch.
      for (const rom of batch) prewarmRoms.delete(rom)
    }
  }

  /**
   * Download `downloads` (the bytes show in the progress) and unpack them into `staging`. The downloaded files are
   * added to `files` as they arrive: the caller deletes them, and `staging`.
   */
  async function downloadAndUnpack(
    root: string,
    spec: EmulatorSpec,
    downloads: ResolvedDownload[],
    staging: string,
    sevenZip: () => Promise<string>,
    files: string[]
  ): Promise<void> {
    if (!downloads.length) throw new Error(tMain('mainEmulatorSetup.noDownload'))
    const downloadsDir = join(playoutDir(root), 'downloads')
    await fs.mkdir(downloadsDir, { recursive: true })
    for (const [i, d] of downloads.entries()) {
      const key = `${spec.id}:${i}`
      bytes.set(key, { done: 0, total: d.size ?? 0 })
      emit()
      files.push(
        await m.downloadFile(d, downloadsDir, http(), (done, total) => {
          bytes.set(key, { done, total })
          emit()
        })
      )
    }
    if (controller.signal.aborted) throw new Error('cancelled')

    await fs.rm(staging, RM_RETRY)
    const extractDeps = { sevenZip, run, log }
    if (files.length === 1) {
      await m.extractArchive(files[0], staging, extractDeps)
    } else {
      // RetroArch: the frontend and its cores each have their own top folder ("RetroArch-Win64\"); each is unpacked
      // apart with only that one level removed (the cores archive keeps its "cores\"), then merged into staging.
      await fs.mkdir(staging, { recursive: true })
      for (const [i, file] of files.entries()) {
        const part = `${staging}.${i}`
        await fs.rm(part, RM_RETRY)
        try {
          await m.extractArchive(file, part, extractDeps, { flattenLevels: 1 })
          await fs.cp(part, staging, { recursive: true, force: true })
        } finally {
          await fs.rm(part, RM_RETRY).catch(() => undefined)
        }
      }
    }

    // Checked before the move: a RetroArch without cores is not left behind looking installed.
    if (spec.id === 'RETROARCH' && !(await hasLibretroCores(join(staging, 'cores'))))
      throw new Error(tMain('mainEmulatorSetup.coresMissing'))
  }

  /** Download, unpack, move into place and set up one emulator. */
  async function installOne(
    root: string,
    dir: string,
    spec: EmulatorSpec,
    sevenZip: () => Promise<string>,
    configureFailed: (spec: EmulatorSpec, err: unknown) => void
  ): Promise<void> {
    if (spec.source.kind === 'drive-folder')
      return installFromDrive(root, dir, spec, spec.source, configureFailed)
    const staging = join(root, `.${spec.folder}.extracting`)
    const target = join(root, spec.folder)
    const files: string[] = []
    try {
      const downloads = await m.resolveSource(spec.source, http())
      await downloadAndUnpack(root, spec, downloads, staging, sevenZip, files)

      if (!(await pathExists(target))) {
        // A brand-new folder has none of the emulator's settings: presets recorded for an earlier install of it (a
        // folder the user deleted) no longer apply.
        delete manifest.presets[spec.id]
        await renameRetry(staging, target)
      } else {
        // An interrupted run left the folder without its exe: copy over it, keeping the other files.
        await fs.cp(staging, target, { recursive: true, force: true })
      }
      const exe = exeOf(root, spec)
      if (!(await isFile(exe)))
        throw new Error(tMain('mainEmulatorSetup.exeNotDownloaded', { file: spec.exe }))

      try {
        await configureOne(spec.id, { emuDir: target, dataDir: dir, run, log })
      } catch (err) {
        configureFailed(spec, err)
      }
      manifest.installed[spec.id] = {
        version: downloads[0].version,
        exe,
        installedAt: new Date(now()).toISOString()
      }
      await saveManifest()
      log.info(`${spec.name} ${downloads[0].version} installed in ${target}`)
      // Fullscreen and an XInput/SDL controller (never fails the install: a failure is a notice).
      await applyPresetsTo(root, dir, spec)
    } finally {
      await fs.rm(staging, RM_RETRY).catch(() => undefined)
      for (const file of files) await fs.rm(file, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Download a 'drive-folder' source (an unpacked, preconfigured emulator folder) file by file into
   * <root>\.<folder>.drive, then move it into place and point it at the data folder like any other install. The
   * staging folder is kept when the download fails: the next run downloads only the files still missing. PlayOut's
   * presets are not applied (the folder's own settings win), and the manifest records the source so they never are.
   */
  async function installFromDrive(
    root: string,
    dir: string,
    spec: EmulatorSpec,
    source: DriveFolderSource,
    configureFailed: (spec: EmulatorSpec, err: unknown) => void
  ): Promise<void> {
    const staging = join(root, `.${spec.folder}.drive`)
    const target = join(root, spec.folder)
    driveFiles.set(spec.id, { done: 0, total: 0 })
    emit()
    try {
      await m.downloadDriveFolder(source, staging, http(), (p) => {
        driveFiles.set(spec.id, { done: p.filesDone, total: p.filesTotal })
        emit()
      })
    } finally {
      driveFiles.delete(spec.id)
    }
    if (controller.signal.aborted) throw new Error('cancelled')
    if (!(await isFile(join(staging, spec.exe))))
      throw new Error(tMain('mainEmulatorSetup.exeNotInDrive', { file: spec.exe }))
    const version = `drive-${new Date(now()).toISOString().slice(0, 10)}`
    await fs.writeFile(
      join(staging, DRIVE_MARKER),
      JSON.stringify({ folderId: source.folderId, version }, null, 2),
      'utf8'
    )
    if (!(await pathExists(target))) {
      delete manifest.presets[spec.id]
      await renameRetry(staging, target)
    } else if (await pathExists(join(target, DRIVE_MARKER))) {
      // An earlier Drive install that lost its exe (an interrupted run): the Drive copy goes over it again.
      await fs.cp(staging, target, { recursive: true, force: true })
      await fs.rm(staging, RM_RETRY).catch(() => undefined)
    } else {
      // A folder of the user's own RPCS3 without its exe (antivirus, a broken update): its settings must not be
      // overwritten by the Drive copy, so it is kept aside, whole, and the Drive copy takes its place.
      const aside = `${target}.playout-old-${new Date(now()).toISOString().slice(0, 10)}`
      let keep = aside
      for (let n = 2; await pathExists(keep); n++) keep = `${aside}-${n}`
      await renameRetry(target, keep)
      log.warn(`${spec.name}: the existing ${target} had no ${spec.exe}; kept as ${keep}`)
      delete manifest.presets[spec.id]
      await renameRetry(staging, target)
    }
    const exe = exeOf(root, spec)
    if (!(await isFile(exe)))
      throw new Error(tMain('mainEmulatorSetup.exeNotDownloaded', { file: spec.exe }))

    try {
      // The other PC's absolute folder paths in vfs.yml go back to the defaults; configure then points dev_hdd0 and
      // the games folder at the data folder as for every RPCS3.
      if (spec.id === 'RPCS3') await localizeRpcs3Vfs(target, log)
      await configureOne(spec.id, { emuDir: target, dataDir: dir, run, log })
    } catch (err) {
      configureFailed(spec, err)
    }
    manifest.installed[spec.id] = {
      version,
      exe,
      installedAt: new Date(now()).toISOString(),
      source: 'drive-folder'
    }
    await saveManifest()
    log.info(
      `${spec.name} installed from Google Drive in ${target} (its own settings kept, no presets)`
    )
  }

  /** Installs the runtimes in `needs` that Windows lacks (the bytes show in the progress); failures become notices. */
  async function ensureNeededRuntimes(root: string, needs: RuntimeId[]): Promise<void> {
    if (!needs.length) return
    const rdeps: RuntimeDeps = {
      ...http(),
      workDir: join(playoutDir(root), 'downloads'),
      readRegistry,
      exists: pathExists,
      runElevated: elevated,
      onBytes: (done, total) => {
        bytes.set('runtimes', { done, total })
        emit()
      }
    }
    try {
      await fs.mkdir(rdeps.workDir, { recursive: true })
      const lacking = await m.runtimesMissing(needs, rdeps)
      if (lacking.length) for (const n of await m.ensureRuntimes(lacking, rdeps)) addNotice(n)
    } catch (err) {
      log.warn(`runtimes could not be installed: ${message(err)}`)
      addNotice(tMain('mainEmulatorSetup.runtimesFailed', { error: message(err) }))
    }
  }

  /** One setup run over these ids (only the ones whose exe is missing are installed). */
  async function runOnce(ids: string[]): Promise<void> {
    // The data folder is read once: every emulator of this run, configuredFor and the BIOS sync use the same one.
    const dir = dataDir()
    const root = await resolveRoot()
    await loadManifest()
    await adoptOrphans(root, dir)
    const wanted = ids.map((id) => specById.get(id)).filter((s): s is EmulatorSpec => !!s)
    const missing: EmulatorSpec[] = []
    for (const spec of wanted) if (!(await isFile(exeOf(root, spec)))) missing.push(spec)
    for (const spec of wanted) if (!missing.includes(spec)) itemState.delete(spec.id)
    if (!missing.length) return

    notices = []
    for (const spec of missing) itemState.set(spec.id, { state: 'installing' })
    bytes.clear()
    driveFiles.clear()
    current.clear()
    progress = { done: 0, total: missing.length, stage: 'runtimes' }
    emit(true)
    log.info(`setting up ${missing.length} emulator(s): ${missing.map((s) => s.id).join(', ')}`)

    // 1. Runtimes the missing emulators need.
    const needs = [...new Set(missing.flatMap((s) => s.runtimes ?? []))] as RuntimeId[]
    await ensureNeededRuntimes(root, needs)

    // 2. 7zr.exe, when an archive needs it; 3. the emulators.
    progress = { ...progress, stage: 'emulators' }
    emit(true)
    let sevenZipPromise: Promise<string> | null = null
    const sevenZip = (): Promise<string> => {
      sevenZipPromise ??= m.ensureSevenZip(playoutDir(root), http()).catch((err) => {
        sevenZipPromise = null
        throw err
      })
      return sevenZipPromise
    }
    let installed = 0
    let configureFailures = 0
    const configuredForBefore = manifest.configuredFor
    const hadInstalled = Object.keys(manifest.installed).length > 0
    const queue = [...missing]
    const worker = async (): Promise<void> => {
      while (queue.length && !controller.signal.aborted) {
        const spec = queue.shift()!
        current.add(spec.name)
        emit(true)
        try {
          await installOne(root, dir, spec, sevenZip, (s, err) => {
            configureFailures++
            log.warn(`${s.name} folders could not be set: ${message(err)}`)
            notices.push(
              tMain('mainEmulatorSetup.foldersNotSet', { name: s.name, error: message(err) })
            )
          })
          itemState.delete(spec.id)
          installed++
        } catch (err) {
          log.warn(`${spec.name} could not be installed: ${message(err)}`)
          itemState.set(spec.id, { state: 'failed', error: message(err) })
        } finally {
          current.delete(spec.name)
          for (const key of [...bytes.keys()]) if (key.startsWith(`${spec.id}:`)) bytes.delete(key)
          progress = { ...progress, done: progress.done + 1 }
          emit(true)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker))
    for (const spec of missing)
      if (itemState.get(spec.id)?.state === 'installing')
        itemState.set(spec.id, { state: 'failed', error: 'cancelled' })

    // Record which data folder the new emulators point at: only when the earlier ones point there too (startup's
    // reconfigure fixes the others), and never after a failed configure (it is retried at the next launch).
    if (installed) {
      if (configureFailures) manifest.configuredFor = null
      else if (!hadInstalled || configuredForBefore === dir) manifest.configuredFor = dir
      await saveManifest()
      try {
        deps.onInstalled?.()
      } catch (err) {
        log.warn(`onInstalled failed: ${message(err)}`)
      }
    }

    // 4. BIOS sync.
    progress = { ...progress, stage: 'bios' }
    emit(true)
    try {
      await syncBiosNow(root, dir)
    } catch (err) {
      log.warn(`BIOS sync failed: ${message(err)}`)
    }

    // The data folder changed during the run: point everything at the new one afterwards (configuredFor is `dir`
    // or null, so the reconfigure sees the change; the watcher's own queued one then finds nothing to do).
    if (!disposed && dataDir() !== dir)
      void exclusive(() => reconfigure(false, true)).catch((err) =>
        log.error(`emulators could not be pointed at the new Emulation folder: ${message(err)}`)
      )
  }

  async function allInstalled(): Promise<boolean> {
    const root = await resolveRoot()
    for (const spec of catalog) if (!(await isFile(exeOf(root, spec)))) return false
    return true
  }

  async function drain(): Promise<void> {
    try {
      while (pending.size && !disposed) {
        const batch = [...pending]
        pending.clear()
        try {
          await runOnce(batch)
        } catch (err) {
          log.error(`emulator setup failed: ${message(err)}`)
          for (const id of batch)
            if (itemState.get(id)?.state === 'installing')
              itemState.set(id, { state: 'failed', error: message(err) })
        }
      }
      if (!disposed && !manifest.completed && (await allInstalled())) {
        manifest.completed = true
        await saveManifest()
      }
    } finally {
      bytes.clear()
      driveFiles.clear()
      current.clear()
      progress = { done: 0, total: 0 }
      emit(true)
    }
  }

  function setup(ids?: string[]): Promise<EmulatorSetupStatus> {
    // A manual setup (a dev run skips startup) still follows data folder changes.
    watchSettings()
    const requested = (ids ?? catalog.map((s) => s.id)).filter((id) => specById.has(id))
    for (const id of requested) {
      pending.add(id)
      // Shown as installing at once (the run removes the ones already installed).
      if (itemState.get(id)?.state !== 'installing') itemState.set(id, { state: 'installing' })
    }
    kick()
    return (async () => {
      // Ids added while a run was ending start another run: wait for it too.
      while (draining) await draining
      return status()
    })()
  }

  function kick(): void {
    if (draining || !pending.size || disposed) return
    draining = exclusive(drain).finally(() => {
      draining = null
      kick()
    })
  }

  // --- Update all emulators ------------------------------------------------------------------------------------

  /** Emulator id -> when PlayOut last began launching it (beforeLaunch): Update all emulators leaves it alone a while. */
  const launchedAt = new Map<string, number>()
  /** Update all emulators' file swaps going on: PlayOut closing waits for them (dispose). */
  const overlaying = new Set<Promise<void>>()

  /** What the last Update all emulators did (status().lastUpdate). */
  let lastUpdate: EmulatorUpdateReport | undefined
  /** The Update all emulators run going on (a second press joins it). */
  let updating: Promise<EmulatorSetupStatus> | null = null

  function update(): Promise<EmulatorSetupStatus> {
    updating ??= exclusive(updateAll)
      .catch((err) => log.error(`emulator update failed: ${message(err)}`))
      .then(() => status())
      .finally(() => {
        updating = null
      })
    return updating
  }

  /**
   * Every emulator PlayOut installed (its exe in the root), to the newest build of its update channel: checked against
   * the manifest's version, downloaded, unpacked and put over the installed folder (overlay.ts: settings, saves and the
   * junctions stay; on a failure the folder is put back). An emulator that is open is left alone. Its folders are
   * pointed at the data folder again afterwards; the presets are not applied again (the user's settings stay).
   */
  async function updateAll(): Promise<void> {
    const dir = dataDir()
    const root = await resolveRoot()
    await loadManifest()
    await adoptOrphans(root, dir)
    const installed: EmulatorSpec[] = []
    for (const spec of catalog) if (await isFile(exeOf(root, spec))) installed.push(spec)
    const results = new Map<string, EmulatorUpdateItem>()
    const report = (spec: EmulatorSpec, item: Omit<EmulatorUpdateItem, 'id' | 'name'>): void => {
      results.set(spec.id, { id: spec.id, name: spec.name, ...item })
    }
    const candidates: EmulatorSpec[] = []
    for (const spec of installed) {
      if (spec.update) candidates.push(spec)
      else
        report(spec, {
          result: 'unavailable',
          from: manifest.installed[spec.id]?.version
        })
    }
    if (!candidates.length) {
      lastUpdate = { at: new Date(now()).toISOString(), items: [...results.values()] }
      return
    }

    bytes.clear()
    driveFiles.clear()
    current.clear()
    progress = { done: 0, total: candidates.length, stage: 'updates' }
    emit(true)
    log.info(`updating ${candidates.length} emulator(s): ${candidates.map((s) => s.id).join(', ')}`)
    // A newer build may need a runtime the installed one did not (Azahar's MSVC build: Visual C++).
    await ensureNeededRuntimes(root, [
      ...new Set(candidates.flatMap((s) => [...(s.runtimes ?? []), ...(s.update!.runtimes ?? [])]))
    ])
    bytes.delete('runtimes')
    let sevenZipPromise: Promise<string> | null = null
    const sevenZip = (): Promise<string> => {
      sevenZipPromise ??= m.ensureSevenZip(playoutDir(root), http()).catch((err) => {
        sevenZipPromise = null
        throw err
      })
      return sevenZipPromise
    }
    let changed = false
    const queue = [...candidates]
    const worker = async (): Promise<void> => {
      while (queue.length && !controller.signal.aborted) {
        const spec = queue.shift()!
        current.add(spec.name)
        emit(true)
        const from = manifest.installed[spec.id]?.version
        const channel = spec.update!.channel
        try {
          const outcome = await updateOne(root, dir, spec, sevenZip)
          report(spec, { ...outcome, from, channel })
          if (outcome.result === 'updated') changed = true
        } catch (err) {
          log.warn(`${spec.name} could not be updated: ${message(err)}`)
          report(spec, { result: 'failed', from, channel, error: message(err) })
        } finally {
          current.delete(spec.name)
          for (const key of [...bytes.keys()]) if (key.startsWith(`${spec.id}:`)) bytes.delete(key)
          progress = { ...progress, done: progress.done + 1 }
          emit(true)
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker))
      for (const spec of candidates)
        if (!results.has(spec.id))
          report(spec, {
            result: 'failed',
            from: manifest.installed[spec.id]?.version,
            channel: spec.update!.channel,
            error: 'cancelled'
          })
      if (changed) {
        try {
          deps.onInstalled?.()
        } catch (err) {
          log.warn(`onInstalled failed: ${message(err)}`)
        }
      }
    } finally {
      // In catalog order.
      lastUpdate = {
        at: new Date(now()).toISOString(),
        items: catalog.flatMap((s) => results.get(s.id) ?? [])
      }
      bytes.clear()
      current.clear()
      progress = { done: 0, total: 0 }
      emit(true)
    }
  }

  /** One emulator of Update all emulators. Throws when the check or the update fails (the installed build stays). */
  async function updateOne(
    root: string,
    dir: string,
    spec: EmulatorSpec,
    sevenZip: () => Promise<string>
  ): Promise<Pick<EmulatorUpdateItem, 'result' | 'to'>> {
    const exeName = basename(spec.exe).toLowerCase()
    /**
     * Whether it is open, or may be: an unreadable process list throws (its files must not be swapped blind), and a
     * launch of it that began moments ago counts as open (it may not show in the list yet).
     */
    const isOpen = async (): Promise<boolean> => {
      const images = await runningImages()
      if (images === null) throw new Error(tMain('mainEmulatorSetup.processesUnreadable'))
      return images.has(exeName) || now() - (launchedAt.get(spec.id) ?? -Infinity) < LAUNCH_QUIET_MS
    }
    if (await isOpen()) return { result: 'running' }
    const downloads = await m.resolveSource(spec.update!.source, http())
    const to = downloads[0]?.version
    if (!to) throw new Error(tMain('mainEmulatorSetup.noDownload'))
    const recorded = manifest.installed[spec.id]
    if (recorded?.version === to) return { result: 'current', to }

    const staging = join(root, `.${spec.folder}.updating`)
    const target = join(root, spec.folder)
    const files: string[] = []
    try {
      await downloadAndUnpack(root, spec, downloads, staging, sevenZip, files)
      if (!(await isFile(join(staging, spec.exe))))
        throw new Error(tMain('mainEmulatorSetup.exeNotDownloaded', { file: spec.exe }))
      if (controller.signal.aborted) throw new Error('cancelled')

      // From here a launch of it waits until the new build is in and its folders are set. The gate is up before the
      // last check, so a launch is either seen by it (open, or launched moments ago) or waits.
      let open: () => void = () => {}
      const gate = new Promise<void>((r) => (open = r))
      gates.set(spec.id, gate)
      let release: () => void = () => {}
      const swapping = new Promise<void>((r) => (release = r))
      try {
        // Opened while it downloaded: left alone (its files are in use).
        if (await isOpen()) return { result: 'running', to }
        // PlayOut began closing during that check: it no longer waits for a swap started now.
        if (disposed || controller.signal.aborted) throw new Error('cancelled')
        // PlayOut closing waits for the files to be swapped (dispose), so the folder is never left half-way.
        overlaying.add(swapping)
        const overlay = await overlayFolder(staging, target, {
          keep: keepRule(spec.keep ?? []),
          backupDir: join(playoutDir(root), 'update-backup', spec.folder)
        })
        if (!(await isFile(exeOf(root, spec)))) {
          const back = await overlay.undo()
          throw new Error(
            back
              ? tMain('mainEmulatorSetup.update.exeMissingBack', { file: spec.exe })
              : tMain('mainEmulatorSetup.update.exeMissingPending', { file: spec.exe })
          )
        }
        // The new build stays: its backup goes before the manifest says so (a stop in between only means the next
        // update puts the same build in again).
        try {
          await overlay.commit()
        } catch (err) {
          const back = await overlay.undo()
          throw new Error(
            back
              ? tMain('mainEmulatorSetup.update.incompleteBack', { error: message(err) })
              : tMain('mainEmulatorSetup.update.incompletePending', { error: message(err) }),
            { cause: err }
          )
        }
        try {
          // The new build's defaults may point elsewhere: its folders go back to the data folder.
          await configureOne(spec.id, { emuDir: target, dataDir: dir, run, log })
        } catch (err) {
          log.warn(`${spec.name} folders could not be set after the update: ${message(err)}`)
          addNotice(
            tMain('mainEmulatorSetup.update.foldersNotSet', {
              name: spec.name,
              error: message(err)
            })
          )
        }
        manifest.installed[spec.id] = {
          ...(recorded ?? { installedAt: new Date(now()).toISOString() }),
          version: to,
          exe: exeOf(root, spec),
          channel: spec.update!.channel,
          updatedAt: new Date(now()).toISOString()
        }
        await saveManifest()
      } finally {
        overlaying.delete(swapping)
        release()
        open()
        if (gates.get(spec.id) === gate) gates.delete(spec.id)
      }
      log.info(
        `${spec.name} updated from ${recorded?.version ?? 'unknown'} to ${to} (${spec.update!.channel})`
      )
      return { result: 'updated', to }
    } finally {
      await fs.rm(staging, RM_RETRY).catch(() => undefined)
      for (const file of files) await fs.rm(file, { force: true }).catch(() => undefined)
      // Only removed when empty (another emulator's update may be using it, or a backup is kept).
      await fs.rmdir(join(playoutDir(root), 'update-backup')).catch(() => undefined)
    }
  }

  /**
   * Overlays PlayOut did not finish (closed half-way through Update all emulators, or an undo that could not put every
   * file back): each emulator folder is put back from its journal and backup (overlay.ts recoverOverlay). Never throws.
   */
  async function recoverInterruptedUpdates(root: string): Promise<void> {
    const backups = join(playoutDir(root), 'update-backup')
    if (!(await pathExists(backups))) return
    for (const spec of catalog) {
      const backupDir = join(backups, spec.folder)
      if (!(await pathExists(backupDir)) && !(await pathExists(journalOf(backupDir)))) continue
      const outcome = await recoverOverlay(join(root, spec.folder), backupDir)
      if (outcome === 'restored')
        log.warn(`${spec.name}: an interrupted update was undone; the earlier build is back`)
      else if (outcome === 'incomplete') {
        log.warn(
          `${spec.name}: an interrupted update could not be fully undone (kept in ${backupDir})`
        )
        addNotice(tMain('mainEmulatorSetup.update.undoPending', { name: spec.name }))
      }
    }
    await fs.rmdir(backups).catch(() => undefined)
  }

  /** Configure runs in progress, by emulator id: a launch of that emulator waits for its run (beforeLaunch). */
  const configuring = new Map<string, Promise<void>>()
  /** A reconfigure about to update an emulator's changed configurator: its launches wait for that too. */
  const gates = new Map<string, Promise<void>>()

  /** configureEmulator, recording the configure version it ran with (saved with the manifest by the caller). */
  async function configureOne(
    id: string,
    ctx: Parameters<typeof m.configureEmulator>[1]
  ): Promise<void> {
    const task = m.configureEmulator(id, ctx)
    const settled = task.then(
      () => undefined,
      () => undefined
    )
    configuring.set(id, settled)
    try {
      await task
      manifest.configured[id] = versionOf(id)
    } finally {
      if (configuring.get(id) === settled) configuring.delete(id)
    }
  }

  /**
   * Whether `spec` must wait for PlayOut's next start: its configurator changed since it was configured (its run may
   * move folders, as RPCS3's dev_hdd0 in 0.1.109) and it is running now, or the process list cannot tell.
   */
  function heldWhileRunning(spec: EmulatorSpec, images: Set<string> | null): boolean {
    if ((manifest.configured[spec.id] ?? 1) >= versionOf(spec.id)) return false
    if (images === null) {
      // Unknown (tasklist failed): go ahead, as the presets do, rather than hold it at every start.
      log.warn(`process list unavailable; updating ${spec.name} folder settings anyway`)
      return false
    }
    if (!images.has(basename(spec.exe).toLowerCase())) return false
    log.info(`${spec.name} is running: its folder settings are updated at PlayOut's next start`)
    return true
  }

  /**
   * After an update that changed some configurators (CONFIGURE_VERSIONS): configure those installed emulators again,
   * and only those. One that is running is left for PlayOut's next start (moving its folders now could fail half-way
   * or move them under it); so is one that fails. Neither gets its version recorded.
   */
  async function reconfigureOutdated(root: string, dir: string, skip: string[]): Promise<void> {
    const outdated: EmulatorSpec[] = []
    for (const spec of catalog) {
      if (skip.includes(spec.id) || !manifest.installed[spec.id]) continue
      if ((manifest.configured[spec.id] ?? 1) >= versionOf(spec.id)) continue
      if (await isFile(exeOf(root, spec))) outdated.push(spec)
    }
    if (!outdated.length) return
    const images = await runningImages()
    let ran = false
    for (const spec of outdated) {
      if (heldWhileRunning(spec, images)) continue
      try {
        await configureOne(spec.id, { emuDir: join(root, spec.folder), dataDir: dir, run, log })
        ran = true
        log.info(`${spec.name} folder settings updated for this PlayOut version`)
      } catch (err) {
        log.warn(`${spec.name} folders could not be set: ${message(err)}`)
      }
    }
    if (ran) await saveManifest()
  }

  /** Point every installed emulator at the data folder again when it changed; then sync BIOS files. */
  async function reconfigure(force: boolean, skipBiosUnlessChanged = false): Promise<void> {
    // Launches of an emulator whose configurator changed wait from now (beforeLaunch), not only once its run starts:
    // the process list read before it takes a while.
    let open: () => void = () => {}
    const gate = new Promise<void>((r) => (open = r))
    const gated: string[] = []
    try {
      await loadManifest()
      for (const spec of catalog)
        if (
          manifest.installed[spec.id] &&
          (manifest.configured[spec.id] ?? 1) < versionOf(spec.id)
        ) {
          gates.set(spec.id, gate)
          gated.push(spec.id)
        }
      await reconfigureNow(force, skipBiosUnlessChanged)
    } finally {
      open()
      for (const id of gated) if (gates.get(id) === gate) gates.delete(id)
    }
  }

  async function reconfigureNow(force: boolean, skipBiosUnlessChanged: boolean): Promise<void> {
    const dir = dataDir()
    const root = await resolveRoot()
    await loadManifest()
    const adoption = await adoptOrphans(root, dir)
    const changed = force || manifest.configuredFor !== dir
    // The same folder: only emulators whose configurator changed since they were configured run it again.
    if (!changed) await reconfigureOutdated(root, dir, adoption.adopted)
    if (changed) {
      let failures = adoption.failures
      // Read only when an emulator's configurator changed since it was configured (heldWhileRunning).
      let images: Set<string> | null | undefined
      for (const spec of catalog) {
        if (adoption.adopted.includes(spec.id)) continue
        if (!manifest.installed[spec.id] || !(await isFile(exeOf(root, spec)))) continue
        if ((manifest.configured[spec.id] ?? 1) < versionOf(spec.id)) {
          if (images === undefined) images = await runningImages()
          if (heldWhileRunning(spec, images)) {
            // Not pointed at `dir` yet: configuredFor stays unrecorded, so the next start runs it.
            failures++
            continue
          }
        }
        try {
          await configureOne(spec.id, {
            emuDir: join(root, spec.folder),
            dataDir: dir,
            run,
            log
          })
        } catch (err) {
          failures++
          log.warn(`${spec.name} folders could not be set: ${message(err)}`)
        }
      }
      if (Object.keys(manifest.installed).length) {
        manifest.configuredFor = failures ? null : dir
        await saveManifest()
        log.info(`emulators pointed at ${dir}${failures ? ` (${failures} failed)` : ''}`)
      }
    }
    // Emulators installed before the presets existed (0.1.81 / 0.1.82), adopted ones, and ones skipped because they
    // were running or failed: the presets they have not got yet.
    try {
      await applyPendingPresets(root, dir)
    } catch (err) {
      log.warn(`fullscreen and controller presets failed: ${message(err)}`)
    }
    if (changed || !skipBiosUnlessChanged) await syncBiosNow(root, dir)
  }

  // --- data folder changes ---------------------------------------------------------------------------------------

  let lastDataDir = dataDir()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  function watchSettings(): void {
    if (unsubscribe || !deps.settings.onChange) return
    lastDataDir = dataDir()
    unsubscribe = deps.settings.onChange(() => {
      const dir = dataDir()
      if (dir === lastDataDir) return
      lastDataDir = dir
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (disposed) return
        void exclusive(() => reconfigure(false)).catch((err) =>
          log.error(`emulators could not be pointed at the new Emulation folder: ${message(err)}`)
        )
      }, debounceMs)
    })
  }

  /** managedExe's fallback hits (exes found on disk without a manifest entry). */
  const foundExe = new Map<string, string>()

  // --- API -------------------------------------------------------------------------------------------------------

  async function status(): Promise<EmulatorSetupStatus> {
    const root = await resolveRoot()
    await loadManifest()
    const emulationDir = dataDir()
    const items: EmulatorSetupItem[] = []
    for (const spec of catalog) {
      const exe = exeOf(root, spec)
      const recorded = manifest.installed[spec.id]
      const run = itemState.get(spec.id)
      const item: EmulatorSetupItem = { id: spec.id, name: spec.name, state: 'missing' }
      if (await isFile(exe)) {
        item.state = 'installed'
        item.exe = exe
        if (recorded) item.version = recorded.version
        if (recorded?.channel) item.channel = recorded.channel
      } else if (run) {
        item.state = run.state
        if (run.error) item.error = run.error
      }
      items.push(item)
    }
    return {
      root,
      emulationDir,
      biosDir: join(emulationDir, 'bios'),
      items,
      progress: snapshot(),
      notices: [...notices],
      ...(lastUpdate ? { lastUpdate } : {})
    }
  }

  return {
    async startup() {
      try {
        await resolveRoot()
        await loadManifest()
        watchSettings()
        // Before anything reads the emulator folders: an update PlayOut closed during is undone.
        await recoverInterruptedUpdates(await resolveRoot())
        biosSynced = false
        if (!manifest.completed) await setup()
        if (disposed) return
        const synced = biosSynced
        await exclusive(() => reconfigure(false, synced))
        // The PS2 games PCSX2 does not list yet (PCSX2 installed or set up now, or games added while PlayOut was off).
        if (manifest.installed.PCSX2) schedulePrewarm()
      } catch (err) {
        log.error(`emulator setup at startup failed: ${message(err)}`)
      }
    },
    status,
    setup,
    update,
    async runningEmulators() {
      const images = await runningImages()
      if (!images) return []
      return catalog
        .filter((spec) => images.has(basename(spec.exe).toLowerCase()))
        .map((spec) => spec.name)
    },
    managedExe(id) {
      const recorded = manifest.installed[id]?.exe
      if (recorded) return recorded
      const cached = foundExe.get(id)
      if (cached) return cached
      // An install the manifest lost: <root>\<folder>\<exe> when it is there (every usable root before resolving).
      const spec = specById.get(id)
      if (!spec) return null
      for (const root of resolvedRoot ? [resolvedRoot] : usableCandidates()) {
        const exe = exeOf(root, spec)
        if (existsSync(exe)) {
          foundExe.set(id, exe)
          return exe
        }
      }
      return null
    },
    async beforeLaunch(id, exe, rom, context) {
      if (disposed) return
      // Update all emulators leaves it alone from now (and waits below while its files are being swapped).
      launchedAt.set(id, now())
      // Its folders may be moving right now (RPCS3's dev_hdd0 after an update): start it once they are in place.
      const pending = configuring.get(id) ?? gates.get(id)
      if (pending) {
        log.info(`${id}: waiting for its folder settings to be updated before the launch`)
        await pending
        await configuring.get(id)
      }
      // A background PCSX2 scan never runs alongside a game: it stops now (PCSX2 closed, settings put back), and none
      // starts for a while.
      lastLaunchAt = now()
      prewarmAbort?.abort()
      if (id === 'PCSX2') {
        const installed = manifest.installed[id]?.exe
        // A PCSX2 still closing (the game just ended, saving to its memory cards) holds them: a second one started now
        // reports "Memory Card Read Failed". Wait for it to be gone first (up to 15 s, then launch anyway).
        // Only right after a PCSX2 game PlayOut started has ended: a PCSX2 the user opened, or one still running a game,
        // stays open and must not hold the launch. With that game's pid the check needs no process list.
        const endedMsAgo = context?.endedMsAgo
        if (endedMsAgo !== undefined && endedMsAgo < PCSX2_CLOSE_WAIT_MS) {
          const exeName = basename(exe ?? installed ?? 'pcsx2-qt.exe').toLowerCase()
          const left = PCSX2_CLOSE_WAIT_MS - endedMsAgo
          if (!(await waitUntilClosed(exeName, left, context?.pid))) {
            log.warn(
              `${exeName} is still running ${left} ms after its game ended; launching anyway`
            )
          }
        }
        // Only the PCSX2 PlayOut installed, and only for a game file (Game Properties needs its game list entry).
        if (!installed || !rom) return
        if (exe && resolve(exe).toLowerCase() !== resolve(installed).toLowerCase()) return
        // After a background scan's step (stopped above), so its settings are back before this PCSX2 starts.
        const step = pcsx2Step.then(async () => {
          const isRunning = (): Promise<boolean> => pcsx2Running(installed)
          // No scan here: a game PCSX2 does not list yet starts at once and is scanned in the background later.
          const listed = await ensurePcsx2GameListed({
            emuDir: dirname(installed),
            exe: installed,
            rom,
            log,
            startHidden,
            isRunning,
            scan: false
          })
          if (listed === 'pending') {
            if (prewarmRoms.size < PREWARM_BATCH) prewarmRoms.add(rom)
            log.info(`PCSX2 does not list ${rom} yet: it is scanned in the background later`)
          }
          if (listed !== 'skipped')
            await fixSharedMemoryCard({ emuDir: dirname(installed), rom, log, isRunning })
        })
        pcsx2Step = step.catch(() => undefined)
        await step
        return
      }
      if (id === 'M2EMULATOR') {
        const installed = manifest.installed[id]?.exe
        if (!installed || !rom) return
        if (exe && resolve(exe).toLowerCase() !== resolve(installed).toLowerCase()) return
        await addModel2RomDir(dirname(installed), dirname(rom), log)
        return
      }
      if (id !== 'RYUJINX') return
      const installed = manifest.installed[id]?.exe
      if (!installed) return
      // Only the Ryujinx PlayOut installed (a user override elsewhere keeps its own configuration).
      if (exe && resolve(exe).toLowerCase() !== resolve(installed).toLowerCase()) return
      let timer: ReturnType<typeof setTimeout> | undefined
      // Aborted when the launch stops waiting (timeout) or on dispose: the refresh then writes nothing.
      const abort = new AbortController()
      launchRefreshes.add(abort)
      const refresh = Promise.resolve()
        .then(() =>
          refreshRyujinx({
            emuDir: dirname(installed),
            run,
            log,
            signal: abort.signal,
            dataDir: dataDir()
          })
        )
        .then(
          () => 'done' as const,
          (err) => {
            log.warn(`Ryujinx controllers could not be refreshed: ${message(err)}`)
            return 'failed' as const
          }
        )
      const timeout = new Promise<'timeout'>(
        (resolveTimeout) =>
          (timer = setTimeout(() => resolveTimeout('timeout'), beforeLaunchTimeoutMs))
      )
      try {
        if ((await Promise.race([refresh, timeout])) === 'timeout') {
          abort.abort()
          log.warn(
            `Ryujinx controller refresh took over ${beforeLaunchTimeoutMs} ms; launching anyway`
          )
        }
      } finally {
        if (timer) clearTimeout(timer)
        launchRefreshes.delete(abort)
      }
    },
    prewarmPcsx2() {
      schedulePrewarm()
    },
    dispose() {
      disposed = true
      prewarmAbort?.abort()
      if (prewarmTimer) clearTimeout(prewarmTimer)
      prewarmTimer = null
      if (restoreTimer) clearInterval(restoreTimer)
      restoreTimer = null
      for (const abort of launchRefreshes) abort.abort()
      launchRefreshes.clear()
      controller.abort()
      if (debounceTimer) clearTimeout(debounceTimer)
      if (emitTimer) clearTimeout(emitTimer)
      debounceTimer = null
      emitTimer = null
      unsubscribe?.()
      unsubscribe = null
      // A background PCSX2 scan stops (asked above): PCSX2 is asked to close (not forced) and its settings go back.
      // Bounded: what is not done by then is put back at the next start (the marker stays).
      let timer: ReturnType<typeof setTimeout> | undefined
      const bound = new Promise<void>((r) => {
        timer = setTimeout(r, DISPOSE_WAIT_MS)
        timer.unref?.()
      })
      // An update swapping an emulator's files finishes first (or is undone), so the folder is never left half-way.
      const steps = Promise.all([pcsx2Step, ...overlaying]).then(() => undefined)
      return Promise.race([steps, bound]).finally(() => clearTimeout(timer))
    }
  }
}
