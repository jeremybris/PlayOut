import { FRAME_LIMIT_MAX } from '../../../shared/overlay-extras'
import type { MemoryPassSteps, MemoryStep } from '../../../shared/memory'
import { isProfileExe } from '../../rtss/memory'
import {
  parseElapsedMs,
  parseTrimCounts,
  TRIM_CS_MAX_PIDS,
  type TrimCounts
} from '../memory/trim-cs'
import { tMain } from '../../i18n'

/**
 * The power helper's pipe protocol: one JSON object per line ("\n"), one request at a time, one answer per request.
 *
 *   {"op":"info"}                              -> {"ok":true,"method":"intel-msr","cpu":"…","minWatts":5,…}
 *   {"op":"set","watts":15,"boostWatts":25}    -> {"ok":true,"watts":15,"boostWatts":25}
 *   {"op":"restore"}                           -> {"ok":true}
 *   {"op":"fpsStart","pids":[1234,5678]}       -> {"ok":true}            (version 2: starts its own PresentMon)
 *   {"op":"fps"}                               -> {"ok":true,"fps":58.7,"frameTimeMs":17.0,"pid":1234,"frames":88}
 *                                                 ({"ok":true,"fps":null} while no frames came in the last ~1.5 s)
 *   {"op":"fpsStop"}                           -> {"ok":true}
 *   {"op":"rtssLimit","exe":"Game.exe","fps":60} -> {"ok":true,"exe":"Game.exe","fps":60,"created":true}
 *                                                 (version 3: RivaTuner's Profiles\Game.exe.cfg [Framerate] Limit;
 *                                                 fps 0 puts back what was there before PlayOut's first change)
 *   {"op":"rtssSelf","exe":"PlayOut.exe"}      -> {"ok":true,"changed":true}   (version 3: [Hooking] EnableHooking=0)
 *   {"op":"rtssRestore"}                       -> {"ok":true,"restored":3}     (version 3: every limit and exclusion
 *                                                 PlayOut wrote put back, before the helper is removed)
 *   {"op":"memTrim","pids":[1234],"shell":false,"purgeBelowMb":1024,"createdBefore":1700000000000}
 *                                              -> {"ok":true,"id":7}
 *                                                 (version 4: starts a memory cleanup in the background, so the pipe
 *                                                 keeps answering Dynamic TDP's readings: the working sets of these
 *                                                 pids, the modified list, the low-priority standby list, the whole
 *                                                 standby list only when less than purgeBelowMb is free by then
 *                                                 and the list holds at least that much, and memory combining. A process created at or after
 *                                                 createdBefore (Unix ms: when the pid list was read) is left alone)
 *   {"op":"memResult"}                         -> {"ok":true,"id":7,"running":true}, then
 *                                                 {"ok":true,"id":7,"running":false,"steps":{…}} (version 4)
 *   anything that fails                        -> {"ok":false,"error":"…"}
 *
 * The pipe is \\.\pipe\PlayOutPower-<user SID> (the user who installed the helper, from user.sid); only that user,
 * SYSTEM and Administrators may open it (network logons are denied).
 */

export const HELPER_PROTOCOL_VERSION = 4
/** The first version that measures frame rates (fpsStart / fps / fpsStop): what Dynamic TDP needs. */
export const HELPER_FPS_VERSION = 2
/** The first version that writes RivaTuner per-game profiles (rtssLimit / rtssSelf): the frame rate limit tile. */
export const HELPER_RTSS_VERSION = 3
/** The first version that frees memory system-wide (memTrim / memResult): Settings › System's "Free up memory". */
export const HELPER_MEMORY_VERSION = 4

/** Highest frame rate limit the helper accepts (FRAME_LIMIT_MAX in shared/overlay-extras.ts). */
export const MAX_RTSS_FPS = FRAME_LIMIT_MAX

/** At most this many pids per fpsStart (the helper refuses more). */
export const MAX_FPS_PIDS = 64

/** At most this many pids per memTrim (the helper refuses the whole request above it). */
export const MAX_TRIM_PIDS = TRIM_CS_MAX_PIDS
/** The largest purgeBelowMb the helper takes (1 TB). */
export const MAX_PURGE_BELOW_MB = 1_048_576

