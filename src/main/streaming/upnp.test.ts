import { describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'os'
import {
  createUpnpClient,
  findWanServices,
  localIPv4Addresses,
  parseSoapFault,
  parseSsdpResponse,
  pickInternalClient,
  readCapped,
  soapEnvelope,
  UpnpError,
  type UdpSocket
} from './upnp'

const LOCATION = 'http://192.168.1.1:5000/rootDesc.xml'

const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <friendlyName>Test Router</friendlyName>
    <serviceList><service>
      <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
      <controlURL>/ctl/L3F</controlURL>
    </service></serviceList>
    <deviceList><device>
      <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
      <deviceList><device>
        <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType>
            <controlURL>/ctl/PPP</controlURL>
          </service>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
            <controlURL>/ctl/IPConn</controlURL>
          </service>
        </serviceList>
      </device></deviceList>
    </device></deviceList>
  </device>
</root>`

function soapResponse(action: string, inner: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${inner}</u:${action}Response></s:Body></s:Envelope>`
}

function soapFault(code: number, description: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`
}

function iface(address: string, netmask: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null
  } as NetworkInterfaceInfo
}

class FakeSocket implements UdpSocket {
  sent: { msg: string; port: number; address: string }[] = []
  boundTo: string | undefined = 'unbound'
  closed = false
  private onMsg: ((msg: Buffer, rinfo: { address: string; port: number }) => void) | null = null
  on(event: 'message' | 'error', listener: (...args: never[]) => void): this {
    if (event === 'message') this.onMsg = listener as never
    return this
  }
  bind(_port: number, address: string | undefined, cb: () => void): this {
    this.boundTo = address
    queueMicrotask(cb)
    return this
  }
  send(msg: Buffer, port: number, address: string): this {
    this.sent.push({ msg: msg.toString(), port, address })
    return this
  }
  close(): this {
    this.closed = true
    return this
  }
  reply(text: string, from = '192.168.1.1'): void {
    this.onMsg?.(Buffer.from(text), { address: from, port: 1900 })
  }
}

const SSDP_OK = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: urn:schemas-upnp-org:service:WANIPConnection:1\r\nLOCATION: ${LOCATION}\r\nSERVER: Test\r\n\r\n`

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>

function fakeFetch(route: Route): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown, init?: RequestInit) =>
    route(String(input), init)
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

function soapAction(init?: RequestInit): string {
  const header = (init?.headers as Record<string, string>)?.SOAPAction ?? ''
  return header.replace(/"/g, '').split('#')[1] ?? ''
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('parseSsdpResponse', () => {
  it('reads LOCATION and ST case-insensitively', () => {
    expect(parseSsdpResponse(SSDP_OK.replace('LOCATION', 'Location'))).toEqual({
      location: LOCATION,
      st: 'urn:schemas-upnp-org:service:WANIPConnection:1'
    })
  })
  it('ignores notifications, missing or non-http locations', () => {
    expect(parseSsdpResponse('NOTIFY * HTTP/1.1\r\nLOCATION: http://x/\r\n\r\n')).toBeNull()
    expect(parseSsdpResponse('HTTP/1.1 200 OK\r\nST: x\r\n\r\n')).toBeNull()
    expect(parseSsdpResponse('HTTP/1.1 200 OK\r\nLOCATION: file:///c:/x\r\n\r\n')).toBeNull()
  })
})

describe('findWanServices', () => {
  it('finds nested WAN services, IP before PPP, resolved against the location', () => {
    const services = findWanServices(DESCRIPTION, LOCATION)
    expect(services.map((s) => [s.serviceType, s.controlUrl])).toEqual([
      ['urn:schemas-upnp-org:service:WANIPConnection:1', 'http://192.168.1.1:5000/ctl/IPConn'],
      ['urn:schemas-upnp-org:service:WANPPPConnection:1', 'http://192.168.1.1:5000/ctl/PPP']
    ])
  })
  it('prefers URLBase when the description has one', () => {
    const xml = DESCRIPTION.replace(
      '<device>',
      '<URLBase>http://192.168.1.1:8080/</URLBase><device>'
    )
    expect(findWanServices(xml, LOCATION)[0].controlUrl).toBe('http://192.168.1.1:8080/ctl/IPConn')
  })
  it('drops control URLs on another host than the LOCATION', () => {
    const elsewhere = DESCRIPTION.replace('/ctl/IPConn', 'http://127.0.0.1:47990/api/apps')
    expect(findWanServices(elsewhere, LOCATION).map((s) => s.controlUrl)).toEqual([
      'http://192.168.1.1:5000/ctl/PPP'
    ])
    const base = DESCRIPTION.replace('<device>', '<URLBase>http://203.0.113.5/</URLBase><device>')
    expect(findWanServices(base, LOCATION)).toEqual([])
  })
  it('returns nothing for devices that are not gateways', () => {
    expect(
      findWanServices('<root><device><friendlyName>TV</friendlyName></device></root>', LOCATION)
    ).toEqual([])
    expect(findWanServices('not xml', LOCATION)).toEqual([])
  })
})

describe('readCapped', () => {
  function streamed(chunks: number[]): { res: Response; cancelled: () => boolean } {
    let cancelled = false
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++]).fill(97))
        else controller.close()
      },
      cancel() {
        cancelled = true
      }
    })
    return { res: new Response(body), cancelled: () => cancelled }
  }

  it('reads a body within the limit', async () => {
    expect(await readCapped(new Response('héllo'), 100)).toBe('héllo')
    expect(await readCapped(new Response(null), 100)).toBe('')
  })
  it('refuses a declared length over the limit without reading', async () => {
    const res = new Response('abc', { headers: { 'content-length': '5000' } })
    await expect(readCapped(res, 100)).rejects.toThrow(/too large \(5000 bytes\)/)
  })
  it('stops reading a stream once it passes the limit', async () => {
    const { res, cancelled } = streamed([60, 60, 60, 60])
    await expect(readCapped(res, 100)).rejects.toThrow(/over 100 bytes/)
    expect(cancelled()).toBe(true)
  })
})

