import { initFocus } from './focus'
import { startGamepadPolling } from './gamepad'
import { startKeyboard } from './keyboard'
import { startPointer } from './pointer'

/**
 * Initialise every input source once: the focus engine, keyboard, pointer and gamepad polling.
 * Returns a function that stops them all (App calls it on unmount).
 */
export function initInput(): () => void {
  initFocus()
  const stops = [startKeyboard(), startPointer(), startGamepadPolling()]
  return () => {
    for (const stop of stops) stop()
  }
}

export * from './actions'
export * from './focus'
export {
  STANDARD_BUTTONS,
  activeGamepad,
  isGamepadPaused,
  rumble,
  setGamepadNeedsFocus,
  setGamepadPaused,
  startGamepadPolling
} from './gamepad'
export { actionForKey, isEditable, startKeyboard } from './keyboard'
export { startPointer } from './pointer'
