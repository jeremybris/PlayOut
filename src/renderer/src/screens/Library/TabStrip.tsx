import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode
} from 'react'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useLayerId } from '../../hooks/useActionHandlers'
import { FocusContext, useFocusable, type Direction } from '../../input/focus'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { revealLeft } from '../../lib/hScroll'
import { LIBRARY_SETTINGS_TAB, type LibraryTab } from '../../lib/libraryView'
import { cappedTabGroups, type TabNamePart } from '../../lib/libraryTabs'
import { tabPartIcon } from '../../lib/filterChoiceIcons'
import { useCustomFilters } from '../../state/customFilters'
import { SettingsTabIcon } from '../../components/SettingsTabIcon'
import { Plus } from 'lucide-react'
import { ADD_TAB_KEY, TABS_KEY, tabFocusKey } from './keys'
import { TabScrollBar } from './TabScrollBar'
import { smoothScrolls, useStripOverflow, useStripScrolling } from './useTabScroll'

export interface TabStripProps {
  tabs: LibraryTab[]
  active: string
  onSelect: (tabId: string) => void
  /** Up pressed on a tab (nothing lies above the band): return true when handled. */
  onUp: () => boolean
  /** The "+" after the last tab: adds a tab. */
  onAdd: () => void
  /** The Library is the shown screen: the right stick's left / right scrolls the tabs when they do not fit. */
  shown?: boolean
  /**
   * Settings > Library "Icons for tabs": a tab with filters shows its choices' icons (the Filters sub-menus' ones)
   * instead of its name, which stays its tooltip and accessible name.
   */
  icons?: boolean
}

const UNDERLINE_ON = 'library__tab-underline--on'
const UNDERLINE_SLIDE = 'library__tab-underline--slide'

/**
 * The centred tab strip of the Library band: an LB glyph, one tab per library tab, an RB glyph. The
 * active tab carries a 60u accent underline that slides to the new tab (transform transition). When the
 * tabs are wider than the band they scroll horizontally, keeping the active tab in view, while the glyphs
 * stay at the ends: a scroll bar shows under them only then (TabScrollBar.tsx), and the strip scrolls by dragging
 * it (mouse or touch), the wheel and the right stick's left / right. A Norigin container that remembers its last
 * focused tab.
 */