describe('SOAP helpers', () => {
  it('escapes argument values', () => {
    const xml = soapEnvelope('urn:x:1', 'AddPortMapping', [
      ['NewPortMappingDescription', 'A & <B>']
    ])
    expect(xml).toContain(
      '<NewPortMappingDescription>A &amp; &lt;B&gt;</NewPortMappingDescription>'
    )
    expect(xml).toContain('<u:AddPortMapping xmlns:u="urn:x:1">')
  })
  it('reads the UPnP error of a fault', () => {
    expect(parseSoapFault(soapFault(718, 'ConflictInMappingEntry'))).toEqual({
      code: 718,
      description: 'ConflictInMappingEntry'
    })
    expect(parseSoapFault(soapResponse('X', ''))).toBeNull()
  })
})

describe('local addresses', () => {
  const interfaces = {
    Loopback: [iface('127.0.0.1', '255.0.0.0', true)],
    Tailscale: [iface('100.101.102.103', '255.192.0.0')],
    Public: [iface('203.0.113.5', '255.255.255.0')],
    Ethernet: [
      iface('192.168.1.20', '255.255.255.0'),
      { ...iface('fe80::1', 'ffff::'), family: 'IPv6' } as NetworkInterfaceInfo
    ],
    APIPA: [iface('169.254.3.4', '255.255.0.0')],
    HyperV: [iface('172.20.0.1', '255.255.240.0')]
  }
  it('lists non-internal IPv4, private ranges first and overlays last', () => {
    expect(localIPv4Addresses(interfaces)).toEqual([
      '192.168.1.20',
      '172.20.0.1',
      '203.0.113.5',
      '100.101.102.103'
    ])
  })
  it('picks the address on the gateway subnet', () => {
    expect(pickInternalClient('192.168.1.1', interfaces)).toBe('192.168.1.20')
    expect(pickInternalClient('172.20.5.1', interfaces)).toBe('172.20.0.1')
  })
  it('falls back to the longest shared prefix, then the first LAN address', () => {
    expect(pickInternalClient('192.168.7.1', interfaces)).toBe('192.168.1.20')
    expect(pickInternalClient('router.local', interfaces)).toBe('192.168.1.20')
    expect(pickInternalClient('192.168.1.1', {})).toBeNull()
  })
})

