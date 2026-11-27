/**
 * RivaTuner Statistics Server's shared memory ("RTSSSharedMemoryV2", SDK RTSSSharedMemory.h v2.x), as the native host
 * reads it (native-cs.ts PlayOutRtss.Snapshot): the pure parts that pick the game's entry and work out its frame rate.
 */

/** 'RTSS' as the header's first DWORD. RTSS writes 'DEAD' there when it exits. */
export const RTSS_SIGNATURE = 0x52545353
/** App entry dwFlags bit RTSSHooks64.dll's UpdateProfiles sets: the hooked app reloads its profile. */
export const APPFLAG_PROFILE_UPDATE_REQUESTED = 0x10000000

export interface RtssAppEntry {
  pid: number
  /** The program's full path (ANSI, as RTSS stores it). */
  name: string
  flags: number
  /** The frame rate window: RTSS counts `frames` between `time0` and `time1` (ms ticks). */
  time0: number
  time1: number
  frames: number
  /** The last frame's time, microseconds. */
  frameTimeUs: number
}

export interface RtssSnapshot {
  /** dwVersion, e.g. 0x00020015 for v2.21. */
  version: number
  /** dwLastForegroundAppProcessID (v2.16+); null on older versions or when 0. */
  foregroundPid: number | null
  /** The entries in use (pid != 0). */
  apps: RtssAppEntry[]
  /**
   * The system's millisecond tick (GetTickCount) when the snapshot was read: the clock of time0/time1. Absent from
   * older native hosts; with it, an entry whose window ended long ago (the game stopped presenting) is not measured.
   */
  tick?: number
}

/** An app entry whose last frame window ended longer ago than this, ms, has stopped presenting (hung, paused, minimized). */
export const RTSS_STALE_MS = 2_500

/** ms from `time1` to `tick` (32-bit ticks, wrap-around included); 0 when time1 is a little ahead (a racing read). */
function ageMs(time1: number, tick: number): number {
  const age = (tick - time1) >>> 0
  return age > 0x80000000 ? 0 : age
}

/**
 * 1000*frames/(time1-time0); null without a valid window, or (with the snapshot's `tick`) when the window ended more
 * than RTSS_STALE_MS ago: RTSS only updates it from the game's Present calls, so a game that stopped presenting would
 * otherwise keep its last rate. Rounded to 0.1.
 */
export function appFps(e: RtssAppEntry, tick?: number): number | null {
  if (!e.time0 || !(e.time1 > e.time0) || !(e.frames > 0)) return null
  if (typeof tick === 'number' && ageMs(e.time1, tick) > RTSS_STALE_MS) return null
  const fps = (1000 * e.frames) / (e.time1 - e.time0)
  if (!Number.isFinite(fps) || fps <= 0 || fps > 100_000) return null
  return Math.round(fps * 10) / 10
}

/**
 * The game's entry: one whose pid is in `pids` (preferring foregroundPid, then the highest fps); else, when `pids` is
 * empty, the foreground entry (foregroundPid). null when none has frames.
 */
export function pickGameEntry(s: RtssSnapshot, pids: readonly number[]): RtssAppEntry | null {
  const fps = (a: RtssAppEntry): number | null => appFps(a, s.tick)
  const measured = s.apps.filter((a) => fps(a) !== null)
  if (!pids.length) {
    if (!s.foregroundPid) return null
    return measured.find((a) => a.pid === s.foregroundPid) ?? null
  }
  const ours = measured.filter((a) => pids.includes(a.pid))
  if (!ours.length) return null
  const fg = s.foregroundPid ? ours.find((a) => a.pid === s.foregroundPid) : undefined
  if (fg) return fg
  return ours.reduce((best, a) => ((fps(a) ?? 0) > (fps(best) ?? 0) ? a : best))
}

/** 'C:\Games\X\Game.exe' -> 'Game.exe' (either slash). */
export function exeBaseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

// eslint-disable-next-line no-control-regex -- control characters cannot be in a file name
const PROFILE_EXE = /^[^\\/:*?"<>|\x00-\x1f]{1,200}\.exe$/i

/** RTSS per-exe profile names PlayOut may write: a bare *.exe file name, no path, no '..', not 'Global'. */
export function isProfileExe(name: string): boolean {
  if (typeof name !== 'string' || !PROFILE_EXE.test(name)) return false
  const stem = name.slice(0, -4)
  // Dots only ('...exe') or a parent reference ('..x.exe') never name a program; nor does a leading space.
  return !/^[.\s]*$/.test(stem) && !stem.includes('..') && !/^\s/.test(name)
}

/** The snapshot as the native host answers it (JSON "null" or the object); null when not a valid snapshot. */
export function parseRtssSnapshot(raw: unknown): RtssSnapshot | null {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const u32 = (x: unknown): number | null =>
    typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 0xffffffff ? x : null
  const version = u32(v.version)
  if (version === null) return null
  const fg = u32(v.foregroundPid)
  const apps: RtssAppEntry[] = []
  for (const item of Array.isArray(v.apps) ? (v.apps as unknown[]) : []) {
    if (!item || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    const pid = u32(a.pid)
    if (!pid) continue
    apps.push({
      pid,
      name: typeof a.name === 'string' ? a.name : '',
      flags: u32(a.flags) ?? 0,
      time0: u32(a.time0) ?? 0,
      time1: u32(a.time1) ?? 0,
      frames: u32(a.frames) ?? 0,
      frameTimeUs: u32(a.frameTimeUs) ?? 0
    })
  }
  const tick = u32(v.tick)
  return { version, foregroundPid: fg ? fg : null, apps, ...(tick !== null ? { tick } : {}) }
}
