import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { cx } from '../lib/cx'

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  /** Text next to the ring. */
  label?: string
  className?: string
}

/** Indeterminate progress ring. */
export function Spinner({ size = 'md', label, className }: SpinnerProps): ReactElement {
  const t = useT()
  return (
    <span
      className={cx('spinner', size !== 'md' && `spinner--${size}`, className)}
      role="status"
      aria-label={label ?? t('components.spinner.loading')}
    >
      <span className="spinner__ring" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  )
}
