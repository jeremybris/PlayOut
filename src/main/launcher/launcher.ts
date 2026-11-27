import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { dirname, extname, join } from 'path'
import type { Game, LaunchError, LaunchResult, LaunchSpec } from '../../shared/types'
import type { EmulationService } from '../emulation/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { psQuote, runPowerShell, type PowerShellResult } from '../system/powershell'
import { isDirectory, isFile, pathExists } from '../util/fs'
import { isInside, knownFolders, normalizePath } from '../util/paths'
import {
  findByNames,
  normalizeProcessName,
  type ProcessInfo,
  type ProcessMonitor
} from './process-monitor'
import type { SessionTracker } from './session-tracker'
import type { LauncherService, LaunchOptions } from './types'
import { tMain } from '../i18n'

/** What a Windows shortcut points at (Electron's shell.readShortcutLink). */
export interface ShortcutTarget {
  target: string
  /** Raw command line of the shortcut, as typed in its properties dialog. */
  args?: string
  cwd?: string
}

/** The side effects of a launch, injectable for tests. */
export interface LaunchIo {
  openExternal(uri: string): Promise<void>
  spawn(file: string, args: string[], options: SpawnOptions): ChildProcess
  sleep(ms: number): Promise<void>
  /** One-shot PowerShell for the elevated (UAC) start; never reached in tests with a fake. */
  runPowerShell(script: string, options: { timeoutMs: number }): Promise<PowerShellResult>
  /** Resolve a .lnk; throws when the file is not a readable shortcut. */
  readShortcutLink(file: string): Promise<ShortcutTarget>
  /** `taskkill /T /F /PID <pid>`; resolves when it finished, rejects with its message when it failed. */
  killTree(pid: number): Promise<void>
}

/**
 * The UAC consent dialog dismisses itself after about two minutes; the elevated start must outlive it so a slow
 * answer is never reported as a failure.
 */
export const ELEVATED_START_TIMEOUT_MS = 150_000

export interface GameLauncherDeps {
  emulation: EmulationService
  tracker: SessionTracker
  log: Logger
  /** Process list for client pre-start checks (Battle.net); without it games launch directly. */
  monitor?: Pick<ProcessMonitor, 'listNames'>
  /**
   * Called before an emulator game is spawned, with the emulator's find-rules id and executable (PlayOut's emulator
   * setup refreshes Ryujinx's controllers). Its errors are logged and never stop the launch.
   */
  beforeLaunch?(
    emulatorId: string,
    exe: string,
    rom?: string,
    context?: BeforeLaunchContext
  ): Promise<void>
  /** Session ends ('session:ended'): how long ago the same emulator's last game ended reaches beforeLaunch. */
  events?: Pick<EventBus, 'on'>
  /**
   * Why the game must not start now (an upgrade is rewriting its files), else null. Checked first by every launch,
   * so Play, the play menu and a streamed start are all refused with this line.
   */
  launchBlocked?(game: Game): string | null
  /**
   * Called once a launch is planned, before anything starts (PC Saves copies a newer copy of a game's saves back): an
   * error refuses the start with it; a throw is logged and the game starts. `streamed`: a paired PC's stream.
   */
  beforeGameLaunch?(game: Game, context: { streamed: boolean }): Promise<LaunchError | null>
  io?: Partial<LaunchIo>
}

/** What the launcher knows when an emulator game is about to start. */
export interface BeforeLaunchContext {
  /** How long ago (ms) a game PlayOut started with the same emulator ended; absent when none did since start-up. */
  endedMsAgo?: number
  /** The process PlayOut spawned for that game (with endedMsAgo, when known): whether it is still closing. */
  pid?: number
}

/** Playnite's BattleNetGameController: the client is "up" once this many Battle.net processes exist. */
export const BATTLENET_READY_PROCESSES = 5
export const BATTLENET_START_TIMEOUT_MS = 90_000
const BATTLENET_SETTLE_MS = 5_000
const BATTLENET_POLL_MS = 1_000

