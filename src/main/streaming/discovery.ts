import { createSocket as createUdpSocket, type Socket } from 'dgram'
import { networkInterfaces } from 'os'
import type { Logger } from '../logger'

/**
 * Finding PlayOut hosts on the local network: the client broadcasts a short UDP datagram on the host port + 1 and
 * every host with the host service on answers with who it is. Only the local network: the router's port forwarding
 * maps the TCP port, never this one. The answer carries nothing secret (the fingerprint is public; pairing still
 * needs the PIN), and answers are rate-limited so a host cannot be used to bounce traffic at someone else.
 */

export const DISCOVER_MESSAGE = 'PLAYOUT-DISCOVER 1'
const MAX_ANSWERS_PER_SECOND = 20

export interface DiscoveryInfo {
  id: string
  name: string
  /** The host service's TCP port. */
  port: number
  fingerprint: string
}

export interface FoundHost extends DiscoveryInfo {
  address: string
}

type SocketFactory = (type: 'udp4') => Socket

export interface DiscoveryResponderDeps {
  /** UDP port to answer on (the host port + 1). */
  port: number
  info: () => DiscoveryInfo
  log?: Logger
  createSocket?: SocketFactory
  now?: () => number
}

export interface DiscoveryResponder {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createDiscoveryResponder(deps: DiscoveryResponderDeps): DiscoveryResponder {
  const make = deps.createSocket ?? ((type) => createUdpSocket({ type }))
  const now = deps.now ?? Date.now
  let socket: Socket | null = null
  let windowStart = 0
  let answered = 0

  return {
    start() {
      if (socket) return Promise.resolve()
      const s = make('udp4')
      socket = s
      s.on('message', (msg, rinfo) => {
        if (msg.length > 64 || msg.toString('utf8').trim() !== DISCOVER_MESSAGE) return
        const t = now()
        if (t - windowStart >= 1000) {
          windowStart = t
          answered = 0
        }
        if (++answered > MAX_ANSWERS_PER_SECOND) return
        const { id, name, port, fingerprint } = deps.info()
        const answer = Buffer.from(JSON.stringify({ playout: 1, id, name, port, fingerprint }))
        s.send(answer, rinfo.port, rinfo.address, (err) => {
          if (err) deps.log?.debug(`discovery answer to ${rinfo.address} failed: ${err.message}`)
        })
      })
      return new Promise<void>((resolve, reject) => {
        const onStartError = (err: Error): void => {
          socket = null
          s.close()
          reject(err)
        }
        s.once('error', onStartError)
        s.bind(deps.port, () => {
          s.off('error', onStartError)
          // An 'error' with no listener would end the app (see index.ts).
          s.on('error', (err) => deps.log?.warn('discovery socket error:', err))
          resolve()
        })
      })
    },
    stop() {
      const s = socket
      socket = null
      if (!s) return Promise.resolve()
      return new Promise<void>((resolve) => {
        try {
          s.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
  }
}

export interface DiscoverOptions {
  /** UDP port the hosts answer on (the host port + 1). */
  port: number
  timeoutMs?: number
  /** Where to send the question; defaults to 255.255.255.255 and each interface's broadcast address. */
  targets?: string[]
  createSocket?: SocketFactory
  log?: Logger
}

/** Ask the local network for PlayOut hosts; resolves with every distinct host that answered within the time. */
export function discoverHosts(options: DiscoverOptions): Promise<FoundHost[]> {
  const make = options.createSocket ?? ((type) => createUdpSocket({ type }))
  const targets = options.targets ?? ['255.255.255.255', ...broadcastAddresses()]
  const timeoutMs = options.timeoutMs ?? 2500
  const found = new Map<string, FoundHost>()

  return new Promise((resolve) => {
    const s = make('udp4')
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try {
        s.close()
      } catch {
        /* already closed */
      }
      resolve([...found.values()])
    }
    const timer = setTimeout(finish, timeoutMs)
    s.on('error', (err) => {
      options.log?.warn('host discovery failed:', err)
      finish()
    })
    s.on('message', (msg, rinfo) => {
      const host = parseAnswer(msg, rinfo.address)
      if (host && !found.has(host.id)) found.set(host.id, host)
    })
    s.bind(0, () => {
      try {
        s.setBroadcast(true)
      } catch {
        /* not on every platform/address; unicast targets still work */
      }
      const question = Buffer.from(DISCOVER_MESSAGE)
      for (const target of new Set(targets)) {
        s.send(question, options.port, target, (err) => {
          if (err) options.log?.debug(`discovery to ${target} failed: ${err.message}`)
        })
      }
    })
  })
}

function parseAnswer(msg: Buffer, address: string): FoundHost | null {
  if (msg.length > 4096) return null
  try {
    const v = JSON.parse(msg.toString('utf8')) as Record<string, unknown>
    if (v.playout !== 1) return null
    const { id, name, port, fingerprint } = v
    if (typeof id !== 'string' || !id || id.length > 128) return null
    if (typeof name !== 'string' || name.length > 128) return null
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint)) return null
    return { id, name, port, fingerprint: fingerprint.toLowerCase(), address }
  } catch {
    return null
  }
}

/** The directed broadcast address of each non-internal IPv4 interface (e.g. 192.168.1.255 for a /24). */
export function broadcastAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string[] {
  const out = new Set<string>()
  for (const list of Object.values(interfaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const addr = toInt(ni.address)
      const mask = toInt(ni.netmask)
      if (addr === null || mask === null || mask === 0xffffffff) continue
      out.add(fromInt((addr | ~mask) >>> 0))
    }
  }
  return [...out]
}

function toInt(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function fromInt(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}
