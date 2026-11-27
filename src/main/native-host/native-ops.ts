import type { DisplayMode, MediaAction, MediaSession } from '../../shared/overlay'
import type { Logger } from '../logger'
import { parseRtssSnapshot, type RtssSnapshot } from '../rtss/memory'
import {
  parseElapsedMs,
  parseTrimCounts,
  TRIM_CS_MAX_PIDS,
  type TrimCounts
} from '../performance/memory/trim-cs'
import { createPsWorker, type PsRunner, type PsWorker } from '../system/ps-worker'
import { mediaControlScript, MEDIA_SESSION_SCRIPT, NATIVE_INIT } from './native-cs'
import { tMain } from '../i18n'

/**
 * Window, display and media calls for the overlay (docs/home-overlay.md), through one dedicated PowerShell worker that
 * compiles the PlayOutNative class (native-cs.ts) once. All rectangles are physical pixels; Electron's screen API
 * converts them (screen.screenToDipRect).
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface MonitorInfo {
  /** GDI device name, e.g. \\.\DISPLAY1 (what displayModes and setDisplayMode take). */
  device: string
  rect: Rect
  workArea: Rect
}

export interface ForegroundWindow {
  /** The window handle as a decimal string (what focus and restore take). */
  hwnd: string
  pid: number
  /** Full path of the program when readable; only its file name for protected processes; '' when unknown. */
  exe: string
  title: string
  rect: Rect
  monitor: MonitorInfo | null
  /** The window covers its whole monitor (borderless or exclusive full screen). */
  fullscreen: boolean
  /** Windows reports a Direct3D exclusive full-screen app (it minimizes when it loses the foreground). */
  exclusive: boolean
}

export interface DisplayModes {
  current: DisplayMode
  modes: DisplayMode[]
}

export interface NativeOps {
  foreground(): Promise<ForegroundWindow | null>
  /** Bring a window to the foreground; true when it is the foreground afterwards. */
  focus(hwnd: string): Promise<boolean>
  /** Give a saved window (the game) the foreground back, restoring it if minimized. */
  restore(hwnd: string): Promise<void>
  displayModes(device: string): Promise<DisplayModes>
  /** Change and persist a monitor's mode, after Windows confirmed it can (code: DISP_CHANGE_*, 0 = success). */
  setDisplayMode(device: string, mode: DisplayMode): Promise<{ ok: boolean; code: number }>
  mediaSession(): Promise<MediaSession | null>
  mediaControl(action: MediaAction): Promise<void>
  /**
   * Pause (suspend) or resume a process. A resume passes the start time the pause reported, so a process that
   * ended and whose PID was reused is left alone ('gone').
   */
  pauseProcess(pid: number, pause: boolean, created?: number): Promise<PauseResult>
  /** RivaTuner Statistics Server's shared memory, read-only; null when RTSS is not running. Never throws. */
  rtssSnapshot(): Promise<RtssSnapshot | null>
  /**
   * Write text into the RTSS OSD slot of `owner` (claimed when needed), or with text null clear and free it.
   * owner: /^[\w .-]{1,31}$/. Text above OSD_TEXT_MAX characters is cut. Never throws.
   */
  rtssOsd(owner: string, text: string | null): Promise<OsdResult>
  /** Ask every app RTSS has hooked to reload its profile (what RTSSHooks64.dll UpdateProfiles does); entries flagged. */
  rtssRequestProfileUpdate(): Promise<number>
  /** Windows HDR for a monitor (\\.\DISPLAYn); null when unreadable. Never throws. */
  hdrState(device: string): Promise<HdrState | null>
  /**
   * Trim the working sets of these processes with this user's own rights (performance/memory, the tier without the
   * power helper). The C# refuses protected programs again by their image path, and every process created at or
   * after `createdBefore` (Date.now() milliseconds: when the process list the pids come from was read), so a reused
   * process id is never trimmed; `shell` lets explorer.exe through. Throws when the list is not one (see
   * isTrimPidList), `createdBefore` is not a time, or the worker failed.
   */
  trimWorkingSets(
    pids: readonly number[],
    shell: boolean,
    createdBefore: number
  ): Promise<TrimCounts>
  dispose(): void
}

/** A pid list the trim takes: whole numbers above 4, at most TRIM_CS_MAX_PIDS (they reach the script as literals). */
export function isTrimPidList(pids: readonly number[]): boolean {
  return (
    Array.isArray(pids) &&
    pids.length <= TRIM_CS_MAX_PIDS &&
    pids.every((p) => Number.isInteger(p) && p > 4 && p <= 0x7fffffff)
  )
}

