import type { PerfSample, PowerMode, SystemStatus } from '../../shared/types'
import { NO_BLUETOOTH, RADIO_INIT, readBluetooth } from './bluetooth'
import { readBrightness, setBrightness } from './brightness'
import { OFFLINE, readNetwork } from './network'
import { createPerfMonitor, type PerfMonitor } from './perf'
import { powerAction, readBattery, readPowerMode, setPowerMode, type PowerActionIo } from './power'
import { createPsWorker, type PsRunner, type PsWorker } from './ps-worker'
import type { SystemDeps, SystemService } from './types'
import { AUDIO_TYPE_INIT, readVolume, setMuted, setVolume } from './volume'
import { openWindowsSettings } from './windows-settings'

export interface SystemServiceOptions extends SystemDeps {
  /** Replace the PowerShell worker (tests). */
  ps?: PsRunner
  /** Replace the commands behind power actions (tests). */
  powerIo?: PowerActionIo
  /** Replace shell.openExternal (tests). */
  openExternal?: (uri: string) => Promise<void>
  /** How long a status() result stays fresh (default 5 s). */
  cacheMs?: number
  /** Interval of the slow probes (Bluetooth, brightness, power mode) while polling (default 60 s). */
  slowIntervalMs?: number
  /** status() never takes longer than this; late probes keep their previous value (default 9 s). */
  deadlineMs?: number
}

const DEFAULT_CACHE_MS = 5_000
const DEFAULT_SLOW_INTERVAL_MS = 60_000
const DEFAULT_DEADLINE_MS = 9_000
const DEFAULT_POLL_MS = 15_000

/** Everything the worker needs compiled or loaded once per PowerShell process. */
export const WORKER_INIT = `${AUDIO_TYPE_INIT}\n${RADIO_INIT}`

type FastFields = Pick<SystemStatus, 'battery' | 'network' | 'volume'>
type SlowFields = Pick<SystemStatus, 'bluetooth' | 'brightness' | 'powerMode'>

const INITIAL: SystemStatus = {
  battery: null,
  network: OFFLINE,
  bluetooth: NO_BLUETOOTH,
  volume: null,
  brightness: null,
  powerMode: null,
  updatedAt: new Date(0).toISOString()
}

/**
 * System bar data and controls. Every probe goes through one persistent PowerShell worker (ps-worker.ts): the
 * CoreAudio type and the WinRT radio helper are compiled once, so a full refresh costs ~100-400 ms warm instead
 * of ~1 s per probe with fresh processes. Probes are independent: one failing or timing out leaves the others
 * and the previous value of that field intact, and status() never rejects.
 */
