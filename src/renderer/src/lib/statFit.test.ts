import { describe, expect, it } from 'vitest'
import { dropUpTo, fitPlan, type FitItem } from './statFit'

// The game page's stats: play time, achievements, then divider + Main story, review score, Main + extras and
// Completionist, dropped from the right.
const row: FitItem[] = [
  { width: 150 },
  { width: 120 },
  { width: 1, drop: 4 },
  { width: 100, drop: 4 },
  { width: 80, drop: 3 },
  { width: 110, drop: 2 },
  { width: 120, drop: 1 }
]
const gap = 30
// Everything: 681 px of stats and 6 gaps of 30.
const full = 681 + 6 * 30

describe('dropUpTo', () => {
  it('keeps every stat that fits', () => {
    expect(dropUpTo(row, gap, full)).toBe(0)
    expect(dropUpTo(row, gap, 2000)).toBe(0)
  })

  it('drops from the right, one rank at a time, only as far as needed', () => {
    expect(dropUpTo(row, gap, full - 1)).toBe(1)
    expect(dropUpTo(row, gap, full - 150)).toBe(1)
    expect(dropUpTo(row, gap, full - 151)).toBe(2)
    // Main story and its divider go together, last.
    expect(dropUpTo(row, gap, 150 + 120 + 30 + 1 + 100 + 60)).toBe(3)
    expect(dropUpTo(row, gap, 150 + 120 + 30)).toBe(4)
  })

  it('drops every rank when even the kept stats do not fit', () => {
    expect(dropUpTo(row, gap, 50)).toBe(4)
  })

  it('tolerates sub-pixel rounding', () => {
    expect(dropUpTo(row, gap, full - 0.4)).toBe(0)
  })

  it('handles a row with nothing to drop', () => {
    expect(dropUpTo([{ width: 100 }], 10, 50)).toBe(0)
    expect(dropUpTo([], 10, 50)).toBe(0)
  })
})

describe('fitPlan', () => {
  // The game page's stats on a 16:10 screen with a Co-Op half on Play: achievements, divider, play time, review score
  // (rank 2), Players (rank 1). Compact: shorter play time and review score, half the gap.
  const normal = {
    items: [
      { width: 111 },
      { width: 1 },
      { width: 157 },
      { width: 88, drop: 2 },
      { width: 112, drop: 1 }
    ],
    gap: 25.4
  }
  const compact = {
    items: [
      { width: 111 },
      { width: 1 },
      { width: 111 },
      { width: 55, drop: 2 },
      { width: 112, drop: 1 }
    ],
    gap: 12.7
  }

  it('keeps everything as it is when it fits, and leaves Players out before going compact', () => {
    expect(fitPlan(normal, compact, 2000)).toEqual({ upTo: 0, compact: false })
    expect(fitPlan(normal, compact, 440)).toEqual({ upTo: 1, compact: false })
  })

  it('goes compact rather than leaving the review score out', () => {
    expect(fitPlan(normal, compact, 325)).toEqual({ upTo: 1, compact: true })
  })

  it('leaves the review score out only when even compact does not fit', () => {
    expect(fitPlan(normal, compact, 260)).toEqual({ upTo: 2, compact: true })
    expect(fitPlan(normal, compact, 10)).toEqual({ upTo: 2, compact: true })
    expect(fitPlan(normal, null, 325)).toEqual({ upTo: 2, compact: false })
  })

  it('never brings a stat back once it was left out (a narrow Players stat)', () => {
    const narrow = (m: typeof normal): typeof normal => ({
      ...m,
      items: m.items.map((i) => (i.drop === 1 ? { ...i, width: 40 } : i))
    })
    // Normal without Players: 433.2; compact with it: 368.8. Between the two, Players stays out.
    expect(fitPlan(narrow(normal), narrow(compact), 400)).toEqual({ upTo: 1, compact: true })
  })
})
