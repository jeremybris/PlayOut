import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { cx } from '../lib/cx'

export interface ToggleProps {
  label: string
  description?: string
  /** 24u glyph left of the label. */
  icon?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  focusKey?: string
  disabled?: boolean
  className?: string
}

/**
 * Settings-row switch. A / Enter / click flip it; left turns it off and right turns it on (consumed only
 * when the state actually changes, so focus still leaves the row at the ends).
 */
export function Toggle({
  label,
  description,
  icon,
  checked,
  onChange,
  focusKey,
  disabled,
  className
}: ToggleProps): ReactElement {
  const latest = useRef({ checked, onChange })
  useEffect(() => {
    latest.current = { checked, onChange }
  })
  const { ref, props: controlProps } = useFocusableControl<HTMLDivElement>({
    focusKey,
    disabled,
    onPress: () => latest.current.onChange(!latest.current.checked),
    onArrowPress: (direction) => {
      if (direction !== 'left' && direction !== 'right') return true
      const next = direction === 'right'
      if (next === latest.current.checked) return true
      latest.current.onChange(next)
      return false
    }
  })
  return (
    <div
      ref={ref}
      className={cx(
        'control',
        'toggle',
        checked && 'toggle--on',
        disabled && 'control--disabled',
        className
      )}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      {...controlProps}
    >
      {icon ? <span className="control__icon">{icon}</span> : null}
      <div className="control__text">
        <span className="control__label">{label}</span>
        {description ? <span className="control__desc">{description}</span> : null}
      </div>
      <div className="control__body">
        <span className="toggle__switch" aria-hidden="true">
          <span className="toggle__knob" />
        </span>
      </div>
    </div>
  )
}
