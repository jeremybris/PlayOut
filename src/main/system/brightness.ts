import { clampPercent } from './volume'
import type { PsRunner } from './ps-worker'

/**
 * Internal panel brightness through WMI (docs/research/electron-stack.md section 6.5). Only displays with a WMI
 * brightness driver expose these classes; external monitors need DDC/CI, so the result is null for them and the
 * UI hides the slider. Setting the value worked as a standard user on this machine (no admin needed).
 */
const READ_SCRIPT = `
$b = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue |
  Where-Object { $_.Active -ne $false } | Select-Object -First 1 CurrentBrightness)
if ($b.Count -gt 0) { @{ brightness = [int]$b[0].CurrentBrightness } } else { @{ brightness = $null } }
`

export function parseBrightness(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as { brightness?: unknown }).brightness
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clampPercent(value)
}

/** Current brightness in percent, or null when no display supports WMI brightness control. */
export async function readBrightness(ps: PsRunner, timeoutMs = 5_000): Promise<number | null> {
  return parseBrightness(await ps.run(READ_SCRIPT, { timeoutMs }))
}

export async function setBrightness(
  ps: PsRunner,
  percent: number,
  timeoutMs = 8_000
): Promise<void> {
  const value = clampPercent(percent)
  const script = `
$m = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue)
if ($m.Count -eq 0) { throw 'No display supports brightness control (WmiMonitorBrightnessMethods is absent)' }
foreach ($i in $m) {
  Invoke-CimMethod -InputObject $i -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]${value} } | Out-Null
}
`
  await ps.run(script, { timeoutMs })
}
