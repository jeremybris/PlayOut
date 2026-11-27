import { ArrowUpDown, Copy, Menu } from 'lucide-react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/cx'
import { displayButton, type HintButton } from '../lib/hintButton'
import { useSettingsStore } from '../state/settings'
import { useUiStore } from '../state/ui'

export type { HintButton }

export interface Hint {
  /** The standard-layout button for the action ('a' = accept, 'b' = back); drawn swapped when settings.input.swapAB is on. */
  button: HintButton
  label: string
}

export interface ButtonHintsProps {
  hints: Hint[]
  className?: string
}

const GLYPH_TEXT: Record<HintButton, string> = {
  a: 'A',
  b: 'B',
  x: 'X',
  y: 'Y',
  lb: 'LB',
  rb: 'RB',
  lt: 'LT',
  rt: 'RT',
  start: '',
  select: '',
  dpad: '',
  rs: 'RS'
}

/**
 * Bottom-right bar of controller glyphs with labels ("A Select  B Back"). Hidden while the mouse or touch
 * is the active input method. Portaled to <body> so it sits at the screen edge even when rendered inside
 * a modal (whose transform would otherwise contain the fixed bar). Render one per screen/modal. With the
 * 'Swap A and B' setting on (Nintendo layout) the A and B glyphs are swapped to match input/gamepad.ts.
 */
export function ButtonHints({ hints, className }: ButtonHintsProps): ReactElement | null {
  const inputMethod = useUiStore((s) => s.inputMethod)
  const swapAB = useSettingsStore((s) => s.settings?.input.swapAB ?? false)
  if (inputMethod === 'mouse' || inputMethod === 'touch' || hints.length === 0) return null
  return createPortal(
    <div className={cx('hints', className)} aria-hidden="true">
      {hints.map((hint) => {
        const shown = displayButton(hint.button, swapAB)
        return (
          <span key={`${hint.button}:${hint.label}`} className="hint">
            <span className={cx('hint__glyph', `hint__glyph--${shown}`)}>
              {shown === 'start' ? (
                <Menu size="60%" />
              ) : shown === 'select' ? (
                <Copy size="60%" />
              ) : shown === 'dpad' ? (
                <ArrowUpDown size="60%" />
              ) : (
                GLYPH_TEXT[shown]
              )}
            </span>
            <span className="hint__label">{hint.label}</span>
          </span>
        )
      })}
    </div>,
    document.body
  )
}
