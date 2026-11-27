import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { LayerContext, useActionHandlersOnLayer } from '../hooks/useActionHandlers'
import { useFocusLayer } from '../hooks/useFocusLayer'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT } from '../i18n'
import { FocusContext } from '../input/focus'
import { cx } from '../lib/cx'
import { registerPopupOpener } from '../lib/popupOpeners'
import { Menu, MenuItem } from './MenuItem'
import { placeSelectMenu } from './selectMenuPlacement'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  /** Row variant: a picture shown for the option in place of its text (`label` is what assistive tech reads). */
  art?: ReactNode
  /** Pill variant's menu: an icon left of the option's name (the Sort menu's). */
  icon?: ReactNode
}

export interface SelectFieldProps<T extends string = string> {
  label: string
  description?: string
  /** 24u glyph left of the label. */
  icon?: ReactNode
  /** Shown beside the chosen option's text (a platform's badge). */
  valueIcon?: ReactNode
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  focusKey?: string
  disabled?: boolean
  /** Row variant: wrap around at the ends (default true). */
  wrap?: boolean
  /**
   * row (default) = settings row with the label, the value and previous/next arrows; left/right cycle the
   * options and are consumed so focus stays on the row, A / Enter / click advances.
   * pill = a compact pill showing only the value and a chevron (the label names it for assistive tech);
   * A / Enter / click opens an anchored popup list of the options, left/right move to the neighbouring control.
   */
  variant?: 'row' | 'pill'
  /**
   * Pill only: the picked option carries a down or up arrow (its direction) instead of a tick, and picking it again
   * calls `onChange` with the same value, which the caller turns into a reversal (the Library's sort).
   */
  direction?: 'down' | 'up'
  className?: string
}

/**
 * Option picker. As a settings row, left/right (or the arrow buttons) cycle through `options` and A /
 * Enter advances to the next one. As a pill (the Library header), activation opens a popup list below the
 * pill (its own focus and action layer, like the Play menu) and the arrows are left to spatial navigation.
 */
export function SelectField<T extends string = string>({
  label,
  description,
  icon,
  valueIcon,
  value,
  options,
  onChange,
  focusKey,
  disabled,
  wrap = true,
  variant = 'row',
  direction,
  className
}: SelectFieldProps<T>): ReactElement {
  const t = useT()
  const latest = useRef({ value, options, onChange, wrap, variant })
  useEffect(() => {
    latest.current = { value, options, onChange, wrap, variant }
  })
  // The pill's popup, anchored to the pill element (captured when it opens: refs are not read in render).
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const menuOpen = menuAnchor !== null

  const move = (delta: 1 | -1): boolean => {
    const { options: list, value: current, onChange: change, wrap: around } = latest.current
    if (list.length === 0) return false
    const index = Math.max(
      0,
      list.findIndex((o) => o.value === current)
    )
    let next = index + delta
    if (next < 0) next = around ? list.length - 1 : 0
    if (next >= list.length) next = around ? 0 : list.length - 1
    if (next === index) return false
    change(list[next]!.value)
    return true
  }

  const {
    ref,
    props: controlProps,
    focusKey: ownFocusKey
  } = useFocusableControl<HTMLDivElement>({
    focusKey,
    disabled,
    onPress: () => {
      if (latest.current.variant === 'pill') setMenuAnchor(ref.current)
      else move(1)
    },
    onArrowPress: (direction) => {
      if (direction !== 'left' && direction !== 'right') return true
      // The pill sits in a horizontal header: let the focus engine move to the neighbouring control.
      if (latest.current.variant === 'pill') return true
      move(direction === 'left' ? -1 : 1)
      return false
    }
  })

  // A pill's popup can be opened from elsewhere (lib/popupOpeners.ts: LT in the Library) without focusing the
  // pill first, so closing it gives focus back to where it was.
  useEffect(() => {
    if (variant !== 'pill' || disabled) return undefined
    return registerPopupOpener(ownFocusKey, () => setMenuAnchor(ref.current))
  }, [variant, disabled, ownFocusKey, ref])

  const onPrevious = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (!disabled) move(-1)
  }
  const onNext = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (!disabled) move(1)
  }

  const current = options.find((o) => o.value === value)

  if (variant === 'pill') {
    // The popup is a sibling of the pill, not a child: React events from the portal would otherwise
    // bubble into the pill's hover/click handlers and re-focus or re-open it.
    return (
      <>
        <div
          ref={ref}
          className={cx('select', 'select--pill', disabled && 'control--disabled', className)}
          role="group"
          aria-label={label}
          aria-disabled={disabled || undefined}
          aria-expanded={menuOpen}
          title={label}
          {...controlProps}
        >
          {icon ? <span className="control__icon">{icon}</span> : null}
          <span className="select__value" aria-live="polite">
            {valueIcon ? <span className="select__value-icon">{valueIcon}</span> : null}
            {current?.art ? (
              <span className="select__value-art" role="img" aria-label={current.label}>
                {current.art}
              </span>
            ) : (
              (current?.label ?? value)
            )}
          </span>
          {direction ? (
            <span
              className="select__direction"
              aria-label={direction === 'up' ? t('components.selectField.reversed') : undefined}
            >
              <DirectionArrow direction={direction} />
            </span>
          ) : null}
          <span className="select__chevron" aria-hidden="true">
            <ChevronDown />
          </span>
        </div>
        {menuAnchor ? (
          <SelectMenu
            anchor={menuAnchor}
            focusKey={`${ownFocusKey}:menu`}
            label={label}
            value={value}
            options={options}
            direction={direction}
            onSelect={(next) => {
              setMenuAnchor(null)
              if (next !== value || direction) onChange(next)
            }}
            onClose={() => setMenuAnchor(null)}
          />
        ) : null}
      </>
    )
  }

  return (
    <div
      ref={ref}
      className={cx('control', 'select', disabled && 'control--disabled', className)}
      role="group"
      aria-label={label}
      aria-disabled={disabled || undefined}
      {...controlProps}
    >
      {icon ? <span className="control__icon">{icon}</span> : null}
      <div className="control__text">
        <span className="control__label">{label}</span>
        {description ? <span className="control__desc">{description}</span> : null}
      </div>
      <div className="control__body">
        <button
          type="button"
          className="select__arrow"
          aria-label={t('components.selectField.previousOption')}
          tabIndex={-1}
          onClick={onPrevious}
        >
          <ChevronLeft />
        </button>
        <span className="select__value" aria-live="polite">
          {valueIcon ? <span className="select__value-icon">{valueIcon}</span> : null}
          {current?.art ? (
            <span className="select__value-art" role="img" aria-label={current.label}>
              {current.art}
            </span>
          ) : (
            (current?.label ?? value)
          )}
        </span>
        <button
          type="button"
          className="select__arrow"
          aria-label={t('components.selectField.nextOption')}
          tabIndex={-1}
          onClick={onNext}
        >
          <ChevronRight />
        </button>
      </div>
    </div>
  )
}

