import { topLayer } from './actions'

/**
 * The right stick's left / right, held: what scrolls sideways while it is held (the Library's tab strip when its tabs
 * do not fit). gamepad.ts calls dispatchStickX on every frame the stick is held left or right, with the deflection
 * past the dead zone and the time since the last frame. Only the handlers on the top action layer are asked (a modal
 * over the Library takes the stick away from its tabs); the latest registration first, and a handler returns false to
 * pass (its strip fits, so there is nothing to scroll).
 */

/** `deflection` -1 (left) .. 1 (right), past the dead zone; `ms` since the last call. Return true when it scrolled. */
export type StickXHandler = (deflection: number, ms: number) => boolean

const handlers: Array<{ layer: string; handler: StickXHandler }> = []

/** Register a sideways scroller on `layer`; returns the unregister function. */
export function registerStickX(layer: string, handler: StickXHandler): () => void {
  const entry = { layer, handler }
  handlers.push(entry)
  return () => {
    const index = handlers.indexOf(entry)
    if (index >= 0) handlers.splice(index, 1)
  }
}

/** Offer one frame of a held right stick left / right; returns whether something scrolled. */
export function dispatchStickX(deflection: number, ms: number): boolean {
  const top = topLayer()
  for (let i = handlers.length - 1; i >= 0; i--) {
    const entry = handlers[i]
    if (!entry || entry.layer !== top) continue
    if (entry.handler(deflection, ms)) return true
  }
  return false
}
