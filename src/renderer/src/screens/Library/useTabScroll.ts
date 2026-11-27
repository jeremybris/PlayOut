import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { registerStickX } from '../../input/stickScrollX'
import { carryStep, isDrag, overflows, stickStepX, wheelDeltaX } from '../../lib/hScroll'
import { useSettingsStore } from '../../state/settings'

/** Class the strip's box carries while a pointer drags it (grabbing cursor, no hover colours). */
export const DRAGGING_CLASS = 'library__tabs--dragging'

/** Whether moves should animate: PlayOut's Animations setting and the system's reduced-motion preference. */
export function smoothScrolls(): boolean {
  const animations = useSettingsStore.getState().settings?.ui.animations ?? true
  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return animations && !reduced
}

/**
 * Whether the tab strip's content (`strip`, max-content wide) is wider than its box (`viewport`), kept current as
 * either resizes (the window, a tab added / removed / renamed, the language, the zoom, the display font loading).
 * Measured before paint, so the bar never flickers in or out.
 */
export function useStripOverflow(
  viewportRef: RefObject<HTMLElement | null>,
  stripRef: RefObject<HTMLElement | null>
): boolean {
  const [overflow, setOverflow] = useState(false)
  const measure = useCallback(() => {
    const viewport = viewportRef.current
    const strip = stripRef.current
    if (!viewport || !strip) return
    // The strip is max-content wide: its own width is the content's, also before the viewport has scrolled.
    const content = Math.max(viewport.scrollWidth, strip.offsetWidth)
    setOverflow(overflows(content, viewport.clientWidth))
  }, [viewportRef, stripRef])

  useLayoutEffect(measure)

  useEffect(() => {
    const viewport = viewportRef.current
    const strip = stripRef.current
    if (!viewport || !strip) return undefined
    let cancelled = false
    window.addEventListener('resize', measure)
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready
        .then(() => {
          if (!cancelled) measure()
        })
        .catch(() => undefined)
    }
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      observer.observe(viewport)
      observer.observe(strip)
    }
    return () => {
      cancelled = true
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [viewportRef, stripRef, measure])

  return overflow
}

/**
 * While the tabs overflow: drag the strip with the mouse or a finger (past a small threshold, so a click or tap on a
 * tab still selects it, and the click that ends a drag selects nothing), the wheel over the strip or its bar (`boxRef`,
 * which holds both) scrolls it sideways (a vertical wheel too, without reaching the Library's wheel-up-returns-Home),
 * and the right stick's left / right scrolls it on `layer` while `enabled`. When the tabs fit, none of these does
 * anything and the events go on as before.
 */
export function useStripScrolling(
  viewportRef: RefObject<HTMLElement | null>,
  boxRef: RefObject<HTMLElement | null>,
  overflow: boolean,
  layer: string,
  enabled: boolean
): void {
  const overflowRef = useRef(overflow)
  useLayoutEffect(() => {
    overflowRef.current = overflow
  }, [overflow])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    const box = boxRef.current ?? viewport
    let press: { id: number; x: number; y: number; left: number; dragging: boolean } | null = null
    let swallowClick = false
    let swallowTimer: ReturnType<typeof setTimeout> | null = null

    // A press that ends without dragging anywhere (released off the strip before the threshold) or a mouse that moves
    // with no button held: forget it, so a later hover never drags and the tabs stay clickable.
    const dropPress = (): void => {
      press = null
      viewport.classList.remove(DRAGGING_CLASS)
      window.removeEventListener('pointerup', onWindowEnd)
      window.removeEventListener('pointercancel', onWindowEnd)
    }
    function onWindowEnd(event: PointerEvent): void {
      if (press && event.pointerId === press.id) dropPress()
    }

    const onPointerDown = (event: PointerEvent): void => {
      dropPress()
      if (!overflowRef.current) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      press = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: viewport.scrollLeft,
        dragging: false
      }
      // Bubble phase, so it runs after the strip's own pointerup (a release on the strip): only a release elsewhere.
      window.addEventListener('pointerup', onWindowEnd)
      window.addEventListener('pointercancel', onWindowEnd)
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (!press || event.pointerId !== press.id) return
      if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
        dropPress()
        return
      }
      const dx = event.clientX - press.x
      if (!press.dragging) {
        if (!isDrag(dx, event.clientY - press.y)) return
        press.dragging = true
        viewport.classList.add(DRAGGING_CLASS)
        try {
          viewport.setPointerCapture(event.pointerId)
        } catch {
          // The pointer is already gone: the drag simply ends with it.
        }
      }
      viewport.scrollLeft = press.left - dx
    }
    const onPointerEnd = (event: PointerEvent): void => {
      if (!press || event.pointerId !== press.id) return
      if (press.dragging) {
        // The click this release makes (on the tab under it) must not select that tab.
        swallowClick = event.type === 'pointerup'
        if (swallowTimer) clearTimeout(swallowTimer)
        swallowTimer = setTimeout(() => {
          swallowClick = false
          swallowTimer = null
        }, 0)
      }
      dropPress()
    }
    const onClickCapture = (event: MouseEvent): void => {
      if (!swallowClick) return
      swallowClick = false
      event.stopPropagation()
      event.preventDefault()
    }
    const onWheel = (event: WheelEvent): void => {
      if (!overflowRef.current) return
      const delta = wheelDeltaX(event, viewport.clientWidth)
      if (delta === 0) return
      event.preventDefault()
      // Over the tabs and their bar the wheel is theirs: the Library's wheel-up at the top of the grid must not see it.
      event.stopPropagation()
      viewport.scrollLeft += delta
    }

    viewport.addEventListener('pointerdown', onPointerDown)
    viewport.addEventListener('pointermove', onPointerMove)
    viewport.addEventListener('pointerup', onPointerEnd)
    viewport.addEventListener('pointercancel', onPointerEnd)
    viewport.addEventListener('click', onClickCapture, true)
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      viewport.removeEventListener('pointerdown', onPointerDown)
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerup', onPointerEnd)
      viewport.removeEventListener('pointercancel', onPointerEnd)
      viewport.removeEventListener('click', onClickCapture, true)
      box.removeEventListener('wheel', onWheel)
      dropPress()
      if (swallowTimer) clearTimeout(swallowTimer)
    }
  }, [viewportRef, boxRef])

  useEffect(() => {
    if (!enabled) return undefined
    // Sub-pixel steps (a light push) add up here instead of being lost to scrollLeft's pixel snapping.
    let carry = 0
    return registerStickX(layer, (deflection, ms) => {
      const viewport = viewportRef.current
      if (!viewport || !overflowRef.current) return false
      const step = carryStep(carry, stickStepX(deflection, ms))
      carry = step.carry
      if (step.px !== 0) viewport.scrollLeft += step.px
      return true
    })
  }, [viewportRef, layer, enabled])
}
