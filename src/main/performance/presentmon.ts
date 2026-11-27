import type { ResolvedDownload } from '../emulator-setup/types'

/**
 * PresentMon (Intel's GameTechDev/PresentMon console application, MIT): what the power helper runs to measure a
 * game's frame rate for Dynamic TDP. It reads the DXGI / D3D9 / Vulkan present events from ETW, which needs
 * administrator rights; the helper runs as SYSTEM, so PlayOut never elevates for it.
 *
 * Pinned: one release, one asset, its SHA-256 (from the GitHub release's own digest). The install downloads it into
 * PlayOut's cache, the elevated install copies it into the admin-only helper folder as PresentMon.exe and checks the
 * hash there, and the helper checks the hash again (with the file open, deny-write) before every start. Updating it =
 * changing these constants (the helper.ps1 text changes with them, so the install state turns 'outdated' and the
 * next install brings the new copy).
 */
export const PRESENTMON_VERSION = 'v2.6.0'
export const PRESENTMON_DOWNLOAD: ResolvedDownload = {
  version: PRESENTMON_VERSION,
  url: 'https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe',
  fileName: 'PresentMon-2.6.0-x64.exe',
  sha256: 'b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af',
  size: 980320
}

/** The name the copy has in the helper folder. */
export const PRESENTMON_FILE = 'PresentMon.exe'

/** The ETW session the helper's PresentMon uses (stopped first if a crashed run left it behind). */
export const PRESENTMON_SESSION = 'PlayOutFps'

/**
 * The command line (README-ConsoleApplication.md of v2.6.0): CSV rows on stdout only, no console table, a session of
 * its own that replaces a stale one, and no GPU, input or display tracking (only the present-to-present interval is
 * used, so the cheapest capture). Every process is captured (--process_id takes one pid, a game may present from a
 * child); the helper keeps the rows of the pids it was given.
 */
export const PRESENTMON_ARGS = [
  '--output_stdout',
  '--no_console_stats',
  '--session_name',
  PRESENTMON_SESSION,
  '--stop_existing_session',
  '--no_track_gpu',
  '--no_track_input',
  '--no_track_display'
]

/** The rolling window the frame rate is measured over, ms. */
export const FPS_WINDOW_MS = 1500

/** A pid needs at least this many presents in the window to count (a burst of a few is not a frame rate). */
export const FPS_MIN_FRAMES = 5

/** The CSV columns used (matched case-insensitively: 1.x wrote msBetweenPresents, 2.x MsBetweenPresents). */
export const PID_COLUMN = 'ProcessID'
export const INTERVAL_COLUMN = 'MsBetweenPresents'

/**
 * The TypeScript twin of the helper's C# FpsMeter (csharp.ts): parses PresentMon's CSV stream and reports the frame
 * rate of the pid with the most presents in the last FPS_WINDOW_MS (ties: the higher rate), counting only pids with
 * at least FPS_MIN_FRAMES presents there, so a launcher or overlay's short burst never stands in for the game.
 * helper-csharp.test.ts feeds both the same lines.
 */
export class FpsMeter {
  private pidCol = -1
  private msCol = -1
  private headerLength = 0
  private readonly frames = new Map<number, { at: number; ms: number }[]>()

  constructor(private readonly pids: ReadonlySet<number>) {}

  /** One line of PresentMon's stdout, received at `now` (ms). */
  push(line: string, now: number): void {
    const fields = line.split(',')
    if (this.pidCol < 0) {
      const names = fields.map((f) => f.trim().toLowerCase())
      const pid = names.indexOf(PID_COLUMN.toLowerCase())
      const ms = names.indexOf(INTERVAL_COLUMN.toLowerCase())
      if (pid >= 0 && ms >= 0) {
        this.pidCol = pid
        this.msCol = ms
        this.headerLength = fields.length
      }
      return
    }
    // The application name (the first column) is the only one that can hold a comma.
    const shift = fields.length - this.headerLength
    if (shift < 0) return
    const at = (i: number): string => fields[i > 0 ? i + shift : i] ?? ''
    const pid = Number.parseInt(at(this.pidCol).trim(), 10)
    if (!this.pids.has(pid)) return
    const ms = Number(at(this.msCol).trim())
    if (!Number.isFinite(ms) || ms <= 0 || ms > 5000) return
    let list = this.frames.get(pid)
    if (!list) this.frames.set(pid, (list = []))
    list.push({ at: now, ms })
    this.prune(now)
  }

  private prune(now: number): void {
    for (const list of this.frames.values()) {
      while (list.length && now - list[0].at > FPS_WINDOW_MS) list.shift()
    }
  }

  /** The busiest pid's rate at `now`, or null when no pid has FPS_MIN_FRAMES frames in the window. */
  read(now: number): { fps: number; frameTimeMs: number; pid: number; frames: number } | null {
    this.prune(now)
    let best: { fps: number; frameTimeMs: number; pid: number; frames: number } | null = null
    for (const [pid, list] of this.frames) {
      if (list.length < FPS_MIN_FRAMES) continue
      const sum = list.reduce((s, f) => s + f.ms, 0)
      const frameTimeMs = sum / list.length
      const fps = 1000 / frameTimeMs
      const busier =
        !best || list.length > best.frames || (list.length === best.frames && fps > best.fps)
      if (busier) best = { fps, frameTimeMs, pid, frames: list.length }
    }
    return best
  }
}
