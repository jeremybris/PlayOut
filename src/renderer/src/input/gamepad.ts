import type { PlayOutApi } from '@shared/api'
import { PAD_BUTTONS, type PadInfo } from '@shared/overlay'
import { createLog } from '../lib/log'
import { stickScroll, stickScrollTarget } from './stickScroll'
import { currentSettings } from '../state/settings'
import { useUiStore } from '../state/ui'
import { dispatchAction, type Action, type Direction } from './actions'
import { releaseEnter } from './focus'

const log = createLog('gamepad')

/** W3C "standard" mapping button indices. */
export const STANDARD_BUTTONS = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  select: 8,
  start: 9,
  ls: 10,
  rs: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
  guide: 16
} as const

/** Buttons that produce actions on their rising edge. */
const BUTTON_ACTIONS: ReadonlyArray<readonly [index: number, action: Action]> = [
  [STANDARD_BUTTONS.a, 'accept'],
  [STANDARD_BUTTONS.b, 'back'],
  [STANDARD_BUTTONS.x, 'x'],
  [STANDARD_BUTTONS.y, 'y'],
  [STANDARD_BUTTONS.lb, 'lb'],
  [STANDARD_BUTTONS.rb, 'rb'],
  [STANDARD_BUTTONS.lt, 'lt'],
  [STANDARD_BUTTONS.rt, 'rt'],
  [STANDARD_BUTTONS.select, 'select'],
  [STANDARD_BUTTONS.start, 'start']
]

/** Analog buttons (triggers) count as pressed above this value. */
const PRESS_THRESHOLD = 0.5
/** A stick direction fires when the dominant axis passes this... */
const STICK_PRESS = 0.5
/** ...and holds until it drops below this (hysteresis). */
const STICK_RELEASE = 0.35
/** After this many repeats the interval drops to the fast rate. */
const FAST_AFTER_REPEATS = 6
const FAST_REPEAT_MS = 60
const FAST_REPEAT_FULL_DEFLECTION_MS = 40
/** Section jumps (D-pad up / down in the library) repeat no faster than this while held. */
const SECTION_REPEAT_MS = 220
/** Rumble on accept. */
const ACCEPT_RUMBLE_MS = 24
const ACCEPT_RUMBLE_STRENGTH = 0.25

interface PadState {
  buttons: boolean[]
  /** Combined D-pad / left-stick direction currently held. */
  direction: Direction | null
  /** Whether `direction` comes from the D-pad (it wins over the stick). */
  fromDpad: boolean
  /** Stick-only direction, kept separately for hysteresis. */
  stickDirection: Direction | null
  /** Right-stick direction (edge-triggered: no repeat, never moves focus). */
  rightStick: Direction | null
  /** The held right stick's up / down went unhandled: what it scrolls while held (input/stickScroll.ts). */
  rightStickScrolls: HTMLElement | null
  /** When the right stick last scrolled (the next frame scrolls for the time since). */
  rightStickAt: number
  directionSince: number
  lastRepeat: number
  repeats: number
  /** The last press of the held direction was taken as a section jump (slower repeat). */
  sectionJump: boolean
  /** The direction was already held while paused: it never repeats (only a new direction counts). */
  heldThroughPause: boolean
}

const pads = new Map<number, PadState>()
let activeIndex: number | null = null
let frame = 0
let running = false
/** setGamepadPaused: the pads are read (to keep the held state) but nothing is dispatched. */
let paused = false
/**
 * setGamepadNeedsFocus: this window acts on the pads only while it is the active window. Chromium hands the pads to
 * every window, also one behind a game or on another screen, so without this the game's menu presses would also
 * move around (and press A on) PlayOut's own menus, opening its on-screen keyboard over the game.
 */
let needsFocus = false
/**
 * setGamepadActiveElsewhere: the window counts as active although its document lost the focus (the in-app web viewer's
 * page, a view inside the same window, has it once clicked).
 */
