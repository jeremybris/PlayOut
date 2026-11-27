import { promises as fs } from 'fs'
import { dirname } from 'path'
import { psQuote } from '../system/powershell'

/**
 * Enhanced Sleep/Wake's Windows changes (docs/sleep-wake.md, "Windows changes"), made in one elevated step and undone
 * exactly when the feature is turned off. Ported from Winhanced's wake-source provisioning, standby and hibernate
 * settings, conservatively:
 * - Network adapters and fingerprint readers stop waking the PC (`powercfg -devicedisablewake`). Only devices whose
 *   Plug and Play class is Net or Biometric, and never an Xbox one; keyboards, mice, controllers (the Xbox Wireless
 *   Adapter too), USB hubs, the power button and the lid keep waking it.
 * - Sleep pauses everything: no network in Modern Standby (so mail, sync, updates and apps stop working in the
 *   background), no wake timers (scheduled tasks and updates cannot wake the PC), no Away Mode (an app cannot keep the
 *   PC running with the screen off), and automatic maintenance cannot wake it.
 * - Windows hibernates after 48 hours of sleep (HIBERNATEIDLE on the active plan, AC and DC), only where it was never
 *   or later than that, with hibernation switched on when it is off and the disk has room for it.
 * The ledger records only what PlayOut changed, so turning the feature off never touches anything else.
 */

/** Hibernate after this many seconds of sleep (Winhanced's handheld default, 48 h). */
export const HIBERNATE_AFTER_S = 172_800
/** Bumped when the elevated step changes more: a PC where an older step ran gets the new changes once. */
export const APPLY_VERSION = 2

const SUB_NONE = 'fea3413e-7e05-4911-9a71-700331f1c294'
const SUB_SLEEP = '238c9fa8-0aad-41ed-83f4-97be242c8f20'
const HIBERNATE_IDLE = '9d7815a6-7ee4-497e-8888-515a05f02364'
const MAINTENANCE_KEY =
  'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Schedule\\Maintenance'

interface PowerRule {
  /** For the log and the docs. */
  name: string
  sub: string
  setting: string
  target: number
  /** PowerShell condition on `$v` (the value found) under which PlayOut changes it. */
  when: string
  /** Only while hibernation is on. */
  needsHibernation?: boolean
}

/** The power plan settings PlayOut changes (active plan, plugged in and on battery). */
export const POWER_RULES: readonly PowerRule[] = [
  // Modern Standby without network ("disconnected standby"): background activity stops while asleep.
  {
    name: 'network in standby off',
    sub: SUB_NONE,
    setting: 'f15576e8-98b7-4186-b944-eafa664402d9',
    target: 0,
    when: '$v -ne 0'
  },
  // Wake timers off: scheduled tasks (updates, maintenance, apps) cannot wake the PC.
  {
    name: 'wake timers off',
    sub: SUB_SLEEP,
    setting: 'bd3b718a-0680-4d9d-8ab2-e1d2b4ac806d',
    target: 0,
    when: '$v -ne 0'
  },
  // Away Mode off: an app cannot keep the PC running behind a dark screen when it is told to sleep.
  {
    name: 'away mode off',
    sub: SUB_SLEEP,
    setting: '25dfa149-5dd1-4736-b5ab-e8a37b5b8187',
    target: 0,
    when: '$v -ne 0'
  },
  {
    name: 'hibernate after 48 h',
    sub: SUB_SLEEP,
    setting: HIBERNATE_IDLE,
    target: HIBERNATE_AFTER_S,
    when: `$v -eq 0 -or $v -gt ${HIBERNATE_AFTER_S}`,
    needsHibernation: true
  }
]

/** One power plan setting PlayOut changed, with the values it found (null: that side untouched). */
export interface PowerChange {
  scheme: string
  sub: string
  setting: string
  /** The value PlayOut set (put back only while it is still this). */
  target: number
  ac: number | null
  dc: number | null
}

/** What the elevated step changed (written by the apply script, read back by PlayOut). */
export interface WakeSourceLedger {
  /** Devices whose wake PlayOut disarmed (powercfg names). */
  devices: string[]
  /** Power plan settings PlayOut changed. */
  power: PowerChange[]
  /** PlayOut switched hibernation on. */
  hibernation: boolean
  /** The automatic-maintenance WakeUp value PlayOut changed to 0 (null: untouched). */
  maintenanceWake: number | null
}

