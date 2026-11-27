import { describe, expect, it, vi } from 'vitest'
import { createNatPmpClient, parseDefaultGateways, withNatPmpFallback } from './natpmp'
import type { UdpSocket } from './upnp'

/** A router answering NAT-PMP as RFC 6886 lays it out; `requests` records what it was sent. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function fakeRouter(options: { ip?: string; refuse?: number; silent?: boolean } = {}) {
  const requests: Buffer[] = []
  const createSocket = (): UdpSocket => {
    let onMessage: ((msg: Buffer, rinfo: { address: string; port: number }) => void) | null = null
    return {
      on(event: string, listener: never) {
        if (event === 'message') onMessage = listener
        return this
      },
      bind: (_port: number, _address: string | undefined, cb: () => void) => cb(),
      send(msg: Buffer, _port: number, address: string) {
        requests.push(Buffer.from(msg))
        if (options.silent) return
        const opcode = msg[1]!
        const answer = Buffer.alloc(opcode === 0 ? 12 : 16)
        answer[1] = opcode + 128
        answer.writeUInt16BE(options.refuse ?? 0, 2)
        if (opcode === 0) {
          const [a, b, c, d] = (options.ip ?? '203.0.113.9').split('.').map(Number)
          answer.set([a!, b!, c!, d!], 8)
        } else {
          answer.writeUInt16BE(msg.readUInt16BE(4), 8)
          answer.writeUInt16BE(msg.readUInt16BE(6), 10)
          answer.writeUInt32BE(msg.readUInt32BE(8), 12)
        }
        queueMicrotask(() => onMessage?.(answer, { address, port: 5351 }))
      },
      close: () => undefined
    } as unknown as UdpSocket
  }
  return { requests, createSocket }
}

describe('NAT-PMP', () => {
  it("reads the default routes' gateways from Windows' route table", () => {
    const table = [
      'IPv4 Route Table',
      'Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0      192.168.1.1   192.168.1.10     25',
      '          0.0.0.0          0.0.0.0         10.0.0.1      10.0.0.85     35',
      '        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331'
    ].join('\r\n')
    expect(parseDefaultGateways(table)).toEqual(['192.168.1.1', '10.0.0.1'])
  })

  it('finds the router, reads its internet address, forwards and removes a port', async () => {
    const router = fakeRouter()
    const client = createNatPmpClient({
      createSocket: router.createSocket,
      gateways: async () => ['10.0.0.1']
    })
    const gateway = await client.discover()
    expect(gateway?.serviceType).toBe('NAT-PMP')
    expect(await gateway!.externalIp()).toBe('203.0.113.9')
    const { leaseSeconds } = await gateway!.addPortMapping({
      protocol: 'TCP',
      externalPort: 47900,
      internalPort: 47900,
      internalClient: '10.0.0.85',
      description: 'PlayOut host',
      leaseSeconds: 3600
    })
    expect(leaseSeconds).toBe(3600)
    const map = router.requests.at(-1)!
    expect([map[0], map[1], map.readUInt16BE(4), map.readUInt16BE(6), map.readUInt32BE(8)]).toEqual(
      [0, 2, 47900, 47900, 3600]
    )
    await gateway!.deletePortMapping({ protocol: 'UDP', externalPort: 47998 })
    const del = router.requests.at(-1)!
    expect([del[1], del.readUInt16BE(4), del.readUInt32BE(8)]).toEqual([1, 47998, 0])
  })

  it('gives up on a router that does not answer, and reports a refusal', async () => {
    vi.useFakeTimers()
    try {
      const silent = createNatPmpClient({
        createSocket: fakeRouter({ silent: true }).createSocket,
        gateways: async () => ['10.0.0.1']
      })
      const found = silent.discover()
      await vi.runAllTimersAsync()
      expect(await found).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    const refusing = createNatPmpClient({
      createSocket: fakeRouter({ refuse: 2 }).createSocket,
      gateways: async () => ['10.0.0.1']
    })
    expect(await refusing.discover()).toBeNull()
  })

  it('is asked only when UPnP finds no router', async () => {
    const upnpGateway = { host: 'upnp' } as never
    const natpmp = { discover: vi.fn(async () => null) }
    expect(await withNatPmpFallback({ discover: async () => upnpGateway }, natpmp).discover()).toBe(
      upnpGateway
    )
    expect(natpmp.discover).not.toHaveBeenCalled()
    await withNatPmpFallback({ discover: async () => null }, natpmp).discover()
    expect(natpmp.discover).toHaveBeenCalled()
  })
})
