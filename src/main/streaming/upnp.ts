import { createSocket as createDgramSocket } from 'dgram'
import { networkInterfaces, type NetworkInterfaceInfo } from 'os'
import { XMLParser } from 'fast-xml-parser'
import type { Logger } from '../logger'

/**
 * A small UPnP Internet Gateway Device client: finds the router by SSDP, then asks it over SOAP for its external
 * address and to open or close port mappings. Only what the streaming host needs (no NAT-PMP/PCP, no event
 * subscriptions), and no dependency beyond fast-xml-parser, which PlayOut already ships.
 *
 * Every network edge is injectable (UDP socket, fetch, the local addresses) so the tests run without a router.
 */

const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900
const SOAP_TIMEOUT_MS = 5000
const DESCRIPTION_TIMEOUT_MS = 4000
/** Device descriptions are a few KB; anything far larger is not a router talking to us. */
const MAX_DESCRIPTION_BYTES = 1024 * 1024
/** SOAP answers to the few actions we send are a few hundred bytes. */
const MAX_SOAP_BYTES = 64 * 1024

/** The WAN connection services that can map ports, best first. */
export const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
] as const

/**
 * What M-SEARCH asks for: the services themselves, plus the IGD device types because some routers only answer
 * those (the device description then names the service either way).
 */
const SEARCH_TARGETS = [
  ...WAN_SERVICES,
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2'
]

export type PortProtocol = 'TCP' | 'UDP'

export interface PortMappingRequest {
  protocol: PortProtocol
  externalPort: number
  internalPort: number
  /** The LAN address the router forwards to (this PC; see pickInternalClient). */
  internalClient: string
  description: string
  /** 0 asks for a permanent mapping; IGD:2 routers refuse that, so callers should lease and renew. */
  leaseSeconds: number
}

export interface UpnpGateway {
  /** The device description URL the router announced. */
  location: string
  /** The router's LAN address (the LOCATION host). */
  host: string
  serviceType: string
  controlUrl: string
  friendlyName?: string
  externalIp(): Promise<string>
  /**
   * Resolves with the lease the router actually granted: 0 means it only took a permanent mapping, which stays on the
   * router if PlayOut never deletes it, so the caller should remember it for cleanup.
   */
  addPortMapping(request: PortMappingRequest): Promise<{ leaseSeconds: number }>
  deletePortMapping(request: { protocol: PortProtocol; externalPort: number }): Promise<void>
}

export interface UpnpClient {
  /** Find a gateway that can map ports, or null when the network has none (or UPnP is turned off). */
  discover(timeoutMs?: number): Promise<UpnpGateway | null>
}

/** The parts of a dgram socket SSDP needs (so tests can pass a fake). */
export interface UdpSocket {
  on(
    event: 'message',
    listener: (msg: Buffer, rinfo: { address: string; port: number }) => void
  ): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  bind(port: number, address: string | undefined, callback: () => void): unknown
  send(msg: Buffer, port: number, address: string, callback?: (err: Error | null) => void): unknown
  setMulticastTTL?(ttl: number): unknown
  setMulticastInterface?(address: string): unknown
  close(): unknown
}

export interface UpnpDeps {
  createSocket?: () => UdpSocket
  fetch?: typeof fetch
  log?: Logger
  /** The address to search from; by default every local IPv4 address is used, so a VPN adapter cannot hide the LAN. */
  localAddress?: () => string
}

/** A UPnP error answer from the router (`code` is the UPnP error code, e.g. 718). */
export class UpnpError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly action: string
  ) {
    super(message)
    this.name = 'UpnpError'
  }
}

/** Plain words for the UPnP errors a router gives back for port mappings. */
const ERROR_TEXT: Record<number, string> = {
  401: 'the router does not support this action',
  402: 'the router rejected the request as invalid',
  501: 'the router could not complete the action',
  606: 'the router does not allow this (UPnP changes are restricted)',
  713: 'the mapping index is out of range',
  714: 'no such port mapping',
  715: 'the router does not accept a wildcard source address',
  716: 'the router does not accept a wildcard external port',
  718: 'the port is already forwarded to another device',
  724: 'the router requires the same internal and external port',
  725: 'the router only supports permanent mappings',
  726: 'the router requires a wildcard remote host',
  727: 'the router requires a wildcard external port',
  728: 'the router has no free port mappings left',
  729: 'the port conflicts with another forwarding mechanism on the router',
  732: 'the router does not accept a wildcard internal port'
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true
})