export function createSystemService(options: SystemServiceOptions): SystemService {
  const { log } = options
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  const slowIntervalMs = options.slowIntervalMs ?? DEFAULT_SLOW_INTERVAL_MS
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS

  let worker: PsWorker | null = null
  let current: SystemStatus = INITIAL
  let lastFullAt = 0
  let lastSlowAt = 0
  let inFlight: Promise<SystemStatus> | null = null
  let timer: NodeJS.Timeout | null = null
  let listener: ((status: SystemStatus) => void) | null = null

  function ps(): PsRunner {
    if (options.ps) return options.ps
    if (!worker) worker = createPsWorker({ log, init: WORKER_INIT })
    return worker
  }

  const perfMonitor: PerfMonitor = createPerfMonitor({ ps, log })

  /** Run a probe, keeping the previous value (and logging) when it fails. */
  async function probe<K extends keyof SystemStatus>(
    name: K,
    run: () => Promise<SystemStatus[K]>
  ): Promise<SystemStatus[K]> {
    try {
      return await run()
    } catch (err) {
      log.warn(`${name} probe failed: ${(err as Error).message}`)
      return current[name]
    }
  }

  async function fastProbes(): Promise<FastFields> {
    const runner = ps()
    const [battery, network, volume] = await Promise.all([
      probe('battery', () => readBattery(runner)),
      probe('network', () => readNetwork(runner)),
      probe('volume', () => readVolume(runner))
    ])
    return { battery, network, volume }
  }

  async function slowProbes(): Promise<SlowFields> {
    const runner = ps()
    const [bluetooth, brightness, powerMode] = await Promise.all([
      probe('bluetooth', () => readBluetooth(runner)),
      probe('brightness', () => readBrightness(runner)),
      probe('powerMode', () => readPowerMode(runner))
    ])
    lastSlowAt = Date.now()
    return { bluetooth, brightness, powerMode }
  }

  function publish(patch: Partial<SystemStatus>): SystemStatus {
    current = { ...current, ...patch, updatedAt: new Date().toISOString() }
    if (listener) {
      try {
        listener(current)
      } catch (err) {
        log.error(`system status listener failed: ${(err as Error).message}`)
      }
    }
    return current
  }

  /**
   * Refresh the given probe groups. The worker runs scripts one after another, so a stuck probe would delay
   * everything behind it: a deadline publishes whatever has finished and lets the rest land on a later tick.
   */
  function refresh(includeSlow: boolean): Promise<SystemStatus> {
    if (inFlight) return inFlight
    const started = Date.now()
    const fast = fastProbes().then((fields) => publish(fields))
    const slow = includeSlow
      ? slowProbes().then((fields) => publish(fields))
      : Promise.resolve(current)
    const all = Promise.all([fast, slow]).then(() => {
      if (includeSlow) lastFullAt = Date.now()
      return current
    })
    let deadline: NodeJS.Timeout | null = null
    const bounded = new Promise<SystemStatus>((resolve) => {
      deadline = setTimeout(() => {
        log.warn(`system status refresh exceeded ${deadlineMs} ms; publishing partial results`)
        resolve(current)
      }, deadlineMs)
      deadline.unref()
      void all.then(resolve)
    })
    inFlight = bounded.finally(() => {
      if (deadline) clearTimeout(deadline)
      inFlight = null
      log.debug(`system status refreshed in ${Date.now() - started} ms`)
    })
    return inFlight
  }

  async function status(): Promise<SystemStatus> {
    if (Date.now() - lastFullAt < cacheMs) return current
    try {
      return await refresh(true)
    } catch (err) {
      log.error(`system status failed: ${(err as Error).message}`)
      return current
    }
  }

  function tick(): void {
    const includeSlow = Date.now() - lastSlowAt >= slowIntervalMs
    refresh(includeSlow).catch((err) =>
      log.error(`system status poll failed: ${(err as Error).message}`)
    )
  }

  return {
    status,

    start(onStatus, intervalMs = DEFAULT_POLL_MS) {
      if (timer) clearInterval(timer)
      listener = onStatus
      tick()
      timer = setInterval(tick, Math.max(1_000, intervalMs))
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
      listener = null
      if (worker) {
        worker.dispose()
        worker = null
      }
    },

    async setVolume(level) {
      await setVolume(ps(), level)
      const volume = await probe('volume', () => readVolume(ps()))
      publish({ volume })
    },

    async setMuted(muted) {
      await setMuted(ps(), muted)
      const volume = await probe('volume', () => readVolume(ps()))
      publish({ volume })
    },

    async setBrightness(percent) {
      await setBrightness(ps(), percent)
      const brightness = await probe('brightness', () => readBrightness(ps()))
      publish({ brightness })
    },

    async setPowerMode(mode: PowerMode) {
      await setPowerMode(mode, options.powerIo?.run)
      const powerMode = await probe('powerMode', () => readPowerMode(ps()))
      publish({ powerMode })
    },

    powerAction(action) {
      return powerAction(action, log, options.powerIo)
    },

    openWindowsSettings(page) {
      return openWindowsSettings(page, options.openExternal)
    },

    perf(): Promise<PerfSample> {
      return perfMonitor.sample()
    }
  }
}
