import { promises as fs } from 'fs'
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket
} from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../logger'
import { CertificateMismatchError, createHostClient, HostRequestError } from './host-client'
import {
  createHostServer,
  RECENT_SEND_MS,
  MAX_CONNECTIONS_PER_ADDRESS,
  type ClientRecord,
  type HostHandlers,
  type HostServer,
  type RequestContext
} from './host-server'
import { createPinPairing, hashToken, newToken } from './pairing'
import { ensureHostCertificate, type HostCertificate } from './tls'

/**
 * A real host server and client over TLS on localhost: pairing with the PIN proof, the lockout, certificate pinning,
 * authenticated routes and ranged ROM downloads.
 */

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

interface Host {
  server: HostServer
  cert: HostCertificate
  pairing: ReturnType<typeof createPinPairing>
  clients: Map<string, { record: ClientRecord; hash: string }>
  auth: ReturnType<typeof vi.fn>
  clock: { t: number }
  romPath: string
  /** The options of each romFiles call. */
  romOptions: unknown[]
  /** Launch failures per client id, as /v1/stream/status reports them (once). */
  launchErrors: Map<string, { gameId: string; message: string }>
  /** What handlers.logins answers (null: sharing off); it may throw. */
  logins: { answer: () => unknown }
  /** What handlers.libraryTabs answers (null: the sync off); it may throw. */
  tabs: { answer: (ctx: RequestContext, body: Record<string, unknown>) => unknown }
  /** What handlers.favorites answers (null: the sync off); it may throw. */
  favorites: { answer: (ctx: RequestContext, body: Record<string, unknown>) => unknown }
  /** What handlers.playtime answers (null: the sync off); it may throw. */
  playtime: { answer: (ctx: RequestContext, body: Record<string, unknown>) => unknown }
  /** What handlers.achievements answers (null: none). */
  achievements: { answer: (ctx: RequestContext, gameId: string) => Promise<unknown> }
}

let root: string
let host: Host
let other: Host
const client = createHostClient({ timeoutMs: 5000 })