export type HelperRequest =
  | { op: 'info' }
  | { op: 'set'; watts: number | null; boostWatts: number | null }
  | { op: 'restore' }
  | { op: 'fpsStart'; pids: number[] }
  | { op: 'fps' }
  | { op: 'fpsStop' }
  | { op: 'rtssLimit'; exe: string; fps: number }
  | { op: 'rtssSelf'; exe: string }
  | { op: 'rtssRestore' }
  | { op: 'memTrim'; pids: number[]; shell: boolean; purgeBelowMb: number; createdBefore: number }
  | { op: 'memResult' }

/** The frame rate of the measured process with the most presents (rolling ~1.5 s), or fps null without frames. */
export interface FpsReading {
  fps: number | null
  frameTimeMs?: number
  pid?: number
  frames?: number
  /** False when the helper's PresentMon is not running (stopped, or every measured process exited). */
  running: boolean
}

export type HelperMethod = 'intel-msr' | 'ryzen-smu'

export interface HelperInfo {
  ok: true
  /** Null when the helper found no method on this CPU (see message). */
  method: HelperMethod | null
  cpu: string
  minWatts?: number
  maxWatts?: number
  /** Package power now (Intel: from the energy counter; AMD: the PM table), watts. */
  currentWatts?: number
  /** The sustained and boost limits in force now. */
  watts?: number
  boostWatts?: number
  /** Intel: MSR 0x610's lock bit is set, the limits cannot be changed. */
  locked?: boolean
  message?: string
  version: number
}

export type HelperResponse = (Record<string, unknown> & { ok: true }) | { ok: false; error: string }

const SID = /^S-1-5-21(-\d+){3,4}$|^S-1-5-\d+$/

export function helperPipeName(sid: string): string {
  if (!SID.test(sid)) throw new Error(`Not a user SID: ${sid}`)
  return `PlayOutPower-${sid}`
}

export function helperPipePath(sid: string): string {
  return `\\\\.\\pipe\\${helperPipeName(sid)}`
}

export function encodeRequest(req: HelperRequest): string {
  return `${JSON.stringify(req)}\n`
}

/** Longest line accepted; a helper answer is a few hundred bytes. */
export const MAX_LINE = 64 * 1024

/**
 * Splits a byte stream into lines (UTF-8, "\n" or "\r\n"), keeping a partial line between chunks. A line longer than
 * MAX_LINE throws: the other end is not the helper.
 */
export class LineDecoder {
  private buffer = ''
  private readonly decoder = new TextDecoder('utf-8')

  push(chunk: Uint8Array | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const lines: string[] = []
    let i: number
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '')
      this.buffer = this.buffer.slice(i + 1)
      if (line.trim()) lines.push(line)
    }
    if (this.buffer.length > MAX_LINE) {
      this.buffer = ''
      throw new Error(tMain('mainPerformance.helper.lineTooLong'))
    }
    return lines
  }
}

export function parseResponse(line: string): HelperResponse {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(tMain('mainPerformance.helper.notJson'))
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(tMain('mainPerformance.helper.unexpected'))
  const o = value as Record<string, unknown>
  if (o.ok === true) return o as HelperResponse
  if (o.ok === false)
    return {
      ok: false,
      error: typeof o.error === 'string' ? o.error : tMain('mainPerformance.helper.failed')
    }
  throw new Error(tMain('mainPerformance.helper.unexpected'))
}

const finiteOrUndefined = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** Pids worth sending: whole, above the idle and System processes, no repeats, at most MAX_FPS_PIDS. */
export function cleanPids(pids: readonly number[]): number[] {
  const out: number[] = []
  for (const p of pids)
    if (Number.isInteger(p) && p > 4 && p <= 0xffffffff && !out.includes(p)) out.push(p)
  return out.slice(0, MAX_FPS_PIDS)
}

