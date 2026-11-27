import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { cx } from '../lib/cx'

export interface PillProps {
  children: ReactNode
  /** glass = blurred translucent material (system bar, quick actions; default), solid = opaque surface (store pill). */
  variant?: 'glass' | 'solid'
  /** sm = 50u store pill, md = 56u quick action (default), lg = 74u system pill. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
  style?: CSSProperties
  role?: string
  'aria-label'?: string
}

/** Non-focusable translucent pill container. Put focusable items inside it. */
export function Pill({
  children,
  variant = 'glass',
  size = 'md',
  className,
  style,
  role,
  'aria-label': ariaLabel
}: PillProps): ReactElement {
  return (
    <div
      className={cx(
        'pill',
        variant === 'glass' ? 'glass' : 'pill--solid',
        size !== 'md' && `pill--${size}`,
        className
      )}
      style={style}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  )
}

/** Thin vertical separator between pill items (system bar). */
export function PillDivider(): ReactElement {
  return <span className="pill__divider" aria-hidden="true" />
}
