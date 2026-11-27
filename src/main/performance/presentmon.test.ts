import { describe, expect, it } from 'vitest'
import { FPS_MIN_FRAMES, FpsMeter } from './presentmon'

const HEADER = 'Application,ProcessID,SwapChainAddress,MsBetweenPresents'
const row = (pid: number, ms: number): string => `app.exe,${pid},0x1,${ms}`

function meter(pids: number[], frames: [pid: number, ms: number, count: number][]): FpsMeter {
  const m = new FpsMeter(new Set(pids))
  m.push(HEADER, 0)
  for (const [pid, ms, count] of frames)
    for (let i = 0; i < count; i++) m.push(row(pid, ms), 100 + i)
  return m
}

describe('FpsMeter', () => {
  it('picks the pid with the most frames, not the highest rate', () => {
    // The game: 30 frames at 60 fps; an overlay: 10 frames at 500 fps.
    const r = meter(
      [1, 2],
      [
        [1, 16.667, 30],
        [2, 2, 10]
      ]
    ).read(500)
    expect(r?.pid).toBe(1)
    expect(r?.frames).toBe(30)
    expect(r?.fps).toBeCloseTo(60, 0)
  })

  it('breaks a tie in frames by the higher rate', () => {
    const r = meter(
      [1, 2],
      [
        [1, 33.333, 8],
        [2, 16.667, 8]
      ]
    ).read(500)
    expect(r?.pid).toBe(2)
  })

  it('needs at least FPS_MIN_FRAMES frames in the window', () => {
    expect(FPS_MIN_FRAMES).toBe(5)
    expect(meter([1], [[1, 16.667, FPS_MIN_FRAMES - 1]]).read(500)).toBeNull()
    expect(meter([1], [[1, 16.667, FPS_MIN_FRAMES]]).read(500)?.pid).toBe(1)
  })
})
