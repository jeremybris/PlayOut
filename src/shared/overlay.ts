/**
 * The home button, the in-game overlay and what it controls (docs/home-overlay.md): shared between the main process,
 * the main window and the overlay window.
 */

/** Controller buttons, in the bit order the native host reports them (a = bit 0 … guide = bit 16). */
export const PAD_BUTTONS = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'lt',
  'rt',
  'view',
  'menu',
  'ls',
  'rs',
  'up',
  'down',
  'left',
  'right',
  'guide'
] as const
export type PadButton = (typeof PAD_BUTTONS)[number]

/** How each button is shown (Xbox names; the PS names follow in parentheses where they differ). */
export const PAD_BUTTON_LABELS: Record<PadButton, string> = {
  a: 'A',
  b: 'B',
  x: 'X',
  y: 'Y',
  lb: 'LB',
  rb: 'RB',
  lt: 'LT',
  rt: 'RT',
  view: 'View',
  menu: 'Menu',
  ls: 'Left stick',
  rs: 'Right stick',
  up: 'D-pad up',
  down: 'D-pad down',
  left: 'D-pad left',
  right: 'D-pad right',
  guide: 'Home (Guide / PS)'
}

export function buttonsOf(mask: number): PadButton[] {
  return PAD_BUTTONS.filter((_, i) => (mask & (1 << i)) !== 0)
}

export function maskOf(buttons: readonly PadButton[]): number {
  return buttons.reduce((m, b) => m | (1 << PAD_BUTTONS.indexOf(b)), 0)
}

/** A connected controller as the native host sees it. */
export interface PadInfo {
  /** 'xinput:0'…'xinput:3', or 'sdl:<instance id>'. */
  id: string
  name: string
  /** Buttons held right now (PadButton bits). */
  buttons: number
  /**
   * Sticks and triggers, for the in-game overlay's navigation (it gets no focus, so it cannot read the pads itself):
   * [leftX, leftY, rightX, rightY] in -1..1 (up is negative, as the browser Gamepad API), and [leftTrigger,
   * rightTrigger] in 0..1. Absent from a reader that does not send them.
   */
  axes?: [number, number, number, number]
  triggers?: [number, number]
}

/** The pads as the in-game overlay sees them ('overlay:pad', sent only while it is open). */
export interface OverlayPadState {
  pads: PadInfo[]
}

/** The home button's state (Settings › Controls). */
export interface HomeButtonStatus {
  enabled: boolean
  /** The controller reader: 'starting', 'running', or 'unavailable' (with why). */
  reader: { state: 'starting' | 'running' | 'unavailable'; message?: string }
  pads: PadInfo[]
  /** Steam's "Guide button focuses Steam" and in-game overlay settings: what PlayOut did about them. */
  steam: OverrideStatus
  /** Xbox Game Bar's controller button. */
  gameBar: OverrideStatus
  /** Another program using the same buttons (Winhanced's View + Menu), in one sentence; absent when none. */
  clash?: string
}

export interface OverrideStatus {
  /**
   * 'off': the override is not wanted (setting off, or the combo has no Guide); 'applied': PlayOut changed it and
   * will put it back; 'already': it was already off; 'missing': the program is not installed; 'pending': waiting
   * (Steam closing); 'error': it could not be changed (see message).
   */
  state: 'off' | 'applied' | 'already' | 'missing' | 'pending' | 'error'
  message?: string
}

/** While Settings records a new combo: the buttons held so far and whether the capture finished. */
export interface ComboCaptureEvent {
  held: PadButton[]
  /** The combo recorded (every button released after holding these), or absent while still recording. */
  done?: PadButton[]
}

export type PowerProfileId = 'silent' | 'balanced' | 'performance' | 'custom'
export const POWER_PROFILE_IDS: PowerProfileId[] = ['silent', 'balanced', 'performance', 'custom']

/**
 * What the overlay's Power section can put in effect: a profile, or Dynamic TDP (the power helper changes the watts
 * to hold a frame rate; docs/home-overlay.md, Dynamic TDP). Dynamic needs the helper (PerformanceStatus.helper).
 */
export type PowerChoice = PowerProfileId | 'dynamic'
export const POWER_CHOICES: PowerChoice[] = [...POWER_PROFILE_IDS, 'dynamic']

/** Dynamic TDP's target frame rate: range, default and the overlay's presets. */
export const DYNAMIC_FPS = { min: 20, max: 240, default: 60 } as const
export const DYNAMIC_FPS_PRESETS: readonly number[] = [30, 40, 45, 60, 90, 120]

export type WindowsPowerMode = 'efficiency' | 'balanced' | 'performance'

