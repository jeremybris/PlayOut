import { createReadStream, promises as fs } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import { createServer, type Server } from 'https'
import { extname } from 'path'
import type { Socket } from 'net'
import { pipeline } from 'stream/promises'
import type { Logger } from '../logger'
import type { EmulationCommit, EmulationDelete, EmulationManifest } from './emulation-sync/types'
import { UPLOAD_CHUNK_BYTES } from './emulation-sync/types'
import { MAX_FAVORITES_BODY_BYTES } from './favorites-sync'
import { isMoonlightPin } from './pairing'
import { MAX_PLAYTIME_BODY_BYTES } from './playtime-sync'
import { MAX_TABS_DOC_BYTES } from './library-tabs-sync'

/**
 * PlayOut's host service: a small JSON API over HTTPS that paired PlayOut computers use for the library, art, ROM
 * downloads and to start a stream. Only /v1/info and /v1/pair answer without a token; everything else needs the
 * bearer token the client got when it paired. The server knows nothing about games or pairing itself: the streaming
 * service supplies `auth` and the handlers, so this file stays about HTTP, limits and errors.
 */

/** A paired client, as `auth` resolves it from a bearer token. */
export interface ClientRecord {
  id: string
  name: string
}

export interface HostInfo {
  id: string
  name: string
  version: string
  fingerprint: string
  externalIp?: string
}

/** 'is-host': the caller is this PC's own host (the library goes host to client only, never both ways). */
export type PairError = 'wrong-pin' | 'expired' | 'locked' | 'not-pairing' | 'is-host'

export type PairResult =
  | { ok: true; hostId: string; hostName: string; token: string; externalIp?: string }
  | { ok: false; error: PairError }

export interface RomFileList {
  /** Paths relative to the host's ROM root, forward slashes. */
  /** `mtimeMs`: set on files that change in place (a PS3 game's updates): the client replaces a copy of another time. */
  files: { path: string; size: number; mtimeMs?: number }[]
  totalBytes: number
}

export type PrepareResult =
  /** `warning`: why a stream to the caller's network may fail (the host's stream ports are not forwarded). */
  | { ok: true; sunshinePort: number; warning?: string }
  | { ok: false; error: 'busy' | 'not-installed' | 'sunshine'; message: string }

/**
 * What the host knows about the caller's last stream start. `lastError` is a launch failure from the last couple of
 * minutes (the game could not start when Sunshine ran it); it is reported once, reading it clears it.
 */
export interface StreamStatus {
  lastError?: { gameId: string; message: string }
}

/** Media for one game: bytes in memory or a file on disk. `type` defaults from the file extension. */
export type MediaResult = { data: Buffer; type: string } | { file: string; type?: string }

/** Who is calling: the paired client and the address it connected from. */
export interface RequestContext {
  client: ClientRecord
  address: string
}

