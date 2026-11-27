import type { ChildProcess, SpawnOptions } from 'child_process'
import { spawn as nodeSpawn } from 'child_process'
import { createHash, randomBytes, X509Certificate } from 'crypto'
import { promises as fs } from 'fs'
import { request as httpsRequest } from 'https'
import { connect } from 'net'
import { dirname, join, sep } from 'path'
import { createInterface } from 'readline'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import type { StreamingToolStatus } from '../../shared/types'
import type { Logger } from '../logger'
import { readJson } from '../util/fs'
import { isMoonlightPin } from './pairing'
import {
  ensureGithubTool,
  findToolFile,
  readInstalledTool,
  SUNSHINE_TOOL,
  type GithubToolSpec,
  type InstalledTool
} from './tools'
import { tMain } from '../i18n'

/**
 * Sunshine (the GameStream host Moonlight connects to) run by PlayOut as a plain hidden child process: the portable
 * build, PlayOut's own config folder, no service, no tray icon and no admin. Its web API is only used from here (main
 * process, localhost, Basic auth): Sunshine skips its CSRF check for requests without Origin or Referer, which Node
 * never sends.
 */

export const SUNSHINE_EXE = 'sunshine.exe'
export const SUNSHINE_USER = 'playout'
/** Sunshine's base (GameStream HTTP) port; the web API is on port + 1. */
export const SUNSHINE_DEFAULT_PORT = 47989
/** The one app PlayOut offers: it runs PlayOut's stream launcher, which plays the game the client asked for. */
export const SUNSHINE_APP_NAME = 'PlayOut'

/**
 * The ports Sunshine's own UPnP would forward for a base port (GameStream HTTPS, HTTP and RTSP over TCP; video, control
 * and audio over UDP). PlayOut forwards them itself and keeps Sunshine's UPnP off: Sunshine is ended by force, which
 * skips its own clean-up, so its mappings would stay on the router.
 */
export function sunshinePorts(base: number): ['TCP' | 'UDP', number][] {
  return [
    ['TCP', base - 5],
    ['TCP', base],
    ['TCP', base + 21],
    ['UDP', base + 9],
    ['UDP', base + 10],
    ['UDP', base + 11]
  ]
}

/** Windows' own tools by full path: a bare name is looked up in the current folder before PATH. */
function systemTool(...parts: string[]): string {
  const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  return join(root, 'System32', ...parts)
}

const API_TIMEOUT_MS = 15_000
/** POST /api/pin waits for Moonlight's handshake to finish before it answers. */
const PIN_POST_TIMEOUT_MS = 60_000
/** Sunshine tests every video encoder before it listens: about 30 s on its first start (seen on an Intel + NVIDIA laptop). */
const READY_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 5_000
const CREDS_TIMEOUT_MS = 30_000
/** After ending a leftover Sunshine: how many half-second checks for its ports to free up. */
const ORPHAN_PORT_CHECKS = 10
/** Restarts after a crash: back off, and give up after this many within the window. */
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 2 * 60_000

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface SunshineHttpRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  /**
   * Sunshine's certificate (`config/credentials/cacert.pem`), when it exists. The default request only talks to a
   * server holding exactly this certificate, so the password never goes to whatever else listens on the port while
   * Sunshine is down.
   */
  pinnedCertPem?: string
}

export type SunshineRequestFn = (
  req: SunshineHttpRequest
) => Promise<{ status: number; body: string }>

/** Where the Sunshine password lives between runs (the streaming service's encrypted secrets). */
export interface SecretSlot {
  get(): Promise<string | null>
  set(value: string): Promise<void>
}

export interface SunshineDeps {
  /** userData/streaming/sunshine: the release goes in `app/`, PlayOut's config for it in `config/`. */
  root: string
  log: Logger
  spawn?: SpawnFn
  request?: SunshineRequestFn
  fetch?: typeof fetch
  /** Without one the password lives in memory and is set again on every start (harmless: --creds is quick). */
  secret?: SecretSlot
  /** Whether something answers on 127.0.0.1:port. */
  probePort?: (port: number) => Promise<boolean>
  /** PIDs of sunshine.exe processes running from under `dir` (copies an earlier PlayOut left behind). */
  ownProcesses?: (dir: string) => Promise<number[]>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The release to use (tests). */
  tool?: GithubToolSpec
  onStatus?: (status: StreamingToolStatus) => void
  /**
   * Sunshine closed on its own while it was meant to run (a crash, ended from Task Manager), not through `stop`: a
   * stream it carried is over, whatever happens to the app it was running.
   */
  onExit?: () => void
}

