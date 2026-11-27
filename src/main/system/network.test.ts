import { afterAll, describe, expect, it, vi } from 'vitest'
import { OFFLINE, parseNetwork, parseWlanInterfaces, readNetwork } from './network'
import { createPsWorker, type PsWorker } from './ps-worker'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

const NETSH = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX211 160MHz
    GUID                   : 1b2c3d4e-0000-0000-0000-000000000000
    Physical address       : 00:11:22:33:44:55
    Interface type         : Primary
    State                  : connected
    SSID                   : HomeNetwork5
    AP BSSID               : 02:00:00:00:00:01
    Band                   : 5 GHz
    Channel                : 44
    Network type           : Infrastructure
    Radio type             : 802.11ax
    Authentication         : WPA2-Personal
    Cipher                 : CCMP
    Connection mode        : Auto Connect
    Receive rate (Mbps)    : 721
    Transmit rate (Mbps)   : 721
    Signal                 : 75%
    Profile                : HomeNetwork5

    Hosted network status  : Not available
`

// German Windows: the labels are translated but SSID and Signal are not.
const NETSH_DE = `
Es ist 1 Schnittstelle auf dem System vorhanden:

    Name                   : WLAN
    Beschreibung           : Intel(R) Wi-Fi 6E AX211 160MHz
    GUID                   : 1b2c3d4e-0000-0000-0000-000000000000
    Physische Adresse      : 00:11:22:33:44:55
    Status                 : Verbunden
    SSID                   : MeinNetz
    AP BSSID               : 02:00:00:00:00:01
    Signal                 : 86%
    Profil                 : MeinNetz
`

// Japanese Windows: even Name and State carry non-Latin labels.
const NETSH_JA = `
システムに 1 インターフェイスがあります:

    名前                   : Wi-Fi
    説明                   : Intel(R) Wi-Fi 6E AX211 160MHz
    状態                   : 接続されました
    SSID                   : 自宅ネット
    AP BSSID               : 02:00:00:00:00:01
    Signal                 : 64%