/** One answer of PlayOutMemory.Trim; throws when it is not one (the class did not compile). */
export function parseTrimResult(raw: unknown): TrimCounts {
  const value = decode(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { trimmed?: unknown }).trimmed !== 'number'
  )
    throw new Error(tMain('mainApp.memory.noWindowsAnswer'))
  const ms = parseElapsedMs((value as { ms?: unknown }).ms)
  return { ...parseTrimCounts(value), ...(ms !== undefined ? { ms } : {}) }
}

export interface OsdResult {
  ok: boolean
  slot?: number
  /** 'missing': RTSS is not running; 'busy': its OSD lock was held; 'full': no free slot. */
  error?: 'missing' | 'busy' | 'full' | string
}

export interface HdrState {
  /** The display can show HDR. */
  supported: boolean
  /** Windows HDR is on for it. */
  enabled: boolean
}

/** The longest OSD text written (szOSDEx holds 4096 bytes with its terminator). */
export const OSD_TEXT_MAX = 4095
const OSD_OWNER = /^[\w .-]{1,31}$/

export { parseRtssSnapshot }

/** One answer of PlayOutRtss.Osd. */
export function parseOsdResult(raw: unknown): OsdResult {
  const value = decode(raw)
  if (!value || typeof value !== 'object') return { ok: false, error: 'missing' }
  const r = value as { ok?: unknown; slot?: unknown; error?: unknown }
  if (r.ok === true)
    return {
      ok: true,
      ...(typeof r.slot === 'number' && Number.isInteger(r.slot) && r.slot >= 0
        ? { slot: r.slot }
        : {})
    }
  return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : 'missing' }
}

/** One answer of PlayOutHdr.State. */
export function parseHdrState(raw: unknown): HdrState | null {
  const value = decode(raw)
  if (!value || typeof value !== 'object') return null
  const r = value as { supported?: unknown; enabled?: unknown }
  if (typeof r.supported !== 'boolean' || typeof r.enabled !== 'boolean') return null
  return { supported: r.supported, enabled: r.enabled }
}

/** The number of app entries PlayOutRtss.RequestProfileUpdate flagged. */
export function parseFlagged(raw: unknown): number {
  const value = decode(raw)
  if (!value || typeof value !== 'object') return 0
  const n = (value as { flagged?: unknown }).flagged
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0
}

/** A string for a script, as base64 decoded there: no quoting can break out of it. */
function psText(value: string): string {
  return `[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`
}

export interface PauseResult {
  ok: boolean
  /** The process's start time (ms since 1601), to resume exactly this process later. */
  created?: number
  /** 'access': another user's or an elevated process; 'gone': it ended; else Windows' status. */
  error?: string
}

/** One answer of PlayOutNative.Pause. */
export function parsePauseResult(raw: unknown): PauseResult {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  if (!value || typeof value !== 'object') return { ok: false, error: 'no answer' }
  const r = value as { ok?: unknown; created?: unknown; error?: unknown }
  return {
    ok: r.ok === true,
    ...(typeof r.created === 'number' && r.created > 0 ? { created: r.created } : {}),
    ...(typeof r.error === 'string' && r.error ? { error: r.error } : {})
  }
}

export interface NativeOpsDeps {
  log: Logger
  /** A runner that has already run NATIVE_INIT (tests); by default a dedicated worker is created and owned. */
  runner?: PsRunner
}

/**
 * BrowserWindow.getNativeWindowHandle() as the decimal string the native calls take and foreground() reports: the
 * HWND is a pointer stored little-endian (8 bytes in 64-bit Electron, 4 in 32-bit), but only its low 32 bits mean
 * anything (Windows shares handles with 32-bit processes and may sign-extend them). Reading those bits unsigned gives
 * the same string as the C# side, so handles can be compared as strings.
 */
export function hwndOf(handle: Buffer): string {
  if (handle.length >= 4) return handle.readUInt32LE(0).toString()
  throw new Error(`Unexpected window handle size: ${handle.length} bytes`)
}

/** Handles and device names reach the scripts as literals, so only these shapes are let through. */
export function isHwnd(value: string): boolean {
  return /^[1-9]\d{0,19}$/.test(value)
}

export function isDisplayDevice(value: string): boolean {
  return /^\\\\\.\\DISPLAY\d{1,3}$/i.test(value)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The worker's result: the C# methods answer with a JSON string. */
function decode(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseRect(raw: unknown): Rect | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = num(r.x)
  const y = num(r.y)
  const width = num(r.width)
  const height = num(r.height)
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height }
}

