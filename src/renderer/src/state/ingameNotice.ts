// The in-game overlay was turned off for a game after a crash or a fault (main/overlay/ingame/session.ts): the main
// window says so once, with the Borderless tip. The overlay pages (window and in-game) load the same bundle and ignore it.
import { api } from '../api/client'
import { useUiStore } from './ui'

const overlayPage =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('overlay') === '1'

if (!overlayPage) {
  api.on('overlay:ingame-notice', ({ message }) => {
    useUiStore.getState().toast(message, 'error', 10000)
  })
}
