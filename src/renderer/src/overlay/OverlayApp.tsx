import { peerPartyForOverlay } from '@shared/peerparty'
import { useEffect, type ReactElement } from 'react'
import { api, isMock } from '../api/client'
import { ToastHost } from '../components/Toast'
import { useActionHandlers } from '../hooks/useActionHandlers'
import { useT } from '../i18n'
import { initInput } from '../input'
import { FocusContext, isFocusWithin, setFocus, useFocusable } from '../input/focus'
import { createOverlayPadSource, setGamepadSource } from '../input/gamepad'
import { createLog } from '../lib/log'
import { useInstallQueueStore } from '../state/installQueue'
import { useInstallsStore } from '../state/installs'
import { useLibraryStore } from '../state/library'
import { refreshPeerPartySession, usePeerPartySession } from '../state/peerparty'
import { useSettingsStore } from '../state/settings'
import { useSystemStore } from '../state/system'
import { DisplayTab } from './DisplayTab'
import { FriendsTab } from './FriendsTab'
import { isIngameOverlay } from './ingame'
import { closeOverlay } from './shared'
import { MusicAudio } from './MusicAudio'
import { onGameStarted } from './musicPlayer'
import { OverlayHeader } from './OverlayHeader'
import { OverlayModals } from './OverlayModals'
import { railTabs, useOverlayStore, type OverlayTab } from './overlayStore'
import { OverlayRail } from './OverlayRail'
import { PANEL_FOCUS_KEY, RAIL_FOCUS_KEY, railKey, tabLabel } from './shared'
import { PeerPartyTab } from './PeerPartyTab'
import { PowerTab } from './PowerTab'
import { SettingsTab } from './SettingsTab'
import { DownloadsTab, MusicTab, PerformanceTab } from './tabs'
import './overlay.css'

const log = createLog('overlay-app')

/**
 * The overlay window's app (docs/home-overlay.md), mounted instead of App when the page has `?overlay=1`. The window
 * is transparent: the panel and the dim over the game are drawn here. It stays loaded while hidden, so the local
 * music player keeps playing; everything that polls stops while the overlay is closed.
 *
 * With `&ingame=1` it is the in-game overlay's offscreen page (overlay/ingame.ts): the pads come from PlayOut
 * ('overlay:pad'), and it has no music player of its own.
 */
export function OverlayApp(): ReactElement {
  const open = useOverlayStore((s) => s.open)
  const ingame = isIngameOverlay()

  useEffect(() => {
    // Before the input starts: the in-game page is never focused, so Chromium hands it no pads.
    const padSource = ingame ? createOverlayPadSource(api) : null
    if (padSource) setGamepadSource(padSource)
    const stopInput = initInput()
    const { refreshPerformance, setState } = useOverlayStore.getState()
    useSettingsStore
      .getState()
      .load()
      .then(() =>
        Promise.all([
          useLibraryStore.getState().refresh(),
          useSystemStore.getState().refresh(),
          // The Downloads tab: the queue and the active store install's progress (events keep both current).
          useInstallQueueStore.getState().refresh(),
          useInstallsStore.getState().refresh(),
          refreshPerformance(),
          api.getOverlayState().then(setState)
        ])
      )
      .catch((err) => log.error('initial load failed', err))
    // settings.music.gameStart: the game's playlist when a game starts (the overlay window is the player; the
    // in-game page is not).
    const offSession = ingame
      ? () => undefined
      : api.on('session:started', ({ gameId }) => void onGameStarted(gameId))
    return () => {
      offSession()
      stopInput()
      if (padSource) {
        setGamepadSource(null)
        padSource.dispose()
      }
    }
  }, [ingame])

  // Each open: fresh readings, and focus on the panel's first control.
  useEffect(() => {
    if (!open) return
    const { refreshPerformance, refreshDisplay } = useOverlayStore.getState()
    void refreshPerformance()
    void refreshDisplay()
    void useSystemStore.getState().refresh()
    // 'peerparty:session' keeps the PeerParty entry current; asked again here in case one was missed.
    refreshPeerPartySession()
    // 'settings:changed' keeps the store current (state/settings.ts); reading them again here is the fallback
    // for an event missed while the window was being created.
    void useSettingsStore.getState().load()
    // After the panel's focusables have registered (they mount with the open state).
    const frame = requestAnimationFrame(() => void setFocus(PANEL_FOCUS_KEY))
    return () => cancelAnimationFrame(frame)
  }, [open])

  usePeerPartyRail()

  useActionHandlers(
    {
      // B / Escape at the top level (drawers and dialogs are layers of their own and take B first).
      back: () => closeOverlay(),
      lb: () => stepTab(-1),
      rb: () => stepTab(1)
    },
    open
  )

  return (
    <>
      {ingame ? null : <MusicAudio />}
      {isMock ? <MockGame /> : null}
      {open ? <OverlayView /> : isMock ? <MockReopen /> : null}
      <OverlayModals />
      <ToastHost />
    </>
  )
}