async function startHost(dir: string, romPath: string): Promise<Host> {
  const cert = await ensureHostCertificate(dir)
  const clock = { t: Date.now() }
  const pairing = createPinPairing({ now: () => clock.t })
  const clients = new Map<string, { record: ClientRecord; hash: string }>()
  const auth = vi.fn((token: string): ClientRecord | null => {
    const h = hashToken(token)
    for (const c of clients.values()) if (c.hash === h) return c.record
    return null
  })
  const launchErrors = new Map<string, { gameId: string; message: string }>()
  const logins: { answer: () => unknown } = { answer: () => null }
  const tabs: Host['tabs'] = { answer: () => null }
  const favorites: Host['favorites'] = { answer: () => null }
  const playtime: Host['playtime'] = { answer: () => null }
  const achievements: Host['achievements'] = { answer: async () => null }
  const romOptions: unknown[] = []
  const handlers: HostHandlers = {
    logins: () => logins.answer(),
    achievements: (ctx, gameId) => achievements.answer(ctx, gameId),
    libraryTabs: (ctx, body) => tabs.answer(ctx, body) as { doc: unknown; now: number } | null,
    favorites: (ctx, body) =>
      favorites.answer(ctx, body) as { entries: unknown[]; now: number } | null,
    playtime: (ctx, body) =>
      playtime.answer(ctx, body) as {
        took: number
        sessions: unknown[]
        next: unknown
        more: boolean
        now: number
      } | null,
    emulationManifest: async () => ({
      root: 'R',
      folderId: 'f',
      now: 0,
      files: [],
      unsettled: [],
      linked: [],
      excluded: []
    }),
    emulationFile: async () => null,
    emulationUpload: async () => {},
    emulationCommit: async () => {},
    emulationDelete: async () => {},
    scan: async () => {},
    scanStatus: async () => ({ running: false }),
    info: () => ({
      id: 'host-1',
      name: 'Living Room PC',
      version: '0.1.48',
      fingerprint: cert.fingerprint
    }),
    async pair({ clientId, clientName, proof, address }) {
      const result = pairing.verify(proof, cert.fingerprint, clientId, address)
      if (result !== 'ok') {
        const error = result === 'wrong' ? 'wrong-pin' : result === 'none' ? 'not-pairing' : result
        return { ok: false, error }
      }
      const token = newToken()
      clients.set(clientId, { record: { id: clientId, name: clientName }, hash: hashToken(token) })
      return { ok: true, hostId: 'host-1', hostName: 'Living Room PC', token }
    },
    library: async () => [{ id: 'steam:1', title: 'Portal' }],
    media: async (_ctx, gameId, kind) =>
      gameId === 'steam:1' && kind === 'cover'
        ? { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' }
        : null,
    romFiles: async (_ctx, gameId, options) =>
      romOptions.push(options) && gameId === 'rom:snes/Mario World'
        ? { files: [{ path: 'snes/Mario World.sfc', size: 4096 }], totalBytes: 4096 }
        : null,
    romFile: async (_ctx, gameId, path) =>
      gameId === 'rom:snes/Mario World' && path === 'snes/Mario World.sfc' ? romPath : null,
    prepareStream: async (_ctx, gameId) =>
      gameId === 'steam:1'
        ? { ok: true, sunshinePort: 47989 }
        : { ok: false, error: 'not-installed', message: 'Not installed on this PC' },
    stopStream: async () => {},
    streamStatus: async (ctx) => {
      const lastError = launchErrors.get(ctx.client.id)
      launchErrors.delete(ctx.client.id)
      return lastError ? { lastError } : {}
    },
    moonlightPair: async (_ctx, pin) => ({ ok: pin === pairing.lastPin() }),
    unpair: async (ctx) => {
      clients.delete(ctx.client.id)
    }
  }
  const server = createHostServer({
    tls: cert,
    port: 0,
    host: '127.0.0.1',
    log: quiet,
    auth,
    handlers,
    now: () => clock.t
  })
  await server.listen()
  return {
    server,
    cert,
    pairing,
    clients,
    auth,
    clock,
    romPath,
    romOptions,
    launchErrors,
    logins,
    tabs,
    favorites,
    achievements,
    playtime
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-channel-'))
  const romPath = join(root, 'mario.sfc')
  await fs.writeFile(romPath, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)))
  ;[host, other] = await Promise.all([
    startHost(join(root, 'a'), romPath),
    startHost(join(root, 'b'), romPath)
  ])
}, 60_000)

afterAll(async () => {
  await Promise.all([host?.server.close(), other?.server.close()])
  await fs.rm(root, { recursive: true, force: true })
})

