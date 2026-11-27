import { useEffect, type ReactElement, type ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import type { Direction } from '../input/focus'
import { cx } from '../lib/cx'

export interface IconButtonProps {
  /** The glyph (a lucide icon element). */
  icon: ReactNode
  /** Required: icon-only controls need a name for assistive tech and tooltips. */
  'aria-label': string
  /** Optional caption chip rendered next to the button. */
  label?: string
  onPress?: () => void
  focusKey?: string
  /** sm = 44u (system pill items), md = 52u (default), lg = 64u. */
  size?: 'sm' | 'md' | 'lg'
  /** solid = control fill (default), glass = translucent surface (modal header), ghost = transparent. */
  variant?: 'solid' | 'glass' | 'ghost'
  /** round (default) or square with 12u corners (detail action bar). */
  shape?: 'round' | 'square'
  /** Accent-coloured glyph, e.g. favourite on. */
  active?: boolean
  disabled?: boolean
  autoFocus?: boolean
  onFocus?: () => void
  /** Arrow press while focused; return false to keep the focus engine from moving. */
  onArrowPress?: (direction: Direction) => boolean
  className?: string
}

/** Round focusable icon button. */
export function IconButton({
  icon,
  'aria-label': ariaLabel,
  label,
  onPress,
  focusKey,
  size = 'md',
  variant = 'solid',
  shape = 'round',
  active,
  disabled,
  autoFocus,
  onFocus,
  onArrowPress,
  className
}: IconButtonProps): ReactElement {
  const {
    ref,
    props: controlProps,
    focusSelf
  } = useFocusableControl<HTMLButtonElement>({
    focusKey,
    onPress,
    disabled,
    onFocus: onFocus ? () => onFocus() : undefined,
    onArrowPress
  })
  useEffect(() => {
    if (autoFocus) focusSelf()
    // on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const button = (
    <button
      ref={ref}
      type="button"
      className={cx(
        'icon-btn',
        size !== 'md' && `icon-btn--${size}`,
        variant !== 'solid' && `icon-btn--${variant}`,
        shape === 'square' && 'icon-btn--square',
        active && 'icon-btn--active',
        !label && className
      )}
      aria-label={ariaLabel}
      aria-pressed={active === undefined ? undefined : active}
      title={label ?? ariaLabel}
      disabled={disabled}
      {...controlProps}
    >
      {icon}
    </button>
  )
  if (!label) return button
  return (
    <span className={cx('icon-btn-wrap', className)}>
      {button}
      <span className="icon-btn__label">{label}</span>
    </span>
  )
}
