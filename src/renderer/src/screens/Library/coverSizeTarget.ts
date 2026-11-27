import { COVER_LARGER_KEY, COVER_SIZE_KEY, COVER_SMALLER_KEY } from './keys'

/**
 * D-pad left from the grid's first column: the part of the slider level with `y` (the card's middle), so a row beside
 * the track lands on the track (the diamond) and one beside − or + on that button. Null without a slider.
 */
export function coverSizeKeyAt(container: HTMLElement | null, y: number): string | null {
  if (!container) return null
  const parts: [string, string][] = [
    [COVER_SIZE_KEY, '.library__cover-size-track'],
    [COVER_SMALLER_KEY, '.library__cover-size-button:first-child'],
    [COVER_LARGER_KEY, '.library__cover-size-button:last-child']
  ]
  let best: string | null = null
  let bestDistance = Infinity
  for (const [key, selector] of parts) {
    const rect = container.querySelector(selector)?.getBoundingClientRect()
    if (!rect) continue
    const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
    // the track first: it wins a tie
    if (distance < bestDistance) {
      best = key
      bestDistance = distance
    }
  }
  return best
}
