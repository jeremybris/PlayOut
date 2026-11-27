import type { EmulatorUpdateItem, EmulatorUpdateReport } from '@shared/types'
import { t } from '../../../i18n'
import type { ToastKind } from '../../../state/ui'

/**
 * Texts of Update all emulators (Settings › Emulators): the toast when a run ends, and the report lines under it.
 * Whole sentences in settingsEmulators.updateReport.*, looked up when asked so they follow the language.
 */

export interface UpdateReportLine {
  id: string
  name: string
  text: string
  tone: 'ok' | 'warn'
}

/** A version as shown: long ones (a commit hash) cut to 24 characters. */
function shown(version: string | undefined): string {
  if (!version) return t('settingsEmulators.updateReport.unknownVersion')
  return version.length > 24 ? `${version.slice(0, 23)}…` : version
}

/** One emulator's line: a whole sentence per outcome, the channel (an id such as "dev") as a variable. */
export function updateLine(item: EmulatorUpdateItem): UpdateReportLine {
  const channel = item.channel && item.channel !== 'stable' ? item.channel : ''
  const base = { id: item.id, name: item.name }
  switch (item.result) {
    case 'updated': {
      const vars = { from: shown(item.from), to: shown(item.to), channel }
      return {
        ...base,
        text: channel
          ? t('settingsEmulators.updateReport.updatedChannel', vars)
          : t('settingsEmulators.updateReport.updated', vars),
        tone: 'ok'
      }
    }
    case 'current': {
      const vars = { version: shown(item.to ?? item.from), channel }
      return {
        ...base,
        text: channel
          ? t('settingsEmulators.updateReport.currentChannel', vars)
          : t('settingsEmulators.updateReport.current', vars),
        tone: 'ok'
      }
    }
    case 'running':
      return { ...base, text: t('settingsEmulators.updateReport.running'), tone: 'warn' }
    case 'unavailable':
      return { ...base, text: t('settingsEmulators.updateReport.unavailable'), tone: 'ok' }
    case 'failed':
      return {
        ...base,
        text: item.error
          ? t('settingsEmulators.updateReport.failedWhy', { error: item.error })
          : t('settingsEmulators.updateReport.failed'),
        tone: 'warn'
      }
  }
}

export function updateReportLines(report: EmulatorUpdateReport): UpdateReportLine[] {
  return report.items.map(updateLine)
}

/** The toast when a run ends: what changed, and what needs the user. */
export function updateSummary(report: EmulatorUpdateReport): { text: string; tone: ToastKind } {
  const by = (r: EmulatorUpdateItem['result']): number =>
    report.items.filter((i) => i.result === r).length
  const updated = by('updated')
  const current = by('current')
  const running = by('running')
  const failed = by('failed')
  if (!report.items.length)
    return { text: t('settingsEmulators.updateReport.summary.none'), tone: 'info' }
  // Each count is a phrase of its own with its own plural; ' · ' joins them.
  const parts: string[] = []
  if (updated) parts.push(t('settingsEmulators.updateReport.summary.updated', { count: updated }))
  if (current) parts.push(t('settingsEmulators.updateReport.summary.current', { count: current }))
  if (running) parts.push(t('settingsEmulators.updateReport.summary.running', { count: running }))
  if (failed) parts.push(t('settingsEmulators.updateReport.summary.failed', { count: failed }))
  if (!parts.length)
    return { text: t('settingsEmulators.updateReport.summary.noneNewer'), tone: 'info' }
  return {
    text: parts.join(' · '),
    tone: failed ? 'warning' : updated ? 'success' : running ? 'warning' : 'info'
  }
}
