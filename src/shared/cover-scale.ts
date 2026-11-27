/**
 * Library cover size (settings.ui.libraryCoverScale): the cover-size slider on the left of every Library tab picks one
 * of these steps, a multiple of the covers' original size (240x360u). 1 is today's size and the default; the steps
 * below it shrink by 10 points, the ones above grow by 15, so each press feels about the same.
 */
export const COVER_SCALE_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.45, 1.6] as const

export const DEFAULT_COVER_SCALE = 1
export const MIN_COVER_SCALE = COVER_SCALE_STEPS[0]
export const MAX_COVER_SCALE = COVER_SCALE_STEPS[COVER_SCALE_STEPS.length - 1]!

/** The index of the step nearest `scale` (a non-number or NaN = the default's). */
export function coverScaleIndex(scale: unknown): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) {
    return COVER_SCALE_STEPS.indexOf(DEFAULT_COVER_SCALE)
  }
  let best = 0
  for (let i = 1; i < COVER_SCALE_STEPS.length; i++) {
    if (Math.abs(COVER_SCALE_STEPS[i]! - scale) < Math.abs(COVER_SCALE_STEPS[best]! - scale))
      best = i
  }
  return best
}

/** The step nearest `scale` (clamped to the ends; a non-number = the default). */
export function nearestCoverScale(scale: unknown): number {
  return COVER_SCALE_STEPS[coverScaleIndex(scale)]!
}

/** One step bigger (`delta` 1) or smaller (-1), staying at the ends. */
export function stepCoverScale(scale: number, delta: number): number {
  const index = Math.max(
    0,
    Math.min(COVER_SCALE_STEPS.length - 1, coverScaleIndex(scale) + Math.sign(delta))
  )
  return COVER_SCALE_STEPS[index]!
}

/** The most grid columns at `scale`: six at today's size (six 240u cards fill a 1920u canvas), more when smaller. */
export function maxColumnsFor(scale: number, base = 6): number {
  return Math.max(1, Math.round(base / nearestCoverScale(scale)))
}
