import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../../logger'
import { HostRequestError } from '../host-client'
import {
  createEmulationSync,
  MAX_CLIENT_UPLOADS,
  type EmulationSync,
  type SyncSummary
} from './index'
import { scopeFor } from './rules'
import type { EmulationTransport } from './types'

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-emusync-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** A clock both PCs read (with an offset for the host), moved on by hand. */
const clock = { t: Date.parse('2026-11-12T12:00:00Z') }

interface Pc {
  name: string
  root: string
  sync: EmulationSync
  /** Its ROM folder (left out of the sync when inside its Emulation folder). */
  romsRoot?: string
}

async function pc(name: string, offsetMs = 0): Promise<Pc> {
  const root = join(dir, name, 'Emulation')
  await fs.mkdir(root, { recursive: true })
  return {
    name,
    root,
    sync: createEmulationSync({
      stateDir: join(dir, name, 'state'),
      log: quiet,
      now: () => clock.t + offsetMs,
      settleMs: 30_000
    })
  }
}

/** The host's engine behind the transport a client uses, its refusals turned into the host's answers. */
function transport(host: Pc, clientId: string): EmulationTransport {
  const scope = scopeFor(host.root, host.romsRoot ?? null)
  const answer = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (err) {
      const e = err as { name?: string; status?: number; code?: string }
      if (e.name === 'SyncRefused') throw new HostRequestError(e.status!, e.code!)
      throw err
    }
  }
  return {
    manifest: () => answer(() => host.sync.host.manifest(host.root, scope)),
    download: (path, dest) =>
      answer(async () => {
        const file = await host.sync.host.file(host.root, scope, path)
        if (!file) throw new HostRequestError(404, 'not-found')
        await fs.copyFile(file, dest)
      }),
    uploadChunk: (id, offset, total, data) =>
      answer(() => host.sync.host.uploadChunk(clientId, host.root, id, offset, total, data)),
    commit: (c) => answer(() => host.sync.host.commit(clientId, host.root, scope, c)),
    remove: (r) => answer(() => host.sync.host.remove(clientId, host.root, scope, r))
  }
}

/** Write a file with a modified time `agoMs` before the clock (old enough to sync by default). */
async function put(p: Pc, rel: string, text: string, agoMs = 120_000): Promise<void> {
  const file = join(p.root, ...rel.split('/'))
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  const t = new Date(clock.t - agoMs)
  await fs.utimes(file, t, t)
}

async function read(p: Pc, rel: string): Promise<string | null> {
  return fs.readFile(join(p.root, ...rel.split('/')), 'utf8').catch(() => null)
}

async function files(p: Pc): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(join(d, e.name), r)
      else if (e.name !== '.playout-sync-id') out.push(r)
    }
  }
  await walk(p.root, '')
  return out.sort()
}

async function backups(p: Pc): Promise<string[]> {
  const out: string[] = []
  const root = join(dir, p.name, 'state', 'backups')
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(join(d, e.name), r)
      else out.push(r.split('/').slice(1).join('/'))
    }
  }
  await walk(root, '')
  return out.sort()
}

function sync(client: Pc, host: Pc, clientId = client.name): Promise<SyncSummary> {
  return client.sync.syncWithHost({
    hostId: host.name,
    transport: transport(host, clientId),
    root: client.root,
    scope: scopeFor(client.root, null)
  })
}

