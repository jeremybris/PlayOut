/** One child of a row of stats: its natural width and, for one that may be left out, its drop rank. */
export interface FitItem {
  width: number
  /** Left out when the row is too narrow: rank 1 goes first; items of one rank go together. Absent: always kept. */
  drop?: number
}

/**
 * The drop rank at or below which a row leaves its items out so the rest, `gap` apart, fit in `available` pixels: 0
 * when everything fits, the highest rank when even that does not. Half a pixel of slack absorbs sub-pixel rounding.
 */
export function dropUpTo(items: readonly FitItem[], gap: number, available: number): number {
  const ranks = [...new Set(items.flatMap((i) => (i.drop === undefined ? [] : [i.drop])))].sort(
    (a, b) => a - b
  )
  for (const upTo of [0, ...ranks]) {
    const kept = items.filter((i) => i.drop === undefined || i.drop > upTo)
    const width = kept.reduce((sum, i) => sum + i.width, 0) + gap * Math.max(0, kept.length - 1)
    if (width <= available + 0.5) return upTo
  }
  return ranks.at(-1) ?? 0
}

/** A row's children measured one way (as they are, or with the row's compact styles). */
export interface FitMeasure {
  items: readonly FitItem[]
  gap: number
}

/** How a row is shown: the drop rank at or below which children are left out, and whether it is compact. */
export interface FitPlan {
  upTo: number
  compact: boolean
}

function fits(m: FitMeasure, upTo: number, available: number): boolean {
  const kept = m.items.filter((i) => i.drop === undefined || i.drop > upTo)
  const width = kept.reduce((sum, i) => sum + i.width, 0) + m.gap * Math.max(0, kept.length - 1)
  return width <= available + 0.5
}

/**
 * How a row fits in `available` pixels, from its widths as it is (`normal`) and with its compact styles (`compact`:
 * tighter gaps, shorter labels and values, `fit-compact`): everything as it is; else the first rank (the least
 * important stat) left out; else compact, leaving out as few ranks as fit. Compact before dropping more keeps a
 * stat (the review score of a game whose Play button has a Co-Op half, on a 16:10 screen) in a shorter form.
 */
export function fitPlan(
  normal: FitMeasure,
  compact: FitMeasure | null,
  available: number
): FitPlan {
  const ranks = [
    ...new Set(normal.items.flatMap((i) => (i.drop === undefined ? [] : [i.drop])))
  ].sort((a, b) => a - b)
  if (fits(normal, 0, available)) return { upTo: 0, compact: false }
  const first = ranks[0]
  if (first !== undefined && fits(normal, first, available)) return { upTo: first, compact: false }
  if (!compact) return { upTo: dropUpTo(normal.items, normal.gap, available), compact: false }
  // From the first rank on: a stat left out as the row narrowed never comes back with the compact styles.
  for (const upTo of first === undefined ? [0] : ranks)
    if (fits(compact, upTo, available)) return { upTo, compact: true }
  return { upTo: ranks.at(-1) ?? 0, compact: true }
}