export interface HostHandlers {
  info(): HostInfo
  pair(request: {
    clientId: string
    clientName: string
    proof: string
    address: string
  }): Promise<PairResult>
  /** The games this host offers (HostGame from remote-library.ts); passed through as JSON. */
  library(ctx: RequestContext): Promise<unknown[]>
  /** Rescan this host's library for the caller (its Scan); answers at once, the scan runs on. */
  scan(ctx: RequestContext): Promise<void>
  /** Whether this host's library scan is still running. */
  scanStatus(ctx: RequestContext): Promise<{ running: boolean }>
  media(ctx: RequestContext, gameId: string, kind: MediaKindParam): Promise<MediaResult | null>
  /**
   * `ps3Hdd`: the client takes a PS3 game's PS3 HDD files ('PS3 HDD/...', sent with `?with=ps3-hdd` by PlayOut
   * 0.1.109 and later); an older client is not sent them, as it would store them where its RPCS3 never looks.
   * `textures`: the client takes a game's texture packs ('Texture Packs/...', `?with=textures`, PlayOut 0.1.134 and
   * later); an older client would put them inside its ROM folder, so it is not sent them either.
   */
  romFiles(
    ctx: RequestContext,
    gameId: string,
    options?: { ps3Hdd?: boolean; textures?: boolean }
  ): Promise<RomFileList | null>
  /** Absolute path of one file of the game's ROM set, or null when `path` is not one of its files. */
  romFile(ctx: RequestContext, gameId: string, path: string): Promise<string | null>
  prepareStream(ctx: RequestContext, gameId: string): Promise<PrepareResult>
  stopStream(ctx: RequestContext): Promise<void>
  /** The caller's recent launch failure, if any; reading it clears it. */
  streamStatus(ctx: RequestContext): Promise<StreamStatus>
  /**
   * This PC's metadata and RetroAchievements logins for the paired caller (host-logins.ts); null while sharing them is
   * off (Settings › Streaming) or for a PC that is this PC's own host.
   */
  logins(ctx: RequestContext): unknown
  /**
   * The Library tabs sync (library-tabs-sync.ts): `body` is the caller's `{ doc, now }` (unchecked); the answer is
   * this PC's copy after taking the caller's when newer, with this PC's clock. Null while the sync is off here, or for
   * a PC that is this PC's own host.
   */
  libraryTabs?(
    ctx: RequestContext,
    body: Record<string, unknown>
  ): { doc: unknown; now: number } | null
  /**
   * The favourites sync (favorites-sync.ts): `body` is the caller's `{ entries, now }` (unchecked: its proposed
   * favourites by this PC's offered ids); the answer is every favourite (or changed) game this PC offers after taking
   * the caller's newer ones, with this PC's clock. Null while the sync is off here, or for a PC that is this PC's own
   * host. Absent: 404 (as an older PlayOut).
   */
  favorites?(
    ctx: RequestContext,
    body: Record<string, unknown>
  ): { entries: unknown[]; now: number } | null
  /**
   * The play time sync (playtime-sync.ts): `body` is the caller's `{ sessions, games, after, recent, now }` (unchecked: its
   * sessions of games this PC offers, and which of this PC's sessions it asks for). The answer: how many of the caller's
   * sessions were new here, a page of this PC's sessions of those games after the cursor, the next cursor, whether more
   * are left, and this PC's clock; to a caller that sent `recent` (recency-relay.ts), the other PCs' last played of
   * the store games this PC does not offer that it names (`want`, and those in `recent`). Null while the sync is off here, or for a PC that is this PC's own host.
   * Absent: 404 (as an older PlayOut).
   */
  playtime?(
    ctx: RequestContext,
    body: Record<string, unknown>
  ): {
    took: number
    sessions: unknown[]
    next: unknown
    more: boolean
    now: number
    recent?: unknown[]
  } | null
  /**
   * A game's achievements list as this PC's achievements service has it (AchievementsInfo, host-achievements.ts), by
   * its offered id: for a client showing the game as a host-only one. Null when there is none (no such offered game, no
   * account, no achievements) or for a PC that is this PC's own host. Absent: 404 (as an older PlayOut).
   */
  achievements?(ctx: RequestContext, gameId: string): Promise<unknown>
  /** Approve the caller's Moonlight pairing on Sunshine (may wait up to 90 s). */
  moonlightPair(
    ctx: RequestContext,
    pin: string | undefined
  ): Promise<{ ok: boolean; error?: string }>
  unpair(ctx: RequestContext): Promise<void>
  /**
   * The Emulation folder sync (emulation-sync/). Handlers refuse with an error named 'SyncRefused' carrying
   * `status` and `code` (sync turned off, a game running, the file changed meanwhile).
   */
  emulationManifest(ctx: RequestContext): Promise<EmulationManifest>
  /** Absolute path of a file of the Emulation folder the caller may download, or null. */
  emulationFile(ctx: RequestContext, path: string): Promise<string | null>
  emulationUpload(
    ctx: RequestContext,
    upload: { id: string; offset: number; total: number; data: Buffer }
  ): Promise<void>
  emulationCommit(ctx: RequestContext, commit: EmulationCommit): Promise<void>
  emulationDelete(ctx: RequestContext, request: EmulationDelete): Promise<void>
}

export type MediaKindParam = 'cover' | 'hero' | 'logo' | 'icon' | `screenshot${number}`

