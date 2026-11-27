import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import type { IncomingMessage } from 'http'
import { Agent, request, type RequestOptions } from 'https'
import type { Duplex } from 'stream'
import { pipeline } from 'stream/promises'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import type { HostInfo, MediaKindParam, RomFileList, StreamStatus } from './host-server'
import { ROM_DOWNLOAD_STREAMS } from './host-server'
import type { EmulationTransport } from './emulation-sync/types'
import { MAX_ACHIEVEMENTS_BODY_BYTES } from './host-achievements'
import { pairingProof } from './pairing'
import { sameFingerprint } from './tls'
import { tMain } from '../i18n'

/**
 * The client side of the host service. The host's certificate is self-signed, so the usual CA check is off and the
 * certificate is pinned instead: before a single byte of a request (the bearer token included) is written, the
 * fingerprint the server presented is compared with the one stored when pairing, and the connection is dropped when
 * they differ. Only probe() (reading /v1/info of a host not paired yet) connects without a pin, and it only reads.
 */

export interface HostClientDeps {
  /** Per-request limit for JSON calls (default 15 s). Downloads use it as an inactivity limit instead. */
  timeoutMs?: number
}

export interface PairResponse {
  hostId: string
  hostName: string
  token: string
  fingerprint: string
  externalIp?: string
}

export interface DownloadOptions {
  /** Bytes `dest` already holds; asks the host for the rest (`Range: bytes=<from>-`) and appends. */
  from?: number
  /** Bytes appended since the last call (a delta). */
  onBytes?: (bytes: number) => void
  signal?: AbortSignal
  /**
   * Refuse a whole-file (200) answer to a ranged request instead of starting `dest` over. ROM downloads use it: their
   * caller checks every byte against the size the host listed, and a restart would count the file twice.
   */
  strictRange?: boolean
}

export interface HostConnection {
  info(): Promise<HostInfo>
  /** The host's offer (HostGame[] from remote-library.ts). */
  library(): Promise<unknown[]>
  /**
   * The same offer with the host's clock (`now`, unchecked; absent from an older host): the games' last played are
   * dated on it, and shown only with it. Absent on test doubles: `library()` is asked, as of a host with no clock.
   */
  libraryAt?(): Promise<{ games: unknown[]; now?: unknown }>
  /** Ask the host to rescan its library (it answers at once; `scanRunning` tells when it is done). */
  scan(): Promise<void>
  scanRunning(): Promise<boolean>
  media(gameId: string, kind: MediaKindParam): Promise<{ data: Buffer; type: string } | null>
  romFiles(gameId: string): Promise<RomFileList>
  downloadFile(gameId: string, path: string, dest: string, options?: DownloadOptions): Promise<void>
  /**
   * Many downloads in a row (a game's files, its texture packs) over a few kept-alive connections, each checked
   * against the pin when it opens. close() when done. Absent on test doubles: downloadFile per file.
   */
  downloadSession?(): DownloadSession
  /** `warning`: the host's reason a stream from this network may fail (its stream ports are not forwarded). */
  prepareStream(gameId: string): Promise<{ app: string; sunshinePort: number; warning?: string }>
  stopStream(): Promise<void>
  /** The host's recent launch failure for this PC, if any (reported once). */
  streamStatus(): Promise<StreamStatus>
  /**
   * The host's metadata and RetroAchievements logins (host-logins.ts), unchecked; null when the host does not share
   * them (switched off, or a PlayOut from before 0.1.129).
   */
  logins(): Promise<unknown>
  /**
   * The Library tabs sync (library-tabs-sync.ts): send this PC's copy and its clock, get the host's (unchecked) and
   * the host's clock. Null when the host does not sync them (switched off, or an older PlayOut). Absent on test
   * doubles: no sync.
   */
  libraryTabs?(doc: unknown, now: number): Promise<{ doc: unknown; now: unknown } | null>
  /**
   * The favourites sync (favorites-sync.ts): send this PC's proposed favourites (by the host's offered ids) and its
   * clock, get every favourite (or changed) game of the host (unchecked) and the host's clock. Null when the host does
   * not sync them (switched off, or an older PlayOut). Absent on test doubles: no sync.
   */
  favorites?(entries: unknown[], now: number): Promise<{ entries: unknown; now: unknown } | null>
  /**
   * The play time sync (playtime-sync.ts): send this PC's sessions (by the host's offered ids) and/or ask for the
   * host's sessions of `games` after `after`; get the host's answer (unchecked). `recent`: the last played of this
   * PC's store games the host does not offer, answered with the other PCs' of the games in `want`
   * (recency-relay.ts; an older host answers none). Null when the host does not sync play time (switched off, or an older PlayOut). Absent on test doubles: no
   * sync.
   */
  playtime?(request: {
    sessions?: unknown[]
    recent?: unknown[]
    want?: string[]
    games?: string[]
    after?: unknown
    now: number
  }): Promise<{
    took: unknown
    sessions: unknown
    next: unknown
    more: unknown
    now: unknown
    recent?: unknown
  } | null>
  /**
   * A game's achievements list from the host (by its offered id), unchecked (host-achievements.ts
   * sanitizeAchievementsInfo); null when the host has none for it or is an older PlayOut. Absent on test doubles:
   * none.
   */
  achievements?(gameId: string): Promise<unknown>
  moonlightPair(pin?: string): Promise<{ ok: boolean; error?: string }>
  unpair(): Promise<void>
  /** The Emulation folder sync with this host (emulation-sync/). */
  emulation: EmulationTransport
}

