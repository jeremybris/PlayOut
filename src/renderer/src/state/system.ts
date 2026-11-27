import type { PerfSample, SystemStatus } from '@shared/types'
import { create } from 'zustand'
import { api } from '../api/client'
import { createLog } from '../lib/log'

const log = createLog('system')

/**
 * System store: status bar data (battery, network, Bluetooth, volume, brightness, power mode), the running
 * game session and the latest performance sample. Fed by 'system:status', 'session:started' and
 * 'session:ended' events; battery changes also arrive instantly through navigator.getBattery().
 */
export interface RunningSession {
  gameId: string
  startedAt: string
}

export interface SystemState {
  status: SystemStatus | null
  running: RunningSession | null
  perf: PerfSample | null
  /** Fetch status and the running game. */
  refresh(): Promise<void>
  /** Fetch a CPU/RAM sample (quick panel polls this while open). */
  refreshPerf(): Promise<void>
  /** Merge a partial status locally (e.g. after setVolume) so the UI updates before the next poll. */
  patchStatus(patch: Partial<SystemStatus>): void
}

export const useSystemStore = create<SystemState>()((set, get) => ({
  status: null,
  running: null,
  perf: null,
  async refresh() {
    const [status, running] = await Promise.allSettled([
      api.getSystemStatus(),
      api.getRunningGame()
    ])
    if (status.status === 'fulfilled') set({ status: withBattery(status.value) })
    else log.error('getSystemStatus failed', status.reason)
    if (running.status === 'fulfilled') set({ running: running.value })
    else log.error('getRunningGame failed', running.reason)
  },
  async refreshPerf() {
    try {
      set({ perf: await api.getPerfSample() })
    } catch (err) {
      log.error('getPerfSample failed', err)
    }
  },
  patchStatus(patch) {
    const current = get().status
    if (!current) return
    set({ status: { ...current, ...patch } })
  }
}))

api.on('system:status', (status) => useSystemStore.setState({ status: withBattery(status) }))
api.on('session:started', ({ gameId, startedAt }) =>
  useSystemStore.setState({ running: { gameId, startedAt } })
)
api.on('session:ended', ({ gameId }) => {
  if (useSystemStore.getState().running?.gameId === gameId)
    useSystemStore.setState({ running: null })
})

// --- instant battery updates through the Battery Status API ------------------------------------------

let battery: BatteryManager | null = null

/** Overlay the live browser battery reading (when available) on a polled status. */
function withBattery(status: SystemStatus): SystemStatus {
  if (!battery || !status.battery?.present) return status
  return {
    ...status,
    battery: { present: true, percent: Math.round(battery.level * 100), charging: battery.charging }
  }
}

function onBatteryChange(): void {
  const current = useSystemStore.getState().status
  if (current && current.battery?.present) useSystemStore.setState({ status: withBattery(current) })
}

if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
  navigator
    .getBattery()
    .then((manager) => {
      battery = manager
      manager.addEventListener('levelchange', onBatteryChange)
      manager.addEventListener('chargingchange', onBatteryChange)
      onBatteryChange()
    })
    .catch((err) => log.warn('navigator.getBattery unavailable', err))
}
