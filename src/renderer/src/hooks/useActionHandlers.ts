import { createContext, useContext, useEffect, useRef } from 'react'
import {
  BUTTON_ACTIONS,
  ROOT_LAYER,
  registerActionHandlers,
  type ActionHandlers,
  type ButtonAction
} from '../input/actions'

/**
 * The layer a component registers its action handlers on. Modal (via useFocusLayer) provides its own layer
 * id to its children; everything outside a modal is on the root layer.
 */
export const LayerContext = createContext<string>(ROOT_LAYER)

/** The id of the action layer the calling component lives in. */
export function useLayerId(): string {
  return useContext(LayerContext)
}

/**
 * Register button-action handlers on an explicit layer (Modal and OnScreenKeyboard register on the layer
 * they own). Handlers are read through a ref, so passing fresh closures every render is fine.
 */
export function useActionHandlersOnLayer(
  layerId: string,
  handlers: ActionHandlers,
  enabled = true
): void {
  const latest = useRef<ActionHandlers>(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  useEffect(() => {
    if (!enabled) return undefined
    const forward: ActionHandlers = {}
    for (const action of BUTTON_ACTIONS) {
      forward[action] = (a: ButtonAction, source) => {
        const handler = latest.current[a]
        return handler ? handler(a, source) : false
      }
    }
    return registerActionHandlers(layerId, forward)
  }, [layerId, enabled])
}

/**
 * Register handlers for back / x / y / lb / rb / start / select / lt / rt on the component's layer.
 * Only the topmost layer receives these actions, so a screen under a modal is never triggered. A handler
 * that returns false declines the action and lets an earlier registration on the same layer handle it.
 *
 * @example useActionHandlers({ back: () => close(), x: () => toggleFavorite() })
 */
export function useActionHandlers(handlers: ActionHandlers, enabled = true): void {
  useActionHandlersOnLayer(useContext(LayerContext), handlers, enabled)
}
