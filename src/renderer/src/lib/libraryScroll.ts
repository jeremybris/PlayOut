import type { Game, LibraryScrollPosition } from '@shared/types'

/**
 * A Library tab's scroll position (pure). Saved as the game at the start of the top visible row and how far the view
 * was past that row's top, not as pixels: the window may have another width next time (other columns), and games may
 * have been added or removed above, yet the same games are back at the top.
 */

/** The grid's row geometry: card height plus the row gap, and the viewport's padding above the first row (px). */
export interface RowGeometry {
  rowStride: number
  paddingTop: number
}

/** Where `scrollTop` is, as a saved position; null at the top (nothing to remember). */
export function scrollAnchor(
  games: readonly Game[],
  columns: number,
  geometry: RowGeometry,
  scrollTop: number
): LibraryScrollPosition | null {
  const { rowStride, paddingTop } = geometry
  if (scrollTop <= 1 || rowStride <= 0 || columns <= 0 || games.length === 0) return null
  const row = Math.max(0, Math.floor((scrollTop - paddingTop) / rowStride))
  const game = games[Math.min(games.length - 1, row * columns)]
  if (!game) return null
  const offset = Math.max(0, scrollTop - (paddingTop + row * rowStride))
  return { gameId: game.id, offset: Math.round(offset) }
}

/**
 * The scrollTop that shows `position` again: the row now holding its game, plus the offset (at most one row, in case
 * the cards got smaller). null when the game is no longer in the tab (the tab then opens as before).
 */
export function scrollTopFor(
  position: LibraryScrollPosition,
  indexOf: ReadonlyMap<string, number>,
  columns: number,
  geometry: RowGeometry
): number | null {
  const index = indexOf.get(position.gameId)
  if (index === undefined || columns <= 0 || geometry.rowStride <= 0) return null
  const row = Math.floor(index / columns)
  return (
    geometry.paddingTop + row * geometry.rowStride + Math.min(position.offset, geometry.rowStride)
  )
}

/** The rows wholly inside the viewport at `scrollTop` (first <= last; first may equal last when only one fits). */
export function visibleRows(
  scrollTop: number,
  viewportHeight: number,
  geometry: RowGeometry,
  rowCount: number
): { first: number; last: number } {
  const { rowStride, paddingTop } = geometry
  if (rowStride <= 0 || rowCount <= 0) return { first: 0, last: 0 }
  const first = Math.max(0, Math.ceil((scrollTop - paddingTop) / rowStride))
  // A row counts as visible when its card fits; the gap below the last card may be cut off.
  const last = Math.floor((scrollTop + viewportHeight - paddingTop) / rowStride) - 1
  const clampedFirst = Math.min(first, rowCount - 1)
  return { first: clampedFirst, last: Math.max(clampedFirst, Math.min(last, rowCount - 1)) }
}

/**
 * The card to focus when a tab opens scrolled: its remembered card when that is on screen, else the first card of the
 * top visible row, so focusing it does not scroll the view away from where it was left.
 */
export function focusTargetAfterScroll(
  games: readonly Game[],
  columns: number,
  remembered: string | null,
  indexOf: ReadonlyMap<string, number>,
  rows: { first: number; last: number }
): string | null {
  if (games.length === 0 || columns <= 0) return null
  const index = remembered === null ? undefined : indexOf.get(remembered)
  if (index !== undefined) {
    const row = Math.floor(index / columns)
    if (row >= rows.first && row <= rows.last) return remembered
  }
  return games[Math.min(games.length - 1, rows.first * columns)]?.id ?? null
}