describe('host channel', () => {
  let token = ''

  it('probes the host and sees its certificate', async () => {
    const { info, fingerprint } = await client.probe('127.0.0.1', host.server.port)
    expect(fingerprint).toBe(host.cert.fingerprint)
    expect(info).toMatchObject({ id: 'host-1', name: 'Living Room PC' })
    expect(info).not.toHaveProperty('pairingOpen')
  })

  it('refuses pairing when no PIN is shown', async () => {
    await expect(
      client.pair('127.0.0.1', host.server.port, '1234', 'client-1', 'Bedroom PC')
    ).rejects.toMatchObject({ status: 403, code: 'not-pairing' })
  })

  it('refuses a wrong PIN and pairs with the right one', async () => {
    const { pin } = host.pairing.start()
    const wrong = pin === '0000' ? '0001' : '0000'
    await expect(
      client.pair('127.0.0.1', host.server.port, wrong, 'client-1', 'Bedroom PC')
    ).rejects.toMatchObject({ status: 403, code: 'wrong-pin' })

    const paired = await client.pair('127.0.0.1', host.server.port, pin, 'client-1', 'Bedroom PC')
    expect(paired).toMatchObject({ hostId: 'host-1', hostName: 'Living Room PC' })
    expect(paired.fingerprint).toBe(host.cert.fingerprint)
    expect(paired.token.length).toBeGreaterThan(30)
    // Only the hash is kept on the host.
    expect(host.clients.get('client-1')?.hash).toBe(hashToken(paired.token))
    token = paired.token
  })

  it('serves the authenticated routes to the paired client only', async () => {
    const conn = client.connect({
      address: '127.0.0.1',
      port: host.server.port,
      fingerprint: host.cert.fingerprint,
      token
    })
    expect(await conn.library()).toEqual([{ id: 'steam:1', title: 'Portal' }])
    // The same offer with the host's clock (the games' last played are dated on it).
    const at = await conn.libraryAt!()
    expect(at.games).toEqual([{ id: 'steam:1', title: 'Portal' }])
    expect(at.now).toEqual(expect.any(Number))
    expect(await conn.media('steam:1', 'cover')).toEqual({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      type: 'image/png'
    })
    expect(await conn.media('steam:1', 'hero')).toBeNull()
    expect(await conn.prepareStream('steam:1')).toEqual({ app: 'PlayOut', sunshinePort: 47989 })
    await expect(conn.prepareStream('steam:2')).rejects.toMatchObject({
      status: 409,
      code: 'not-installed',
      message: 'Not installed on this PC'
    })
    await conn.stopStream()
    expect(await conn.moonlightPair(host.pairing.lastPin() ?? undefined)).toEqual({ ok: true })
    // Moonlight PINs are 4 digits: anything else is a bad request, never passed on to be refused later.
    for (const pin of ['123', '12345', '12345678', '12a4'])
      await expect(conn.moonlightPair(pin)).rejects.toMatchObject({
        status: 400,
        code: 'bad-request'
      })

    const stranger = client.connect({
      address: '127.0.0.1',
      port: host.server.port,
      fingerprint: host.cert.fingerprint,
      token: newToken()
    })
    await expect(stranger.library()).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
  })

  it("reports the caller's launch failure once on /v1/stream/status, and needs a token", async () => {
    const conn = client.connect({
      address: '127.0.0.1',
      port: host.server.port,
      fingerprint: host.cert.fingerprint,
      token
    })
    expect(await conn.streamStatus()).toEqual({})
    host.launchErrors.set('client-1', {
      gameId: 'rom:nes/Zelda',
      message: 'Mesen (MESEN) is not installed or could not be found'
    })
    expect(await conn.streamStatus()).toEqual({
      lastError: {
        gameId: 'rom:nes/Zelda',
        message: 'Mesen (MESEN) is not installed or could not be found'
      }
    })
    // Read once: cleared.
    expect(await conn.streamStatus()).toEqual({})
    expect(await fetchRaw(host.server.port, '/v1/stream/status')).toEqual({
      status: 401,
      body: { error: 'unauthorized' }
    })
  })

  describe('/v1/logins', () => {
    const conn = (): ReturnType<typeof client.connect> =>
      client.connect({
        address: '127.0.0.1',
        port: host.server.port,
        fingerprint: host.cert.fingerprint,
        token
      })
    const shared = { steamgriddb: { apiKey: 'fake-key-1' } }

    afterAll(() => {
      host.logins.answer = () => null
    })

    it('needs the bearer token', async () => {
      host.logins.answer = () => shared
      expect(await fetchRaw(host.server.port, '/v1/logins')).toEqual({
        status: 401,
        body: { error: 'unauthorized' }
      })
      const stranger = client.connect({
        address: '127.0.0.1',
        port: host.server.port,
        fingerprint: host.cert.fingerprint,
        token: newToken()
      })
      await expect(stranger.logins()).rejects.toMatchObject({ status: 401 })
    })

    it("answers 200 { logins } with the handler's logins, for the calling client", async () => {
      const handler = vi.fn(() => shared)
      host.logins.answer = handler
      expect(await conn().logins()).toEqual(shared)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(await fetchRaw(host.server.port, '/v1/logins', undefined, `Bearer ${token}`)).toEqual({
        status: 200,
        body: { logins: shared }
      })
    })

    it('answers 403 logins-off when the handler returns null; the client reads it as null', async () => {
      host.logins.answer = () => null
      expect(await fetchRaw(host.server.port, '/v1/logins', undefined, `Bearer ${token}`)).toEqual({
        status: 403,
        body: { error: 'logins-off' }
      })
      expect(await conn().logins()).toBeNull()
    })

    it('reads a 404 (a host from before /v1/logins) as null', async () => {
      host.logins.answer = () => {
        throw Object.assign(new Error('not-found'), {
          name: 'SyncRefused',
          status: 404,
          code: 'not-found'
        })
      }
      expect(await conn().logins()).toBeNull()
    })

    it('throws on a 500', async () => {
      host.logins.answer = () => {
        throw new Error('boom')
      }
      const err = await conn()
        .logins()
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostRequestError)
      expect(err).toMatchObject({ status: 500 })
    })
  })

  describe('/v1/library-tabs', () => {
    const conn = (): ReturnType<typeof client.connect> =>
      client.connect({
        address: '127.0.0.1',
        port: host.server.port,
        fingerprint: host.cert.fingerprint,
        token
      })
    const mine = { v: 1, tabs: [], updatedAt: '2026-11-17T12:00:00.000Z', by: 'client-a' }
    const theirs = { v: 1, tabs: [], updatedAt: '2026-11-17T12:05:00.000Z', by: 'host-1' }

    afterAll(() => {
      host.tabs.answer = () => null
    })

    it("sends this PC's copy and clock, and reads the host's", async () => {
      const handler = vi.fn(() => ({ doc: theirs, now: 1234 }))
      host.tabs.answer = handler
      expect(await conn().libraryTabs!(mine, 99)).toEqual({ doc: theirs, now: 1234 })
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0]).toMatchObject([
        { client: { id: 'client-1' } },
        { doc: mine, now: 99 }
      ])
    })

    it('needs the bearer token', async () => {
      host.tabs.answer = () => ({ doc: theirs, now: 1 })
      expect(await fetchRaw(host.server.port, '/v1/library-tabs')).toMatchObject({ status: 401 })
    })

    it('answers 403 tabs-sync-off while the sync is off; the client reads it as null', async () => {
      host.tabs.answer = () => null
      expect(await conn().libraryTabs!(mine, 1)).toBeNull()
    })

    it('reads a 404 (an older host) as null', async () => {
      host.tabs.answer = () => {
        throw Object.assign(new Error('not-found'), {
          name: 'SyncRefused',
          status: 404,
          code: 'not-found'
        })
      }
      expect(await conn().libraryTabs!(mine, 1)).toBeNull()
    })

    it('refuses a body over its cap (413)', async () => {
      host.tabs.answer = () => ({ doc: theirs, now: 1 })
      const huge = { ...mine, pad: 'x'.repeat(300 * 1024) }
      const err = await conn().libraryTabs!(huge, 1).catch((e: unknown) => e)
      expect(err).toMatchObject({ status: 413 })
    })
  })

  describe('/v1/favorites', () => {
    const conn = (): ReturnType<typeof client.connect> =>
      client.connect({
        address: '127.0.0.1',
        port: host.server.port,
        fingerprint: host.cert.fingerprint,
        token
      })
    const mine = [{ id: 'steam:1', favorite: true, at: 1_800_000_000_000 }]
    const theirs = [{ id: 'steam:2', favorite: true, at: 0 }]

    afterAll(() => {
      host.favorites.answer = () => null
    })

    it("sends this PC's proposals and clock, and reads the host's favourites", async () => {
      const handler = vi.fn(() => ({ entries: theirs, now: 1234 }))
      host.favorites.answer = handler
      expect(await conn().favorites!(mine, 99)).toEqual({ entries: theirs, now: 1234 })
      expect(handler.mock.calls[0]).toMatchObject([
        { client: { id: 'client-1' } },
        { entries: mine, now: 99 }
      ])
    })

    it('needs the bearer token', async () => {
      host.favorites.answer = () => ({ entries: [], now: 1 })
      expect(await fetchRaw(host.server.port, '/v1/favorites')).toMatchObject({ status: 401 })
    })

    it('answers 403 favorites-sync-off while the sync is off; the client reads it as null', async () => {
      host.favorites.answer = () => null
      expect(await conn().favorites!(mine, 1)).toBeNull()
    })

    it('reads a 404 (an older host, without the endpoint) as null', async () => {
      const server = createHostServer({
        tls: host.cert,
        port: 0,
        host: '127.0.0.1',
        log: quiet,
        auth: () => ({ id: 'client-1', name: 'Desk' }),
        handlers: { ...({} as HostHandlers), favorites: undefined }
      })
      await server.listen()
      try {
        const old = client.connect({
          address: '127.0.0.1',
          port: server.port,
          fingerprint: host.cert.fingerprint,
          token
        })
        expect(await old.favorites!(mine, 1)).toBeNull()
      } finally {
        await server.close()
      }
    })

    it('refuses a body over its cap (413)', async () => {
      host.favorites.answer = () => ({ entries: [], now: 1 })
      const huge = [{ id: 'x', favorite: true, at: 1, pad: 'x'.repeat(3 * 1024 * 1024) }]
      const err = await conn().favorites!(huge, 1).catch((e: unknown) => e)
      expect(err).toMatchObject({ status: 413 })
    })
  })

  describe('/v1/achievements', () => {
    const conn = (): ReturnType<typeof client.connect> =>
      client.connect({
        address: '127.0.0.1',
        port: host.server.port,
        fingerprint: host.cert.fingerprint,
        token
      })
    const list = {
      provider: 'steam',
      total: 2,
      unlocked: 1,
      list: [
        { id: 'A', name: 'First', unlocked: true },
        { id: 'B', name: 'Second', unlocked: false }
      ]
    }

    afterAll(() => {
      host.achievements.answer = async () => null
    })

    it("reads the host's list of a game by its offered id", async () => {
      const handler = vi.fn(async () => list)
      host.achievements.answer = handler
      expect(await conn().achievements!('manual:a/b c')).toEqual(list)
      expect(handler.mock.calls[0]).toMatchObject([{ client: { id: 'client-1' } }, 'manual:a/b c'])
    })

    it('reads "none" as null', async () => {
      host.achievements.answer = async () => null
      expect(await conn().achievements!('steam:1')).toBeNull()
    })

    it('needs the bearer token', async () => {
      host.achievements.answer = async () => list
      expect(await fetchRaw(host.server.port, '/v1/achievements/steam%3A1')).toMatchObject({
        status: 401
      })
    })

    it('reads a 404 (an older host, without the endpoint) as null', async () => {
      const server = createHostServer({
        tls: host.cert,
        port: 0,
        host: '127.0.0.1',
        log: quiet,
        auth: () => ({ id: 'client-1', name: 'Desk' }),
        handlers: { ...({} as HostHandlers), achievements: undefined }
      })
      await server.listen()
      try {
        const old = client.connect({
          address: '127.0.0.1',
          port: server.port,
          fingerprint: host.cert.fingerprint,
          token
        })
        expect(await old.achievements!('steam:1')).toBeNull()
      } finally {
        await server.close()
      }
    })

    it('refuses an answer over its cap', async () => {
      host.achievements.answer = async () => ({ ...list, pad: 'x'.repeat(5 * 1024 * 1024) })
      await expect(conn().achievements!('steam:1')).rejects.toThrow()
    })
  })

  describe('/v1/playtime', () => {
    const conn = (): ReturnType<typeof client.connect> =>
      client.connect({
        address: '127.0.0.1',
        port: host.server.port,
        fingerprint: host.cert.fingerprint,
        token
      })
    const sessions = [
      {
        id: 's_a',
        game: 'steam:1',
        startedAt: '2026-11-17T10:00:00.000Z',
        endedAt: '2026-11-17T11:00:00.000Z',
        minutes: 60
      }
    ]

    afterAll(() => {
      host.playtime.answer = () => null
    })

    it("sends this PC's sessions and asks for the host's, and reads its answer", async () => {
      const answer = { took: 1, sessions, next: { at: 5, id: 's_a' }, more: false, now: 1234 }
      const handler = vi.fn(() => answer)
      host.playtime.answer = handler
      const request = { sessions, games: ['steam:1'], after: { at: 1, id: 's_0' }, now: 99 }
      expect(await conn().playtime!(request)).toEqual(answer)
      expect(handler.mock.calls[0]).toMatchObject([{ client: { id: 'client-1' } }, request])
    })

    it('needs the bearer token', async () => {
      host.playtime.answer = () => ({ took: 0, sessions: [], next: null, more: false, now: 1 })
      expect(await fetchRaw(host.server.port, '/v1/playtime')).toMatchObject({ status: 401 })
    })

    it('answers 403 playtime-sync-off while the sync is off; the client reads it as null', async () => {
      host.playtime.answer = () => null
      expect(await conn().playtime!({ sessions, now: 1 })).toBeNull()
    })

    it('reads a 404 (an older host, without the endpoint) as null', async () => {
      const server = createHostServer({
        tls: host.cert,
        port: 0,
        host: '127.0.0.1',
        log: quiet,
        auth: () => ({ id: 'client-1', name: 'Desk' }),
        handlers: { ...({} as HostHandlers), playtime: undefined }
      })
      await server.listen()
      try {
        const old = client.connect({
          address: '127.0.0.1',
          port: server.port,
          fingerprint: host.cert.fingerprint,
          token
        })
        expect(await old.playtime!({ games: ['steam:1'], after: null, now: 1 })).toBeNull()
      } finally {
        await server.close()
      }
    })

    it('refuses a body over its cap (413)', async () => {
      host.playtime.answer = () => ({ took: 0, sessions: [], next: null, more: false, now: 1 })
      const huge = [{ ...sessions[0], pad: 'x'.repeat(3 * 1024 * 1024) }]
      const err = await conn().playtime!({ sessions: huge, now: 1 }).catch((e: unknown) => e)
      expect(err).toMatchObject({ status: 413 })
    })
  })

  it('downloads a ROM file whole and from an offset (Range)', async () => {
    const conn = client.connect({
      address: '127.0.0.1',
      port: host.server.port,
      fingerprint: host.cert.fingerprint,
      token
    })
    const original = await fs.readFile(host.romPath)
    expect(await conn.romFiles('rom:snes/Mario World')).toEqual({
      files: [{ path: 'snes/Mario World.sfc', size: 4096 }],
      totalBytes: 4096
    })
    // This PlayOut takes a PS3 game's PS3 HDD files and a game's texture packs (an older client asks for neither).
    expect(host.romOptions.at(-1)).toEqual({ ps3Hdd: true, textures: true })

    const whole = join(root, 'whole.part')
    let reported = 0
    await conn.downloadFile('rom:snes/Mario World', 'snes/Mario World.sfc', whole, {
      onBytes: (n) => (reported += n)
    })
    expect(await fs.readFile(whole)).toEqual(original)
    expect(reported).toBe(4096)
    // Sent a moment ago, it still counts as being sent (the rest of a set may follow); later, no longer.
    expect(host.server.filesBeingSent?.()).toContain(host.romPath)
    const t = host.clock.t
    host.clock.t += RECENT_SEND_MS + 1
    expect(host.server.filesBeingSent?.()).not.toContain(host.romPath)
    host.clock.t = t

    // Resume: the .part already holds the first 1000 bytes.
    const resumed = join(root, 'resumed.part')
    await fs.writeFile(resumed, original.subarray(0, 1000))
    reported = 0
    await conn.downloadFile('rom:snes/Mario World', 'snes/Mario World.sfc', resumed, {
      from: 1000,
      onBytes: (n) => (reported += n)
    })
    expect(reported).toBe(3096)
    expect(await fs.readFile(resumed)).toEqual(original)

    // Already complete: nothing more to fetch.
    await conn.downloadFile('rom:snes/Mario World', 'snes/Mario World.sfc', resumed, { from: 4096 })
    expect((await fs.stat(resumed)).size).toBe(4096)

    // Only files of the set are served.
    await expect(
      conn.downloadFile('rom:snes/Mario World', '../secret.txt', join(root, 'x.part'))
    ).rejects.toMatchObject({ status: 404 })
  })

  it('a download session reuses its pinned connections for many files', async () => {
    const conn = client.connect({
      address: '127.0.0.1',
      port: host.server.port,
      fingerprint: host.cert.fingerprint,
      token
    })
    const original = await fs.readFile(host.romPath)
    const session = conn.downloadSession!()
    try {
      for (let i = 0; i < 6; i++) {
        const dest = join(root, `session-${i}.part`)
        await session.downloadFile('rom:snes/Mario World', 'snes/Mario World.sfc', dest)
        expect(await fs.readFile(dest)).toEqual(original)
      }
      // Four at once, then a refused path (its error answer read whole), then one more over the kept connections.
      await Promise.all(
        [0, 1, 2, 3].map((i) =>
          session.downloadFile(
            'rom:snes/Mario World',
            'snes/Mario World.sfc',
            join(root, `parallel-${i}.part`)
          )
        )
      )
      await expect(
        session.downloadFile('rom:snes/Mario World', '../secret.txt', join(root, 'y.part'))
      ).rejects.toMatchObject({ status: 404 })
      await session.downloadFile(
        'rom:snes/Mario World',
        'snes/Mario World.sfc',
        join(root, 'z.part')
      )
      expect(session.connectionsOpened()).toBeGreaterThanOrEqual(1)
      expect(session.connectionsOpened()).toBeLessThanOrEqual(4)
    } finally {
      session.close()
    }
    await expect(
      session.downloadFile('rom:snes/Mario World', 'snes/Mario World.sfc', join(root, 'w.part'))
    ).rejects.toThrow(/closed/)

    // Every connection of a session is pin-checked: another certificate is refused.
    const wrong = client.connect({
      address: '127.0.0.1',
      port: other.server.port,
      fingerprint: host.cert.fingerprint,
      token
    }).downloadSession!()
    try {
      await expect(
        wrong.downloadFile('rom:snes/Mario World', 'snes/Mario World.sfc', join(root, 'v.part'))
      ).rejects.toBeInstanceOf(CertificateMismatchError)
      expect(wrong.connectionsOpened()).toBe(0)
    } finally {
      wrong.close()
    }
  })

  it('refuses a host that presents a different certificate, before sending the token', async () => {
    other.auth.mockClear()
    const conn = client.connect({
      address: '127.0.0.1',
      port: other.server.port,
      fingerprint: host.cert.fingerprint,
      token
    })
    await expect(conn.library()).rejects.toBeInstanceOf(CertificateMismatchError)
    expect(other.auth).not.toHaveBeenCalled()
  })

  it('locks out the address after five wrong PINs', async () => {
    const { pin } = host.pairing.start()
    const wrong = pin === '0000' ? '0001' : '0000'
    for (let i = 0; i < 5; i++) {
      await expect(
        client.pair('127.0.0.1', host.server.port, wrong, 'client-2', 'Attic PC')
      ).rejects.toMatchObject({ code: 'wrong-pin' })
    }
    const locked = await client
      .pair('127.0.0.1', host.server.port, pin, 'client-2', 'Attic PC')
      .catch((e: unknown) => e)
    expect(locked).toBeInstanceOf(HostRequestError)
    expect(locked).toMatchObject({ status: 403, code: 'locked' })
    // Only that address: pairing stays open for others, so one stranger cannot block it.
    expect(host.pairing.lockedUntil()).toBeNull()
    expect(host.clients.has('client-2')).toBe(false)
  })

  it('unpairs: the token stops working', async () => {
    const conn = client.connect({
      address: '127.0.0.1',
      port: host.server.port,
      fingerprint: host.cert.fingerprint,
      token
    })
    await conn.unpair()
    await expect(conn.library()).rejects.toMatchObject({ status: 401 })
  })

  it('answers unknown routes and bad bodies with JSON errors', async () => {
    const res = await fetchRaw(host.server.port, '/v1/nope')
    // Unknown routes need a token like the real ones, so they reveal nothing to strangers.
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(await fetchRaw(host.server.port, '/elsewhere')).toEqual({
      status: 404,
      body: { error: 'not-found' }
    })
    const big = await fetchRaw(host.server.port, '/v1/pair', 'x'.repeat(70 * 1024))
    expect(big.status).toBe(413)
    const bad = await fetchRaw(host.server.port, '/v1/pair', '{nope')
    expect(bad).toEqual({ status: 400, body: { error: 'bad-json' } })
  })
})