describe('Emulation folder sync', () => {
  it('first sync merges both folders, both ways, leaving roms and texturepacks alone', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'bios/scph1001.bin', 'bios')
    await put(host, 'saves/duckstation/saves/a.mcd', 'host save')
    await put(host, 'roms/psx/game.chd', 'host rom')
    await put(host, 'texturepacks/dolphin/t.png', 'host tex')
    await put(client, 'saves/pcsx2/saves/b.ps2', 'client save')
    await put(client, 'ROMS/ps2/other.iso', 'client rom')
    await put(client, 'TexturePacks/x.png', 'client tex')

    const result = await sync(client, host)
    expect(result).toMatchObject({ downloaded: 2, uploaded: 1, deleted: 0, conflicts: 0 })
    expect(await files(client)).toEqual([
      'ROMS/ps2/other.iso',
      'TexturePacks/x.png',
      'bios/scph1001.bin',
      'saves/duckstation/saves/a.mcd',
      'saves/pcsx2/saves/b.ps2'
    ])
    expect(await files(host)).toEqual([
      'bios/scph1001.bin',
      'roms/psx/game.chd',
      'saves/duckstation/saves/a.mcd',
      'saves/pcsx2/saves/b.ps2',
      'texturepacks/dolphin/t.png'
    ])
    // A second pass finds nothing to do.
    expect(await sync(client, host)).toMatchObject({ downloaded: 0, uploaded: 0, deleted: 0 })
  })

  it('carries edits and deletions both ways, keeping deleted files in the backups', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/one.srm', 'v1')
    await put(host, 'saves/two.srm', 'v1')
    await put(host, 'saves/three.srm', 'v1')
    await sync(client, host)

    clock.t += 600_000
    await put(client, 'saves/one.srm', 'v2 from client')
    await fs.rm(join(client.root, 'saves', 'two.srm'))
    await fs.rm(join(host.root, 'saves', 'three.srm'))
    const result = await sync(client, host)
    expect(result).toMatchObject({ uploaded: 1, deleted: 2, conflicts: 0 })
    expect(await read(host, 'saves/one.srm')).toBe('v2 from client')
    expect(await read(host, 'saves/two.srm')).toBeNull()
    expect(await read(client, 'saves/three.srm')).toBeNull()
    expect(await backups(host)).toEqual(['saves/two.srm'])
    expect(await backups(client)).toEqual(['saves/three.srm'])
  })

  it('a conflict keeps the newer copy and backs up the other on its own PC', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/s.srm', 'v1')
    await sync(client, host)

    clock.t += 600_000
    await put(host, 'saves/s.srm', 'host edit', 200_000)
    await put(client, 'saves/s.srm', 'client edit, newer', 100_000)
    expect(await sync(client, host)).toMatchObject({ uploaded: 1, conflicts: 1 })
    expect(await read(host, 'saves/s.srm')).toBe('client edit, newer')
    expect(await backups(host)).toEqual(['saves/s.srm'])

    clock.t += 600_000
    await put(host, 'saves/s.srm', 'host edit, newer', 100_000)
    await put(client, 'saves/s.srm', 'client edit', 200_000)
    expect(await sync(client, host)).toMatchObject({ downloaded: 1, conflicts: 1 })
    expect(await read(client, 'saves/s.srm')).toBe('host edit, newer')
    expect(await backups(client)).toEqual(['saves/s.srm'])
  })

  it('reads the host’s times on its own clock (the PCs’ clocks differ)', async () => {
    // The host's clock is an hour ahead: its file written 200 s ago looks an hour newer than it is.
    const host = await pc('host', 3_600_000)
    const client = await pc('client')
    await put(host, 'saves/s.srm', 'host, older', 200_000 - 3_600_000)
    await put(client, 'saves/s.srm', 'client, newer', 100_000)
    expect(await sync(client, host)).toMatchObject({ uploaded: 1, conflicts: 1 })
    expect(await read(host, 'saves/s.srm')).toBe('client, newer')
  })

  it('a change on one PC reaches another client through the host', async () => {
    const host = await pc('host')
    const a = await pc('a')
    const b = await pc('b')
    await put(a, 'saves/from-a.srm', 'a')
    await sync(a, host)
    await sync(b, host)
    expect(await read(b, 'saves/from-a.srm')).toBe('a')

    clock.t += 600_000
    await fs.rm(join(b.root, 'saves', 'from-a.srm'))
    await sync(b, host)
    await sync(a, host)
    expect(await read(a, 'saves/from-a.srm')).toBeNull()
  })

  it('an emptied folder (moved, drive not plugged in) merges instead of deleting everything', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/a.srm', 'a')
    await put(host, 'bios/b.bin', 'b')
    await sync(client, host)

    await fs.rm(client.root, { recursive: true })
    await fs.mkdir(client.root)
    const result = await sync(client, host)
    expect(result).toMatchObject({ downloaded: 2, deleted: 0 })
    expect(await files(host)).toEqual(['bios/b.bin', 'saves/a.srm'])
  })

  it('a missing folder stops the pass', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/a.srm', 'a')
    await fs.rm(client.root, { recursive: true })
    await expect(sync(client, host)).rejects.toThrow(/missing/)
    expect(await files(host)).toEqual(['saves/a.srm'])
  })

  it('leaves files written moments ago for a later pass', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(client, 'saves/now.srm', 'being saved', 5_000)
    await put(host, 'saves/now2.srm', 'being saved', 5_000)
    expect(await sync(client, host)).toMatchObject({ downloaded: 0, uploaded: 0 })
    clock.t += 60_000
    expect(await sync(client, host)).toMatchObject({ downloaded: 1, uploaded: 1 })
  })

  it('the host refuses a change when its copy changed meanwhile; the next pass decides again', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/s.srm', 'v1')
    await sync(client, host)
    clock.t += 600_000
    await put(client, 'saves/s.srm', 'client v2')
    // Between the host's list and the client's upload, the host's copy changes.
    const t = transport(host, 'client')
    const sneaky: EmulationTransport = {
      ...t,
      async commit(c) {
        await put(host, 'saves/s.srm', 'host v2 meanwhile', 1_000)
        return t.commit(c)
      }
    }
    const result = await client.sync.syncWithHost({
      hostId: 'host',
      transport: sneaky,
      root: client.root,
      scope: scopeFor(client.root, null)
    })
    expect(result).toMatchObject({ uploaded: 0, skipped: 1 })
    expect(await read(host, 'saves/s.srm')).toBe('host v2 meanwhile')
    expect(await read(client, 'saves/s.srm')).toBe('client v2')
  })

  it('uploads a file larger than one piece', async () => {
    const host = await pc('host')
    const client = await pc('client')
    const big = 'x'.repeat(2.5 * 1024 * 1024)
    await put(client, 'storage/big.bin', big)
    expect(await sync(client, host)).toMatchObject({ uploaded: 1 })
    expect(await read(host, 'storage/big.bin')).toBe(big)
  })

  it('never follows or copies junctions', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(client, 'saves/rpcs3/saves/game/SAVE.DAT', 'save')
    await fs.mkdir(join(client.root, 'storage', 'rpcs3', 'home'), { recursive: true })
    await fs.symlink(
      join(client.root, 'saves', 'rpcs3', 'saves'),
      join(client.root, 'storage', 'rpcs3', 'home', 'savedata'),
      'junction'
    )
    await sync(client, host)
    expect(await files(host)).toEqual(['saves/rpcs3/saves/game/SAVE.DAT'])
  })

  it('a host whose folder moved is merged again from scratch', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/a.srm', 'a')
    await sync(client, host)
    // The host now uses another (empty) folder: the client's files go there, nothing here is deleted.
    host.root = join(dir, 'host', 'Elsewhere')
    await fs.mkdir(host.root)
    expect(await sync(client, host)).toMatchObject({ uploaded: 1, deleted: 0 })
    expect(await read(client, 'saves/a.srm')).toBe('a')
  })

  it('a junction made after a sync holds that folder: nothing under it reads as deleted', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/game/a.srm', 'a')
    await put(host, 'saves/game/b.srm', 'b')
    await sync(client, host)
    // The client's saves\game becomes a junction to a folder elsewhere (the files are still there, another way).
    const elsewhere = join(dir, 'elsewhere')
    await fs.rename(join(client.root, 'saves', 'game'), elsewhere)
    await fs.symlink(elsewhere, join(client.root, 'saves', 'game'), 'junction')
    clock.t += 600_000
    expect(await sync(client, host)).toMatchObject({ deleted: 0, downloaded: 0 })
    expect(await files(host)).toEqual(['saves/game/a.srm', 'saves/game/b.srm'])
  })

  it('never writes through a junction on the way to a file', async () => {
    const host = await pc('host')
    const client = await pc('client')
    const elsewhere = join(dir, 'elsewhere')
    await fs.mkdir(elsewhere)
    await fs.mkdir(join(client.root, 'saves'), { recursive: true })
    await fs.symlink(elsewhere, join(client.root, 'saves', 'linked'), 'junction')
    await put(host, 'saves/linked/x.srm', 'x')
    await sync(client, host)
    expect(await fs.readdir(elsewhere)).toEqual([])
    // And the host serves nothing through one either.
    await fs.mkdir(join(host.root, 'storage'), { recursive: true })
    await fs.symlink(join(host.root, 'saves'), join(host.root, 'storage', 'via'), 'junction')
    expect(
      await host.sync.host.file(host.root, scopeFor(host.root, null), 'storage/via/linked/x.srm')
    ).toBeNull()
  })

  it('a folder only the host leaves out (its ROM folder) is not deleted on the client', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'games/psx/a.chd', 'game')
    await put(host, 'saves/s.srm', 's')
    await sync(client, host)
    expect(await read(client, 'games/psx/a.chd')).toBe('game')
    // The host's ROM folder is now Emulation\games: its list leaves it out.
    host.romsRoot = join(host.root, 'games')
    clock.t += 600_000
    expect(await sync(client, host)).toMatchObject({ deleted: 0, uploaded: 0 })
    expect(await read(client, 'games/psx/a.chd')).toBe('game')
  })

  it('a file the host cannot replace is skipped; the others still sync', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'bios/locked.bin', 'v1')
    await sync(client, host)
    clock.t += 600_000
    await put(client, 'bios/locked.bin', 'v2')
    await put(client, 'saves/z.srm', 'z')
    // A folder where the host's file was: the host refuses that one file.
    await fs.rm(join(host.root, 'bios', 'locked.bin'))
    await fs.mkdir(join(host.root, 'bios', 'locked.bin'))
    const result = await sync(client, host)
    expect(result.uploaded).toBe(1)
    expect(await read(host, 'saves/z.srm')).toBe('z')
  })

  it('stages uploads inside the host folder (same drive) and leaves nothing there afterwards', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(client, 'saves/s.srm', 's')
    await sync(client, host)
    expect(await read(host, 'saves/s.srm')).toBe('s')
    const staging = join(host.root, 'uploads.playout-sync')
    const left = await fs.readdir(staging, { recursive: true }).catch(() => [] as string[])
    expect(left.filter((n) => String(n).endsWith('.part'))).toEqual([])
    // The staging folder is never synced.
    const listed = (await files(host)).filter((f) => !f.startsWith('uploads.playout-sync'))
    expect(listed).toEqual(['saves/s.srm'])
    expect(await files(client)).toEqual(['saves/s.srm'])
  })

  it('a file dated in the future still syncs (it is not being written)', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(client, 'saves/future.srm', 'f', -10 * 86_400_000)
    expect(await sync(client, host)).toMatchObject({ uploaded: 1 })
  })

  it('one file whose transfer fails is retried next pass; the others still sync', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/a.srm', 'a')
    await put(host, 'saves/b.srm', 'b')
    const t = transport(host, 'client')
    const flaky: EmulationTransport = {
      ...t,
      async download(path, dest, signal) {
        if (path === 'saves/a.srm') throw new Error('socket hang up')
        return t.download(path, dest, signal)
      }
    }
    const result = await client.sync.syncWithHost({
      hostId: 'host',
      transport: flaky,
      root: client.root,
      scope: scopeFor(client.root, null)
    })
    expect(result).toMatchObject({ downloaded: 1, failed: 1 })
    expect(await read(client, 'saves/b.srm')).toBe('b')
    expect(await sync(client, host)).toMatchObject({ downloaded: 1 })
    expect(await read(client, 'saves/a.srm')).toBe('a')
  })

  it('a host that keeps failing ends the pass', async () => {
    const host = await pc('host')
    const client = await pc('client')
    for (const n of ['a', 'b', 'c', 'd']) await put(host, `saves/${n}.srm`, n)
    const t = transport(host, 'client')
    const gone: EmulationTransport = {
      ...t,
      download: async () => {
        throw new Error('connect ECONNREFUSED')
      }
    }
    await expect(
      client.sync.syncWithHost({
        hostId: 'host',
        transport: gone,
        root: client.root,
        scope: scopeFor(client.root, null)
      })
    ).rejects.toThrow(/ECONNREFUSED/)
  })

  it('a conflict whose replace keeps failing backs its copy up once', async () => {
    const host = await pc('host')
    const client = await pc('client')
    await put(host, 'saves/s.srm', 'host, newer', 100_000)
    await put(client, 'saves/s.srm', 'client, older', 200_000)
    const t = transport(host, 'client')
    let fail = true
    const stuck: EmulationTransport = {
      ...t,
      async download(path, dest, signal) {
        await t.download(path, dest, signal)
        // The client's copy is held open elsewhere: the rename onto it fails (a folder takes the temp file's place).
        if (fail) {
          await fs.rm(dest)
          await fs.mkdir(dest)
          await fs.writeFile(join(dest, 'x'), 'x')
        }
      }
    }
    const run = (): ReturnType<typeof client.sync.syncWithHost> =>
      client.sync.syncWithHost({
        hostId: 'host',
        transport: stuck,
        root: client.root,
        scope: scopeFor(client.root, null)
      })
    await run().catch(() => undefined)
    await run().catch(() => undefined)
    fail = false
    await run()
    expect(await read(client, 'saves/s.srm')).toBe('host, newer')
    expect(await backups(client)).toEqual(['saves/s.srm'])
  })

  it('a host delete holds the file here: nothing on this PC puts it back meanwhile', async () => {
    const host = await pc('host')
    const middle = await pc('middle')
    await put(middle, 'saves/a.srm', 'old')
    await sync(middle, host)
    await fs.rm(join(middle.root, 'saves', 'a.srm'))
    // While the host deletes its copy, another client commits the same file to this PC (it is a host too).
    const inner = transport(host, 'middle')
    const scope = scopeFor(middle.root, null)
    let cameBackMeanwhile: boolean | null = null
    let commit: Promise<void> = Promise.resolve()
    const racing: EmulationTransport = {
      ...inner,
      remove: async (request) => {
        const data = Buffer.from('new')
        commit = (async () => {
          await middle.sync.host.uploadChunk('third', middle.root, 'upload-0001', 0, 3, data)
          await middle.sync.host.commit('third', middle.root, scope, {
            id: 'upload-0001',
            path: 'saves/a.srm',
            size: 3,
            hash: createHash('sha1').update(data).digest('hex'),
            mtimeMs: clock.t - 60_000,
            expect: null
          })
        })()
        cameBackMeanwhile = await Promise.race([
          commit.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 300))
        ])
        await inner.remove(request)
      }
    }
    const result = await middle.sync.syncWithHost({
      hostId: host.name,
      transport: racing,
      root: middle.root,
      scope
    })
    expect(cameBackMeanwhile).toBe(false)
    expect(result.deleted).toBe(1)
    // The other client's file lands once the delete is through, and reaches the host at the next pass.
    await commit
    expect(await read(middle, 'saves/a.srm')).toBe('new')
    clock.t += 120_000
    expect((await sync(middle, host)).uploaded).toBe(1)
    expect(await read(host, 'saves/a.srm')).toBe('new')
  })

  it('keeps only a few unfinished uploads per client: starting another removes the oldest', async () => {
    const host = await pc('host')
    const staged = async (): Promise<string[]> =>
      (await fs.readdir(join(host.root, 'uploads.playout-sync'), { recursive: true }))
        .map(String)
        .filter((n) => n.endsWith('.part'))
    const data = Buffer.from('half')
    const ids = Array.from({ length: MAX_CLIENT_UPLOADS + 3 }, (_, i) => `upload-000${i}`)
    for (const id of ids) {
      await host.sync.host.uploadChunk('client', host.root, id, 0, 8, data)
      await new Promise((r) => setTimeout(r, 15))
    }
    expect(await staged()).toHaveLength(MAX_CLIENT_UPLOADS)
    // The newest goes on; the oldest is gone. Another client's uploads are counted apart.
    await host.sync.host.uploadChunk('client', host.root, ids.at(-1)!, 4, 8, data)
    await expect(
      host.sync.host.uploadChunk('client', host.root, ids[0], 4, 8, data)
    ).rejects.toMatchObject({ status: 409, code: 'bad-offset' })
    await host.sync.host.uploadChunk('other', host.root, 'upload-0000', 0, 8, data)
    expect(await staged()).toHaveLength(MAX_CLIENT_UPLOADS + 1)
  })

  it('asks for room again as an upload goes on, and drops what was staged when the drive filled', async () => {
    const root = join(dir, 'host', 'Emulation')
    await fs.mkdir(root, { recursive: true })
    let free = 1024 ** 4
    const asked: number[] = []
    const engine = createEmulationSync({
      stateDir: join(dir, 'host', 'state'),
      log: quiet,
      now: () => clock.t,
      freeBytes: async () => {
        asked.push(free)
        return free
      }
    })
    const data = Buffer.alloc(1024, 1)
    await engine.host.uploadChunk('client', root, 'upload-0001', 0, 4096, data)
    await engine.host.uploadChunk('client', root, 'upload-0001', 1024, 4096, data)
    expect(asked).toHaveLength(2)
    // Something else filled the drive meanwhile.
    free = 1024
    await expect(
      engine.host.uploadChunk('client', root, 'upload-0001', 2048, 4096, data)
    ).rejects.toMatchObject({ status: 507, code: 'no-space' })
    const left = await fs.readdir(join(root, 'uploads.playout-sync'), { recursive: true })
    expect(left.map(String).filter((n) => n.endsWith('.part'))).toEqual([])
  })

  it('makes room for a new upload from what the same client left unfinished, oldest first', async () => {
    const root = join(dir, 'host', 'Emulation')
    await fs.mkdir(root, { recursive: true })
    const staged = async (): Promise<string[]> =>
      (await fs.readdir(join(root, 'uploads.playout-sync'), { recursive: true }))
        .map(String)
        .filter((n) => n.endsWith('.part'))
    // A drive that only has room while no more than `room` unfinished uploads are on it.
    let room = Infinity
    const engine = createEmulationSync({
      stateDir: join(dir, 'host', 'state'),
      log: quiet,
      now: () => clock.t,
      freeBytes: async () => ((await staged()).length > room ? 0 : 1024 ** 4)
    })
    const data = Buffer.from('half')
    const ids = Array.from({ length: MAX_CLIENT_UPLOADS + 1 }, (_, i) => `upload-000${i}`)
    for (const id of ids) {
      await engine.host.uploadChunk('client', root, id, 0, 8, data)
      await new Promise((r) => setTimeout(r, 15))
    }
    await engine.host.uploadChunk('other', root, 'upload-0000', 0, 8, data)
    expect(await staged()).toHaveLength(MAX_CLIENT_UPLOADS + 1)
    room = 2
    // Its own abandoned uploads go (the other client's stays): the newest of them survives, and the new one starts.
    await engine.host.uploadChunk('client', root, 'upload-0009', 0, 8, data)
    expect(await staged()).toHaveLength(3)
    room = Infinity
    await engine.host.uploadChunk('client', root, 'upload-0009', 4, 8, data)
    await engine.host.uploadChunk('client', root, ids.at(-1)!, 4, 8, data)
    await expect(
      engine.host.uploadChunk('client', root, ids.at(-2)!, 4, 8, data)
    ).rejects.toMatchObject({ status: 409, code: 'bad-offset' })
    // Nothing of its own left to give up: refused, and the other client's upload is not touched.
    room = -1
    await expect(
      engine.host.uploadChunk('client', root, 'upload-0010', 0, 8, data)
    ).rejects.toMatchObject({ status: 507, code: 'no-space' })
    expect(await staged()).toHaveLength(1)
    room = Infinity
    await engine.host.uploadChunk('other', root, 'upload-0000', 4, 8, data)
  })
})
