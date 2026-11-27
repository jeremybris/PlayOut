import { spawn as nodeSpawn } from 'child_process'
import type { PadInfo } from '../../shared/overlay'
import type { Logger } from '../logger'
import { padReaderScript } from './pad-script'
import { tMain } from '../i18n'

/**
 * The controller reader (docs/home-overlay.md, "Native host"): one long-lived powershell.exe running the C# poller of
 * pad-script.ts. It writes one JSON line per change on stdout; its stdin stays open, and closing it ends the process.
 */

export type ReaderState = 'starting' | 'running' | 'unavailable'

export interface ReaderStatus {
  state: ReaderState
  message?: string
}

/** The part of a child process the reader uses (tests pass a fake). */
export interface PadProcess {
  stdin: {
    write(chunk: string): unknown
    end(): unknown
    on(event: 'error', listener: (err: Error) => void): unknown
  }
  stdout: {
    setEncoding(encoding: BufferEncoding): unknown
    on(event: 'data', listener: (chunk: string) => void): unknown
  }
  stderr: {
    setEncoding(encoding: BufferEncoding): unknown
    on(event: 'data', listener: (chunk: string) => void): unknown
  }
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  kill(): unknown
}

export type PadSpawn = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }
) => PadProcess

export interface PadReaderDeps {
  log: Logger
  /** Where SDL2.dll is (sdl.ts), asked again at every start so a newly installed copy is picked up. */
  sdlDir: () => string | null
  /** Close Xbox Game Bar whenever it starts (Settings › Controls › Turn off Xbox Game Bar); read at every start. */
  closeGameBar?: () => boolean
  spawn?: PadSpawn
}

export interface PadReader {
  /** Start reading (no-op while running). After 'unavailable', starts over with a fresh crash count. */
  start(): void
  /** Stop: closes the reader's stdin (it exits on its own), killing it if it lingers. Pads are cleared. */
  stop(): void
  pads(): PadInfo[]
  /** Called with every change of the pads (connection or buttons). Returns an unsubscribe function. */
  onPads(listener: (pads: PadInfo[]) => void): () => void
  status(): ReaderStatus
  onStatus(listener: (status: ReaderStatus) => void): () => void
}

/** One parsed stdout line. */
export type PadLine =
  { kind: 'ready'; sdl: boolean; sdlError: string } | { kind: 'pads'; pads: PadInfo[] }

const BUTTON_MASK = 0x1ffff

/** `count` finite numbers clamped to min..max, or undefined when the value is not such an array. */
function numbers(value: unknown, count: number, min: number, max: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== count) return undefined
  if (!value.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined
  // `+ 0` turns a -0 into 0, so a stick at rest compares equal however it was written.
  return (value as number[]).map((v) => Math.min(max, Math.max(min, v)) + 0)
}

/** A stdout line of the reader, or null for anything else (blank lines, PowerShell noise). */
export function parsePadLine(line: string): PadLine | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (obj.ready === true) {
    return {
      kind: 'ready',
      sdl: obj.sdl === true,
      sdlError: typeof obj.sdlError === 'string' ? obj.sdlError : ''
    }
  }
  if (Array.isArray(obj.pads)) {
    const pads: PadInfo[] = []
    for (const p of obj.pads as unknown[]) {
      if (!p || typeof p !== 'object') continue
      const { id, name, buttons, axes, triggers } = p as Record<string, unknown>
      if (typeof id !== 'string' || !id) continue
      const pad: PadInfo = {
        id,
        name: typeof name === 'string' && name ? name : 'Controller',
        buttons:
          typeof buttons === 'number' && Number.isInteger(buttons) ? buttons & BUTTON_MASK : 0
      }
      // Sticks and triggers (the in-game overlay's navigation); absent or malformed ones are left out.
      const a = numbers(axes, 4, -1, 1)
      if (a) pad.axes = a as [number, number, number, number]
      const t = numbers(triggers, 2, 0, 1)
      if (t) pad.triggers = t as [number, number]
      pads.push(pad)
    }
    return { kind: 'pads', pads }
  }
  return null
}

/**
 * The one-sentence reason from what PowerShell wrote to stderr: its first non-empty line (an error's later lines are
 * "At line:1 char:1" and the script excerpt), capped so it fits the Controls page.
 */
export function stderrMessage(stderr: string): string | undefined {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return undefined
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

/** Wait before restart number `n` (1-based): 1 s, 2 s, 4 s … capped at 30 s. */
export function restartDelay(n: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, n - 1))
}

/** The reader is given up on after this many exits within CRASH_WINDOW_MS. */
export const CRASH_LIMIT = 5
const CRASH_WINDOW_MS = 60_000
/** Compiling the C# takes ~1-2 s; a reader that has said nothing after this long is stuck. */
const READY_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 2_000

const defaultSpawn: PadSpawn = (command, args, options) => nodeSpawn(command, args, options)

