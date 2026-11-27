import type { MemoryPassResult, MemoryStatus } from '@shared/memory'
import { describe, expect, it } from 'vitest'
import {
  agoText,
  memoryDescription,
  memoryResultLine,
  memoryTierHint,
  passText
} from './memoryText'

const NOW = Date.parse('2026-11-22T12:00:00.000Z')
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

const pass = (over: Partial<MemoryPassResult> = {}): MemoryPassResult => ({
  at: at(2 * 60_000),
  reason: 'manual',
  tier: 'system',
  beforeAvailableMb: 2140,
  afterAvailableMb: 3983,
  freedMb: 1843,
  trimmed: 96,
  skipped: 118,
  denied: 7,
  steps: { workingSets: { state: 'done' } },
  ...over
})

const status = (over: Partial<MemoryStatus> = {}): MemoryStatus => ({
  enabled: true,
  running: false,
  systemWide: 'ready',
  last: pass(),
  ...over
})

describe('Settings > System > Memory text', () => {
  it('says honestly what the switch does', () => {
    expect(memoryDescription()).toMatch(/Temporary/)
    expect(memoryDescription()).toMatch(/Windows refills its cache/)
    expect(memoryDescription()).toMatch(/slow for a moment/)
  })

  it('tells how long ago the last pass was', () => {
    expect(agoText(at(0), NOW)).toBe('just now')
    expect(agoText(at(59_000), NOW)).toBe('just now')
    expect(agoText(at(60_000), NOW)).toBe('1 minute ago')
    expect(agoText(at(2 * 60_000 + 30_000), NOW)).toBe('2 minutes ago')
    expect(agoText(at(60 * 60_000), NOW)).toBe('1 hour ago')
    expect(agoText(at(5 * 3_600_000), NOW)).toBe('5 hours ago')
    expect(agoText(at(49 * 3_600_000), NOW)).toBe('2 days ago')
    // A clock that went back never gives a negative time.
    expect(agoText(at(-5_000), NOW)).toBe('just now')
    expect(agoText('not a date', NOW)).toBe('')
  })

  it('shows the last result as "Freed 1.8 GB · 2 minutes ago"', () => {
    expect(memoryResultLine(status(), NOW)).toBe('Freed 1.8 GB · 2 minutes ago')
    expect(memoryResultLine(status({ last: pass({ freedMb: 640 }) }), NOW)).toBe(
      'Freed 640 MB · 2 minutes ago'
    )
    expect(passText(pass({ freedMb: 0 }))).toBe('Nothing could be freed this time')
    expect(
      memoryResultLine(
        status({ last: pass({ freedMb: 0, error: 'It did not finish in time.' }) }),
        NOW
      )
    ).toBe('It did not finish in time. · 2 minutes ago')
  })

  it('adds how long the cleanup took once it took a second, and only to what was freed', () => {
    expect(memoryResultLine(status({ last: pass({ durationMs: 4547 }) }), NOW)).toBe(
      'Freed 1.8 GB in 5 s · 2 minutes ago'
    )
    expect(passText(pass({ durationMs: 1000 }))).toBe('Freed 1.8 GB in 1 s')
    expect(passText(pass({ durationMs: 1499 }))).toBe('Freed 1.8 GB in 1 s')
    // Under a second is not worth a word (never rounded up to "in 1 s"); an unknown or broken time says nothing.
    expect(passText(pass({ durationMs: 412 }))).toBe('Freed 1.8 GB')
    expect(passText(pass({ durationMs: 500 }))).toBe('Freed 1.8 GB')
    expect(passText(pass({ durationMs: 999 }))).toBe('Freed 1.8 GB')
    expect(passText(pass({ durationMs: 0 }))).toBe('Freed 1.8 GB')
    expect(passText(pass({ durationMs: NaN }))).toBe('Freed 1.8 GB')
    expect(passText(pass({ freedMb: 0, durationMs: 4547 }))).toBe(
      'Nothing could be freed this time'
    )
    expect(passText(pass({ error: 'It did not finish in time.', durationMs: 4547 }))).toBe(
      'It did not finish in time.'
    )
  })

  it('shows a running pass and the state before the first one', () => {
    expect(memoryResultLine(null, NOW)).toBe('Checking…')
    expect(memoryResultLine(status({ running: true }), NOW)).toBe('Freeing memory…')
    expect(memoryResultLine(status({ last: null }), NOW)).toMatch(/never touched/)
  })

  it('says when the system-wide part needs the power helper', () => {
    expect(memoryTierHint('ready')).toBeNull()
    expect(memoryTierHint(undefined)).toBeNull()
    expect(memoryTierHint('missing')).toMatch(/install it from the Power helper row/)
    // The row's button reads Install (watts off) or Update (watts on) for an outdated helper: both are named.
    expect(memoryTierHint('outdated')).toMatch(/press Install or Update in the Power helper row/)
    // A helper that does not answer has only Remove in its row: the hint never says "install it" alone.
    expect(memoryTierHint('not-answering')).toMatch(
      /not answering: remove it and install it again from the Power helper row/
    )
    expect(memoryTierHint('unavailable')).toMatch(/not available on this PC/)
    // Before the PC has been looked at nothing is claimed.
    expect(memoryTierHint('unknown')).toBeNull()
    for (const tier of ['missing', 'outdated', 'not-answering', 'unavailable'] as const)
      expect(memoryTierHint(tier)).toMatch(/^Only your own apps are trimmed/)
  })
})
