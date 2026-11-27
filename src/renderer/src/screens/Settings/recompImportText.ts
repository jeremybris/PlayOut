// Words and choices for Settings › Recompilations › Import (RecompImportDialog.tsx), kept pure so they are tested
// without rendering.
import type { RecompImportItem, RecompImportProgress, RecompImportScan } from '@shared/recomp'
import { t } from '../../i18n'
import { formatBytes } from '../../lib/format'

/** The choice that leaves a folder where it is. */
export const SKIP = '__skip__'
/** The dropdown's "Choose another…": opens the search of the whole catalog. */
export const CHOOSE_OTHER = '__other__'
/** The most search results shown at once. */
export const SEARCH_LIMIT = 30

type CatalogItem = RecompImportScan['catalog'][number]

/**
 * The catalog's recompilations whose name, game or console holds every word typed (any case, accents ignored), the
 * row's own choices left out; at most SEARCH_LIMIT, with whether there were more.
 */
export function searchImportCatalog(
  catalog: readonly CatalogItem[],
  query: string,
  exclude: readonly string[] = []
): { results: CatalogItem[]; more: boolean } {
  const fold = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return { results: [], more: false }
  const skip = new Set(exclude)
  const hits = catalog.filter((c) => {
    if (skip.has(c.id)) return false
    const text = fold(`${c.name} ${c.game} ${c.console}`)
    return words.every((w) => text.includes(w))
  })
  return { results: hits.slice(0, SEARCH_LIMIT), more: hits.length > SEARCH_LIMIT }
}

/**
 * A row's choice when the list opens: the recompilation PlayOut is sure of (its project's repository or RecompLauncher's
 * id for it, one recompilation, not installed, nothing in its way); anything else starts at Skip for the user to pick.
 */
export function importStartChoice(item: RecompImportItem): string {
  if (item.blocked || !item.recompId || item.match === 'title' || item.match === 'none') return SKIP
  const choice = item.choices.find((c) => c.id === item.recompId)
  return choice && !choice.installed && !choice.targetTaken ? item.recompId : SKIP
}

/** Whether a row will be imported with this choice, and the line that says why (not) or where it goes. */
export function importRowState(
  item: RecompImportItem,
  pick: string,
  picks: Record<string, string>,
  catalog: readonly CatalogItem[] = []
): { ok: boolean; message: string | null } {
  if (item.blocked) return { ok: false, message: item.blocked }
  if (pick === SKIP) {
    if (item.match === 'none') return { ok: false, message: t('settingsRecomp.import.matchNone') }
    if (item.match === 'title')
      return {
        ok: false,
        message: t('settingsRecomp.import.matchTitle', { name: item.choices[0]?.name ?? '' })
      }
    if (item.choices.length > 1) return { ok: false, message: t('settingsRecomp.import.matchMany') }
    const only = item.choices[0]
    if (only?.installed)
      return {
        ok: false,
        message: t('settingsRecomp.import.installedAlready', { name: only.name })
      }
    if (only?.targetTaken)
      return { ok: false, message: t('settingsRecomp.import.targetTaken', { path: only.target }) }
    return { ok: false, message: t('settingsRecomp.import.skipped') }
  }
  if (pick === CHOOSE_OTHER) return { ok: false, message: null }
  // One of the row's own choices, else any recompilation of the catalog (picked by search): the same checks.
  const choice = item.choices.find((c) => c.id === pick) ?? catalog.find((c) => c.id === pick)
  if (choice?.installed)
    return {
      ok: false,
      message: t('settingsRecomp.import.installedAlready', { name: choice.name })
    }
  if (choice?.targetTaken)
    return { ok: false, message: t('settingsRecomp.import.targetTaken', { path: choice.target }) }
  const twice = Object.entries(picks).some(([folder, id]) => folder !== item.folder && id === pick)
  if (twice) return { ok: false, message: t('settingsRecomp.import.chosenTwice') }
  return {
    ok: true,
    message: choice
      ? t('settingsRecomp.import.moveTo', { path: choice.target })
      : t('settingsRecomp.import.moveToRoot')
  }
}

/** What the move of one folder is doing. */
export function importPhaseText(p: RecompImportProgress): string {
  switch (p.phase) {
    case 'checking':
      return t('settingsRecomp.import.phase.checking')
    case 'copying':
      return t('settingsRecomp.import.phase.copying', {
        done: formatBytes(p.bytesDone),
        total: formatBytes(p.bytesTotal ?? 0)
      })
    case 'verifying':
      return t('settingsRecomp.import.phase.verifying')
    case 'switching':
      return t('settingsRecomp.import.phase.switching')
    case 'cleaning':
      return t('settingsRecomp.import.phase.cleaning')
    case 'done':
      return t('settingsRecomp.import.phase.done')
    default:
      return t('settingsRecomp.import.phase.moving')
  }
}
