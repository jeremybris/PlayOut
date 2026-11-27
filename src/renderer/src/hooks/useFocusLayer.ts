import { useCallback, useEffect, useId, useRef, type RefObject } from 'react'
import {
  ROOT_LAYER,
  layerOrder,
  popLayer,
  pushLayer,
  topLayer,
  topLayerFocusKey
} from '../input/actions'
import { doesFocusableExist, getCurrentFocusKey, setFocus, useFocusable } from '../input/focus'
import { useUiStore } from '../state/ui'

/**
 * Focus isolation for modals and sheets.
 *
 * The returned `ref` goes on the modal's root element and `focusKey` into a <FocusContext.Provider> around
 * its children (Modal does both). The container is a Norigin focus boundary, so directional navigation never
 * leaves it; on mount it pushes an action layer, remembers the focused element and focuses its first (or
 * preferred) focusable; when it is released (the `closing` option turning true, or unmount) it pops the
 * layer and restores the previous focus. When that element vanished with the modal (the card that opened
 * it was hidden or removed), focus lands in the layer that is now on top instead, so directional input
 * keeps working; the root case is the Home and Library views' own focus effects.
 */
export interface FocusLayerOptions {
  /** Focus key of the container; children's keys are conventionally prefixed with it. */
  focusKey: string
  /** Child to focus first instead of the one closest to the top-left corner. */
  preferredChildFocusKey?: string
  /** Restore the previously focused element on release (default true). */
  restoreFocus?: boolean
  /** Move focus into the layer on mount (default true). */
  focusOnMount?: boolean
  /**
   * The owner is playing its exit animation: release the layer now (pop it and restore focus) while the
   * DOM stays mounted, so the layer below is interactive as soon as the close starts. Unmount releases too.
   */
  closing?: boolean
}

export interface FocusLayer<E extends HTMLElement = HTMLElement> {
  ref: RefObject<E | null>
  focusKey: string
  /** Action layer id; provide it through LayerContext so useActionHandlers inside registers on this layer. */
  layerId: string
  hasFocusedChild: boolean
  /** Move focus (back) into the layer, to its remembered/preferred/first child. */
  focusFirst(): void
}

/**
 * A layer that was released in the current tick hands its restore target to a layer that mounts right after
 * (a dialog replacing a sheet, React StrictMode's double mount), so focus goes back to where the sequence
 * started instead of to a focusable that no longer exists.
 */
let pendingRestore: { key: string | null; timer: ReturnType<typeof setTimeout> } | null = null

export function useFocusLayer<E extends HTMLElement = HTMLElement>(
  options: FocusLayerOptions
): FocusLayer<E> {
  const {
    focusKey,
    preferredChildFocusKey,
    restoreFocus = true,
    focusOnMount = true,
    closing = false
  } = options
  const layerId = useId()
  const { ref, hasFocusedChild } = useFocusable<object, E>({
    focusKey,
    preferredChildFocusKey,
    isFocusBoundary: true,
    trackChildren: true,
    saveLastFocusedChild: true,
    focusable: true
  })

  /** The element focused before this layer took focus (set on mount). */
  const previous = useRef<string | null>(null)
  /** The screen under this layer when it opened: no restore once another screen shows (it places focus itself). */
  const screen = useRef(useUiStore.getState().screen)
  /** True once this mount's layer was popped (by closing or unmount); the release then runs once. */
  const released = useRef(true)
  const latest = useRef({ restoreFocus })
  useEffect(() => {
    latest.current = { restoreFocus }
  })

  const release = useCallback(() => {
    if (released.current) return
    released.current = true
    const order = layerOrder(layerId)
    popLayer(layerId)
    if (!latest.current.restoreFocus) return
    const remembered = previous.current
    const target = remembered && doesFocusableExist(remembered) ? remembered : null
    // Nested layers releasing in one commit share one deferred restore (the outermost target wins).
    if (pendingRestore) clearTimeout(pendingRestore.timer)
    // Deferred past this commit: on unmount the layer's children are removed after this cleanup and
    // Norigin would otherwise schedule its own (wrong) auto-restore; setFocus cancels that. By then every
    // layer that unmounted in this commit has popped and every removed focusable (including a vanished
    // card) is gone, and a modal that replaces this one has mounted and taken over the restore.
    const timer = setTimeout(() => {
      pendingRestore = null
      // The layer closed by switching screens (a game page's chip opened the Library): the target was on the screen
      // that is gone, and the new one focuses its own card.
      if (useUiStore.getState().screen !== screen.current) return
      // A layer pushed after this one is on top (a modal replaced this one and already holds focus):
      // restoring here would pull focus out from under it.
      if (layerOrder(topLayer()) > order) return
      if (target && doesFocusableExist(target)) {
        void setFocus(target)
        return
      }
      // The restore target disappeared with the modal (hidden/removed game): land on the container of
      // the layer now on top; Norigin resolves it to its remembered/preferred/first child.
      if (topLayer() === ROOT_LAYER) return
      const fallback = topLayerFocusKey()
      if (fallback && doesFocusableExist(fallback)) void setFocus(fallback)
    }, 0)
    pendingRestore = { key: target, timer }
  }, [layerId])

  useEffect(() => {
    if (pendingRestore) {
      clearTimeout(pendingRestore.timer)
      previous.current = pendingRestore.key
      pendingRestore = null
    } else {
      const current = getCurrentFocusKey()
      previous.current = current && doesFocusableExist(current) ? current : null
    }
    released.current = false
    screen.current = useUiStore.getState().screen
    pushLayer(layerId, focusKey)
    if (focusOnMount) void setFocus(focusKey)
    return release
    // Mount/unmount only: focusKey and layerId are stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Closing: release now; the owner keeps the DOM for its exit animation and the unmount release is a no-op.
  useEffect(() => {
    if (closing) release()
  }, [closing, release])

  const focusFirst = useCallback(() => {
    void setFocus(focusKey)
  }, [focusKey])

  return { ref: ref as RefObject<E | null>, focusKey, layerId, hasFocusedChild, focusFirst }
}
