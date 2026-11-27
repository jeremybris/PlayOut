/**
 * The in-game overlay's page (docs/home-overlay.md, "In-game overlay"): `?overlay=1&ingame=1`. PlayOut renders it
 * offscreen and the game draws it inside its own frames, alpha-blended over them, so the page differs from the
 * window overlay's in a few ways:
 *
 * - it is never focused and Chromium gives it no pads: it reads the pads PlayOut sends ('overlay:pad');
 * - no local music player (the window overlay's page stays the one player; this page shows Windows' media only);
 * - no backdrop blur (there is nothing behind an offscreen page to blur): the panels are near-opaque instead;
 * - anything that needs a desktop window (a folder picker, an elevation prompt) closes the overlay first.
 */

/** Whether a page's query string asks for the in-game overlay (both `overlay=1` and `ingame=1`). */
export function isIngameQuery(search: string): boolean {
  try {
    const params = new URLSearchParams(search)
    return params.get('overlay') === '1' && params.get('ingame') === '1'
  } catch {
    return false
  }
}

let cached: boolean | null = null

/** Whether this page is the in-game overlay (read once from the page's URL). */
export function isIngameOverlay(): boolean {
  if (cached === null) {
    cached =
      typeof window !== 'undefined' && !!window.location && isIngameQuery(window.location.search)
  }
  return cached
}
