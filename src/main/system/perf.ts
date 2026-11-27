import { cpus, freemem, totalmem } from 'os'
import type { PerfSample } from '../../shared/types'
import type { Logger } from '../logger'
import type { PsRunner } from './ps-worker'

/**
 * CPU % and memory come from Node for free (docs/research/electron-stack.md section 6.8: os.cpus() idle/total
 * delta, os.totalmem()/os.freemem(), the latter being GlobalMemoryStatusEx's available physical memory, the same
 * figure as Win32_OperatingSystem.FreePhysicalMemory). GPU % is the sum of the 3D engine counters, ~300 ms warm
 * but 2-3 s on the first WMI call, so it is refreshed in the background and the last value is reported.
 */
const GPU_SCRIPT = `
$rows = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*engtype_3D' } | Select-Object UtilizationPercentage)
if ($rows.Count -eq 0) { @{ gpu = $null } } else { @{ gpu = [double](($rows | Measure-Object UtilizationPercentage -Sum).Sum) } }
`

export interface CpuTimes {
  idle: number
  total: number
}

export function sampleCpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** Busy percentage between two samples; null when no time elapsed. */
export function cpuPercentBetween(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total
  if (total <= 0) return null
  const idle = current.idle - previous.idle
  return Math.round(Math.min(100, Math.max(0, (1 - idle / total) * 100)) * 10) / 10
}

export function parseGpu(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as { gpu?: unknown }).gpu
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

/** Physical memory, MB. */
export interface MemorySample {
  totalMb: number
  /** What Windows calls "available": free memory plus the cache it gives up at once. */
  availableMb: number
  usedMb: number
}

/** os.totalmem() / os.freemem(): no process is started, so it can be read as often as needed. */
export function sampleMemory(): MemorySample {
  const totalBytes = totalmem()
  const freeBytes = freemem()
  return {
    totalMb: Math.round(totalBytes / 1_048_576),
    availableMb: Math.round(freeBytes / 1_048_576),
    usedMb: Math.round((totalBytes - freeBytes) / 1_048_576)
  }
}

export interface PerfMonitor {
  sample(): Promise<PerfSample>
}

export interface PerfMonitorOptions {
  ps: () => PsRunner
  log: Logger
  /** Reuse a GPU reading younger than this (default 2 s). */
  gpuMaxAgeMs?: number
  /** Minimum gap between the two CPU snapshots when no earlier one exists (default 250 ms). */
  cpuWindowMs?: number
  gpuTimeoutMs?: number
}

const MIN_CPU_WINDOW_MS = 100

export function createPerfMonitor(options: PerfMonitorOptions): PerfMonitor {
  const { log } = options
  const gpuMaxAgeMs = options.gpuMaxAgeMs ?? 2_000
  const cpuWindowMs = options.cpuWindowMs ?? 250
  const gpuTimeoutMs = options.gpuTimeoutMs ?? 8_000
  let lastCpu: { at: number; times: CpuTimes } | null = null
  let gpu: { at: number; value: number | null } | null = null
  let gpuInFlight: Promise<void> | null = null
  let gpuUnsupported = false

  function refreshGpu(): Promise<void> {
    if (gpuInFlight) return gpuInFlight
    gpuInFlight = options
      .ps()
      .run(GPU_SCRIPT, { timeoutMs: gpuTimeoutMs })
      .then((raw) => {
        const value = parseGpu(raw)
        if (value === null && !gpuUnsupported) {
          gpuUnsupported = true
          log.info('GPU engine counters are not available; GPU usage will not be shown')
        }
        gpu = { at: Date.now(), value }
      })
      .catch((err) => {
        log.warn(`GPU usage probe failed: ${(err as Error).message}`)
        gpu = { at: Date.now(), value: null }
      })
      .finally(() => {
        gpuInFlight = null
      })
    return gpuInFlight
  }

  async function cpuPercent(): Promise<number | null> {
    const now = Date.now()
    let previous = lastCpu
    if (!previous || now - previous.at < MIN_CPU_WINDOW_MS) {
      // Nothing recent to diff against: take two snapshots a short window apart.
      previous = { at: now, times: sampleCpuTimes() }
      await new Promise((r) => setTimeout(r, cpuWindowMs))
    }
    const current = { at: Date.now(), times: sampleCpuTimes() }
    lastCpu = current
    return cpuPercentBetween(previous.times, current.times)
  }

  return {
    async sample() {
      const now = Date.now()
      const gpuStale = !gpu || now - gpu.at > gpuMaxAgeMs
      // The GPU probe refreshes behind the cached value and never delays a sample: the first sample of a
      // session reports gpuPercent null and the panel's next poll (a second later) shows the number.
      if (gpuStale && !gpuUnsupported) void refreshGpu()
      const cpu = await cpuPercent()
      const memory = sampleMemory()
      return {
        cpuPercent: cpu,
        memoryUsedMb: memory.usedMb,
        memoryTotalMb: memory.totalMb,
        gpuPercent: gpu?.value ?? null,
        updatedAt: new Date().toISOString()
      }
    }
  }
}