export const EMPTY_LEDGER: WakeSourceLedger = Object.freeze({
  devices: [],
  power: [],
  hibernation: false,
  maintenanceWake: null
}) as WakeSourceLedger

export function ledgerIsEmpty(l: WakeSourceLedger): boolean {
  return (
    l.devices.length === 0 && l.power.length === 0 && !l.hibernation && l.maintenanceWake === null
  )
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? v : null
const key = (c: PowerChange): string => `${c.scheme}|${c.sub}|${c.setting}`.toLowerCase()

function parseChange(raw: unknown): PowerChange | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const target = num(r.target)
  if (![r.scheme, r.sub, r.setting].every((g) => GUID.test(String(g))) || target === null)
    return null
  const ac = num(r.ac)
  const dc = num(r.dc)
  if (ac === null && dc === null) return null
  return {
    scheme: String(r.scheme),
    sub: String(r.sub),
    setting: String(r.setting),
    target,
    ac,
    dc
  }
}

/** Validates a ledger read from disk (the file is the user's own; anything odd is dropped). */
export function parseLedger(text: string): WakeSourceLedger | null {
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return null
    const devices = Array.isArray(raw.devices)
      ? raw.devices.filter(
          (d): d is string => typeof d === 'string' && d.trim() !== '' && d.length < 300
        )
      : []
    const power: PowerChange[] = []
    const add = (c: PowerChange | null): void => {
      if (c && !power.some((p) => key(p) === key(c))) power.push(c)
    }
    for (const c of Array.isArray(raw.power) ? raw.power : [raw.power]) add(parseChange(c))
    // 0.1.98's ledger: the hibernate timeout alone.
    const h = raw.hibernate as Record<string, unknown> | null | undefined
    if (h && typeof h === 'object') {
      add(parseChange({ ...h, sub: SUB_SLEEP, setting: HIBERNATE_IDLE, target: HIBERNATE_AFTER_S }))
    }
    return {
      devices,
      power,
      hibernation: raw.hibernation === true,
      maintenanceWake: num(raw.maintenanceWake)
    }
  } catch {
    return null
  }
}

/**
 * An earlier ledger merged with a new run's: the earlier record holds the original values (a new run only sees what
 * PlayOut set), so it wins for a setting both recorded.
 */
export function mergeLedgers(
  prior: WakeSourceLedger,
  next: WakeSourceLedger | null
): WakeSourceLedger {
  const n = next ?? EMPTY_LEDGER
  // Per side: a side only the new run changed keeps the value that run found.
  const power = prior.power.map((p) => {
    const c = n.power.find((x) => key(x) === key(p))
    return c ? { ...p, ac: p.ac ?? c.ac, dc: p.dc ?? c.dc } : p
  })
  for (const c of n.power) if (!power.some((p) => key(p) === key(c))) power.push(c)
  return {
    devices: [...new Set([...prior.devices, ...n.devices])],
    power,
    hibernation: prior.hibernation || n.hibernation,
    maintenanceWake: prior.maintenanceWake ?? n.maintenanceWake
  }
}

/**
 * PowerShell: `$vals` = the AC and DC values of one setting (hidden settings included). powercfg's labels are in the
 * Windows language, so the lines ending in a hex value are taken, of which the current AC and DC values are the last
 * two (a range setting's minimum, maximum and step come before them).
 */
const readValues = (scheme: string, sub: string, setting: string): string =>
  `$vals = @((powercfg /qh ${scheme} ${sub} ${setting}) | ForEach-Object { if ($_ -match ':\\s*0x([0-9a-fA-F]+)\\s*$') { [Convert]::ToInt64($Matches[1], 16) } }); if ($vals.Count -ge 2) { $vals = @($vals[$vals.Count - 2], $vals[$vals.Count - 1]) }`

/**
 * The elevated apply step. Writes the ledger to `ledgerPath` (JSON, UTF-8) as it goes, so a step cut short is still
 * undone. Device names come from powercfg itself; nothing is read from a file.
 */