/** How long stop() waits for a closed game's processes to disappear before it gives up on them. */
export const STOP_TIMEOUT_MS = 10_000
const STOP_POLL_MS = 500
/** taskkill's exit code when the process is already gone. */
const TASKKILL_NOT_FOUND = 128

/**
 * Processes stop() never closes even when a session matches them: a bad install dir (a drive root, a profile
 * folder) or a hand-off into the shell must not take Windows or PlayOut down with the game.
 */
const PROTECTED_PROCESS_NAMES = new Set([
  'explorer',
  'svchost',
  'csrss',
  'wininit',
  'winlogon',
  'lsass',
  'services',
  'smss',
  'dwm',
  'sihost',
  'ctfmon',
  'fontdrvhost',
  'taskhostw',
  'runtimebroker',
  'startmenuexperiencehost',
  'shellexperiencehost',
  'searchhost',
  'textinputhost',
  'applicationframehost',
  'sunshine',
  'playout'
])

/** A validated launch, ready to execute. */
export type LaunchPlan =
  | { kind: 'uri'; uri: string }
  | {
      kind: 'spawn'
      file: string
      args: string[]
      cwd: string | undefined
      hideWindow: boolean
      runInBackground: boolean
      /** Where the real game lives when the spawned process is only a launcher (see SessionTracker). */
      handoffDir: string | undefined
      /** The find-rules id of the emulator this spawn starts (emulator games only). */
      emulatorId?: string
      /** The game's file or folder (emulator games only). */
      rom?: string
    }

export type LaunchPlanResult = LaunchPlan | { error: LaunchError }

/**
 * The only schemes a `uri` launch hands to `shell.openExternal`: the store clients' own protocols. The providers
 * emit steam: (`steam://rungameid/<appid>`), com.epicgames.launcher: (`…://apps/<id>?action=launch`), origin2: (EA),
 * battlenet: and uplay: (Ubisoft); the `launch` of an owned, not installed record (installs/install-uri.ts) adds
 * goggalaxy:, msxbox: and ms-windows-store:. No provider launches through http(s):, file: or any other scheme, so a
 * library record carrying one (a damaged or tampered library.json, a record synced from elsewhere) is refused
 * instead of being opened by whatever program Windows has registered for it.
 */
export const ALLOWED_LAUNCH_SCHEMES: readonly string[] = [
  'steam:',
  'com.epicgames.launcher:',
  'origin2:',
  'battlenet:',
  'uplay:',
  'goggalaxy:',
  'msxbox:',
  'ms-windows-store:'
]

/** The scheme of a URI with its colon, lower-case ('steam:'); null when the text has none. */
function uriScheme(uri: string): string | null {
  const match = /^([a-z][a-z0-9.+-]*:)/i.exec(uri)
  return match ? match[1].toLowerCase() : null
}

export function isAllowedLaunchUri(uri: string): boolean {
  const scheme = uriScheme(uri)
  return scheme !== null && ALLOWED_LAUNCH_SCHEMES.includes(scheme)
}

const defaultIo: LaunchIo = {
  // Loaded lazily so this module (and its tests) can run outside Electron.
  async openExternal(uri) {
    const { shell } = await import('electron')
    await shell.openExternal(uri)
  },
  spawn,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runPowerShell,
  async readShortcutLink(file) {
    const { shell } = await import('electron')
    const link = shell.readShortcutLink(file)
    return { target: link.target, args: link.args, cwd: link.cwd }
  },
  killTree(pid) {
    return new Promise((resolve, reject) => {
      execFile(
        'taskkill.exe',
        ['/T', '/F', '/PID', String(pid)],
        { windowsHide: true, timeout: 15_000, encoding: 'utf8' },
        (error, _stdout, stderr) => {
          if (!error || error.code === TASKKILL_NOT_FOUND) resolve()
          else reject(new Error(String(stderr ?? '').trim() || error.message))
        }
      )
    })
  }
}

