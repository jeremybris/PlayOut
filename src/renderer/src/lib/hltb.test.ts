import { describe, expect, it } from 'vitest'
import type { Game } from '@shared/types'
import { ALL_HLTB, HLTB_BUCKETS, hltbBucketOf, hltbHours, hltbUsesSolo } from './hltb'

const withHltb = (hltb: Game['metadata']['hltb']): Pick<Game, 'metadata'> =>
  ({ metadata: { hltb } }) as Pick<Game, 'metadata'>

describe('hltbHours', () => {
  it('goes by Main Story for a usual game', () => {
    const game = withHltb({ main: 12, extra: 20, completionist: 40, combined: false })
    expect(hltbHours(game)).toBe(12)
    expect(hltbUsesSolo(game)).toBe(false)
  })

  it('goes by Main Story for a compilation too, as the HLTB page now does (Kingdom Hearts HD 1.5 + 2.5 ReMIX)', () => {
    const game = withHltb({
      main: 112.8,
      extra: 155.7,
      completionist: 303.6,
      solo: 158.3,
      combined: true
    })
    expect(hltbHours(game)).toBe(112.8)
    expect(hltbUsesSolo(game)).toBe(false)
  })

  it('falls back to Solo for a game without a Main Story time', () => {
    const game = withHltb({ solo: 4, combined: false })
    expect(hltbHours(game)).toBe(4)
    expect(hltbUsesSolo(game)).toBe(true)
  })

  it('uses Main Story when a combined game has no Solo time, and nothing without times', () => {
    expect(hltbHours(withHltb({ main: 9, combined: true }))).toBe(9)
    expect(hltbHours(withHltb({ extra: 9 }))).toBeUndefined()
    expect(hltbHours(withHltb(undefined))).toBeUndefined()
  })
})

describe('hltbBucketOf', () => {
  it('puts times in the bands of the filter, the upper bound exclusive', () => {
    expect(HLTB_BUCKETS.map((b) => b.label)).toEqual([
      '0-3 Hours',
      '3-10 Hours',
      '10-20 Hours',
      '20-50 Hours',
      '50-100 Hours',
      '100+ Hours'
    ])
    const label = (hours: number | undefined): string | undefined =>
      HLTB_BUCKETS.find((b) => b.id === hltbBucketOf(hours))?.label
    expect(label(0.5)).toBe('0-3 Hours')
    expect(label(3)).toBe('3-10 Hours')
    expect(label(9.9)).toBe('3-10 Hours')
    expect(label(20)).toBe('20-50 Hours')
    expect(label(67.2)).toBe('50-100 Hours')
    expect(label(100)).toBe('100+ Hours')
    expect(label(1500)).toBe('100+ Hours')
    expect(hltbBucketOf(undefined)).toBeUndefined()
    expect(hltbBucketOf(0)).toBeUndefined()
    expect(HLTB_BUCKETS.some((b) => b.id === ALL_HLTB)).toBe(false)
  })
})
