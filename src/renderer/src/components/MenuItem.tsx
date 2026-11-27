import { useEffect, type ReactElement, type ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import type { Direction } from '../input/focus'
import { cx } from '../lib/cx'

export interface MenuProps {
  children: ReactNode
  className?: string
  'aria-label'?: string
}

/** Vertical list container for MenuItems (power menu, context menus, settings nav). Not focusable itself. */
export function Menu({ children, className, 'aria-label': ariaLabel }: MenuProps): ReactElement {
  return (
    <div className={cx('menu', className)} role="menu" aria-label={ariaLabel}>
      {children}
    </div>
  )
}

export interface MenuItemProps {
  label: string
  /** A picture shown in place of the label's words (the label is then what assistive tech reads). */
  art?: ReactNode
  /** 24u glyph before the label. */
  icon?: ReactNode
  /** Right-aligned extra (a value, a chevron, a Chip). */
  trailing?: ReactNode
  /** Red text for destructive rows. */
  danger?: boolean
  /** Highlighted as the current selection (settings nav). */
  selected?: boolean
  onPress?: () => void
  onFocus?: () => void
  /** Return false to consume the direction (a row that opens or closes a sub-menu sideways). */
  onArrowPress?: (direction: Direction) => boolean
  focusKey?: string
  disabled?: boolean
  autoFocus?: boolean
  className?: string
}

/** One focusable 56u row of a Menu. */
export function MenuItem({
  label,
  art,
  icon,
  trailing,
  danger,
  selected,
  onPress,
  onFocus,
  onArrowPress,
  focusKey,
  disabled,
  autoFocus,
  className
}: MenuItemProps): ReactElement {
  const {
    ref,
    props: controlProps,
    focusSelf
  } = useFocusableControl<HTMLDivElement>({
    focusKey,
    onPress,
    disabled,
    onFocus: onFocus ? () => onFocus() : undefined,
    onArrowPress,
    scroll: { inline: 'nearest', block: 'nearest' }
  })
  useEffect(() => {
    if (autoFocus) focusSelf()
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      ref={ref}
      className={cx(
        'menu__item',
        danger && 'menu__item--danger',
        selected && 'menu__item--selected',
        disabled && 'control--disabled',
        className
      )}
      role="menuitem"
      aria-disabled={disabled || undefined}
      aria-current={selected || undefined}
      {...controlProps}
    >
      {icon}
      {art ? (
        <span className="u-grow menu__item-art" role="img" aria-label={label}>
          {art}
        </span>
      ) : (
        <span className="u-grow u-truncate">{label}</span>
      )}
      {trailing}
    </div>
  )
}
