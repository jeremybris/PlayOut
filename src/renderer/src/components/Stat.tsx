import type { ReactElement, ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { cx } from '../lib/cx'

export interface StatProps {
  /** Uppercase label: 'TOTAL PLAY TIME' (or its full and short forms, for a row that may be compact). */
  label: ReactNode
  /** Big value: '9.4 Hours', '25/40'. */
  value: ReactNode
  /** Right of the value (e.g. the achievements chevron). */
  trailing?: ReactNode
  /** When given the block is focusable and activates with A / click (achievements list). */
  onPress?: () => void
  focusKey?: string
  className?: string
}

/** Label-over-value block for action bars (detail panel) and the quick panel. */
export function Stat({
  label,
  value,
  trailing,
  onPress,
  focusKey,
  className
}: StatProps): ReactElement {
  const { ref, props: controlProps } = useFocusableControl<HTMLDivElement>({
    focusKey,
    onPress,
    focusable: !!onPress,
    scroll: false
  })
  const props = onPress ? { ...controlProps, role: 'button' as const } : {}
  return (
    <div ref={ref} className={cx('stat', onPress && 'stat--button', className)} {...props}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">
        {value}
        {trailing}
      </span>
    </div>
  )
}
