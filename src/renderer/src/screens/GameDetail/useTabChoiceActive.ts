import { hasTabChoice, type TabChoice } from '../../lib/libraryTabs'
import { currentTabFilters } from '../../state/libraryTabs'
import { useSettingsStore } from '../../state/settings'
import { useUiStore } from '../../state/ui'

/**
 * Whether the Library's current tab (the first tab while the Settings tab is shown) has this developer, publisher or
 * genre on: a game page's button or chip for it shows it is on, and pressing it takes it off.
 */
export function useTabChoiceActive(choice: TabChoice): boolean {
  const defs = useSettingsStore((s) => s.settings?.ui.libraryTabs ?? null)
  return useUiStore((s) => hasTabChoice(currentTabFilters(s.library, defs ?? []), choice))
}
