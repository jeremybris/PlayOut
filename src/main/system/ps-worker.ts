import { spawn, type ChildProcess } from 'child_process'
import type { Logger } from '../logger'
import { runPowerShell } from './powershell'

export interface PsRunOptions {
  /** Reject (and restart the worker) when the script has not answered within this time. Default 10 s. */
  timeoutMs?: number
}

/** Runs PowerShell scripts and returns their output converted to JSON. */
export interface PsRunner {
  /**
   * Run a script and return its output as parsed JSON (`null` when the script output nothing).
   * Scripts must `Select-Object` the properties they need: whole CIM instances serialise slowly and deeply.
   * Rejects with a `PsError` when the script throws, times out or PowerShell is unavailable.
   */
  run<T = unknown>(script: string, options?: PsRunOptions): Promise<T | null>
}

export interface PsWorker extends PsRunner {
  /** True while a powershell.exe process is attached and healthy. */
  isRunning(): boolean
  /** Ends the process; every later `run` rejects with code 'disposed'. */
  dispose(): void
}

export type PsErrorCode = 'script' | 'timeout' | 'exited' | 'unavailable' | 'protocol' | 'disposed'

export class PsError extends Error {
  readonly code: PsErrorCode

  constructor(code: PsErrorCode, message: string) {
    super(message)
    this.name = 'PsError'
    this.code = code
  }
}

export interface PsWorkerOptions {
  log: Logger
  /** Script run once each time a powershell.exe process starts (Add-Type definitions, assembly loads). */
  init?: string
  /** Executable to spawn; tests use a bogus name to exercise the one-shot fallback. */
  exe?: string
}

interface Job {
  id: number
  script: string
  timeoutMs: number
  internal: boolean
  settled: boolean
  session: Session | null
  resolve: (value: unknown) => void
  reject: (error: PsError) => void
}

interface Reply {
  id?: number
  ok?: boolean
  result?: unknown
  error?: string
}

interface Session {
  proc: ChildProcess
  buffer: string
  ended: boolean
}

const MARK = '>>PLAYOUT-PS>>'
const DEFAULT_TIMEOUT_MS = 10_000
const INIT_TIMEOUT_MS = 30_000
const CRASH_WINDOW_MS = 60_000
const CRASH_LIMIT = 3
const COOLDOWN_MS = 60_000
const EXIT_GRACE_MS = 2_000

// `& $__sb` runs scripts in a child scope, so preferences must be global to reach them.
const PREAMBLE = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$global:ProgressPreference = 'SilentlyContinue'",
  "$global:ErrorActionPreference = 'Stop'"
].join('; ')

/**
 * One command line: the script travels base64-encoded (no quoting or line-break issues on stdin) and answers
 * with exactly one line `MARK{"id":n,"ok":bool,"result":...|"error":"..."}` so replies can be matched to jobs.
 */
function envelope(id: number, script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return (
    `$__sb = [scriptblock]::Create([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))); ` +
    `try { $__r = & $__sb; $__o = @{ id = ${id}; ok = $true; result = $__r } } ` +
    `catch { $__o = @{ id = ${id}; ok = $false; error = $_.Exception.Message } }; ` +
    `[Console]::Out.WriteLine('${MARK}' + (ConvertTo-Json -InputObject $__o -Depth 8 -Compress)); [Console]::Out.Flush()`
  )
}

function parseReply(text: string): Reply | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' ? (value as Reply) : null
  } catch {
    return null
  }
}

/**
 * One long-lived `powershell.exe -Command -` process: scripts are written to its stdin one at a time and answered
 * with delimited JSON lines. A fresh process costs ~1 s per call on this machine; the warm worker answers most
 * probes in 10-100 ms. The process is restarted when it exits or a command times out; after three restarts within
 * a minute, commands run in one-shot processes (`runPowerShell`) for a minute before the worker is tried again.
 */
