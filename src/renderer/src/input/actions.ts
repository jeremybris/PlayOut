import { createLog } from '../lib/log'
import { navigateByDirection, pressArrow, pressEnter, type Direction } from './focus'

const log = createLog('actions')

/**
 * The action bus. Gamepad buttons, keyboard keys and pointer buttons are translated into abstract actions;
 * dispatchAction routes directions to the focus engine, 'accept' to the focused element and every other
 * action to the handlers of the topmost layer. A layer is pushed by each modal (useFocusLayer) so a screen
 * underneath a modal never receives its back/x/y presses.
 */

/** Re-exported from the focus engine so actions and focus share one `Direction` type. */
export type { Direction }

/**
 * 'section-prev' / 'section-next' come from the gamepad's D-pad up / down only (not the left stick or the keyboard
 * arrows) and are offered to the handlers first: the library grid jumps to the previous / next section. When no
 * handler takes one, the press goes on as the plain direction. 'rs-up' / 'rs-down' are the right stick's up / down.
 */
export type Action =
  | Direction
  | 'accept'
  | 'back'
  | 'x'
  | 'y'
  | 'lb'
  | 'rb'
  | 'start'
  | 'select'
  | 'lt'
  | 'rt'
  | 'section-prev'
  | 'section-next'
  | 'rs-up'
  | 'rs-down'

/** Actions that go to the handler stack (everything that is not a direction or accept). */
export type ButtonAction = Exclude<Action, Direction | 'accept'>

export type ActionSource = 'gamepad' | 'keyboard' | 'mouse' | 'touch' | 'program'

/** Return false to decline the action so an earlier registration on the same layer gets it. */
export type ActionHandler = (action: ButtonAction, source: ActionSource) => boolean | void

export type ActionHandlers = Partial<Record<ButtonAction, ActionHandler>>

export const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right']
export const BUTTON_ACTIONS: readonly ButtonAction[] = [
  'back',
  'x',
  'y',
  'lb',
  'rb',
  'start',
  'select',
  'lt',
  'rt',
  'section-prev',
  'section-next',
  'rs-up',
  'rs-down'
]

/** The implicit bottom layer (Home screen and App-level handlers). */
export const ROOT_LAYER = 'root'

const layers: string[] = [ROOT_LAYER]
/** Container focus key of each layer (useFocusLayer registers it) so a vanished restore target has a fallback. */
const layerFocusKeys = new Map<string, string>()
/** Push sequence number of each layer on the stack (the root layer is 0), so a layer can tell a newer one. */
const layerOrders = new Map<string, number>()
let nextOrder = 1
const registrations = new Map<string, ActionHandlers[]>()
/** Directions and accept are dropped while set (a modal is playing its exit animation; see setInputFrozen). */
let frozen = false

export type ActionListener = (action: Action, source: ActionSource, handled: boolean) => void
const listeners = new Set<ActionListener>()

export function isDirection(action: Action): action is Direction {
  return action === 'up' || action === 'down' || action === 'left' || action === 'right'
}

/**
 * Make `id` the top layer (moving it up if it is already on the stack). `focusKey` is the focus key of the
 * layer's container (its modal), remembered for topLayerFocusKey().
 */
export function pushLayer(id: string, focusKey?: string): void {
  const index = layers.indexOf(id)
  if (index >= 0) layers.splice(index, 1)
  layers.push(id)
  layerOrders.set(id, nextOrder++)
  if (focusKey) layerFocusKeys.set(id, focusKey)
}

/** Remove a layer; the root layer can never be removed. */
export function popLayer(id: string): void {
  if (id === ROOT_LAYER) return
  const index = layers.indexOf(id)
  if (index >= 0) layers.splice(index, 1)
  layerFocusKeys.delete(id)
  layerOrders.delete(id)
}

/** The layer that currently receives button actions. */
export function topLayer(): string {
  return layers[layers.length - 1] ?? ROOT_LAYER
}

/** The container focus key registered for the top layer, or null (root layer, or none registered). */
export function topLayerFocusKey(): string | null {
  return layerFocusKeys.get(topLayer()) ?? null
}

/**
 * When `id` was pushed, as a number that grows with every push: a layer pushed later has a higher order.
 * 0 for the root layer and for ids that are not on the stack.
 */
export function layerOrder(id: string): number {
  return layerOrders.get(id) ?? 0
}

/**
 * Freeze directional and accept input: a modal that is closing keeps its DOM (and its Norigin focusables)
 * for the exit animation, and without this a quick B then A would still activate its fading controls.
 * Button actions keep flowing to the top layer, so a second B reaches the layer below as soon as the
 * closing modal has released its layer. ModalHost sets this while any modal is closing.
 */
export function setInputFrozen(value: boolean): void {
  frozen = value
}

export function isInputFrozen(): boolean {
  return frozen
}

/** Register handlers on a layer; returns the unregister function. Later registrations are tried first. */
export function registerActionHandlers(layerId: string, handlers: ActionHandlers): () => void {
  let list = registrations.get(layerId)
  if (!list) {
    list = []
    registrations.set(layerId, list)
  }
  list.push(handlers)
  return () => {
    const current = registrations.get(layerId)
    if (!current) return
    const index = current.indexOf(handlers)
    if (index >= 0) current.splice(index, 1)
    if (current.length === 0) registrations.delete(layerId)
  }
}

/** Observe every dispatched action (debugging, hints); returns the unsubscribe function. */
export function addActionListener(listener: ActionListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function dispatchButton(action: ButtonAction, source: ActionSource): boolean {
  const list = registrations.get(topLayer())
  if (!list) return false
  for (let i = list.length - 1; i >= 0; i--) {
    const handler = list[i]?.[action]
    if (!handler) continue
    try {
      if (handler(action, source) !== false) return true
    } catch (err) {
      log.error(`handler for '${action}' threw`, err)
      return true
    }
  }
  return false
}

/**
 * Route one action. Returns true when something consumed it: for directions, when the focused element took
 * the arrow or the focus engine was asked to move; for accept, always; for buttons, when a handler on the
 * top layer accepted it. Directions and accept are dropped (handled = false) while input is frozen.
 */
export function dispatchAction(action: Action, source: ActionSource): boolean {
  let handled: boolean
  if (isDirection(action)) {
    if (frozen) handled = false
    else if (pressArrow(action)) handled = true
    else {
      navigateByDirection(action, { source }).catch((err) =>
        log.error('navigateByDirection failed', err)
      )
      handled = true
    }
  } else if (action === 'accept') {
    if (frozen) handled = false
    else {
      pressEnter()
      handled = true
    }
  } else if ((action === 'section-prev' || action === 'section-next') && frozen) {
    // A direction in disguise: frozen like the plain one it falls back to.
    handled = false
  } else {
    handled = dispatchButton(action, source)
  }
  for (const listener of listeners) listener(action, source, handled)
  return handled
}

/** Test/HMR helper: forget every layer and registration except the root layer. */
export function resetActionBus(): void {
  layers.splice(0, layers.length, ROOT_LAYER)
  layerFocusKeys.clear()
  layerOrders.clear()
  nextOrder = 1
  registrations.clear()
  listeners.clear()
  frozen = false
}
