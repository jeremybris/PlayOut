import type { ReactElement } from 'react'
import { cx } from '../lib/cx'

export interface DividerProps {
  /** 1u wide, 52u tall line for action bars (default: full-width horizontal rule). */
  vertical?: boolean
  /** Brighter line (30 % white). */
  strong?: boolean
  /** No margin. */
  tight?: boolean
  className?: string
}

/** Hairline separator. */
export function Divider({ vertical, strong, tight, className }: DividerProps): ReactElement {
  return (
    <div
      className={cx(
        'divider',
        vertical && 'divider--vertical',
        strong && 'divider--strong',
        tight && 'divider--tight',
        className
      )}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
    />
  )
}
