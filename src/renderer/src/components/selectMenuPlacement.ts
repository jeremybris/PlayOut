import type { CSSProperties } from 'react'

/**
 * Where a SelectField-style popup list goes (SelectField's pill popup, the Edit sheet's Genres & Tags dropdown). Kept
 * out of the component files so React fast-refresh keeps working.
 */

/** Gap between the anchor and the popup, in canvas units. */
const MENU_GAP_U = 8
/** Estimated popup height per option and padding, in canvas units (placement only; the list scrolls). */
const MENU_ITEM_U = 60
const MENU_PAD_U = 24
/**
 * Kept clear at the top of the window by a list that opens upward: the status bar (clock, battery, Wi-Fi) floats
 * there over the game page and the Edit sheet, and would cover the list's first rows.
 */
const TOP_INSET_U = 130

/**
 * Popup position: left-aligned with and at least as wide as its anchor (the pill, or the Edit sheet's Genres & Tags
 * field); below it unless above has more room. Never taller than that room (less a gap at the window's edge): a
 * long list scrolls inside it (.select-menu > .menu) instead of running off the window.
 */
export function placeSelectMenu(
  anchor: HTMLElement,
  count: number
): { style: CSSProperties; above: boolean } {
  const rect = anchor.getBoundingClientRect()
  const unit = window.innerHeight / 1080
  const gap = MENU_GAP_U * unit
  const estimate = Math.min(
    count * MENU_ITEM_U * unit + MENU_PAD_U * unit,
    window.innerHeight * 0.8
  )
  const below = window.innerHeight - rect.bottom - gap
  const upward = rect.top - gap - TOP_INSET_U * unit
  const above = below < estimate && upward > below
  const room = (above ? upward : below) - gap
  const style: CSSProperties = {
    left: Math.round(rect.left),
    minWidth: Math.round(rect.width),
    // At least a few rows, should the anchor sit at the very edge.
    maxHeight: Math.round(
      Math.min(window.innerHeight * 0.8, Math.max(room, 3 * MENU_ITEM_U * unit + MENU_PAD_U * unit))
    )
  }
  if (above) style.bottom = Math.round(window.innerHeight - rect.top + gap)
  else style.top = Math.round(rect.bottom + gap)
  return { style, above }
}