// ---------------------------------------------------------------------------------------------------------------------
// HTTP

/**
 * The body as text, refusing anything past `max` bytes while it streams in: res.text() would buffer whatever a
 * hostile or broken LAN device sends until the timeout, in the main process.
 */
export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`response too large (${declared} bytes)`)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`response too large (over ${max} bytes)`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

// ---------------------------------------------------------------------------------------------------------------------
// Local addresses

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** 0 = RFC 1918 LAN, 1 = other routable, 2 = CGNAT/overlay VPNs (100.64/10), which rarely face the router. */
function addressRank(ip: string): number {
  const n = ipv4ToInt(ip) ?? 0
  const a = n >>> 24
  const b = (n >>> 16) & 255
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 0
  if (a === 100 && b >= 64 && b <= 127) return 2
  return 1
}

function ipv4Entries(interfaces: Interfaces): NetworkInterfaceInfo[] {
  const out: NetworkInterfaceInfo[] = []
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      // Node 18.0-18.3 reported the family as a number.
      const family = info.family as string | number
      if (family !== 'IPv4' && family !== 4) continue
      if (info.internal) continue
      // APIPA addresses mean the adapter got no DHCP lease: no router behind it.
      if (info.address.startsWith('169.254.')) continue
      out.push(info)
    }
  }
  return out
}

/** This PC's non-internal IPv4 addresses, LAN (private) ranges first. */
export function localIPv4Addresses(interfaces: Interfaces = networkInterfaces()): string[] {
  const seen = new Set<string>()
  const addresses: string[] = []
  for (const info of ipv4Entries(interfaces)) {
    if (seen.has(info.address)) continue
    seen.add(info.address)
    addresses.push(info.address)
  }
  // Array.prototype.sort is stable, so adapters keep the system order within a rank.
  return addresses.sort((x, y) => addressRank(x) - addressRank(y))
}

/**
 * The local address on the gateway's subnet: the one the router can forward to. Falls back to the address sharing
 * the longest prefix with the gateway, then to the first LAN address; null when this PC has no IPv4 address at all.
 */
export function pickInternalClient(
  gatewayHost: string,
  interfaces: Interfaces = networkInterfaces()
): string | null {
  const gateway = ipv4ToInt(gatewayHost)
  const entries = ipv4Entries(interfaces)
  if (entries.length === 0) return null
  if (gateway === null) return localIPv4Addresses(interfaces)[0] ?? null
  for (const info of entries) {
    const addr = ipv4ToInt(info.address)
    const mask = ipv4ToInt(info.netmask)
    if (addr === null || mask === null || mask === 0) continue
    if ((addr & mask) >>> 0 === (gateway & mask) >>> 0) return info.address
  }
  let best: string | null = null
  let bestBits = -1
  for (const info of entries) {
    const addr = ipv4ToInt(info.address)
    if (addr === null) continue
    const bits = Math.clz32((addr ^ gateway) >>> 0)
    if (
      bits > bestBits ||
      (bits === bestBits && best && addressRank(info.address) < addressRank(best))
    ) {
      best = info.address
      bestBits = bits
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------------------------------
// SSDP

export function searchMessage(target: string): Buffer {
  return Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      'MX: 2',
      `ST: ${target}`,
      '',
      ''
    ].join('\r\n')
  )
}

/** The LOCATION of an SSDP answer, or null when the datagram is not a usable answer. */
export function parseSsdpResponse(text: string): { location: string; st: string } | null {
  const lines = text.split(/\r?\n/)
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] ?? '')) return null
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
  }
  const location = headers.get('location')
  if (!location) return null
  try {
    const url = new URL(location)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  return { location, st: headers.get('st') ?? '' }
}

// ---------------------------------------------------------------------------------------------------------------------
// Device description