export function applyScript(ledgerPath: string): string {
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    `$ledgerPath = ${psQuote(ledgerPath)}`,
    '$ledger = [ordered]@{ devices = @(); power = @(); hibernation = $false; maintenanceWake = $null }',
    'function Save { [IO.File]::WriteAllText($ledgerPath, ($ledger | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false)) }',
    'Save',
    // Wake-armed devices; only network adapters and fingerprint readers are disarmed.
    '$armed = @(powercfg -devicequery wake_armed | Where-Object { $_ -and $_.Trim() })',
    'foreach ($name in $armed) {',
    '  $name = $name.Trim()',
    // An Xbox device (the Xbox Wireless Adapter can be a network device) keeps waking the PC: Wake with the Xbox button.
    "  if ($name -match 'Xbox') { continue }",
    '  $class = $null',
    // powercfg tells same-named devices apart with " (001)", " (002)"; Plug and Play knows them without it.
    "  $lookup = $name -replace '\\s*\\(\\d{3}\\)$', ''",
    '  try { $class = @(Get-PnpDevice -FriendlyName $lookup -ErrorAction Stop | ForEach-Object { $_.Class } | Select-Object -Unique) } catch { }',
    // Only when every device of that name is of that class (one name, one kind of device).
    '  if ($class.Count -eq 1) { $class = $class[0] } else { $class = $null }',
    "  if ($class -ne 'Net' -and $class -ne 'Biometric') { continue }",
    '  powercfg -devicedisablewake $name | Out-Null',
    '  if ($LASTEXITCODE -eq 0) { $ledger.devices += $name; Save }',
    '}',
    // Automatic maintenance may not wake the PC.
    `$mkey = ${psQuote(MAINTENANCE_KEY)}`,
    '$wake = $null',
    'try { $wake = (Get-ItemProperty -Path $mkey -Name WakeUp -ErrorAction Stop).WakeUp } catch { }',
    'if ($wake -ne $null -and $wake -ne 0) {',
    '  try { Set-ItemProperty -Path $mkey -Name WakeUp -Value 0 -Type DWord -ErrorAction Stop; $ledger.maintenanceWake = [int64]$wake; Save } catch { }',
    '}',
    // Hibernation on, when it is off and the disk has room for the hibernation file (40 % of the memory) and 10 GB.
    "$powerKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power'",
    // Windows uses HibernateEnabledDefault while HibernateEnabled is absent.
    "function HibOn { $p = Get-ItemProperty -Path $powerKey -ErrorAction SilentlyContinue; if ($p -and $p.PSObject.Properties['HibernateEnabled']) { return ($p.HibernateEnabled -eq 1) }; return [bool]($p -and $p.HibernateEnabledDefault -eq 1) }",
    'if (-not (HibOn)) {',
    '  try {',
    '    $ram = [int64](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory',
    '    $free = [int64](New-Object IO.DriveInfo ($env:SystemDrive)).AvailableFreeSpace',
    '    if ($ram -gt 0 -and $free -gt ($ram * 0.4 + 10GB)) {',
    '      powercfg /hibernate on | Out-Null',
    '      if (HibOn) { $ledger.hibernation = $true; Save }',
    '    }',
    '  } catch { }',
    '}',
    "$scheme = ([regex]'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}').Match((powercfg /getactivescheme) -join ' ').Value",
    'if ($scheme) {',
    '  $changed = $false'
  ]
  for (const r of POWER_RULES) {
    lines.push(
      `  # ${r.name}`,
      // A bare { } would only be a script block value; `if` runs it in this scope.
      `  if (${r.needsHibernation ? 'HibOn' : '$true'}) {`,
      `    ${readValues('$scheme', r.sub, r.setting)}`,
      '    if ($vals.Count -eq 2) {',
      `      $c = [ordered]@{ scheme = $scheme; sub = '${r.sub}'; setting = '${r.setting}'; target = ${r.target}; ac = $null; dc = $null }`,
      `      $v = $vals[0]; if (${r.when}) { powercfg /setacvalueindex $scheme ${r.sub} ${r.setting} ${r.target}; if ($LASTEXITCODE -eq 0) { $c.ac = [int64]$v } }`,
      `      $v = $vals[1]; if (${r.when}) { powercfg /setdcvalueindex $scheme ${r.sub} ${r.setting} ${r.target}; if ($LASTEXITCODE -eq 0) { $c.dc = [int64]$v } }`,
      '      if ($c.ac -ne $null -or $c.dc -ne $null) { $ledger.power += ,$c; $changed = $true; Save }',
      '    }',
      '  }'
    )
  }
  lines.push(
    '  if ($changed) { powercfg /setactive $scheme | Out-Null }',
    '}',
    // Without a written record nothing could be undone: a failure, tried again.
    'try { Save } catch { exit 3 }',
    'exit 0'
  )
  return lines.join('\n')
}

