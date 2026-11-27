// Words for Settings › Recompilations (Recompilations.tsx), kept pure so they are tested without rendering. Each line
// is a whole sentence in settingsRecomp.text.* (plurals by count), looked up when asked, so it follows the language.
import type {
  InstalledRecomp,
  RecompCatalogStatus,
  RecompCloudState,
  RecompProgress,
  RecompRow
} from '@shared/recomp'
import { currentLanguage, t } from '../../../i18n'
import { daysSince, formatBytes, formatDate } from '../../../lib/format'

/** The section's lead: how big the catalog is and how many library games have a recompilation. */
export function catalogLead(catalog: RecompCatalogStatus): string {
  if (!catalog.entries)
    return catalog.offline.length
      ? t('settingsRecomp.text.catalogOffline')
      : t('settingsRecomp.text.catalogNotLoaded')
  const games = catalog.matchedGames
  // Two counts in one sentence: the recompilations pick the sentence's plural, the games a phrase of their own.
  return t('settingsRecomp.text.catalogLead', {
    count: catalog.entries,
    games: games
      ? t('settingsRecomp.text.games', { count: games })
      : t('settingsRecomp.text.noGames')
  })
}

const SOURCE_NAMES: Record<string, string> = {
  'decomp-buddy': 'decomp-buddy',
  recomplauncher: 'RecompLauncher'
}

/** A catalog's display name ('recomplauncher' -> 'RecompLauncher'). */
export function catalogSourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source
}

/** "A and B" in the language shown (Intl knows each language's word for "and"). */
function listText(items: string[]): string {
  try {
    return new Intl.ListFormat(currentLanguage(), { type: 'conjunction' }).format(items)
  } catch {
    return items.join(', ')
  }
}

/** The browser row's description: how many there are, how many are new. */
export function browseText(entries: number, fresh: number): string {
  const base = entries
    ? t('settingsRecomp.text.browse', { count: entries.toLocaleString(currentLanguage()) })
    : t('settingsRecomp.text.browseEmpty')
  return fresh ? t('settingsRecomp.text.browseFresh', { text: base, count: fresh }) : base
}

/** "Updated today", "Updated 3 days ago", "Updated on 11/2/2026": whole sentences, no lower-cased fragments. */
function updatedText(iso: string, now: Date): string {
  const days = daysSince(iso, now)
  if (days === null) return t('settingsRecomp.text.neverUpdated')
  if (days <= 0) return t('settingsRecomp.text.updatedToday')
  if (days === 1) return t('settingsRecomp.text.updatedYesterday')
  if (days < 7) return t('settingsRecomp.text.updatedDaysAgo', { count: days })
  return t('settingsRecomp.text.updatedOn', { date: formatDate(iso, 'short') })
}

/** When the catalogs were fetched ("Updated today"), and which could not be reached. */
export function catalogFetched(catalog: RecompCatalogStatus, now: Date = new Date()): string {
  const times = Object.values(catalog.fetchedAt).filter((t): t is string => !!t)
  const newest = times.sort().at(-1)
  const parts = [newest ? updatedText(newest, now) : t('settingsRecomp.text.neverUpdated')]
  if (catalog.offline.length)
    parts.push(
      t('settingsRecomp.text.sourcesOffline', {
        sources: listText(catalog.offline.map((s) => SOURCE_NAMES[s] ?? s))
      })
    )
  return parts.join(' · ')
}

/** The phase of an install / update in words, with the percentage while downloading. */
export function progressText(p: RecompProgress): string {
  switch (p.phase) {
    case 'queued':
      return t('settingsRecomp.progress.queued')
    case 'checking':
      return t('settingsRecomp.progress.checking')
    case 'downloading': {
      const percent = p.progress === null ? null : Math.floor(p.progress * 100)
      const size = p.total ? formatBytes(p.total) : null
      if (percent !== null && size)
        return t('settingsRecomp.progress.downloadingPercentOf', { percent, size })
      if (percent !== null) return t('settingsRecomp.progress.downloadingPercent', { percent })
      if (size) return t('settingsRecomp.progress.downloadingOf', { size })
      return t('settingsRecomp.progress.downloading')
    }
    case 'verifying':
      return t('settingsRecomp.progress.verifying')
    case 'extracting':
      return t('settingsRecomp.progress.extracting')
    case 'installing':
      return t('settingsRecomp.progress.installing')
    case 'done':
      return p.message ?? t('settingsRecomp.progress.done')
    case 'failed':
      return p.message
        ? t('settingsRecomp.progress.failedWhy', { error: p.message })
        : t('settingsRecomp.progress.failed')
  }
}

