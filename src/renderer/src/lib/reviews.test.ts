import { describe, expect, it } from 'vitest'
import { STAR_INNER, starClipTop, starFill, starVisibleFillBelow } from './bandIcon'
import {
  REVIEW_BANDS,
  isReviewBandId,
  reviewBandLabel,
  reviewBandOf,
  reviewScoreOf
} from './reviews'

describe('REVIEW_BANDS', () => {
  it('lists the nine bands best first', () => {
    expect(REVIEW_BANDS.map((b) => b.label)).toEqual([
      '95-100',
      '90-95',
      '85-90',
      '80-85',
      '75-80',
      '70-75',
      '60-70',
      '40-60',
      '0-40'
    ])
    expect(new Set(REVIEW_BANDS.map((b) => b.id)).size).toBe(9)
    expect(isReviewBandId('r95')).toBe(true)
    expect(isReviewBandId('95-100')).toBe(false)
    expect(isReviewBandId(95)).toBe(false)
    expect(reviewBandLabel('r60')).toBe('60-70')
    expect(reviewBandLabel('unknown')).toBe('unknown')
  })
})

describe('reviewBandOf', () => {
  const label = (score: number | undefined): string | undefined => {
    const id = reviewBandOf(score)
    return id === undefined ? undefined : reviewBandLabel(id)
  }

  it('puts a lower bound in its band and the top score in the top band', () => {
    expect(label(100)).toBe('95-100')
    expect(label(95)).toBe('95-100')
    expect(label(94.9)).toBe('90-95')
    expect(label(90)).toBe('90-95')
    expect(label(89.99)).toBe('85-90')
    expect(label(85)).toBe('85-90')
    expect(label(80)).toBe('80-85')
    expect(label(75)).toBe('75-80')
    expect(label(74.5)).toBe('70-75')
    expect(label(70)).toBe('70-75')
    expect(label(69.9)).toBe('60-70')
    expect(label(60)).toBe('60-70')
    expect(label(59.9)).toBe('40-60')
    expect(label(40)).toBe('40-60')
    expect(label(39.9)).toBe('0-40')
    expect(label(0)).toBe('0-40')
  })

  it('has no band for no score', () => {
    expect(reviewBandOf(undefined)).toBeUndefined()
    expect(reviewBandOf(Number.NaN)).toBeUndefined()
    expect(reviewBandOf(101)).toBeUndefined()
    expect(reviewBandOf(100.01)).toBeUndefined()
    expect(reviewBandOf(-1)).toBeUndefined()
    expect(reviewBandOf(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})

describe('reviewScoreOf', () => {
  it("is the game page's score: reviewScore.score, never the scrapers' rating", () => {
    expect(reviewScoreOf({ reviewScore: { source: 'steam', score: 93 } })).toBe(93)
    expect(reviewScoreOf({ reviewScore: { source: 'igdb', score: 71.4 } })).toBe(71.4)
    expect(reviewScoreOf({})).toBeUndefined()
    expect(reviewScoreOf({ rating: 88 } as never)).toBeUndefined()
    expect(reviewScoreOf({ reviewScore: { source: 'steam' } })).toBeUndefined()
    // The page shows '—' for these.
    expect(reviewScoreOf({ reviewScore: { score: 0 } })).toBeUndefined()
    expect(reviewScoreOf({ reviewScore: { score: Number.NaN } })).toBeUndefined()
  })
})

describe('starFill', () => {
  it('fills the best band completely and each lower band one ninth less, a sliver for the lowest', () => {
    const fills = REVIEW_BANDS.map((_, i) => starFill(REVIEW_BANDS.length - i, REVIEW_BANDS.length))
    expect(fills[0]).toBe(1)
    expect(fills[8]).toBeCloseTo(1 / 9)
    for (let i = 1; i < fills.length; i++) expect(fills[i - 1]! - fills[i]!).toBeCloseTo(1 / 9)
    expect(starFill(0, 9)).toBeCloseTo(1 / 9)
    expect(starFill(12, 9)).toBe(1)
  })
})

describe('starClipTop', () => {
  it('shows an equal step more of the inside the outline leaves showing for each better band', () => {
    const n = REVIEW_BANDS.length
    const tops = REVIEW_BANDS.map((_, i) => starClipTop(n - i, n))
    expect(tops[0]).toBe(0)
    const ys = STAR_INNER.map((p) => p[1])
    // The lowest band's fill reaches above the inner feet (the part the outline does not cover).
    expect(tops[8]!).toBeLessThan(Math.max(...ys) - 0.5)
    for (let i = 1; i < n; i++) {
      expect(tops[i]!).toBeGreaterThan(tops[i - 1]!)
      expect(starVisibleFillBelow(tops[i]!)).toBeCloseTo((n - i) / n, 3)
    }
    // The inner star sits inside the outer one, by about half the outline's width at the flat edges.
    expect(Math.min(...ys)).toBeGreaterThan(1.6)
    expect(Math.max(...ys)).toBeLessThan(20.61)
  })
})