export function parseFps(res: HelperResponse): FpsReading {
  if (!res.ok) throw new Error(res.error)
  const o = res as Record<string, unknown>
  const fps = finiteOrUndefined(o.fps)
  const running = o.running !== false
  if (fps === undefined || fps <= 0) return { fps: null, running }
  return {
    fps,
    frameTimeMs: finiteOrUndefined(o.frameTimeMs),
    pid: typeof o.pid === 'number' && Number.isInteger(o.pid) ? o.pid : undefined,
    frames: finiteOrUndefined(o.frames),
    running
  }
}

export function parseInfo(res: HelperResponse): HelperInfo {
  if (!res.ok) throw new Error(res.error)
  const o = res as Record<string, unknown>
  const method = o.method === 'intel-msr' || o.method === 'ryzen-smu' ? o.method : null
  return {
    ok: true,
    method,
    cpu: typeof o.cpu === 'string' ? o.cpu : '',
    minWatts: finiteOrUndefined(o.minWatts),
    maxWatts: finiteOrUndefined(o.maxWatts),
    currentWatts: finiteOrUndefined(o.currentWatts),
    watts: finiteOrUndefined(o.watts),
    boostWatts: finiteOrUndefined(o.boostWatts),
    locked: o.locked === true ? true : undefined,
    message: typeof o.message === 'string' && o.message ? o.message : undefined,
    version: typeof o.version === 'number' ? o.version : 0
  }
}

/** A frame rate limit the helper takes: a whole number from 0 (put back) to MAX_RTSS_FPS. */
export function isRtssFps(fps: unknown): fps is number {
  return typeof fps === 'number' && Number.isInteger(fps) && fps >= 0 && fps <= MAX_RTSS_FPS
}

/** Checks an rtssLimit request before it is sent (the helper checks it again). */
export function rtssLimitRequest(exe: string, fps: number): HelperRequest {
  if (!isProfileExe(exe)) throw new Error(`Not a program name: ${exe}`)
  if (!isRtssFps(fps)) throw new Error(`Not a frame rate limit: ${fps}`)
  return { op: 'rtssLimit', exe, fps }
}

export function rtssSelfRequest(exe: string): HelperRequest {
  if (!isProfileExe(exe)) throw new Error(`Not a program name: ${exe}`)
  return { op: 'rtssSelf', exe }
}

export interface RtssLimitResult {
  exe: string
  fps: number
  /** The profile file did not exist before PlayOut's first limit for this program. */
  created: boolean
}

export function parseRtssLimit(res: HelperResponse, exe: string, fps: number): RtssLimitResult {
  if (!res.ok) throw new Error(res.error)
  const o = res as Record<string, unknown>
  return {
    exe: typeof o.exe === 'string' && o.exe ? o.exe : exe,
    fps: isRtssFps(o.fps) ? o.fps : fps,
    created: o.created === true
  }
}

/** rtssRestore's answer: how many profiles were put back; throws the helper's error. */
export function parseRtssRestore(res: HelperResponse): { restored: number } {
  if (!res.ok) throw new Error(res.error)
  const n = (res as Record<string, unknown>).restored
  return { restored: typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0 }
}

export function parseRtssSelf(res: HelperResponse): { changed: boolean } {
  if (!res.ok) throw new Error(res.error)
  return { changed: (res as Record<string, unknown>).changed === true }
}

export interface MemoryTrimOptions {
  /** explorer.exe may be trimmed (the running game is in front); the helper refuses it otherwise. */
  shell: boolean
  /**
   * When the process list the pids come from was read (Date.now() milliseconds): the helper leaves every process
   * created at or after it alone, so a process id reused since then is never trimmed.
   */
  createdBefore: number
  /**
   * Drop the whole standby cache when less than this is free (not merely available: the cache itself counts as
   * available) after the earlier steps and the cache holds at least this much; 0: never.
   */
  purgeBelowMb: number
}

/**
 * Checks a memTrim request before it is sent (the helper checks it again and refuses the whole request): whole pids
 * above 4, no repeats, at most MAX_TRIM_PIDS; a whole purgeBelowMb from 0 to MAX_PURGE_BELOW_MB; createdBefore a
 * whole number of milliseconds above 0.
 */
