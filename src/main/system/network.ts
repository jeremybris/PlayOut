import type { SystemStatus } from '../../shared/types'
import type { PsRunner } from './ps-worker'

export type NetworkStatus = SystemStatus['network']

export const OFFLINE: NetworkStatus = { connected: false, kind: 'none' }

/**
 * One round trip in the warm worker, language-independent first (docs/research/electron-stack.md section 6.2):
 *
 * 1. Connection profiles (Get-NetConnectionProfile): which adapters have a network and how far it reaches.
 * 2. Physical adapters (Get-NetAdapter -Physical, 20 ms warm; the ~2 s cost is cold only): `PhysicalMediaType`
 *    is the untranslated NDIS medium, 'Native 802.11' for Wi-Fi, joined to the profiles by InterfaceIndex.
 * 3. WinRT connection profiles (35 ms warm): `IsWlanConnectionProfile`, the connected SSID and signal bars (0-5),
 *    none of which depend on the display language. Only profiles with at least local access are returned.
 * 4. The raw `netsh wlan show interfaces` text, whose labels are localized: it is enrichment only (an exact
 *    signal percentage, the SSID when WinRT is unavailable) and the last resort for the kind on an English Windows
 *    where the modern cmdlets failed.
 *
 * Each probe is wrapped so a failure (Windows N, policy, an old PowerShell) degrades to the next one.
 */
const SCRIPT = `
$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
  Select-Object Name, InterfaceAlias, InterfaceIndex, IPv4Connectivity, IPv6Connectivity)
$adapters = @()
try {
  $adapters = @(Get-NetAdapter -Physical -ErrorAction Stop |
    Select-Object InterfaceIndex, Name, @{n='PhysicalMediaType';e={ [string]$_.PhysicalMediaType }})
} catch { $adapters = @() }
$winrt = @()
try {
  $null = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
  foreach ($cp in [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()) {
    $level = [int]$cp.GetNetworkConnectivityLevel()
    if ($level -lt 1) { continue }
    $entry = @{ isWlan = [bool]$cp.IsWlanConnectionProfile; level = $level; adapterId = ''; bars = $null; ssid = '' }
    try { if ($cp.NetworkAdapter) { $entry.adapterId = [string]$cp.NetworkAdapter.NetworkAdapterId } } catch {}
    try { $b = $cp.GetSignalBars(); if ($null -ne $b) { $entry.bars = [int]$b } } catch {}
    if ($cp.IsWlanConnectionProfile) {
      try { $entry.ssid = [string]$cp.WlanConnectionProfileDetails.GetConnectedSsid() } catch {}
    }
    $winrt += $entry
  }
} catch { $winrt = @() }
$wlan = ''
try { $wlan = (& netsh.exe wlan show interfaces 2>&1 | Out-String) } catch { $wlan = '' }
@{ profiles = $profiles; adapters = $adapters; winrt = $winrt; wlan = [string]$wlan }
`

interface RawProfile {
  Name?: unknown
  InterfaceAlias?: unknown
  InterfaceIndex?: unknown
  IPv4Connectivity?: unknown
  IPv6Connectivity?: unknown
}

interface RawAdapter {
  InterfaceIndex?: unknown
  Name?: unknown
  /** 'Native 802.11' for Wi-Fi as a string, or the numeric NdisPhysicalMedium (9) from the CIM class. */
  PhysicalMediaType?: unknown
}

interface RawWinRtProfile {
  isWlan?: unknown
  /** NetworkConnectivityLevel: 0 None, 1 LocalAccess, 2 ConstrainedInternetAccess, 3 InternetAccess. */
  level?: unknown
  adapterId?: unknown
  /** 0-5 signal bars, null for wired profiles. */
  bars?: unknown
  ssid?: unknown
}

interface RawNetwork {
  profiles?: RawProfile | RawProfile[] | null
  adapters?: RawAdapter | RawAdapter[] | null
  winrt?: RawWinRtProfile | RawWinRtProfile[] | null
  wlan?: unknown
}

export interface WlanInterface {
  name: string
  state: string
  ssid?: string
  /** 0-100 */
  signal?: number
}

/** NLM connectivity levels: 0 Disconnected, 1 NoTraffic, 2 Subnet, 3 LocalNetwork, 4 Internet. */
const LOCAL_NETWORK = 3

/** WinRT NetworkConnectivityLevel.LocalAccess; anything at or above it is a connected profile. */
const WINRT_LOCAL_ACCESS = 1

/** NdisPhysicalMedium value for Native802_11 (the numeric form of 'Native 802.11'). */
const NDIS_NATIVE_802_11 = 9

/**
 * Parse `netsh wlan show interfaces`. Each interface starts with a `Name` line in English; `SSID` is matched on
 * its own so the `AP BSSID` line is not mistaken for it. The labels are localized, so on a non-English Windows
 * `Name`/`State` may not be recognised: labels may be any text (non-Latin included, treated as unknown keys), and
 * an `SSID` or `Signal` line that arrives before any recognised `Name` opens an implicit block (empty name) so
 * the untranslated values still come through. The result decides nothing on its own; `parseNetwork` uses it to
 * enrich a Wi-Fi status with an exact signal percentage and, failing WinRT, the SSID.
 */