/** The direction arrow of a sort-like pill: down for the order's own direction, up for reversed. */
function DirectionArrow({ direction }: { direction: 'down' | 'up' }): ReactElement {
  return direction === 'up' ? (
    <ArrowUp className="select-menu__direction" aria-hidden="true" />
  ) : (
    <ArrowDown className="select-menu__direction" aria-hidden="true" />
  )
}

interface SelectMenuProps<T extends string> {
  anchor: HTMLElement
  focusKey: string
  label: string
  value: T
  options: readonly SelectOption<T>[]
  direction?: 'down' | 'up'
  onSelect: (value: T) => void
  onClose: () => void
}

/**
 * The pill's popup: every option as a MenuItem (the current one ticked), below the pill and at least as
 * wide, or above it when there is more room there. Portaled to <body> with its own focus and action
 * layer, so B / Escape / a click outside close it and focus returns to the pill.
 */
function SelectMenu<T extends string>({
  anchor,
  focusKey,
  label,
  value,
  options,
  direction,
  onSelect,
  onClose
}: SelectMenuProps<T>): ReactElement {
  const { ref, layerId } = useFocusLayer<HTMLDivElement>({
    focusKey,
    preferredChildFocusKey: `${focusKey}:${value}`
  })
  useActionHandlersOnLayer(layerId, {
    back: () => {
      onClose()
      return true
    }
  })
  const [position, setPosition] = useState(() => placeSelectMenu(anchor, options.length))
  useEffect(() => {
    const update = (): void => setPosition(placeSelectMenu(anchor, options.length))
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor, options.length])

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.target === event.currentTarget) onClose()
  }

  return createPortal(
    <div className="select-menu-backdrop" onClick={onBackdropClick}>
      <LayerContext.Provider value={layerId}>
        <FocusContext.Provider value={focusKey}>
          <div
            ref={ref}
            className={cx('select-menu', position.above && 'select-menu--above')}
            style={position.style}
            role="listbox"
            aria-label={label}
            data-focus-key={focusKey}
          >
            <Menu>
              {options.map((option) => (
                <MenuItem
                  key={option.value}
                  focusKey={`${focusKey}:${option.value}`}
                  label={option.label}
                  icon={option.icon}
                  selected={option.value === value}
                  trailing={
                    option.value !== value ? undefined : direction ? (
                      <DirectionArrow direction={direction} />
                    ) : (
                      <Check className="select-menu__check" />
                    )
                  }
                  onPress={() => onSelect(option.value)}
                />
              ))}
            </Menu>
          </div>
        </FocusContext.Provider>
      </LayerContext.Provider>
    </div>,
    document.body
  )
}
