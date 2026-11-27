import type { VrModProgress } from '@shared/vr-mods'
import { create } from 'zustand'
import { api } from '../api/client'

/**
 * VR mods as main reports them: downloads in progress ('vr-mods:progress', by mod id; a finished one stays until
 * replaced, so its warning or error can be shown), and a counter bumped on 'vr-mods:changed' that views re-read
 * their data on.
 */
export const useVrModsStore = create<{
  progress: Record<string, VrModProgress>
  version: number
}>()(() => ({ progress: {}, version: 0 }))

api.on('vr-mods:progress', (p) =>
  useVrModsStore.setState((s) => ({ progress: { ...s.progress, [p.id]: p } }))
)
api.on('vr-mods:changed', () => useVrModsStore.setState((s) => ({ version: s.version + 1 })))

/** Whether a download of `id` is queued or running. */
export function vrModBusy(p: VrModProgress | undefined): boolean {
  return !!p && p.phase !== 'done' && p.phase !== 'failed'
}

/** Forget `id`'s last download report (after it was removed, so an old warning or error is not shown on it). */
export function clearVrModProgress(id: string): void {
  useVrModsStore.setState((s) => {
    if (!(id in s.progress)) return s
    const next = { ...s.progress }
    delete next[id]
    return { progress: next }
  })
}
