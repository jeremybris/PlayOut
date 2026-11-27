import { execFile } from 'child_process'
import { createSocket as createDgramSocket } from 'dgram'
import type { Logger } from '../logger'
import {
  localIPv4Addresses,
  UpnpError,
  type PortMappingRequest,
  type PortProtocol,
  type UdpSocket,
  type UpnpClient,
  type UpnpGateway
} from './upnp'

/**
 * NAT-PMP (RFC 6886): port forwarding on routers that do not speak UPnP (Apple's and many others). The router is asked
 * on UDP 5351 for its internet address and to forward a port, through the same gateway interface UPnP uses, so the
 * host maps its port the same way whichever the router speaks.
 */
export const NAT_PMP_PORT = 5351
const FIRST_WAIT_MS = 250
const TRIES = 4
/** How long discovery waits for any router to answer (its retries take 3.75 s in all). */
const DISCOVER_TIMEOUT_MS = 4000

export interface NatPmpDeps {
  createSocket?: () => UdpSocket
  /** The router addresses to ask (default: Windows' default routes, else each local network's .1). */
  gateways?: () => Promise<string[]>
  log?: Logger
}

/** The gateways of Windows' default routes (`route print -4 0.0.0.0`: "0.0.0.0  0.0.0.0  <gateway>  <interface>  <metric>"). */
export function parseDefaultGateways(routePrint: string): string[] {
  const out: string[] = []
  for (const line of routePrint.split(/\r?\n/)) {
    const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s/.exec(line)
    if (m && !out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

function routeGateways(): Promise<string[]> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([])
    execFile(
      'route',
      ['print', '-4', '0.0.0.0'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => resolve(err ? [] : parseDefaultGateways(String(stdout)))
    )
  })
}

/** Where to ask: the default routes' gateways, then each local network's usual router address (x.y.z.1). */
async function candidateGateways(): Promise<string[]> {
  const out = await routeGateways()
  for (const ip of localIPv4Addresses()) {
    const guess = ip.replace(/\.\d+$/, '.1')
    if (!out.includes(guess) && guess !== ip) out.push(guess)
  }
  return out
}

function ipOf(buf: Buffer, at: number): string {
  return `${buf[at]}.${buf[at + 1]}.${buf[at + 2]}.${buf[at + 3]}`
}

const RESULT_TEXT: Record<number, string> = {
  1: 'unsupported version',
  2: 'not authorized or refused',
  3: 'network failure',
  4: 'out of resources',
  5: 'unsupported opcode'
}

export function createNatPmpClient(deps: NatPmpDeps = {}): UpnpClient {
  const makeSocket =
    deps.createSocket ??
    ((): UdpSocket => createDgramSocket({ type: 'udp4' }) as unknown as UdpSocket)
  const gateways = deps.gateways ?? candidateGateways

  /** One request to the router, retried with doubling waits; resolves with its answer of `opcode + 128`. */
  function ask(gateway: string, request: Buffer, opcode: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = makeSocket()
      let tries = 0
      let timer: NodeJS.Timeout | null = null
      const done = (err: Error | null, answer?: Buffer): void => {
        if (timer) clearTimeout(timer)
        try {
          socket.close()
        } catch {
          /* already closed */
        }
        if (err) reject(err)
        else resolve(answer!)
      }
      socket.on('error', (err) => done(err))
      socket.on('message', (msg, rinfo) => {
        if (rinfo.address !== gateway || msg.length < 8 || msg[0] !== 0 || msg[1] !== opcode + 128)
          return
        const result = msg.readUInt16BE(2)
        if (result !== 0)
          return done(
            new UpnpError(`NAT-PMP: ${RESULT_TEXT[result] ?? `error ${result}`}`, result, 'NAT-PMP')
          )
        done(null, msg)
      })
      const send = (): void => {
        if (tries >= TRIES) return done(new Error('NAT-PMP: the router did not answer'))
        const wait = FIRST_WAIT_MS * 2 ** tries
        tries++
        socket.send(request, NAT_PMP_PORT, gateway, (err) => {
          if (err) done(err)
        })
        timer = setTimeout(send, wait)
      }
      socket.bind(0, undefined, send)
    })
  }

  function gatewayAt(address: string, firstIp: string): UpnpGateway {
    const externalIp = async (): Promise<string> => {
      const answer = await ask(address, Buffer.from([0, 0]), 0)
      if (answer.length < 12) throw new Error('NAT-PMP: short answer')
      return ipOf(answer, 8)
    }
    const map = async (
      protocol: PortProtocol,
      internalPort: number,
      externalPort: number,
      lifetime: number
    ): Promise<number> => {
      const opcode = protocol === 'UDP' ? 1 : 2
      const req = Buffer.alloc(12)
      req[0] = 0
      req[1] = opcode
      req.writeUInt16BE(internalPort, 4)
      req.writeUInt16BE(externalPort, 6)
      req.writeUInt32BE(lifetime, 8)
      const answer = await ask(address, req, opcode)
      if (answer.length < 16) throw new Error('NAT-PMP: short answer')
      const mapped = answer.readUInt16BE(10)
      if (lifetime && mapped !== externalPort)
        throw new Error(`NAT-PMP: the router gave port ${mapped} instead of ${externalPort}`)
      return answer.readUInt32BE(12)
    }
    let cachedIp: string | undefined = firstIp
    return {
      location: `natpmp://${address}`,
      host: address,
      serviceType: 'NAT-PMP',
      controlUrl: '',
      friendlyName: 'NAT-PMP router',
      async externalIp() {
        if (cachedIp) {
          const ip = cachedIp
          cachedIp = undefined
          return ip
        }
        return externalIp()
      },
      async addPortMapping(request: PortMappingRequest) {
        // NAT-PMP mappings always lease; the host renews them as it does UPnP's.
        const leaseSeconds = await map(
          request.protocol,
          request.internalPort,
          request.externalPort,
          request.leaseSeconds || 3600
        )
        return { leaseSeconds: leaseSeconds || request.leaseSeconds || 3600 }
      },
      async deletePortMapping(request: { protocol: PortProtocol; externalPort: number }) {
        await map(request.protocol, request.externalPort, 0, 0)
      }
    }
  }

  return {
    async discover(timeoutMs = DISCOVER_TIMEOUT_MS) {
      const list = await gateways()
      if (!list.length) return null
      // Every candidate at once, the first to answer wins: a host start never waits on each silent address in turn.
      const attempts = list.map(async (address) => {
        try {
          const answer = await ask(address, Buffer.from([0, 0]), 0)
          if (answer.length < 12) throw new Error('NAT-PMP: short answer')
          deps.log?.info(`NAT-PMP: router ${address} answered`)
          return gatewayAt(address, ipOf(answer, 8))
        } catch (err) {
          deps.log?.debug(`NAT-PMP: ${address}: ${(err as Error).message}`)
          throw err
        }
      })
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
      try {
        return await Promise.race([Promise.any(attempts), timeout])
      } catch {
        return null
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  }
}

/** UPnP first, then NAT-PMP: the first kind of router that answers forwards the port. */
export function withNatPmpFallback(upnp: UpnpClient, natpmp: UpnpClient, log?: Logger): UpnpClient {
  return {
    async discover(timeoutMs) {
      const gateway = await upnp.discover(timeoutMs)
      if (gateway) return gateway
      log?.info('UPnP: no gateway found; trying NAT-PMP')
      return natpmp.discover(timeoutMs)
    }
  }
}