export interface SunshineConfig {
  /** The name Moonlight shows for this PC. */
  name: string
  port?: number
  /** The command line Sunshine runs for the PlayOut app. */
  appCommand: string
}

export interface PendingPairing {
  id: string
  name: string
  address: string
}

export class SunshineApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string
  ) {
    super(`Sunshine ${path}: HTTP ${status}`)
    this.name = 'SunshineApiError'
  }
}

export interface Sunshine {
  status(): StreamingToolStatus
  ensureInstalled(onProgress?: (done: number, total: number) => void): Promise<InstalledTool>
  configure(config: SunshineConfig): Promise<void>
  /** Make sure Sunshine's stored login is PlayOut's (run before start; restarts a running Sunshine when it changed). */
  ensureCredentials(): Promise<void>
  /** Start it hidden (restarted if it dies) and wait until its API answers. */
  start(): Promise<void>
  stop(): Promise<void>
  running(): boolean
  /** Another Sunshine (an installed one, or a service) already holds the ports. */
  portInUse(): Promise<boolean>
  api<T = unknown>(path: string, method?: string, body?: unknown): Promise<T>
  pendingPairings(): Promise<PendingPairing[]>
  /**
   * Wait for Moonlight's pairing request from `clientAddress` and approve it with the PIN. True when Sunshine says the
   * pairing finished; false when no request came in time or the handshake failed.
   */
  approvePairing(opts: {
    clientAddress: string
    pin: string
    name: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<boolean>
  /** End the running app (and with it the stream). */
  closeApp(): Promise<void>
  unpairAll(): Promise<void>
  /** Virtual controllers need the ViGEmBus driver; without it the host gets keyboard and mouse only. */
  controllerDriverInstalled(): Promise<boolean>
  dispose(): void
}

/** `sunshine.conf`: absolute paths for everything, so the release folder can be replaced without losing state. */
export function sunshineConf(configDir: string, config: SunshineConfig): string {
  const name =
    config.name
      .replace(/[\r\n#=]/g, ' ')
      .trim()
      .slice(0, 64) || 'PlayOut'
  const lines: [string, string | number][] = [
    ['sunshine_name', name],
    ['port', config.port ?? SUNSHINE_DEFAULT_PORT],
    ['file_apps', join(configDir, 'apps.json')],
    // Sunshine keeps the login and the paired clients in the same state file by default.
    ['credentials_file', join(configDir, 'sunshine_state.json')],
    ['file_state', join(configDir, 'sunshine_state.json')],
    ['log_path', join(configDir, 'sunshine.log')],
    ['pkey', join(configDir, 'credentials', 'cakey.pem')],
    ['cert', join(configDir, 'credentials', 'cacert.pem')],
    // The web API stays reachable from this PC only: PlayOut is its one user.
    ['origin_web_ui_allowed', 'pc'],
    // PlayOut forwards Sunshine's ports itself (sunshinePorts): Sunshine's own mappings outlive a forced stop.
    ['upnp', 'disabled'],
    ['system_tray', 'disabled'],
    ['min_log_level', 'info']
  ]
  return lines.map(([k, v]) => `${k} = ${v}`).join('\r\n') + '\r\n'
}

/**
 * `apps.json`: the single PlayOut app. Not auto-detached and waiting for the whole process group, so the stream lasts
 * exactly as long as the launcher (and the game it waits for) runs.
 */
export function sunshineApps(appCommand: string): string {
  return JSON.stringify(
    {
      env: {},
      apps: [
        {
          name: SUNSHINE_APP_NAME,
          cmd: appCommand,
          'auto-detach': false,
          'wait-all': true,
          'exit-timeout': 5
        }
      ]
    },
    null,
    2
  )
}

/** Sunshine's address strings (IPv4-mapped IPv6, brackets, a port) and ours, reduced to the bare address. */
export function normalizeAddress(address: string): string {
  let a = address.trim().toLowerCase()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a)
  if (bracketed) a = bracketed[1]
  const v4port = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(a)
  if (v4port) a = v4port[1]
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7)
  return a
}

/** Whether Sunshine's state file holds this login (its hash = hex(sha256(password + salt))). */
export function credentialsMatch(state: unknown, user: string, password: string): boolean {
  const s = state as { username?: unknown; salt?: unknown; password?: unknown } | null
  if (!s || s.username !== user || typeof s.salt !== 'string' || typeof s.password !== 'string')
    return false
  const hash = createHash('sha256')
    .update(password + s.salt)
    .digest('hex')
  return hash === s.password.toLowerCase()
}

/** A TLS connection to `url`, kept only when the server shows exactly `certPem`. */
function pinnedSocket(url: URL, certPem: string, timeoutMs: number): Promise<TLSSocket> {
  const expected = new X509Certificate(certPem).raw
  return new Promise((resolve, reject) => {
    // Sunshine's certificate is self-signed, so the CA check is off and the pin below is the whole check.
    const socket = tlsConnect({
      host: url.hostname,
      port: Number(url.port),
      rejectUnauthorized: false
    })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Sunshine did not answer in time')))
    socket.once('error', reject)
    socket.once('secureConnect', () => {
      socket.setTimeout(0)
      socket.off('error', reject)
      // Keeps a late error from going unhandled before the HTTP request takes the socket over.
      socket.on('error', () => undefined)
      const raw = socket.getPeerCertificate().raw as Buffer | undefined
      if (!raw || !raw.equals(expected)) {
        socket.destroy()
        reject(
          new Error(`the program on ${url.host} is not PlayOut's Sunshine (certificate mismatch)`)
        )
        return
      }
      resolve(socket)
    })
  })
}

/**
 * HTTPS to localhost, sent only after the server proved it holds Sunshine's own certificate: the request (and its
 * Basic-auth password) is written on a connection that already passed the pin.
 */
export const pinnedSunshineRequest: SunshineRequestFn = async (req) => {
  if (!req.pinnedCertPem) throw new Error("Sunshine's certificate is not there yet")
  const url = new URL(req.url)
  const socket = await pinnedSocket(url, req.pinnedCertPem, req.timeoutMs)
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        // With createConnection and no agent, Node uses this socket as is, for this one request.
        createConnection: () => socket,
        timeout: req.timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          socket.destroy()
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        })
        res.on('error', reject)
      }
    )
    r.on('timeout', () => r.destroy(new Error('Sunshine did not answer in time')))
    r.on('error', (err) => {
      socket.destroy()
      reject(err)
    })
    r.end(req.body)
  })
}

