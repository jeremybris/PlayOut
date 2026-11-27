import type { DisplayMode, DisplayStatus, OverlayState, PerformanceStatus } from '@shared/overlay'
import type {
  IntelGraphicsStatus,
  LiveStats,
  OverlayExtrasStatus,
  PerfOverlayLevel
} from '@shared/overlay-extras'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { createLog } from '../lib/log'
import { useUiStore } from '../state/ui'
import { isIngameOverlay } from './ingame'
import type { ProfileChoice } from './text'

const log = createLog('overlay')

/**
 * The in-game overlay (overlay/ingame.ts) closes before anything that needs the desktop (an elevation prompt): inside
 * a full-screen game it would be hidden behind the game. The window overlay stays open.
 */
function closeIngameOverlay(): void {
  if (!isIngameOverlay()) return
  api.closeOverlay().catch((err) => log.error('closeOverlay failed', err))
}

export type OverlayTab =
  'performance' | 'music' | 'display' | 'downloads' | 'friends' | 'peerparty' | 'settings' | 'power'
/** The rail's order, top to bottom: LB / RB step through it. PeerParty takes Friends' place (railTabs). */
export const OVERLAY_TABS: readonly OverlayTab[] = [
  'performance',
  'music',
  'display',
  'downloads',
  'friends',
  'settings',
  'power'
]
const PEERPARTY_TABS: readonly OverlayTab[] = OVERLAY_TABS.map((t) =>
  t === 'friends' ? 'peerparty' : t
)

/**
 * The rail's tabs: while the game under the overlay runs through PeerParty, its PeerParty tab stands where Friends
 * is (docs/home-overlay.md, "PeerParty"), and the Steam Friends tab is not shown.
 */
export function railTabs(peerParty: boolean): readonly OverlayTab[] {
  return peerParty ? PEERPARTY_TABS : OVERLAY_TABS
}

/** The tab to show when PeerParty's entry comes or goes: the user on one of the two is moved to the other. */
export function tabForRail(tab: OverlayTab, peerParty: boolean): OverlayTab {
  if (peerParty && tab === 'friends') return 'peerparty'
  if (!peerParty && tab === 'peerparty') return 'friends'
  return tab
}

/** The quick tiles' filter chips on the Performance tab. */
export type TileFilter = 'all' | 'display' | 'game' | 'sound' | 'system'

/**
 * The overlay window's own state: whether it is open (and over what), the tab, and the performance and display
 * readings it shows. PlayOut's other stores (settings, library, system) are shared with the main window's code.
 */
export interface OverlayStoreState extends OverlayState {
  tab: OverlayTab
  /** The game under the overlay runs through PeerParty: the rail shows PeerParty in Friends' place (railTabs). */
  peerParty: boolean
  filter: TileFilter
  performance: PerformanceStatus | null
  display: DisplayStatus | null
  /** getDisplayStatus answered null (no display control on this PC) or failed. */
  displayUnavailable: boolean
  /** The Game tiles' state (frame limit, sync, performance overlay, Auto HDR, CPU boost); null until read. */
  extras: OverlayExtrasStatus | null
  /** The last getOverlayExtras failed and no reading came since (the Game group says so instead of "Checking…"). */
  extrasUnavailable: boolean
  /** The header's live fps and watts, polled while the overlay is open; null when the last read failed. */
  live: LiveStats | null
  /** The Intel graphics driver's settings (Endurance Gaming); null until read or on a PC without the driver. */
  intel: IntelGraphicsStatus | null
  setState(state: OverlayState): void
  setTab(tab: OverlayTab): void
  /** A PeerParty session starting or ending under the overlay (OverlayApp follows 'peerparty:session'). */
  setPeerParty(active: boolean): void
  setFilter(filter: TileFilter): void
  refreshPerformance(): Promise<void>
  refreshDisplay(): Promise<void>
  refreshExtras(): Promise<void>
  refreshLive(): Promise<void>
  refreshIntel(): Promise<void>
  applyProfile(
    profile: ProfileChoice,
    forGame?: string | null,
    options?: { targetFps?: number }
  ): Promise<void>
  installHelper(): Promise<void>
  removeHelper(): Promise<void>
  setDisplayMode(mode: DisplayMode): Promise<void>
  /** 0 = unlimited. */
  setFrameLimit(fps: number): Promise<void>
  setFrameLimitSync(enabled: boolean): Promise<void>
  setPerfOverlayLevel(level: PerfOverlayLevel): Promise<void>
  setAutoHdr(enabled: boolean): Promise<void>
  setCpuBoost(enabled: boolean): Promise<void>
  /** One of intel.enduranceGaming.options[].key. */
  setEnduranceGaming(value: string): Promise<void>
}

