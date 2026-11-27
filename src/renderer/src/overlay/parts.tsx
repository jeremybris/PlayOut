import type { ReactElement, ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { useT } from '../i18n'
import { cx } from '../lib/cx'

/** A titled block of the overlay panel (the uppercase label style of Settings' sections). */
export function OverlayGroup({
  title,
  aside,
  children,
  className
}: {
  title?: string
  /** Right of the title (a count, a small button). */
  aside?: ReactNode
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <section className={cx('ov-group', className)}>
      {title || aside ? (
        <div className="ov-group__head">
          {title ? <h3 className="ov-group__title">{title}</h3> : null}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** A selectable card (power profiles): title, one detail line, the selected state. */
export function ChoiceCard({
  focusKey,
  icon,
  title,
  detail,
  selected,
  onPress
}: {
  focusKey: string
  icon?: ReactNode
  title: string
  detail: string
  selected: boolean
  onPress: () => void
}): ReactElement {
  const { ref, props } = useFocusableControl<HTMLButtonElement>({ focusKey, onPress })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ov-card', selected && 'ov-card--on')}
      role="radio"
      aria-checked={selected}
      {...props}
    >
      {icon ? <span className="ov-card__icon">{icon}</span> : null}
      <span className="ov-card__title u-truncate">{title}</span>
      <span className="ov-card__detail">{detail}</span>
    </button>
  )
}

/** A filter chip (All / Display / Sound / System). */
export function FilterChip({
  focusKey,
  label,
  selected,
  onPress
}: {
  focusKey: string
  label: string
  selected: boolean
  onPress: () => void
}): ReactElement {
  const { ref, props } = useFocusableControl<HTMLButtonElement>({ focusKey, onPress })
  return (
    <button
      ref={ref}
      type="button"
      className={cx('ov-chip', selected && 'ov-chip--on')}
      aria-pressed={selected}
      {...props}
    >
      {label}
    </button>
  )
}

/**
 * A quick tile: icon, label and value. Focusable even without an action, so the gamepad can scroll the panel down to
 * read it; with `onPress` it opens something (a drawer of display modes) or, with `toggled`, switches something on
 * or off (drawn as an on/off pill). A `disabled` tile stays focusable so its `detail` (the reason) can be read, and
 * pressing it does nothing.
 */
export function QuickTile({
  focusKey,
  icon,
  label,
  value,
  detail,
  meter,
  toggled,
  disabled,
  onPress
}: {
  focusKey: string
  icon: ReactNode
  label: string
  value: string
  detail?: string
  /** 0-100: draws a thin usage bar. */
  meter?: number | null
  /** A switch tile: on (true) or off (false); draws the pill and sets aria-pressed. */
  toggled?: boolean
  disabled?: boolean
  onPress?: () => void
}): ReactElement {
  const press = disabled ? undefined : onPress
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLButtonElement>({ focusKey, onPress: press })
  const toggle = toggled !== undefined
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'ov-tile',
        press && 'ov-tile--action',
        toggle && 'ov-tile--toggle',
        disabled && 'ov-tile--disabled'
      )}
      aria-label={
        detail
          ? t('overlay.quick.tileDetail', { label, value, detail })
          : t('overlay.quick.tile', { label, value })
      }
      aria-pressed={toggle ? toggled : undefined}
      aria-disabled={disabled || undefined}
      {...props}
    >
      <span className="ov-tile__icon">{icon}</span>
      {toggle ? (
        <span className={cx('ov-tile__pill', toggled && 'ov-tile__pill--on')} aria-hidden="true">
          <span />
        </span>
      ) : null}
      <span className="ov-tile__label u-truncate">{label}</span>
      <span className="ov-tile__value u-truncate">{value}</span>
      {detail ? <span className="ov-tile__detail u-truncate">{detail}</span> : null}
      {meter !== undefined && meter !== null ? (
        <span className="ov-tile__meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, meter))}%` }} />
        </span>
      ) : null}
    </button>
  )
}