export function createGameLauncher(deps: GameLauncherDeps): LauncherService {
  const io: LaunchIo = { ...defaultIo, ...deps.io }
  const { emulation, tracker, log, monitor } = deps

  /**
   * `Battle.net.exe --exec="launch <code>"` is dropped when the client is not running yet (it only starts the
   * client), so the client is started first and the command is sent once it has settled.
   */
  async function ensureBattlenetClient(game: Game): Promise<void> {
    const clientPath = game.extra?.clientPath
    if (
      !monitor ||
      game.source !== 'battlenet' ||
      game.extra?.launchesViaClient !== true ||
      typeof clientPath !== 'string'
    )
      return
    const count = async (): Promise<number> =>
      findByNames(await monitor.listNames(), ['Battle.net']).length
    if ((await count()) > 0) return
    log.info(`starting the Battle.net client (${clientPath}) before ${game.title}`)
    // A ChildProcess reports a failed spawn (EACCES, a file removed since the plan) as an asynchronous 'error';
    // without a listener Node raises it as an uncaught exception, which kills the main process.
    const started = await new Promise<boolean>((resolve) => {
      try {
        const client = io.spawn(clientPath, [], {
          cwd: dirname(clientPath),
          detached: true,
          stdio: 'ignore'
        })
        client.once('spawn', () => resolve(true))
        client.on('error', (err) => {
          log.warn(`could not start the Battle.net client (${clientPath}): ${err.message}`)
          resolve(false)
        })
        client.unref()
      } catch (err) {
        log.warn(`could not start the Battle.net client (${clientPath}): ${(err as Error).message}`)
        resolve(false)
      }
    })
    // The launch command below spawns the same executable and reports the real LaunchError.
    if (!started) return
    const deadline = Date.now() + BATTLENET_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      await io.sleep(BATTLENET_POLL_MS)
      if ((await count()) >= BATTLENET_READY_PROCESSES) {
        await io.sleep(BATTLENET_SETTLE_MS)
        return
      }
    }
    log.warn('the Battle.net client did not come up in time; sending the launch command anyway')
  }

  /**
   * Launches of a game still being started (a before-launch step can take a few seconds): a second Play gets the same
   * result instead of starting the game twice.
   */
  const starting = new Map<string, Promise<LaunchResult>>()
  /**
   * The emulator (and spawned process) of each emulator game PlayOut started, and when (and with which process) each
   * emulator's last game ended.
   */
  const emulatorOfGame = new Map<string, { emulatorId: string; pid?: number }>()
  const endedAt = new Map<string, { at: number; pid?: number }>()
  const unsubscribe = deps.events?.on('session:ended', ({ gameId }) => {
    const ran = emulatorOfGame.get(gameId)
    if (ran) endedAt.set(ran.emulatorId, { at: Date.now(), pid: ran.pid })
  })

  function launch(game: Game, options?: LaunchOptions): Promise<LaunchResult> {
    const blocked = deps.launchBlocked?.(game) ?? null
    if (blocked) {
      log.warn(`cannot launch ${game.title}: ${blocked}`)
      return Promise.resolve({ ok: false, error: { kind: 'failed', message: blocked } })
    }
    const pending = starting.get(game.id)
    if (pending) {
      log.info(`${game.title} is already starting`)
      return pending
    }
    const result = launchNow(game, options).finally(() => starting.delete(game.id))
    starting.set(game.id, result)
    return result
  }

  async function launchNow(game: Game, options?: LaunchOptions): Promise<LaunchResult> {
    const plan = await planLaunch(game, options, emulation, log)
    if ('error' in plan) {
      log.warn(`cannot launch ${game.title}: ${plan.error.kind}: ${plan.error.message}`)
      return { ok: false, error: plan.error }
    }
    if (deps.beforeGameLaunch) {
      let refused: LaunchError | null = null
      try {
        refused = await deps.beforeGameLaunch(game, { streamed: options?.streamed === true })
      } catch (err) {
        log.warn(`before-launch step for ${game.title} failed: ${(err as Error).message}`)
      }
      if (refused) {
        log.warn(`cannot launch ${game.title}: ${refused.kind}: ${refused.message}`)
        return { ok: false, error: refused }
      }
    }
    if (plan.kind === 'spawn') await ensureBattlenetClient(game)
    if (plan.kind === 'spawn' && plan.emulatorId && deps.beforeLaunch) {
      try {
        const ended = endedAt.get(plan.emulatorId)
        await deps.beforeLaunch(
          plan.emulatorId,
          plan.file,
          plan.rom,
          ended === undefined
            ? {}
            : {
                endedMsAgo: Date.now() - ended.at,
                ...(ended.pid !== undefined ? { pid: ended.pid } : {})
              }
        )
      } catch (err) {
        log.warn(`before-launch step for ${plan.emulatorId} failed: ${(err as Error).message}`)
      }
    }

    // One game at a time: the running session ends before the next game starts. A trackable launch keeps the
    // window minimized for its own session and restores it at the end; a failed launch restores it below.
    const previous = tracker.current()
    if (previous) tracker.end({ restore: false, reason: `replaced by ${game.title}` })

    const fail = (error: LaunchError): LaunchResult => {
      log.error(`launch of ${game.title} failed: ${error.message}`)
      if (previous) tracker.restoreWindow()
      return { ok: false, error }
    }

    try {
      let child: ChildProcess | undefined
      let pid: number | undefined
      let spawnedAt: number | undefined
      if (plan.kind === 'uri') {
        log.info(`launching ${game.title}: ${plan.uri}`)
        await io.openExternal(plan.uri)
      } else {
        const resolved = await resolveShortcut(io, plan, log)
        if ('error' in resolved) return fail(resolved.error)
        const command = buildSpawnCommand(resolved.file, resolved.args)
        if ('error' in command) return fail(command.error)
        const target = { ...plan, ...resolved }
        log.info(
          `launching ${game.title}: ${command.file} ${command.args.join(' ')} (cwd ${target.cwd ?? 'inherited'})`
        )
        spawnedAt = Date.now()
        try {
          child = await spawnDetached(io, command, target, log)
        } catch (err) {
          if (!needsElevation(err, command)) throw err
          log.info(`${target.file} needs elevation; launching ${game.title} elevated (UAC)`)
          const elevated = await startElevated(io, target)
          if (!elevated.ok)
            return fail({
              kind: 'failed',
              message: elevated.detail
                ? tMain('mainLauncher.elevationFailedWhy', {
                    title: game.title,
                    detail: elevated.detail
                  })
                : tMain('mainLauncher.elevationFailed', { title: game.title })
            })
          pid = elevated.pid
        }
      }
      if (plan.kind === 'spawn' && plan.emulatorId) {
        const spawned = child?.pid ?? pid
        emulatorOfGame.set(game.id, {
          emulatorId: plan.emulatorId,
          ...(spawned !== undefined ? { pid: spawned } : {})
        })
        // This emulator runs a game again: an earlier end no longer means one of its processes is closing.
        endedAt.delete(plan.emulatorId)
      } else {
        emulatorOfGame.delete(game.id)
      }
      const session = tracker.start({
        game,
        child,
        pid,
        spawnedAt,
        runInBackground: plan.kind === 'spawn' ? plan.runInBackground : false,
        // An emulator comes up in front first, then PlayOut minimizes (store and Steam launches: at once, as before).
        waitForWindow: plan.kind === 'spawn' && game.launch.kind === 'emulator',
        handoffDir: plan.kind === 'spawn' ? plan.handoffDir : undefined
      })
      return { ok: true, startedAt: session.startedAt }
    } catch (err) {
      const message = (err as Error).message || String(err)
      return fail({
        kind: 'failed',
        message: tMain('mainLauncher.couldNotStart', { title: game.title, error: message })
      })
    }
  }

  /** The session's processes minus protected ones; null when the process list failed. */
  async function listGameProcesses(): Promise<ProcessInfo[] | null> {
    try {
      return (await tracker.gameProcesses()).filter((p) => !isProtectedProcess(p))
    } catch (err) {
      log.warn(`could not list the game's processes: ${(err as Error).message}`)
      return null
    }
  }

  async function stop(gameId: string): Promise<boolean> {
    const session = tracker.current()
    if (!session || session.gameId !== gameId) return true
    const same = (): boolean => {
      const now = tracker.current()
      return now !== null && now.gameId === session.gameId && now.startedAt === session.startedAt
    }
    // Without a process list the spawned pid is still known, and taskkill /T reaches its children by itself.
    const targets =
      (await listGameProcesses()) ??
      (session.pid
        ? [{ pid: session.pid, parentPid: null, name: '', path: null, sessionId: -1 }]
        : [])
    if (!same()) return true
    log.info(
      `stopping ${gameId}: ${targets.map((p) => `${p.name || '?'} (${p.pid})`).join(', ') || 'no processes found'}`
    )
    // taskkill /T on a parent also takes the children, so a child that is gone by its turn is not an error.
    await Promise.all(
      targets.map((p) =>
        io.killTree(p.pid).catch((err: Error) => {
          log.warn(`could not close ${p.name || '?'} (${p.pid}): ${err.message}`)
        })
      )
    )
    const deadline = Date.now() + STOP_TIMEOUT_MS
    for (;;) {
      if (!same()) return true
      const left = await listGameProcesses()
      if (!same()) return true
      if (left && !left.length) {
        tracker.end({ reason: 'stopped on request' })
        return true
      }
      if (Date.now() >= deadline) {
        // The session stays: it ends by itself (poll, linger or grace) once the game really exits.
        const what = left ? left.map((p) => `${p.name || '?'} (${p.pid})`).join(', ') : 'unknown'
        log.warn(`${gameId} may still be running after stop: ${what}`)
        return false
      }
      await io.sleep(STOP_POLL_MS)
    }
  }

  return {
    launch,
    stop,
    track(game, child, options) {
      // Not an emulator session: its end must not count as an emulator's.
      emulatorOfGame.delete(game.id)
      const previous = tracker.current()
      if (previous)
        tracker.end({
          restore: false,
          reason: `replaced by ${game.title} (${options?.reason ?? 'Co-Op'})`
        })
      const handoffDir = safeHandoffDir(options?.handoffDir)
      tracker.start({
        game: { ...game, tracking: { mode: 'spawned' } },
        child,
        spawnedAt: Date.now(),
        ...(handoffDir ? { handoffDir } : {})
      })
    },
    running() {
      const current = tracker.current()
      return current
        ? {
            gameId: current.gameId,
            startedAt: current.startedAt,
            ...(current.pid !== undefined ? { pid: current.pid } : {})
          }
        : null
    },
    async gameProcesses() {
      return (await tracker.gameProcesses()).map((p) => ({ pid: p.pid, name: p.name }))
    },
    dispose() {
      unsubscribe?.()
      tracker.dispose()
    }
  }
}