export function parseWlanInterfaces(text: string): WlanInterface[] {
  const out: WlanInterface[] = []
  let current: WlanInterface | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const m = /^\s*([^\s:][^:]*?)\s*:\s*(.*?)\s*$/.exec(rawLine)
    if (!m) continue
    const key = m[1].trim().toLowerCase()
    const value = m[2]
    if (key === 'name') {
      current = { name: value, state: '' }
      out.push(current)
      continue
    }
    if (key !== 'state' && key !== 'ssid' && key !== 'signal') continue
    if (!current) {
      current = { name: '', state: '' }
      out.push(current)
    }
    if (key === 'state') {
      current.state = value.toLowerCase()
    } else if (key === 'ssid') {
      if (value) current.ssid = value
    } else {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) current.signal = Math.min(100, Math.max(0, n))
    }
  }
  return out
}

function connectivity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toList<T extends object>(value: T | T[] | null | undefined): T[] {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list.filter((item): item is T => !!item && typeof item === 'object')
}

function isWifiMedium(value: unknown): boolean {
  if (typeof value === 'number') return value === NDIS_NATIVE_802_11
  return str(value).replace(/\s+/g, '').toLowerCase() === 'native802.11'
}

function sameAlias(a: unknown, b: unknown): boolean {
  const x = str(a).trim().toLowerCase()
  return x !== '' && x === str(b).trim().toLowerCase()
}

/** The netsh block that describes `alias`, else the only block that carries an SSID (a one-radio machine). */
function wlanFor(interfaces: WlanInterface[], alias: unknown): WlanInterface | undefined {
  const byName = interfaces.find((w) => sameAlias(w.name, alias))
  if (byName) return byName
  const withSsid = interfaces.filter((w) => w.ssid !== undefined || w.signal !== undefined)
  return withSsid.length === 1 ? withSsid[0] : undefined
}

function wifiStatus(ssid: string | undefined, signal: number | undefined): NetworkStatus {
  const result: NetworkStatus = { connected: true, kind: 'wifi' }
  if (ssid) result.ssid = ssid
  if (signal !== undefined) result.signal = signal
  return result
}

/**
 * Decide the kind in order of trust: WinRT says the connected profile is WLAN; the connected profile's adapter
 * is a Native 802.11 medium; the English netsh block for the profile's alias says connected; otherwise any
 * connected profile is wired for our purposes (Ethernet, USB tethering, VPN adapters). netsh supplies the exact
 * signal percentage when it parsed; WinRT's bars (0-5, scaled to 0-100) otherwise.
 */
export function parseNetwork(raw: unknown): NetworkStatus {
  if (!raw || typeof raw !== 'object') return OFFLINE
  const { profiles, adapters, winrt, wlan } = raw as RawNetwork
  const connectedProfiles = toList(profiles).filter(
    (p) =>
      Math.max(connectivity(p.IPv4Connectivity), connectivity(p.IPv6Connectivity)) >= LOCAL_NETWORK
  )
  const connectedWinRt = toList(winrt).filter((p) => connectivity(p.level) >= WINRT_LOCAL_ACCESS)
  const wifiAdapters = toList(adapters).filter((a) => isWifiMedium(a.PhysicalMediaType))
  const wlanInterfaces = parseWlanInterfaces(str(wlan))

  // 1. WinRT: language-independent, carries the SSID and bars itself.
  const winRtWlan = connectedWinRt.find((p) => p.isWlan === true)
  if (winRtWlan) {
    const adapter = wifiAdapters.find((a) =>
      connectedProfiles.some((p) => p.InterfaceIndex === a.InterfaceIndex)
    )
    const alias =
      connectedProfiles.find((p) => adapter && p.InterfaceIndex === adapter.InterfaceIndex)
        ?.InterfaceAlias ?? adapter?.Name
    const netsh = wlanFor(wlanInterfaces, alias)
    const bars = connectivity(winRtWlan.bars)
    const signal =
      netsh?.signal ??
      (typeof winRtWlan.bars === 'number' ? Math.min(100, Math.max(0, bars * 20)) : undefined)
    return wifiStatus(str(winRtWlan.ssid) || netsh?.ssid, signal)
  }

  // 2. Adapter medium: the connected profile sits on a Native 802.11 adapter.
  const wifiProfile = connectedProfiles.find((p) =>
    wifiAdapters.some(
      (a) =>
        (typeof a.InterfaceIndex === 'number' && a.InterfaceIndex === p.InterfaceIndex) ||
        sameAlias(a.Name, p.InterfaceAlias)
    )
  )
  if (wifiProfile) {
    const netsh = wlanFor(wlanInterfaces, wifiProfile.InterfaceAlias)
    return wifiStatus(netsh?.ssid, netsh?.signal)
  }

  // 3. English netsh: a connected radio whose name is a connected profile's alias (or the only evidence at all).
  const connectedWlan = wlanInterfaces.filter((w) => w.state === 'connected')
  const netshProfile = connectedProfiles.find((p) =>
    connectedWlan.some((w) => sameAlias(w.name, p.InterfaceAlias))
  )
  const netsh = netshProfile
    ? connectedWlan.find((w) => sameAlias(w.name, netshProfile.InterfaceAlias))
    : connectedProfiles.length === 0 && connectedWinRt.length === 0 && connectedWlan.length > 0
      ? connectedWlan[0]
      : undefined
  if (netsh) return wifiStatus(netsh.ssid, netsh.signal)

  if (connectedProfiles.length > 0 || connectedWinRt.length > 0)
    return { connected: true, kind: 'ethernet' }
  return OFFLINE
}

export async function readNetwork(ps: PsRunner, timeoutMs = 8_000): Promise<NetworkStatus> {
  return parseNetwork(await ps.run(SCRIPT, { timeoutMs }))
}