let activeElsewhere: (() => boolean) | null = null
/** Whether the last frame dispatched nothing (paused, or this window not active). */
let idle = false
/**
 * After this window becomes the active one again (a game closed, or Windows handed the foreground back for a moment
 * while a game starts), presses are only recorded until this time: a press meant for the game (A on its Exit, or on a
 * dialog it shows while starting) must not land on PlayOut's focused control (Play would start the game again; a
 * text field would open the on-screen keyboard).
 */
let settleUntil = 0
/** How long a window that just became active only records the pads. */
export const ACTIVE_SETTLE_MS = 500
/**
 * Pads whose state was dropped while the window was hidden: their next reading is only recorded (a button held then,
 * A still down from a game's Exit, is not a new press). A pad never seen before is not in here: Chromium shows a pad to
 * a page only with the press that reveals it, and that first press must count.
 */
const forgotten = new Set<number>()

/**
 * Where the pads come from instead of navigator.getGamepads (setGamepadSource): the in-game overlay's offscreen page
 * is never focused and Chromium gives it no pads, so it reads the ones PlayOut's controller reader sends
 * (createOverlayPadSource).
 */
export interface GamepadSource {
  /** The pads right now, at their index (gaps are null), as navigator.getGamepads() returns them. */
  getGamepads(): ReadonlyArray<Gamepad | null>
  /**
   * Changes whenever every pad's state must be forgotten (the overlay opened or closed): the next reading of each pad
   * is only recorded, so buttons still held then (the home combo, the B that closed it) are not new presses.
   */
  epoch(): number
}

/** How often a GamepadSource is read: on a timer, since an offscreen page's animation frames are throttled. */
export const SOURCE_POLL_MS = 16

let source: GamepadSource | null = null
let sourceTimer: ReturnType<typeof setInterval> | null = null
let sourceEpoch: number | null = null

const windowActive = (): boolean =>
  typeof document.hasFocus !== 'function' || document.hasFocus() || !!activeElsewhere?.()

function freshState(): PadState {
  return {
    buttons: [],
    direction: null,
    fromDpad: false,
    stickDirection: null,
    rightStick: null,
    rightStickScrolls: null,
    rightStickAt: 0,
    directionSince: 0,
    lastRepeat: 0,
    repeats: 0,
    sectionJump: false,
    heldThroughPause: false
  }
}

function isPressed(button: GamepadButton | undefined): boolean {
  return !!button && (button.pressed || button.value > PRESS_THRESHOLD)
}

function swapAB(action: Action, swap: boolean): Action {
  if (!swap) return action
  if (action === 'accept') return 'back'
  if (action === 'back') return 'accept'
  return action
}

/** Dominant-axis stick direction with a radial dead zone and press/release hysteresis. */
function stickDirection(
  x: number,
  y: number,
  deadzone: number,
  previous: Direction | null
): Direction | null {
  if (Math.hypot(x, y) < deadzone) return null
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const dominant: Direction = ax >= ay ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up'
  const value = Math.max(ax, ay)
  if (previous && dominant === previous) return value >= STICK_RELEASE ? previous : null
  return value >= STICK_PRESS ? dominant : null
}

function readDirection(
  pad: Gamepad,
  state: PadState,
  deadzone: number
): { direction: Direction | null; deflection: number; fromDpad: boolean } {
  const dpad: Direction | null = isPressed(pad.buttons[STANDARD_BUTTONS.up])
    ? 'up'
    : isPressed(pad.buttons[STANDARD_BUTTONS.down])
      ? 'down'
      : isPressed(pad.buttons[STANDARD_BUTTONS.left])
        ? 'left'
        : isPressed(pad.buttons[STANDARD_BUTTONS.right])
          ? 'right'
          : null
  const x = pad.axes[0] ?? 0
  const y = pad.axes[1] ?? 0
  state.stickDirection = stickDirection(x, y, deadzone, state.stickDirection)
  if (dpad) return { direction: dpad, deflection: 1, fromDpad: true }
  return {
    direction: state.stickDirection,
    deflection: state.stickDirection ? Math.max(Math.abs(x), Math.abs(y)) : 0,
    fromDpad: false
  }
}