/** Resolve the LaunchSpec into a concrete command and check that everything it needs exists. */
export async function planLaunch(
  game: Game,
  options: { emulatorId?: string } | undefined,
  emulation: EmulationService,
  log: Logger
): Promise<LaunchPlanResult> {
  const spec: LaunchSpec = game.launch
  switch (spec.kind) {
    case 'uri': {
      if (!isAllowedLaunchUri(spec.uri)) {
        const scheme = uriScheme(spec.uri)
        return {
          error: {
            kind: 'failed',
            message: scheme
              ? tMain('mainLauncher.badScheme', { title: game.title, scheme })
              : tMain('mainLauncher.noLink', { title: game.title })
          }
        }
      }
      return { kind: 'uri', uri: spec.uri }
    }

    case 'exec': {
      if (!(await isFile(spec.file))) return { error: fileMissing('executable', spec.file) }
      return {
        kind: 'spawn',
        file: spec.file,
        args: [...spec.args, ...tokenizeArgs(game.user.extraArgs ?? '')],
        cwd: await resolveCwd(spec.cwd, spec.file, log),
        hideWindow: false,
        runInBackground: false,
        handoffDir: safeHandoffDir(game.installDir ?? dirname(spec.file))
      }
    }

    case 'emulator': {
      const resolved = await emulation.resolveLaunch(
        game,
        options?.emulatorId ?? game.user.emulatorId
      )
      if (!resolved.ok) return { error: resolved.error }
      if (!(await isFile(resolved.file))) return { error: fileMissing('emulator', resolved.file) }
      const rom = game.romPath ?? spec.romPath
      // A ROM may be a directory for systems with dirExtensions (.ps3, .wiiu), so only existence is checked.
      if (rom && !(await pathExists(rom))) return { error: fileMissing('rom', rom) }
      return {
        kind: 'spawn',
        file: resolved.file,
        args: resolved.args,
        cwd: await resolveCwd(resolved.cwd, resolved.file, log),
        hideWindow: resolved.hideWindow,
        runInBackground: resolved.runInBackground,
        handoffDir: safeHandoffDir(dirname(resolved.file)),
        ...(resolved.emulatorId ? { emulatorId: resolved.emulatorId } : {}),
        ...(rom ? { rom } : {})
      }
    }

    case 'uwp':
      return {
        kind: 'spawn',
        file: 'explorer.exe',
        args: ['shell:AppsFolder\\' + spec.aumid],
        cwd: undefined,
        hideWindow: false,
        runInBackground: false,
        handoffDir: undefined
      }
  }
}

