import { connect as netConnect, type Socket } from 'net'
import type { Logger } from '../logger'
import {
  cleanPids,
  encodeRequest,
  HelperMemoryBusyError,
  helperPipePath,
  LineDecoder,
  memTrimRequest,
  parseFps,
  parseInfo,
  parseMemResult,
  parseMemStart,
  parseResponse,
  parseRtssLimit,
  parseRtssRestore,
  parseRtssSelf,
  rtssLimitRequest,
  rtssSelfRequest,
  type FpsReading,
  type HelperInfo,
  type HelperMemoryResult,
  type HelperRequest,
  type HelperResponse,
  type MemoryTrimOptions,
  type RtssLimitResult
} from './helper/protocol'
import { tMain } from '../i18n'

/**
 * PlayOut's side of the power helper's pipe. Requests are sent one at a time. PlayOut never starts the helper: its
 * scheduled task runs it as SYSTEM from boot (and the install starts it), so a missing pipe means the helper is not
 * running. The pipe is retried for a few seconds (the helper compiles its C# when it starts, e.g. right after boot or
 * an install), then the request fails with notRunningMessage().
 */

export const notRunningMessage = (): string => tMain('mainPerformance.helper.notRunning')

export interface HelperClientDeps {
  /** The signed-in user's SID (the pipe's name). */
  sid: string
  log: Logger
  /** Tests: another pipe path. */
  pipePath?: string
  connect?: (path: string) => Socket
  /** How long a missing pipe is retried before notRunningMessage(). Default 3 s. */
  connectWaitMs?: number
  /** How long one request may take (Intel's info samples the energy counter for 250 ms). Default 15 s. */
  requestTimeoutMs?: number
  /** Delay between connection attempts while the helper starts. Default 500 ms. */
  retryMs?: number
  /** How often a running memory cleanup is asked for its result. Default 500 ms. */
  memoryPollMs?: number
  /** How long a memory cleanup may run before memoryTrim gives up on it. Default 45 s. */
  memoryTimeoutMs?: number
}

export interface HelperClient {
  /** Wait up to `timeoutMs` for the pipe (after an install started the task); throws notRunningMessage(). */
  waitUntilRunning?(timeoutMs: number): Promise<void>
  request(req: HelperRequest): Promise<HelperResponse>
  info(): Promise<HelperInfo>
  /** Resolves with the limits now in force; throws the helper's error. */
  set(
    watts: number | null,
    boostWatts: number | null
  ): Promise<{ watts?: number; boostWatts?: number }>
  restore(): Promise<void>
  /** Protocol 2: start the helper's PresentMon for these pids (replacing an earlier start). */
  fpsStart?(pids: number[]): Promise<void>
  /** Protocol 2: the busiest pid's frame rate over the last ~1.5 s. */
  fps?(): Promise<FpsReading>
  /** Protocol 2: stop the helper's PresentMon. */
  fpsStop?(): Promise<void>
  /**
   * Protocol 3: RivaTuner's per-program profile <exe>.cfg gets [Framerate] Limit=fps (0 puts back what was there
   * before PlayOut's first change, or deletes the file PlayOut created). Never the global profile.
   */
  rtssLimit?(exe: string, fps: number): Promise<RtssLimitResult>
  /** Protocol 3: <exe>.cfg gets [Hooking] EnableHooking=0 (PlayOut's own overlay is never hooked by RTSS). */
  rtssSelf?(exe: string): Promise<{ changed: boolean }>
  /** Protocol 3: every limit and hooking exclusion PlayOut wrote put back (before the helper is removed). */
  rtssRestore?(): Promise<{ restored: number }>
  /**
   * Protocol 4: a system-wide memory cleanup (helper/csharp.ts Mem): the working sets of `pids`, Windows' modified
   * and standby lists, memory combining. The helper runs it in the background; this starts it and asks for the result
   * until it has ended. Throws when the helper refuses it, loses it or has not ended it after `timeoutMs`: a
   * HelperMemoryBusyError whenever a cleanup is, or may still be, running in the helper (it was busy, or the one
   * started here was not seen to end), any other Error when it did not start one.
   */
  memoryTrim?(
    pids: readonly number[],
    options: MemoryTrimOptions & { timeoutMs?: number }
  ): Promise<HelperMemoryResult>
  close(): void
}

