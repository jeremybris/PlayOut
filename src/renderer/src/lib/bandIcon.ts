/**
 * Shared shape of the band icons before Filters > Size's and Filters > H.L.T.B.'s choices (SizePie, HltbClock): a
 * slice that fills more for each larger band, and an icon that grows with the band.
 */

/**
 * How much of a band icon's slice is filled for band `step` of `steps` (1 = smallest): one more share per band, out of
 * one share more than there are bands, so the largest band is almost full (Size: 7/8, H.L.T.B.: 6/7).
 */
export function bandFill(step: number, steps: number): number {
  return Math.min(Math.max(step, 1), steps) / (steps + 1)
}

/**
 * A band icon's width and height: the whole icon grows with the band, from about half the box Platform's console
 * pictures use for the smallest to nearly the full box for the largest.
 */
export function bandIconSize(step: number, steps: number): string {
  const grow = steps > 1 ? (Math.min(Math.max(step, 1), steps) - 1) / (steps - 1) : 1
  return `calc(${(19 + 19 * grow).toFixed(2)} * var(--u))`
}

/**
 * How much of Filters > Reviews' star is filled for band `step` of `steps` (1 = lowest): one share per band, so the
 * best band is full and the lowest keeps a sliver (1/9 of nine bands). Unlike bandFill, the top band is complete.
 */
export function starFill(step: number, steps: number): number {
  return Math.min(Math.max(step, 1), steps) / steps
}

/** A slice of a circle that starts at the top and runs clockwise for `fill` (0-1) of the way round. */
export function slicePath(cx: number, cy: number, r: number, fill: number): string {
  const angle = 2 * Math.PI * fill
  const x = (cx + r * Math.sin(angle)).toFixed(2)
  const y = (cy - r * Math.cos(angle)).toFixed(2)
  return `M${cx} ${cy} L${cx} ${cy - r} A${r} ${r} 0 ${fill > 0.5 ? 1 : 0} 1 ${x} ${y} Z`
}

/** A five-point star in a 24 x 24 box (the game page's StarRating and Filters > Reviews' ReviewStarIcon). */
export const STAR =
  'M12 1.6l3.09 6.26 6.91 1-5 4.87 1.18 6.88L12 17.36l-6.18 3.25L7 13.73 2 8.86l6.91-1z'
/** STAR's corners, in order (the path above, written out). */
const STAR_POINTS: readonly Pt[] = [
  [12, 1.6],
  [15.09, 7.86],
  [22, 8.86],
  [17, 13.73],
  [18.18, 20.61],
  [12, 17.36],
  [5.82, 20.61],
  [7, 13.73],
  [2, 8.86],
  [8.91, 7.86]
]

/** Half the width of ReviewStarIcon's outline: how far into the star the outline covers. */
export const STAR_STROKE_HALF = 0.75

type Pt = readonly [number, number]

function polygonArea(pts: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!
    const [x2, y2] = pts[(i + 1) % pts.length]!
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

/** A polygon shrunk by `d` on every side: each edge moved inward by `d`, corners where neighbouring edges meet. */
function insetPolygon(pts: readonly Pt[], d: number): Pt[] {
  const sign = polygonArea(pts) > 0 ? 1 : -1
  const n = pts.length
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n]!
    const dx = q[0] - p[0]
    const dy = q[1] - p[1]
    const len = Math.hypot(dx, dy)
    return { x: p[0] - (dy / len) * sign * d, y: p[1] + (dx / len) * sign * d, dx, dy }
  })
  return lines.map((b, i) => {
    const a = lines[(i - 1 + n) % n]!
    const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / (a.dx * b.dy - a.dy * b.dx)
    return [a.x + a.dx * t, a.y + a.dy * t] as const
  })
}

/** The part of a polygon at or below the line y = `c` (y grows downward). */
function clipBelow(pts: readonly Pt[], c: number): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % pts.length]!
    const pIn = p[1] >= c
    if (pIn) out.push(p)
    if (pIn !== q[1] >= c) out.push([p[0] + ((q[0] - p[0]) * (c - p[1])) / (q[1] - p[1]), c])
  }
  return out
}

/** The star's inside that ReviewStarIcon's outline leaves showing (STAR shrunk by half the outline's width). */
export const STAR_INNER: readonly Pt[] = insetPolygon(STAR_POINTS, STAR_STROKE_HALF)

/** How much of the star's visible inside (STAR_INNER) lies at or below y = `c`, from 0 to 1. */
export function starVisibleFillBelow(c: number): number {
  return Math.abs(polygonArea(clipBelow(STAR_INNER, c))) / Math.abs(polygonArea(STAR_INNER))
}

/**
 * Where ReviewStarIcon's bottom-up fill stops (its clip's top, in the 24 x 24 box) for band `step` of `steps`: chosen
 * so the filled part of the inside the outline leaves showing is starFill's share of it, so each band shows the same
 * step more than the one below and the lowest keeps a visible sliver. The best band fills the whole box.
 */
export function starClipTop(step: number, steps: number): number {
  const fill = starFill(step, steps)
  if (fill >= 1) return 0
  const ys = STAR_INNER.map((p) => p[1])
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (starVisibleFillBelow(mid) > fill) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Filters > Reviews' gold for band `step` of `steps` (1 = lowest): the same gold hue throughout, brighter for better
 * reviews, so 95-100 is the brightest and 0-40 the dimmest.
 */
export function reviewGold(step: number, steps: number): string {
  const t = steps > 1 ? Math.min(1, Math.max(0, (step - 1) / (steps - 1))) : 1
  const mix = (from: number, to: number): number => Math.round((from + (to - from) * t) * 10) / 10
  return `hsl(${mix(40, 48)} ${mix(55, 100)}% ${mix(28, 62)}%)`
}

/**
 * Filters > Size's colour for band `step` of `steps` (1 = smallest): blue for the smallest games, through yellow in
 * the middle, to red for the largest, like a heat scale.
 */
export function sizeColor(step: number, steps: number): string {
  const t = steps > 1 ? Math.min(1, Math.max(0, (step - 1) / (steps - 1))) : 1
  // Blue (215°) to yellow (50°) over the first half, yellow to red (0°) over the second.
  const hue = t <= 0.5 ? 215 - (215 - 50) * (t / 0.5) : 50 - 50 * ((t - 0.5) / 0.5)
  return `hsl(${Math.round(hue)} 85% 58%)`
}
