import { useEffect, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { cx } from '../lib/cx'

export interface ButtonProps {
  children?: ReactNode
  /** primary = accent fill, secondary = control fill (default), ghost = transparent, danger = red. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  /** lg = Play-sized (76u). */
  size?: 'md' | 'lg'
  /** Icon slot before the label (24u). */
  icon?: ReactNode
  iconRight?: ReactNode
  /** A / Enter / click / tap. */
  onPress?: () => void
  focusKey?: string
  disabled?: boolean
  /** Take focus when mounted. */
  autoFocus?: boolean
  onFocus?: () => void
  className?: string
  style?: CSSProperties
  title?: string
  'aria-label'?: string
  /** Looks and reads as disabled but stays focusable (a busy button the D-pad must still reach). */
  'aria-disabled'?: boolean
}

/** Focusable push button. */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  onPress,
  focusKey,
  disabled,
  autoFocus,
  onFocus,
  className,
  style,
  title,
  'aria-label': ariaLabel,
  'aria-disabled': ariaDisabled
}: ButtonProps): ReactElement {
  const {
    ref,
    props: controlProps,
    focusSelf
  } = useFocusableControl<HTMLButtonElement>({
    focusKey,
    onPress,
    disabled,
    onFocus: onFocus ? () => onFocus() : undefined
  })
  useEffect(() => {
    if (autoFocus) focusSelf()
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'btn',
        `btn--${variant}`,
        size === 'lg' && 'btn--lg',
        disabled && 'btn--disabled',
        className
      )}
      style={style}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-disabled={ariaDisabled}
      {...controlProps}
    >
      {icon ? <span className="btn__icon">{icon}</span> : null}
      {children !== undefined && children !== null ? (
        <span className="btn__label">{children}</span>
      ) : null}
      {iconRight ? <span className="btn__icon">{iconRight}</span> : null}
    </button>
  )
}