const NOT_THERE = new Set(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET'])

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createHelperClient(deps: HelperClientDeps): HelperClient {
  const path = deps.pipePath ?? helperPipePath(deps.sid)
  const connect = deps.connect ?? ((p: string) => netConnect(p))
  const connectWait = deps.connectWaitMs ?? 3_000
  const requestTimeout = deps.requestTimeoutMs ?? 15_000
  const retryMs = deps.retryMs ?? 500
  const memoryPoll = deps.memoryPollMs ?? 500
  const memoryTimeout = deps.memoryTimeoutMs ?? 45_000

  let socket: Socket | null = null
  let decoder = new LineDecoder()
  let waiting: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let closed = false

  function drop(err: Error): void {
    const s = socket
    socket = null
    s?.destroy()
    const w = waiting
    waiting = null
    w?.reject(err)
  }

  function open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(path)
      const onError = (err: Error): void => {
        s.destroy()
        reject(err)
      }
      s.once('error', onError)
      s.once('connect', () => {
        s.off('error', onError)
        s.on('error', (err) => drop(err))
        s.on('close', () => {
          if (socket === s) drop(new Error(tMain('mainPerformance.helper.connectionClosed')))
        })
        s.on('data', (chunk: Buffer) => {
          let lines: string[]
          try {
            lines = decoder.push(chunk)
          } catch (err) {
            drop(err as Error)
            return
          }
          for (const line of lines) {
            const w = waiting
            waiting = null
            w?.resolve(line)
          }
        })
        resolve(s)
      })
    })
  }

  /** Connect, retrying a missing pipe until `waitMs` has passed. */
  async function ensure(waitMs: number = connectWait): Promise<Socket> {
    if (socket && !socket.destroyed) return socket
    decoder = new LineDecoder()
    const deadline = Date.now() + waitMs
    for (;;) {
      try {
        socket = await open()
        return socket
      } catch (err) {
        if (!NOT_THERE.has((err as NodeJS.ErrnoException).code ?? '')) throw err
      }
      if (Date.now() + retryMs > deadline) break
      await sleep(retryMs)
    }
    deps.log.warn('performance: the power helper pipe is not there')
    throw new Error(notRunningMessage())
  }

  async function send(req: HelperRequest): Promise<HelperResponse> {
    if (closed) throw new Error(tMain('mainPerformance.helper.clientClosed'))
    const s = await ensure()
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        drop(new Error(tMain('mainPerformance.helper.noAnswer')))
      }, requestTimeout)
      waiting = {
        resolve: (l) => {
          clearTimeout(timer)
          resolve(l)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      }
      s.write(encodeRequest(req))
    })
    return parseResponse(line)
  }

  function request(req: HelperRequest): Promise<HelperResponse> {
    const next = chain.then(
      () => send(req),
      () => send(req)
    )
    chain = next.catch(() => undefined)
    return next
  }

  return {
    async waitUntilRunning(timeoutMs) {
      if (closed) throw new Error(tMain('mainPerformance.helper.clientClosed'))
      await ensure(timeoutMs)
    },
    request,
    async info() {
      return parseInfo(await request({ op: 'info' }))
    },
    async set(watts, boostWatts) {
      const res = await request({ op: 'set', watts, boostWatts })
      if (!res.ok) throw new Error(res.error)
      const o = res as Record<string, unknown>
      return {
        watts: typeof o.watts === 'number' ? o.watts : undefined,
        boostWatts: typeof o.boostWatts === 'number' ? o.boostWatts : undefined
      }
    },
    async restore() {
      const res = await request({ op: 'restore' })
      if (!res.ok) throw new Error(res.error)
    },
    async fpsStart(pids) {
      const clean = cleanPids(pids)
      if (!clean.length) throw new Error(tMain('mainPerformance.fps.noProcesses'))
      const res = await request({ op: 'fpsStart', pids: clean })
      if (!res.ok) throw new Error(res.error)
    },
    async fps() {
      return parseFps(await request({ op: 'fps' }))
    },
    async fpsStop() {
      const res = await request({ op: 'fpsStop' })
      if (!res.ok) throw new Error(res.error)
    },
    async rtssLimit(exe, fps) {
      return parseRtssLimit(await request(rtssLimitRequest(exe, fps)), exe, fps)
    },
    async rtssSelf(exe) {
      return parseRtssSelf(await request(rtssSelfRequest(exe)))
    },
    async rtssRestore() {
      return parseRtssRestore(await request({ op: 'rtssRestore' }))
    },
    async memoryTrim(pids, options) {
      const { id } = parseMemStart(await request(memTrimRequest(pids, options)))
      // From here the helper is cleaning up on its own thread: whatever goes wrong, it may still be at it.
      const deadline = Date.now() + (options.timeoutMs ?? memoryTimeout)
      for (;;) {
        await sleep(memoryPoll)
        let state: ReturnType<typeof parseMemResult>
        try {
          state = parseMemResult(await request({ op: 'memResult' }))
        } catch (err) {
          throw new HelperMemoryBusyError(
            tMain('mainPerformance.memory.helperNotReported', { error: (err as Error).message }),
            { cause: err }
          )
        }
        // Another cleanup's id: the helper restarted, or someone else started one.
        if (state.id !== id)
          throw new HelperMemoryBusyError(tMain('mainPerformance.memory.helperLost'))
        if (!state.running) {
          if (!state.result)
            throw new HelperMemoryBusyError(tMain('mainPerformance.memory.helperNoReport'))
          return state.result
        }
        if (Date.now() >= deadline)
          throw new HelperMemoryBusyError(tMain('mainPerformance.memory.timeout'))
      }
    },
    close() {
      closed = true
      drop(new Error(tMain('mainPerformance.helper.clientClosed')))
    }
  }
}
