import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { useFocusableControl } from '../hooks/useFocusableControl'
import { cx } from '../lib/cx'

/** Idle time after the last arrow press before onCommit fires (pointer drags commit on release). */
const COMMIT_IDLE_MS = 300

export interface SliderProps {
  label?: string
  description?: string
  /** 24u glyph left of the label (e.g. <Volume2 />). */
  icon?: ReactNode
  value: number
  min?: number
  max?: number
  step?: number
  /** Every change (arrow press, drag). */
  onChange: (value: number) => void
  /** Settled value: after a drag ends or 300 ms after the last arrow press. Use it for IPC calls. */
  onCommit?: (value: number) => void
  /** Text right of the track; default `${value}%` when max is 100, else the number. */
  formatValue?: (value: number) => string
  focusKey?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

function clamp(value: number, min: number, max: number, step: number): number {
  const stepped = Math.round((value - min) / step) * step + min
  const fixed = Number(stepped.toFixed(6))
  return Math.min(max, Math.max(min, fixed))
}

/** Focusable range control: left/right adjust by `step` (consuming the direction), drag or tap the track to set. */
export function Slider({
  label,
  description,
  icon,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  onCommit,
  formatValue,
  focusKey,
  disabled,
  className,
  'aria-label': ariaLabel
}: SliderProps): ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ value, onChange, onCommit })
  useEffect(() => {
    latest.current = { value, onChange, onCommit }
  })
  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current)
    },
    []
  )

  const scheduleCommit = useCallback((next: number) => {
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null
      latest.current.onCommit?.(next)
    }, COMMIT_IDLE_MS)
  }, [])

  const { ref, props: controlProps } = useFocusableControl<HTMLDivElement>({
    focusKey,
    disabled,
    onArrowPress: (direction) => {
      if (direction !== 'left' && direction !== 'right') return true
      const next = clamp(
        latest.current.value + (direction === 'right' ? step : -step),
        min,
        max,
        step
      )
      if (next !== latest.current.value) {
        latest.current.onChange(next)
        scheduleCommit(next)
      }
      // Consume left/right even at the ends so focus never jumps sideways out of a slider.
      return false
    }
  })

  const valueFromPointer = useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track) return latest.current.value
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return latest.current.value
      const ratio = (clientX - rect.left) / rect.width
      return clamp(min + ratio * (max - min), min, max, step)
    },
    [min, max, step]
  )

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (disabled || event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
      const next = valueFromPointer(event.clientX)
      if (next !== latest.current.value) latest.current.onChange(next)
    },
    [disabled, valueFromPointer]
  )
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      const next = valueFromPointer(event.clientX)
      if (next !== latest.current.value) latest.current.onChange(next)
    },
    [dragging, valueFromPointer]
  )
  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      setDragging(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId)
      latest.current.onCommit?.(latest.current.value)
    },
    [dragging]
  )

  const ratio = max > min ? (value - min) / (max - min) : 0
  const percent = `${Math.round(Math.min(1, Math.max(0, ratio)) * 1000) / 10}%`
  const text = formatValue
    ? formatValue(value)
    : max === 100 && min === 0
      ? `${Math.round(value)}%`
      : String(value)

  return (
    <div
      ref={ref}
      className={cx('control', 'slider', disabled && 'control--disabled', className)}
      role="slider"
      aria-label={ariaLabel ?? label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={text}
      aria-disabled={disabled || undefined}
      {...controlProps}
    >
      {icon ? <span className="control__icon">{icon}</span> : null}
      {label || description ? (
        <div className="control__text">
          {label ? <span className="control__label">{label}</span> : null}
          {description ? <span className="control__desc">{description}</span> : null}
        </div>
      ) : null}
      <div className="slider__body">
        <div
          ref={trackRef}
          className="slider__track"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="slider__fill" style={{ width: percent }} />
          <div className="slider__thumb" style={{ left: percent }} />
        </div>
        <span className="slider__value">{text}</span>
      </div>
    </div>
  )
}
