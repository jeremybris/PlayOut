import type { ReactElement, ReactNode } from 'react'
import { cx } from '../lib/cx'

export interface ChipProps {
  children: ReactNode
  /** 20u glyph before the text. */
  icon?: ReactNode
  /** Accent tint (e.g. "Installed"). */
  accent?: boolean
  className?: string
  title?: string
}

/** Small translucent tag: genre, "37 playing now", status. Not focusable. */
export function Chip({ children, icon, accent, className, title }: ChipProps): ReactElement {
  return (
    <span className={cx('chip', accent && 'chip--accent', className)} title={title}>
      {icon ? <span className="chip__icon">{icon}</span> : null}
      {children}
    </span>
  )
}
