/** Focus keys, tab names and hooks shared by the overlay's components (kept out of them for React fast refresh). */
import { api } from '../api/client'
import type { Translate } from '../i18n'
import { createLog } from '../lib/log'
import { useSystemStore } from '../state/system'
import { useOverlayStore, type OverlayTab } from './overlayStore'

/** A tab's name in the current language (`t` from useT(), so the rail and the header follow a language change). */
export function tabLabel(t: Translate, tab: OverlayTab): string {
  const labels: Record<OverlayTab, string> = {
    performance: t('overlay.tabs.performance'),
    music: t('overlay.tabs.music'),
    display: t('overlay.tabs.display'),
    downloads: t('overlay.tabs.downloads'),
    friends: t('overlay.tabs.friends'),
    peerparty: t('overlay.tabs.peerparty'),
    settings: t('overlay.tabs.settings'),
    power: t('overlay.tabs.power')
  }
  return labels[tab]
}

export const RAIL_FOCUS_KEY = 'overlay:rail'
export const PANEL_FOCUS_KEY = 'overlay:panel'

/** The rail entry of a tab. */
export function railKey(tab: OverlayTab): string {
  return `${RAIL_FOCUS_KEY}:${tab}`
}

/** The running PlayOut game, as the overlay knows it: the performance status's, the overlay's, or the session's. */
export function useRunningGameId(): string | undefined {
  const fromPerformance = useOverlayStore((s) => s.performance?.gameId)
  const fromOverlay = useOverlayStore((s) => s.gameId)
  const fromSession = useSystemStore((s) => s.running?.gameId)
  return fromPerformance ?? fromOverlay ?? fromSession
}

const log = createLog('overlay')

/** Close the overlay; the main process gives the foreground back to the game. */
export function closeOverlay(): void {
  api.closeOverlay().catch((err) => log.error('closeOverlay failed', err))
}
