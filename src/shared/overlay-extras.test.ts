import { describe, expect, it } from 'vitest'
import { frameLimitOptions } from './overlay-extras'

describe('frameLimitOptions', () => {
  it('lists unlimited first, then the presets', () => {
    expect(frameLimitOptions()).toEqual([0, 30, 40, 45, 60, 72, 90, 120])
  })

  it('adds the display rate when it is not a preset, in order', () => {
    expect(frameLimitOptions(143.9)).toEqual([0, 30, 40, 45, 60, 72, 90, 120, 144])
    expect(frameLimitOptions(100)).toEqual([0, 30, 40, 45, 60, 72, 90, 100, 120])
  })

  it('does not repeat a preset rate and ignores nonsense', () => {
    expect(frameLimitOptions(60)).toEqual([0, 30, 40, 45, 60, 72, 90, 120])
    expect(frameLimitOptions(Number.NaN)).toHaveLength(8)
    expect(frameLimitOptions(1)).toHaveLength(8)
  })
})