/**
 * One press of a held direction. D-pad up / down are offered as section jumps first; a press nobody takes as a
 * jump (outside the library grid, first / last section) moves focus like any direction. Returns whether it jumped.
 */
function pressDirection(direction: Direction, fromDpad: boolean): boolean {
  if (fromDpad && (direction === 'up' || direction === 'down')) {
    if (dispatchAction(direction === 'up' ? 'section-prev' : 'section-next', 'gamepad')) return true
  }
  dispatchAction(direction, 'gamepad')
  return false
}

/**
 * Right stick up / down: edge-triggered actions (Home / Library), never focus movement or repeat. When no screen takes
 * the press, the stick scrolls the menu instead, smoothly for as long as it is held (input/stickScroll.ts).
 */
function pollRightStick(pad: Gamepad, state: PadState, deadzone: number, now: number): void {
  const y = pad.axes[3] ?? 0
  const next = stickDirection(pad.axes[2] ?? 0, y, deadzone, state.rightStick)
  if (next !== state.rightStick) {
    state.rightStick = next
    state.rightStickScrolls = null
    if (next === 'up' || next === 'down') {
      markActive(pad)
      const handled = dispatchAction(next === 'up' ? 'rs-up' : 'rs-down', 'gamepad')
      if (!handled) {
        state.rightStickScrolls = stickScrollTarget()
        state.rightStickAt = now - 16
      }
    }
  }
  if (state.rightStickScrolls && (state.rightStick === 'up' || state.rightStick === 'down')) {
    // Past the dead zone, scaled to 0..1, so a light push scrolls slowly.
    const past = Math.max(0, Math.abs(y) - deadzone) / Math.max(0.01, 1 - deadzone)
    stickScroll(state.rightStickScrolls, Math.sign(y) * past, now - state.rightStickAt)
    state.rightStickAt = now
  }
}

function markActive(pad: Gamepad): void {
  activeIndex = pad.index
  useUiStore.getState().setInputMethod('gamepad')
}

function stateOf(pad: Gamepad): PadState {
  let state = pads.get(pad.index)
  if (!state) {
    state = freshState()
    pads.set(pad.index, state)
  }
  return state
}

/**
 * While paused: record what is held without dispatching anything, so a button or direction still held when the
 * pause ends is not taken as a fresh press (the B that closed the overlay must not also run 'back' here) and a
 * held direction does not start repeating.
 */
function trackPad(pad: Gamepad): void {
  const input = currentSettings().input
  const state = stateOf(pad)
  for (const [index] of BUTTON_ACTIONS) state.buttons[index] = isPressed(pad.buttons[index])
  state.rightStickScrolls = null
  state.rightStick = stickDirection(
    pad.axes[2] ?? 0,
    pad.axes[3] ?? 0,
    input.deadzone,
    state.rightStick
  )
  const { direction, fromDpad } = readDirection(pad, state, input.deadzone)
  state.direction = direction
  state.fromDpad = fromDpad
  state.repeats = 0
  state.sectionJump = false
  state.heldThroughPause = direction !== null
}

