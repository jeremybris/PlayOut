import { describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD_PX,
  PAGE_FRACTION,
  STICK_X_SPEED,
  WHEEL_LINE_PX,
  isDrag,
  overflows,
  pageTarget,
  scrollLeftForThumb,
  stickStepX,
  thumbGeometry,
  wheelDeltaX,
  carryStep,
  revealLeft
} from './hScroll'

describe('overflows', () => {
  it('is true only when the content is wider than its box (beyond a pixel of rounding)', () => {
    expect(overflows(1000, 1000)).toBe(false)
    expect(overflows(1000.8, 1000)).toBe(false)
    expect(overflows(1002, 1000)).toBe(true)
    expect(overflows(800, 1000)).toBe(false)
  })
})

describe('thumbGeometry', () => {
  const metrics = { scrollWidth: 2000, clientWidth: 500, scrollLeft: 0 }

  it('is as wide as the visible share of the content: shorter the further there is to scroll', () => {
    expect(thumbGeometry(metrics, 400, 20).width).toBe(100)
    expect(thumbGeometry({ ...metrics, scrollWidth: 1000 }, 400, 20).width).toBe(200)
    expect(thumbGeometry({ ...metrics, scrollWidth: 4000 }, 400, 20).width).toBe(50)
  })

  it('never goes under the minimum nor over the track', () => {
    expect(thumbGeometry({ ...metrics, scrollWidth: 100000 }, 400, 30).width).toBe(30)
    expect(thumbGeometry({ ...metrics, scrollWidth: 400 }, 400, 30).width).toBe(400)
    expect(thumbGeometry(metrics, 20, 30).width).toBe(20)
  })

  it('sits at the scrolled fraction: the start, the middle and the end of the track', () => {
    expect(thumbGeometry(metrics, 400, 20).left).toBe(0)
    expect(thumbGeometry({ ...metrics, scrollLeft: 750 }, 400, 20).left).toBe(150)
    expect(thumbGeometry({ ...metrics, scrollLeft: 1500 }, 400, 20).left).toBe(300)
    // Overscrolled (rounding) stays on the track.
    expect(thumbGeometry({ ...metrics, scrollLeft: 1600 }, 400, 20).left).toBe(300)
    expect(thumbGeometry({ ...metrics, scrollLeft: -5 }, 400, 20).left).toBe(0)
  })

  it('fills the track at 0 when nothing scrolls', () => {
    expect(thumbGeometry({ scrollWidth: 500, clientWidth: 500, scrollLeft: 0 }, 400, 20)).toEqual({
      width: 400,
      left: 0
    })
  })
})

describe('scrollLeftForThumb', () => {
  const metrics = { scrollWidth: 2000, clientWidth: 500 }
  it('maps the pill position back to the scroll position, clamped to the ends', () => {
    expect(scrollLeftForThumb(0, metrics, 400, 100)).toBe(0)
    expect(scrollLeftForThumb(150, metrics, 400, 100)).toBe(750)
    expect(scrollLeftForThumb(300, metrics, 400, 100)).toBe(1500)
    expect(scrollLeftForThumb(900, metrics, 400, 100)).toBe(1500)
    expect(scrollLeftForThumb(-40, metrics, 400, 100)).toBe(0)
  })
  it('round-trips with thumbGeometry', () => {
    const at = thumbGeometry({ ...metrics, scrollLeft: 420 }, 400, 20)
    expect(scrollLeftForThumb(at.left, metrics, 400, at.width)).toBeCloseTo(420)
  })
  it('is 0 when the pill fills the track', () => {
    expect(scrollLeftForThumb(10, metrics, 400, 400)).toBe(0)
  })
})