const defaultProbePort = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (used: boolean): void => {
      socket.destroy()
      resolve(used)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * sunshine.exe processes started from under `dir`, by their image path: only a copy of PlayOut's own release matches,
 * never an installed Sunshine or its service. Get-CimInstance needs no admin for the user's own processes; the folder
 * goes in through the environment so no quoting can break the command.
 */
const ownProcessesScript =
  '$d = $env:PLAYOUT_SUNSHINE_DIR; Get-CimInstance Win32_Process -Filter "Name=\'sunshine.exe\'" | ' +
  'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) } | ' +
  'ForEach-Object { $_.ProcessId }'

function defaultOwnProcesses(spawn: SpawnFn): (dir: string) => Promise<number[]> {
  return async (dir) => {
    const result = await runForExit(
      spawn,
      systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', ownProcessesScript],
      { env: { ...process.env, PLAYOUT_SUNSHINE_DIR: dir.endsWith(sep) ? dir : dir + sep } },
      20_000
    )
    if (result.code !== 0) return []
    return result.output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }
}

/** Run a short command and resolve with its exit code (-1 when it could not start or timed out). */
function runForExit(
  spawn: SpawnFn,
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options
      })
    } catch {
      resolve({ code: -1, output })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, output })
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()))
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, output })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

export function createSunshine(deps: SunshineDeps): Sunshine {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnFn)
  const request = deps.request ?? pinnedSunshineRequest
  const probePort = deps.probePort ?? defaultProbePort
  const ownProcesses = deps.ownProcesses ?? defaultOwnProcesses(spawn)
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const log = deps.log
  const toolRoot = join(deps.root, 'app')
  const configDir = join(deps.root, 'config')
  const confPath = join(configDir, 'sunshine.conf')
  const statePath = join(configDir, 'sunshine_state.json')
  const certPath = join(configDir, 'credentials', 'cacert.pem')

  let current: StreamingToolStatus = { state: 'missing' }
  let exe: string | null = null
  let port = SUNSHINE_DEFAULT_PORT
  let password: string | null = null
  let child: ChildProcess | null = null
  let wanted = false
  let restarts: number[] = []
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  /** The start in progress: overlapping callers share it instead of launching a second, untracked sunshine.exe. */
  let starting: Promise<void> | null = null

  function setStatus(next: StreamingToolStatus): void {
    current = next
    deps.onStatus?.({ ...next })
  }

  async function findExe(): Promise<string | null> {
    if (exe) return exe
    const installed = await readInstalledTool(toolRoot)
    if (!installed) return null
    exe = await findToolFile(installed.dir, SUNSHINE_EXE)
    if (exe && current.state === 'missing')
      setStatus({ state: 'installed', version: installed.tag })
    return exe
  }

  async function requireExe(): Promise<string> {
    const found = await findExe()
    if (!found) throw new Error(tMain('mainStreaming.sunshine.notInstalled'))
    return found
  }

  async function loadPassword(): Promise<string> {
    if (password) return password
    password = (await deps.secret?.get().catch(() => null)) ?? null
    if (!password) {
      // Hex only: it goes on Sunshine's command line, where quoting rules differ between programs.
      password = randomBytes(24).toString('hex')
      await deps.secret?.set(password)
    }
    return password
  }

  function watchOutput(proc: ChildProcess): void {
    const onLine = (line: string): void => {
      const text = line.trim()
      if (!text) return
      // Sunshine logs every frame-rate tick at info; only what may matter is kept (its own log has the rest).
      if (/\b(Fatal|Error):/i.test(text)) log.warn(`Sunshine: ${text.slice(0, 500)}`)
      else if (/\bWarning:/i.test(text)) log.info(`Sunshine: ${text.slice(0, 500)}`)
    }
    if (proc.stdout) createInterface({ input: proc.stdout }).on('line', onLine)
    if (proc.stderr) createInterface({ input: proc.stderr }).on('line', onLine)
  }

  function launch(path: string): ChildProcess {
    // A second copy would lose track of the first (which then outlives PlayOut) and fail on the busy ports anyway.
    if (child && alive()) return child
    const proc = spawn(path, [confPath], {
      cwd: dirname(path),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child = proc
    watchOutput(proc)
    proc.once('error', (err) => {
      log.warn(`Sunshine could not run: ${err.message}`)
    })
    /**
     * Acted on when the process ends, not when its output closes: 'close' waits for every holder of the output
     * pipes, and the app Sunshine started may be one of them and outlive it. 'close' still does it when there was
     * no 'exit' (a spawn that failed).
     */
    let gone = false
    const onGone = (code: number | null): void => {
      if (gone) return
      gone = true
      if (child === proc) child = null
      if (!wanted || disposed) {
        if (current.state === 'running') setStatus({ state: 'installed', version: current.version })
        return
      }
      log.warn(`Sunshine exited (code ${code}); restarting`)
      try {
        deps.onExit?.()
      } catch (err) {
        log.warn(
          `Sunshine exit handler failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const t = now()
      restarts = restarts.filter((at) => t - at < RESTART_WINDOW_MS)
      restarts.push(t)
      if (restarts.length > MAX_RESTARTS) {
        wanted = false
        setStatus({
          state: 'error',
          version: current.version,
          error: tMain('mainStreaming.sunshine.keepsClosing')
        })
        return
      }
      const delay = Math.min(30_000, 1000 * 2 ** (restarts.length - 1))
      restartTimer = setTimeout(() => {
        restartTimer = null
        if (wanted && !disposed && !child) launch(path)
      }, delay)
    }
    proc.once('exit', onGone)
    proc.once('close', onGone)
    return proc
  }

  function alive(): boolean {
    return !!child && child.exitCode === null && !child.killed
  }

  async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const pass = await loadPassword()
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${SUNSHINE_USER}:${pass}`).toString('base64')}`,
      Accept: 'application/json'
    }
    let payload: string | undefined
    if (body !== undefined || method !== 'GET') {
      // Sunshine refuses POSTs that are not JSON, even empty ones.
      payload = JSON.stringify(body ?? {})
      headers['Content-Type'] = 'application/json'
    }
    // Read on every call: Sunshine makes the certificate on its first start, and again if the file goes missing.
    const pinnedCertPem = await fs.readFile(certPath, 'utf8').catch(() => undefined)
    const res = await request({
      method,
      url: `https://127.0.0.1:${port + 1}${path}`,
      headers,
      body: payload,
      timeoutMs: path === '/api/pin' && method === 'POST' ? PIN_POST_TIMEOUT_MS : API_TIMEOUT_MS,
      pinnedCertPem
    })
    if (res.status < 200 || res.status >= 300)
      throw new SunshineApiError(res.status, path, res.body)
    if (!res.body.trim()) return {} as T
    try {
      return JSON.parse(res.body) as T
    } catch {
      throw new Error(`Sunshine ${path}: unreadable answer`)
    }
  }

  async function waitReady(proc: ChildProcess): Promise<void> {
    const deadline = now() + READY_TIMEOUT_MS
    let last = ''
    while (now() < deadline) {
      if (proc.exitCode !== null || child !== proc)
        throw new Error(
          last
            ? tMain('mainStreaming.sunshine.closedWhileStartingWhy', { error: last })
            : tMain('mainStreaming.sunshine.closedWhileStarting')
        )
      try {
        await api('/api/apps')
        return
      } catch (err) {
        last = err instanceof Error ? err.message : String(err)
        // A wrong login is not going to fix itself by waiting.
        if (err instanceof SunshineApiError && err.status === 401) throw err
      }
      await sleep(500)
    }
    throw new Error(
      last
        ? tMain('mainStreaming.sunshine.notStartedWhy', { error: last })
        : tMain('mainStreaming.sunshine.notStarted')
    )
  }

  async function stop(): Promise<void> {
    wanted = false
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    const proc = child
    if (!proc || proc.exitCode !== null) {
      child = null
      return
    }
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // taskkill could not end it (or never ran): the direct kill is the last resort.
        proc.kill()
        resolve()
      }, STOP_TIMEOUT_MS)
      proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    // The whole tree: the app Sunshine runs (PlayOut's stream launcher) goes too.
    if (proc.pid) {
      const killer = spawn(systemTool('taskkill.exe'), ['/T', '/F', '/PID', String(proc.pid)], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => proc.kill())
    } else proc.kill()
    await closed
    if (child === proc) child = null
  }

  /**
   * End sunshine.exe copies left running from PlayOut's own release folder. Windows does not end child processes with
   * their parent, so a crash (or PlayOut ended from Task Manager) leaves Sunshine holding its ports, and every later
   * start would take it for someone else's Sunshine. True when the ports are free afterwards.
   */
  async function clearOrphans(): Promise<boolean> {
    const pids = (await ownProcesses(toolRoot).catch(() => [] as number[])).filter(
      (pid) => pid !== child?.pid
    )
    if (!pids.length) return false
    log.warn(`Sunshine: ending ${pids.length} copy(ies) left running by an earlier PlayOut`)
    for (const pid of pids)
      await runForExit(
        spawn,
        systemTool('taskkill.exe'),
        ['/T', '/F', '/PID', String(pid)],
        {},
        10_000
      )
    // The ports are released a moment after the process is gone.
    for (let i = 0; i < ORPHAN_PORT_CHECKS; i++) {
      if (!(await self.portInUse())) return true
      await sleep(500)
    }
    return false
  }

  async function startNow(): Promise<void> {
    const path = await requireExe()
    if ((await self.portInUse()) && !(await clearOrphans())) {
      wanted = false
      throw new Error(tMain('mainStreaming.sunshine.otherCopy', { port, port2: port + 1 }))
    }
    restarts = []
    const proc = launch(path)
    try {
      await waitReady(proc)
    } catch (err) {
      await stop()
      setStatus({
        state: 'error',
        version: current.version,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }
    setStatus({ state: 'running', version: current.version })
    log.info('Sunshine: running')
  }

  const self: Sunshine = {
    status: () => ({ ...current }),

    async ensureInstalled(onProgress): Promise<InstalledTool> {
      const before = current
      try {
        const installed = await ensureGithubTool({
          ...(deps.tool ?? SUNSHINE_TOOL),
          root: toolRoot,
          fetch: deps.fetch,
          log,
          requiredFile: SUNSHINE_EXE,
          onProgress: (done, total) => {
            setStatus({
              state: 'downloading',
              percent: total ? Math.min(100, Math.round((done / total) * 100)) : undefined
            })
            onProgress?.(done, total)
          }
        })
        exe = await findToolFile(installed.dir, SUNSHINE_EXE)
        if (!exe) throw new Error(`the Sunshine release has no ${SUNSHINE_EXE}`)
        setStatus({ state: alive() ? 'running' : 'installed', version: installed.tag })
        return installed
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus({ state: 'error', version: before.version, error: message })
        throw err
      }
    },

    async configure(config: SunshineConfig): Promise<void> {
      port = config.port ?? SUNSHINE_DEFAULT_PORT
      await fs.mkdir(join(configDir, 'credentials'), { recursive: true })
      await fs.writeFile(confPath, sunshineConf(configDir, config))
      await fs.writeFile(join(configDir, 'apps.json'), sunshineApps(config.appCommand))
    },

    async ensureCredentials(): Promise<void> {
      const pass = await loadPassword()
      if (credentialsMatch(await readJson(statePath), SUNSHINE_USER, pass)) return
      const path = await requireExe()
      await fs.access(confPath).catch(() => {
        throw new Error(tMain('mainStreaming.sunshine.notConfigured'))
      })
      // The conf path comes first: Sunshine applies it before running the --creds command.
      const result = await runForExit(
        spawn,
        path,
        [confPath, '--creds', SUNSHINE_USER, pass],
        { cwd: dirname(path) },
        CREDS_TIMEOUT_MS
      )
      if (result.code !== 0)
        throw new Error(tMain('mainStreaming.sunshine.loginNotSaved', { code: result.code }))
      log.info('Sunshine: login set')
      // A running Sunshine read the old login at startup.
      if (alive()) {
        await stop()
        await self.start()
      }
    },

    start(): Promise<void> {
      if (disposed) return Promise.reject(new Error('Sunshine was shut down'))
      if (starting) return starting
      wanted = true
      if (alive()) return Promise.resolve()
      starting = startNow().finally(() => {
        starting = null
      })
      return starting
    },

    stop,

    running: alive,

    async portInUse(): Promise<boolean> {
      const [base, web] = await Promise.all([probePort(port), probePort(port + 1)])
      return base || web
    },

    api,

    async pendingPairings(): Promise<PendingPairing[]> {
      const res = await api<{ pairings?: Partial<PendingPairing>[] }>('/api/pin')
      return (res.pairings ?? [])
        .filter((p) => typeof p.id === 'string')
        .map((p) => ({ id: p.id!, name: String(p.name ?? ''), address: String(p.address ?? '') }))
    },

    async approvePairing({
      clientAddress,
      pin,
      name,
      timeoutMs = 90_000,
      signal
    }): Promise<boolean> {
      if (!isMoonlightPin(pin)) throw new Error('the pairing PIN must be 4 digits')
      const want = normalizeAddress(clientAddress)
      const label = Buffer.from(name.trim() || 'PlayOut', 'utf8')
        .subarray(0, 128)
        .toString('utf8')
      const deadline = now() + timeoutMs
      while (now() < deadline && !signal?.aborted) {
        let match: PendingPairing | undefined
        try {
          match = (await self.pendingPairings())
            .filter((p) => normalizeAddress(p.address) === want)
            .pop()
        } catch (err) {
          log.warn(`Sunshine: pending pairings: ${err instanceof Error ? err.message : err}`)
        }
        if (match) {
          const res = await api<{ status?: unknown }>('/api/pin', 'POST', {
            pairing_id: match.id,
            pin,
            name: label.replace(/�+$/, '') || 'PlayOut'
          })
          const ok = res.status === true || res.status === 'true'
          log.info(`Sunshine: pairing with ${want} ${ok ? 'finished' : 'failed'}`)
          return ok
        }
        await sleep(1000)
      }
      return false
    },

    async closeApp(): Promise<void> {
      await api('/api/apps/close', 'POST', {})
    },

    async unpairAll(): Promise<void> {
      await api('/api/clients/unpair-all', 'POST', {})
    },

    async controllerDriverInstalled(): Promise<boolean> {
      // `sc query` exits 0 for an existing service (running or not) and 1060 when there is none; no admin needed.
      const result = await runForExit(
        spawn,
        systemTool('sc.exe'),
        ['query', 'ViGEmBus'],
        {},
        10_000
      )
      return result.code === 0
    },

    dispose(): void {
      if (disposed) return
      void stop().catch(() => undefined)
      disposed = true
    }
  }
  return self
}
