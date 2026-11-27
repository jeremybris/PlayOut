import { createSocket } from 'dgram'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  broadcastAddresses,
  createDiscoveryResponder,
  discoverHosts,
  type DiscoveryResponder
} from './discovery'

const FP = 'ab'.repeat(32)
let responders: DiscoveryResponder[] = []

afterEach(async () => {
  await Promise.all(responders.map((r) => r.stop()))
  responders = []
})

/** A free UDP port (bind to 0, read it, close). */
async function freePort(): Promise<number> {
  const s = createSocket('udp4')
  await new Promise<void>((resolve) => s.bind(0, '127.0.0.1', resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

describe('discovery', () => {
  it('finds a responding host and ignores other datagrams', async () => {
    const port = await freePort()
    const responder = createDiscoveryResponder({
      port,
      info: () => ({ id: 'host-1', name: 'Living Room PC', port: 47900, fingerprint: FP })
    })
    responders.push(responder)
    await responder.start()

    const found = await discoverHosts({ port, targets: ['127.0.0.1', '127.0.0.1'], timeoutMs: 500 })
    expect(found).toEqual([
      { id: 'host-1', name: 'Living Room PC', port: 47900, fingerprint: FP, address: '127.0.0.1' }
    ])

    // Anything but the question gets no answer.
    const probe = createSocket('udp4')
    const answers: Buffer[] = []
    probe.on('message', (m) => answers.push(m))
    await new Promise<void>((resolve) => probe.bind(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => probe.send('HELLO', port, '127.0.0.1', () => resolve()))
    await new Promise((r) => setTimeout(r, 200))
    probe.close()
    expect(answers).toEqual([])
  })

  it('resolves empty when nobody answers', async () => {
    const port = await freePort()
    expect(await discoverHosts({ port, targets: ['127.0.0.1'], timeoutMs: 200 })).toEqual([])
  })

  it('rejects start when the port is taken', async () => {
    const taken = createSocket('udp4')
    await new Promise<void>((resolve) => taken.bind(0, resolve))
    const port = (taken.address() as AddressInfo).port
    const responder = createDiscoveryResponder({
      port,
      info: () => ({ id: 'x', name: 'x', port: 1, fingerprint: FP })
    })
    await expect(responder.start()).rejects.toThrow()
    taken.close()
  })
})

describe('broadcastAddresses', () => {
  it('computes each interface broadcast address', () => {
    const list = broadcastAddresses({
      Ethernet: [
        {
          address: '192.168.1.20',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.1.20/24'
        }
      ],
      'Wi-Fi': [
        {
          address: '10.0.5.3',
          netmask: '255.255.240.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '10.0.5.3/20'
        }
      ],
      Loopback: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8'
        }
      ]
    })
    expect(list).toEqual(['192.168.1.255', '10.0.15.255'])
  })
})
