import { api } from '../api/client'
import { createLog } from '../lib/log'
import { useUiStore } from '../state/ui'
import { dispatchAction, type Action, type Direction } from './actions'
import { getCurrentFocusKey, releaseEnter } from './focus'

const log = createLog('keyboard')

const DIRECTION_KEYS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

/**
 * Keyboard mapping (design spec 6.5):
 * arrows = directions, Enter/Space = accept, Escape/Backspace = back, Tab/Shift+Tab = next/previous section
 * (rb/lb), [ ] and Q E = lb/rb, PageUp/PageDown = lt/rt (sort / filters), F = x (favourite), ContextMenu = y
 * (game options), / Ctrl+F F3 F1 = select (search), F10/Ctrl+, = start (settings), Ctrl+Up/Down = previous / next
 * library section (the gamepad's D-pad up / down), F11 = fullscreen toggle.
 */
export function actionForKey(event: KeyboardEvent): Action | null {
  const modifier = event.ctrlKey || event.metaKey || event.altKey
  const direction = DIRECTION_KEYS[event.key]
  if (direction) {
    if (event.ctrlKey && !event.altKey && (direction === 'up' || direction === 'down'))
      return direction === 'up' ? 'section-prev' : 'section-next'
    return modifier ? null : direction
  }
  switch (event.key) {
    case 'Enter':
    case ' ':
      return modifier ? null : 'accept'
    case 'Escape':
    case 'Backspace':
    case 'BrowserBack':
      return 'back'
    case 'Tab':
      return event.shiftKey ? 'lb' : 'rb'
    case '[':
      return 'lb'
    case ']':
      return 'rb'
    case 'q':
    case 'Q':
      return modifier ? null : 'lb'
    case 'e':
    case 'E':
      return modifier ? null : 'rb'
    case 'PageUp':
      return 'lt'
    case 'PageDown':
      return 'rt'
    case 'f':
    case 'F':
      if (event.ctrlKey) return 'select'
      return modifier ? null : 'x'
    case '/':
    case 'F3':
      return 'select'
    case 'ContextMenu':
      return 'y'
    case 'F10':
      return 'start'
    case ',':
      return event.ctrlKey ? 'start' : null
    case 'F1':
      return 'select'
    default:
      return null
  }
}

/**
 * The direction a key pressed inside a single-line text input hands to the focus engine: ArrowUp/ArrowDown
 * without a modifier (design 6.2 "arrows move"; a single-line input has no use for them). Left/Right,
 * typing and Backspace stay with the input.
 */
export function editableLeaveDirection(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): Direction | null {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  return event.key === 'ArrowUp' ? 'up' : 'down'
}

/** True for elements that take typed text; their keys belong to the element, not to the focus engine. */
export function isEditable(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement) {
    const type = target.type
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(
      type
    )
  }
  return target instanceof HTMLTextAreaElement || target.isContentEditable
}

/**
 * Leave a text input in the given direction: blur it and let the focus engine move. When nothing lies in
 * that direction (an empty search result grid) the engine's focus stays on the field and the input gets
 * the caret back, so the user is never stranded on a blurred field. Navigation resolves in microtasks, so
 * the check runs on the next macrotask.
 */
export function leaveEditable(input: HTMLElement, direction: Direction): void {
  const before = getCurrentFocusKey()
  input.blur()
  useUiStore.getState().setInputMethod('keyboard')
  dispatchAction(direction, 'keyboard')
  setTimeout(() => {
    if (getCurrentFocusKey() === before && input.isConnected && document.activeElement !== input)
      input.focus()
  }, 0)
}

function toggleFullscreen(): void {
  api
    .isFullscreen()
    .then((fullscreen) => api.setFullscreen(!fullscreen))
    .catch((err) => log.error('fullscreen toggle failed', err))
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'F11') {
    // Inside Electron the main window intercepts F11 before the renderer sees it; this path serves the browser mock.
    event.preventDefault()
    toggleFullscreen()
    return
  }
  if (isEditable(event.target)) {
    // Up/Down leave a single-line input for the focus engine (textareas keep them for their lines);
    // Escape leaves the text field and returns control to the focus engine; everything else is typing.
    const direction =
      event.target instanceof HTMLInputElement ? editableLeaveDirection(event) : null
    if (direction) {
      event.preventDefault()
      leaveEditable(event.target, direction)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.target.blur()
    }
    return
  }
  const action = actionForKey(event)
  if (!action) return
  if (event.repeat && !(action in DIRECTION_KEYS_SET)) return
  event.preventDefault()
  useUiStore.getState().setInputMethod('keyboard')
  dispatchAction(action, 'keyboard')
}

const DIRECTION_KEYS_SET: Record<string, true> = { up: true, down: true, left: true, right: true }

function onKeyUp(event: KeyboardEvent): void {
  if (isEditable(event.target)) return
  if (event.key === 'Enter' || event.key === ' ') releaseEnter()
}

/**
 * The window lost the focus (a game started, or another program came in front): a text field PlayOut was typing in
 * lets go of it. Otherwise Chromium gives that field the focus back when the window returns, and on a touchscreen PC
 * that asks Windows for its touch keyboard (Winhanced shows its own), which then pops up as a game closes. The focus
 * engine still marks the field; activating it focuses it again.
 */
export function onWindowBlurReleaseText(): void {
  const active = document.activeElement
  if (isEditable(active)) active.blur()
}

/** Install the window key listeners (capture phase). Returns the stop function. */
export function startKeyboard(): () => void {
  window.addEventListener('keydown', onKeyDown, { capture: true })
  window.addEventListener('keyup', onKeyUp, { capture: true })
  window.addEventListener('blur', onWindowBlurReleaseText)
  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true })
    window.removeEventListener('keyup', onKeyUp, { capture: true })
    window.removeEventListener('blur', onWindowBlurReleaseText)
  }
}
