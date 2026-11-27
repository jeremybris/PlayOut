import type { ReactElement, ReactNode } from 'react'
import { cx } from '../lib/cx'

export interface EmptyStateProps {
  /** Large lucide icon above the title. */
  icon?: ReactNode
  title: string
  description?: string
  /** Usually a <Button>. */
  action?: ReactNode
  className?: string
}

/** Centred "nothing here" block with an optional call to action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className
}: EmptyStateProps): ReactElement {
  return (
    <div className={cx('empty', className)}>
      {icon ? <span className="empty__icon">{icon}</span> : null}
      <div className="empty__title">{title}</div>
      {description ? <div className="empty__desc">{description}</div> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  )
}
