// The graphics card games run on, for the Upgrade menu (docs/research/upgrades/gpu-anticheat.md, part A): Windows'
// video controllers (Win32_VideoController) plus the DirectX adapter cache's dedicated memory, read by one PowerShell
// script; the vendor from the PCI id, the NVIDIA RTX series from the name, NVIDIA's driver version from the Windows
// one. The dedicated card wins over the processor's built-in graphics.
import type { GpuInfo } from '../../shared/upgrades'

/**
 * PowerShell printing the computer's video controllers as a JSON array (one object per adapter, even when there is
 * one): Win32_VideoController's name, PCI id, driver version, display state and error code, with the adapter's
 * dedicated memory from the DirectX adapter cache (HKLM\SOFTWARE\Microsoft\DirectX, matched by PCI vendor and device
 * id; as a string, it can be large) and its PCI location ("PCI bus 0, device 2, function 0"). parseVideoControllers
 * reads it. Read-only; nothing is changed.
 */
export const VIDEO_CONTROLLER_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$dx = @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\DirectX' | ForEach-Object {
  $p = Get-ItemProperty -LiteralPath $_.PSPath
  if ($null -ne $p.VendorId -and $null -ne $p.DeviceId -and $null -ne $p.DedicatedVideoMemory) {
    [pscustomobject]@{ Ven = [uint32]$p.VendorId; Dev = [uint32]$p.DeviceId; Mem = [uint64]$p.DedicatedVideoMemory }
  }
})
$out = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  $x = $_
  $mem = $null
  if ($x.PNPDeviceID -match 'VEN_([0-9A-Fa-f]{4})&DEV_([0-9A-Fa-f]{4})') {
    $ven = [Convert]::ToUInt32($Matches[1], 16)
    $dev = [Convert]::ToUInt32($Matches[2], 16)
    $hit = $dx | Where-Object { $_.Ven -eq $ven -and $_.Dev -eq $dev } | Sort-Object Mem -Descending | Select-Object -First 1
    if ($hit) { $mem = $hit.Mem.ToString() }
  }
  $loc = $null
  try { $loc = [string](Get-PnpDeviceProperty -InstanceId $x.PNPDeviceID -KeyName DEVPKEY_Device_LocationInfo -ErrorAction Stop).Data } catch {}
  [pscustomobject]@{
    Name = [string]$x.Name
    PNPDeviceID = [string]$x.PNPDeviceID
    DriverVersion = [string]$x.DriverVersion
    AdapterCompatibility = [string]$x.AdapterCompatibility
    CurrentHorizontalResolution = $x.CurrentHorizontalResolution
    ConfigManagerErrorCode = $x.ConfigManagerErrorCode
    DedicatedVideoMemory = $mem
    LocationInfo = $loc
  }
})
ConvertTo-Json -InputObject $out -Compress`

/** What primaryGpu weighs beside GpuInfo (kept apart so GpuInfo stays as the menu shows it). */
interface Hints {
  /** Dedicated video memory in bytes from the DirectX adapter cache, if known. */
  dedicated: number | null
  /** The adapter drives a display now. */
  display: boolean
  /** "PCI bus 0, device 2": the usual slot of Intel's built-in graphics. */
  igpuSlot: boolean
}

const hints = new WeakMap<GpuInfo, Hints>()

const GIB = 1024 * 1024 * 1024

const VENDOR_IDS: Record<string, GpuInfo['vendor']> = {
  '10DE': 'nvidia',
  '1002': 'amd',
  '1022': 'amd',
  '8086': 'intel'
}

/** Microsoft Basic Render / Display and virtual display drivers: never the card games run on. */
const MICROSOFT_VENDOR = '1414'

/**
 * Reads VIDEO_CONTROLLER_SCRIPT's output (or a plain `Get-CimInstance Win32_VideoController | ConvertTo-Json`; one
 * object or an array; also a JSON string of that JSON, as a PowerShell runner that converts output to JSON returns it)
 * into the computer's real graphics adapters. Skipped: adapters not on PCI, Microsoft's basic and virtual display
 * drivers, disabled or failed devices. Unreadable input gives an empty list.
 */
export function parseVideoControllers(json: string): GpuInfo[] {
  let data: unknown
  try {
    data = JSON.parse(json)
    if (typeof data === 'string') data = JSON.parse(data)
  } catch {
    return []
  }
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  const gpus: GpuInfo[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const pnp = str(r['PNPDeviceID'])
    if (!/^PCI\\/i.test(pnp)) continue
    const ven = /VEN_([0-9A-F]{4})/i.exec(pnp)?.[1]?.toUpperCase() ?? ''
    if (ven === MICROSOFT_VENDOR) continue
    const err = r['ConfigManagerErrorCode']
    if (err !== undefined && err !== null && Number(err) !== 0) continue
    const name = str(r['Name']).trim()
    const vendor = VENDOR_IDS[ven] ?? vendorFromName(name, str(r['AdapterCompatibility']))
    const rawDriver = str(r['DriverVersion']).trim()
    const driver =
      vendor === 'nvidia'
        ? (nvidiaDriverVersion(rawDriver) ?? (rawDriver || null))
        : rawDriver || null
    const gpu: GpuInfo = {
      vendor,
      name,
      rtxSeries: vendor === 'nvidia' ? rtxSeriesOf(name) : null,
      driver
    }
    const mem = Number(str(r['DedicatedVideoMemory']) || NaN)
    hints.set(gpu, {
      dedicated: Number.isFinite(mem) && mem > 0 ? mem : null,
      display: Number(r['CurrentHorizontalResolution'] ?? 0) > 0,
      igpuSlot: /\bPCI bus 0, device 2\b/i.test(str(r['LocationInfo']))
    })
    gpus.push(gpu)
  }
  return gpus
}

/**
 * The adapter games run on, ranked by how sure it is a dedicated card: NVIDIA, and AMD or Intel cards known by name
 * (Radeon RX / Pro W / VII, Arc A-series and B5x0), first; then AMD or Intel adapters the name rules do not know but
 * with 1 GB or more of dedicated memory; then built-in graphics. Built-in graphics known by name ("AMD Radeon(TM)
 * Graphics", Radeon 780M / 8060S / Vega 8, Intel UHD / Iris / Arc Graphics / 140V / B390, or in Intel's usual
 * built-in slot) never count as dedicated, whatever memory the BIOS gives them. Then more dedicated memory, then
 * NVIDIA, AMD, Intel; the one driving a display only breaks ties (on laptops the built-in graphics drive the screen).
 * Null for an empty list.
 *
 * Memory, display and slot are only known for the very objects parseVideoControllers returned: pass that array
 * itself, not a copy (JSON, structuredClone, IPC or `{ ...gpu }` lose them). On copies or GpuInfo made elsewhere it
 * ranks by vendor and name alone.
 */
export function primaryGpu(gpus: GpuInfo[]): GpuInfo | null {
  let best: GpuInfo | null = null
  let bestKey: number[] = []
  for (const gpu of gpus) {
    const h = hints.get(gpu)
    const key = [
      dedicatedTier(gpu, h),
      h?.dedicated ?? 0,
      VENDOR_RANK[gpu.vendor],
      h?.display ? 1 : 0
    ]
    if (!best || compareKeys(key, bestKey) > 0) {
      best = gpu
      bestKey = key
    }
  }
  return best
}

/**
 * NVIDIA's driver version ("561.56") from the Windows one ("31.0.15.6156"): the last five digits of the third and
 * fourth parts (the fourth padded to four digits), a dot after the first three. Null when it is not a four-part
 * version of digits.
 */
export function nvidiaDriverVersion(windowsVersion: string): string | null {
  const p = windowsVersion.trim().split('.')
  if (p.length !== 4 || !p.every((x) => /^\d+$/.test(x))) return null
  const digits = (p[2] + p[3].padStart(4, '0')).slice(-5)
  if (digits.length < 5) return null
  return `${digits.slice(0, 3)}.${digits.slice(3)}`
}

/** The GeForce RTX series (20, 30, 40, 50) of an NVIDIA card's name, else null (GTX, MX, newer unknown ones). */
export function rtxSeriesOf(name: string): number | null {
  if (/Blackwell/i.test(name) && /\bRTX\b/i.test(name)) return 50
  if (/Ada Generation/i.test(name)) return 40
  if (/\bTITAN RTX\b/i.test(name) || /\bQuadro RTX\b/i.test(name)) return 20
  if (/\bRTX\s*A\d{3,4}\b/i.test(name)) return 30
  const m = /\bRTX\s*(?:PRO\s*)?(\d{2})(\d{2})\b/i.exec(name)
  if (!m) return null
  const series = Number(m[1])
  return [20, 30, 40, 50].includes(series) ? series : null
}

const VENDOR_RANK: Record<GpuInfo['vendor'], number> = { nvidia: 3, amd: 2, intel: 1, other: 0 }

/**
 * 2: a dedicated card by vendor or name; 1: dedicated only by its memory (1 GB or more, a name the rules do not
 * know); 0: built-in graphics. Name rules run before memory, as Ryzen processors report their BIOS frame buffer
 * (often 2 to 16 GB) as dedicated memory.
 */
function dedicatedTier(gpu: GpuInfo, h: Hints | undefined): number {
  if (gpu.vendor === 'nvidia') return 2
  if (gpu.vendor === 'amd') {
    if (/^AMD Radeon\s*(\(TM\))?\s*Graphics$/i.test(gpu.name)) return 0
    if (/Radeon\s*(\(TM\))?\s*(\d{3}M|\d{4}S|Vega)\b/i.test(gpu.name)) return 0
    if (/Radeon.*\bRX\s?(\d{3,4}|Vega)/i.test(gpu.name)) return 2
    if (/Radeon\s*(\(TM\))?\s*(Pro\s*W|VII\b)/i.test(gpu.name)) return 2
  } else if (gpu.vendor === 'intel') {
    // Arc A-series and B570 / B580 cards; "Arc(TM) Graphics", 130V / 140V and B370 / B390 are built-in graphics.
    if (/Arc\s*(\(TM\))?\s*(Pro\s*)?(A\d{2,3}M?|B5\d0)\b/i.test(gpu.name)) return 2
    if (h?.igpuSlot) return 0
    if (/\b(UHD|Iris|HD Graphics)\b/i.test(gpu.name)) return 0
    if (/Arc\s*(\(TM\))?\s*(Graphics|\d{3}V|B3\d0)\b/i.test(gpu.name)) return 0
  } else return 0
  return h?.dedicated != null && h.dedicated >= GIB ? 1 : 0
}

function vendorFromName(name: string, company: string): GpuInfo['vendor'] {
  const s = `${name} ${company}`
  if (/NVIDIA/i.test(s)) return 'nvidia'
  if (/\bAMD\b|Advanced Micro Devices|Radeon/i.test(s)) return 'amd'
  if (/Intel/i.test(s)) return 'intel'
  return 'other'
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}
