import { asArray, psQuote, runPowerShellJson } from '../system/powershell'

/**
 * Wake with the Xbox button's Windows commands (ported from SoCal IT's Windows11-Xbox-Controller-Wake, MIT,
 * ConsoleStylePCWizard 1.1.0 "Controller wake"): every device Windows can let wake the PC whose name says Xbox (the
 * Xbox Wireless Adapter, a wired Xbox controller) is allowed to (`powercfg -deviceenablewake`). Unlike the wizard,
 * which allows them all and later disallows every armed Xbox device, PlayOut records the devices it allowed and turns
 * only those back off, so a device the user allowed in Device Manager stays allowed.
 *
 * The wizard's other changes (classic S3 sleep, Modern Standby off, timeouts, automatic sign-in) are not ported: they
 * are whole-PC changes the wake does not need where the PC's sleep already lets USB devices wake it.
 */

/** Official Xbox Wireless Adapters (the wizard's VID/PID table): models 1790 and 1713, and later revisions. */
export const XBOX_ADAPTER_IDS = /VID_045E&PID_(02FE|0B05|02E6|02F9|091E)/i

/** A device of the wake lists that is an Xbox one (the wizard's name check). */
export const XBOX_NAME = /xbox/i

/** A powercfg device list: one name per line ("NONE" when empty, in English Windows). */
export function parseDeviceList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.toUpperCase() !== 'NONE')
}

/** The Xbox devices of a list, each once. */
export function xboxDevices(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => XBOX_NAME.test(n)))]
}

/**
 * Read without elevation: the Xbox devices that can wake the PC, those that do, and whether an Xbox Wireless Adapter
 * is plugged in. Its last expression is one object for runPowerShellJson.
 */
export const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$capable = @(powercfg -devicequery wake_from_any | ForEach-Object { $_.Trim() } | Where-Object { $_ })',
  '$armed = @(powercfg -devicequery wake_armed | ForEach-Object { $_.Trim() } | Where-Object { $_ })',
  '$programmable = @(powercfg -devicequery wake_programmable | ForEach-Object { $_.Trim() } | Where-Object { $_ })',
  '$adapter = $false',
  `try { $adapter = [bool](Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.InstanceId -match '${XBOX_ADAPTER_IDS.source}' } | Select-Object -First 1) } catch { }`,
  '[pscustomobject]@{ capable = $capable; armed = $armed; programmable = $programmable; adapter = $adapter }'
].join('\n')

/**
 * The elevated step that allows `targets` (Xbox devices whose wake setting can be changed and that are not allowed
 * yet, from the probe) to wake the PC. Writes the ledger (the devices PlayOut allowed, `prior` ones included) to
 * `ledgerPath` as it goes, so a step cut short is still undone. The names are passed in, so the elevated script never
 * reads a file a user process could change; each is checked against powercfg's own lists again.
 */
export function applyScript(
  ledgerPath: string,
  prior: readonly string[],
  targets: readonly string[]
): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$ledgerPath = ${psQuote(ledgerPath)}`,
    `$devices = New-Object System.Collections.ArrayList`,
    ...prior.map((name) => `[void]$devices.Add(${psQuote(name)})`),
    'function Save { [IO.File]::WriteAllText($ledgerPath, ((@{ devices = @($devices) }) | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false)) }',
    'Save',
    '$armed = @(powercfg -devicequery wake_armed | ForEach-Object { $_.Trim() } | Where-Object { $_ })',
    // -deviceenablewake changes only devices whose wake setting can be changed.
    '$programmable = @(powercfg -devicequery wake_programmable | ForEach-Object { $_.Trim() } | Where-Object { $_ })',
    '$failed = 0',
    `foreach ($name in @(${targets.map((t) => psQuote(t)).join(', ')})) {`,
    `  if ($name -notmatch '${XBOX_NAME.source}' -or $programmable -notcontains $name) { $failed++; continue }`,
    '  if ($armed -contains $name) { continue }',
    '  powercfg -deviceenablewake $name | Out-Null',
    '  if ($LASTEXITCODE -ne 0) { $failed++; continue }',
    '  if (-not $devices.Contains($name)) { [void]$devices.Add($name); Save }',
    '}',
    // Without a written record nothing could be undone: a failure.
    'try { Save } catch { exit 3 }',
    'if ($failed -gt 0) { exit 5 }',
    'exit 0'
  ].join('\n')
}

/**
 * The elevated step that turns wake back off for the devices PlayOut allowed (`devices`, from its ledger), those
 * still allowed (a device the user turned off since, or that is gone, needs nothing).
 */
export function revertScript(devices: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    '$armed = @(powercfg -devicequery wake_armed | ForEach-Object { $_.Trim() } | Where-Object { $_ })',
    // An unreadable list is a failure (tried again), never "nothing is armed".
    'if ($LASTEXITCODE -ne 0) { exit 4 }',
    '$failed = 0',
    ...devices.map(
      (name) =>
        `if ($armed -contains ${psQuote(name)}) { powercfg -devicedisablewake ${psQuote(name)} | Out-Null; if ($LASTEXITCODE -ne 0) { $failed++ } }`
    ),
    'if ($failed -gt 0) { exit 5 }',
    'exit 0'
  ].join('\n')
}

/** A ledger read back from disk (the user's own file: anything odd is dropped). */
export function parseLedger(text: string): string[] | null {
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as { devices?: unknown }
    const list = Array.isArray(raw?.devices) ? raw.devices : raw?.devices ? [raw.devices] : []
    return [
      ...new Set(
        list.filter((d): d is string => typeof d === 'string' && d.trim() !== '' && d.length < 300)
      )
    ]
  } catch {
    return null
  }
}

/** Reads the wake lists without elevation (PROBE_SCRIPT); null when PowerShell could not. */
export async function readWakeDevices(): Promise<{
  capable: string[]
  armed: string[]
  programmable: string[]
  adapter: boolean
} | null> {
  const raw = await runPowerShellJson<{
    capable?: unknown
    armed?: unknown
    programmable?: unknown
    adapter?: unknown
  }>(PROBE_SCRIPT, { timeoutMs: 30_000 })
  if (!raw) return null
  const list = (v: unknown): string[] =>
    parseDeviceList(
      asArray(v as string | string[] | null)
        .filter((x) => typeof x === 'string')
        .join('\n')
    )
  return {
    capable: list(raw.capable),
    armed: list(raw.armed),
    programmable: list(raw.programmable),
    adapter: raw.adapter === true
  }
}
