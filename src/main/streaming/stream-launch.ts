// Host launch hand-off between Sunshine and PlayOut (docs: streaming DESIGN.md module 4).
//
// Sunshine's single app runs `"<PlayOut exe>" --stream-launch`. That process (the client below) never opens a
// window or takes the single-instance lock: it connects to a per-user named pipe served by the running PlayOut,
// asks it to run the game armed by `POST /v1/stream/prepare`, and blocks until PlayOut reports the game ended.
// Sunshine sees one long-lived process per stream, so it keeps streaming while the game runs and ends the stream
// when the game exits; when the viewer quits, Sunshine kills the client, the pipe closes, and PlayOut closes the game.
import { spawn } from 'child_process'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { connect, createServer, type Server, type Socket } from 'net'
import { userInfo } from 'os'
import { dirname, join } from 'path'
import type { EventBus } from '../events'
import type { Logger } from '../logger'

export const STREAM_LAUNCH_FLAG = '--stream-launch'

/** One request line is tiny; anything longer is not a PlayOut client. */
const MAX_LINE_BYTES = 4096
const REQUEST_TIMEOUT_MS = 10_000
export const CLIENT_CONNECT_TIMEOUT_MS = 30_000
const CLIENT_RETRY_MS = 500

export interface StreamLaunchRequest {
  op: 'run'
  token: string
}

export type StreamLaunchEvent =
  { event: 'started'; gameId: string } | { event: 'ended' } | { event: 'error'; message: string }

/** True when PlayOut was started as Sunshine's app command (the blocking client, not the app). */
export function hasStreamLaunchFlag(argv: readonly string[]): boolean {
  return argv.some((a) => a === STREAM_LAUNCH_FLAG || a.startsWith(`${STREAM_LAUNCH_FLAG}=`))
}

/**
 * `\\.\pipe\playout-stream-<hash>`: one pipe per Windows account, so two users signed in on one PC (fast user
 * switching) each reach their own PlayOut. Sunshine runs the app command as the console user, which is the
 * same account as the PlayOut that serves the pipe. The hash keeps the user name out of the pipe namespace.
 */