export interface HostServerDeps {
  tls: { key: string; cert: string }
  /** 0 picks a free port (tests); `port` then reports the real one after listen(). */
  port: number
  /** Address to listen on (default all interfaces). */
  host?: string
  log: Logger
  auth: (token: string) => ClientRecord | null
  handlers: HostHandlers
  /** Clock (ms), for tests. */
  now?: () => number
}

export interface HostServer {
  listen(): Promise<void>
  close(): Promise<void>
  readonly port: number
  /**
   * Files a client is downloading (ROMs, Emulation folder files), as served: open now, or sent within RECENT_SEND_MS
   * (a game's files come one request after another, and a download may pause between them).
   */
  filesBeingSent?(): string[]
}

export const MAX_BODY_BYTES = 64 * 1024
/** A file sent this recently still counts as being sent (filesBeingSent): the rest of its set may follow. */
export const RECENT_SEND_MS = 15 * 60_000
/** POST /v1/library-tabs: a Library tabs copy (MAX_TABS_DOC_BYTES) and its envelope. */
const MAX_TABS_BODY_BYTES = MAX_TABS_DOC_BYTES + 4096
export const MAX_FILE_STREAMS_PER_CLIENT = 4
/**
 * Files a client's game download fetches at once: one stream short of the limit, so Emulation sync (which shares it)
 * still gets a turn while a texture pack's small files come in.
 */
export const ROM_DOWNLOAD_STREAMS = MAX_FILE_STREAMS_PER_CLIENT - 1
/** Socket inactivity limit: above the 90 s a Moonlight pairing approval may take. */
const SOCKET_TIMEOUT_MS = 120_000
const HEADERS_TIMEOUT_MS = 15_000
/** Emulation folder sync answers that hash files first (an authenticated client only). */
const EMULATION_SLOW_MS = 30 * 60_000
/**
 * Connection caps. With UPnP on, the port is open to the internet and every connection costs an RSA handshake and
 * memory before anyone has shown a token. A few paired clients with four downloads each plus JSON calls stay far
 * below these.
 */
export const MAX_CONNECTIONS = 64
export const MAX_CONNECTIONS_PER_ADDRESS = 16
const MEDIA_KIND = /^(cover|hero|logo|icon|screenshot[0-9])$/

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** The connection is closed once this answer is sent: the rest of the request is not read. */
    readonly closes = false
  ) {
    super(message ?? code)
  }
}

