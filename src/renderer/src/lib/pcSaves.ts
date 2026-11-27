// PC Saves' text (main/pc-saves): the Edit sheet's "Save folder" status line and the launch prompt's sentence.
import type { PcSaveView } from '@shared/pc-saves'
import type { Translate } from '../i18n'
import { formatDate } from './format'

/** The status line under the game's save folder; `warn` for what needs the user (or went wrong). */
export function pcSaveStatus(
  view: PcSaveView,
  t: Translate,
  title: string
): { text: string; tone?: 'warn' } | null {
  if (!view.folder) return null
  if (!view.featureOn) return { text: t('pcSaves.status.featureOff') }
  if (view.confirm)
    return {
      text: t('pcSaves.status.confirm', {
        machine: view.confirm.machine,
        title: view.confirm.title || title
      }),
      tone: 'warn'
    }
  if (view.conflict) return { text: t('pcSaves.status.conflict'), tone: 'warn' }
  if (view.running) return { text: t('pcSaves.status.running') }
  if (view.error) return { text: t('pcSaves.status.error', { error: view.error }), tone: 'warn' }
  if (view.pending) return { text: t('pcSaves.status.pending') }
  if (view.syncedAt) {
    const date = formatDate(view.syncedAt, 'medium')
    return {
      text: view.copyMachine
        ? t('pcSaves.status.syncedAtFrom', { date, machine: view.copyMachine })
        : t('pcSaves.status.syncedAt', { date })
    }
  }
  return { text: t('pcSaves.status.never') }
}

/** The conflict prompt's sentence (the two sides' dates when known). */
export function pcSaveConflictText(
  conflict: NonNullable<PcSaveView['conflict']>,
  t: Translate
): string {
  const local = formatDate(conflict.localAt, 'medium')
  const cloud = formatDate(conflict.cloudAt, 'medium')
  const vars = { localAt: local ? ` (${local})` : '', cloudAt: cloud ? ` (${cloud})` : '' }
  return conflict.cloudDevice
    ? t('pcSaves.conflict.textDevice', { ...vars, device: conflict.cloudDevice })
    : t('pcSaves.conflict.text', vars)
}