function pollPad(pad: Gamepad, now: number): void {
  const input = currentSettings().input
  const state = stateOf(pad)

  for (const [index, action] of BUTTON_ACTIONS) {
    const pressed = isPressed(pad.buttons[index])
    const was = state.buttons[index] ?? false
    if (pressed === was) continue
    state.buttons[index] = pressed
    const mapped = swapAB(action, input.swapAB)
    if (pressed) {
      markActive(pad)
      dispatchAction(mapped, 'gamepad')
      if (mapped === 'accept') rumble(ACCEPT_RUMBLE_MS, ACCEPT_RUMBLE_STRENGTH)
    } else if (mapped === 'accept') {
      releaseEnter()
    }
  }

  pollRightStick(pad, state, input.deadzone, now)

  const { direction, deflection, fromDpad } = readDirection(pad, state, input.deadzone)
  if (direction !== state.direction || fromDpad !== state.fromDpad) {
    state.direction = direction
    state.fromDpad = fromDpad
    state.directionSince = now
    state.lastRepeat = now
    state.repeats = 0
    state.sectionJump = false
    state.heldThroughPause = false
    if (direction) {
      markActive(pad)
      state.sectionJump = pressDirection(direction, fromDpad)
    }
    return
  }
  if (!direction || state.heldThroughPause) return
  if (now - state.directionSince < input.repeatDelayMs) return
  let rate = input.repeatRateMs
  if (state.sectionJump) rate = Math.max(rate, SECTION_REPEAT_MS)
  else if (state.repeats >= FAST_AFTER_REPEATS) {
    rate = Math.min(rate, deflection >= 0.9 ? FAST_REPEAT_FULL_DEFLECTION_MS : FAST_REPEAT_MS)
  }
  if (now - state.lastRepeat >= rate) {
    state.lastRepeat = now
    state.repeats += 1
    const jumped = pressDirection(direction, fromDpad)
    if (state.sectionJump && !jumped) {
      // The held jumps reached the first / last section and fell back to a plain move: start over with the
      // normal delay instead of racing on at the fast rate out of the grid.
      state.directionSince = now
      state.repeats = 0
    }
    state.sectionJump = jumped
  }
}

function readGamepads(): ReadonlyArray<Gamepad | null> {
  if (source) return source.getGamepads()
  return typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
}

function poll(now: number): void {
  if (!running) return
  if (source) {
    const epoch = source.epoch()
    if (epoch !== sourceEpoch) {
      sourceEpoch = epoch
      settleHeld()
      pads.clear()
      forgotten.clear()
    }
  }
  const list = readGamepads()
  // A source's page is never focused (nor visible): the focus gate is for the windows Chromium hands the pads to.
  const gated = needsFocus && !source
  const nowIdle = paused || (gated && !windowActive())
  if (nowIdle && !idle) settleHeld()
  if (!nowIdle && idle && gated && !paused) settleUntil = now + ACTIVE_SETTLE_MS
  idle = nowIdle
  const settling = now < settleUntil
  const seen = new Set<number>()
  for (const pad of list) {
    if (!pad || !pad.connected) continue
    seen.add(pad.index)
    // From a source a pad is not revealed by a press (as in Chromium): its first reading is only recorded.
    if (nowIdle || settling || forgotten.has(pad.index) || (source && !pads.has(pad.index))) {
      trackPad(pad)
      forgotten.delete(pad.index)
    } else pollPad(pad, now)
  }
  if (source) {
    // A source has no disconnect event: a pad gone from its list is forgotten (and is new when it comes back).
    for (const index of [...pads.keys()]) if (!seen.has(index)) pads.delete(index)
    if (activeIndex !== null && !seen.has(activeIndex)) activeIndex = null
    return
  }
  frame = requestAnimationFrame(poll)
}

function onDisconnected(event: GamepadEvent): void {
  pads.delete(event.gamepad.index)
  forgotten.delete(event.gamepad.index)
  if (activeIndex === event.gamepad.index) activeIndex = null
  log.info(`gamepad disconnected: ${event.gamepad.id}`)
}

function onConnected(event: GamepadEvent): void {
  log.info(`gamepad connected: ${event.gamepad.id} (mapping: ${event.gamepad.mapping || 'none'})`)
  if (event.gamepad.mapping !== 'standard')
    log.warn('non-standard mapping; using standard indices anyway')
}

