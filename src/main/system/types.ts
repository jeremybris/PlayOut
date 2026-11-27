import type {
  PerfSample,
  PowerAction,
  PowerMode,
  SystemStatus,
  WindowsSettingsPage
} from '../../shared/types'
import type { Logger } from '../logger'

export interface SystemService {
  /** Current status (battery, network, Bluetooth, volume, brightness, power mode). Cached for a few seconds. */
  status(): Promise<SystemStatus>
  /** Start periodic polling; `onStatus` receives every refreshed status. */
  start(onStatus: (status: SystemStatus) => void, intervalMs?: number): void
  stop(): void
  setVolume(level: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
  setBrightness(percent: number): Promise<void>
  setPowerMode(mode: PowerMode): Promise<void>
  /** Sleep, hibernate, restart or shut down the machine ('exit' and 'minimize' are handled by the app). */
  powerAction(action: Exclude<PowerAction, 'exit' | 'minimize'>): Promise<void>
  openWindowsSettings(page: WindowsSettingsPage): Promise<void>
  perf(): Promise<PerfSample>
}

export interface SystemDeps {
  log: Logger
}
