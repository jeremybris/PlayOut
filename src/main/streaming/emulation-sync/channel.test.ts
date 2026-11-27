import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../../logger'
import { createHostClient, HostRequestError } from '../host-client'
import { createHostServer, type HostHandlers, type HostServer } from '../host-server'
import { hashToken, newToken } from '../pairing'
import { ensureHostCertificate } from '../tls'
import { createEmulationSync, SyncRefused } from './index'
import { scopeFor } from './rules'

/** The Emulation folder sync over PlayOut's real host service: HTTPS, the pinned client, uploads in pieces. */

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let dir: string
let server: HostServer
let busy = false

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-emusync-tls-'))
  busy = false
})
afterEach(async () => {
  await server?.close()
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(root: string, rel: string, data: string | Buffer): Promise<void> {
  const file = join(root, ...rel.split('/'))
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, data)
  const t = new Date(Date.now() - 120_000)
  await fs.utimes(file, t, t)
}

describe('Emulation folder sync over the host service', () => {
  it('syncs both ways through the real server and client, and passes on the host’s refusals', async () => {
    const hostRoot = join(dir, 'host', 'Emulation')
    const clientRoot = join(dir, 'client', 'Emulation')
    await fs.mkdir(hostRoot, { recursive: true })
    await fs.mkdir(clientRoot, { recursive: true })
    const hostSync = createEmulationSync({ stateDir: join(dir, 'host', 'state'), log: quiet })
    const clientSync = createEmulationSync({ stateDir: join(dir, 'client', 'state'), log: quiet })
    const scope = scopeFor(hostRoot, null)
    const guard = (): void => {
      if (busy) throw new SyncRefused(409, 'busy')
    }
    const notUsed = async (): Promise<never> => {
      throw new Error('not used')
    }
    const handlers: HostHandlers = {
      info: () => ({ id: 'host-1', name: 'Host', version: '1', fingerprint: cert.fingerprint }),
      pair: notUsed,
      library: async () => [],
      scan: async () => {},
      scanStatus: async () => ({ running: false }),
      media: async () => null,
      romFiles: async () => null,
      romFile: async () => null,
      prepareStream: notUsed,
      stopStream: async () => {},
      streamStatus: async () => ({}),
      logins: () => null,
      moonlightPair: notUsed,
      unpair: async () => {},
      emulationManifest: async () => (guard(), hostSync.host.manifest(hostRoot, scope)),
      emulationFile: async (_ctx, path) => (guard(), hostSync.host.file(hostRoot, scope, path)),
      emulationUpload: async (ctx, u) => {
        guard()
        await hostSync.host.uploadChunk(ctx.client.id, hostRoot, u.id, u.offset, u.total, u.data)
      },
      emulationCommit: async (ctx, c) => {
        guard()
        await hostSync.host.commit(ctx.client.id, hostRoot, scope, c)
      },
      emulationDelete: async (ctx, r) => {
        guard()
        await hostSync.host.remove(ctx.client.id, hostRoot, scope, r)
      }
    }
    const cert = await ensureHostCertificate(join(dir, 'cert'))
    const token = newToken()
    server = createHostServer({
      tls: cert,
      port: 0,
      host: '127.0.0.1',
      log: quiet,
      auth: (t) => (hashToken(t) === hashToken(token) ? { id: 'client-1', name: 'Client' } : null),
      handlers
    })
    await server.listen()
    const conn = createHostClient({ timeoutMs: 10_000 }).connect({
      address: '127.0.0.1',
      port: server.port,
      fingerprint: cert.fingerprint,
      token
    })

    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7)
    await put(hostRoot, 'bios/scph1001.bin', 'bios')
    await put(hostRoot, 'roms/psx/game.chd', 'rom')
    await put(clientRoot, 'saves/big.state', big)
    await put(clientRoot, 'texturepacks/x.png', 'tex')

    const run = (): ReturnType<typeof clientSync.syncWithHost> =>
      clientSync.syncWithHost({
        hostId: 'host-1',
        transport: conn.emulation,
        root: clientRoot,
        scope: scopeFor(clientRoot, null)
      })
    expect(await run()).toMatchObject({ downloaded: 1, uploaded: 1, failed: 0 })
    expect(await fs.readFile(join(clientRoot, 'bios', 'scph1001.bin'), 'utf8')).toBe('bios')
    expect((await fs.readFile(join(hostRoot, 'saves', 'big.state'))).equals(big)).toBe(true)
    await expect(fs.access(join(hostRoot, 'texturepacks'))).rejects.toThrow()
    await expect(fs.access(join(clientRoot, 'roms'))).rejects.toThrow()

    // A path outside the folder or into roms is not served.
    await expect(conn.emulation.download('../cert/key.pem', join(dir, 'x'))).rejects.toMatchObject({
      status: 404
    })
    await expect(
      conn.emulation.download('roms/psx/game.chd', join(dir, 'x'))
    ).rejects.toMatchObject({ status: 404 })

    // A game running on the host: the client is told, and nothing moves.
    busy = true
    const refused = await run().catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(HostRequestError)
    expect(refused).toMatchObject({ status: 409, code: 'busy' })
  })
})
