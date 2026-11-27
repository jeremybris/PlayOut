/**
 * Horizontal row windowing (design 6.9: rows render only the cards near the viewport). Pure index maths so
 * WindowedCards can be unit tested without a DOM.
 */

/** A run of mounted card indices, `end` exclusive. */
export interface Segment {
  start: number
  end: number
}

export interface CardWindowInput {
  /** Number of cards in the row. */
  count: number
  /** The track's scrollLeft and clientWidth in px. */
  scrollLeft: number
  clientWidth: number
  /** The track's left padding (page inset) before the first card, in px. */
  paddingLeft: number
  /** Card width plus the flex gap, in px (0 when nothing could be measured yet). */
  stride: number
  /** Cards rendered beyond each edge of the visible range, and around each pinned card. */
  overscan: number
  /** Indices that must stay mounted whatever is visible (the focused / remembered card); out-of-range values are ignored. */
  pinned: readonly number[]
}

/**
 * The runs of cards to mount: the visible range widened by `overscan` on both sides, plus `overscan` cards
 * around every pinned index (so a D-pad step from the focused card always has a mounted neighbour), merged
 * and sorted. Everything between runs is replaced by a spacer of the exact omitted width.
 */
export function cardWindow(input: CardWindowInput): Segment[] {
  const { count, overscan } = input
  if (count <= 0) return []
  const runs: Segment[] = []
  const add = (first: number, last: number): void => {
    const start = Math.max(0, first - overscan)
    const end = Math.min(count, last + overscan + 1)
    if (end > start) runs.push({ start, end })
  }
  if (input.stride > 0) {
    const offset = Math.max(0, input.scrollLeft - input.paddingLeft)
    const first = Math.min(count - 1, Math.floor(offset / input.stride))
    const last = Math.min(
      count - 1,
      Math.floor((offset + Math.max(0, input.clientWidth)) / input.stride)
    )
    add(first, last)
  } else {
    // Nothing measured yet (first render): the start of the row.
    add(0, overscan)
  }
  for (const index of input.pinned) {
    if (Number.isInteger(index) && index >= 0 && index < count) add(index, index)
  }
  return mergeSegments(runs)
}

/** Sort and merge overlapping or touching runs. */
export function mergeSegments(runs: Segment[]): Segment[] {
  const sorted = [...runs].sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  for (const run of sorted) {
    const last = out[out.length - 1]
    if (last && run.start <= last.end) last.end = Math.max(last.end, run.end)
    else out.push({ ...run })
  }
  return out
}

export function sameSegments(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.start !== b[i]!.start || a[i]!.end !== b[i]!.end) return false
  }
  return true
}

/** One child of a row-windowed grid: a spacer standing in for `rows` omitted rows, or one mounted row. */
export type RowLayoutEntry =
  { kind: 'spacer'; row: number; rows: number } | { kind: 'row'; row: number }

/**
 * The mounted rows and spacers of a row-windowed grid, in order: `segments` (sorted, non-overlapping,
 * clamped to `rowCount`) become mounted rows and every gap before, between and after them a spacer of the
 * exact number of omitted rows, so the entries always account for all `rowCount` rows.
 */
export function gridRowLayout(segments: readonly Segment[], rowCount: number): RowLayoutEntry[] {
  const out: RowLayoutEntry[] = []
  let cursor = 0
  for (const segment of segments) {
    const start = Math.min(segment.start, rowCount)
    const end = Math.min(segment.end, rowCount)
    if (start > cursor) out.push({ kind: 'spacer', row: cursor, rows: start - cursor })
    for (let row = Math.max(start, cursor); row < end; row++) out.push({ kind: 'row', row })
    cursor = Math.max(cursor, end)
  }
  if (cursor < rowCount) out.push({ kind: 'spacer', row: cursor, rows: rowCount - cursor })
  return out
}
