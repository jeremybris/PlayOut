import { describe, expect, it } from 'vitest'
import { WheelExit } from './wheelExit'

const options = { step: 120, restMs: 300, gapMs: 400, graceMs: 300 }
const up = (now: number, deltaY = -100): { deltaY: number; now: number; atTop: boolean } => ({
  deltaY,
  now,
  atTop: true
})

describe('WheelExit', () => {
  it('returns Home after a deliberate upward gesture at a resting top', () => {
    const exit = new WheelExit(options, 0)
    expect(exit.wheel(up(1000))).toBe(false)
    expect(exit.wheel(up(1050))).toBe(true)
    // The accumulator starts over after a completed gesture.
    expect(exit.wheel(up(1100))).toBe(false)
  })

  it('ignores the momentum that opened the view', () => {
    const exit = new WheelExit(options, 1000)
    expect(exit.wheel(up(1100, -500))).toBe(false)
    expect(exit.wheel(up(1200, -500))).toBe(false)
    expect(exit.wheel(up(1350, -200))).toBe(true)
  })

  it('does not exit while the viewport is still settling at the top', () => {
    const exit = new WheelExit(options, 0)
    exit.scrolled(1000)
    expect(exit.wheel(up(1100, -500))).toBe(false)
    expect(exit.wheel(up(1200, -500))).toBe(false)
    // A deliberate gesture once the viewport has rested.
    expect(exit.wheel(up(1700, -100))).toBe(false)
    expect(exit.wheel(up(1750, -100))).toBe(true)
  })

  it('ignores the rest of the burst that scrolled the grid to its top', () => {
    const exit = new WheelExit(options, 0)
    expect(exit.wheel({ deltaY: -100, now: 1000, atTop: false })).toBe(false)
    exit.scrolled(1005)
    // The notch that reached the top and its tail: at the top now, but part of the same burst.
    for (let t = 1400; t < 2000; t += 50) expect(exit.wheel(up(t, -300))).toBe(false)
    // A new gesture after a pause exits.
    expect(exit.wheel(up(2500, -100))).toBe(false)
    expect(exit.wheel(up(2550, -100))).toBe(true)
  })

  it('resets the accumulator on downward deltas, pauses, scrolling and when something is on top', () => {
    const exit = new WheelExit(options, 0)
    expect(exit.wheel(up(1000))).toBe(false)
    expect(exit.wheel({ deltaY: 50, now: 1050, atTop: true })).toBe(false)
    expect(exit.wheel(up(1100))).toBe(false)
    // A pause longer than gapMs starts over.
    expect(exit.wheel(up(1600))).toBe(false)
    expect(exit.wheel(up(1650, -10))).toBe(false)
    expect(exit.wheel({ deltaY: -100, now: 1700, atTop: true, blocked: true })).toBe(false)
    expect(exit.wheel(up(1750))).toBe(false)
    expect(exit.wheel(up(1800))).toBe(true)
  })

  it('tells when a touch gesture may arm at the top', () => {
    const exit = new WheelExit(options, 0)
    expect(exit.restedAtTop(100, true)).toBe(false)
    expect(exit.restedAtTop(400, true)).toBe(true)
    expect(exit.restedAtTop(400, false)).toBe(false)
    exit.scrolled(500)
    expect(exit.restedAtTop(700, true)).toBe(false)
    expect(exit.restedAtTop(800, true)).toBe(true)
  })
})