/** LB / RB: the previous / next tab, with focus on its rail entry so the panel follows. */
function stepTab(delta: 1 | -1): void {
  const { tab, setTab, peerParty } = useOverlayStore.getState()
  const tabs = railTabs(peerParty)
  const index = tabs.indexOf(tab)
  const next = tabs[(index + delta + tabs.length) % tabs.length]!
  setTab(next)
  void setFocus(railKey(next))
}

/**
 * The rail's PeerParty entry (docs/home-overlay.md, "PeerParty"): shown in Friends' place while the game under the
 * overlay (or any game, when the overlay is over none) runs through PeerParty, following 'peerparty:session'. A
 * session starting or ending while the user is on one of the two moves them to the other, with the focus on its rail
 * entry (the panel or rail entry they were on is gone).
 */
function usePeerPartyRail(): void {
  const session = usePeerPartySession()
  const gameId = useOverlayStore((s) => s.gameId)
  const program = useOverlayStore((s) => s.program)
  const active = peerPartyForOverlay(session, {
    ...(gameId ? { gameId } : {}),
    ...(program ? { program } : {})
  })
  useEffect(() => {
    const { tab: before, setPeerParty } = useOverlayStore.getState()
    const focusOnTab = isFocusWithin(RAIL_FOCUS_KEY) || isFocusWithin(PANEL_FOCUS_KEY)
    setPeerParty(active)
    const { tab: after, open } = useOverlayStore.getState()
    if (after === before || !open || !focusOnTab) return
    // After the new rail entry has mounted.
    const frame = requestAnimationFrame(() => void setFocus(railKey(after)))
    return () => cancelAnimationFrame(frame)
  }, [active])
}

function OverlayView(): ReactElement {
  const tab = useOverlayStore((s) => s.tab)
  return (
    <div className="ov">
      <div className="ov-dim" onClick={closeOverlay} aria-hidden="true" />
      <div className="ov-shell">
        <OverlayRail />
        <OverlayPanel tab={tab} />
      </div>
    </div>
  )
}

function OverlayPanel({ tab }: { tab: OverlayTab }): ReactElement {
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: PANEL_FOCUS_KEY,
    trackChildren: true,
    // Entering the panel (opening, or right from the rail) always starts at its first control.
    saveLastFocusedChild: false
  })
  const t = useT()
  const title = tabLabel(t, tab)
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="ov-panel" role="region" aria-label={title}>
        <OverlayHeader title={title} />
        {/* Keyed by tab: a new tab starts scrolled to the top. */}
        <div key={tab} className="ov-panel__body">
          {tab === 'performance' ? <PerformanceTab active /> : null}
          {tab === 'music' ? <MusicTab active /> : null}
          {tab === 'display' ? <DisplayTab /> : null}
          {tab === 'downloads' ? <DownloadsTab /> : null}
          {tab === 'friends' ? <FriendsTab /> : null}
          {tab === 'peerparty' ? <PeerPartyTab /> : null}
          {tab === 'settings' ? <SettingsTab /> : null}
          {tab === 'power' ? <PowerTab /> : null}
        </div>
      </div>
    </FocusContext.Provider>
  )
}

/**
 * Browser preview only: the running game's art stands in for the game the real overlay window is transparent over,
 * so the dim and the panel's glass can be judged.
 */
function MockGame(): ReactElement | null {
  const gameId = useSystemStore((s) => s.running?.gameId)
  const art = useLibraryStore((s) => {
    const game = gameId ? s.byId.get(gameId) : undefined
    return game?.media.hero ?? game?.media.screenshots?.[0]
  })
  return art ? <img className="ov-mock-game" src={art} alt="" /> : null
}

/** Browser preview only (`?mock=1&overlay=1`): the real window is hidden when closed, the page is not. */
function MockReopen(): ReactElement {
  return (
    <button type="button" className="ov-mock-reopen" onClick={() => void api.openOverlay()}>
      Open the overlay (mock)
    </button>
  )
}