export interface DownloadSession {
  downloadFile: HostConnection['downloadFile']
  /** Connections opened so far (each one pin-checked). */
  connectionsOpened(): number
  close(): void
}

/** Connections a download session keeps open at most (its caller fetches small files this many at a time). */
const SESSION_SOCKETS = ROM_DOWNLOAD_STREAMS

export interface HostClient {
  probe(address: string, port: number): Promise<{ info: HostInfo; fingerprint: string }>
  pair(
    address: string,
    port: number,
    pin: string,
    clientId: string,
    clientName: string
  ): Promise<PairResponse>
  connect(target: {
    address: string
    port: number
    fingerprint: string
    token: string
  }): HostConnection
}

/** The host answered with an error (`code` is its `{ error }`, e.g. 'wrong-pin', 'busy', 'unauthorized'). */
export class HostRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message || `The host answered ${status} (${code})`)
    this.name = 'HostRequestError'
  }
}

/** The host presented a different certificate than the one paired with: not the same computer, or someone between. */
export class CertificateMismatchError extends Error {
  constructor(readonly seen: string) {
    super(tMain('mainStreaming.client.certificateChanged'))
    this.name = 'CertificateMismatchError'
  }
}

const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
/** The host waits up to 90 s for Moonlight's pairing request. */
const MOONLIGHT_PAIR_TIMEOUT_MS = 100_000
/** Asked right after a stream closed: a host that does not answer quickly changes nothing. */
const STREAM_STATUS_TIMEOUT_MS = 3_000
/** A TLS handshake on a LAN takes milliseconds; anything this slow is the wrong machine or none at all. */
const HANDSHAKE_TIMEOUT_MS = 15_000
/** Hashing a large Emulation folder, or a large upload, on the host. */
const EMULATION_MANIFEST_TIMEOUT_MS = 30 * 60_000

/**
 * An agent whose connections are checked against `pin` before the request goes out. `seen` gets the fingerprint of
 * every connection (probe() reads it from there). No TLS session reuse, so every connection is checked against a full
 * handshake's certificate; no keep-alive unless asked (a download session), where a kept connection is one that was
 * checked when it opened.
 */
class PinnedAgent extends Agent {
  seen: string | null = null
  /**
   * Connections still in their handshake. Agent only learns of a socket once the callback below hands it over, so
   * destroy() would otherwise miss these and leave them open.
   */
  private readonly pending = new Set<TLSSocket>()