export function createHostServer(deps: HostServerDeps): HostServer {
  const { log, handlers } = deps
  const fileStreams = new Map<string, number>()
  /** Files being sent to a client now, with how many downloads of each are open. */
  const sending = new Map<string, number>()
  /** When each file last finished sending (filesBeingSent counts it for RECENT_SEND_MS more). */
  const lastSent = new Map<string, number>()
  const clock = deps.now ?? Date.now
  const sockets = new Set<Socket>()
  /** Open connections per remote address, for MAX_CONNECTIONS_PER_ADDRESS. */
  const perAddress = new Map<string, number>()
  let boundPort = deps.port
  let server: Server | null = null

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const address = remoteAddress(req)
    const url = new URL(req.url ?? '/', 'https://host')
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((p) => {
        try {
          return decodeURIComponent(p)
        } catch {
          throw new HttpError(400, 'bad-path')
        }
      })
    if (parts[0] !== 'v1') throw new HttpError(404, 'not-found')
    const route = parts.slice(1)
    const method = req.method ?? 'GET'

    if (method === 'GET' && route.length === 1 && route[0] === 'info') {
      return sendJson(res, 200, handlers.info())
    }
    if (method === 'POST' && route.length === 1 && route[0] === 'pair') {
      const body = await readJson(req)
      const clientId = str(body.clientId, 128)
      const clientName = str(body.clientName, 128)
      const proof = str(body.proof, 128)
      if (!clientId || !clientName || !proof) throw new HttpError(400, 'bad-request')
      const result = await handlers.pair({ clientId, clientName, proof, address })
      if (!result.ok) {
        log.warn(`pairing refused for ${clientName} (${address}): ${result.error}`)
        return sendJson(res, 403, { error: result.error })
      }
      log.info(`paired with ${clientName} (${address})`)
      const { hostId, hostName, token, externalIp } = result
      return sendJson(res, 200, { hostId, hostName, token, externalIp })
    }

    const client = authenticate(req)
    const ctx: RequestContext = { client, address }

    if (method === 'GET' && route.length === 1 && route[0] === 'library') {
      // `now`: this host's clock, so a client can date the games' last played on its own (an older client ignores it).
      return sendJson(res, 200, { games: await handlers.library(ctx), now: clock() })
    }
    if (route.length === 1 && route[0] === 'scan') {
      if (method === 'POST') {
        await handlers.scan(ctx)
        return sendJson(res, 202, await handlers.scanStatus(ctx))
      }
      if (method === 'GET') return sendJson(res, 200, await handlers.scanStatus(ctx))
    }
    if (method === 'GET' && route.length === 3 && route[0] === 'media') {
      const [, gameId, kind] = route
      if (!MEDIA_KIND.test(kind)) throw new HttpError(404, 'not-found')
      const media = await handlers.media(ctx, gameId, kind as MediaKindParam)
      if (!media) throw new HttpError(404, 'not-found')
      if ('data' in media) {
        res.writeHead(200, {
          'Content-Type': media.type,
          'Content-Length': media.data.length,
          'Cache-Control': 'no-cache'
        })
        res.end(media.data)
        return
      }
      const type =
        media.type ?? MIME[extname(media.file).toLowerCase()] ?? 'application/octet-stream'
      return sendFile(req, res, media.file, type, null)
    }
    if (method === 'GET' && route.length === 3 && route[0] === 'rom' && route[2] === 'files') {
      const takes = (url.searchParams.get('with') ?? '').split(',')
      const list = await handlers.romFiles(ctx, route[1], {
        ps3Hdd: takes.includes('ps3-hdd'),
        textures: takes.includes('textures')
      })
      if (!list) throw new HttpError(404, 'not-found')
      return sendJson(res, 200, list)
    }
    if (method === 'GET' && route.length === 3 && route[0] === 'rom' && route[2] === 'file') {
      const path = url.searchParams.get('path')
      if (!path) throw new HttpError(400, 'bad-request')
      const file = await handlers.romFile(ctx, route[1], path)
      if (!file) throw new HttpError(404, 'not-found')
      return sendFile(req, res, file, 'application/octet-stream', client.id)
    }
    if (method === 'GET' && route.length === 1 && route[0] === 'logins') {
      const logins = handlers.logins(ctx)
      if (!logins) throw new HttpError(403, 'logins-off')
      return sendJson(res, 200, { logins })
    }
    if (method === 'POST' && route.length === 1 && route[0] === 'library-tabs') {
      if (!handlers.libraryTabs) throw new HttpError(404, 'not-found')
      const body = await readJson(req, MAX_TABS_BODY_BYTES)
      const answer = handlers.libraryTabs(ctx, body)
      if (!answer) throw new HttpError(403, 'tabs-sync-off')
      return sendJson(res, 200, answer)
    }
    if (method === 'POST' && route.length === 1 && route[0] === 'favorites') {
      if (!handlers.favorites) throw new HttpError(404, 'not-found')
      const body = await readJson(req, MAX_FAVORITES_BODY_BYTES)
      const answer = handlers.favorites(ctx, body)
      if (!answer) throw new HttpError(403, 'favorites-sync-off')
      return sendJson(res, 200, answer)
    }
    if (method === 'POST' && route.length === 1 && route[0] === 'playtime') {
      if (!handlers.playtime) throw new HttpError(404, 'not-found')
      const body = await readJson(req, MAX_PLAYTIME_BODY_BYTES)
      const answer = handlers.playtime(ctx, body)
      if (!answer) throw new HttpError(403, 'playtime-sync-off')
      return sendJson(res, 200, answer)
    }
    if (method === 'GET' && route.length === 2 && route[0] === 'achievements') {
      if (!handlers.achievements) throw new HttpError(404, 'not-found')
      return sendJson(res, 200, { info: (await handlers.achievements(ctx, route[1])) ?? null })
    }
    if (method === 'GET' && route.length === 2 && route[0] === 'stream' && route[1] === 'status') {
      return sendJson(res, 200, await handlers.streamStatus(ctx))
    }
    if (method === 'POST' && route.length === 2 && route[0] === 'stream') {
      const body = await readJson(req)
      if (route[1] === 'prepare') {
        const gameId = str(body.gameId, 512)
        if (!gameId) throw new HttpError(400, 'bad-request')
        const result = await handlers.prepareStream(ctx, gameId)
        if (!result.ok) return sendJson(res, 409, { error: result.error, message: result.message })
        return sendJson(res, 200, {
          app: 'PlayOut',
          sunshinePort: result.sunshinePort,
          ...(result.warning ? { warning: result.warning } : {})
        })
      }
      if (route[1] === 'stop') {
        await handlers.stopStream(ctx)
        return sendJson(res, 200, {})
      }
    }
    if (
      method === 'POST' &&
      route.length === 2 &&
      route[0] === 'moonlight' &&
      route[1] === 'pair'
    ) {
      const body = await readJson(req)
      const pin = body.pin === undefined ? undefined : str(body.pin, 16)
      if (pin === null || (pin !== undefined && !isMoonlightPin(pin))) {
        throw new HttpError(400, 'bad-request')
      }
      return sendJson(res, 200, await handlers.moonlightPair(ctx, pin))
    }
    if (route.length === 2 && route[0] === 'emulation') {
      const what = route[1]
      if (method === 'GET' && what === 'manifest') {
        // Hashing a large folder the first time is quiet for minutes: the idle limit would drop the connection.
        req.socket.setTimeout(EMULATION_SLOW_MS)
        return sendJson(res, 200, await handlers.emulationManifest(ctx))
      }
      if (method === 'GET' && what === 'file') {
        const path = url.searchParams.get('path')
        if (!path) throw new HttpError(400, 'bad-request')
        const file = await handlers.emulationFile(ctx, path)
        if (!file) throw new HttpError(404, 'not-found')
        return sendFile(req, res, file, 'application/octet-stream', client.id)
      }
      if (method === 'PUT' && what === 'upload') {
        const id = url.searchParams.get('id') ?? ''
        const offset = Number(url.searchParams.get('offset'))
        const total = Number(url.searchParams.get('total'))
        const data = await readRaw(req, UPLOAD_CHUNK_BYTES)
        await handlers.emulationUpload(ctx, { id, offset, total, data })
        return sendJson(res, 200, {})
      }
      if (method === 'POST' && what === 'commit') {
        const body = await readJson(req)
        // The host checks the whole uploaded file before taking it.
        req.socket.setTimeout(EMULATION_SLOW_MS)
        const id = str(body.id, 64)
        const path = str(body.path, 1024)
        const hash = str(body.hash, 64)
        const size = body.size
        const mtimeMs = body.mtimeMs
        const expect = body.expect === null ? null : str(body.expect, 64)
        if (
          !id ||
          !path ||
          !hash ||
          (body.expect !== null && !expect) ||
          typeof size !== 'number' ||
          !Number.isSafeInteger(size) ||
          typeof mtimeMs !== 'number' ||
          !Number.isFinite(mtimeMs)
        )
          throw new HttpError(400, 'bad-request')
        await handlers.emulationCommit(ctx, {
          id,
          path,
          hash,
          size,
          mtimeMs,
          expect,
          ...(body.backup === true ? { backup: true } : {})
        })
        return sendJson(res, 200, {})
      }
      if (method === 'POST' && what === 'delete') {
        const body = await readJson(req)
        req.socket.setTimeout(EMULATION_SLOW_MS)
        const path = str(body.path, 1024)
        const expect = str(body.expect, 64)
        if (!path || !expect) throw new HttpError(400, 'bad-request')
        await handlers.emulationDelete(ctx, { path, expect })
        return sendJson(res, 200, {})
      }
    }
    if (method === 'POST' && route.length === 1 && route[0] === 'unpair') {
      await readJson(req)
      await handlers.unpair(ctx)
      log.info(`${client.name} (${address}) unpaired itself`)
      return sendJson(res, 200, {})
    }
    throw new HttpError(404, 'not-found')
  }

  const authenticate = (req: IncomingMessage): ClientRecord => {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(header)
    const client = match ? deps.auth(match[1]) : null
    if (!client) throw new HttpError(401, 'unauthorized')
    return client
  }

  const sendFile = async (
    req: IncomingMessage,
    res: ServerResponse,
    file: string,
    type: string,
    limitClient: string | null
  ): Promise<void> => {
    const st = await fs.stat(file).catch(() => null)
    if (!st || !st.isFile()) throw new HttpError(404, 'not-found')
    const size = st.size
    let start = 0
    let end = size - 1
    let partial = false
    const range = req.headers.range
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
      if (!m) throw new HttpError(416, 'bad-range')
      start = Number(m[1])
      if (m[2]) end = Math.min(Number(m[2]), size - 1)
      if (!Number.isSafeInteger(start) || start >= size || end < start) {
        res.writeHead(416, {
          'Content-Range': `bytes */${size}`,
          'Content-Type': 'application/json'
        })
        res.end(JSON.stringify({ error: 'bad-range' }))
        return
      }
      partial = true
    }
    if (limitClient !== null) {
      const open = fileStreams.get(limitClient) ?? 0
      if (open >= MAX_FILE_STREAMS_PER_CLIENT) throw new HttpError(429, 'too-many-downloads')
      fileStreams.set(limitClient, open + 1)
    }
    if (limitClient !== null) sending.set(file, (sending.get(file) ?? 0) + 1)
    try {
      const length = size === 0 ? 0 : end - start + 1
      const headers: Record<string, string | number> = {
        'Content-Type': type,
        'Content-Length': length,
        'Accept-Ranges': 'bytes'
      }
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      res.writeHead(partial ? 206 : 200, headers)
      if (length === 0) {
        res.end()
        return
      }
      await pipeline(createReadStream(file, { start, end }), res)
    } catch (e) {
      // A client that goes away mid-download is normal (cancel, sleep); nothing to report.
      if (!res.headersSent) throw e
      res.destroy()
    } finally {
      if (limitClient !== null) {
        const left = (sending.get(file) ?? 1) - 1
        if (left > 0) sending.set(file, left)
        else sending.delete(file)
        lastSent.set(file, clock())
        const open = (fileStreams.get(limitClient) ?? 1) - 1
        if (open > 0) fileStreams.set(limitClient, open)
        else fileStreams.delete(limitClient)
      }
    }
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        if (e.status >= 500) log.warn(`${req.method} ${req.url}: ${e.message}`)
        // Without this the connection stays open and Node goes on reading the body it was just refused for.
        if (e.closes && !res.headersSent) res.setHeader('Connection', 'close')
        sendJson(res, e.status, { error: e.code })
        return
      }
      const refused = e as { name?: string; status?: unknown; code?: unknown; message?: string }
      if (
        refused?.name === 'SyncRefused' &&
        typeof refused.status === 'number' &&
        typeof refused.code === 'string'
      ) {
        // Reading the rest of a refused upload lets the answer reach the client.
        req.resume()
        sendJson(res, refused.status, {
          error: refused.code,
          ...(refused.message && refused.message !== refused.code
            ? { message: refused.message }
            : {})
        })
        return
      }
      log.error(`${req.method} ${req.url?.split('?')[0]} failed:`, e)
      sendJson(res, 500, { error: 'internal' })
    })
  }

  return {
    get port() {
      return boundPort
    },
    filesBeingSent: () => {
      const since = clock() - RECENT_SEND_MS
      for (const [file, at] of lastSent) if (at < since) lastSent.delete(file)
      return [...new Set([...sending.keys(), ...lastSent.keys()])]
    },
    listen() {
      if (server) return Promise.resolve()
      const s = createServer(
        {
          key: deps.tls.key,
          cert: deps.tls.cert,
          minVersion: 'TLSv1.2',
          // The default is 120 s per handshake, which lets a silent peer hold a connection slot that long.
          handshakeTimeout: HEADERS_TIMEOUT_MS
        },
        onRequest
      )
      s.headersTimeout = HEADERS_TIMEOUT_MS
      // Receiving a request (at most 64 KB of body) never needs long; a slow sender must not hold a slot for minutes.
      // Node counts only the request here, not the answer, so ROM downloads and the 90 s Moonlight approval are fine.
      s.requestTimeout = HEADERS_TIMEOUT_MS
      s.keepAliveTimeout = 5_000
      s.maxHeadersCount = 50
      s.maxConnections = MAX_CONNECTIONS
      s.setTimeout(SOCKET_TIMEOUT_MS, (socket) => socket.destroy())
      s.on('connection', (socket: Socket) => {
        const from = socket.remoteAddress ?? ''
        const open = perAddress.get(from) ?? 0
        if (open >= MAX_CONNECTIONS_PER_ADDRESS) {
          socket.destroy()
          return
        }
        perAddress.set(from, open + 1)
        sockets.add(socket)
        socket.on('close', () => {
          sockets.delete(socket)
          const left = (perAddress.get(from) ?? 1) - 1
          if (left > 0) perAddress.set(from, left)
          else perAddress.delete(from)
        })
      })
      // Port scans, wrong protocols and clients that drop the handshake: not worth a log line each.
      s.on('tlsClientError', () => undefined)
      s.on('clientError', (_err, socket) => socket.destroy())
      return new Promise<void>((resolve, reject) => {
        const onStartError = (err: Error): void => {
          server = null
          reject(err)
        }
        s.once('error', onStartError)
        s.listen(deps.port, deps.host, () => {
          s.off('error', onStartError)
          // An 'error' with no listener would end the app (see index.ts); after start, log it instead.
          s.on('error', (err) => log.error('host server error:', err))
          const addr = s.address()
          if (addr && typeof addr === 'object') boundPort = addr.port
          log.info(`host service listening on port ${boundPort}`)
          resolve()
        })
        server = s
      })
    },
    close() {
      const s = server
      server = null
      if (!s) return Promise.resolve()
      return new Promise<void>((resolve) => {
        s.close(() => resolve())
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      })
    }
  }
}

