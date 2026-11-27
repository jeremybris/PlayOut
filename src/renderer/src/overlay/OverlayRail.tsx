import { Download, Gauge, Monitor, Music, Network, Power, Settings, Users } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT } from '../i18n'
import { FocusContext, setFocus, useFocusable } from '../input/focus'
import { cx } from '../lib/cx'
import { useOverlayStore, type OverlayTab } from './overlayStore'
import { PANEL_FOCUS_KEY, RAIL_FOCUS_KEY, railKey, tabLabel } from './shared'

const TAB_ICONS: Record<OverlayTab, ReactNode> = {
  performance: <Gauge />,
  music: <Music />,
  display: <Monitor />,
  downloads: <Download />,
  friends: <Users />,
  peerparty: <Network />,
  settings: <Settings />,
  power: <Power />
}

/**
 * The left icon rail: Performance, Music, Display, Downloads and Friends at the top, Settings and Power at the bottom.
 * Friends comes last of the top group, so the tabs that were there keep their places (and their LB / RB steps). While
 * the game under the overlay runs through PeerParty, PeerParty stands in Friends' place (railTabs).
 * Focusing an entry shows its tab (the gamepad browses the tabs by moving up and down); A or a click moves into the
 * panel.
 */
export function OverlayRail(): ReactElement {
  const tab = useOverlayStore((s) => s.tab)
  const peerParty = useOverlayStore((s) => s.peerParty)
  const { ref, focusKey } = useFocusable<object, HTMLElement>({
    focusKey: RAIL_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: true,
    // Coming back from the panel lands on the tab being shown, never on a neighbour that would switch tabs.
    preferredChildFocusKey: railKey(tab)
  })
  const t = useT()
  return (
    <FocusContext.Provider value={focusKey}>
      <nav ref={ref} className="ov-rail" aria-label={t('overlay.rail.label')}>
        <div className="ov-rail__group">
          <RailItem tab="performance" />
          <RailItem tab="music" />
          <RailItem tab="display" />
          <RailItem tab="downloads" />
          {peerParty ? <RailItem key="peerparty" tab="peerparty" /> : <RailItem tab="friends" />}
        </div>
        <div className="ov-rail__group">
          <RailItem tab="settings" />
          <RailItem tab="power" />
        </div>
      </nav>
    </FocusContext.Provider>
  )
}

function RailItem({ tab }: { tab: OverlayTab }): ReactElement {
  const selected = useOverlayStore((s) => s.tab === tab)
  const setTab = useOverlayStore((s) => s.setTab)
  const label = tabLabel(useT(), tab)
  const { ref, props } = useFocusableControl<HTMLButtonElement>({
    focusKey: railKey(tab),
    // A mouse passing over the rail only highlights; it takes a click to switch.
    onFocus: (_layout, details) => {
      if ((details as { source?: string } | undefined)?.source !== 'mouse') setTab(tab)
    },
    onPress: () => {
      setTab(tab)
      void setFocus(PANEL_FOCUS_KEY)
    }
  })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ov-rail__item', selected && 'ov-rail__item--on')}
      aria-label={label}
      aria-current={selected ? 'page' : undefined}
      title={label}
      {...props}
    >
      {TAB_ICONS[tab]}
    </button>
  )
}