describe('a peer that never finishes the handshake', () => {
  let silent: NetServer
  let port = 0
  const held = new Set<Socket>()

  beforeAll(async () => {
    // Accepts TCP and says nothing: a wrong address typed in, or a device that is not PlayOut.
    silent = createNetServer((socket) => {
      held.add(socket)
      // Read and drop the ClientHello, so the client's close is noticed.
      socket.resume()
      socket.on('close', () => held.delete(socket))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    port = (silent.address() as { port: number }).port
  })

  afterAll(async () => {
    for (const s of held) s.destroy()
    await new Promise<void>((resolve) => silent.close(() => resolve()))
  })

  const waitClosed = async (): Promise<void> => {
    for (let i = 0; i < 50 && held.size > 0; i++) await new Promise((r) => setTimeout(r, 20))
  }

  it('gives up on a probe after the timeout and closes the connection', async () => {
    const quick = createHostClient({ timeoutMs: 300 })
    const started = Date.now()
    await expect(quick.probe('127.0.0.1', port)).rejects.toThrow(/in time/)
    expect(Date.now() - started).toBeLessThan(3000)
    await waitClosed()
    expect(held.size).toBe(0)
  })

  it('cancels a download right away while the handshake is still pending', async () => {
    const conn = createHostClient({ timeoutMs: 10_000 }).connect({
      address: '127.0.0.1',
      port,
      fingerprint: 'ab'.repeat(32),
      token: 't'
    })
    const ac = new AbortController()
    const pending = conn.downloadFile('g', 'f', join(root, 'never.bin'), { signal: ac.signal })
    await new Promise((r) => setTimeout(r, 100))
    expect(held.size).toBe(1)
    const started = Date.now()
    ac.abort()
    await expect(pending).rejects.toBeTruthy()
    expect(Date.now() - started).toBeLessThan(1000)
    await waitClosed()
    expect(held.size).toBe(0)
  })
})

describe('connection limits', () => {
  it('drops connections from one address above the cap', async () => {
    const opened: Socket[] = []
    try {
      for (let i = 0; i < MAX_CONNECTIONS_PER_ADDRESS; i++) {
        const s = netConnect(host.server.port, '127.0.0.1')
        s.on('error', () => undefined)
        await new Promise((r) => s.once('connect', r))
        opened.push(s)
      }
      const extra = netConnect(host.server.port, '127.0.0.1')
      extra.on('error', () => undefined)
      opened.push(extra)
      await new Promise((r) => extra.once('close', r))
      // Once the others go, the address is welcome again.
      for (const s of opened) s.destroy()
      await new Promise((r) => setTimeout(r, 100))
      const { info } = await client.probe('127.0.0.1', host.server.port)
      expect(info.id).toBe('host-1')
    } finally {
      for (const s of opened) s.destroy()
    }
  })
})

/** A plain request without pinning, for the error shapes. */
async function fetchRaw(
  port: number,
  path: string,
  body?: string,
  authorization?: string
): Promise<{ status: number; body: unknown }> {
  const { request } = await import('https')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        rejectUnauthorized: false,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(authorization ? { Authorization: authorization } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = JSON.parse(text)
          } catch {
            /* keep text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}