function fileMissing(what: 'executable' | 'emulator' | 'rom', path: string): LaunchError {
  const message =
    what === 'executable'
      ? tMain('mainLauncher.executableMissing', { path })
      : what === 'emulator'
        ? tMain('mainLauncher.emulatorMissing', { path })
        : tMain('mainLauncher.romMissing', { path })
  return { kind: 'file-missing', message }
}

/**
 * A directory is only evidence of "the game is still running" when it belongs to that game. Windows, drive roots
 * and the Program Files / profile roots host unrelated user-session processes (conhost, RuntimeBroker, ...),
 * so a hand-off watch there would never end the session.
 */
export function safeHandoffDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined
  const norm = normalizePath(dir)
  if (/^[a-z]:$/.test(norm) || !/^[a-z]:\\/.test(norm)) return undefined
  const folders = knownFolders()
  const systemRoot =
    process.env['SystemRoot'] || process.env['windir'] || join(folders.systemDrive, 'Windows')
  if (norm === normalizePath(systemRoot) || isInside(systemRoot, dir)) return undefined
  const roots = [
    folders.programFiles,
    folders.programFilesX86,
    folders.programData,
    folders.userProfile,
    folders.appData,
    folders.localAppData,
    folders.publicDir,
    join(folders.systemDrive, 'Users')
  ]
  return roots.some((root) => normalizePath(root) === norm) ? undefined : dir
}

