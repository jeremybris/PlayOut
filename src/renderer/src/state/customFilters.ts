import {
  cleanFilterName,
  customFilterIcon,
  filterNameProblem,
  MAX_CUSTOM_FILTER_GAMES,
  MAX_CUSTOM_FILTER_NAME,
  MAX_CUSTOM_FILTERS,
  newCustomFilterId,
  type FilterNameProblem
} from '@shared/custom-filters'
import type { CustomFilter, LibraryTabDef } from '@shared/types'
import { t } from '../i18n'
import { filterHasGame } from '../lib/customFilters'
import { displayTitle } from '../lib/library'
import { findGame } from '../lib/streaming'
import { copiesFor } from './favorite'
import { useLibraryStore } from './library'
import { libraryTabDefs, setTabsWith } from './libraryTabs'
import { currentSettings, useSettingsStore } from './settings'
import { useStreamingStore } from './streaming'
import { useUiStore } from './ui'

/**
 * The user's own filters (settings.library.customFilters): made from a game's options menu (Create a filter, which
 * puts the game in it), games added and removed there, renamed, given another icon or deleted from Filters > Custom.
 * Every change is saved to settings at once (the settings store applies it first).
 */

const EMPTY: readonly CustomFilter[] = []

/** The user's filters as they stand. */
export function customFiltersNow(): readonly CustomFilter[] {
  return currentSettings().library.customFilters ?? EMPTY
}

/** The user's filters, for a component (re-renders when they change). */
export function useCustomFilters(): readonly CustomFilter[] {
  return useSettingsStore((s) => s.settings?.library.customFilters ?? EMPTY)
}

function save(next: CustomFilter[]): Promise<boolean> {
  return useSettingsStore.getState().update({ library: { customFilters: next } })
}

/** Every id the card of a game stands for (its copies), the game's own first. */
function copyIdsOf(gameId: string): string[] {
  const ids = [gameId, ...copiesFor(gameId).map((c) => c.id)]
  return [...new Set(ids)]
}

function titleOf(gameId: string): string {
  // A paired host's game (Streaming) is not in the library store.
  const game = findGame(
    gameId,
    useLibraryStore.getState().byId,
    useStreamingStore.getState().remote
  )
  return game ? displayTitle(game) : gameId
}

/** The message for a name that cannot be used. */
export function nameProblemText(problem: FilterNameProblem): string {
  return t(`customFilter.problem.${problem}`, { max: MAX_CUSTOM_FILTER_NAME })
}

/**
 * Make a filter called `name` with `icon`, with `gameId` in it (Create a filter from a game's options menu). Resolves
 * to the new filter, or null when it was not made (the name cannot be used, there are MAX_CUSTOM_FILTERS already, or
 * the save failed; a toast says which).
 */
export async function createCustomFilter(
  name: string,
  icon: string,
  gameId?: string
): Promise<CustomFilter | null> {
  const toast = useUiStore.getState().toast
  const filters = customFiltersNow()
  const problem = filterNameProblem(name, filters)
  if (problem) {
    toast(nameProblemText(problem), 'error')
    return null
  }
  if (filters.length >= MAX_CUSTOM_FILTERS) {
    toast(t('customFilter.toast.tooMany', { max: MAX_CUSTOM_FILTERS }), 'error')
    return null
  }
  const filter: CustomFilter = {
    id: newCustomFilterId(filters),
    name: cleanFilterName(name),
    icon: customFilterIcon(icon),
    gameIds: gameId ? [gameId] : []
  }
  const saved = await save([...filters, filter])
  if (!saved) return null
  toast(
    gameId
      ? t('customFilter.toast.createdWith', { name: filter.name, title: titleOf(gameId) })
      : t('customFilter.toast.created', { name: filter.name }),
    'success'
  )
  return filter
}

/** Whether a game's card (any of its copies) is in the filter. */
export function gameInFilter(filter: CustomFilter, gameId: string): boolean {
  return filterHasGame(filter, copyIdsOf(gameId))
}

/**
 * Put a game in a filter, or take it out when it is in it already (every copy of it): the options menu's
 * "Add to …" / "Remove from …". Resolves to whether it was saved.
 */
