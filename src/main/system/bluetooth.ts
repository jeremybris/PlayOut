import type { SystemStatus } from '../../shared/types'
import type { PsRunner } from './ps-worker'

export type BluetoothStatus = SystemStatus['bluetooth']

export const NO_BLUETOOTH: BluetoothStatus = { available: false, on: false }

/**
 * WinRT Windows.Devices.Radios from PowerShell (docs/research/electron-stack.md section 6.3): ~4 ms warm and it
 * reports the real radio state (on/off/disabled). The AsTask lookup needs System.Runtime.WindowsRuntime loaded
 * first; both are done once in the worker's init script. `$global:` because worker scripts run in a child scope.
 */
export const RADIO_INIT = `
$global:PlayOutRadioAsTask = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $null = [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]
  $global:PlayOutRadioAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' }
  )[0].MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
} catch {
  $global:PlayOutRadioAsTask = $null
}
`

/**
 * Radios first; when WinRT is unavailable (Windows N editions, locked-down policies) fall back to Plug and Play
 * presence, which only tells whether a Bluetooth adapter exists and reports no error.
 */
const SCRIPT = `
$radios = $null
if ($null -ne $global:PlayOutRadioAsTask) {
  try {
    $t = $global:PlayOutRadioAsTask.Invoke($null, @([Windows.Devices.Radios.Radio]::GetRadiosAsync()))
    if ($t.Wait(5000)) { $radios = @($t.Result | Select-Object Name, Kind, State) }
  } catch { $radios = $null }
}
if ($null -ne $radios) {
  @{ source = 'radios'; radios = $radios }
} else {
  $devices = @(Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match 'Bluetooth' -and $_.FriendlyName -notmatch 'Enumerator|RFCOMM|Service|Profile' } |
    Select-Object FriendlyName, Status)
  @{ source = 'pnp'; devices = $devices }
}
`

/** WinRT RadioKind / RadioState values. */
const KIND_BLUETOOTH = 3
const STATE_ON = 1

interface RawRadio {
  Name?: unknown
  Kind?: unknown
  State?: unknown
}

interface RawDevice {
  FriendlyName?: unknown
  Status?: unknown
}

interface RawBluetooth {
  source?: unknown
  radios?: RawRadio | RawRadio[] | null
  devices?: RawDevice | RawDevice[] | null
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function parseBluetooth(raw: unknown): BluetoothStatus {
  if (!raw || typeof raw !== 'object') return NO_BLUETOOTH
  const data = raw as RawBluetooth
  if (data.source === 'radios') {
    const bt = toArray(data.radios).filter(
      (r) => r && typeof r === 'object' && r.Kind === KIND_BLUETOOTH
    )
    if (bt.length === 0) return NO_BLUETOOTH
    return { available: true, on: bt.some((r) => r.State === STATE_ON) }
  }
  if (data.source === 'pnp') {
    const devices = toArray(data.devices).filter((d) => d && typeof d === 'object')
    if (devices.length === 0) return NO_BLUETOOTH
    return { available: true, on: devices.some((d) => d.Status === 'OK') }
  }
  return NO_BLUETOOTH
}

export async function readBluetooth(ps: PsRunner, timeoutMs = 8_000): Promise<BluetoothStatus> {
  return parseBluetooth(await ps.run(SCRIPT, { timeoutMs }))
}
