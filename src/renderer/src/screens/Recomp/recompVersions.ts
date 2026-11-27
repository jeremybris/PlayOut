// The releases of a recompilation and Back to latest, for VersionManager.tsx (the Recompilation page and Settings ›
// Recompilations).
import type { RecompEntry, RecompRelease } from '@shared/recomp'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { t } from '../../i18n'
import { createLog } from '../../lib/log'
import type { UiState } from '../../state/ui'

const log = createLog('recomp')

/** Reports a failed call: (what failed, the words when the error has none) -> the catch handler. */
export type FailHandler = (what: string, fallback: string) => (err: unknown) => void

export type Entry = Pick<RecompEntry, 'id' | 'name' | 'repoUrl'>

export type ReleasesState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: RecompRelease[] }

/** The project's releases (newest first), read while `enabled`; `retry` reads them again after a failure. */
export function useRecompReleases(
  id: string,
  enabled: boolean
): { releases: ReleasesState; retry: () => void } {
  const [releases, setReleases] = useState<ReleasesState>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    api
      .getRecompReleases(id)
      .then((list) => {
        if (!cancelled) setReleases({ status: 'ready', value: list })
      })
      .catch((err) => {
        log.warn('getRecompReleases failed', err)
        if (!cancelled) setReleases({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [id, enabled, tick])
  return {
    releases,
    retry: () => {
      setReleases({ status: 'loading' })
      setTick((n) => n + 1)
    }
  }
}

/** Back to latest: install the newest release, and the pin goes. */
export function backToLatest(entry: Entry, toast: UiState['toast'], fail: FailHandler): void {
  api
    .setRecompVersion(entry.id, null)
    .then(() => toast(t('recomp.version.installingLatest', { name: entry.name }), 'info'))
    .catch(fail('setRecompVersion', t('recomp.version.updateFailed', { name: entry.name })))
}