export const TabStrip = memo(function TabStrip({
  tabs,
  active,
  onSelect,
  onUp,
  onAdd,
  shown = true,
  icons = false
}: TabStripProps): ReactElement {
  const t = useT()
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: TABS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    preferredChildFocusKey: tabFocusKey(active)
  })
  const boxRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLSpanElement>(null)
  const overflow = useStripOverflow(viewportRef, stripRef)
  useStripScrolling(viewportRef, boxRef, overflow, useLayerId(), shown)

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

  // The tab LB / RB (or a click) makes active scrolls fully into view, clear of the strip's faded ends (the strip's
  // 2.4rem side padding is the fade's width), so it and its underline are never half faded.
  useLayoutEffect(() => {
    measure()
    const viewport = viewportRef.current
    const strip = stripRef.current
    const tab = strip?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`)
    if (!viewport || !strip || !tab) return
    const metrics = {
      scrollWidth: viewport.scrollWidth,
      clientWidth: viewport.clientWidth,
      scrollLeft: viewport.scrollLeft
    }
    if (metrics.scrollWidth - metrics.clientWidth <= 0) return
    const fade = parseFloat(getComputedStyle(strip).paddingLeft) || 0
    const left = revealLeft(tab.offsetLeft, tab.offsetWidth, metrics, fade)
    if (Math.abs(left - metrics.scrollLeft) < 1) return
    viewport.scrollTo({ left, behavior: smoothScrolls() ? 'smooth' : 'auto' })
  }, [measure, active, tabs, icons])

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
  }, [measure, tabs, icons])

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={cx('library__tabs-group', overflow && 'library__tabs-group--scrolls')}
        role="tablist"
        aria-label={t('library.tabs.label')}
      >
        <span className="hint__glyph hint__glyph--lb library__tabs-glyph" aria-hidden="true">
          LB
        </span>
        <div ref={boxRef} className="library__tabs-box">
          <div ref={viewportRef} className="library__tabs">
            <div ref={stripRef} className="library__tabs-strip">
              {tabs.map((tab) => (
                <Tab
                  key={tab.id}
                  tab={tab}
                  active={tab.id === active}
                  icons={icons}
                  onSelect={onSelect}
                  onUp={onUp}
                />
              ))}
              <AddTab onAdd={onAdd} onUp={onUp} />
              <span ref={lineRef} className="library__tab-underline" aria-hidden="true" />
            </div>
          </div>
          {overflow ? <TabScrollBar viewportRef={viewportRef} stripRef={stripRef} /> : null}
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
  icons: boolean
  onSelect: (tabId: string) => void
  onUp: () => boolean
}

const Tab = memo(function Tab({ tab, active, icons, onSelect, onUp }: TabProps): ReactElement {
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
  const settings = tab.id === LIBRARY_SETTINGS_TAB
  const customFilters = useCustomFilters()
  // "Icons for tabs": a tab with filters draws them, each choice its icon or else its words. All Games (no filters)
  // and a tab none of whose choices has an icon (only developers, say) keep their name.
  const parts = useMemo(() => {
    if (settings || !icons || !tab.groups?.length) return null
    const customIcons = new Map(customFilters.map((f) => [f.id, f.icon]))
    const groups = tab.groups.map((group): DrawnPart[] =>
      group.map((part) => ({ part, icon: tabPartIcon(part, (id) => customIcons.get(id)) }))
    )
    return groups.some((group) => group.some((p) => p.icon != null)) ? groups : null
  }, [settings, icons, tab.groups, customFilters])
  const drawn = parts !== null
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      className={cx(
        'library__tab',
        active && 'library__tab--active',
        drawn && 'library__tab--icons'
      )}
      data-tab-id={tab.id}
      {...controlProps}
      // The Settings tab shows a gear and wrench instead of its word, and a tab its filters' icons with "Icons for
      // tabs" on: the name stays for screen readers and the tooltip.
      {...(settings || drawn ? { 'aria-label': tab.label, title: tab.label } : {})}
    >
      {settings ? (
        <SettingsTabIcon className="library__tab-icon" />
      ) : drawn ? (
        <TabIcons groups={parts} />
      ) : (
        tab.label
      )}
    </button>
  )
})

/** One choice of a tab with "Icons for tabs" on: its icon, or its words when it has none. */
interface DrawnPart {
  part: TabNamePart
  icon: ReactNode
}

/**
 * A tab's choices as icons (lib/filterChoiceIcons.ts tabPartIcon: the Filters sub-menus' icons): a filter's choices a
 * thin gap apart, filters a wider gap apart, with a "·" between filters and a "+" between choices of one filter
 * wherever a choice without an icon keeps its words, as the tab's name joins them. At most MAX_TAB_ICONS icons, then
 * "+N".
 */
const TabIcons = memo(function TabIcons({
  groups
}: {
  groups: readonly (readonly DrawnPart[])[]
}): ReactElement {
  const drawn = useMemo(() => cappedTabGroups(groups, (p) => p.icon != null), [groups])
  return (
    <span className="library__tab-icons" aria-hidden="true">
      {drawn.groups.map((group, g) => {
        const prev = drawn.groups[g - 1]
        // A "·" between two filters where either side is words; between two icons the wider gap says it.
        const dot = !!prev && (!prev[prev.length - 1]!.icon || !group[0]!.icon)
        return (
          <Fragment key={`${group[0]!.part.kind}:${g}`}>
            {dot ? <span className="library__tab-sep">·</span> : null}
            <span
              className={cx('library__tab-filter', g > 0 && !dot && 'library__tab-filter--gap')}
            >
              {group.map(({ part, icon }, i) => (
                <Fragment key={`${part.kind}:${part.id}`}>
                  {/* A "+" wherever either neighbour is words; between two icons the thin gap says it. */}
                  {i > 0 && (!icon || !group[i - 1]!.icon) ? (
                    <span className="library__tab-sep">+</span>
                  ) : null}
                  {icon ? (
                    <span className="library__tab-choice" data-choice={`${part.kind}:${part.id}`}>
                      {icon}
                    </span>
                  ) : (
                    <span className="library__tab-word" data-choice={`${part.kind}:${part.id}`}>
                      {part.label}
                    </span>
                  )}
                </Fragment>
              ))}
            </span>
          </Fragment>
        )
      })}
      {drawn.more > 0 ? <span className="library__tab-more">+{drawn.more}</span> : null}
    </span>
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