`

describe('netsh parsing', () => {
  it('reads name, state, SSID and signal without confusing AP BSSID for SSID', () => {
    expect(parseWlanInterfaces(NETSH)).toEqual([
      { name: 'Wi-Fi', state: 'connected', ssid: 'HomeNetwork5', signal: 75 }
    ])
  })

  it('keeps the untranslated SSID and Signal lines of a localized dump', () => {
    expect(parseWlanInterfaces(NETSH_DE)).toEqual([
      { name: 'WLAN', state: '', ssid: 'MeinNetz', signal: 86 }
    ])
    // No recognised Name line: the values open an implicit block instead of being dropped.
    expect(parseWlanInterfaces(NETSH_JA)).toEqual([
      { name: '', state: '', ssid: '自宅ネット', signal: 64 }
    ])
  })

  it('handles a disconnected radio and no interfaces', () => {
    const text =
      '    Name : Wi-Fi\r\n    State : disconnected\r\n    Radio status : Hardware On\r\n'
    expect(parseWlanInterfaces(text)).toEqual([{ name: 'Wi-Fi', state: 'disconnected' }])
    expect(parseWlanInterfaces('There is no wireless interface on the system.')).toEqual([])
    expect(parseWlanInterfaces('')).toEqual([])
  })
})

describe('network status', () => {
  it('reports Wi-Fi with SSID and signal when the connected profile is a wireless interface', () => {
    const status = parseNetwork({
      profiles: {
        Name: 'HomeNetwork5 4',
        InterfaceAlias: 'Wi-Fi',
        IPv4Connectivity: 4,
        IPv6Connectivity: 4
      },
      wlan: NETSH
    })
    expect(status).toEqual({ connected: true, kind: 'wifi', ssid: 'HomeNetwork5', signal: 75 })
  })

  it('reports Ethernet for a connected profile that is not a wireless interface', () => {
    const status = parseNetwork({
      profiles: [
        { Name: 'Network 2', InterfaceAlias: 'Ethernet', IPv4Connectivity: 4, IPv6Connectivity: 1 }
      ],
      wlan: 'There is no wireless interface on the system.'
    })
    expect(status).toEqual({ connected: true, kind: 'ethernet' })
  })

  it('prefers the Wi-Fi profile when both are connected', () => {
    const status = parseNetwork({
      profiles: [
        { Name: 'Network 2', InterfaceAlias: 'Ethernet', IPv4Connectivity: 4, IPv6Connectivity: 1 },
        { Name: 'HomeNetwork5', InterfaceAlias: 'Wi-Fi', IPv4Connectivity: 3, IPv6Connectivity: 0 }
      ],
      wlan: NETSH
    })
    expect(status.kind).toBe('wifi')
    expect(status.ssid).toBe('HomeNetwork5')
  })

  it('is offline when no profile reaches a network', () => {
    expect(parseNetwork({ profiles: [], wlan: '' })).toEqual(OFFLINE)
    expect(
      parseNetwork({
        profiles: [{ InterfaceAlias: 'Ethernet', IPv4Connectivity: 1, IPv6Connectivity: 0 }],
        wlan: ''
      })
    ).toEqual(OFFLINE)
    expect(parseNetwork(null)).toEqual(OFFLINE)
    expect(parseNetwork('garbage')).toEqual(OFFLINE)
  })

  it('falls back to the netsh state when profiles are unavailable but a radio says connected', () => {
    expect(parseNetwork({ profiles: null, wlan: NETSH })).toEqual({
      connected: true,
      kind: 'wifi',
      ssid: 'HomeNetwork5',
      signal: 75
    })
  })
})

describe('network status on a non-English Windows', () => {
  const profileDe = {
    Name: 'MeinNetz',
    InterfaceAlias: 'WLAN',
    InterfaceIndex: 17,
    IPv4Connectivity: 4,
    IPv6Connectivity: 4
  }

  it('is Wi-Fi when the adapter medium is Native 802.11, with SSID and signal from the German netsh dump', () => {
    const status = parseNetwork({
      profiles: profileDe,
      adapters: [
        { InterfaceIndex: 17, Name: 'WLAN', PhysicalMediaType: 'Native 802.11' },
        { InterfaceIndex: 5, Name: 'Ethernet', PhysicalMediaType: '802.3' }
      ],
      wlan: NETSH_DE
    })
    expect(status).toEqual({ connected: true, kind: 'wifi', ssid: 'MeinNetz', signal: 86 })
  })

  it('is Wi-Fi from the numeric CIM medium (9) even when netsh is unusable', () => {
    const status = parseNetwork({
      profiles: { ...profileDe, InterfaceAlias: 'Wi-Fi' },
      adapters: { InterfaceIndex: 17, Name: 'Wi-Fi', PhysicalMediaType: 9 },
      wlan: NETSH_JA
    })
    // The Japanese block has no recognisable name but is the only one with an SSID, so it still enriches.
    expect(status).toEqual({ connected: true, kind: 'wifi', ssid: '自宅ネット', signal: 64 })
    expect(
      parseNetwork({
        profiles: profileDe,
        adapters: [{ InterfaceIndex: 17, PhysicalMediaType: 9 }],
        wlan: ''
      })
    ).toEqual({ connected: true, kind: 'wifi' })
  })

  it('takes the kind, SSID and bars from WinRT when it answered', () => {
    const status = parseNetwork({
      profiles: profileDe,
      adapters: [],
      winrt: { isWlan: true, level: 3, adapterId: 'c5cb1d6d', bars: 4, ssid: 'MeinNetz' },
      wlan: ''
    })
    expect(status).toEqual({ connected: true, kind: 'wifi', ssid: 'MeinNetz', signal: 80 })
    // netsh's exact percentage beats the five bars when both are there.
    expect(
      parseNetwork({
        profiles: profileDe,
        winrt: [{ isWlan: true, level: 3, bars: 4, ssid: 'MeinNetz' }],
        wlan: NETSH_DE
      })
    ).toEqual({ connected: true, kind: 'wifi', ssid: 'MeinNetz', signal: 86 })
    // A disconnected WLAN profile (level 0) is not evidence of anything.
    expect(
      parseNetwork({
        profiles: [],
        winrt: [{ isWlan: true, level: 0, bars: 0, ssid: '' }],
        wlan: ''
      })
    ).toEqual(OFFLINE)
  })

  it('is Ethernet for a connected profile on a wired adapter whatever netsh says', () => {
    expect(
      parseNetwork({
        profiles: { ...profileDe, InterfaceAlias: 'Ethernet', InterfaceIndex: 5 },
        adapters: [
          { InterfaceIndex: 5, Name: 'Ethernet', PhysicalMediaType: '802.3' },
          { InterfaceIndex: 17, Name: 'WLAN', PhysicalMediaType: 'Native 802.11' }
        ],
        winrt: [{ isWlan: false, level: 3, bars: null, ssid: '' }],
        wlan: ''
      })
    ).toEqual({ connected: true, kind: 'ethernet' })
    expect(
      parseNetwork({
        profiles: { ...profileDe, InterfaceAlias: 'Ethernet', InterfaceIndex: 5 },
        adapters: { InterfaceIndex: 5, Name: 'Ethernet', PhysicalMediaType: 14 },
        wlan: ''
      })
    ).toEqual({ connected: true, kind: 'ethernet' })
  })
})

describe.skipIf(!onWindows)('network probe on this machine', () => {
  let worker: PsWorker | null = null
  afterAll(() => worker?.dispose())

  it('returns a well-formed status', async () => {
    worker = createPsWorker({ log })
    const t0 = performance.now()
    const status = await readNetwork(worker)
    const ms = Math.round(performance.now() - t0)
    expect(typeof status.connected).toBe('boolean')
    expect(['wifi', 'ethernet', 'none']).toContain(status.kind)
    if (status.kind === 'none') expect(status.connected).toBe(false)
    if (status.signal !== undefined) {
      expect(status.signal).toBeGreaterThanOrEqual(0)
      expect(status.signal).toBeLessThanOrEqual(100)
    }
    console.info(`[network] ${JSON.stringify(status)} in ${ms} ms`)
  }, 30_000)
})