describe('pageTarget', () => {
  const metrics = { scrollWidth: 2000, clientWidth: 500, scrollLeft: 600 }
  const thumb = thumbGeometry(metrics, 400, 20)
  it('pages toward a press beside the pill, and not at all on it', () => {
    expect(pageTarget(0, thumb, metrics)).toBe(600 - 500 * PAGE_FRACTION)
    expect(pageTarget(399, thumb, metrics)).toBe(600 + 500 * PAGE_FRACTION)
    expect(pageTarget(thumb.left + thumb.width / 2, thumb, metrics)).toBe(600)
  })
  it('stops at the ends', () => {
    expect(pageTarget(0, thumb, { ...metrics, scrollLeft: 100 })).toBe(0)
    expect(pageTarget(399, thumb, { ...metrics, scrollLeft: 1400 })).toBe(1500)
  })
})

describe('isDrag', () => {
  it('is a click until the pointer moves past the threshold, mostly sideways', () => {
    expect(isDrag(0, 0)).toBe(false)
    expect(isDrag(DRAG_THRESHOLD_PX - 1, 0)).toBe(false)
    expect(isDrag(DRAG_THRESHOLD_PX, 0)).toBe(true)
    expect(isDrag(-DRAG_THRESHOLD_PX - 4, 2)).toBe(true)
    // Mostly up / down: a vertical swipe (the Library's swipe Home), not a drag of the tabs.
    expect(isDrag(10, 30)).toBe(false)
  })
})

describe('wheelDeltaX', () => {
  it('takes the larger axis, so a vertical wheel scrolls sideways too', () => {
    expect(wheelDeltaX({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 500)).toBe(100)
    expect(wheelDeltaX({ deltaX: -60, deltaY: 10, deltaMode: 0 }, 500)).toBe(-60)
  })
  it('turns lines and pages into pixels', () => {
    expect(wheelDeltaX({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toBe(3 * WHEEL_LINE_PX)
    expect(wheelDeltaX({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 500)).toBe(-500)
  })
})

describe('stickStepX', () => {
  it('scrolls gently near the centre and quickly at the edge, both ways', () => {
    expect(stickStepX(1, 16)).toBeCloseTo(STICK_X_SPEED * 0.016)
    expect(stickStepX(-1, 16)).toBeCloseTo(-STICK_X_SPEED * 0.016)
    expect(stickStepX(0.5, 16)).toBeCloseTo(STICK_X_SPEED * 0.016 * 0.25)
    expect(stickStepX(0, 16)).toBe(0)
  })
  it('caps a long frame gap (a stalled frame does not jump)', () => {
    expect(stickStepX(1, 1000)).toBeCloseTo(STICK_X_SPEED * 0.05)
  })
})

describe('revealLeft', () => {
  const metrics = { scrollWidth: 2000, clientWidth: 500, scrollLeft: 600 }
  it('leaves an item already clear of the fades where it is', () => {
    expect(revealLeft(700, 200, metrics, 24)).toBe(600)
  })
  it('brings an item past either edge in, a fade away from that edge', () => {
    expect(revealLeft(1000, 200, metrics, 24)).toBe(1000 + 200 + 24 - 500)
    expect(revealLeft(610, 200, metrics, 24)).toBe(586)
  })
  it('stops at the ends and lines up an item wider than the room with the start fade', () => {
    expect(revealLeft(10, 100, metrics, 24)).toBe(0)
    expect(revealLeft(1900, 100, metrics, 24)).toBe(1500)
    expect(revealLeft(900, 480, metrics, 24)).toBe(876)
  })
})

describe('carryStep', () => {
  it('adds sub-pixel steps up into whole pixels', () => {
    let carry = 0
    let moved = 0
    for (let i = 0; i < 10; i++) {
      const step = carryStep(carry, 0.25)
      carry = step.carry
      moved += step.px
    }
    expect(moved).toBe(2)
    expect(carry).toBeCloseTo(0.5)
  })
  it('drops the remainder when the direction changes', () => {
    expect(carryStep(0.9, -0.3)).toEqual({ px: 0, carry: -0.3 })
    expect(carryStep(0.5, 1.75)).toEqual({ px: 2, carry: 0.25 })
  })
})