export interface PowerProfileConfig {
  /** Windows power mode while the profile is on. */
  powerMode: WindowsPowerMode
  /** CPU maximum state, 5-100 %. */
  cpuMaxPercent: number
  cpuBoost: boolean
  /** Sustained power limit in watts (PL1 / STAPM), with the power helper; null leaves it. */
  watts: number | null
  /** Short boost limit in watts (PL2 / fast), with the power helper; null leaves it. */
  boostWatts: number | null
}

/** The watts backend (the elevated power helper). */
export interface WattsBackendStatus {
  /**
   * 'unsupported': this CPU or PC has no supported method; 'not-installed': the helper can be installed (one admin
   * prompt); 'ready': installed and answering; 'error': installed but failing (see message).
   */
  state: 'unsupported' | 'not-installed' | 'ready' | 'error'
  /** The method: 'ryzenadj' (AMD), 'intel-msr' (Intel through PawnIO), 'asus-wmi' (ASUS laptops). */
  method?: string
  cpu?: string
  /** Allowed range for this PC, watts. */
  minWatts?: number
  maxWatts?: number
  /** What the CPU runs at now, when the backend can read it. */
  currentWatts?: number
  /** The power helper's protocol version (helper methods, when it answered). */
  helperVersion?: number
  message?: string
}

/**
 * The power helper for Dynamic TDP: 'ready' = installed, answering with a watts method (Intel MSR or Ryzen SMU) and
 * new enough to measure frame rates; 'outdated' = installed but needs an update (one administrator prompt);
 * 'missing' = can be installed; 'none' = not on this PC (no helper method, ASUS firmware watts, watts turned off, or
 * not answering).
 */
export type PowerHelperState = 'ready' | 'outdated' | 'missing' | 'none'

/** What Dynamic TDP is doing. */
export interface DynamicTdpStatus {
  targetFps: number
  /**
   * 'idle': no game runs (Windows keeps its own watts); 'measuring': waiting for frames; 'holding': on target;
   * 'raising' / 'lowering': just changed the watts; 'settling': waiting for a change to show; 'plateau': more watts
   * gave no more frames, so it stopped climbing; 'max' / 'min': at the end of the range; 'no-fps': no frames measured
   * (a safe middle value is used).
   */
  state:
    | 'idle'
    | 'measuring'
    | 'holding'
    | 'raising'
    | 'lowering'
    | 'settling'
    | 'plateau'
    | 'max'
    | 'min'
    | 'no-fps'
  /** The measured frame rate (smoothed), when frames are coming. */
  fps?: number
  frameTimeMs?: number
  /** The sustained limit Dynamic TDP set, watts. */
  watts?: number
}

export interface PerformanceStatus {
  /** The profile (or Dynamic TDP) in effect, or null when PlayOut left Windows as it is. */
  active: PowerChoice | null
  /** Why it is in effect: the running game's profile, the default, or chosen in the overlay. */
  source: 'game' | 'default' | 'manual' | null
  /** The running game, when one is. */
  gameId?: string
  /** The running game's own profile, when it has one. */
  gameProfile?: PowerChoice
  /** The running game's own Dynamic TDP target, when it has one. */
  gameTargetFps?: number
  watts: WattsBackendStatus
  /** Whether Dynamic TDP is available (absent: not known yet, treated as 'none'). */
  helper?: PowerHelperState
  /** Dynamic TDP's readout while it is the choice in effect. */
  dynamic?: DynamicTdpStatus
  /** The last apply's problem, if any. */
  error?: string
}

export interface DisplayMode {
  width: number
  height: number
  hz: number
}

export interface DisplayStatus {
  /** The monitor the overlay is on (the game's). */
  name: string
  current: DisplayMode
  modes: DisplayMode[]
}

export type MediaAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous'

/** What Windows is playing (the current media session), or null for nothing. */
export interface MediaSession {
  /** The app (its AppUserModelId: 'Spotify.exe', a browser…). */
  app: string
  title: string
  artist: string
  album: string
  status: 'playing' | 'paused' | 'stopped' | 'other'
  /** Album art as a data: URL, when the app shares it. */
  art?: string
  canNext: boolean
  canPrevious: boolean
}

export interface MusicTrack {
  /** Path relative to the music folder, forward slashes. */
  path: string
  title: string
  /** The folder it is in (often the artist or album). */
  folder: string
}

export interface MusicLibrary {
  folder: string | null
  tracks: MusicTrack[]
}

/** The overlay window's state, for both windows. */
export interface OverlayState {
  open: boolean
  /** The game the overlay opened over (PlayOut's game, when it is one). */
  gameId?: string
  /** The foreground program it opened over (its exe name), when not a PlayOut game. */
  program?: string
  /** That program is paused while the overlay is open (Settings › Controls › Pause the game). */
  paused?: boolean
  /** The overlay is drawn inside the game (the in-game overlay), not as PlayOut's overlay window. */
  ingame?: boolean
}
