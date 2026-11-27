// The Upgrade menu's live progress (main upgrades/ emits 'upgrades:progress'): what is running for which game, and a
// toast when an upgrade finishes or fails, whether or not its menu is still open.
import type { UpgradeProgress } from '@shared/upgrades'
import { create } from 'zustand'
import { api } from '../api/client'
import { useUiStore } from './ui'

interface UpgradesState {
  /** The latest progress per game (kept after it ends, so a reopened menu shows the outcome line). */
  progress: Record<string, UpgradeProgress>
}

export const useUpgradesStore = create<UpgradesState>(() => ({ progress: {} }))

let started = false

/** Listen once for the app's lifetime; later calls do nothing. */
export function startUpgradeProgress(): void {
  if (started) return
  started = true
  api.on('upgrades:progress', (p) => {
    useUpgradesStore.setState((s) => ({ progress: { ...s.progress, [p.gameId]: p } }))
    if (p.state === 'done') useUiStore.getState().toast(p.message, 'success')
    else if (p.state === 'failed') useUiStore.getState().toast(p.message, 'error')
  })
}

/** The game's latest upgrade progress, if any. */
export function useUpgradeProgress(gameId: string): UpgradeProgress | undefined {
  return useUpgradesStore((s) => s.progress[gameId])
}
