import { afterAll, describe, expect, it, vi } from 'vitest'
import { parseBrightness, readBrightness } from './brightness'
import { createPsWorker, type PsWorker } from './ps-worker'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

describe('brightness parsing', () => {
  it('returns the percentage or null when no panel supports it', () => {
    expect(parseBrightness({ brightness: 56 })).toBe(56)
    expect(parseBrightness({ brightness: 250 })).toBe(100)
    expect(parseBrightness({ brightness: null })).toBeNull()
    expect(parseBrightness(null)).toBeNull()
  })
})

/**
 * The setter is not exercised here: it was verified by hand with Invoke-CimMethod WmiSetBrightness using the
 * panel's current value as a standard user (no error, value unchanged, no admin prompt).
 */
describe.skipIf(!onWindows)('brightness on this machine', () => {
  let worker: PsWorker | null = null
  afterAll(() => worker?.dispose())

  it('reads a percentage or null', async () => {
    worker = createPsWorker({ log })
    const t0 = performance.now()
    const value = await readBrightness(worker)
    const ms = Math.round(performance.now() - t0)
    if (value !== null) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
    console.info(`[brightness] ${value} in ${ms} ms`)
  }, 30_000)
})
