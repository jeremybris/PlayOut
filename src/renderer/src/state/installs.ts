import type { InstallProgress } from '@shared/types'
import { create } from 'zustand'
import { api } from '../api/client'
import { createLog } from '../lib/log'

const log = createLog('installs')

/**
 * Background installs PlayOut tracks (ARCHITECTURE.md §4.8): gameId -> the latest InstallProgress. Filled by
 * getInstalls() when the app loads (a reloaded renderer restores its bars) and by every 'install:progress'
 * event. A `done` install stays in the map until the library snapshot shows the game installed (the detail
 * panel shows a disabled Play meanwhile, never a second Install button); a `failed` one stays until the user
 * retries or stops tracking, so the panel can show the message and a Retry button. App.tsx raises the done /
 * failed toasts.
 */
export interface InstallsState {
  installs: Map<string, InstallProgress>
  loaded: boolean
  refresh(): Promise<void>
  /** Forget one install locally (after cancelInstallTracking, or when a failed one is retried). */
  remove(gameId: string): void
  /** Drop the `done` entries whose game the library now reports installed (or no longer knows). */
  pruneDone(installed: (gameId: string) => boolean | undefined): void
}

export const useInstallsStore = create<InstallsState>()((set, get) => ({
  installs: new Map(),
  loaded: false,
  async refresh() {
    try {
      const list = await api.getInstalls()
      set({ installs: new Map(list.map((p) => [p.gameId, p])), loaded: true })
    } catch (err) {
      log.error('getInstalls failed', err)
      set({ loaded: true })
    }
  },
  remove(gameId) {
    if (!get().installs.has(gameId)) return
    const installs = new Map(get().installs)
    installs.delete(gameId)
    set({ installs })
  },
  pruneDone(installed) {
    let installs: Map<string, InstallProgress> | null = null
    for (const [gameId, progress] of get().installs) {
      if (progress.state !== 'done' || installed(gameId) === false) continue
      installs ??= new Map(get().installs)
      installs.delete(gameId)
    }
    if (installs) set({ installs })
  }
}))

api.on('install:progress', (progress) => {
  const installs = new Map(useInstallsStore.getState().installs)
  installs.set(progress.gameId, progress)
  useInstallsStore.setState({ installs })
})

/** React hook: the tracked install of one game, if any (re-renders only when that entry changes). */
export function useInstallProgress(gameId: string | null | undefined): InstallProgress | undefined {
  return useInstallsStore((s) => (gameId ? s.installs.get(gameId) : undefined))
}

/** Percent 0-100 of a progress entry, or null when the bar is indeterminate. */
export function installPercent(
  progress: Pick<InstallProgress, 'percent'> | null | undefined
): number | null {
  if (!progress || progress.percent === undefined || !Number.isFinite(progress.percent)) return null
  return Math.max(0, Math.min(100, progress.percent))
}

/**
 * True for a store install the store stopped moving for a while (main sets `stalled` with its stalledMessage, "No
 * progress from <Store> for 30 minutes; it may be paused there" in the user's language): it is not failed and keeps
 * its turn in the queue; the progress line shows that message in place of the bytes so the last percent does not read
 * as live progress.
 */
export function installStalled(
  progress: Pick<InstallProgress, 'state' | 'stalled'> | null | undefined
): boolean {
  return (
    !!progress &&
    progress.state !== 'failed' &&
    progress.state !== 'done' &&
    progress.stalled === true
  )
}

export { formatBytes } from '../lib/format'
