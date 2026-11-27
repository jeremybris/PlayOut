import type { PlayOutApi } from '@shared/api'
import { createLog } from '../lib/log'
import { setGamepadPaused } from './gamepad'

const log = createLog('gamepad')

/**
 * PlayOut's main window: no gamepad actions while the overlay is open. The overlay window takes focus over PlayOut,
 * but Chromium still hands the pads to the visible main window under it, so A / B / the d-pad would act in both.
 * Follows 'overlay:state' and starts from getOverlayState(); returns the function that stops following (and
 * resumes the pad).
 */
export function pauseGamepadWhileOverlayOpen(
  source: Pick<PlayOutApi, 'on' | 'getOverlayState'>
): () => void {
  let heard = false
  const off = source.on('overlay:state', (state) => {
    heard = true
    setGamepadPaused(state.open)
  })
  source
    .getOverlayState()
    .then((state) => {
      // An event that arrived meanwhile is newer than this answer.
      if (!heard) setGamepadPaused(state.open)
    })
    .catch((err: unknown) => log.warn('getOverlayState failed', err))
  return () => {
    off()
    setGamepadPaused(false)
  }
}