interface ServiceCandidate {
  serviceType: string
  controlUrl: string
  friendlyName?: string
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

interface DeviceNode {
  friendlyName?: unknown
  serviceList?: { service?: unknown } | string
  deviceList?: { device?: unknown } | string
}

/**
 * Every WAN connection service in the description, best type first, with controlURL resolved against URLBase (or the
 * LOCATION when there is none, as UPnP 1.1 requires). A control URL on another host than the LOCATION is dropped: a
 * real router serves both itself, and following one elsewhere would let any LAN device aim our SOAP requests (which
 * carry this PC's address) at localhost or the internet.
 */
export function findWanServices(xml: string, location: string): ServiceCandidate[] {
  let locationHost: string
  try {
    locationHost = new URL(location).hostname
  } catch {
    return []
  }
  const doc = parser.parse(xml) as { root?: { URLBase?: unknown; device?: unknown } }
  const root = doc.root
  if (!root || typeof root !== 'object') return []
  const base = text(root.URLBase) || location
  const found: ServiceCandidate[] = []
  const visit = (node: DeviceNode, depth: number, rootName?: string): void => {
    if (!node || typeof node !== 'object' || depth > 8) return
    // The router's own name is on the root device; embedded WAN devices carry generic ones.
    const friendlyName = rootName ?? (text(node.friendlyName) || undefined)
    const services =
      typeof node.serviceList === 'object' ? asArray(node.serviceList.service as unknown[]) : []
    for (const service of services as { serviceType?: unknown; controlURL?: unknown }[]) {
      const serviceType = text(service?.serviceType)
      const control = text(service?.controlURL)
      if (!control || !(WAN_SERVICES as readonly string[]).includes(serviceType)) continue
      try {
        const url = new URL(control, base)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
        if (url.hostname !== locationHost) continue
        found.push({ serviceType, controlUrl: url.toString(), friendlyName })
      } catch {
        /* a controlURL that does not resolve cannot be called */
      }
    }
    const devices =
      typeof node.deviceList === 'object' ? asArray(node.deviceList.device as unknown[]) : []
    for (const child of devices) visit(child as DeviceNode, depth + 1, friendlyName)
  }
  for (const device of asArray(root.device as unknown[])) visit(device as DeviceNode, 0)
  const rank = (t: string): number => (WAN_SERVICES as readonly string[]).indexOf(t)
  return found.sort((a, b) => rank(a.serviceType) - rank(b.serviceType))
}

// ---------------------------------------------------------------------------------------------------------------------
// SOAP

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function soapEnvelope(
  serviceType: string,
  action: string,
  args: [string, string | number][]
): string {
  const body = args.map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('')
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${escapeXml(serviceType)}">${body}</u:${action}></s:Body>` +
    '</s:Envelope>'
  )
}