export function parseForeground(raw: unknown): ForegroundWindow | null {
  const value = decode(raw)
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const hwnd = str(v.hwnd)
  const pid = num(v.pid)
  const rect = parseRect(v.rect)
  if (!isHwnd(hwnd) || pid === null || !rect) return null
  let monitor: MonitorInfo | null = null
  if (v.monitor && typeof v.monitor === 'object') {
    const m = v.monitor as Record<string, unknown>
    const mRect = parseRect(m.rect)
    const work = parseRect(m.workArea)
    if (mRect && work && str(m.device))
      monitor = { device: str(m.device), rect: mRect, workArea: work }
  }
  return {
    hwnd,
    pid,
    exe: str(v.exe),
    title: str(v.title),
    rect,
    monitor,
    fullscreen: v.fullscreen === true,
    exclusive: v.exclusive === true
  }
}

interface RawMode {
  width: number
  height: number
  hz: number
  bpp: number
}

function parseMode(raw: unknown): RawMode | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const width = num(m.width)
  const height = num(m.height)
  const hz = num(m.hz)
  const bpp = num(m.bpp)
  if (!width || !height || hz === null || bpp === null) return null
  return { width, height, hz, bpp }
}

/** Largest first (by pixel count, then width), then the highest refresh rate. */
export function compareModes(a: DisplayMode, b: DisplayMode): number {
  return b.width * b.height - a.width * a.height || b.width - a.width || b.hz - a.hz
}

/**
 * The modes a monitor offers, as the overlay lists them: 32-bit colour only (the 8/16-bit ones are legacy), each
 * resolution and rate once (drivers repeat them per scaling and orientation), sorted by compareModes. Rates of 0 and 1
 * mean "hardware default" and are dropped.
 */
export function normalizeModes(raw: unknown): DisplayModes | null {
  const value = decode(raw)
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const current = parseMode(v.current)
  if (!current) return null
  const seen = new Set<string>()
  const modes: DisplayMode[] = []
  for (const item of Array.isArray(v.modes) ? (v.modes as unknown[]) : []) {
    const m = parseMode(item)
    if (!m || m.bpp !== 32 || m.hz <= 1) continue
    const key = `${m.width}x${m.height}@${m.hz}`
    if (seen.has(key)) continue
    seen.add(key)
    modes.push({ width: m.width, height: m.height, hz: m.hz })
  }
  modes.sort(compareModes)
  return { current: { width: current.width, height: current.height, hz: current.hz }, modes }
}

/** GlobalSystemMediaTransportControlsSessionPlaybackStatus → MediaSession.status. */
export function mapPlaybackStatus(status: string): MediaSession['status'] {
  switch (status) {
    case 'Playing':
      return 'playing'
    case 'Paused':
      return 'paused'
    case 'Stopped':
    case 'Closed':
      return 'stopped'
    default:
      return 'other'
  }
}

export function parseMediaSession(raw: unknown): MediaSession | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const session: MediaSession = {
    app: str(v.app),
    title: str(v.title),
    artist: str(v.artist),
    album: str(v.album),
    status: mapPlaybackStatus(str(v.status)),
    canNext: v.canNext === true,
    canPrevious: v.canPrevious === true
  }
  if (typeof v.art === 'string' && /^data:image\/[\w.+-]+;base64,/.test(v.art)) session.art = v.art
  return session
}

