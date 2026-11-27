/// <reference types="vite/client" />

/** Battery Status API (Chromium ships it; it is not part of lib.dom). */
interface BatteryManager extends EventTarget {
  readonly charging: boolean
  readonly chargingTime: number
  readonly dischargingTime: number
  /** 0..1 */
  readonly level: number
}

interface Navigator {
  getBattery?: () => Promise<BatteryManager>
}
