import type { OverlayState } from '../../shared/overlay'
import type { ForegroundWindow, PauseResult, Rect } from '../native-host/native-ops'

/**
 * Pure pieces of the overlay window (docs/home-overlay.md, "Overlay window behaviour"): which window the overlay
 * opened over, which monitor it covers and the state both windows are told about. Kept free of Electron so they can
 * be tested without a display.
 */

// The native host's own types (rectangles in physical pixels; monitor may be null), so its foreground() result is
// passed in as it is.
export type { ForegroundWindow, Rect }

/** The window the overlay opened over, which gets the foreground back when it closes. */
export interface OverlayTarget {
  hwnd: string
  /** The process that owns the window (0 when unknown). */
  pid: number
  /** An exclusive full-screen game minimizes when the overlay takes the foreground, so it is restored on close. */
  exclusive: boolean
  /** Its exe name, without the folder. */
  program: string
}

/** The part of Electron's `screen` the overlay uses. `screenToDipRect` exists on Windows only. */
export interface OverlayScreen {
  getDisplayMatching(rect: Rect): { bounds: Rect }
  getPrimaryDisplay(): { bounds: Rect }
  screenToDipRect?: (window: null, rect: Rect) => Rect
}

/** "C:\Games\x\game.exe" -> "game.exe" (the host may report a full path or a bare name). */
export function exeName(exe: string): string {
  const parts = exe.split(/[\\/]/)
  return parts[parts.length - 1] ?? exe
}

/**
 * The window to give the foreground back to on close: none when there is no foreground window, or when it is
 * PlayOut's own (the overlay itself, or the main window: hiding the overlay already lands there).
 */
export function overlayTarget(
  fg: ForegroundWindow | null,
  ownHwnd: string | null,
  isPlayOutWindow: (hwnd: string) => boolean
): OverlayTarget | null {
  if (!fg || !fg.hwnd) return null
  if (fg.hwnd === ownHwnd || isPlayOutWindow(fg.hwnd)) return null
  return { hwnd: fg.hwnd, pid: fg.pid, exclusive: fg.exclusive, program: exeName(fg.exe) }
}

/**
 * Programs never paused under the overlay: Windows' own shell and system windows, Steam (it runs the game's overlay
 * and controller support), PlayOut and other launchers' helpers. Pausing one of them could freeze the desktop.
 */
const NEVER_PAUSE = new Set([
  'explorer.exe',
  'dwm.exe',
  'applicationframehost.exe',
  'searchhost.exe',
  'searchapp.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
  'textinputhost.exe',
  'lockapp.exe',
  'systemsettings.exe',
  'taskmgr.exe',
  'csrss.exe',
  'winlogon.exe',
  'steam.exe',
  'steamwebhelper.exe',
  'gamebar.exe',
  'gamebarftserver.exe',
  'playout.exe',
  'electron.exe',
  'whservice.exe',
  'winhanced.exe',
  'winhanced.usersessionhost.exe',
  'winhancedkeyboard.exe'
])

/**
 * Windows' shell, Steam, PlayOut, Winhanced and the like (the programs never paused): never a game, so the overlay's
 * frame limit and performance overlay never act on one (a RivaTuner limit on explorer.exe would outlive PlayOut).
 */
export function isShellProgram(program: string): boolean {
  return NEVER_PAUSE.has(program.trim().toLowerCase())
}

/** Whether the overlay may pause the program it opened over. */
export function pausable(target: OverlayTarget | null, ownPid: number): boolean {
  if (!target || !target.pid || target.pid <= 4 || target.pid === ownPid) return false
  const name = target.program.toLowerCase()
  return name !== '' && !NEVER_PAUSE.has(name)
}

/**
 * Anti-cheat services: a game running under one of them is never suspended, by the overlay's pause or for sleep (it
 * could be flagged or kicked).
 */
export const ANTI_CHEAT: ReadonlySet<string> = new Set([
  'easyanticheat.exe',
  'easyanticheat_eos.exe',
  'beservice.exe',
  'beservice_x64.exe',
  'vgc.exe',
  'faceitservice.exe',
  'faceit.exe',
  'eaanticheat.gameservice.exe',
  'eaanticheat.gameservicelauncher.exe',
  'pnkbstra.exe',
  'pnkbstrb.exe',
  'xigncode.exe',
  'gameguard.exe',
  'ricochet.exe'
])

/** The anti-cheat service among the running programs (lower-case image names), or null when none runs. */
export function antiCheatRunning(images: ReadonlySet<string>): string | null {
  return [...ANTI_CHEAT].find((name) => images.has(name)) ?? null
}

/**
 * Whether a resume needs no retry: it worked, or the process is gone (another process now has the id: 'gone'; or it
 * cannot be opened: 'access', which for a process PlayOut opened to pause it means it has ended). Anything else (the
 * host timed out or restarted) leaves the record, so the next close, quit or start tries again.
 */
export function resumeSettled(result: PauseResult): boolean {
  return result.ok || result.error === 'gone' || result.error === 'access'
}

/**
 * The overlay's bounds in DIP: the whole of the foreground window's monitor, else the primary display. The native
 * rectangle is in physical pixels; it is converted to DIP first (Windows) and then snapped to the matching display's
 * own bounds, so rounding in the conversion never leaves a 1 px gap or spills onto the next monitor.
 */
export function overlayBounds(screen: OverlayScreen, fg: ForegroundWindow | null): Rect {
  // The monitor when the host could read it, else the window itself (its display is matched below).
  const monitor = [fg?.monitor?.rect, fg?.rect].find((r) => !!r && r.width > 0 && r.height > 0)
  if (!monitor) return screen.getPrimaryDisplay().bounds
  let dip = monitor
  if (typeof screen.screenToDipRect === 'function') {
    try {
      dip = screen.screenToDipRect(null, monitor)
    } catch {
      /* keep physical: right on 100 % scaling, near enough to pick the display otherwise */
    }
  }
  try {
    return screen.getDisplayMatching(dip).bounds
  } catch {
    return screen.getPrimaryDisplay().bounds
  }
}

/**
 * The state after opening. A running PlayOut game is the game the overlay opened over; otherwise the foreground
 * program's exe is named (nothing when the overlay opened over PlayOut itself).
 */
export function openedState(
  target: OverlayTarget | null,
  running: { gameId: string } | null
): OverlayState {
  if (running?.gameId) return { open: true, gameId: running.gameId }
  if (target) return { open: true, program: target.program }
  return { open: true }
}

export const CLOSED_STATE: OverlayState = Object.freeze({ open: false })

/** Same state, so an unchanged state is not broadcast twice. */
export function sameState(a: OverlayState, b: OverlayState): boolean {
  return (
    a.open === b.open &&
    a.gameId === b.gameId &&
    a.program === b.program &&
    !!a.paused === !!b.paused
  )
}