function remoteAddress(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s && s.length <= max ? s : null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

/**
 * How much of a body over its cap is still read (and thrown away) before the refusal is sent. A 413 sent while the
 * caller is still writing its body closes the connection under it, and the caller then sees a broken connection
 * (ECONNRESET) instead of the refusal, depending on timing. Reading the rest first lets the 413 arrive. Bounded: a few
 * times the cap, never more than DISCARD_MAX_BYTES; a body longer than that is refused without being read to its end,
 * and the connection is closed with the answer (that caller may see the broken connection instead of the refusal).
 */
export const DISCARD_MAX_BYTES = 8 * 1024 * 1024
export function discardLimit(max: number): number {
  return Math.min(DISCARD_MAX_BYTES, max * 4 + 1024 * 1024)
}

/**
 * A request body of at most `max` bytes. Longer: nothing more is kept, the rest is read up to discardLimit(max) so the
 * caller gets the answer, and the request is refused with 413. Past discardLimit(max) the 413 closes the connection.
 */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  const limit = discardLimit(max)
  let tooLarge = declared > max
  // A declared length past what will be read: refused at once, and the connection closed so the rest is not read.
  if (declared > limit) throw new HttpError(413, 'too-large', undefined, true)
  const chunks: Buffer[] = []
  let size = 0
  let pastLimit = false
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > max) {
        tooLarge = true
        chunks.length = 0
        // Enough read: the answer closes the connection (HttpError.closes).
        if (size > limit) {
          pastLimit = true
          break
        }
        continue
      }
      if (!tooLarge) chunks.push(chunk as Buffer)
    }
  } catch (err) {
    // The caller went away while its too-long body was being thrown away: there is no one to answer.
    if (!tooLarge) throw err
  }
  if (tooLarge) throw new HttpError(413, 'too-large', undefined, pastLimit)
  return Buffer.concat(chunks)
}

/** A raw request body of at most `max` bytes (an upload piece). */
async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return readBody(req, max)
}

async function readJson(
  req: IncomingMessage,
  max = MAX_BODY_BYTES
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, max)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'bad-json')
  }
}
