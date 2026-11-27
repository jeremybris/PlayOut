import type { PeerPartyInviteResult, PeerPartyOverlayStatus } from '@shared/peerparty'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { createLog } from '../lib/log'

const log = createLog('overlay-peerparty')

/** How often the open PeerParty tab reads the LAN status and the player count again. */
export const PEERPARTY_POLL_MS = 5000

/**
 * The PeerParty tab's status and its last invite (docs/home-overlay.md, "PeerParty"). Nothing is read unless the tab
 * is open: `watch` runs only while it is mounted.
 */
export interface PeerPartyStoreState {
  status: PeerPartyOverlayStatus | null
  /** An invite is waiting for its answer. */
  inviting: boolean
  /** The last invite's answer, shown under the button until the tab is opened again. */
  invite: PeerPartyInviteResult | null
  refresh(): Promise<void>
  /** Read now and every PEERPARTY_POLL_MS until the returned stop is called (the tab unmounting). */
  watch(): () => void
  /** "Invite everyone on the LAN". */
  sendInvite(): Promise<void>
}

/** Each read's number: only the newest one's answer is kept. */
let calls = 0

export const usePeerPartyOverlayStore = create<PeerPartyStoreState>()((set, get) => ({
  status: null,
  inviting: false,
  invite: null,
  async refresh() {
    const call = ++calls
    try {
      const status = await api.peerPartyOverlay()
      if (call === calls) set({ status })
    } catch (err) {
      // The status shown stays; the next tick tries again.
      log.error('peerPartyOverlay failed', err)
    }
  },
  watch() {
    // A new open starts at "Checking PeerParty…", never with the last open's game, LAN state or count.
    set({ invite: null, status: null })
    void get().refresh()
    const timer = setInterval(() => void get().refresh(), PEERPARTY_POLL_MS)
    return () => {
      clearInterval(timer)
      // Cleared on close too, so the next open's first paint (before its watch runs) shows nothing old, and a read
      // still in flight cannot land after it.
      calls++
      set({ status: null })
    }
  },
  async sendInvite() {
    if (get().inviting) return
    set({ inviting: true, invite: null })
    try {
      set({ invite: await api.peerPartyInvite() })
    } catch (err) {
      log.error('peerPartyInvite failed', err)
      set({ invite: { result: 'error', message: t('overlay.peerParty.inviteFailed') } })
    } finally {
      set({ inviting: false })
    }
  }
}))
