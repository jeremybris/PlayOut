import { describe, expect, it } from 'vitest'
import { MODAL_EXIT_FALLBACK_MS, MODAL_EXIT_SLACK_MS, modalExitFallbackMs } from './modalClosing'

describe('modalExitFallbackMs', () => {
  it('waits just over the real exit duration, not the generic bound', () => {
    expect(modalExitFallbackMs('180ms')).toBe(180 + MODAL_EXIT_SLACK_MS)
    expect(modalExitFallbackMs(' 180ms ')).toBe(180 + MODAL_EXIT_SLACK_MS)
    expect(modalExitFallbackMs('0.18s')).toBe(180 + MODAL_EXIT_SLACK_MS)
    expect(modalExitFallbackMs('.18s')).toBe(180 + MODAL_EXIT_SLACK_MS)
    expect(modalExitFallbackMs('180ms')).toBeLessThan(MODAL_EXIT_FALLBACK_MS)
  })

  it('never cuts an exit animation short', () => {
    expect(modalExitFallbackMs('180ms')).toBeGreaterThan(180)
    expect(modalExitFallbackMs('250.4ms')).toBeGreaterThan(250.4)
  })

  it('does not wait when there is no exit animation (animations off, reduced motion)', () => {
    expect(modalExitFallbackMs('0ms')).toBe(0)
    expect(modalExitFallbackMs('0s')).toBe(0)
  })

  it('keeps the generic bound for a duration it cannot read, and never exceeds it', () => {
    expect(modalExitFallbackMs('')).toBe(MODAL_EXIT_FALLBACK_MS)
    expect(modalExitFallbackMs(undefined)).toBe(MODAL_EXIT_FALLBACK_MS)
    expect(modalExitFallbackMs(null)).toBe(MODAL_EXIT_FALLBACK_MS)
    expect(modalExitFallbackMs('var(--x)')).toBe(MODAL_EXIT_FALLBACK_MS)
    expect(modalExitFallbackMs('2s')).toBe(MODAL_EXIT_FALLBACK_MS)
  })
})