/** True for a process stop() must leave alone: PlayOut itself, Windows' own processes and the shell. */
export function isProtectedProcess(p: Pick<ProcessInfo, 'pid' | 'name' | 'path'>): boolean {
  if (p.pid <= 4 || p.pid === process.pid || p.pid === process.ppid) return true
  if (PROTECTED_PROCESS_NAMES.has(normalizeProcessName(p.path ?? p.name))) return true
  if (!p.path) return false
  const systemRoot =
    process.env['SystemRoot'] ||
    process.env['windir'] ||
    join(knownFolders().systemDrive, 'Windows')
  return isInside(systemRoot, p.path)
}

/** The requested working directory when it exists, else the executable's folder. */
async function resolveCwd(cwd: string | undefined, file: string, log: Logger): Promise<string> {
  if (cwd) {
    if (await isDirectory(cwd)) return cwd
    log.warn(`working directory ${cwd} does not exist; using the executable's folder`)
  }
  return dirname(file)
}

export interface SpawnCommand {
  file: string
  args: string[]
  /** True when `args` is already one quoted command line (cmd.exe wrapper). */
  verbatim: boolean
}

export type SpawnCommandResult = SpawnCommand | { error: LaunchError }

/** The spawn target after shortcut resolution: file, argv and working directory. */
interface SpawnTarget {
  file: string
  args: string[]
  cwd: string | undefined
}

