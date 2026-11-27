import { Minus, Plus } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type RefObject,
  type WheelEvent
} from 'react'
import { COVER_SCALE_STEPS, coverScaleIndex, stepCoverScale } from '@shared/cover-scale'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { setFocus } from '../../input/focus'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { COVER_LARGER_KEY, COVER_SIZE_KEY, COVER_SMALLER_KEY } from './keys'

/** A wheel (or a trackpad's stream of small wheel events) changes one step per this many ms at most. */
const WHEEL_STEP_MS = 120

export interface CoverSizeSliderProps {
  /** The current step (settings.ui.libraryCoverScale). */
  value: number
  /** A new step: the covers of every Library tab follow it. */
  onChange: (value: number) => void
  /** D-pad right from any of its parts: back to the grid (false when the grid took it). */
  onRight: () => boolean
  /** The slider's outer element, for coverSizeKeyAt (coverSizeTarget.ts). */
  containerRef?: RefObject<HTMLDivElement | null>
}

/**
 * The cover-size slider in the Library's left gutter (every tab but Settings): "−" at the top, "+" at the bottom and a
 * track between them whose diamond marks the step. The top end is the smallest size. Drag the diamond (it snaps to
 * the steps), tap the track, turn the wheel over it or press − / +; with a controller, up / down on the focused track
 * change the size (and never move focus off the slider: on − / + they move it to the track and step), A on − / +
 * steps, right goes back to the grid.
 */
export const CoverSizeSlider = memo(function CoverSizeSlider({
  value,
  onChange,
  onRight,
  containerRef
}: CoverSizeSliderProps): ReactElement {
  const t = useT()
  const index = coverScaleIndex(value)
  const last = COVER_SCALE_STEPS.length - 1
  const latest = useRef({ value, onChange, onRight })
  useEffect(() => {
    latest.current = { value, onChange, onRight }
  })

  const step = useCallback((delta: 1 | -1) => {
    const next = stepCoverScale(latest.current.value, delta)
    if (next === latest.current.value) return
    // Kept at once, so presses faster than a render each step from the last one.
    latest.current.value = next
    latest.current.onChange(next)
  }, [])
  const setIndex = useCallback((i: number) => {
    const next = COVER_SCALE_STEPS[Math.max(0, Math.min(COVER_SCALE_STEPS.length - 1, i))]!
    if (next === latest.current.value) return
    latest.current.value = next
    latest.current.onChange(next)
  }, [])
  // On − / +: right goes back to the grid, and up / down never leave the slider: they move the focus to the track
  // (where up / down keep working) and change the size there, like up / down on the track itself.
  const buttonArrow = useCallback(
    (direction: string): boolean => {
      if (direction === 'up' || direction === 'down') {
        setFocus(COVER_SIZE_KEY)
        step(direction === 'up' ? -1 : 1)
        return false
      }
      return direction === 'right' ? latest.current.onRight() : true
    },
    [step]
  )

  // − and + stay focus stops at the ends (dimmed, A does nothing), so a focused one never loses the focus.
  const smaller = useFocusableControl<HTMLButtonElement>({
    focusKey: COVER_SMALLER_KEY,
    onPress: () => step(-1),
    onArrowPress: buttonArrow,
    scroll: false
  })
  const larger = useFocusableControl<HTMLButtonElement>({
    focusKey: COVER_LARGER_KEY,
    onPress: () => step(1),
    onArrowPress: buttonArrow,
    scroll: false
  })
  const track = useFocusableControl<HTMLDivElement>({
    focusKey: COVER_SIZE_KEY,
    scroll: false,
    onArrowPress: (direction) => {
      if (direction === 'up' || direction === 'down') {
        step(direction === 'up' ? -1 : 1)
        // Consumed even at the ends: up / down only ever change the size here.
        return false
      }
      if (direction === 'left') return false
      return latest.current.onRight()
    }
  })

  // ---- pointer: drag the diamond or tap the track (snapping to the nearest step) -------------------------------
  const railRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const indexAt = useCallback((clientY: number): number | null => {
    const rail = railRef.current
    if (!rail) return null
    const rect = rail.getBoundingClientRect()
    if (!(rect.height > 0)) return null
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    return Math.round(ratio * (COVER_SCALE_STEPS.length - 1))
  }, [])
  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // a synthetic pointer (tests) has nothing to capture
      }
      setDragging(true)
      track.focusSelf({ source: 'mouse' })
      const i = indexAt(event.clientY)
      if (i !== null) setIndex(i)
    },
    [indexAt, setIndex, track]
  )
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      const i = indexAt(event.clientY)
      if (i !== null) setIndex(i)
    },
    [dragging, indexAt, setIndex]
  )
  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      setDragging(false)
      const i = indexAt(event.clientY)
      if (i !== null) setIndex(i)
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [dragging, indexAt, setIndex]
  )

  // ---- wheel: down = bigger (toward +), up = smaller ---------------------------------------------------------------
  const lastWheel = useRef(0)
  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY === 0) return
      const now = Date.now()
      if (now - lastWheel.current < WHEEL_STEP_MS) return
      lastWheel.current = now
      step(event.deltaY > 0 ? 1 : -1)
    },
    [step]
  )

  const percent = Math.round(COVER_SCALE_STEPS[index]! * 100)
  const position = `${(index / last) * 100}%`
  return (
    <div
      ref={containerRef}
      className="library__cover-size"
      role="group"
      aria-label={t('library.coverSize.label')}
      onWheel={onWheel}
    >
      <button
        ref={smaller.ref}
        type="button"
        className="library__cover-size-button"
        aria-label={t('library.coverSize.smaller')}
        aria-disabled={index === 0 || undefined}
        {...smaller.props}
        onClick={index === 0 ? undefined : smaller.props.onClick}
      >
        <Minus aria-hidden="true" />
      </button>
      <div
        ref={track.ref}
        className={cx('library__cover-size-track', dragging && 'library__cover-size-track--drag')}
        role="slider"
        aria-label={t('library.coverSize.label')}
        aria-orientation="vertical"
        aria-valuemin={Math.round(COVER_SCALE_STEPS[0] * 100)}
        aria-valuemax={Math.round(COVER_SCALE_STEPS[last]! * 100)}
        aria-valuenow={percent}
        aria-valuetext={t('library.coverSize.value', { n: percent })}
        {...track.props}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          track.props.onPointerMove(event)
          onPointerMove(event)
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={railRef} className="library__cover-size-rail">
          {COVER_SCALE_STEPS.map((s, i) => (
            <span
              key={s}
              className={cx(
                'library__cover-size-tick',
                s === 1 && 'library__cover-size-tick--default'
              )}
              style={{ top: `${(i / last) * 100}%` }}
              aria-hidden="true"
            />
          ))}
          <span
            className="library__cover-size-thumb"
            style={{ top: position }}
            aria-hidden="true"
          />
        </div>
      </div>
      <button
        ref={larger.ref}
        type="button"
        className="library__cover-size-button"
        aria-label={t('library.coverSize.larger')}
        aria-disabled={index === last || undefined}
        {...larger.props}
        onClick={index === last ? undefined : larger.props.onClick}
      >
        <Plus aria-hidden="true" />
      </button>
    </div>
  )
})
