import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject
} from 'react'
import {
  pageTarget,
  scrollLeftForThumb,
  thumbGeometry,
  type ThumbGeometry
} from '../../lib/hScroll'
import { cx } from '../../lib/cx'
import { smoothScrolls } from './useTabScroll'

export interface TabScrollBarProps {
  /** The strip's scrolling box (.library__tabs). */
  viewportRef: RefObject<HTMLElement | null>
  /** The strip itself (max-content wide): its resizes move the pill. */
  stripRef: RefObject<HTMLElement | null>
}

/**
 * The bar under the tab strip while its tabs do not fit: a rounded track with a pill in the accent colour, as wide as
 * the visible share of the tabs (shorter the further there is to scroll) and placed at the scrolled fraction. Drag the
 * pill to scroll; press the track beside it to page toward the press. Decorative for assistive technology (the tabs
 * themselves are the tablist), so aria-hidden.
 */
export const TabScrollBar = memo(function TabScrollBar({
  viewportRef,
  stripRef
}: TabScrollBarProps): ReactElement {
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const geometry = useRef<ThumbGeometry>({ width: 0, left: 0 })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; left: number } | null>(null)

  const update = useCallback(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    const thumb = thumbRef.current
    if (!viewport || !track || !thumb) return
    const trackWidth = track.clientWidth
    // The pill is never shorter than three times its height, so it stays a pill and easy to grab.
    const minThumb = Math.min(trackWidth, track.clientHeight * 3)
    const next = thumbGeometry(
      {
        scrollWidth: viewport.scrollWidth,
        clientWidth: viewport.clientWidth,
        scrollLeft: viewport.scrollLeft
      },
      trackWidth,
      minThumb
    )
    geometry.current = next
    thumb.style.width = `${next.width}px`
    thumb.style.transform = `translateX(${next.left}px)`
  }, [viewportRef])

  useLayoutEffect(update)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    viewport.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(update)
      observer.observe(viewport)
      if (stripRef.current) observer.observe(stripRef.current)
      if (trackRef.current) observer.observe(trackRef.current)
    }
    return () => {
      viewport.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [viewportRef, stripRef, update])

  const onTrackDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current
      const track = trackRef.current
      if (!viewport || !track || event.target !== track) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      event.preventDefault()
      const x = event.clientX - track.getBoundingClientRect().left
      const left = pageTarget(x, geometry.current, {
        scrollWidth: viewport.scrollWidth,
        clientWidth: viewport.clientWidth,
        scrollLeft: viewport.scrollLeft
      })
      viewport.scrollTo({ left, behavior: smoothScrolls() ? 'smooth' : 'auto' })
    },
    [viewportRef]
  )

  const onThumbDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    drag.current = { id: event.pointerId, x: event.clientX, left: geometry.current.left }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is already gone.
    }
    setDragging(true)
  }, [])

  const onThumbMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = drag.current
      const viewport = viewportRef.current
      const track = trackRef.current
      if (!current || current.id !== event.pointerId || !viewport || !track) return
      viewport.scrollLeft = scrollLeftForThumb(
        current.left + event.clientX - current.x,
        { scrollWidth: viewport.scrollWidth, clientWidth: viewport.clientWidth },
        track.clientWidth,
        geometry.current.width
      )
    },
    [viewportRef]
  )

  const onThumbEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }, [])

  return (
    <div
      ref={trackRef}
      className="library__tabs-scrollbar"
      aria-hidden="true"
      onPointerDown={onTrackDown}
    >
      <div
        ref={thumbRef}
        className={cx(
          'library__tabs-scrollbar-thumb',
          dragging && 'library__tabs-scrollbar-thumb--dragging'
        )}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbEnd}
        onPointerCancel={onThumbEnd}
      />
    </div>
  )
})