/**
 * Node refuses to spawn .bat/.cmd files directly (CVE-2024-27980), so those go through `cmd.exe /d /s /c` with a
 * command line quoted for cmd (`quoteCmdArg`), never for CreateProcess: cmd has no backslash escaping and reads
 * `& | < > ^` in a bare token as operators, so every token is double-quoted (inside quotes cmd takes those
 * literally) and tokens cmd would still interpret (`"`, `%`, line breaks) are refused. `/V:OFF` keeps `!` inert.
 * A .lnk that could not be resolved (`resolveShortcut`) is handed to `start ""` under the same rules. Everything
 * else spawns as given, quoted by Node for CommandLineToArgvW.
 */
export function buildSpawnCommand(file: string, args: string[]): SpawnCommandResult {
  const ext = extname(file).toLowerCase()
  if (ext !== '.bat' && ext !== '.cmd' && ext !== '.lnk') return { file, args, verbatim: false }
  const comspec = process.env['ComSpec'] || 'cmd.exe'
  const quoted: string[] = []
  for (const token of [file, ...args]) {
    const q = quoteCmdArg(token)
    if (q === null)
      return {
        error: {
          kind: 'failed',
          message: tMain('mainLauncher.unsafeArgument', { file, argument: token })
        }
      }
    quoted.push(q)
  }
  // `start ""` (empty window title) resolves the shortcut's target and arguments like a double-click would.
  const line = ext === '.lnk' ? `start "" ${quoted.join(' ')}` : quoted.join(' ')
  // /s makes cmd strip exactly the outer quotes of the command and keep every inner quote.
  return { file: comspec, args: ['/d', '/s', '/V:OFF', '/c', `"${line}"`], verbatim: true }
}

/**
 * Quote one token for a cmd.exe command line: always double-quoted (cmd does not interpret `& | < > ^ ( )` inside
 * quotes, and a batch file receives the quotes as part of `%1`, which is how arguments normally arrive). Returns
 * null for a token that cannot be made safe: a `"` would end the quoting, `%` expands even inside quotes
 * (`%VAR%`), and a line break ends the command.
 */
export function quoteCmdArg(arg: string): string | null {
  if (/["%\r\n\0]/.test(arg)) return null
  return `"${arg}"`
}

/**
 * Resolve a .lnk through the shell so the target is spawned directly (a shortcut to a .bat still gets the cmd
 * rules through buildSpawnCommand). When the shortcut cannot be read, the plan is returned unchanged and
 * buildSpawnCommand falls back to `start ""`.
 */
async function resolveShortcut(
  io: LaunchIo,
  plan: Extract<LaunchPlan, { kind: 'spawn' }>,
  log: Logger
): Promise<SpawnTarget | { error: LaunchError }> {
  const { file, args, cwd } = plan
  if (extname(file).toLowerCase() !== '.lnk') return { file, args, cwd }
  let link: ShortcutTarget
  try {
    link = await io.readShortcutLink(file)
  } catch (err) {
    log.warn(
      `could not read shortcut ${file}: ${(err as Error).message}; starting it through the shell`
    )
    return { file, args, cwd }
  }
  const target = (link.target ?? '').trim()
  if (!target)
    return {
      error: { kind: 'file-missing', message: tMain('mainLauncher.shortcutNoTarget', { file }) }
    }
  if (extname(target).toLowerCase() === '.lnk')
    return { error: { kind: 'failed', message: tMain('mainLauncher.shortcutChain', { file }) } }
  if (!(await isFile(target)))
    return {
      error: {
        kind: 'file-missing',
        message: tMain('mainLauncher.shortcutTargetMissing', { file: target })
      }
    }
  const linkCwd = (link.cwd ?? '').trim()
  return {
    file: target,
    args: [...tokenizeArgs(link.args ?? ''), ...args],
    cwd: linkCwd && (await isDirectory(linkCwd)) ? linkCwd : cwd || dirname(target)
  }
}

function spawnDetached(
  io: LaunchIo,
  command: SpawnCommand,
  plan: Pick<Extract<LaunchPlan, { kind: 'spawn' }>, 'cwd' | 'hideWindow'>,
  log: Logger
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = io.spawn(command.file, command.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: plan.hideWindow,
      windowsVerbatimArguments: command.verbatim
    })
    child.once('spawn', () => {
      log.debug(`spawned pid ${child.pid}`)
      resolve(child)
    })
    child.on('error', (err) => {
      log.warn(`spawned process error: ${err.message}`)
      reject(err)
    })
    child.unref()
  })
}

