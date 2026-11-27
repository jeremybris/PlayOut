import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  cpuPercentBetween,
  createPerfMonitor,
  parseGpu,
  sampleCpuTimes,
  sampleMemory
} from './perf'
import { createPsWorker, type PsRunner, type PsWorker } from './ps-worker'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

describe('perf arithmetic', () => {
  it('computes busy percent from two cpu snapshots', () => {
    expect(cpuPercentBetween({ idle: 100, total: 1000 }, { idle: 200, total: 1400 })).toBe(75)
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 0, total: 0 })).toBeNull()
    expect(cpuPercentBetween({ idle: 0, total: 0 }, { idle: 500, total: 400 })).toBe(0)
    const s = sampleCpuTimes()
    expect(s.total).toBeGreaterThan(0)
    expect(s.idle).toBeGreaterThan(0)
  })

  it('parses the gpu reply', () => {
    expect(parseGpu({ gpu: 5 })).toBe(5)
    expect(parseGpu({ gpu: 12.345 })).toBe(12.3)
    expect(parseGpu({ gpu: null })).toBeNull()
    expect(parseGpu(null)).toBeNull()
  })

  it('reads total, available and used memory in MB without starting a process', () => {
    const m = sampleMemory()
    expect(m.totalMb).toBeGreaterThan(0)
    expect(m.availableMb).toBeGreaterThan(0)
    expect(m.availableMb).toBeLessThanOrEqual(m.totalMb)
    // Each figure is rounded on its own, so used + available may be 1 MB off the total.
    expect(Math.abs(m.usedMb + m.availableMb - m.totalMb)).toBeLessThanOrEqual(1)
  })
})

describe('perf monitor', () => {
  it('samples cpu and memory without PowerShell and refreshes the gpu in the background', async () => {
    let gpuCalls = 0
    const ps: PsRunner = {
      async run<T>() {
        gpuCalls++
        await new Promise((r) => setTimeout(r, 20))
        return { gpu: 42 } as T
      }
    }
    const monitor = createPerfMonitor({ ps: () => ps, log, cpuWindowMs: 50, gpuMaxAgeMs: 10_000 })
    const first = await monitor.sample()
    expect(first.cpuPercent).not.toBeNull()
    expect(first.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(first.memoryTotalMb).toBeGreaterThan(0)
    expect(first.memoryUsedMb).toBeGreaterThan(0)
    expect(first.memoryUsedMb).toBeLessThanOrEqual(first.memoryTotalMb!)
    await new Promise((r) => setTimeout(r, 60))
    const second = await monitor.sample()
    expect(second.gpuPercent).toBe(42)
    expect(gpuCalls).toBe(1)
  })

  it('keeps sampling when the gpu probe fails', async () => {
    const ps: PsRunner = {
      async run() {
        throw new Error('no counters')
      }
    }
    const monitor = createPerfMonitor({ ps: () => ps, log, cpuWindowMs: 50 })
    const sample = await monitor.sample()
    expect(sample.memoryTotalMb).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 20))
    expect((await monitor.sample()).gpuPercent).toBeNull()
  })
})

describe.skipIf(!onWindows)('gpu counters on this machine', () => {
  let worker: PsWorker | null = null
  afterAll(() => worker?.dispose())

  it('reports a gpu percentage or null', async () => {
    worker = createPsWorker({ log })
    const monitor = createPerfMonitor({ ps: () => worker!, log, gpuTimeoutMs: 15_000 })
    const t0 = performance.now()
    await monitor.sample()
    // Wait for the background GPU probe (2-3 s on the first WMI call) without hanging if it never answers.
    let sample = await monitor.sample()
    const deadline = Date.now() + 15_000
    while (sample.gpuPercent === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      sample = await monitor.sample()
    }
    const ms = Math.round(performance.now() - t0)
    if (sample.gpuPercent !== null) {
      expect(sample.gpuPercent).toBeGreaterThanOrEqual(0)
      expect(sample.gpuPercent).toBeLessThanOrEqual(100)
    }
    console.info(`[perf] ${JSON.stringify(sample)} after ${ms} ms`)
  }, 40_000)
})
