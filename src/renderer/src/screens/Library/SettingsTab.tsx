import { memo, useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  FocusContext,
  doesFocusableExist,
  getCurrentFocusKey,
  isFocusWithin,
  setFocus,
  useFocusable
} from '../../input/focus'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { LIBRARY_SETTINGS_TAB } from '../../lib/libraryView'
import { useUiStore, type SettingsSection } from '../../state/ui'
import { SettingsPanel } from '../Settings'
import { isSection, navFocusKey, sectionOfNavKey } from '../Settings/common'
import { LIBRARY_KEY, SETTINGS_TAB_KEY } from './keys'

export interface SettingsTabProps {
  /** The Library view is interactive (not leaving, no modal over it): the panel seeds its own focus while so. */
  active: boolean
  /** Slide direction of the entrance (a tab switch): 1 = from the right, -1 = from the left, 0 = fade only. */
  direction: 1 | -1 | 0
}

/**
 * The body of the Library's Settings tab: the Settings menu (the same panel as the Settings modal: the section
 * list, the section's controls). The section last shown is remembered in the ui store (`libraryFocus[settings]`),
 * so a tab switch or a return from Home comes back to it. A Norigin container that seeds its own focus whenever
 * the view is interactive and the focused control is gone (the card or header field the tab switch unmounted).
 * The Settings modal is never opened over it (ui.openModal sends the request here: `settingsTabRequest`), and
 * Library.tsx unmounts it should one be open anyway: the two share their controls' focus keys.
 */
export const SettingsTab = memo(function SettingsTab({
  active,
  direction
}: SettingsTabProps): ReactElement {
  const t = useT()
  const rememberFocus = useUiStore((s) => s.rememberLibraryFocus)
  const [section, setSection] = useState<SettingsSection>(
    () => sectionOfNavKey(useUiStore.getState().libraryFocus[LIBRARY_SETTINGS_TAB]) ?? 'library'
  )
  const onActive = useCallback(
    (next: SettingsSection) => {
      setSection(next)
      rememberFocus(LIBRARY_SETTINGS_TAB, navFocusKey(next))
    },
    [rememberFocus]
  )
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: SETTINGS_TAB_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: navFocusKey(section)
  })

  // Settings asked for while this tab shows (Start, a "go to Settings" button): its section here, focus on it.
  // Waits while a modal is over the view, so focus never goes underneath it.
  const request = useUiStore((s) => s.settingsTabRequest)
  useEffect(() => {
    if (!request || !active) return
    useUiStore.getState().clearSettingsTabRequest()
    const target = isSection(request.section) ? request.section : section
    onActive(target)
    void setFocus(navFocusKey(target))
  }, [request, active, section, onActive])

  // Deferred past the tab switch's own unmounts, as Library.tsx does; focus on the tab strip stays there.
  useEffect(() => {
    if (!active) return undefined
    const timer = setTimeout(() => {
      const current = getCurrentFocusKey()
      if (current && doesFocusableExist(current) && isFocusWithin(LIBRARY_KEY)) return
      void setFocus(SETTINGS_TAB_KEY)
    }, 0)
    return () => clearTimeout(timer)
  }, [active])

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={cx(
          'library__settings',
          direction === 1 && 'library__viewport--from-right',
          direction === -1 && 'library__viewport--from-left'
        )}
        role="region"
        aria-label={t('library.settingsLabel')}
      >
        <SettingsPanel active={section} onActive={onActive} />
      </div>
    </FocusContext.Provider>
  )
})