  /** Connections this agent opened that passed the pin check (tests). */
  opened = 0

  constructor(
    private readonly pin: string | null,
    keep?: { maxSockets: number }
  ) {
    super(
      keep
        ? { keepAlive: true, maxSockets: keep.maxSockets, maxCachedSessions: 0 }
        : { keepAlive: false, maxCachedSessions: 0 }
    )
  }

  override createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const host = options.host ?? options.hostname ?? 'localhost'
    const socket: TLSSocket = tlsConnect({
      host,
      port: Number(options.port),
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      // SNI is not allowed for IP addresses and the host does not use it.
      servername: undefined
    })
    // The request's own timeout and abort signal only start working once it has a socket, which is after this
    // callback. A wrong address that accepts TCP and then says nothing would hang the request forever without this.
    const limit = Math.min(Number(options.timeout) || HANDSHAKE_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS)
    this.pending.add(socket)
    let settled = false
    const done = (err: Error | null): void => {
      if (settled) return
      settled = true
      this.pending.delete(socket)
      socket.setTimeout(0)
      if (err) socket.destroy()
      callback?.(err, socket)
    }
    socket.setTimeout(limit, () => done(new Error('The host did not answer in time')))
    socket.once('error', (err) => done(err))
    socket.once('close', () => done(new Error('The host closed the connection')))
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate()?.raw
      if (!raw) return done(new Error(tMain('mainStreaming.client.noCertificate')))
      const fingerprint = createHash('sha256').update(raw).digest('hex')
      this.seen = fingerprint
      if (this.pin !== null && !sameFingerprint(fingerprint, this.pin)) {
        return done(new CertificateMismatchError(fingerprint))
      }
      this.opened++
      done(null)
    })
    return undefined
  }

  override destroy(): void {
    for (const socket of this.pending) socket.destroy()
    this.pending.clear()
    super.destroy()
  }
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT'
  body?: unknown
  /** Sent as is (an upload piece) instead of a JSON body. */
  raw?: Buffer
  token?: string
  timeoutMs?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  /** A JSON answer larger than this is refused (default MAX_JSON_BYTES). */
  maxBytes?: number
}

