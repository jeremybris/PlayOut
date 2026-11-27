// userData/streaming/secrets.json: everything Streaming must keep private, as one safeStorage (DPAPI) blob like the
// store credentials in accounts/token-store.ts. The host side keeps its paired clients (only a hash of each token),
// the client side its paired hosts (the token and the pinned certificate fingerprint), plus the Sunshine password and
// the router mappings that must be deleted on the next start. One blob rather than one per entry: the lists are small,
// change together (pairing writes both sides' bookkeeping) and nothing in them is worth reading without the rest.
import type { TokenCrypto } from '../accounts/token-store'
import type { Logger } from '../logger'
import { JsonStore } from '../store/json-store'
import type { PortProtocol } from './upnp'

/** A client paired with this PC (host side). The token itself is never stored, only its SHA-256. */
export interface StoredClient {
  id: string
  name: string
  tokenHash: string
  pairedAt: string
  lastSeen?: string
  /** The address it last connected from. */
  address?: string
}

/** A host this PC paired with (client side). */
export interface StoredHost {
  id: string
  name: string
  /** SHA-256 of the host's certificate: every connection is pinned to it. */
  fingerprint: string
  token: string
  lanAddress?: string
  wanAddress?: string
  port: number
  pairedAt: string
  lastSeen?: string
}

/** A port mapping the router only took as permanent (lease 0): deleted on the next start or when hosting stops. */
export interface StoredMapping {
  protocol: PortProtocol
  externalPort: number
}

export interface StreamingSecrets {
  clients: StoredClient[]
  hosts: StoredHost[]
  sunshinePassword?: string
  /** A paired client was removed while Sunshine was not running: Sunshine forgets its Moonlight clients at its next start. */
  sunshineUnpairPending?: boolean
  permanentMappings: StoredMapping[]
}

interface SecretsFile {
  version: 1
  /** base64 of safeStorage.encryptString(JSON.stringify(secrets)). */
  encrypted?: string
  /** Plain secrets when encryption is unavailable (logged once). */
  plain?: unknown
}

export function emptySecrets(): StreamingSecrets {
  return { clients: [], hosts: [], permanentMappings: [] }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const text = (v: unknown, max = 600): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max
const optText = (v: unknown, max = 600): string | undefined => (text(v, max) ? v : undefined)
const port = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535

/** Whatever the file held, reduced to valid entries: a damaged entry is dropped, never an exception. */
export function normalizeSecrets(raw: unknown): StreamingSecrets {
  const out = emptySecrets()
  if (!isObject(raw)) return out
  for (const c of Array.isArray(raw.clients) ? raw.clients : []) {
    if (!isObject(c) || !text(c.id, 128) || !text(c.name, 128) || !text(c.pairedAt, 64)) continue
    if (typeof c.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(c.tokenHash)) continue
    out.clients.push({
      id: c.id,
      name: c.name,
      tokenHash: c.tokenHash,
      pairedAt: c.pairedAt,
      lastSeen: optText(c.lastSeen, 64),
      address: optText(c.address, 255)
    })
  }
  for (const h of Array.isArray(raw.hosts) ? raw.hosts : []) {
    if (!isObject(h) || !text(h.id, 128) || !text(h.name, 128) || !text(h.pairedAt, 64)) continue
    if (!text(h.token, 256) || typeof h.fingerprint !== 'string') continue
    if (!/^[0-9a-f]{64}$/.test(h.fingerprint) || !port(h.port)) continue
    out.hosts.push({
      id: h.id,
      name: h.name,
      fingerprint: h.fingerprint,
      token: h.token,
      lanAddress: optText(h.lanAddress, 255),
      wanAddress: optText(h.wanAddress, 255),
      port: h.port,
      pairedAt: h.pairedAt,
      lastSeen: optText(h.lastSeen, 64)
    })
  }
  if (text(raw.sunshinePassword, 256)) out.sunshinePassword = raw.sunshinePassword
  if (raw.sunshineUnpairPending === true) out.sunshineUnpairPending = true
  for (const m of Array.isArray(raw.permanentMappings) ? raw.permanentMappings : []) {
    if (!isObject(m) || (m.protocol !== 'TCP' && m.protocol !== 'UDP') || !port(m.externalPort))
      continue
    out.permanentMappings.push({ protocol: m.protocol, externalPort: m.externalPort })
  }
  return out
}

function normalizeFile(raw: unknown): SecretsFile | null {
  if (!isObject(raw)) return null
  const file: SecretsFile = { version: 1 }
  if (typeof raw.encrypted === 'string' && raw.encrypted) file.encrypted = raw.encrypted
  if (isObject(raw.plain)) file.plain = raw.plain
  return file
}

async function electronCrypto(): Promise<TokenCrypto> {
  const { safeStorage } = await import('electron')
  return safeStorage
}

export interface SecretsStore {
  /** Read and decrypt the file; a blob that does not decrypt (another Windows user, damage) starts empty. */
  load(): Promise<void>
  /** The secrets in memory (after load). Treat as read-only: change them through update(). */
  get(): StreamingSecrets
  /** Change the secrets and save them (encrypted, debounced). */
  update(mutate: (draft: StreamingSecrets) => void): Promise<void>
  flush(): Promise<void>
}

export function createSecretsStore(file: string, log: Logger, crypto?: TokenCrypto): SecretsStore {
  const store = new JsonStore<SecretsFile>({
    file,
    defaults: () => ({ version: 1 }),
    normalize: normalizeFile
  })
  let api: TokenCrypto | null = crypto ?? null
  let current = emptySecrets()
  let warnedPlain = false
  const cryptoApi = async (): Promise<TokenCrypto> => (api ??= await electronCrypto())

  return {
    async load() {
      await store.load()
      const data = store.get()
      if (data.encrypted) {
        try {
          const plain = (await cryptoApi()).decryptString(Buffer.from(data.encrypted, 'base64'))
          current = normalizeSecrets(JSON.parse(plain))
        } catch (err) {
          // Pairings made by another Windows account cannot be read here: they are lost, not an error to stop on.
          log.warn(
            `streaming secrets could not be decrypted (${(err as Error).message}); starting empty`
          )
          current = emptySecrets()
        }
      } else current = normalizeSecrets(data.plain)
    },
    get: () => current,
    async update(mutate) {
      const next = normalizeSecrets(JSON.parse(JSON.stringify(current)))
      mutate(next)
      current = normalizeSecrets(next)
      const c = await cryptoApi()
      const json = JSON.stringify(current)
      if (c.isEncryptionAvailable()) {
        const encrypted = c.encryptString(json).toString('base64')
        store.replace({ version: 1, encrypted })
      } else {
        if (!warnedPlain) {
          warnedPlain = true
          log.warn(
            'safeStorage encryption is not available; streaming pairings are kept as plain JSON'
          )
        }
        store.replace({ version: 1, plain: JSON.parse(json) as unknown })
      }
    },
    flush: () => store.flush()
  }
}