/**
 * Held buttons must not fire phantom releases after the window was hidden: forget every state. Each pad is then read
 * again on its first frame without dispatching (poll), and the window settles once it is visible again.
 */
function onVisibilityChange(): void {
  if (source) return
  if (document.visibilityState === 'hidden') {
    for (const index of pads.keys()) forgotten.add(index)
    pads.clear()
  } else if (needsFocus) settleUntil = performance.now() + ACTIVE_SETTLE_MS
}

/**
 * The window's own focus events, which arrive even when no animation frame runs (a window minimized the moment a game
 * starts may never draw another frame before it loses the focus): losing the focus ends held repeats at once, and
 * getting it back starts the settle.
 */
function onWindowBlur(): void {
  if (!needsFocus || source || activeElsewhere?.()) return
  settleHeld()
  idle = true
}

function onWindowFocus(): void {
  if (needsFocus && !source) settleUntil = performance.now() + ACTIVE_SETTLE_MS
}

/**
 * Start polling navigator.getGamepads() on every animation frame (a GamepadSource every SOURCE_POLL_MS instead) and
 * dispatch actions with edge detection and direction repeat (settings.input.repeatDelayMs / repeatRateMs). Returns
 * the stop function.
 */
export function startGamepadPolling(): () => void {
  if (running) return stopGamepadPolling
  running = true
  window.addEventListener('gamepadconnected', onConnected)
  window.addEventListener('gamepaddisconnected', onDisconnected)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  if (source) {
    sourceEpoch = null
    sourceTimer = setInterval(() => poll(performance.now()), SOURCE_POLL_MS)
  } else frame = requestAnimationFrame(poll)
  return stopGamepadPolling
}

function stopGamepadPolling(): void {
  if (!running) return
  running = false
  cancelAnimationFrame(frame)
  if (sourceTimer) clearInterval(sourceTimer)
  sourceTimer = null
  window.removeEventListener('gamepadconnected', onConnected)
  window.removeEventListener('gamepaddisconnected', onDisconnected)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('focus', onWindowFocus)
  pads.clear()
  idle = false
  settleUntil = 0
  forgotten.clear()
}

/**
 * Pause or resume dispatching gamepad actions in this window (PlayOut's main window while the overlay is open over
 * it: both windows see the same pads). Pausing ends any held repeat and an A press in progress; while paused the
 * pads are still read, so buttons and directions held across the change do not fire when it resumes.
 */
export function setGamepadPaused(next: boolean): void {
  if (paused === next) return
  paused = next
  if (next) settleHeld()
}

/**
 * Act on the pads only while this window is the active one (PlayOut's main window; the overlay window is on screen
 * only while it is open). Losing the focus ends held repeats like a pause, and buttons held when it comes back are
 * not taken as fresh presses.
 */
export function setGamepadNeedsFocus(next: boolean): void {
  needsFocus = next
}

/**
 * While set, the focus gate also passes when `active()` is true: PlayOut's window is the foreground one but a view
 * inside it has the keyboard focus (the in-app web viewer's page, WebViewer.tsx). null: the document's focus only.
 */
export function setGamepadActiveElsewhere(active: (() => boolean) | null): void {
  activeElsewhere = active
}

/**
 * Read the pads from `next` instead of navigator.getGamepads() (null: back to the browser's). The focus and
 * visibility gates do not apply to a source (its page is never focused); everything else (repeat, settle, pause) is
 * the same. Polling restarts when it is running.
 */
export function setGamepadSource(next: GamepadSource | null): void {
  if (source === next) return
  const wasRunning = running
  if (wasRunning) stopGamepadPolling()
  source = next
  if (wasRunning) startGamepadPolling()
}

/**
 * A pad as the controller reader reports it (PadInfo), shaped as a standard-mapping Gamepad: PadButton bit i is
 * button i (the two orders are the same), the triggers' values come from PadInfo.triggers when sent, and the sticks
 * from PadInfo.axes (already -1..1, up negative).
 */