/** MediaAction → the session's Try…Async method. */
export const MEDIA_METHODS: Record<MediaAction, string> = {
  toggle: 'TryTogglePlayPauseAsync',
  play: 'TryPlayAsync',
  pause: 'TryPauseAsync',
  next: 'TrySkipNextAsync',
  previous: 'TrySkipPreviousAsync'
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function createNativeOps(deps: NativeOpsDeps): NativeOps {
  const { log } = deps
  let owned: PsWorker | null = null
  const runner: PsRunner = deps.runner ?? (owned = createPsWorker({ log, init: NATIVE_INIT }))

  async function activate(hwnd: string): Promise<boolean> {
    if (!isHwnd(hwnd)) throw new Error(`Not a window handle: ${hwnd}`)
    return (
      (await runner.run<boolean>(`[PlayOutNative]::Activate('${hwnd}')`, { timeoutMs: 5_000 })) ===
      true
    )
  }

  return {
    async foreground() {
      try {
        return parseForeground(
          await runner.run('[PlayOutNative]::Foreground()', { timeoutMs: 5_000 })
        )
      } catch (err) {
        log.warn(`foreground window could not be read: ${(err as Error).message}`)
        return null
      }
    },
    async focus(hwnd) {
      try {
        return await activate(hwnd)
      } catch (err) {
        log.warn(`focus failed: ${(err as Error).message}`)
        return false
      }
    },
    async restore(hwnd) {
      try {
        if (!(await activate(hwnd))) log.debug(`window ${hwnd} did not take the foreground back`)
      } catch (err) {
        log.warn(`restore failed: ${(err as Error).message}`)
      }
    },
    async pauseProcess(pid, pause, created) {
      if (!Number.isSafeInteger(pid) || pid <= 4) return { ok: false, error: 'not a process' }
      const ticks = created !== undefined && Number.isSafeInteger(created) ? created : 0
      try {
        return parsePauseResult(
          await runner.run(
            `[PlayOutNative]::Pause(${pid}, $${pause ? 'true' : 'false'}, ${ticks})`,
            {
              timeoutMs: 5_000
            }
          )
        )
      } catch (err) {
        log.warn(
          `${pause ? 'pausing' : 'resuming'} process ${pid} failed: ${(err as Error).message}`
        )
        return { ok: false, error: (err as Error).message }
      }
    },
    async displayModes(device) {
      if (!isDisplayDevice(device)) throw new Error(`Not a display device: ${device}`)
      const result = normalizeModes(
        await runner.run(`[PlayOutNative]::DisplayModes(${psQuote(device)})`, { timeoutMs: 10_000 })
      )
      if (!result) throw new Error(`The modes of ${device} could not be read`)
      return result
    },
    async setDisplayMode(device, mode) {
      if (!isDisplayDevice(device)) throw new Error(`Not a display device: ${device}`)
      const ints = [mode.width, mode.height, mode.hz]
      if (!ints.every((n) => Number.isInteger(n) && n > 0 && n < 100_000))
        throw new Error(`Not a display mode: ${JSON.stringify(mode)}`)
      const code = await runner.run<number>(
        `[PlayOutNative]::SetDisplayMode(${psQuote(device)}, ${ints.join(', ')})`,
        { timeoutMs: 15_000 }
      )
      const value = typeof code === 'number' ? code : -999
      if (value !== 0)
        log.warn(`display mode ${ints.join('/')} on ${device} refused (code ${value})`)
      return { ok: value === 0, code: value }
    },
    async mediaSession() {
      try {
        return parseMediaSession(await runner.run(MEDIA_SESSION_SCRIPT, { timeoutMs: 8_000 }))
      } catch (err) {
        log.debug(`media session could not be read: ${(err as Error).message}`)
        return null
      }
    },
    async mediaControl(action) {
      const method = MEDIA_METHODS[action]
      if (!method) throw new Error(`Unknown media action: ${String(action)}`)
      try {
        const done = await runner.run<boolean>(mediaControlScript(method), { timeoutMs: 8_000 })
        if (done !== true) log.debug(`media ${action}: no session, or the app refused`)
      } catch (err) {
        log.warn(`media ${action} failed: ${(err as Error).message}`)
      }
    },
    async rtssSnapshot() {
      try {
        return parseRtssSnapshot(
          await runner.run('[PlayOutRtss]::Snapshot()', { timeoutMs: 3_000 })
        )
      } catch (err) {
        log.debug(`RTSS shared memory could not be read: ${(err as Error).message}`)
        return null
      }
    },
    async rtssOsd(owner, text) {
      if (!OSD_OWNER.test(owner)) return { ok: false, error: 'owner' }
      const body = text === null ? '$null' : psText(text.slice(0, OSD_TEXT_MAX))
      try {
        return parseOsdResult(
          await runner.run(`[PlayOutRtss]::Osd(${psQuote(owner)}, ${body})`, { timeoutMs: 3_000 })
        )
      } catch (err) {
        log.debug(`RTSS OSD could not be written: ${(err as Error).message}`)
        return { ok: false, error: (err as Error).message }
      }
    },
    async rtssRequestProfileUpdate() {
      try {
        return parseFlagged(
          await runner.run('[PlayOutRtss]::RequestProfileUpdate()', { timeoutMs: 3_000 })
        )
      } catch (err) {
        log.debug(`RTSS profile reload could not be requested: ${(err as Error).message}`)
        return 0
      }
    },
    async hdrState(device) {
      if (!isDisplayDevice(device)) return null
      try {
        return parseHdrState(
          await runner.run(`[PlayOutHdr]::State(${psQuote(device)})`, { timeoutMs: 3_000 })
        )
      } catch (err) {
        log.debug(`HDR state of ${device} could not be read: ${(err as Error).message}`)
        return null
      }
    },
    async trimWorkingSets(pids, shell, createdBefore) {
      if (!isTrimPidList(pids)) throw new Error('Not a list of processes to trim')
      if (!Number.isSafeInteger(createdBefore) || createdBefore <= 0)
        throw new Error('Not a time to trim before')
      return parseTrimResult(
        await runner.run(
          `[PlayOutMemory]::Trim([int[]]@(${pids.join(', ')}), $${shell ? 'true' : 'false'}, [long]${createdBefore})`,
          { timeoutMs: 30_000 }
        )
      )
    },
    dispose() {
      owned?.dispose()
      owned = null
    }
  }
}
