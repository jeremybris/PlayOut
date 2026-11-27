import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// PlayOut's language follows Settings > System > Language from the first render on.
import './i18n/followSettings'
import { initFocus } from './input/focus'
import { isIngameOverlay } from './overlay/ingame'
import { OverlayApp } from './overlay/OverlayApp'

// A link or file dropped onto the window must never navigate the document (the main process blocks it too).
for (const type of ['dragover', 'drop'] as const)
  document.addEventListener(type, (e) => e.preventDefault())

// The focus engine must exist before the first useFocusable effect registers a component.
initFocus()

/** `?overlay=1`: this page is the in-game overlay's transparent window (docs/home-overlay.md), not PlayOut's. */
function isOverlayWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('overlay') === '1'
  } catch {
    return false
  }
}

const overlay = isOverlayWindow()
// Before the first paint: the overlay's window is transparent and the page must not draw the app's background.
if (overlay) document.documentElement.classList.add('overlay-window')
// `&ingame=1`: the same overlay, rendered offscreen and drawn inside a full-screen game (overlay/ingame.ts).
if (overlay && isIngameOverlay()) document.documentElement.classList.add('overlay-ingame')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{overlay ? <OverlayApp /> : <App />}</StrictMode>
)