export function streamLaunchPipeName(user: string = currentUserKey()): string {
  const hash = createHash('sha256').update(user.toLowerCase()).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\playout-stream-${hash}`
}

function currentUserKey(): string {
  let name = process.env['USERNAME'] ?? ''
  try {
    name = userInfo().username
  } catch {
    /* no passwd entry; the environment is good enough */
  }
  return `${process.env['USERDOMAIN'] ?? ''}\\${name}`
}

/**
 * The shared secret of the pipe, created once in `file` (userData). The pipe's default ACL already limits it to
 * this account, but any program of the user could otherwise ask PlayOut to start games; the client reads the
 * token from the same file, so only something that can read PlayOut's data folder can use it.
 */
export async function ensureStreamLaunchToken(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch {
    /* missing: create it below */
  }
  const token = randomBytes(32).toString('hex')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, token, { encoding: 'utf8', mode: 0o600 })
  return token
}

function tokenEquals(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

// ---------------------------------------------------------------------------
// Server (PlayOut main)
// ---------------------------------------------------------------------------

export interface StreamLaunchServerDeps {
  pipeName: string
  token: string
  /** Start the armed game. Resolve with an error message when nothing is armed or the launch failed. */
  onRun: () => Promise<{ gameId: string } | { error: string }>
  /**
   * Resolve when the started game's session ended. `signal` aborts when the client went away first; the
   * promise may then stay pending (the server no longer waits for it). See `sessionEndWaiter`.
   */
  waitEnded: (gameId: string, signal: AbortSignal) => Promise<void>
  /** The client closed the pipe while the game ran: the viewer left the stream, so the game should close. */
  onClientGone: (gameId: string) => void | Promise<void>
  log: Logger
  requestTimeoutMs?: number
}

export interface StreamLaunchServer {
  listen(): Promise<void>
  /** Stop listening and drop connected clients without closing their games (PlayOut is quitting). */
  close(): Promise<void>
  /** The game a connected client is running, or null. */
  active(): string | null
  /**
   * Drop the connected client as if it had closed the pipe itself: its game is closed (`onClientGone`) and the slot
   * freed. For a stream that ended without the client going away (Sunshine died and left its app running).
   */
  dropClient(): void
}

export function createStreamLaunchServer(deps: StreamLaunchServerDeps): StreamLaunchServer {
  const { log } = deps
  const sockets = new Set<Socket>()
  let server: Server | null = null
  let closing = false
  /** One stream at a time: Sunshine has one app and one viewer. */
  let busy: { socket: Socket; gameId: string | null } | null = null

  function send(socket: Socket, message: StreamLaunchEvent): void {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
  }

  function fail(socket: Socket, message: string): void {
    send(socket, { event: 'error', message })
    socket.end()
  }

  async function run(socket: Socket): Promise<void> {
    if (busy) {
      log.warn('stream launch refused: another stream is running a game')
      fail(socket, 'busy')
      return
    }
    const slot: { socket: Socket; gameId: string | null } = { socket, gameId: null }
    busy = slot
    // The slot is held until `serve` is completely done, including closing the game of a client that left.
    // Releasing it on the socket's 'close' would let a quick reconnect run a second launch beside a pending
    // one, or be told 'started' for a game that the first client's stop is about to kill.
    try {
      await serve(socket, slot)
    } finally {
      if (busy === slot) busy = null
    }
  }

  async function serve(
    socket: Socket,
    slot: { socket: Socket; gameId: string | null }
  ): Promise<void> {
    const ac = new AbortController()
    socket.once('close', () => ac.abort())
    const left = (): boolean => ac.signal.aborted || socket.destroyed

    /** The viewer left while the game started or ran: close it, unless PlayOut itself is quitting. */
    const closeGame = async (gameId: string): Promise<void> => {
      if (closing) return
      log.info(`stream launch client left while ${gameId} runs; closing the game`)
      try {
        await deps.onClientGone(gameId)
      } catch (err) {
        log.warn(`closing ${gameId} failed: ${(err as Error).message}`)
      }
    }

    let result: { gameId: string } | { error: string }
    try {
      result = await deps.onRun()
    } catch (err) {
      result = { error: (err as Error).message || String(err) }
    }
    if ('error' in result) {
      log.warn(`stream launch failed: ${result.error}`)
      fail(socket, result.error)
      return
    }
    const { gameId } = result
    slot.gameId = gameId
    if (left()) {
      // Gone during the launch (the viewer gave up while the game started): close it like any other leave.
      await closeGame(gameId)
      return
    }
    log.info(`stream launch started ${gameId}`)
    send(socket, { event: 'started', gameId })
    try {
      await new Promise<void>((resolve, reject) => {
        ac.signal.addEventListener('abort', () => resolve(), { once: true })
        deps.waitEnded(gameId, ac.signal).then(resolve, reject)
      })
    } catch (err) {
      if (left()) return closeGame(gameId)
      fail(socket, (err as Error).message || String(err))
      return
    }
    if (left()) return closeGame(gameId)
    log.info(`stream launch: ${gameId} ended`)
    send(socket, { event: 'ended' })
    socket.end()
  }

  function onConnection(socket: Socket): void {
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('error', (err) => log.debug(`stream launch pipe error: ${err.message}`))
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    let handled = false
    const timer = setTimeout(() => {
      if (!handled) socket.destroy()
    }, deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
    socket.on('data', (chunk: string) => {
      if (handled) return
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl < 0) {
        if (buffer.length > MAX_LINE_BYTES) {
          handled = true
          clearTimeout(timer)
          socket.destroy()
        }
        return
      }
      handled = true
      clearTimeout(timer)
      let request: Partial<StreamLaunchRequest> | null = null
      try {
        request = JSON.parse(buffer.slice(0, nl)) as Partial<StreamLaunchRequest>
      } catch {
        /* answered below */
      }
      if (!request || typeof request !== 'object' || request.op !== 'run') {
        fail(socket, 'unknown request')
        return
      }
      if (typeof request.token !== 'string' || !tokenEquals(request.token, deps.token)) {
        log.warn('stream launch refused: wrong token')
        fail(socket, 'unauthorized')
        return
      }
      void run(socket).catch((err: Error) => {
        log.error(`stream launch failed: ${err.message}`)
        fail(socket, err.message)
      })
    })
  }

  return {
    listen() {
      closing = false
      return new Promise((resolve, reject) => {
        const s = createServer(onConnection)
        s.once('error', reject)
        s.listen(deps.pipeName, () => {
          s.removeListener('error', reject)
          s.on('error', (err) => log.warn(`stream launch pipe server error: ${err.message}`))
          server = s
          log.info(`stream launch pipe listening on ${deps.pipeName}`)
          resolve()
        })
      })
    },
    close() {
      closing = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      busy = null
      const s = server
      server = null
      if (!s) return Promise.resolve()
      return new Promise((resolve) => s.close(() => resolve()))
    },
    active() {
      return busy?.gameId ?? null
    },
    dropClient() {
      // The socket's 'close' aborts the wait in `serve`, which then closes the game and frees the slot.
      busy?.socket.destroy()
    }
  }
}

/** What `sessionEndWaiter` needs from the launcher and the event bus. */
export interface SessionEndSources {
  events: Pick<EventBus, 'on'>
  /** `LauncherService.running`. */
  running(): { gameId: string } | null
}

/**
 * `waitEnded` for the server from the session events: resolves when the game's session ends, or when another
 * game's session replaces it (someone at the host started something else). A game PlayOut cannot track
 * (tracking 'none', the session already over) never resolves: the stream then lasts until the viewer quits,
 * which is Sunshine's behaviour for a detached app.
 */
export function sessionEndWaiter(
  sources: SessionEndSources
): (gameId: string, signal: AbortSignal) => Promise<void> {
  return (gameId, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const offs: (() => void)[] = []
      const done = (): void => {
        for (const off of offs) off()
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
      if (sources.running()?.gameId !== gameId) return
      offs.push(sources.events.on('session:ended', (p) => p.gameId === gameId && done()))
      offs.push(sources.events.on('session:started', (p) => p.gameId !== gameId && done()))
    })
}

// ---------------------------------------------------------------------------
// Client (`PlayOut.exe --stream-launch`, run by Sunshine)
// ---------------------------------------------------------------------------

export interface StreamLaunchClientOptions {
  pipeName: string
  tokenFile: string
  /** How long to keep trying to reach PlayOut (it may be starting). Default 30 s. */
  connectTimeoutMs?: number
  retryMs?: number
  /** Start PlayOut when the pipe is not there; default: the PlayOut exe (portable-aware), detached. */
  startApp?: () => void
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * The blocking client. Resolves with the process exit code: 0 when the game ended normally, 1 on an error
 * (PlayOut unreachable, nothing armed, launch failed, PlayOut went away), 2 without the flag. Never throws.
 */
export async function runStreamLaunchClient(
  argv: readonly string[],
  options: StreamLaunchClientOptions
): Promise<number> {
  if (!hasStreamLaunchFlag(argv)) return 2
  const log = options.log ?? ((): void => {})
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (options.connectTimeoutMs ?? CLIENT_CONNECT_TIMEOUT_MS)
  let appStarted = false
  for (;;) {
    try {
      // Read on every try: a first run of PlayOut creates the file only once streaming starts.
      const token = (await readFile(options.tokenFile, 'utf8')).trim()
      const socket = await openPipe(options.pipeName)
      return await converse(socket, token, log)
    } catch (err) {
      if (!appStarted) {
        appStarted = true
        log(`PlayOut is not reachable (${(err as Error).message}); starting it`)
        try {
          ;(options.startApp ?? startPlayOut)()
        } catch (startErr) {
          log(`could not start PlayOut: ${(startErr as Error).message}`)
        }
      }
      if (Date.now() >= deadline) {
        log('PlayOut did not answer in time')
        return 1
      }
      await sleep(options.retryMs ?? CLIENT_RETRY_MS)
    }
  }
}

function openPipe(pipeName: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function converse(socket: Socket, token: string, log: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    let code: number | null = null
    let buffer = ''
    const finish = (value: number): void => {
      if (code !== null) return
      code = value
      socket.end()
      resolve(value)
    }
    socket.setEncoding('utf8')
    socket.on('error', (err) => log(`pipe error: ${err.message}`))
    socket.on('close', () => {
      if (code === null) log('PlayOut closed the connection before the game ended')
      finish(1)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let message: Partial<StreamLaunchEvent> & Record<string, unknown>
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (message.event === 'started') log(`started ${String(message.gameId)}`)
        else if (message.event === 'ended') finish(0)
        else if (message.event === 'error') {
          log(`PlayOut refused: ${String(message.message)}`)
          finish(1)
        }
      }
    })
    const request: StreamLaunchRequest = { op: 'run', token }
    socket.write(`${JSON.stringify(request)}\n`)
  })
}

/**
 * Start the installed or portable PlayOut exe (a portable build runs from a temp copy of itself) through
 * Explorer. This client runs inside the job object Sunshine gives its app and terminates when the stream ends;
 * a `detached` child stays in that job (libuv does not ask for breakaway), so PlayOut started directly would
 * die with the stream. Explorer is outside the job, and the PlayOut it starts is an ordinary app of the user.
 */
export function startPlayOut(spawnFn: typeof spawn = spawn): void {
  const exe = process.env['PORTABLE_EXECUTABLE_FILE'] || process.execPath
  // By full path: a bare name is looked up in the current folder (here the PlayOut exe's) before PATH.
  const windows = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  const explorer = join(windows, 'explorer.exe')
  const child = spawnFn(explorer, [exe], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}