export function createPsWorker(options: PsWorkerOptions): PsWorker {
  const { log } = options
  const exe = options.exe ?? 'powershell.exe'
  const init = options.init ?? ''
  const queue: Job[] = []
  const crashes: number[] = []
  let session: Session | null = null
  let inFlight: Job | null = null
  let timer: NodeJS.Timeout | null = null
  let seq = 0
  let disposed = false
  let cooldownUntil = 0

  function settle(job: Job, value: unknown, error?: PsError): void {
    if (job.settled) return
    job.settled = true
    if (error) job.reject(error)
    else job.resolve(value)
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function recordCrash(): void {
    const now = Date.now()
    crashes.push(now)
    while (crashes.length && crashes[0] < now - CRASH_WINDOW_MS) crashes.shift()
    if (crashes.length >= CRASH_LIMIT) {
      crashes.length = 0
      cooldownUntil = now + COOLDOWN_MS
      log.warn(
        `powershell worker restarted ${CRASH_LIMIT} times within a minute; using one-shot processes for ${COOLDOWN_MS / 1000} s`
      )
    }
  }

  function endSession(s: Session, reason: string): void {
    if (s.ended) return
    s.ended = true
    if (session === s) session = null
    if (inFlight && inFlight.session === s) {
      clearTimer()
      settle(
        inFlight,
        undefined,
        new PsError('exited', `PowerShell worker ${reason} before answering`)
      )
      inFlight = null
    }
    if (!disposed) {
      log.debug(`powershell worker session ended (${reason})`)
      recordCrash()
      pump()
    }
  }

  function killSession(s: Session, reason: string): void {
    try {
      s.proc.kill()
    } catch (err) {
      log.debug(`powershell worker kill failed: ${(err as Error).message}`)
    }
    endSession(s, reason)
  }

  function protocolFailure(s: Session, message: string): void {
    log.warn(`powershell worker protocol error: ${message}; restarting the worker`)
    if (inFlight && inFlight.session === s) {
      clearTimer()
      settle(inFlight, undefined, new PsError('protocol', message))
      inFlight = null
    }
    killSession(s, 'was restarted after a protocol error')
  }

  function handleReply(s: Session, text: string): void {
    const reply = parseReply(text)
    if (!reply) {
      protocolFailure(s, `unparseable reply: ${text.slice(0, 200)}`)
      return
    }
    const job = inFlight
    if (!job || job.session !== s) {
      log.warn(`powershell worker: reply #${reply.id} arrived without a pending command`)
      return
    }
    if (reply.id !== job.id) {
      protocolFailure(s, `reply #${reply.id} does not match command #${job.id}`)
      return
    }
    clearTimer()
    inFlight = null
    if (reply.ok) settle(job, reply.result ?? null)
    else settle(job, undefined, new PsError('script', reply.error || 'PowerShell script failed'))
    pump()
  }

  function onStdout(s: Session, chunk: string): void {
    if (s.ended) return
    s.buffer += chunk
    let newline: number
    while ((newline = s.buffer.indexOf('\n')) !== -1) {
      const line = s.buffer.slice(0, newline).replace(/\r$/, '')
      s.buffer = s.buffer.slice(newline + 1)
      if (line.startsWith(MARK)) handleReply(s, line.slice(MARK.length))
      else if (line.trim()) log.debug(`powershell worker output: ${line.slice(0, 300)}`)
    }
  }

  function initJob(): Job {
    return {
      id: ++seq,
      script: `${PREAMBLE}\n${init}`,
      timeoutMs: INIT_TIMEOUT_MS,
      internal: true,
      settled: false,
      session: null,
      resolve: () => log.debug('powershell worker ready'),
      reject: (error) => {
        if (error.code === 'script')
          log.warn(`powershell worker init script failed: ${error.message}`)
      }
    }
  }

  function startSession(): boolean {
    let proc: ChildProcess
    try {
      proc = spawn(
        exe,
        ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
    } catch (err) {
      log.error(`powershell worker could not be spawned: ${(err as Error).message}`)
      recordCrash()
      return false
    }
    const s: Session = { proc, buffer: '', ended: false }
    session = s
    proc.stdout!.setEncoding('utf8')
    proc.stderr!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => onStdout(s, chunk))
    proc.stderr!.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) log.debug(`powershell worker stderr: ${text.slice(0, 500)}`)
    })
    proc.stdin!.on('error', (err) => log.debug(`powershell worker stdin error: ${err.message}`))
    proc.on('error', (err) => {
      log.error(`powershell worker failed: ${err.message}`)
      endSession(s, 'failed to start')
    })
    proc.on('exit', (code, signal) => endSession(s, `exited (${code ?? signal})`))
    // The init job jumps the queue so every later command sees the compiled types and global preferences.
    queue.unshift(initJob())
    return true
  }

  function send(s: Session, job: Job): void {
    inFlight = job
    job.session = s
    s.proc.stdin!.write(envelope(job.id, job.script) + '\n')
    timer = setTimeout(() => {
      if (job.settled) return
      settle(
        job,
        undefined,
        new PsError('timeout', `PowerShell script timed out after ${job.timeoutMs} ms`)
      )
      if (inFlight === job) inFlight = null
      log.warn(
        `powershell worker command #${job.id} timed out after ${job.timeoutMs} ms; restarting the worker`
      )
      killSession(s, 'was restarted after a timeout')
    }, job.timeoutMs)
    timer.unref()
  }

  async function runFresh(job: Job): Promise<void> {
    const script = `${PREAMBLE}\n${init}\n${envelope(job.id, job.script)}`
    try {
      const result = await runPowerShell(script, { timeoutMs: job.timeoutMs + 5_000 })
      const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith(MARK))
      const reply = line ? parseReply(line.slice(MARK.length)) : null
      if (!reply) {
        const detail = result.stderr.trim().split(/\r?\n/)[0]
        settle(
          job,
          undefined,
          new PsError(
            'unavailable',
            `PowerShell produced no result (exit code ${result.code})${detail ? `: ${detail}` : ''}`
          )
        )
        return
      }
      if (reply.ok) settle(job, reply.result ?? null)
      else settle(job, undefined, new PsError('script', reply.error || 'PowerShell script failed'))
    } catch (err) {
      settle(job, undefined, new PsError('unavailable', (err as Error).message))
    }
  }

  function pump(): void {
    if (disposed) return
    if (Date.now() < cooldownUntil) {
      for (const job of queue.splice(0)) {
        if (job.internal) settle(job, null)
        else void runFresh(job)
      }
      return
    }
    if (inFlight || queue.length === 0) return
    if (!session && !startSession()) {
      pump()
      return
    }
    const job = queue.shift()!
    send(session!, job)
  }

  return {
    run<T>(script: string, runOptions: PsRunOptions = {}): Promise<T | null> {
      if (disposed) return Promise.reject(new PsError('disposed', 'PowerShell worker disposed'))
      return new Promise<T | null>((resolve, reject) => {
        queue.push({
          id: ++seq,
          script,
          timeoutMs: runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          internal: false,
          settled: false,
          session: null,
          resolve: resolve as (value: unknown) => void,
          reject
        })
        pump()
      })
    },
    isRunning() {
      return session !== null && !session.ended
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer()
      const s = session
      session = null
      if (inFlight) {
        settle(inFlight, undefined, new PsError('disposed', 'PowerShell worker disposed'))
        inFlight = null
      }
      for (const job of queue.splice(0))
        settle(job, undefined, new PsError('disposed', 'PowerShell worker disposed'))
      if (s && !s.ended) {
        s.ended = true
        try {
          s.proc.stdin!.end('exit\n')
        } catch (err) {
          log.debug(`powershell worker stdin close failed: ${(err as Error).message}`)
        }
        const grace = setTimeout(() => {
          if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill()
        }, EXIT_GRACE_MS)
        grace.unref()
      }
    }
  }
}
