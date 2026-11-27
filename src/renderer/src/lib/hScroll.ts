/**
 * The maths of a horizontal strip that scrolls without a native scroll bar (the Library's tab strip): whether it
 * overflows, the size and place of the custom bar's pill, dragging the pill, paging from the track, telling a drag
 * of the strip from a click on a tab, the wheel and the right stick.
 */

/** Rounding slack: a strip at most this many pixels wider than its box does not count as overflowing. */
export const OVERFLOW_SLACK_PX = 1

/** A pointer that moved at least this far sideways (and more sideways than up / down) drags instead of clicking. */
export const DRAG_THRESHOLD_PX = 8

/** Pixels a second the right stick scrolls at full deflection (input/stickScroll.ts's vertical speed). */
export const STICK_X_SPEED = 1400

/** A wheel line (deltaMode 1) in pixels. */
export const WHEEL_LINE_PX = 40

/** A click on the track scrolls this share of the visible width toward the click. */
export const PAGE_FRACTION = 0.8

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Whether content `scrollWidth` wide does not fit in a box `clientWidth` wide. */
export function overflows(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > OVERFLOW_SLACK_PX
}

export interface ScrollMetrics {
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
}

export interface ThumbGeometry {
  /** The pill's width in pixels. */
  width: number
  /** The pill's left edge from the track's, in pixels. */
  left: number
}

/**
 * The pill of a track `trackWidth` wide: as wide as the visible share of the content (never under `minThumb`, never
 * over the track), so the further there is to scroll the shorter it is; placed at the scrolled fraction.
 */
export function thumbGeometry(
  metrics: ScrollMetrics,
  trackWidth: number,
  minThumb: number
): ThumbGeometry {
  const { scrollWidth, clientWidth, scrollLeft } = metrics
  const track = Math.max(0, trackWidth)
  const ratio = scrollWidth > 0 ? clamp(clientWidth / scrollWidth, 0, 1) : 1
  const width = Math.min(track, Math.max(minThumb, track * ratio))
  const max = scrollWidth - clientWidth
  const fraction = max > 0 ? clamp(scrollLeft / max, 0, 1) : 0
  return { width, left: (track - width) * fraction }
}

/** The scrollLeft that puts the pill's left edge at `thumbLeft` (dragging the pill). */
export function scrollLeftForThumb(
  thumbLeft: number,
  metrics: Pick<ScrollMetrics, 'scrollWidth' | 'clientWidth'>,
  trackWidth: number,
  thumbWidth: number
): number {
  const max = Math.max(0, metrics.scrollWidth - metrics.clientWidth)
  const room = trackWidth - thumbWidth
  if (room <= 0 || max === 0) return 0
  return clamp((thumbLeft / room) * max, 0, max)
}

/** Where a click at `x` on the track (from its left edge) scrolls to: one page toward the click, or nowhere on the pill. */
export function pageTarget(x: number, thumb: ThumbGeometry, metrics: ScrollMetrics): number {
  const max = Math.max(0, metrics.scrollWidth - metrics.clientWidth)
  const step = metrics.clientWidth * PAGE_FRACTION
  if (x < thumb.left) return clamp(metrics.scrollLeft - step, 0, max)
  if (x > thumb.left + thumb.width) return clamp(metrics.scrollLeft + step, 0, max)
  return metrics.scrollLeft
}

/** Whether a pointer that moved (dx, dy) since it went down is dragging the strip (else it is still a click / tap). */
export function isDrag(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy)
}

/** How far one wheel event scrolls the strip sideways: the larger axis (a vertical wheel scrolls it too), in pixels. */
export function wheelDeltaX(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>,
  pagePx: number
): number {
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (event.deltaMode === 1) return delta * WHEEL_LINE_PX
  if (event.deltaMode === 2) return delta * pagePx
  return delta
}

/**
 * How far the right stick scrolls in `ms` milliseconds at `deflection` (-1 left .. 1 right, past the dead zone):
 * gently near the centre, quickly at the edge (the vertical stick scroll's curve).
 */
export function stickStepX(deflection: number, ms: number): number {
  if (deflection === 0) return 0
  const seconds = Math.min(Math.max(0, ms), 50) / 1000
  return Math.sign(deflection) * deflection * deflection * STICK_X_SPEED * seconds
}

/**
 * The scrollLeft that brings an item (`itemLeft` from the content's start, `itemWidth` wide) fully into view, at least
 * `margin` pixels inside both edges (the strip's faded ends), moving as little as possible; unchanged when it already
 * is. An item wider than the room left between the margins lines up with the start margin.
 */
export function revealLeft(
  itemLeft: number,
  itemWidth: number,
  metrics: ScrollMetrics,
  margin: number
): number {
  const max = Math.max(0, metrics.scrollWidth - metrics.clientWidth)
  const room = Math.max(0, metrics.clientWidth - 2 * margin)
  let left = metrics.scrollLeft
  if (itemWidth > room || itemLeft - margin < left) left = itemLeft - margin
  else if (itemLeft + itemWidth + margin > left + metrics.clientWidth)
    left = itemLeft + itemWidth + margin - metrics.clientWidth
  return clamp(left, 0, max)
}

/**
 * Whole-pixel steps from fractional ones: scrollLeft snaps to device pixels, so a light push of the stick (well under a
 * pixel a frame) would be lost frame after frame. Adds `step` to the carried remainder and returns the whole pixels to
 * scroll now and the remainder to carry; a change of direction drops the old remainder.
 */
export function carryStep(carry: number, step: number): { px: number; carry: number } {
  const start = Math.sign(carry) !== 0 && Math.sign(carry) !== Math.sign(step) ? 0 : carry
  const total = start + step
  const px = Math.trunc(total) || 0
  return { px, carry: total - px }
}
