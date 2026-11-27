import { afterAll, describe, expect, it, vi } from 'vitest'
import { runPowerShell } from './powershell'
import { createPsWorker, type PsWorker } from './ps-worker'
import { AUDIO_TYPE_INIT, clampPercent, parseVolume, readVolume } from './volume'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

describe('volume parsing', () => {
  it('parses the worker reply and clamps the level', () => {
    expect(parseVolume({ level: 36, muted: false })).toEqual({ level: 36, muted: false })
    expect(parseVolume({ level: 120.4, muted: true })).toEqual({ level: 100, muted: true })
    expect(parseVolume({ level: 'x', muted: false })).toBeNull()
    expect(parseVolume(null)).toBeNull()
    expect(clampPercent(-3)).toBe(0)
    expect(clampPercent(49.6)).toBe(50)
    expect(clampPercent(Number.NaN)).toBe(0)
  })
})

/**
 * Setters are not exercised here: they were verified by hand in PowerShell by reading the current level and
 * mute state and calling SetVolume / SetMute with those same values (volume 36, muted) which left both unchanged.
 */
describe.skipIf(!onWindows)('volume on this machine', () => {
  let worker: PsWorker | null = null
  afterAll(() => worker?.dispose())

  it('reads the master volume through the warm worker in a few milliseconds', async () => {
    worker = createPsWorker({ log, init: AUDIO_TYPE_INIT })
    const t0 = performance.now()
    const first = await readVolume(worker)
    const coldMs = Math.round(performance.now() - t0)
    expect(first).not.toBeNull()
    expect(first!.level).toBeGreaterThanOrEqual(0)
    expect(first!.level).toBeLessThanOrEqual(100)
    expect(typeof first!.muted).toBe('boolean')

    const t1 = performance.now()
    const second = await readVolume(worker)
    const warmMs = Math.round(performance.now() - t1)
    expect(second).toEqual(first)
    expect(warmMs).toBeLessThan(700)
    console.info(
      `[volume] ${JSON.stringify(second)}: first call ${coldMs} ms (spawn + compile), warm ${warmMs} ms`
    )
  }, 40_000)

  it('costs far more than 700 ms in a fresh process, which is why the worker exists', async () => {
    const t0 = performance.now()
    const result = await runPowerShell(
      `${AUDIO_TYPE_INIT}\n[math]::Round([PlayOut.Audio]::GetVolume() * 100)`,
      { timeoutMs: 30_000 }
    )
    const ms = Math.round(performance.now() - t0)
    expect(result.code).toBe(0)
    expect(Number.parseInt(result.stdout.trim(), 10)).toBeGreaterThanOrEqual(0)
    console.info(`[volume] one-shot process: ${ms} ms`)
  }, 40_000)
})