describe('createUpnpClient.discover', () => {
  it('searches, reads the description and returns a gateway', async () => {
    const socket = new FakeSocket()
    const http = fakeFetch((url, init) => {
      if (url === LOCATION) return new Response(DESCRIPTION)
      if (soapAction(init) === 'GetExternalIPAddress') {
        return new Response(
          soapResponse(
            'GetExternalIPAddress',
            '<NewExternalIPAddress>198.51.100.7</NewExternalIPAddress>'
          )
        )
      }
      return new Response('', { status: 404 })
    })
    const client = createUpnpClient({
      createSocket: () => socket,
      fetch: http,
      localAddress: () => '192.168.1.20'
    })
    const pending = client.discover(500)
    await flush()
    expect(socket.boundTo).toBe('192.168.1.20')
    expect(socket.sent.length).toBeGreaterThan(0)
    expect(socket.sent[0]).toMatchObject({ port: 1900, address: '239.255.255.250' })
    expect(socket.sent.map((s) => s.msg).join()).toContain(
      'ST: urn:schemas-upnp-org:service:WANIPConnection:1'
    )
    socket.reply(SSDP_OK)
    socket.reply(SSDP_OK) // a second answer for the same LOCATION is not fetched again
    const gateway = await pending
    expect(gateway).not.toBeNull()
    expect(gateway!.host).toBe('192.168.1.1')
    expect(gateway!.serviceType).toBe('urn:schemas-upnp-org:service:WANIPConnection:1')
    expect(gateway!.friendlyName).toBe('Test Router')
    expect(socket.closed).toBe(true)
    expect(http.mock.calls.filter((c) => c[0] === LOCATION)).toHaveLength(1)
    expect(await gateway!.externalIp()).toBe('198.51.100.7')
  })

  it('uses the connected service when the router has both IP and PPP', async () => {
    const socket = new FakeSocket()
    const http = fakeFetch((url) => {
      if (url === LOCATION) return new Response(DESCRIPTION)
      if (url.endsWith('/ctl/IPConn')) {
        return new Response(
          soapResponse('GetExternalIPAddress', '<NewExternalIPAddress></NewExternalIPAddress>')
        )
      }
      return new Response(
        soapResponse(
          'GetExternalIPAddress',
          '<NewExternalIPAddress>198.51.100.9</NewExternalIPAddress>'
        )
      )
    })
    const client = createUpnpClient({
      createSocket: () => socket,
      fetch: http,
      localAddress: () => '192.168.1.20'
    })
    const pending = client.discover(500)
    await flush()
    socket.reply(SSDP_OK)
    const gateway = await pending
    expect(gateway!.serviceType).toBe('urn:schemas-upnp-org:service:WANPPPConnection:1')
  })

  it('returns null after the timeout when nothing answers', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const client = createUpnpClient({
        createSocket: () => socket,
        fetch: fakeFetch(() => new Response('')),
        localAddress: () => '192.168.1.20'
      })
      const pending = client.discover(3000)
      await vi.advanceTimersByTimeAsync(1000)
      // asked twice: the retry covers a dropped datagram
      expect(socket.sent.length).toBe(10)
      await vi.advanceTimersByTimeAsync(2000)
      await expect(pending).resolves.toBeNull()
      expect(socket.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns null when the only answer is not a gateway', async () => {
    const socket = new FakeSocket()
    const client = createUpnpClient({
      createSocket: () => socket,
      fetch: fakeFetch(
        () => new Response('<root><device><friendlyName>TV</friendlyName></device></root>')
      ),
      localAddress: () => '192.168.1.20'
    })
    const pending = client.discover(50)
    await flush()
    socket.reply(SSDP_OK)
    await expect(pending).resolves.toBeNull()
  })

  it('ignores an answer whose LOCATION is not on the sender', async () => {
    const socket = new FakeSocket()
    const http = fakeFetch(() => new Response(DESCRIPTION))
    const client = createUpnpClient({
      createSocket: () => socket,
      fetch: http,
      localAddress: () => '192.168.1.20'
    })
    const pending = client.discover(50)
    await flush()
    socket.reply(SSDP_OK, '192.168.1.66')
    socket.reply(SSDP_OK.replace(LOCATION, 'http://127.0.0.1:47990/'), '192.168.1.1')
    await expect(pending).resolves.toBeNull()
    expect(http).not.toHaveBeenCalled()
  })

  it('does not follow redirects when reading the description', async () => {
    const socket = new FakeSocket()
    const http = fakeFetch(() => new Response(''))
    const client = createUpnpClient({
      createSocket: () => socket,
      fetch: http,
      localAddress: () => '192.168.1.20'
    })
    const pending = client.discover(50)
    await flush()
    socket.reply(SSDP_OK)
    await pending
    const [, init] = http.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('error')
  })

  it('opens one socket per local address by default', async () => {
    const sockets: FakeSocket[] = []
    const client = createUpnpClient({
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      fetch: fakeFetch(() => new Response(''))
    })
    await client.discover(20)
    expect(sockets.length).toBeGreaterThanOrEqual(1)
    expect(sockets.every((s) => s.closed)).toBe(true)
  })
})