function send(
  agent: PinnedAgent,
  address: string,
  port: number,
  path: string,
  options: CallOptions
): Promise<IncomingMessage> {
  const payload: string | Buffer | undefined =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  const headers: Record<string, string | number> = {
    Accept: 'application/json',
    ...options.headers
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  if (payload !== undefined) {
    headers['Content-Type'] = options.raw ? 'application/octet-stream' : 'application/json'
    headers['Content-Length'] = Buffer.byteLength(payload)
  }
  return new Promise((resolve, reject) => {
    const signal = options.signal
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Cancelled'))
      return
    }
    const req = request({
      agent,
      host: address.replace(/^\[|\]$/g, ''),
      port,
      path,
      method: options.method ?? 'GET',
      headers,
      timeout: options.timeoutMs,
      signal
    })
    // ClientRequest ignores an abort until it has a socket; answer it right away instead. The caller's
    // agent.destroy() then closes a connection still in its handshake.
    const onAbort = (): void => {
      req.destroy()
      reject(signal?.reason ?? new Error('Cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = (): void => signal?.removeEventListener('abort', onAbort)
    req.once('response', (res) => {
      settle()
      resolve(res)
    })
    req.once('error', (err) => {
      settle()
      reject(err)
    })
    req.once('timeout', () => req.destroy(new Error('The host did not answer in time')))
    req.end(payload)
  })
}

async function readBody(res: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(res.headers['content-length'] ?? 0)
  if (declared > max) {
    res.destroy()
    throw new Error(tMain('mainStreaming.client.tooMuchData'))
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res) {
    size += (chunk as Buffer).length
    if (size > max) {
      res.destroy()
      throw new Error(tMain('mainStreaming.client.tooMuchData'))
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function errorFrom(res: IncomingMessage): Promise<HostRequestError> {
  let code = 'error'
  let message: string | undefined
  try {
    const body = JSON.parse((await readBody(res, 64 * 1024)).toString('utf8')) as {
      error?: unknown
      message?: unknown
    }
    if (typeof body.error === 'string') code = body.error
    if (typeof body.message === 'string') message = body.message
  } catch {
    /* not JSON: the status says enough */
  }
  return new HostRequestError(res.statusCode ?? 0, code, message)
}

async function json<T>(
  agent: PinnedAgent,
  address: string,
  port: number,
  path: string,
  options: CallOptions
): Promise<T> {
  const res = await send(agent, address, port, path, options)
  if ((res.statusCode ?? 0) >= 400) throw await errorFrom(res)
  const body = await readBody(res, options.maxBytes ?? MAX_JSON_BYTES)
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw new Error(tMain('mainStreaming.client.unreadable'))
  }
}

export function createHostClient(deps: HostClientDeps = {}): HostClient {
  const timeoutMs = deps.timeoutMs ?? 15_000

  const probe: HostClient['probe'] = async (address, port) => {
    const agent = new PinnedAgent(null)
    try {
      const info = await json<HostInfo>(agent, address, port, '/v1/info', { timeoutMs })
      if (!agent.seen) throw new Error(tMain('mainStreaming.client.noCertificate'))
      return { info, fingerprint: agent.seen }
    } finally {
      agent.destroy()
    }
  }

  const connect: HostClient['connect'] = ({ address, port, fingerprint, token }) => {
    const call = async <T>(path: string, options: CallOptions = {}): Promise<T> => {
      const agent = new PinnedAgent(fingerprint)
      try {
        return await json<T>(agent, address, port, path, { timeoutMs, token, ...options })
      } finally {
        agent.destroy()
      }
    }
    const id = encodeURIComponent

    /** One ROM file (or its rest) through `agent`. */
    const download = async (
      agent: PinnedAgent,
      gameId: string,
      path: string,
      dest: string,
      options: DownloadOptions
    ): Promise<void> => {
      const from = options.from ?? 0
      const res = await send(agent, address, port, `/v1/rom/${id(gameId)}/file?path=${id(path)}`, {
        token,
        timeoutMs,
        signal: options.signal,
        headers: from > 0 ? { Range: `bytes=${from}-` } : {}
      })
      // Asking for the bytes after the end: the file is already complete.
      if (res.statusCode === 416 && from > 0) {
        res.resume()
        return
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) throw await errorFrom(res)
      if (options.strictRange && from > 0 && res.statusCode !== 206) {
        res.destroy()
        throw new Error(tMain('mainStreaming.client.wholeFile'))
      }
      // A 200 to a ranged request is the whole file: start the destination over rather than append a copy.
      const append = from > 0 && res.statusCode === 206
      const out = createWriteStream(dest, { flags: append ? 'a' : 'w' })
      if (options.onBytes) {
        const report = options.onBytes
        res.on('data', (chunk: Buffer) => report(chunk.length))
      }
      try {
        await pipeline(res, out, { signal: options.signal })
      } catch (err) {
        // A connection cut off mid-file must not go back to a kept-alive pool.
        res.destroy()
        res.socket?.destroy()
        throw err
      }
    }

    return {
      info: () => call<HostInfo>('/v1/info'),
      library: async () => (await call<{ games: unknown[] }>('/v1/library')).games ?? [],
      libraryAt: async () => {
        const res = await call<{ games: unknown[]; now?: unknown }>('/v1/library')
        return { games: res.games ?? [], now: res.now }
      },
      scan: async () => {
        await call('/v1/scan', { method: 'POST', body: {} })
      },
      scanRunning: async () => (await call<{ running?: boolean }>('/v1/scan')).running === true,
      async media(gameId, kind) {
        const agent = new PinnedAgent(fingerprint)
        try {
          const res = await send(agent, address, port, `/v1/media/${id(gameId)}/${id(kind)}`, {
            token,
            timeoutMs
          })
          if (res.statusCode === 404) {
            res.resume()
            return null
          }
          if ((res.statusCode ?? 0) >= 400) throw await errorFrom(res)
          const type = String(res.headers['content-type'] ?? 'application/octet-stream')
          return { data: await readBody(res, MAX_MEDIA_BYTES), type }
        } finally {
          agent.destroy()
        }
      },
      // ?with=ps3-hdd,textures,updates-dlc: this PlayOut puts a PS3 game's updates and DLC in its own PS3 HDD, a game's
      // texture packs in its own texturepacks, and a Switch / Xbox 360 game's updates and DLC in its own Updates and DLC
      // (an older host ignores what it does not know).
      romFiles: (gameId) =>
        call<RomFileList>(`/v1/rom/${id(gameId)}/files?with=ps3-hdd,textures,updates-dlc`),
      async downloadFile(gameId, path, dest, options = {}) {
        const agent = new PinnedAgent(fingerprint)
        try {
          await download(agent, gameId, path, dest, options)
        } finally {
          agent.destroy()
        }
      },
      downloadSession() {
        const agent = new PinnedAgent(fingerprint, { maxSockets: SESSION_SOCKETS })
        let closed = false
        return {
          downloadFile: async (gameId, path, dest, options = {}) => {
            if (closed) throw new Error(tMain('mainStreaming.client.sessionClosed'))
            await download(agent, gameId, path, dest, options)
          },
          connectionsOpened: () => agent.opened,
          close: () => {
            closed = true
            agent.destroy()
          }
        }
      },
      prepareStream: async (gameId) => {
        const res = await call<{ app: string; sunshinePort: number; warning?: unknown }>(
          '/v1/stream/prepare',
          { method: 'POST', body: { gameId } }
        )
        const out = { app: res.app, sunshinePort: res.sunshinePort }
        return typeof res.warning === 'string' && res.warning
          ? { ...out, warning: res.warning.slice(0, 300) }
          : out
      },
      stopStream: async () => {
        await call('/v1/stream/stop', { method: 'POST', body: {} })
      },
      logins: async () => {
        try {
          return (await call<{ logins?: unknown }>('/v1/logins')).logins ?? null
        } catch (err) {
          // 403: sharing is off; 404: an older host.
          if (err instanceof HostRequestError && (err.status === 403 || err.status === 404))
            return null
          throw err
        }
      },
      libraryTabs: async (doc, now) => {
        try {
          const res = await call<{ doc?: unknown; now?: unknown }>('/v1/library-tabs', {
            method: 'POST',
            body: { doc, now }
          })
          return { doc: res?.doc ?? null, now: res?.now }
        } catch (err) {
          // 403: the host's sync is off; 404: an older host (or this PC is its host).
          if (err instanceof HostRequestError && (err.status === 403 || err.status === 404))
            return null
          throw err
        }
      },
      favorites: async (entries, now) => {
        try {
          const res = await call<{ entries?: unknown; now?: unknown }>('/v1/favorites', {
            method: 'POST',
            body: { entries, now }
          })
          return { entries: res?.entries ?? null, now: res?.now }
        } catch (err) {
          // 403: the host's sync is off; 404: an older host (or this PC is its host).
          if (err instanceof HostRequestError && (err.status === 403 || err.status === 404))
            return null
          throw err
        }
      },
      playtime: async (request) => {
        try {
          const res = await call<{
            took?: unknown
            sessions?: unknown
            next?: unknown
            more?: unknown
            now?: unknown
            recent?: unknown
          }>('/v1/playtime', { method: 'POST', body: request })
          return {
            took: res?.took,
            sessions: res?.sessions ?? null,
            next: res?.next ?? null,
            more: res?.more,
            now: res?.now,
            recent: res?.recent
          }
        } catch (err) {
          // 403: the host's sync is off; 404: an older host (or this PC is its host).
          if (err instanceof HostRequestError && (err.status === 403 || err.status === 404))
            return null
          throw err
        }
      },
      achievements: async (gameId) => {
        try {
          const res = await call<{ info?: unknown }>(
            `/v1/achievements/${encodeURIComponent(gameId)}`,
            // The host may read the list from Steam / RetroAchievements first.
            { maxBytes: MAX_ACHIEVEMENTS_BODY_BYTES, timeoutMs: Math.max(timeoutMs, 30_000) }
          )
          return res?.info ?? null
        } catch (err) {
          // 404: an older host.
          if (err instanceof HostRequestError && err.status === 404) return null
          throw err
        }
      },
      streamStatus: async () => {
        const status = await call<StreamStatus>('/v1/stream/status', {
          timeoutMs: Math.min(timeoutMs, STREAM_STATUS_TIMEOUT_MS)
        })
        const e = status?.lastError
        return e && typeof e.gameId === 'string' && typeof e.message === 'string'
          ? { lastError: { gameId: e.gameId, message: e.message.slice(0, 500) } }
          : {}
      },
      moonlightPair: (pin) =>
        call<{ ok: boolean; error?: string }>('/v1/moonlight/pair', {
          method: 'POST',
          body: pin === undefined ? {} : { pin },
          timeoutMs: MOONLIGHT_PAIR_TIMEOUT_MS
        }),
      unpair: async () => {
        await call('/v1/unpair', { method: 'POST', body: {} })
      },
      emulation: {
        // A large folder takes the host a while to hash the first time.
        manifest: (signal) =>
          call('/v1/emulation/manifest', { timeoutMs: EMULATION_MANIFEST_TIMEOUT_MS, signal }),
        async download(path, dest, signal) {
          const agent = new PinnedAgent(fingerprint)
          try {
            const res = await send(agent, address, port, `/v1/emulation/file?path=${id(path)}`, {
              token,
              timeoutMs,
              signal
            })
            if (res.statusCode !== 200) throw await errorFrom(res)
            await pipeline(res, createWriteStream(dest), { signal })
          } finally {
            agent.destroy()
          }
        },
        uploadChunk: async (uploadId, offset, total, data, signal) => {
          await call(`/v1/emulation/upload?id=${id(uploadId)}&offset=${offset}&total=${total}`, {
            method: 'PUT',
            raw: data,
            signal
          })
        },
        commit: async (commit, signal) => {
          // The host checks the whole file before it takes it.
          await call('/v1/emulation/commit', {
            method: 'POST',
            body: commit,
            timeoutMs: EMULATION_MANIFEST_TIMEOUT_MS,
            signal
          })
        },
        remove: async (request, signal) => {
          // The host checks the file before it moves it to its backups (another drive, maybe).
          await call('/v1/emulation/delete', {
            method: 'POST',
            body: request,
            timeoutMs: EMULATION_MANIFEST_TIMEOUT_MS,
            signal
          })
        }
      }
    }
  }

  const pair: HostClient['pair'] = async (address, port, pin, clientId, clientName) => {
    const seen = await probe(address, port)
    if (!sameFingerprint(seen.info.fingerprint, seen.fingerprint)) {
      // The host names its own certificate in /v1/info; a different one on the wire is something in between.
      throw new CertificateMismatchError(seen.fingerprint)
    }
    const proof = pairingProof(pin, seen.fingerprint, clientId)
    // Pinned to the certificate the proof was made for, so it cannot be swapped between probe and pair.
    const agent = new PinnedAgent(seen.fingerprint)
    try {
      const res = await json<Omit<PairResponse, 'fingerprint'>>(agent, address, port, '/v1/pair', {
        method: 'POST',
        body: { clientId, clientName, proof },
        timeoutMs
      })
      if (!res.token || !res.hostId) throw new Error(tMain('mainStreaming.client.unreadable'))
      return { ...res, fingerprint: seen.fingerprint }
    } finally {
      agent.destroy()
    }
  }

  return { probe, pair, connect }
}
