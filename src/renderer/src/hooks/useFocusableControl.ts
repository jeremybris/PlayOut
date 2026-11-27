import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type RefObject
} from 'react'
import {
  useFocusable,
  type Direction,
  type FocusDetails,
  type FocusableComponentLayout,
  type KeyPressDetails
} from '../input/focus'
import { isStationaryMove, isSyntheticMouseEnter } from '../input/pointer'
import { useUiStore } from '../state/ui'
import { useScrollIntoView, type ScrollIntoViewOptions } from './useScrollIntoView'

/**
 * The shared behaviour of every focusable control (Button, IconButton, GameCard, Slider, keys, ...):
 * Norigin focusable + hover-to-focus + click/tap-to-activate + scroll into view. Spread `props` on the
 * element and attach `ref`; `focused` drives the visual state (also exposed as data-focused for CSS).
 */
export interface FocusableControlOptions {
  focusKey?: string
  /** Activation: A / Enter / click / tap. */
  onPress?: () => void
  /** Called when the control receives focus (any source). */
  onFocus?: (layout: FocusableComponentLayout, details: FocusDetails) => void
  onBlur?: (layout: FocusableComponentLayout, details: FocusDetails) => void
  /** Return false to consume a direction (e.g. a slider adjusting on left/right). */
  onArrowPress?: (direction: Direction, details: KeyPressDetails) => boolean
  disabled?: boolean
  /** Set false to keep the element out of navigation while still rendering it. */
  focusable?: boolean
  /** Mouse hover dwell before the control takes focus (cards use 60 ms). */
  hoverDelayMs?: number
  /** Scroll into view on focus: true (default), false, or options. */
  scroll?: boolean | ScrollIntoViewOptions
  /** Container options passed through to Norigin. */
  trackChildren?: boolean
  saveLastFocusedChild?: boolean
  preferredChildFocusKey?: string
  isFocusBoundary?: boolean
  autoRestoreFocus?: boolean
  forceFocus?: boolean
}

export interface FocusableControlProps {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onClick: (event: MouseEvent<HTMLElement>) => void
  'data-focused': 'true' | undefined
  tabIndex: -1
}

export interface FocusableControl<E extends HTMLElement = HTMLElement> {
  ref: RefObject<E | null>
  focused: boolean
  hasFocusedChild: boolean
  focusKey: string
  focusSelf: (details?: FocusDetails) => void
  props: FocusableControlProps
}

export function useFocusableControl<E extends HTMLElement = HTMLElement>(
  options: FocusableControlOptions
): FocusableControl<E> {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const onEnterPress = useCallback(() => {
    const current = latest.current
    if (!current.disabled) current.onPress?.()
  }, [])
  const onFocus = useCallback(
    (layout: FocusableComponentLayout, _props: object, details: FocusDetails) => {
      latest.current.onFocus?.(layout, details)
    },
    []
  )
  const onBlur = useCallback(
    (layout: FocusableComponentLayout, _props: object, details: FocusDetails) => {
      latest.current.onBlur?.(layout, details)
    },
    []
  )
  const onArrowPress = useCallback(
    (direction: string, _props: object, details: KeyPressDetails) => {
      const handler = latest.current.onArrowPress
      return handler ? handler(direction as Direction, details) : true
    },
    []
  )

  const { ref, focused, hasFocusedChild, focusKey, focusSelf } = useFocusable<object, E>({
    focusKey: options.focusKey,
    focusable: options.focusable !== false && !options.disabled,
    onEnterPress,
    onFocus,
    onBlur,
    onArrowPress,
    trackChildren: options.trackChildren,
    saveLastFocusedChild: options.saveLastFocusedChild,
    preferredChildFocusKey: options.preferredChildFocusKey,
    isFocusBoundary: options.isFocusBoundary,
    autoRestoreFocus: options.autoRestoreFocus,
    forceFocus: options.forceFocus
  })

  const scrollOptions = typeof options.scroll === 'object' ? options.scroll : undefined
  useScrollIntoView(
    ref as RefObject<HTMLElement | null>,
    focused && options.scroll !== false,
    scrollOptions
  )

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearHover = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])
  useEffect(() => clearHover, [clearHover])

  // A synthetic enter (see onPointerEnter) arms the control: the first pointermove with real motion over
  // it is then the hover the enter was not.
  const armed = useRef(false)

  const beginHover = useCallback(() => {
    clearHover()
    // Hover is mouse input even before the pointermove reaches the window listener (pointer.ts).
    useUiStore.getState().setInputMethod('mouse')
    const delay = latest.current.hoverDelayMs ?? 0
    if (delay > 0) {
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null
        focusSelf({ source: 'mouse' })
      }, delay)
    } else {
      focusSelf({ source: 'mouse' })
    }
  }, [clearHover, focusSelf])

  const hoverable = useCallback(
    (event: PointerEvent<HTMLElement>): boolean =>
      event.pointerType === 'mouse' &&
      !latest.current.disabled &&
      latest.current.focusable !== false,
    []
  )

  const onPointerEnter = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!hoverable(event)) return
      // A card that slides under a stationary cursor (scrollIntoView, the row stack's translateY while the
      // gamepad navigates, the window appearing under the cursor) fires pointerenter without any mouse
      // motion: neither a hover nor mouse input until the cursor really moves over the control.
      if (isSyntheticMouseEnter(event)) {
        armed.current = true
        return
      }
      armed.current = false
      beginHover()
    },
    [hoverable, beginHover]
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!armed.current || !hoverable(event) || isStationaryMove(event)) return
      armed.current = false
      beginHover()
    },
    [hoverable, beginHover]
  )

  const onPointerLeave = useCallback(() => {
    armed.current = false
    clearHover()
  }, [clearHover])

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      clearHover()
      if (latest.current.disabled) return
      event.stopPropagation()
      focusSelf({ source: useUiStore.getState().inputMethod })
      latest.current.onPress?.()
    },
    [clearHover, focusSelf]
  )

  return {
    ref: ref as RefObject<E | null>,
    focused,
    hasFocusedChild,
    focusKey,
    focusSelf,
    props: {
      onPointerEnter,
      onPointerMove,
      onPointerLeave,
      onClick,
      'data-focused': focused ? 'true' : undefined,
      tabIndex: -1
    }
  }
}