/**
 * CreateProcess fails with ERROR_ELEVATION_REQUIRED for an exe whose manifest says requireAdministrator (or with the
 * "run as administrator" compatibility flag); libuv reports it as EACCES. Only a directly spawned exe can need it:
 * the cmd.exe wrapper for .bat/.cmd/.lnk never does, so EACCES there is a genuine error.
 */
function needsElevation(err: unknown, command: SpawnCommand): boolean {
  return !command.verbatim && (err as NodeJS.ErrnoException).code === 'EACCES'
}

/**
 * Retry through `Start-Process -Verb RunAs` (docs/research/electron-stack.md section 7.2), which shows the UAC
 * prompt; -PassThru gives the new pid for 'spawned' tracking (its ExecutablePath is hidden from a standard user,
 * so pid liveness is the primary signal). A declined prompt surfaces as "The operation was canceled by the user."
 */
export function elevatedStartScript(
  target: Pick<Extract<LaunchPlan, { kind: 'spawn' }>, 'file' | 'args' | 'cwd' | 'hideWindow'>
): string {
  // -ArgumentList joins an array with spaces without quoting, so one pre-quoted command line is passed instead;
  // PowerShell 5.1 rejects an empty -ArgumentList, so it is omitted when there are no arguments.
  const argLine = target.args.map(quoteWindowsArg).join(' ')
  return (
    `$p = Start-Process -FilePath ${psQuote(target.file)}` +
    ` -WorkingDirectory ${psQuote(target.cwd ?? dirname(target.file))}` +
    (argLine ? ` -ArgumentList ${psQuote(argLine)}` : '') +
    (target.hideWindow ? ' -WindowStyle Hidden' : '') +
    ' -Verb RunAs -PassThru\n$p.Id'
  )
}

async function startElevated(
  io: LaunchIo,
  target: Pick<Extract<LaunchPlan, { kind: 'spawn' }>, 'file' | 'args' | 'cwd' | 'hideWindow'>
): Promise<{ ok: true; pid: number } | { ok: false; detail: string }> {
  let result: PowerShellResult
  try {
    result = await io.runPowerShell(elevatedStartScript(target), {
      timeoutMs: ELEVATED_START_TIMEOUT_MS
    })
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
  const pid = Number.parseInt(result.stdout.trim().split(/\r?\n/).pop() ?? '', 10)
  if (result.code !== 0 || !Number.isInteger(pid) || pid <= 0)
    return { ok: false, detail: result.stderr.trim().split(/\r?\n/)[0] || `exit ${result.code}` }
  return { ok: true, pid }
}

/**
 * Split user-typed extra arguments like a Windows command line: whitespace separates arguments, double quotes
 * group them (quotes removed), `\"` is a literal quote. Other backslashes are kept as they are (paths).
 */
export function tokenizeArgs(input: string): string[] {
  const out: string[] = []
  let current = ''
  let inToken = false
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\' && input[i + 1] === '"') {
      current += '"'
      inToken = true
      i++
    } else if (ch === '"') {
      quoted = !quoted
      inToken = true
    } else if (!quoted && /\s/.test(ch)) {
      if (inToken) out.push(current)
      current = ''
      inToken = false
    } else {
      current += ch
      inToken = true
    }
  }
  if (inToken) out.push(current)
  return out
}

/** Quote one argument the way CommandLineToArgvW expects (the convention Node itself uses for spawn). */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      out += '\\'.repeat(backslashes) + ch
    }
    backslashes = 0
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}
