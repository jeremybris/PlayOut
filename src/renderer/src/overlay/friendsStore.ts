import type { SteamFriendsStatus } from '@shared/friends'
import { friendsErrorText } from '@shared/friends'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { createLog } from '../lib/log'

const log = createLog('overlay-friends')

/** How often the open Friends tab reads the list again (main serves an answer under 30 s old from its cache). */
export const FRIENDS_POLL_MS = 60_000

/**
 * The Friends tab's list (docs/home-overlay.md, "Friends"). The last answer stays here while the tab is closed, so
 * opening it again shows it at once while the fresh one comes. Nothing reads Steam unless the tab is open: `watch`
 * runs only while it is mounted.
 */
export interface FriendsStoreState {
  status: SteamFriendsStatus | null
  /** A read is in flight. */
  busy: boolean
  /** Read the list (`force`: past main's 30 s cache, the Refresh action). */
  refresh(force?: boolean): Promise<void>
  /** Read now and every FRIENDS_POLL_MS until the returned stop is called (the tab unmounting). */
  watch(): () => void
}

/** Each call's number: only the newest one's answer is kept. */
let calls = 0

export const useFriendsStore = create<FriendsStoreState>()((set, get) => ({
  status: null,
  busy: false,
  async refresh(force = false) {
    const call = ++calls
    set({ busy: true })
    try {
      const status = await api.getSteamFriends(force ? { refresh: true } : undefined)
      if (call === calls) set({ status })
    } catch (err) {
      // getSteamFriends answers its errors itself; this is the IPC failing. The friends already shown stay.
      log.error('getSteamFriends failed', err)
      if (call === calls) {
        const previous = get().status
        set({
          status: {
            friends: previous?.friends ?? [],
            fetchedAt: previous?.fetchedAt ?? Date.now(),
            error: { code: 'network', message: friendsErrorText('network', t) }
          }
        })
      }
    } finally {
      if (call === calls) set({ busy: false })
    }
  },
  watch() {
    void get().refresh()
    const timer = setInterval(() => void get().refresh(), FRIENDS_POLL_MS)
    return () => clearInterval(timer)
  }
}))
