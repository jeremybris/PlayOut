import { psQuote, runPowerShellJson } from './powershell'

export type RegistryHive = 'HKLM' | 'HKCU' | 'HKCR' | 'HKU'
export type RegistryView = 'default' | 'x64' | 'x86'
export type RegistryValue = string | number | string[] | null

export interface RegistryKey {
  /** Full key name as reported by Windows, e.g. HKEY_LOCAL_MACHINE\SOFTWARE\Valve\Steam. */
  name: string
  /** Leaf name of the key. */
  leaf: string
  /** Values by name; the default value is stored under '(default)'. REG_BINARY is base64. */
  values: Record<string, RegistryValue>
  /** Subkeys, populated to the requested depth (values empty beyond it). */
  subkeys: RegistryKey[]
}

const HIVES: Record<RegistryHive, string> = {
  HKLM: 'LocalMachine',
  HKCU: 'CurrentUser',
  HKCR: 'ClassesRoot',
  HKU: 'Users'
}

const SCRIPT = `
function Read-RegKey($k, $depth) {
  $vals = @{}
  foreach ($n in $k.GetValueNames()) {
    $v = $k.GetValue($n)
    if ($v -is [byte[]]) { $v = [Convert]::ToBase64String($v) }
    $name = if ($n -eq '') { '(default)' } else { $n }
    $vals[$name] = $v
  }
  $subs = @()
  foreach ($s in $k.GetSubKeyNames()) {
    if ($depth -gt 0) {
      try {
        $sk = $k.OpenSubKey($s)
        if ($sk) { $subs += (Read-RegKey $sk ($depth - 1)); $sk.Close() }
      } catch {}
    } else {
      $subs += @{ name = ($k.Name + '\\' + $s); leaf = $s; values = @{}; subkeys = @() }
    }
  }
  return @{ name = $k.Name; leaf = ($k.Name.Split('\\')[-1]); values = $vals; subkeys = $subs }
}
`

/**
 * Read a registry key with its values and (optionally) subkeys in one PowerShell call.
 * `view` selects the 32-bit (WOW6432Node) or 64-bit view explicitly; 'default' follows the process (64-bit).
 * Returns null when the key does not exist.
 */
export async function readRegistryKey(
  hive: RegistryHive,
  path: string,
  options: { view?: RegistryView; depth?: number; timeoutMs?: number } = {}
): Promise<RegistryKey | null> {
  const view =
    options.view === 'x86' ? 'Registry32' : options.view === 'x64' ? 'Registry64' : 'Default'
  const depth = Math.max(0, Math.min(4, options.depth ?? 1))
  const script = `${SCRIPT}
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::${HIVES[hive]}, [Microsoft.Win32.RegistryView]::${view})
$k = $base.OpenSubKey(${psQuote(path.replace(/^\\+|\\+$/g, ''))})
if ($null -eq $k) { $null } else { $r = Read-RegKey $k ${depth}; $k.Close(); $r }
`
  const raw = await runPowerShellJson<RegistryKey>(script, {
    depth: 12,
    timeoutMs: options.timeoutMs ?? 20_000
  })
  if (!raw || typeof raw !== 'object') return null
  return normalize(raw)
}

function normalize(raw: RegistryKey): RegistryKey {
  const subkeys = Array.isArray(raw.subkeys)
    ? raw.subkeys
    : raw.subkeys
      ? [raw.subkeys as unknown as RegistryKey]
      : []
  return {
    name: String(raw.name ?? ''),
    leaf: String(raw.leaf ?? ''),
    values: raw.values && typeof raw.values === 'object' ? raw.values : {},
    subkeys: subkeys.map(normalize)
  }
}

/** Convenience: read one string value (null when the key or value is missing). */
export async function registryValue(
  hive: RegistryHive,
  path: string,
  valueName: string,
  options: { view?: RegistryView } = {}
): Promise<string | null> {
  const key = await readRegistryKey(hive, path, { view: options.view, depth: 0 })
  if (!key) return null
  const v = key.values[valueName || '(default)']
  if (v === undefined || v === null) return null
  return Array.isArray(v) ? v.join('\n') : String(v)
}