describe('gateway SOAP actions', () => {
  async function gatewayWith(route: Route): Promise<{
    gateway: NonNullable<Awaited<ReturnType<ReturnType<typeof createUpnpClient>['discover']>>>
    http: ReturnType<typeof fakeFetch>
  }> {
    const socket = new FakeSocket()
    const single = DESCRIPTION.replace(
      /<service>\s*<serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1[\s\S]*?<\/service>/,
      ''
    )
    const http = fakeFetch((url, init) =>
      url === LOCATION ? new Response(single) : route(url, init)
    )
    const client = createUpnpClient({
      createSocket: () => socket,
      fetch: http,
      localAddress: () => '192.168.1.20'
    })
    const pending = client.discover(500)
    await flush()
    socket.reply(SSDP_OK)
    const gateway = await pending
    if (!gateway) throw new Error('no gateway')
    return { gateway, http }
  }

  it('sends AddPortMapping with every argument', async () => {
    const { gateway, http } = await gatewayWith(
      () => new Response(soapResponse('AddPortMapping', ''))
    )
    await expect(
      gateway.addPortMapping({
        protocol: 'TCP',
        externalPort: 47900,
        internalPort: 47900,
        internalClient: '192.168.1.20',
        description: 'PlayOut streaming',
        leaseSeconds: 3600
      })
    ).resolves.toEqual({ leaseSeconds: 3600 })
    const [url, init] = http.mock.calls.at(-1) as [string, RequestInit]
    expect(url).toBe('http://192.168.1.1:5000/ctl/IPConn')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).SOAPAction).toBe(
      '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"'
    )
    const body = String(init.body)
    for (const part of [
      '<NewRemoteHost></NewRemoteHost>',
      '<NewExternalPort>47900</NewExternalPort>',
      '<NewProtocol>TCP</NewProtocol>',
      '<NewInternalPort>47900</NewInternalPort>',
      '<NewInternalClient>192.168.1.20</NewInternalClient>',
      '<NewEnabled>1</NewEnabled>',
      '<NewPortMappingDescription>PlayOut streaming</NewPortMappingDescription>',
      '<NewLeaseDuration>3600</NewLeaseDuration>'
    ]) {
      expect(body).toContain(part)
    }
  })

  it('turns a conflict into a readable UpnpError', async () => {
    const { gateway } = await gatewayWith(
      () => new Response(soapFault(718, 'ConflictInMappingEntry'), { status: 500 })
    )
    const err = await gateway
      .addPortMapping({
        protocol: 'UDP',
        externalPort: 47998,
        internalPort: 47998,
        internalClient: '192.168.1.20',
        description: 'x',
        leaseSeconds: 0
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpnpError)
    expect((err as UpnpError).code).toBe(718)
    expect((err as UpnpError).message).toBe(
      'UPnP AddPortMapping failed: the port is already forwarded to another device (error 718)'
    )
  })

  it('retries without a lease when the router only allows permanent mappings', async () => {
    const leases: string[] = []
    const { gateway } = await gatewayWith((_url, init) => {
      const lease = /<NewLeaseDuration>(\d+)</.exec(String(init?.body))?.[1] ?? ''
      leases.push(lease)
      return lease === '0'
        ? new Response(soapResponse('AddPortMapping', ''))
        : new Response(soapFault(725, 'OnlyPermanentLeasesSupported'), { status: 500 })
    })
    await expect(
      gateway.addPortMapping({
        protocol: 'TCP',
        externalPort: 47900,
        internalPort: 47900,
        internalClient: '192.168.1.20',
        description: 'x',
        leaseSeconds: 3600
      })
    ).resolves.toEqual({ leaseSeconds: 0 })
    expect(leases).toEqual(['3600', '0'])
  })

  it('refuses an oversized SOAP answer', async () => {
    const { gateway } = await gatewayWith(
      () => new Response('x'.repeat(65 * 1024 + 1), { headers: { 'content-length': '' } })
    )
    await expect(gateway.externalIp()).rejects.toThrow(/unreadable answer \(response too large/)
  })

  it('rejects invalid ports before calling the router', async () => {
    const { gateway, http } = await gatewayWith(() => new Response(''))
    const before = http.mock.calls.length
    await expect(
      gateway.addPortMapping({
        protocol: 'TCP',
        externalPort: 70000,
        internalPort: 1,
        internalClient: '192.168.1.20',
        description: 'x',
        leaseSeconds: 0
      })
    ).rejects.toThrow(/Invalid port/)
    expect(http.mock.calls.length).toBe(before)
  })

  it('treats deleting a missing mapping as done, other errors as errors', async () => {
    let code = 714
    const { gateway } = await gatewayWith(
      () => new Response(soapFault(code, 'NoSuchEntryInArray'), { status: 500 })
    )
    await expect(
      gateway.deletePortMapping({ protocol: 'TCP', externalPort: 47900 })
    ).resolves.toBeUndefined()
    code = 606
    await expect(
      gateway.deletePortMapping({ protocol: 'TCP', externalPort: 47900 })
    ).rejects.toThrow(/error 606/)
  })

  it('reports a router that does not answer', async () => {
    const { gateway } = await gatewayWith(() => {
      throw new TypeError('fetch failed')
    })
    await expect(gateway.externalIp()).rejects.toThrow(/did not answer \(fetch failed\)/)
  })

  it('rejects an empty external address', async () => {
    const { gateway } = await gatewayWith(
      () =>
        new Response(
          soapResponse(
            'GetExternalIPAddress',
            '<NewExternalIPAddress>0.0.0.0</NewExternalIPAddress>'
          )
        )
    )
    await expect(gateway.externalIp()).rejects.toThrow(/no external address/)
  })
})
