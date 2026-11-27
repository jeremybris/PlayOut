import { Check } from 'lucide-react'
import type { MouseEvent, ReactElement } from 'react'
import { Menu, MenuItem } from '../components/MenuItem'
import { LayerContext, useActionHandlersOnLayer } from '../hooks/useActionHandlers'
import { useFocusLayer } from '../hooks/useFocusLayer'
import { FocusContext } from '../input/focus'

export interface DrawerOption {
  key: string
  label: string
  /** A second, smaller line under the label (what a performance overlay level shows). */
  detail?: string
  selected: boolean
}

export interface OptionDrawerProps {
  focusKey: string
  title: string
  options: readonly DrawerOption[]
  onSelect: (key: string) => void
  onClose: () => void
}

/**
 * A drawer of choices that slides out beside the panel (refresh rate, resolution, frame rate limit, performance
 * overlay). It is its own focus and action
 * layer: B / Escape / a click beside it close it and focus returns to the tile that opened it.
 */
export function OptionDrawer({
  focusKey,
  title,
  options,
  onSelect,
  onClose
}: OptionDrawerProps): ReactElement {
  const selected = options.find((o) => o.selected)
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey: selected ? `${focusKey}:${selected.key}` : undefined
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    }
  })
  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }
  return (
    <div className="ov-drawer-backdrop" onClick={onBackdrop}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={focusKey}>
          <div ref={ref} className="ov-drawer" role="dialog" aria-label={title}>
            <div className="ov-drawer__title">{title}</div>
            <div className="ov-drawer__list">
              <Menu aria-label={title}>
                {options.map((option) => (
                  <MenuItem
                    key={option.key}
                    focusKey={`${focusKey}:${option.key}`}
                    label={option.label}
                    selected={option.selected}
                    className={option.detail ? 'ov-drawer__item--detail' : undefined}
                    trailing={
                      option.selected || option.detail ? (
                        <>
                          {option.selected ? <Check className="ov-drawer__check" /> : null}
                          {option.detail ? (
                            <span className="ov-drawer__detail">{option.detail}</span>
                          ) : null}
                        </>
                      ) : undefined
                    }
                    onPress={() => {
                      onClose()
                      if (!option.selected) onSelect(option.key)
                    }}
                  />
                ))}
              </Menu>
            </div>
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>
  )
}
