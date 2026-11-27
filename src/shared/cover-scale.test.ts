import { describe, expect, it } from 'vitest'
import {
  COVER_SCALE_STEPS,
  coverScaleIndex,
  maxColumnsFor,
  nearestCoverScale,
  stepCoverScale
} from './cover-scale'

describe('cover scale steps', () => {
  it('runs from about 60% to 160% with today’s size as a step', () => {
    expect(COVER_SCALE_STEPS[0]).toBe(0.6)
    expect(COVER_SCALE_STEPS[COVER_SCALE_STEPS.length - 1]).toBe(1.6)
    expect(COVER_SCALE_STEPS).toContain(1)
    for (let i = 1; i < COVER_SCALE_STEPS.length; i++) {
      expect(COVER_SCALE_STEPS[i]!).toBeGreaterThan(COVER_SCALE_STEPS[i - 1]!)
    }
  })

  it('finds the nearest step and clamps to the ends', () => {
    expect(nearestCoverScale(1)).toBe(1)
    expect(nearestCoverScale(0.94)).toBe(0.9)
    expect(nearestCoverScale(1.1)).toBe(1.15)
    expect(nearestCoverScale(0.1)).toBe(0.6)
    expect(nearestCoverScale(9)).toBe(1.6)
    expect(nearestCoverScale(Number.NaN)).toBe(1)
    expect(nearestCoverScale(undefined)).toBe(1)
    expect(coverScaleIndex(1)).toBe(4)
  })

  it('steps one bigger or smaller and stays at the ends', () => {
    expect(stepCoverScale(1, 1)).toBe(1.15)
    expect(stepCoverScale(1, -1)).toBe(0.9)
    expect(stepCoverScale(0.6, -1)).toBe(0.6)
    expect(stepCoverScale(1.6, 1)).toBe(1.6)
    expect(stepCoverScale(0.97, 1)).toBe(1.15)
  })

  it('allows more columns for smaller covers, six at today’s size', () => {
    expect(maxColumnsFor(1)).toBe(6)
    expect(maxColumnsFor(0.6)).toBe(10)
    expect(maxColumnsFor(1.6)).toBe(4)
  })
})