/** The row's second line: game name, version and size on disk. */
export function rowDetail(row: RecompRow, gameName: string | null): string {
  const parts: string[] = []
  if (gameName) parts.push(gameName)
  parts.push(row.installed.tag)
  if (row.installed.diskBytes !== null)
    parts.push(t('settingsRecomp.text.onDisk', { size: formatBytes(row.installed.diskBytes) }))
  if (row.installed.verified === 'unverified') parts.push(t('settingsRecomp.text.notVerified'))
  return parts.join(' · ')
}

/** Where the save folders in use came from. */
export function saveSourceText(source: InstalledRecomp['saveSource'], count: number): string {
  if (!count) return t('settingsRecomp.text.saveSource.none')
  switch (source) {
    case 'user':
      return t('settingsRecomp.text.saveSource.user')
    case 'developer':
      return t('settingsRecomp.text.saveSource.developer')
    case 'catalog':
      return t('settingsRecomp.text.saveSource.catalog')
    case 'detected':
      return t('settingsRecomp.text.saveSource.detected')
    case 'install':
      return t('settingsRecomp.text.saveSource.install')
    default:
      return ''
  }
}

/**
 * Whether a save folder can be removed. Not the only folder when it comes from the catalog or the recompilation's
 * own settings file: with none of the user's own left, PlayOut falls back to that same folder, so Remove would do
 * nothing.
 */
export function canRemoveSave(source: InstalledRecomp['saveSource'], count: number): boolean {
  return count > 1 || (source !== 'catalog' && source !== 'developer')
}

/** Why the one folder above has no Remove (null when it has), and how to stop syncing it. */
export function keptSaveText(source: InstalledRecomp['saveSource'], count: number): string | null {
  if (!count || canRemoveSave(source, count)) return null
  return source === 'catalog'
    ? t('settingsRecomp.text.keptByCatalog')
    : t('settingsRecomp.text.keptByDeveloper')
}

/** "Copied yesterday." and the like: whole sentences per day, as in updatedText. */
function copiedText(iso: string, now: Date): string {
  const days = daysSince(iso, now)
  if (days === null) return t('settingsRecomp.text.cloud.idle')
  if (days <= 0) return t('settingsRecomp.text.cloud.copiedToday')
  if (days === 1) return t('settingsRecomp.text.cloud.copiedYesterday')
  if (days < 7) return t('settingsRecomp.text.cloud.copiedDaysAgo', { count: days })
  return t('settingsRecomp.text.cloud.copiedOn', { date: formatDate(iso, 'short') })
}

/** The state of the copy of one recompilation's saves in the Emulation folder, in a sentence. */
export function cloudStatusText(cloud: RecompCloudState, now: Date = new Date()): string {
  if (!cloud.enabled) return t('settingsRecomp.text.cloud.off')
  if (cloud.conflict)
    return t('settingsRecomp.text.cloud.conflict', {
      localAt: formatDate(cloud.conflict.localAt, 'medium'),
      device: cloud.conflict.cloudDevice || t('settingsRecomp.text.cloud.anotherPc'),
      cloudAt: formatDate(cloud.conflict.cloudAt, 'medium')
    })
  if (cloud.error)
    return cloud.pending
      ? t('settingsRecomp.text.cloud.waitingWhy', { error: cloud.error })
      : cloud.error
  if (cloud.pending) return t('settingsRecomp.text.cloud.waiting')
  if (cloud.syncedAt) return copiedText(cloud.syncedAt, now)
  return t('settingsRecomp.text.cloud.idle')
}

/** The "Update all" button's label. */
export function updateAllLabel(updates: number): string {
  return updates
    ? t('settingsRecomp.text.updateAllCount', { count: updates })
    : t('settingsRecomp.text.updateAll')
}

/** The options of the "Version in use" field: this one and its alternatives, with what is not installed marked. */
export function versionOptions(row: RecompRow): { value: string; label: string }[] {
  return [
    { value: row.entry.id, label: row.entry.name },
    ...row.alternatives.map((a) => ({
      value: a.id,
      label: a.installed ? a.name : t('settingsRecomp.text.installsIt', { name: a.name })
    }))
  ]
}
