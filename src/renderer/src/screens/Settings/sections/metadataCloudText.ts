import { queueLimitText, type MetadataCloudStatus } from '@shared/metadata-cloud'
import { t } from '../../../i18n'

/**
 * Settings › Metadata › Cloud metadata's status lines. Whole sentences in settingsCloud.status.*, looked up when asked
 * so they follow the language; ' · ' only joins separate facts.
 */

/** When the cloud was last checked, as a whole sentence ("Checked 5 min ago", "Checked on Nov 2, 2026"). */
function checkedText(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return t('settingsCloud.status.checked')
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000)
  if (minutes < 1) return t('settingsCloud.status.checkedJustNow')
  if (minutes < 60) return t('settingsCloud.status.checkedMinutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('settingsCloud.status.checkedHours', { count: hours })
  return t('settingsCloud.status.checkedOn', {
    date: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  })
}

/** The status line under "PlayOut cloud": how many games it corrects and when it was last checked. */
export function cloudSyncText(status: MetadataCloudStatus, now: Date = new Date()): string {
  const parts: string[] = []
  if (status.syncing) parts.push(t('settingsCloud.status.checking'))
  else if (status.lastSyncAt) parts.push(checkedText(status.lastSyncAt, now))
  else parts.push(t('settingsCloud.status.notChecked'))
  parts.push(
    status.cloudGames
      ? t('settingsCloud.status.corrected', {
          count: status.cloudGames,
          library: status.libraryGames
        })
      : t('settingsCloud.status.noCorrections')
  )
  return parts.join(' · ')
}

/** What happens to this PC's edits (Settings › Metadata, under Suggest my edits). */
export function editsGoText(status: MetadataCloudStatus): string {
  if (status.owner) return t('settingsCloud.status.edits.published')
  if (status.token.state === 'unchecked') return t('settingsCloud.status.edits.awaitingToken')
  if (!status.suggestEdits) return t('settingsCloud.status.edits.local')
  const relay = status.relayUrl || status.sharedRelayUrl
  // Two sentences side by side, each whole: what happens to edits, then why some still wait.
  if (status.queued && status.queueLimit)
    return t('settingsCloud.status.edits.twoSentences', {
      first: t('settingsCloud.status.edits.suggested'),
      second: queueLimitText(status.queued, status.queueLimit, status.queueNextAt, t)
    })
  if (relay)
    return status.queued
      ? t('settingsCloud.status.edits.suggestedQueued', { count: status.queued })
      : t('settingsCloud.status.edits.suggested')
  return status.queued
    ? t('settingsCloud.status.edits.noRelayQueued', { count: status.queued })
    : t('settingsCloud.status.edits.noRelay')
}
