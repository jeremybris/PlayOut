/**
 * Wake with the Xbox button (Settings > System, main/controller-wake): an Xbox controller's Xbox button wakes the PC
 * from sleep, through the Xbox Wireless Adapter or a USB cable. Ported from SoCal IT's Windows11-Xbox-Controller-Wake
 * (MIT): the Xbox devices Windows can let wake the PC are allowed to.
 */
export interface ControllerWakeStatus {
  /** The setting (settings.system.controllerWake). */
  enabled: boolean
  /** Xbox devices Windows can let wake the PC (powercfg -devicequery wake_from_any), by their Windows names. */
  capable: string[]
  /** Of the Xbox devices, those allowed to wake the PC now (wake_armed). */
  armed: string[]
  /** Of the Xbox devices, those whose wake setting can be changed (wake_programmable): the ones PlayOut can allow. */
  programmable: string[]
  /** Windows' wake lists could be read (false: the lists above are empty because they are unknown). */
  readable: boolean
  /** An official Xbox Wireless Adapter is plugged in (USB VID 045E, PID 02FE, 0B05, 02E6, 02F9 or 091E). */
  adapter: boolean
  /**
   * The administrator step: 'working' while it runs, 'declined' when its prompt was declined (asked again when the
   * setting is turned on, or off, again), 'failed' when Windows did not make every change (kept across starts).
   */
  step: 'idle' | 'working' | 'declined' | 'failed'
}
