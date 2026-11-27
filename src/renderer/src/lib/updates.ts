import type { UpdateStatus } from '@shared/types'
import { t } from '../i18n'

export type UpdateAction = 'check' | 'download' | 'install' | 'release' | null

export interface UpdateView {
  /** One button that follows the steps, so D-pad focus stays on it from the check to the restart. */
  label: string
  action: UpdateAction
  text: string
  /** Null: no bar. A percent, or 'indeterminate' while the length of the step is unknown. */
  progress: number | 'indeterminate' | null
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

/** What the Settings > About row shows for an update status. */
export function updateView(status: UpdateStatus): UpdateView {
  const check = { label: t('lib.updates.check'), action: 'check', progress: null } as const
  const version = status.version ?? t('lib.updates.unknownVersion')
  switch (status.state) {
    case 'idle':
      return { ...check, text: t('lib.updates.idle') }
    case 'checking':
      return {
        label: t('lib.updates.checking'),
        action: null,
        text: t('lib.updates.checkingText'),
        progress: 'indeterminate'
      }
    case 'up-to-date':
      return {
        ...check,
        text: status.message ?? t('lib.updates.upToDate', { version: status.currentVersion })
      }
    case 'available':
      return status.manual
        ? {
            label: t('lib.updates.openRelease'),
            action: 'release',
            text: t('lib.updates.availablePortable', { version }),
            progress: null
          }
        : {
            label: t('lib.updates.download'),
            action: 'download',
            text: t('lib.updates.available', { version }),
            progress: null
          }
    case 'downloading': {
      const parts = [t('lib.updates.downloadingVersion', { version })]
      if (status.bytesTotal)
        parts.push(
          t('lib.updates.bytes', {
            done: formatSize(status.bytesDone ?? 0),
            total: formatSize(status.bytesTotal)
          })
        )
      if (status.bytesPerSecond)
        parts.push(t('lib.updates.speed', { size: formatSize(status.bytesPerSecond) }))
      return {
        label: t('lib.updates.downloading', { percent: Math.round(status.percent ?? 0) }),
        action: null,
        text: parts.join(' · '),
        progress: status.percent ?? 0
      }
    }
    case 'downloaded':
      return {
        label: t('lib.updates.restart'),
        action: 'install',
        text: t('lib.updates.ready', { version }),
        progress: 100
      }
    case 'installing':
      return {
        label: t('lib.updates.installing'),
        action: null,
        text: t('lib.updates.installingText', { version }),
        progress: 'indeterminate'
      }
    case 'error':
    case 'unsupported':
      return { ...check, text: status.message ?? t('lib.updates.unavailable') }
  }
}
