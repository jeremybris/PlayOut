import {
  FocusContext,
  ROOT_FOCUS_KEY,
  SpatialNavigation,
  clearLastFocusedChild,
  doesFocusableExist,
  getCurrentFocusKey,
  init,
  navigateByDirection,
  pause,
  resume,
  setFocus,
  setKeyMap,
  updateAllLayouts,
  useFocusable
} from '@noriginmedia/norigin-spatial-navigation'
import type {
  Direction,
  FocusDetails,
  FocusableComponentLayout,
  KeyPressDetails,
  UseFocusableConfig,
  UseFocusableResult
} from '@noriginmedia/norigin-spatial-navigation'

/**
 * The single focus engine: @noriginmedia/norigin-spatial-navigation, initialised once here. Screens import
 * everything focus-related from this module (or from 'input') and never from the Norigin package directly.
 *
 * Norigin's own window key listeners are neutralised (see initFocus): every key and gamepad button goes
 * through input/keyboard.ts / input/gamepad.ts -> dispatchAction, which calls pressArrow / navigateByDirection
 * / pressEnter below. That keeps text fields, modifier keys and the modal layer stack in one place.
 */

/** A key code that no keyboard event ever produces; used to unbind Norigin's built-in key map. */
const UNBOUND = 'PlayOut:unbound'

let initialised = false

/** Initialise the focus engine (idempotent). Called by initInput(); safe to call again. */
export function initFocus(): void {
  if (initialised) return
  initialised = true
  init({
    shouldFocusDOMNode: false,
    shouldUseNativeEvents: true,
    throttle: 0,
    throttleKeypresses: false,
    debug: false,
    visualDebug: false
  })
  setKeyMap({ left: [UNBOUND], right: [UNBOUND], up: [UNBOUND], down: [UNBOUND], enter: [UNBOUND] })
}

/** Activate the focused element (its onEnterPress). What Norigin does for its Enter key. */
export function pressEnter(): void {
  SpatialNavigation.onEnterPress({ pressedKeys: {} })
}

/** Release after pressEnter (onEnterRelease of the focused element). */
export function releaseEnter(): void {
  SpatialNavigation.onEnterRelease()
}

/**
 * Give the focused element first refusal of a direction (its onArrowPress; Slider and SelectField return
 * false to consume left/right). Returns true when the element consumed the press and navigation must not run.
 */
export function pressArrow(direction: Direction): boolean {
  return SpatialNavigation.onArrowPress(direction, { pressedKeys: {} }) === false
}

/** Counterpart of pressArrow for elements that care about releases. */
export function releaseArrow(direction: Direction): void {
  SpatialNavigation.onArrowRelease(direction)
}

/** The focus key of the focused element, or null when nothing is focused. */
export function focusedKey(): string | null {
  const key = getCurrentFocusKey()
  return key ? key : null
}

/** True while the focused element is inside the container with the given focus key. */
export function isFocusWithin(containerFocusKey: string): boolean {
  const key = getCurrentFocusKey()
  if (!key) return false
  return key === containerFocusKey || SpatialNavigation.isDescendantOf(key, containerFocusKey)
}

export {
  FocusContext,
  ROOT_FOCUS_KEY,
  clearLastFocusedChild,
  doesFocusableExist,
  getCurrentFocusKey,
  navigateByDirection,
  pause,
  resume,
  setFocus,
  updateAllLayouts,
  useFocusable
}
export type {
  Direction,
  FocusDetails,
  FocusableComponentLayout,
  KeyPressDetails,
  UseFocusableConfig,
  UseFocusableResult
}
