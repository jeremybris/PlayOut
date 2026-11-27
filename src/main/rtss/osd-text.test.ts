import { describe, expect, it } from 'vitest'
import { osdText, type OsdStats } from './osd-text'

const full: OsdStats = {
  fps: 119.6,
  frameTimeMs: 8.34,
  cpuPercent: 35.2,
  gpuPercent: 80,
  watts: 15.4,
  ramPercent: 61.5,
  batteryPercent: 80
}
const none: OsdStats = {
  fps: null,
  frameTimeMs: null,
  cpuPercent: null,
  gpuPercent: null,
  watts: null,
  ramPercent: null,
  batteryPercent: null
}
const at = new Date(2026, 10, 14, 21, 4)

describe('osdText', () => {
  it('level 1 is the frame rate', () => {
    expect(osdText(1, full, at, true)).toBe('120 FPS')
  })

  it('level 2 adds frame time, CPU, GPU and watts', () => {
    expect(osdText(2, full, at, true)).toBe('120 FPS\n8.3 ms  CPU 35%  GPU 80%  15 W')
  })

  it('level 3 adds RAM, battery and the time (24 h or 12 h)', () => {
    expect(osdText(3, full, at, true)).toBe(
      '120 FPS\n8.3 ms  CPU 35%  GPU 80%  15 W\nRAM 62%  BAT 80%  21:04'
    )
    expect(osdText(3, full, at, false).split('\n')[2]).toBe('RAM 62%  BAT 80%  9:04 PM')
    expect(osdText(3, full, new Date(2026, 0, 1, 0, 5), false).split('\n')[2]).toContain('12:05 AM')
  })

  it('shows a dash for missing values and never a temperature', () => {
    const text = osdText(3, none, at, true)
    expect(text).toBe('— FPS\n— ms  CPU —  GPU —  — W\nRAM —  BAT —  21:04')
    expect(text).not.toMatch(/°|temp/i)
  })
})