export function createPadReader(deps: PadReaderDeps): PadReader {
  const { log } = deps
  const spawn = deps.spawn ?? defaultSpawn
  const padListeners = new Set<(pads: PadInfo[]) => void>()
  const statusListeners = new Set<(status: ReaderStatus) => void>()
  const crashes: number[] = []
  let current: { proc: PadProcess; buffer: string; stderr: string; ended: boolean } | null = null
  let wanted = false
  let restartTimer: NodeJS.Timeout | null = null
  let readyTimer: NodeJS.Timeout | null = null
  let padList: PadInfo[] = []
  let padKey = '[]'
  let state: ReaderStatus = { state: 'unavailable', message: tMain('mainApp.padReader.off') }

  function setStatus(next: ReaderStatus): void {
    if (next.state === state.state && next.message === state.message) return
    state = next
    for (const l of statusListeners) l(state)
  }

  function setPads(next: PadInfo[]): void {
    const key = JSON.stringify(next)
    if (key === padKey) return
    padKey = key
    padList = next
    for (const l of padListeners) l(padList)
  }

  function clearTimers(): void {
    if (restartTimer) clearTimeout(restartTimer)
    if (readyTimer) clearTimeout(readyTimer)
    restartTimer = readyTimer = null
  }

  function onLine(line: string): void {
    const parsed = parsePadLine(line)
    if (!parsed) {
      if (line.trim()) log.debug(`pad reader output: ${line.slice(0, 300)}`)
      return
    }
    if (parsed.kind === 'ready') {
      if (readyTimer) clearTimeout(readyTimer)
      readyTimer = null
      if (parsed.sdlError)
        log.warn(`pad reader: SDL2 not loaded (${parsed.sdlError}); XInput pads only`)
      else log.info(`pad reader running (${parsed.sdl ? 'XInput + SDL2' : 'XInput only'})`)
      setStatus({ state: 'running' })
    } else {
      setPads(parsed.pads)
    }
  }

  function launch(): void {
    restartTimer = null
    if (!wanted) return
    setStatus({ state: 'starting' })
    const script = padReaderScript(deps.sdlDir(), 16, deps.closeGameBar?.() ?? false)
    let proc: PadProcess
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
    } catch (err) {
      onEnded(null, (err as Error).message)
      return
    }
    const session = { proc, buffer: '', stderr: '', ended: false }
    current = session
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      if (session.ended) return
      session.buffer += chunk
      let nl: number
      while ((nl = session.buffer.indexOf('\n')) !== -1) {
        const line = session.buffer.slice(0, nl).replace(/\r$/, '')
        session.buffer = session.buffer.slice(nl + 1)
        onLine(line)
      }
    })
    proc.stderr.on('data', (chunk) => {
      // Only the start matters (the first error line); the cap keeps a chatty failure from growing it forever.
      if (session.stderr.length < 8192) session.stderr += chunk
    })
    proc.stdin.on('error', (err) => log.debug(`pad reader stdin error: ${err.message}`))
    proc.on('error', (err) => end(session, err.message))
    proc.on('exit', (code, signal) => end(session, `exited (${code ?? signal})`))
    // CRLF: what powershell.exe expects on a redirected stdin. The stream stays open; closing it stops the reader.
    proc.stdin.write(script.split('\n').join('\r\n') + '\r\n')
    readyTimer = setTimeout(() => {
      readyTimer = null
      log.warn('pad reader did not start within 30 s; restarting it')
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      end(session, 'did not start in time')
    }, READY_TIMEOUT_MS)
    readyTimer.unref?.()
  }

  function end(session: NonNullable<typeof current>, reason: string): void {
    if (session.ended) return
    session.ended = true
    if (current === session) current = null
    onEnded(session, reason)
  }

  function onEnded(session: { stderr: string } | null, reason: string): void {
    if (readyTimer) clearTimeout(readyTimer)
    readyTimer = null
    setPads([])
    if (!wanted) return
    const message = (session && stderrMessage(session.stderr)) || reason
    log.warn(`pad reader ${reason}${session?.stderr ? `: ${message}` : ''}`)
    const now = Date.now()
    crashes.push(now)
    while (crashes.length && crashes[0] < now - CRASH_WINDOW_MS) crashes.shift()
    if (crashes.length >= CRASH_LIMIT) {
      log.error(`pad reader gave up after ${CRASH_LIMIT} exits within a minute: ${message}`)
      setStatus({ state: 'unavailable', message })
      return
    }
    setStatus({ state: 'starting', message })
    restartTimer = setTimeout(launch, restartDelay(crashes.length))
    restartTimer.unref?.()
  }

  return {
    start() {
      if (wanted && (current || restartTimer)) return
      wanted = true
      crashes.length = 0
      launch()
    },
    stop() {
      wanted = false
      clearTimers()
      const session = current
      current = null
      if (session && !session.ended) {
        session.ended = true
        try {
          session.proc.stdin.end()
        } catch (err) {
          log.debug(`pad reader stdin close failed: ${(err as Error).message}`)
        }
        const grace = setTimeout(() => {
          try {
            session.proc.kill()
          } catch {
            /* already gone */
          }
        }, STOP_GRACE_MS)
        grace.unref?.()
      }
      setPads([])
      setStatus({ state: 'unavailable', message: tMain('mainApp.padReader.off') })
    },
    pads: () => padList,
    onPads(listener) {
      padListeners.add(listener)
      return () => padListeners.delete(listener)
    },
    status: () => state,
    onStatus(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    }
  }
}
