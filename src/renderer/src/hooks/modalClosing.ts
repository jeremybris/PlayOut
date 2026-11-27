import { createContext, useContext } from 'react'

/**
 * Exit-animation hand-off between App's ModalHost and the Modal component. A modal that left the ui
 * store's stack stays mounted (ModalHost keeps it) until its exit animation ends; the host tells the
 * Modal that it is closing through this context and the Modal reports back when the animation is done.
 * Kept out of the component files so React fast-refresh keeps working.
 */
export interface ModalClosing {
  closing: boolean
  /** Called by the Modal when its exit animation has ended (or at once when there is none). */
  onClosed: () => void
}

const NOT_CLOSING: ModalClosing = { closing: false, onClosed: () => undefined }

export const ModalClosingContext = createContext<ModalClosing>(NOT_CLOSING)

export function useModalClosing(): ModalClosing {
  return useContext(ModalClosingContext)
}

/**
 * Upper bound for an exit animation (ms) whose real duration is not known: the Library screen's exit, and
 * a modal whose --dur-modal cannot be read.
 */
export const MODAL_EXIT_FALLBACK_MS = 400

/** Slack on top of --dur-modal before the host gives up on a modal's animationend (ms): a few frames. */
export const MODAL_EXIT_SLACK_MS = 70

/**
 * How long ModalHost waits for a closing modal's animationend before it removes the modal (input is
 * frozen meanwhile): just over the real exit duration, so a lost animationend costs a few frames rather
 * than MODAL_EXIT_FALLBACK_MS. `durModal` is the computed --dur-modal ("180ms", "0.18s", "0ms"); 0
 * (animations off, reduced motion) means there is no exit animation to wait for. A value that cannot be
 * read keeps the upper bound.
 */
export function modalExitFallbackMs(durModal: string | null | undefined): number {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec((durModal ?? '').trim())
  if (!match) return MODAL_EXIT_FALLBACK_MS
  const duration = Number(match[1]) * (match[2] === 's' ? 1000 : 1)
  if (!Number.isFinite(duration)) return MODAL_EXIT_FALLBACK_MS
  if (duration <= 0) return 0
  return Math.min(MODAL_EXIT_FALLBACK_MS, Math.ceil(duration) + MODAL_EXIT_SLACK_MS)
}

/** modalExitFallbackMs for the document's current --dur-modal (tokens.css zeroes it with animations off). */
export function currentModalExitFallbackMs(): number {
  if (typeof document === 'undefined') return MODAL_EXIT_FALLBACK_MS
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--dur-modal')
    return modalExitFallbackMs(value)
  } catch {
    return MODAL_EXIT_FALLBACK_MS
  }
}
