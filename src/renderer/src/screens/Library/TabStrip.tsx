import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactElement } from 'react'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { FocusContext, useFocusable, type Direction } from '../../input/focus'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import type { LibraryTab } from '../../lib/libraryView'
import { useSettingsStore } from '../../state/settings'
import { Plus } from 'lucide-react'
import { ADD_TAB_KEY, TABS_KEY, tabFocusKey } from './keys'

export interface TabStripProps {
  tabs: LibraryTab[]
  active: string
  onSelect: (tabId: string) => void
  /** Up pressed on a tab (nothing lies above the band): return true when handled. */
  onUp: () => boolean
  /** The "+" after the last tab: adds a tab. */
  onAdd: () => void
}

const UNDERLINE_ON = 'library__tab-underline--on'
const UNDERLINE_SLIDE = 'library__tab-underline--slide'

/**
 * The centred tab strip of the Library band: an LB glyph, one tab per library tab, an RB glyph. The
 * active tab carries a 60u accent underline that slides to the new tab (transform transition). When the
 * tabs are wider than the band they scroll horizontally, keeping the active tab in view, while the glyphs
 * stay at the ends. A Norigin container that remembers its last focused tab.
 */
export const TabStrip = memo(function TabStrip({
  tabs,
  active,
  onSelect,
  onUp,
  onAdd
}: TabStripProps): ReactElement {
  const t = useT()
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: TABS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: tabFocusKey(active)
  })
  const stripRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLSpanElement>(null)

  // The underline follows the active tab's box. Its position is written straight to the element: the
  // first measurement is painted without a transition (otherwise every entrance slides it in from the
  // strip's left edge), later ones slide. Re-measured when the strip or a tab resizes (rem follows the
  // viewport height) and when the display font has loaded.
  const measure = useCallback(() => {
    const strip = stripRef.current
    const line = lineRef.current
    if (!strip || !line) return
    const tab = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`)
    if (!tab) return
    const x = tab.offsetLeft + (tab.offsetWidth - line.offsetWidth) / 2
    line.style.setProperty('--x', `${x}px`)
    line.classList.add(UNDERLINE_ON)
    if (!line.classList.contains(UNDERLINE_SLIDE)) {
      // Flush the first position before the transition is enabled, so it does not animate from x = 0.
      void getComputedStyle(line).transform
      line.classList.add(UNDERLINE_SLIDE)
    }
  }, [active])

  useLayoutEffect(() => {
    measure()
    const strip = stripRef.current
    const tab = strip?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`)
    if (!tab) return
    const animations = useSettingsStore.getState().settings?.ui.animations ?? true
    tab.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: animations ? 'smooth' : 'auto'
    })
  }, [measure, active, tabs])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return undefined
    let cancelled = false
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready
        .then(() => {
          if (!cancelled) measure()
        })
        .catch(() => undefined)
    }
    if (typeof ResizeObserver !== 'function') {
      return () => {
        cancelled = true
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    for (const tab of strip.querySelectorAll<HTMLElement>('[data-tab-id]')) observer.observe(tab)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [measure, tabs])

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="library__tabs-group"
        role="tablist"
        aria-label={t('library.tabs.label')}
      >
        <span className="hint__glyph hint__glyph--lb library__tabs-glyph" aria-hidden="true">
          LB
        </span>
        <div className="library__tabs">
          <div ref={stripRef} className="library__tabs-strip">
            {tabs.map((tab) => (
              <Tab
                key={tab.id}
                tab={tab}
                active={tab.id === active}
                onSelect={onSelect}
                onUp={onUp}
              />
            ))}
            <AddTab onAdd={onAdd} onUp={onUp} />
            <span ref={lineRef} className="library__tab-underline" aria-hidden="true" />
          </div>
        </div>
        <span className="hint__glyph hint__glyph--rb library__tabs-glyph" aria-hidden="true">
          RB
        </span>
      </div>
    </FocusContext.Provider>
  )
})

interface TabProps {
  tab: LibraryTab
  active: boolean
  onSelect: (tabId: string) => void
  onUp: () => boolean
}

const Tab = memo(function Tab({ tab, active, onSelect, onUp }: TabProps): ReactElement {
  const onPress = useCallback(() => onSelect(tab.id), [onSelect, tab.id])
  const onArrowPress = useCallback(
    (direction: Direction): boolean => (direction === 'up' ? !onUp() : true),
    [onUp]
  )
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: tabFocusKey(tab.id),
    onPress,
    onArrowPress,
    scroll: { inline: 'nearest', block: 'nearest' }
  })
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      className={cx('library__tab', active && 'library__tab--active')}
      data-tab-id={tab.id}
      {...controlProps}
    >
      {tab.label}
    </button>
  )
})

/** The "+" at the end of the tabs: a new tab (All Games, Title A–Z, playable games first) after the last one, shown at once. */
const AddTab = memo(function AddTab({
  onAdd,
  onUp
}: {
  onAdd: () => void
  onUp: () => boolean
}): ReactElement {
  const t = useT()
  const onArrowPress = useCallback(
    (direction: Direction): boolean => (direction === 'up' ? !onUp() : true),
    [onUp]
  )
  const { ref, props: controlProps } = useFocusableControl<HTMLButtonElement>({
    focusKey: ADD_TAB_KEY,
    onPress: onAdd,
    onArrowPress,
    scroll: { inline: 'nearest', block: 'nearest' }
  })
  return (
    <button
      ref={ref}
      type="button"
      className="library__tab library__tab--add"
      aria-label={t('library.tabs.add')}
      title={t('library.tabs.add')}
      {...controlProps}
    >
      <Plus aria-hidden="true" />
    </button>
  )
})