/**
 * The elevated revert step: wake back on for the devices PlayOut disarmed, and each setting back where it was, but
 * only while it is still PlayOut's value (one the user changed since stays). Built from the ledger PlayOut read, so the
 * elevated script never reads a file a user process could change.
 */
export function revertScript(ledger: WakeSourceLedger): string {
  const lines = ["$ErrorActionPreference = 'Continue'", '$failed = 0']
  if (ledger.devices.length > 0) {
    // A device that is gone (unplugged, removed) has nothing to put back, and is no failure.
    lines.push(
      '$present = @(powercfg -devicequery wake_programmable | Where-Object { $_ } | ForEach-Object { $_.Trim() })',
      // An unreadable list is a failure (tried again), never "every device is gone".
      'if ($LASTEXITCODE -ne 0 -or $present.Count -eq 0) { $failed++; $present = @() }'
    )
  }
  for (const name of ledger.devices) {
    lines.push(
      `if ($present -contains ${psQuote(name)}) { powercfg -deviceenablewake ${psQuote(name)} | Out-Null; if ($LASTEXITCODE -ne 0) { $failed++ } }`
    )
  }
  const schemes = new Set<string>()
  for (const c of ledger.power) {
    // Every value is validated (GUIDs, integers) by parseLedger; quoted all the same.
    const s = psQuote(c.scheme)
    schemes.add(c.scheme)
    lines.push(
      // `if` keeps $failed in this scope (a & { } block would count in a copy).
      'if ($true) {',
      `  ${readValues(s, psQuote(c.sub), psQuote(c.setting))}`,
      '  if ($vals.Count -eq 2) {',
      ...(c.ac !== null
        ? [
            `    if ($vals[0] -eq ${c.target}) { powercfg /setacvalueindex ${s} ${psQuote(c.sub)} ${psQuote(c.setting)} ${c.ac}; if ($LASTEXITCODE -ne 0) { $failed++ } }`
          ]
        : []),
      ...(c.dc !== null
        ? [
            `    if ($vals[1] -eq ${c.target}) { powercfg /setdcvalueindex ${s} ${psQuote(c.sub)} ${psQuote(c.setting)} ${c.dc}; if ($LASTEXITCODE -ne 0) { $failed++ } }`
          ]
        : []),
      // Unreadable on a plan that still exists: a failure (tried again); a plan deleted since has nothing to put back.
      `  } elseif ($plans -match ${psQuote(c.scheme)}) { $failed++ }`,
      '}'
    )
  }
  if (ledger.power.length > 0) lines.splice(2, 0, '$plans = (powercfg /list) -join " "')
  if (schemes.size > 0) {
    lines.push(
      `$active = ([regex]'[0-9a-fA-F-]{36}').Match((powercfg /getactivescheme) -join ' ').Value`,
      `if (@(${[...schemes].map(psQuote).join(', ')}) -contains $active) { powercfg /setactive $active | Out-Null }`
    )
  }
  if (ledger.maintenanceWake !== null) {
    lines.push(
      `$mkey = ${psQuote(MAINTENANCE_KEY)}`,
      // Put back only while it is still PlayOut's 0 (absent or changed since: left alone).
      '$m = Get-ItemProperty -Path $mkey -ErrorAction SilentlyContinue',
      `if ($m -and $m.PSObject.Properties['WakeUp'] -and $m.WakeUp -eq 0) { try { Set-ItemProperty -Path $mkey -Name WakeUp -Value ${ledger.maintenanceWake} -Type DWord -ErrorAction Stop } catch { $failed++ } }`
    )
  }
  if (ledger.hibernation) {
    // Only while still on (the user may have switched it off since).
    lines.push(
      `$p = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power' -ErrorAction SilentlyContinue`,
      'if ($p -and $p.HibernateEnabled -eq 1) { powercfg /hibernate off | Out-Null; if ($LASTEXITCODE -ne 0) { $failed++ } }'
    )
  }
  lines.push('exit $(if ($failed -gt 0) { 2 } else { 0 })')
  return lines.join('\n')
}

export async function readLedger(path: string): Promise<WakeSourceLedger | null> {
  try {
    return parseLedger(await fs.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

export async function writeLedger(path: string, ledger: WakeSourceLedger | null): Promise<void> {
  if (!ledger) {
    await fs.rm(path, { force: true })
    return
  }
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(ledger), 'utf8')
}
