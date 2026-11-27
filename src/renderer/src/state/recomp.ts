import type { RecompProgress } from '@shared/recomp'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'

/**
 * Recompilations as main reports them: installs / updates in progress ('recomp:progress', by entry id; a finished
 * one stays until replaced, so its warning or error can be shown), and a counter bumped on 'recomp:changed' that
 * views re-read their data on.
 */
export const useRecompStore = create<{
  progress: Record<string, RecompProgress>
  version: number
}>()(() => ({ progress: {}, version: 0 }))

api.on('recomp:progress', (p) =>
  useRecompStore.setState((s) => ({ progress: { ...s.progress, [p.id]: p } }))
)
api.on('recomp:changed', () => useRecompStore.setState((s) => ({ version: s.version + 1 })))

/** Whether an install / update of `id` is queued or running. */
export function recompBusy(p: RecompProgress | undefined): boolean {
  return !!p && p.phase !== 'done' && p.phase !== 'failed'
}

/**
 * Forget `id`'s last install / update report, so a warning or error from a version that has since been uninstalled
 * is not shown on it (main drops its own copy on uninstall but sends no progress event for it).
 */
export function clearRecompProgress(id: string): void {
  useRecompStore.setState((s) => {
    if (!(id in s.progress)) return s
    const next = { ...s.progress }
    delete next[id]
    return { progress: next }
  })
}

/**
 * Settles when the install / update of `id` started after `before` (the report held when it was started, so an
 * older finished report is not taken for this one) finishes: resolves with the 'done' report, rejects on 'failed'
 * with main's message.
 */
export function whenRecompFinished(
  id: string,
  before: RecompProgress | undefined
): Promise<RecompProgress> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null
    let settled = false
    const check = (p: RecompProgress | undefined): void => {
      if (settled || !p || p === before || recompBusy(p)) return
      settled = true
      unsubscribe?.()
      if (p.phase === 'done') resolve(p)
      else reject(new Error(p.message || t('state.recomp.notFinished')))
    }
    unsubscribe = useRecompStore.subscribe((s) => check(s.progress[id]))
    check(useRecompStore.getState().progress[id])
    if (settled) unsubscribe()
  })
}