export async function toggleGameInFilter(filterId: string, gameId: string): Promise<boolean> {
  const toast = useUiStore.getState().toast
  const filters = customFiltersNow()
  const filter = filters.find((f) => f.id === filterId)
  if (!filter) return false
  const copies = copyIdsOf(gameId)
  const removing = filterHasGame(filter, copies)
  if (!removing && filter.gameIds.length >= MAX_CUSTOM_FILTER_GAMES) {
    toast(
      t('customFilter.toast.full', { name: filter.name, max: MAX_CUSTOM_FILTER_GAMES }),
      'error'
    )
    return false
  }
  const gameIds = removing
    ? filter.gameIds.filter((id) => !copies.includes(id))
    : [...filter.gameIds, gameId]
  const saved = await save(filters.map((f) => (f.id === filterId ? { ...f, gameIds } : f)))
  if (saved)
    toast(
      removing
        ? t('customFilter.toast.removed', { name: filter.name, title: titleOf(gameId) })
        : t('customFilter.toast.added', { name: filter.name, title: titleOf(gameId) }),
      'success'
    )
  return saved
}

/**
 * Rename a filter and / or give it another icon (Filters > Custom's Rename / Change icon). Resolves to whether it was
 * saved; a name that cannot be used is refused with a toast.
 */
export async function editCustomFilter(
  filterId: string,
  change: { name?: string; icon?: string }
): Promise<boolean> {
  const toast = useUiStore.getState().toast
  const filters = customFiltersNow()
  const filter = filters.find((f) => f.id === filterId)
  if (!filter) return false
  const name = change.name !== undefined ? cleanFilterName(change.name) : filter.name
  const problem = filterNameProblem(name, filters, filterId)
  if (problem) {
    toast(nameProblemText(problem), 'error')
    return false
  }
  const icon = change.icon !== undefined ? customFilterIcon(change.icon) : filter.icon
  if (name === filter.name && icon === filter.icon) return true
  const saved = await save(filters.map((f) => (f.id === filterId ? { ...f, name, icon } : f)))
  if (saved) toast(t('customFilter.toast.saved', { name }), 'success')
  return saved
}

/** `defs` with the filter's id taken out of every tab's Filters > Custom (the same list when no tab had it). */
export function tabsWithoutFilter(
  defs: readonly LibraryTabDef[],
  filterId: string
): LibraryTabDef[] {
  let changed = false
  const out = defs.map((def) => {
    if (!def.filters.custom?.includes(filterId)) return def
    changed = true
    const custom = def.filters.custom.filter((id) => id !== filterId)
    const { custom: _gone, ...rest } = def.filters
    void _gone
    return { ...def, filters: custom.length ? { ...rest, custom } : rest }
  })
  return changed ? out : [...defs]
}

/**
 * Delete a filter: it goes from settings and from every tab that had it picked (the shown one's view too), in one
 * settings write. Its games stay in the library. Resolves to whether it was saved. (A tab naming a filter that is gone
 * anyway, say one synced from an older copy, is harmless: matching ignores ids with no filter.)
 */
export async function deleteCustomFilter(filterId: string): Promise<boolean> {
  const filters = customFiltersNow()
  const filter = filters.find((f) => f.id === filterId)
  if (!filter) return false
  const rest = filters.filter((f) => f.id !== filterId)
  const defs = libraryTabDefs()
  const next = tabsWithoutFilter(defs, filterId)
  const saved = next.some((d, i) => d !== defs[i])
    ? await setTabsWith(next, { library: { customFilters: rest } })
    : await save(rest)
  if (!saved) return false
  // The view, when its tab was not saved with the filter picked (nothing to reload from the tab).
  const view = useUiStore.getState().library
  if (view.custom.includes(filterId))
    useUiStore.getState().setLibraryFilters({ custom: view.custom.filter((id) => id !== filterId) })
  useUiStore.getState().toast(t('customFilter.toast.deleted', { name: filter.name }), 'success')
  return true
}

/** Ask before deleting a filter (Filters > Custom's Delete). */
export function confirmDeleteCustomFilter(filterId: string): void {
  const filter = customFiltersNow().find((f) => f.id === filterId)
  if (!filter) return
  useUiStore.getState().openModal({
    type: 'confirm',
    title: t('customFilter.delete.title', { name: filter.name }),
    message: t('customFilter.delete.message', { count: filter.gameIds.length }),
    confirmLabel: t('customFilter.delete.confirm'),
    danger: true,
    onConfirm: () => void deleteCustomFilter(filterId)
  })
}

/** The Create a filter dialog for a game (its options menu). */
export function openCreateCustomFilter(gameId: string): void {
  useUiStore.getState().openModal({ type: 'custom-filter', gameId })
}

/** The dialog that renames a filter or changes its icon (Filters > Custom). */
export function openEditCustomFilter(filterId: string, focus: 'name' | 'icon' = 'name'): void {
  useUiStore.getState().openModal({ type: 'custom-filter', filterId, focus })
}
