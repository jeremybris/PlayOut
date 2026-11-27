import { useEffect, type RefObject } from 'react'
import { useSettingsStore } from '../state/settings'
import { useUiStore } from '../state/ui'

export interface ScrollIntoViewOptions {
  /** Default 'center' (cards centre themselves in their row). */
  inline?: ScrollLogicalPosition
  /** Default 'nearest'. */
  block?: ScrollLogicalPosition
  /** Also scroll when the focus came from mouse hover or touch (default false: a hovered card must not slide away under the cursor). */
  pointer?: boolean
}

/**
 * Scroll the element into view whenever `active` becomes true (typically the element's `focused` state):
 * `scrollIntoView({ inline: 'center', block: 'nearest', behavior: settings.ui.animations ? 'smooth' : 'auto' })`.
 */
export function useScrollIntoView(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options?: ScrollIntoViewOptions
): void {
  const inline = options?.inline ?? 'center'
  const block = options?.block ?? 'nearest'
  const pointer = options?.pointer ?? false
  useEffect(() => {
    if (!active) return
    const method = useUiStore.getState().inputMethod
    if (!pointer && (method === 'mouse' || method === 'touch')) return
    const animations = useSettingsStore.getState().settings?.ui.animations ?? true
    ref.current?.scrollIntoView({ inline, block, behavior: animations ? 'smooth' : 'auto' })
  }, [ref, active, inline, block, pointer])
}