const toastError = (text: string): void => {
  useUiStore.getState().toast(text, 'error')
}

/** Bumped at every close: a getLiveStats answer from an earlier open is dropped. */
let liveGeneration = 0
/**
 * The getLiveStats call in flight (0: none): the next poll tick is skipped, so readings never land out of order. Each
 * call has its own number; only the newest one's answer is used.
 */
let liveCall = 0
let liveCalls = 0
/** When the call in flight started (Date.now()). */
let liveCallAt = 0

/**
 * How long a getLiveStats call may stay unanswered before the next poll tick stops waiting for it (ms): a call that
 * never answers would otherwise end the polling for good. Its answer, should it still come, is dropped.
 */
export const LIVE_STATS_TIMEOUT_MS = 5000

/**
 * The main process rejects an extras change with a sentence for the user ("Needs RivaTuner Statistics Server"); show
 * it, or `fallback` when the error carries none.
 */
const toastFailure = (fallback: string, err: unknown): void => {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron wraps a rejected invoke: "Error invoking remote method 'x': Error: <message>".
  const message = raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '').trim()
  // Only a sentence reads well in a toast: a validation dump or a TypeError from a bug shows the fallback.
  const readable =
    !(err instanceof Error && err.name !== 'Error') &&
    message.length > 0 &&
    message.length <= 160 &&
    !/[\n{[]|^\w*Error\b|^undefined$/.test(message)
  toastError(readable ? message : fallback)
}

export const useOverlayStore = create<OverlayStoreState>()((set, get) => {
  /** Run an extras change: keep the status it answers, or toast why it failed. */
  const changeExtras = async (
    what: string,
    fallback: string,
    run: () => Promise<OverlayExtrasStatus>
  ): Promise<void> => {
    try {
      set({ extras: await run() })
    } catch (err) {
      log.error(`${what} failed`, err)
      toastFailure(fallback, err)
    }
  }

  return {
    open: false,
    tab: 'performance',
    peerParty: false,
    filter: 'all',
    performance: null,
    display: null,
    displayUnavailable: false,
    extras: null,
    extrasUnavailable: false,
    live: null,
    intel: null,
    setState(incoming) {
      // Each page shows only its own overlay: the window overlay's page stays closed while the overlay is drawn
      // inside a game, and the in-game page while the window overlay is up.
      const mine = isIngameOverlay() ? incoming.ingame === true : incoming.ingame !== true
      const state: OverlayState = mine ? incoming : { open: false }
      const opening = state.open && !get().open
      // Replace the whole OverlayState: a program the overlay opened over last time must not linger.
      set({
        open: state.open,
        gameId: state.gameId,
        program: state.program,
        paused: state.paused === true
      })
      // Closing ends every dialog (Quit game, Shut down, Restart): one left open would come back at the next open,
      // over a different game, and act on it. The drawers and the Custom editor live in the panel, which unmounts.
      if (!state.open) useUiStore.getState().closeAll()
      // Each open: the Game tiles' state, alongside the performance and display readings OverlayApp fetches.
      if (opening) {
        void get().refreshExtras()
        void get().refreshIntel()
      }
      // A reading from the last open must not show in the chips before the first poll answers, nor arrive after it.
      if (!state.open) {
        liveGeneration++
        set({ live: null })
      }
    },
    setTab(tab) {
      // A tab the rail does not show (Friends while PeerParty stands in its place) shows its stand-in.
      set({ tab: tabForRail(tab, get().peerParty) })
    },
    setPeerParty(active) {
      set({ peerParty: active, tab: tabForRail(get().tab, active) })
    },
    setFilter(filter) {
      set({ filter })
    },
    async refreshPerformance() {
      try {
        set({ performance: await api.getPerformanceStatus() })
      } catch (err) {
        log.error('getPerformanceStatus failed', err)
      }
    },
    async refreshDisplay() {
      try {
        const display = await api.getDisplayStatus()
        set({ display, displayUnavailable: display === null })
      } catch (err) {
        log.error('getDisplayStatus failed', err)
        set({ displayUnavailable: true })
      }
    },
    async refreshExtras() {
      try {
        set({ extras: await api.getOverlayExtras(), extrasUnavailable: false })
      } catch (err) {
        log.error('getOverlayExtras failed', err)
        set({ extrasUnavailable: true })
      }
    },
    async refreshLive() {
      const now = Date.now()
      if (liveCall !== 0) {
        if (now - liveCallAt < LIVE_STATS_TIMEOUT_MS) return
        log.warn('getLiveStats did not answer in time; polling again')
      }
      const call = ++liveCalls
      liveCall = call
      liveCallAt = now
      const generation = liveGeneration
      try {
        const live = await api.getLiveStats()
        // An answer that came after its call was given up is dropped: a newer call's reading is (or will be) shown.
        if (call === liveCall && generation === liveGeneration && get().open) set({ live })
      } catch (err) {
        log.error('getLiveStats failed', err)
        if (call === liveCall && generation === liveGeneration) set({ live: null })
      } finally {
        if (call === liveCall) liveCall = 0
      }
    },
    async refreshIntel() {
      try {
        set({ intel: await api.getIntelGraphics() })
      } catch (err) {
        log.error('getIntelGraphics failed', err)
      }
    },
    async applyProfile(profile, forGame, options) {
      try {
        set({ performance: await api.applyPowerProfile(profile, forGame, options) })
      } catch (err) {
        log.error(`applyPowerProfile(${profile}) failed`, err)
        toastError(t('overlay.profiles.failed'))
      }
    },
    async installHelper() {
      // Windows' elevation prompt needs the desktop: inside a full-screen game the overlay closes first.
      closeIngameOverlay()
      try {
        set({ performance: await api.installPowerHelper() })
      } catch (err) {
        log.error('installPowerHelper failed', err)
        toastError(t('overlay.profiles.installFailed'))
      }
    },
    async removeHelper() {
      closeIngameOverlay()
      try {
        set({ performance: await api.removePowerHelper() })
      } catch (err) {
        log.error('removePowerHelper failed', err)
        toastError(t('overlay.profiles.removeFailed'))
      }
    },
    async setDisplayMode(mode) {
      try {
        const display = await api.setDisplayMode(mode)
        set({ display, displayUnavailable: display === null })
      } catch (err) {
        log.error('setDisplayMode failed', err)
        toastError(t('overlay.display.failed'))
      }
    },
    setFrameLimit(fps) {
      return changeExtras(`setFrameLimit(${fps})`, t('overlay.extras.frameLimit.failed'), () =>
        api.setFrameLimit(fps)
      )
    },
    setFrameLimitSync(enabled) {
      return changeExtras(`setFrameLimitSync(${enabled})`, t('overlay.extras.sync.failed'), () =>
        api.setFrameLimitSync(enabled)
      )
    },
    setPerfOverlayLevel(level) {
      return changeExtras(
        `setPerfOverlayLevel(${level})`,
        t('overlay.extras.perfOverlay.failed'),
        () => api.setPerfOverlayLevel(level)
      )
    },
    setAutoHdr(enabled) {
      return changeExtras(`setAutoHdr(${enabled})`, t('overlay.extras.autoHdr.failed'), () =>
        api.setAutoHdr(enabled)
      )
    },
    setCpuBoost(enabled) {
      return changeExtras(`setCpuBoost(${enabled})`, t('overlay.extras.cpuBoost.failed'), () =>
        api.setCpuBoost(enabled)
      )
    },
    async setEnduranceGaming(value) {
      try {
        const intel = await api.setEnduranceGaming(value)
        set({ intel })
        const reason = intel.enduranceGaming?.reason
        if (reason) toastError(reason)
      } catch (err) {
        log.error(`setEnduranceGaming(${value}) failed`, err)
        toastFailure(t('overlay.extras.endurance.failed'), err)
      }
    }
  }
})

api.on('overlay:state', (state) => useOverlayStore.getState().setState(state))
api.on('performance:status', (performance) => useOverlayStore.setState({ performance }))
api.on('overlay:extras', (extras) => useOverlayStore.setState({ extras, extrasUnavailable: false }))