/** The UPnPError inside a SOAP fault, if the body is one. */
export function parseSoapFault(xml: string): { code: number | null; description: string } | null {
  let doc: unknown
  try {
    doc = parser.parse(xml)
  } catch {
    return null
  }
  const fault = (doc as { Envelope?: { Body?: { Fault?: Record<string, unknown> } } })?.Envelope
    ?.Body?.Fault
  if (!fault) return null
  const upnp = (fault.detail as { UPnPError?: { errorCode?: unknown; errorDescription?: unknown } })
    ?.UPnPError
  const raw = text(upnp?.errorCode)
  const code = /^\d+$/.test(raw) ? Number(raw) : null
  return { code, description: text(upnp?.errorDescription) || text(fault.faultstring) }
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function createGateway(
  location: string,
  service: ServiceCandidate,
  http: typeof fetch,
  log: Logger | undefined
): UpnpGateway {
  const host = new URL(location).hostname

  const call = async (
    action: string,
    args: [string, string | number][]
  ): Promise<Record<string, unknown>> => {
    let res: Response
    try {
      res = await http(service.controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${service.serviceType}#${action}"`
        },
        body: soapEnvelope(service.serviceType, action, args),
        // A redirect could carry the request (and this PC's address) to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(SOAP_TIMEOUT_MS)
      })
    } catch (err) {
      const reason = (err as Error)?.name === 'TimeoutError' ? 'timed out' : (err as Error)?.message
      throw new UpnpError(`UPnP ${action}: the router did not answer (${reason})`, null, action)
    }
    let body: string
    try {
      body = await readCapped(res, MAX_SOAP_BYTES)
    } catch (err) {
      if (res.ok) {
        throw new UpnpError(
          `UPnP ${action}: unreadable answer (${(err as Error)?.message})`,
          null,
          action
        )
      }
      // A failed action is reported by its HTTP status below even when the fault body is unusable.
      body = ''
    }
    if (!res.ok) {
      const fault = parseSoapFault(body)
      const code = fault?.code ?? null
      const known = code !== null ? ERROR_TEXT[code] : undefined
      const detail = known ?? (fault?.description || `HTTP ${res.status}`)
      throw new UpnpError(
        `UPnP ${action} failed: ${detail}${code !== null ? ` (error ${code})` : ''}`,
        code,
        action
      )
    }
    const doc = parser.parse(body) as { Envelope?: { Body?: Record<string, unknown> } }
    const response = doc?.Envelope?.Body?.[`${action}Response`]
    return response && typeof response === 'object' ? (response as Record<string, unknown>) : {}
  }

  return {
    location,
    host,
    serviceType: service.serviceType,
    controlUrl: service.controlUrl,
    friendlyName: service.friendlyName,

    async externalIp(): Promise<string> {
      const res = await call('GetExternalIPAddress', [])
      const ip = text(res.NewExternalIPAddress)
      // Disconnected WAN links answer with an empty string or 0.0.0.0 rather than an error.
      if (!ip || ip === '0.0.0.0' || ipv4ToInt(ip) === null) {
        throw new UpnpError(
          'UPnP: the router has no external address',
          null,
          'GetExternalIPAddress'
        )
      }
      return ip
    },

    async addPortMapping(request: PortMappingRequest): Promise<{ leaseSeconds: number }> {
      if (!validPort(request.externalPort) || !validPort(request.internalPort)) {
        throw new Error(
          `Invalid port for a UPnP mapping: ${request.externalPort}/${request.internalPort}`
        )
      }
      const lease = Math.max(0, Math.floor(request.leaseSeconds))
      const args = (leaseSeconds: number): [string, string | number][] => [
        ['NewRemoteHost', ''],
        ['NewExternalPort', request.externalPort],
        ['NewProtocol', request.protocol],
        ['NewInternalPort', request.internalPort],
        ['NewInternalClient', request.internalClient],
        ['NewEnabled', 1],
        // Routers cut descriptions anywhere past ~64 chars; keep it short and plain.
        ['NewPortMappingDescription', request.description.slice(0, 64)],
        ['NewLeaseDuration', leaseSeconds]
      ]
      try {
        await call('AddPortMapping', args(lease))
        return { leaseSeconds: lease }
      } catch (err) {
        // Older routers only take permanent mappings: retry once that way rather than give up, and say so, because
        // such a mapping stays on the router if PlayOut never gets to delete it.
        if (err instanceof UpnpError && err.code === 725 && lease !== 0) {
          log?.warn(
            `UPnP: router only allows permanent mappings, mapping ${request.protocol} ${request.externalPort} without a lease`
          )
          await call('AddPortMapping', args(0))
          return { leaseSeconds: 0 }
        }
        throw err
      }
    },

    async deletePortMapping(request: {
      protocol: PortProtocol
      externalPort: number
    }): Promise<void> {
      try {
        await call('DeletePortMapping', [
          ['NewRemoteHost', ''],
          ['NewExternalPort', request.externalPort],
          ['NewProtocol', request.protocol]
        ])
      } catch (err) {
        // Already gone (lease ran out, router rebooted): that is what we wanted.
        if (err instanceof UpnpError && err.code === 714) return
        throw err
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Client

export function createUpnpClient(deps: UpnpDeps = {}): UpnpClient {
  const http = deps.fetch ?? fetch
  const log = deps.log
  const makeSocket =
    deps.createSocket ?? ((): UdpSocket => createDgramSocket({ type: 'udp4', reuseAddr: true }))

  /** The candidates of one LOCATION, or [] when it is not an IGD (printers and TVs answer M-SEARCH too). */
  const describe = async (location: string): Promise<ServiceCandidate[]> => {
    try {
      const res = await http(location, {
        // A redirect could bounce the request to a host the answer did not come from.
        redirect: 'error',
        signal: AbortSignal.timeout(DESCRIPTION_TIMEOUT_MS)
      })
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        return []
      }
      const xml = await readCapped(res, MAX_DESCRIPTION_BYTES)
      return findWanServices(xml, location)
    } catch (err) {
      log?.debug(`UPnP: could not read ${location}: ${(err as Error)?.message}`)
      return []
    }
  }

  /**
   * The first candidate that reports an external address. Routers with both an IP and a PPP connection service
   * often have only one of them connected; when none answers, the best-ranked one is still returned so mapping can
   * be tried (a few routers refuse GetExternalIPAddress but map ports fine).
   */
  const choose = async (location: string, candidates: ServiceCandidate[]): Promise<UpnpGateway> => {
    const gateways = candidates.map((c) => createGateway(location, c, http, log))
    if (gateways.length === 1) return gateways[0]
    for (const gateway of gateways) {
      try {
        await gateway.externalIp()
        return gateway
      } catch {
        /* try the next connection service */
      }
    }
    return gateways[0]
  }

  const discover = (timeoutMs = 3000): Promise<UpnpGateway | null> =>
    new Promise((resolve) => {
      const sockets: UdpSocket[] = []
      const seen = new Set<string>()
      const timers: ReturnType<typeof setTimeout>[] = []
      let pending = 0
      let searching = true
      let settled = false

      const closeSockets = (): void => {
        for (const socket of sockets.splice(0)) {
          try {
            socket.close()
          } catch {
            /* already closed */
          }
        }
      }
      const finish = (gateway: UpnpGateway | null): void => {
        if (settled) return
        settled = true
        searching = false
        for (const t of timers) clearTimeout(t)
        closeSockets()
        if (gateway) {
          log?.info(
            `UPnP: gateway ${gateway.friendlyName ?? gateway.host} (${gateway.serviceType})`
          )
        } else {
          log?.info('UPnP: no gateway found')
        }
        resolve(gateway)
      }
      const maybeDone = (): void => {
        if (!searching && pending === 0) finish(null)
      }

      const onMessage = (msg: Buffer, rinfo: { address: string; port: number }): void => {
        if (settled) return
        const answer = parseSsdpResponse(msg.toString('utf8'))
        if (!answer || seen.has(answer.location)) return
        // A router describes itself; a LOCATION on another host (localhost, the internet) is a spoofed or confused
        // answer, and fetching it would let anything that can reach this port steer our requests.
        if (new URL(answer.location).hostname !== rinfo.address) {
          log?.debug(`UPnP: ignoring ${answer.location} announced by ${rinfo.address}`)
          return
        }
        seen.add(answer.location)
        pending++
        void describe(answer.location)
          .then((candidates) => (candidates.length ? choose(answer.location, candidates) : null))
          .then(
            (gateway) => {
              pending--
              if (gateway) finish(gateway)
              else maybeDone()
            },
            () => {
              pending--
              maybeDone()
            }
          )
      }

      const sendSearch = (socket: UdpSocket): void => {
        for (const target of SEARCH_TARGETS) {
          try {
            socket.send(searchMessage(target), SSDP_PORT, SSDP_ADDRESS, (err) => {
              if (err) log?.debug(`UPnP: M-SEARCH send failed: ${err.message}`)
            })
          } catch (err) {
            log?.debug(`UPnP: M-SEARCH send failed: ${(err as Error)?.message}`)
          }
        }
      }

      // One socket per local address: Windows sends multicast out of a single adapter otherwise, and with a VPN or
      // Hyper-V switch present that is often not the one facing the router.
      let addresses: (string | undefined)[]
      try {
        addresses = deps.localAddress ? [deps.localAddress()] : localIPv4Addresses()
      } catch {
        addresses = []
      }
      if (addresses.length === 0) addresses = [undefined]

      for (const address of addresses.slice(0, 8)) {
        let socket: UdpSocket
        try {
          socket = makeSocket()
        } catch (err) {
          log?.warn(`UPnP: could not open a UDP socket: ${(err as Error)?.message}`)
          continue
        }
        sockets.push(socket)
        socket.on('message', onMessage)
        socket.on('error', (err) =>
          log?.debug(`UPnP: socket error on ${address ?? 'any'}: ${err.message}`)
        )
        try {
          socket.bind(0, address, () => {
            if (settled) return
            try {
              socket.setMulticastTTL?.(4)
              if (address) socket.setMulticastInterface?.(address)
            } catch {
              /* defaults are fine */
            }
            sendSearch(socket)
            // SSDP is UDP and routers drop the odd datagram: ask once more before giving up.
            timers.push(
              setTimeout(
                () => {
                  if (!settled) sendSearch(socket)
                },
                Math.min(1000, Math.floor(timeoutMs / 3))
              )
            )
          })
        } catch (err) {
          log?.debug(`UPnP: could not bind to ${address ?? 'any'}: ${(err as Error)?.message}`)
        }
      }
      if (sockets.length === 0) {
        finish(null)
        return
      }

      timers.push(
        setTimeout(() => {
          // Stop listening; descriptions already being fetched may still produce the gateway.
          searching = false
          closeSockets()
          maybeDone()
        }, timeoutMs)
      )
    })

  return { discover }
}
