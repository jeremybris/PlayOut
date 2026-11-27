import { useUiStore } from '../state/ui'
import { dispatchAction } from './actions'

/** Mouse cursor hides this long after the last pointer move while a gamepad drives the UI. */
const CURSOR_HIDE_MS = 2000

let hideTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Where the mouse cursor really is: updated by pointermove events with motion and by mouse pointerdown.
 * Chromium dispatches pointerenter/pointerover boundary events without any physical movement whenever the
 * element under a stationary cursor changes (scrollIntoView, the row stack's translateY), and those must
 * not count as hover.
 */
let lastMouse: { x: number; y: number } | null = null

/** Remember the cursor position of a real mouse event (a move with motion, a button press). */
export function noteMousePosition(event: { clientX: number; clientY: number }): void {
  lastMouse = { x: event.clientX, y: event.clientY }
}

/**
 * True for a mouse pointerenter that happened without the cursor moving: the element slid under a parked
 * cursor, so it is not a hover. The first enter ever seen (the window appeared under a parked cursor:
 * Windows posts a motionless mouse move to the new window) is synthetic too; it records the position so
 * that a later enter elsewhere, which can only come from real motion, counts. A control under a cursor
 * that then really moves gets its hover from that pointermove (useFocusableControl).
 */
export function isSyntheticMouseEnter(event: { clientX: number; clientY: number }): boolean {
  if (lastMouse === null) {
    noteMousePosition(event)
    return true
  }
  return lastMouse.x === event.clientX && lastMouse.y === event.clientY
}

/** True for a mouse pointermove that carries no motion (Chromium's boundary / window-shown moves). */
export function isStationaryMove(event: { movementX: number; movementY: number }): boolean {
  return event.movementX === 0 && event.movementY === 0
}

/** Forget the cursor position (stopPointer, tests). */
export function resetPointerState(): void {
  lastMouse = null
}

function showCursor(): void {
  delete document.documentElement.dataset.cursor
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

function scheduleCursorHide(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (useUiStore.getState().inputMethod === 'gamepad')
      document.documentElement.dataset.cursor = 'hidden'
  }, CURSOR_HIDE_MS)
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerType === 'mouse') {
    // A stationary cursor never switches the input method (the window appearing under it, scrolling).
    if (isStationaryMove(event)) return
    noteMousePosition(event)
    useUiStore.getState().setInputMethod('mouse')
    showCursor()
  } else {
    useUiStore.getState().setInputMethod('touch')
  }
}

function onPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse') {
    noteMousePosition(event)
    useUiStore.getState().setInputMethod('mouse')
    showCursor()
    // Mouse "back" button (button 3) = B.
    if (event.button === 3) {
      event.preventDefault()
      dispatchAction('back', 'mouse')
    }
  } else {
    useUiStore.getState().setInputMethod('touch')
  }
}

function onMouseUp(event: MouseEvent): void {
  // Chromium navigates history on back/forward buttons at mouseup; the renderer has no history to go to.
  if (event.button === 3 || event.button === 4) event.preventDefault()
}

function onContextMenu(event: MouseEvent): void {
  // No browser context menu in a dashboard UI (text fields keep theirs).
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    return
  event.preventDefault()
}

/**
 * Pointer handling: sets the input method from pointerType ('mouse' / 'touch'), maps the mouse back button
 * to B, auto-hides the cursor while the gamepad is in use and tracks the real cursor position so hover
 * handlers can tell a boundary event under a parked cursor from a real hover. Returns the stop function.
 */
export function startPointer(): () => void {
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  window.addEventListener('pointerdown', onPointerDown, { capture: true })
  window.addEventListener('mouseup', onMouseUp, { capture: true })
  window.addEventListener('contextmenu', onContextMenu)
  const unsubscribe = useUiStore.subscribe((state, previous) => {
    if (state.inputMethod === previous.inputMethod) return
    if (state.inputMethod === 'gamepad') scheduleCursorHide()
    else showCursor()
  })
  if (useUiStore.getState().inputMethod === 'gamepad') scheduleCursorHide()
  return () => {
    window.removeEventListener('pointermove', onPointerMove, { capture: true })
    window.removeEventListener('pointerdown', onPointerDown, { capture: true })
    window.removeEventListener('mouseup', onMouseUp, { capture: true })
    window.removeEventListener('contextmenu', onContextMenu)
    unsubscribe()
    showCursor()
    resetPointerState()
  }
}