export function gamepadFromPad(info: PadInfo, index: number, timestamp = 0): Gamepad {
  const buttons = PAD_BUTTONS.map((_, i) => {
    const held = (info.buttons & (1 << i)) !== 0
    const trigger =
      i === STANDARD_BUTTONS.lt
        ? info.triggers?.[0]
        : i === STANDARD_BUTTONS.rt
          ? info.triggers?.[1]
          : undefined
    const value = trigger ?? (held ? 1 : 0)
    const pressed = held || value > PRESS_THRESHOLD
    return { pressed, touched: pressed || value > 0, value } as GamepadButton
  })
  return {
    index,
    id: info.name,
    mapping: 'standard',
    connected: true,
    timestamp,
    axes: info.axes ? [...info.axes] : [0, 0, 0, 0],
    buttons,
    vibrationActuator: null
  } as unknown as Gamepad
}

/**
 * The in-game overlay's pads (docs/home-overlay.md, "In-game overlay"): PlayOut sends them with 'overlay:pad' while
 * the overlay is open. Each pad id keeps its index; opening or closing the overlay ('overlay:state') starts a new
 * epoch, so the buttons held then are not taken as presses. Returns the source with the function that stops
 * listening.
 */
export function createOverlayPadSource(
  events: Pick<PlayOutApi, 'on'>
): GamepadSource & { dispose(): void } {
  const indexOf = new Map<string, number>()
  let list: Array<Gamepad | null> = []
  let epoch = 0
  let open: boolean | null = null
  const offPads = events.on('overlay:pad', ({ pads: infos }) => {
    const next: Array<Gamepad | null> = []
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    for (const info of infos) {
      let index = indexOf.get(info.id)
      if (index === undefined) {
        index = indexOf.size
        indexOf.set(info.id, index)
      }
      while (next.length < index) next.push(null)
      next[index] = gamepadFromPad(info, index, now)
    }
    list = next
  })
  const offState = events.on('overlay:state', (state) => {
    // Only the in-game overlay's opens and closes count (this source serves the in-game page).
    const now = state.open && state.ingame === true
    if (now === open) return
    open = now
    epoch += 1
    list = []
  })
  return {
    getGamepads: () => list,
    epoch: () => epoch,
    dispose() {
      offPads()
      offState()
    }
  }
}

/** End any held repeat and an A press in progress (dispatching stops). */
function settleHeld(): void {
  for (const state of pads.values()) {
    if (state.buttons[STANDARD_BUTTONS.a] || state.buttons[STANDARD_BUTTONS.b]) releaseEnter()
    state.direction = null
    state.repeats = 0
    state.sectionJump = false
  }
}

/** Whether setGamepadPaused(true) is in effect. */
export function isGamepadPaused(): boolean {
  return paused
}

/** The most recently used gamepad, if still connected. */
export function activeGamepad(): Gamepad | null {
  if (activeIndex === null) return null
  if (!source && typeof navigator.getGamepads !== 'function') return null
  const pad = readGamepads()[activeIndex]
  return pad && pad.connected ? pad : null
}

/**
 * Vibrate the active gamepad for `ms` at `strength` (0..1) when settings.input.vibration is on.
 * No-op without a haptic actuator.
 */
export function rumble(ms = ACCEPT_RUMBLE_MS, strength = ACCEPT_RUMBLE_STRENGTH): void {
  if (!currentSettings().input.vibration) return
  const pad = activeGamepad()
  const actuator = (pad?.vibrationActuator ?? null) as GamepadHapticActuator | null
  if (!actuator || typeof actuator.playEffect !== 'function') return
  const magnitude = Math.min(1, Math.max(0, strength))
  actuator
    .playEffect('dual-rumble', {
      duration: ms,
      startDelay: 0,
      strongMagnitude: magnitude,
      weakMagnitude: magnitude
    })
    .catch((err) => log.warn('rumble failed', err))
}
