import { describe, expect, it } from 'vitest'
import { stepScreenshot } from './screenshots'

describe('stepScreenshot', () => {
  it('steps through the screenshots and wraps round at both ends', () => {
    expect(stepScreenshot(0, 1, 3)).toBe(1)
    expect(stepScreenshot(2, 1, 3)).toBe(0)
    expect(stepScreenshot(0, -1, 3)).toBe(2)
    expect(stepScreenshot(5, 0, 3)).toBe(2)
    expect(stepScreenshot(0, 1, 0)).toBe(0)
  })
})