export function memTrimRequest(pids: readonly number[], options: MemoryTrimOptions): HelperRequest {
  if (!Array.isArray(pids)) throw new Error('Not a list of processes.')
  const clean: number[] = []
  for (const p of pids) {
    if (!Number.isInteger(p) || p <= 4 || p > 0x7fffffff) throw new Error(`Not a process id: ${p}`)
    if (!clean.includes(p)) clean.push(p)
  }
  if (clean.length > MAX_TRIM_PIDS) throw new Error('Too many processes to trim at once.')
  const below = options.purgeBelowMb
  if (!Number.isInteger(below) || below < 0 || below > MAX_PURGE_BELOW_MB)
    throw new Error(`Not a memory amount: ${below}`)
  const before = options.createdBefore
  if (!Number.isSafeInteger(before) || before <= 0) throw new Error(`Not a time: ${before}`)
  return {
    op: 'memTrim',
    pids: clean,
    shell: options.shell === true,
    purgeBelowMb: below,
    createdBefore: before
  }
}

/** What the helper answers a memTrim while its last cleanup is still running (csharp.ts Mem.Busy). */
export const HELPER_MEMORY_BUSY = 'A memory cleanup is already running.'

/**
 * The helper is, or may still be, running a memory cleanup that this request did not get the result of: it was busy
 * with an earlier one, or the one just started was lost or did not end in time. Nobody else may trim meanwhile.
 */
export class HelperMemoryBusyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HelperMemoryBusyError'
  }
}

/** memTrim's answer: the id memResult reports this cleanup under. */
export function parseMemStart(res: HelperResponse): { id: number } {
  if (!res.ok) {
    if (res.error === HELPER_MEMORY_BUSY) throw new HelperMemoryBusyError(res.error)
    throw new Error(res.error)
  }
  const id = (res as Record<string, unknown>).id
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0)
    throw new Error(tMain('mainPerformance.memory.helperDidNotStart'))
  return { id }
}

/** What the helper's cleanup did: the steps in order, and the working-set counts. */
export interface HelperMemoryResult {
  steps: MemoryPassSteps
  counts: TrimCounts
  /** How long the whole cleanup took in the helper; absent when the helper did not say. */
  totalMs?: number
}

/** memResult's answer: the cleanup `id` is still running, or what it did. */
export interface HelperMemoryState {
  id: number
  running: boolean
  result?: HelperMemoryResult
}

function parseStep(raw: unknown): MemoryStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const state = o.state === 'done' || o.state === 'failed' || o.state === 'skipped' ? o.state : null
  if (!state) return undefined
  // A skipped step took no time; a missing or invalid "ms" (a helper from before timings) leaves the step as it is.
  const ms = state === 'skipped' ? undefined : parseElapsedMs(o.ms)
  return {
    state,
    ...(typeof o.detail === 'string' && o.detail ? { detail: o.detail } : {}),
    ...(ms !== undefined ? { ms } : {})
  }
}

const MEMORY_STEPS = ['modifiedList', 'lowPriorityStandby', 'standby', 'combine'] as const

/** The steps of a finished cleanup; a step the helper did not report is 'failed' (never taken as done). */
export function parseMemSteps(raw: unknown): HelperMemoryResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const missing: MemoryStep = {
    state: 'failed',
    detail: tMain('mainPerformance.memory.notReported')
  }
  const steps: MemoryPassSteps = { workingSets: parseStep(o.workingSets) ?? missing }
  for (const name of MEMORY_STEPS) steps[name] = parseStep(o[name]) ?? missing
  const totalMs = parseElapsedMs(o.totalMs)
  return {
    steps,
    counts: parseTrimCounts(o.workingSets),
    ...(totalMs !== undefined ? { totalMs } : {})
  }
}

export function parseMemResult(res: HelperResponse): HelperMemoryState {
  if (!res.ok) throw new Error(res.error)
  const o = res as Record<string, unknown>
  const id = typeof o.id === 'number' && Number.isInteger(o.id) ? o.id : 0
  if (o.running === true) return { id, running: true }
  if (!o.steps || typeof o.steps !== 'object') return { id, running: false }
  return { id, running: false, result: parseMemSteps(o.steps) }
}
