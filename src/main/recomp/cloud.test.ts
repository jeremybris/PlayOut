import { promises as fs, type Dirent } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OLD_RECOMP_CLOUD_FOLDER,
  RECOMP_SAVES_FOLDER,
  type RecompCloudState
} from '../../shared/recomp'
import type { Logger } from '../logger'
import { setMainLanguage } from '../i18n'
import { isExcluded } from '../streaming/emulation-sync/rules'
import { listZip, readZipEntry } from '../util/zip'
import {
  adoptOldCopy,
  FreshChangedError,
  cloudSaveKey,
  isWritableSaveRoot,
  oldCloudSaveDir,
  readCopyMeta,
  resolveConflict,
  syncSaves,
  writeZip,
  type CloudSyncDeps
} from './cloud'
import { hashSaves } from './saves'

const ID = 'github:Mr-Wiseguy/Zelda64Recomp#mm'
const noop = (): void => undefined
const log: Logger = { debug: noop, info: noop, warn: noop, error: noop }

let tmp: string
/** The Emulation folder. */
let emuDir: string
let saves: string
let otherSaves: string

function state(over: Partial<RecompCloudState> = {}): RecompCloudState {
  return {
    enabled: true,
    syncedHash: null,
    localHash: null,
    syncedAt: null,
    pending: false,
    error: null,
    conflict: null,
    ...over
  }
}

function deps(machine = 'PC-A', over: Partial<CloudSyncDeps> = {}): CloudSyncDeps {
  return {
    rootDir: emuDir,
    dir: base(),
    machine,
    log,
    backupsDir: join(tmp, `backups-${machine}`),
    now: () => new Date('2026-11-14T10:00:00Z'),
    templates: ['{local}/Zelda64Recompiled/saves'],
    ...over
  }
}

async function write(p: string, content: string): Promise<void> {
  await fs.mkdir(join(p, '..'), { recursive: true })
  await fs.writeFile(p, content)
}

async function read(p: string): Promise<string | null> {
  return fs.readFile(p, 'utf8').catch(() => null)
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false
  )
}

async function zips(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.zip'))
}

const FOLDER = 'Zelda 64 Recompiled (mr-wiseguy-zelda64recomp-mm)'
const base = (): string => join(emuDir, RECOMP_SAVES_FOLDER, FOLDER)
/** Where replaced Emulation-folder copies are backed up on a PC (never in the Emulation folder). */
const copyBackups = (machine = 'PC-A'): string =>
  join(tmp, `backups-${machine}`, cloudSaveKey(ID), 'replaced copies')
/** Deps for an Emulation folder that is not there (a disconnected drive). */
const gone = (): Partial<CloudSyncDeps> => ({
  rootDir: join(tmp, 'gone'),
  dir: join(tmp, 'gone', RECOMP_SAVES_FOLDER, FOLDER)
})

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'playout-cloud-'))
  emuDir = join(tmp, 'Emulation')
  await fs.mkdir(emuDir)
  saves = join(tmp, 'A', 'Zelda64Recompiled', 'saves')
  otherSaves = join(tmp, 'B', 'Zelda64Recompiled', 'saves')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('layout', () => {
  it('makes a filesystem-safe key per recompilation', () => {
    expect(cloudSaveKey(ID)).toBe('github-mr-wiseguy-zelda64recomp-mm')
    expect(cloudSaveKey('gitlab:a/b/c')).toBe('gitlab-a-b-c')
    expect(cloudSaveKey(':::')).toBe('recomp')
    expect(oldCloudSaveDir(join(tmp, 'Drive'), ID)).toBe(
      join(tmp, 'Drive', OLD_RECOMP_CLOUD_FOLDER, 'github-mr-wiseguy-zelda64recomp-mm')
    )
  })

  it('never treats a broad folder as a save root', () => {
    expect(isWritableSaveRoot('C:\\')).toBe(false)
    expect(isWritableSaveRoot('relative')).toBe(false)
    expect(isWritableSaveRoot(join(tmp, 'x'))).toBe(true)
    expect(isWritableSaveRoot(process.env.USERPROFILE ?? 'C:\\Users')).toBe(false)
  })
})

describe('writeZip', () => {
  it('writes a zip util/zip.ts can read', async () => {
    await write(join(tmp, 'f.sav'), 'hello hello hello hello hello')
    const dest = join(tmp, 'out', 'b.zip')
    await writeZip(dest, [
      { name: 'meta.json', from: Buffer.from('{"a":1}') },
      { name: '0/dir/f.sav', from: join(tmp, 'f.sav') }
    ])
    const entries = await listZip(dest)
    expect(entries.map((e) => e.name)).toEqual(['meta.json', '0/dir/f.sav'])
    expect((await readZipEntry(dest, entries[1])).toString()).toBe('hello hello hello hello hello')
    expect((await readZipEntry(dest, entries[0])).toString()).toBe('{"a":1}')
    expect(await fs.readdir(join(tmp, 'out'))).toEqual(['b.zip'])
  })
})

describe('syncSaves', () => {
  it('does nothing while copying the saves is off', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const s = state({ enabled: false })
    expect(await syncSaves(ID, [saves], s, deps(), 'before-play')).toBe(s)
    expect(await exists(base())).toBe(false)
  })

  it('copies to the Emulation folder when it has no copy, then is in sync', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await write(join(saves, 'sub', 'b.sav'), 'B1')
    const s1 = await syncSaves(ID, [saves], state(), deps(), 'after-play')
    const local = (await hashSaves([saves])).hash
    expect(s1).toMatchObject({
      syncedHash: local,
      localHash: local,
      pending: false,
      error: null,
      conflict: null
    })
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    expect(await read(join(base(), 'current', '0', 'sub', 'b.sav'))).toBe('B1')
    expect(await readCopyMeta(base())).toEqual({
      hash: local,
      at: '2026-11-14T10:00:00.000Z',
      machine: 'PC-A',
      roots: ['{local}/Zelda64Recompiled/saves'],
      history: []
    })
    // No temp folders left behind.
    expect((await fs.readdir(base())).sort()).toEqual(['current', 'meta.json'])
    // Second run: in sync, nothing changes.
    const s2 = await syncSaves(ID, [saves], s1, deps(), 'before-play')
    expect(s2).toMatchObject({ syncedHash: local, pending: false, error: null })
  })

  it('restores onto a PC with no saves', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const s = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    expect(await read(join(otherSaves, 'a.sav'))).toBe('A1')
    expect(s.syncedHash).toBe((await hashSaves([saves])).hash)
  })

  it('copy newer: backs up this PC, then copies back (deleting files the copy lacks, inside the root only)', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    // PC-B plays: changes a, adds b, removes nothing; uploads.
    await write(join(otherSaves, 'a.sav'), 'A2')
    await write(join(otherSaves, 'b.sav'), 'B2')
    await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    // PC-A has an extra local file the cloud never had, plus a sibling outside the root.
    const sibling = join(saves, '..', 'config.ini')
    await write(sibling, 'keep me')
    const s = await syncSaves(ID, [saves], sA, deps('PC-A'), 'before-play')
    // PC-A's saves were unchanged since its last sync → cloud newer.
    expect(s.conflict).toBeNull()
    expect(await read(join(saves, 'a.sav'))).toBe('A2')
    expect(await read(join(saves, 'b.sav'))).toBe('B2')
    expect(await read(sibling)).toBe('keep me')
    const backups = await zips(join(tmp, 'backups-PC-A', cloudSaveKey(ID)))
    expect(backups).toHaveLength(1)
    const zipPath = join(tmp, 'backups-PC-A', cloudSaveKey(ID), backups[0])
    const names = (await listZip(zipPath)).map((e) => e.name)
    expect(names).toEqual(['playout-saves.json', '0/a.sav'])
  })

  it('removes a local save the newer cloud copy deleted', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await write(join(saves, 'old.sav'), 'old')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    await fs.rm(join(otherSaves, 'old.sav'))
    await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    await syncSaves(ID, [saves], sA, deps('PC-A'), 'before-play')
    expect(await exists(join(saves, 'old.sav'))).toBe(false)
    expect(await read(join(saves, 'a.sav'))).toBe('A1')
  })

  it('local newer: backs up the copy on this PC (not in the Emulation folder), then copies', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const s1 = await syncSaves(ID, [saves], state(), deps(), 'after-play')
    await write(join(saves, 'a.sav'), 'A2')
    const s2 = await syncSaves(ID, [saves], s1, deps(), 'after-play')
    expect(s2.syncedHash).toBe((await hashSaves([saves])).hash)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A2')
    expect(await exists(join(base(), 'backups'))).toBe(false)
    const backups = await zips(copyBackups())
    expect(backups).toEqual(['2026-11-14T10-00-00Z PC-A.zip'])
    const zipPath = join(copyBackups(), backups[0])
    const entries = await listZip(zipPath)
    expect(
      (
        await readZipEntry(
          zipPath,
          entries.find((e) => e.name === '0/a.sav')!
        )
      ).toString()
    ).toBe('A1')
  })

  it('keeps the newest 10 backups of replaced copies', async () => {
    await write(join(saves, 'a.sav'), 'v0')
    let s = await syncSaves(ID, [saves], state(), deps(), 'after-play')
    for (let i = 1; i <= 12; i++) {
      await write(join(saves, 'a.sav'), `v${i}`)
      const at = new Date(Date.UTC(2026, 10, 14, 10, i))
      s = await syncSaves(ID, [saves], s, deps('PC-A', { now: () => at }), 'after-play')
    }
    expect(await zips(copyBackups())).toHaveLength(10)
  })

  it('both changed: a conflict, nothing overwritten', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    await write(join(otherSaves, 'a.sav'), 'B-played')
    await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    await write(join(saves, 'a.sav'), 'A-played')
    const s = await syncSaves(ID, [saves], sA, deps('PC-A'), 'after-play')
    expect(s.conflict).toMatchObject({ cloudDevice: 'PC-B', cloudAt: '2026-11-14T10:00:00.000Z' })
    expect(s.syncedHash).toBe(sA.syncedHash)
    expect(await read(join(saves, 'a.sav'))).toBe('A-played')
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('B-played')
    // Still a conflict on the next try.
    expect((await syncSaves(ID, [saves], s, deps('PC-A'), 'before-play')).conflict).not.toBeNull()
  })

  it('a copy several uploads ahead of this PC is still taken (its history reaches the last sync)', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    let sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    for (const v of ['B2', 'B3', 'B4']) {
      await write(join(otherSaves, 'a.sav'), v)
      sB = await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    }
    expect((await readCopyMeta(base()))?.history?.length).toBe(3)
    const s = await syncSaves(ID, [saves], sA, deps('PC-A'), 'before-play')
    expect(s.conflict).toBeNull()
    expect(await read(join(saves, 'a.sav'))).toBe('B4')
  })

  it('two PCs played offline from the same saves: the merged copy is a conflict, never copied back', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    // Offline: PC-B has its own copy of the Emulation folder.
    const emuB = join(tmp, 'EmulationB')
    await fs.cp(emuDir, emuB, { recursive: true })
    const onB = { rootDir: emuB, dir: join(emuB, RECOMP_SAVES_FOLDER, FOLDER) }
    await write(join(saves, 'a.sav'), 'A-offline')
    const sA2 = await syncSaves(ID, [saves], sA, deps('PC-A'), 'after-play')
    await write(join(otherSaves, 'a.sav'), 'B-offline')
    await syncSaves(ID, [otherSaves], sB, deps('PC-B', onB), 'after-play')
    // Reconnected: the Emulation folder sync kept PC-B's copy (newer files win).
    await fs.rm(base(), { recursive: true, force: true })
    await fs.cp(onB.dir, base(), { recursive: true })
    // PC-A's saves did not change since its own upload, but the copy did not come from it.
    const s = await syncSaves(ID, [saves], sA2, deps('PC-A'), 'before-play')
    expect(s.conflict).toMatchObject({ cloudDevice: 'PC-B' })
    expect(await read(join(saves, 'a.sav'))).toBe('A-offline')
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('B-offline')
  })

  it('a copy from an older version (no history) newer than the last sync is still taken', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    await write(join(otherSaves, 'a.sav'), 'B2')
    await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    const metaPath = join(base(), 'meta.json')
    const meta = JSON.parse((await read(metaPath))!) as Record<string, unknown>
    delete meta.history
    await fs.writeFile(metaPath, JSON.stringify(meta))
    const s = await syncSaves(ID, [saves], sA, deps('PC-A'), 'before-play')
    expect(s.conflict).toBeNull()
    expect(await read(join(saves, 'a.sav'))).toBe('B2')
  })

  it('never synced and both sides differ: a conflict', async () => {
    await write(join(otherSaves, 'a.sav'), 'B')
    await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'after-play')
    await write(join(saves, 'a.sav'), 'A')
    const s = await syncSaves(ID, [saves], state(), deps('PC-A'), 'before-play')
    expect(s.conflict).not.toBeNull()
    expect(await read(join(saves, 'a.sav'))).toBe('A')
  })

  it('Emulation folder missing: pending with an error, nothing touched', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const s = await syncSaves(ID, [saves], state(), deps('PC-A', gone()), 'before-play')
    expect(s).toMatchObject({ pending: true })
    expect(s.error).toMatch(/cannot be reached/)
    expect(await exists(join(tmp, 'gone'))).toBe(false)
    expect(await read(join(saves, 'a.sav'))).toBe('A1')
  })

  it('a copy still arriving (meta ahead of the files) is left alone', async () => {
    await write(join(otherSaves, 'a.sav'), 'B')
    await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'after-play')
    await write(join(base(), 'current', '0', 'a.sav'), 'half')
    await write(join(saves, 'a.sav'), 'A')
    const s = await syncSaves(ID, [saves], state(), deps('PC-A'), 'before-play')
    expect(s.pending).toBe(true)
    expect(s.error).toMatch(/still arriving/)
    expect(await read(join(saves, 'a.sav'))).toBe('A')
  })

  it("repairs this PC's own interrupted upload", async () => {
    await write(join(saves, 'a.sav'), 'A')
    const s1 = await syncSaves(ID, [saves], state(), deps(), 'after-play')
    await write(join(base(), 'current', '0', 'a.sav'), 'broken')
    const s2 = await syncSaves(ID, [saves], s1, deps(), 'before-play')
    expect(s2).toMatchObject({ pending: false, error: null })
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A')
  })

  it('no known save folders: an explanation, no change', async () => {
    const s = await syncSaves(ID, [], state(), deps(), 'manual')
    expect(s.error).toMatch(/does not know/)
    expect(await exists(base())).toBe(false)
  })

  it('refuses a broad save root', async () => {
    const s = await syncSaves(ID, ['C:\\'], state(), deps(), 'manual')
    expect(s.pending).toBe(true)
    expect(s.error).toMatch(/not a folder PlayOut syncs/)
  })

  it('refuses to restore across a different number of save folders', async () => {
    await write(join(otherSaves, 'a.sav'), 'B')
    await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'after-play')
    const two = [join(tmp, 'C', 'one'), join(tmp, 'C', 'two')]
    const s = await syncSaves(ID, two, state(), deps('PC-A'), 'before-play')
    expect(s.pending).toBe(true)
    expect(s.error).toMatch(/save folder/)
    expect(await exists(join(tmp, 'C'))).toBe(false)
  })

  it('syncs a single-file save root', async () => {
    const fileA = join(tmp, 'A', 'game.sav')
    const fileB = join(tmp, 'B', 'game.sav')
    await write(fileA, 'one')
    await syncSaves(ID, [fileA], state(), deps('PC-A'), 'after-play')
    const s = await syncSaves(ID, [fileB], state(), deps('PC-B'), 'before-play')
    expect(s.error).toBeNull()
    expect(await read(fileB)).toBe('one')
  })
})

describe('resolveConflict', () => {
  async function conflict(): Promise<RecompCloudState> {
    await write(join(saves, 'a.sav'), 'A1')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    await write(join(otherSaves, 'a.sav'), 'B-played')
    await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    await write(join(saves, 'a.sav'), 'A-played')
    const s = await syncSaves(ID, [saves], sA, deps('PC-A'), 'after-play')
    expect(s.conflict).not.toBeNull()
    return s
  }

  it('keep local: the cloud copy is backed up and replaced', async () => {
    const s = await resolveConflict(ID, [saves], await conflict(), 'local', deps('PC-A'))
    expect(s).toMatchObject({ conflict: null, pending: false, error: null })
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A-played')
    // PC-B backed up PC-A's first copy on PC-B; PC-A backs up PC-B's copy it replaces now.
    expect(await zips(copyBackups('PC-B'))).toHaveLength(1)
    expect(await zips(copyBackups('PC-A'))).toHaveLength(1)
    expect((await readCopyMeta(base()))?.machine).toBe('PC-A')
  })

  it('keep the copy: this PC is backed up and the copy put back', async () => {
    const s = await resolveConflict(ID, [saves], await conflict(), 'cloud', deps('PC-A'))
    expect(s).toMatchObject({ conflict: null, pending: false, error: null })
    expect(await read(join(saves, 'a.sav'))).toBe('B-played')
    expect(await zips(join(tmp, 'backups-PC-A', cloudSaveKey(ID)))).toHaveLength(1)
  })

  it('Emulation folder offline: pending, conflict kept', async () => {
    const c = await conflict()
    const s = await resolveConflict(ID, [saves], c, 'cloud', deps('PC-A', gone()))
    expect(s.pending).toBe(true)
    expect(s.conflict).toEqual(c.conflict)
    expect(await read(join(saves, 'a.sav'))).toBe('A-played')
  })
})

describe('copy safety', () => {
  it('files in current/ without a meta.json are a copy still arriving, never an empty copy', async () => {
    await write(join(base(), 'current', '0', 'a.sav'), 'from PC-B')
    await write(join(saves, 'a.sav'), 'A')
    const s = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    expect(s.pending).toBe(true)
    expect(s.error).toMatch(/still arriving/)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('from PC-B')
    expect(await exists(join(base(), 'meta.json'))).toBe(false)
  })

  it('an unreadable meta.json is not an empty copy either', async () => {
    await write(join(otherSaves, 'a.sav'), 'B')
    await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'after-play')
    await fs.writeFile(join(base(), 'meta.json'), '{"hash": "abc", "roo')
    await write(join(saves, 'a.sav'), 'A')
    const s = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    expect(s.pending).toBe(true)
    expect(s.error).toMatch(/still arriving/)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('B')
  })

  it('keep local over a copy without meta.json backs that copy up first', async () => {
    await write(join(base(), 'current', '0', 'a.sav'), 'orphan')
    await write(join(saves, 'a.sav'), 'A')
    const s = await resolveConflict(ID, [saves], state(), 'local', deps('PC-A'))
    expect(s.error).toBeNull()
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A')
    const backups = await zips(copyBackups())
    expect(backups).toEqual(['2026-11-14T10-00-00Z unknown PC.zip'])
    const zipPath = join(copyBackups(), backups[0])
    const entry = (await listZip(zipPath)).find((e) => e.name === '0/a.sav')!
    expect((await readZipEntry(zipPath, entry)).toString()).toBe('orphan')
  })

  it('a swap that fails puts the previous copy back', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const s1 = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    await write(join(saves, 'a.sav'), 'A2')
    const real = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('.playout-new') && String(to).endsWith('current')) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      return real(from, to)
    })
    let s2: RecompCloudState
    try {
      s2 = await syncSaves(ID, [saves], s1, deps('PC-A'), 'after-play')
    } finally {
      spy.mockRestore()
    }
    expect(s2.pending).toBe(true)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    expect((await fs.readdir(base())).filter((n) => n.startsWith('current')).sort()).toEqual([
      'current'
    ])
    // Not stuck: the next try uploads.
    const s3 = await syncSaves(ID, [saves], s2, deps('PC-A'), 'after-play')
    expect(s3).toMatchObject({ pending: false, error: null })
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A2')
  })

  it('a meta.json that cannot be written takes the new copy out again', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const s1 = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const before = await read(join(base(), 'meta.json'))
    await write(join(saves, 'a.sav'), 'A2')
    const real = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('meta.json')) throw Object.assign(new Error('nope'), { code: 'EIO' })
      return real(from, to)
    })
    let s2: RecompCloudState
    try {
      s2 = await syncSaves(ID, [saves], s1, deps('PC-A'), 'after-play')
    } finally {
      spy.mockRestore()
    }
    expect(s2.pending).toBe(true)
    expect(await read(join(base(), 'meta.json'))).toBe(before)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    const s3 = await syncSaves(ID, [saves], s2, deps('PC-A'), 'after-play')
    expect(s3).toMatchObject({ pending: false, error: null })
  })

  it('copies each saved folder back into the local folder with the same template, whatever the order', async () => {
    const a = [join(tmp, 'A', 'local'), join(tmp, 'A', 'docs')]
    const b = [join(tmp, 'B', 'docs'), join(tmp, 'B', 'local')]
    const tA = ['{local}/Foo/saves', '{documents}/Foo']
    const tB = ['{documents}/Foo', '{local}/Foo/saves']
    await write(join(a[0], 'l.sav'), 'local save')
    await write(join(a[1], 'd.sav'), 'docs save')
    await syncSaves(ID, a, state(), deps('PC-A', { templates: tA }), 'after-play')
    await write(join(b[0], 'stray.sav'), 'B docs')
    const sB = await resolveConflict(ID, b, state(), 'cloud', deps('PC-B', { templates: tB }))
    expect(sB.error).toBeNull()
    expect(await read(join(b[1], 'l.sav'))).toBe('local save')
    expect(await read(join(b[0], 'd.sav'))).toBe('docs save')
    expect(await exists(join(b[0], 'l.sav'))).toBe(false)
    // In step afterwards: the same saves hash the same on both PCs.
    const again = await syncSaves(ID, b, sB, deps('PC-B', { templates: tB }), 'before-play')
    expect(again).toMatchObject({ pending: false, error: null, conflict: null })
    expect(again.syncedHash).toBe(sB.syncedHash)
  })

  it("refuses to copy back into save folders that are not the copy's", async () => {
    await write(join(otherSaves, 'a.sav'), 'B')
    await syncSaves(
      ID,
      [otherSaves],
      state(),
      deps('PC-B', { templates: ['{documents}/Zelda'] }),
      'after-play'
    )
    const mine = join(tmp, 'C', 'saves')
    const s = await syncSaves(ID, [mine], state(), deps('PC-A'), 'before-play')
    expect(s.pending).toBe(true)
    expect(s.error).toMatch(/same save folders/)
    expect(await exists(join(tmp, 'C'))).toBe(false)
  })

  it('never syncs dot-folders of the profile, the Start Menu or Windows', () => {
    const profile = process.env.USERPROFILE ?? 'C:\\Users\\Ann'
    expect(isWritableSaveRoot(join(profile, '.ssh'))).toBe(false)
    expect(
      isWritableSaveRoot(
        join(profile, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
      )
    ).toBe(false)
    expect(isWritableSaveRoot(join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts'))).toBe(false)
    expect(isWritableSaveRoot(join(profile, 'AppData', 'Local', 'Zelda64Recompiled'))).toBe(true)
  })

  it('refuses a copy folder outside the Emulation folder', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const s = await syncSaves(
      ID,
      [saves],
      state(),
      deps('PC-A', { dir: join(tmp, 'elsewhere') }),
      'after-play'
    )
    expect(s.pending).toBe(true)
    expect(s.error).toMatch(/not inside the Emulation folder/)
    expect(await exists(join(tmp, 'elsewhere'))).toBe(false)
  })

  it('names work in progress so the Emulation folder sync leaves it out', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const s1 = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    await write(join(saves, 'a.sav'), 'A2')
    const seen: string[] = []
    const real = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      seen.push(String(from), String(to))
      return real(from, to)
    })
    try {
      await syncSaves(ID, [saves], s1, deps('PC-A'), 'after-play')
    } finally {
      spy.mockRestore()
    }
    const inCopy = seen
      // Everything renamed in the copy folder except the finished current/ and meta.json is work in progress.
      .filter((f) => f.startsWith(base()) && !/[\\/](current|meta\.json)$/.test(f))
      .map((f) => f.slice(emuDir.length + 1).replace(/\\/g, '/'))
    expect(inCopy.length).toBeGreaterThan(0)
    for (const rel of inCopy) expect(isExcluded(rel, { extraExcluded: [] })).toBe(true)
    // The copy itself is synced.
    expect(
      isExcluded(`${RECOMP_SAVES_FOLDER}/${FOLDER}/current/0/a.sav`, { extraExcluded: [] })
    ).toBe(false)
  })
})

describe('adoptOldCopy', () => {
  async function oldCopy(content = 'old cloud'): Promise<string> {
    // An older PlayOut's copy in a cloud folder: written by the same sync, then moved there.
    const drive = join(tmp, 'Drive')
    const old = oldCloudSaveDir(drive, ID)
    await fs.mkdir(drive, { recursive: true })
    await write(join(saves, 'a.sav'), content)
    await syncSaves(ID, [saves], state(), deps('PC-A', { rootDir: drive, dir: old }), 'after-play')
    await fs.rm(saves, { recursive: true, force: true })
    return old
  }

  it('copies a whole old copy into an empty Emulation folder place, leaving the old one as it was', async () => {
    const old = await oldCopy()
    const meta = await readCopyMeta(old)
    expect(await adoptOldCopy(old, base(), log)).toBe(true)
    expect(await readCopyMeta(base())).toEqual(meta)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('old cloud')
    expect(await read(join(old, 'current', '0', 'a.sav'))).toBe('old cloud')
    expect((await fs.readdir(base())).sort()).toEqual(['current', 'meta.json'])
    // Never twice: the copy there now wins.
    expect(await adoptOldCopy(old, base(), log)).toBe(false)
  })

  it('then follows the three-way rule with no last-synced hash: different saves are a conflict', async () => {
    const old = await oldCopy()
    await adoptOldCopy(old, base(), log)
    await write(join(saves, 'a.sav'), 'newer here')
    const s = await syncSaves(ID, [saves], state({ syncedHash: null }), deps('PC-A'), 'before-play')
    expect(s.conflict).not.toBeNull()
    expect(await read(join(saves, 'a.sav'))).toBe('newer here')
  })

  it('adopts nothing over an existing copy, from a missing folder, or from a broken copy', async () => {
    const old = await oldCopy()
    await write(join(base(), 'current', '0', 'x.sav'), 'here already')
    expect(await adoptOldCopy(old, base(), log)).toBe(false)
    expect(await adoptOldCopy(join(tmp, 'nowhere'), join(emuDir, 'other'), log)).toBe(false)
    await write(join(old, 'current', '0', 'a.sav'), 'changed after meta')
    expect(await adoptOldCopy(old, join(emuDir, 'third'), log)).toBe(false)
    expect(await exists(join(emuDir, 'third'))).toBe(false)
  })
})

/**
 * Make fs.readdir report the entries named `names` (in folders under `under`) as links, the way Windows lists OneDrive placeholders (cloud
 * files, hydrated or not): every reparse point is a link to readdir, while lstat shows the regular file or folder.
 */
function asPlaceholders(under: string, names: string[]): { mockRestore: () => void } {
  const real = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown>
  return vi.spyOn(fs, 'readdir').mockImplementation((async (p: unknown, opts?: unknown) => {
    const out = await real(p, opts)
    if (!(opts as { withFileTypes?: boolean } | undefined)?.withFileTypes) return out
    if (!String(p).startsWith(under)) return out
    return (out as Dirent[]).map((e) =>
      names.includes(e.name)
        ? Object.assign(Object.create(Object.getPrototypeOf(e) as object) as Dirent, e, {
            isSymbolicLink: () => true,
            isFile: () => false,
            isDirectory: () => false
          })
        : e
    )
  }) as never)
}

describe('restore safety', () => {
  it('a save that is a OneDrive placeholder is a save, never restored over without a word', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    await write(join(otherSaves, 'a.sav'), 'B own')
    const spy = asPlaceholders(otherSaves, ['a.sav'])
    let s: RecompCloudState
    try {
      s = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    } finally {
      spy.mockRestore()
    }
    expect(s.conflict).not.toBeNull()
    expect(await read(join(otherSaves, 'a.sav'))).toBe('B own')
  })

  it('a placeholder folder of saves is walked like a folder', async () => {
    await write(join(saves, 'slots', 'a.sav'), 'A1')
    await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    await write(join(otherSaves, 'slots', 'a.sav'), 'B own')
    const spy = asPlaceholders(otherSaves, ['slots'])
    let s: RecompCloudState
    try {
      s = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    } finally {
      spy.mockRestore()
    }
    expect(s.conflict).not.toBeNull()
    expect(await read(join(otherSaves, 'slots', 'a.sav'))).toBe('B own')
  })

  it('a real link (junction) inside a save folder is still not followed', async () => {
    const outside = join(tmp, 'outside')
    await write(join(outside, 'big.dat'), 'not a save')
    await write(join(saves, 'a.sav'), 'A1')
    await fs.symlink(outside, join(saves, 'linked'), 'junction')
    const s = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    expect(s.error).toBeNull()
    expect(await exists(join(base(), 'current', '0', 'linked'))).toBe(false)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
  })

  it('a placeholder that cannot be read: pending, nothing restored over it', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    await write(join(otherSaves, 'a.sav'), 'B own')
    const readdir = asPlaceholders(otherSaves, ['a.sav'])
    const realLstat = fs.lstat.bind(fs)
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation((async (p: unknown, o?: unknown) => {
      if (String(p).startsWith(otherSaves) && String(p).endsWith('a.sav'))
        throw Object.assign(new Error('The cloud operation was unsuccessful'), { code: 'EIO' })
      return realLstat(p as string, o as never)
    }) as never)
    let s: RecompCloudState
    try {
      s = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    } finally {
      lstat.mockRestore()
      readdir.mockRestore()
    }
    expect(s.pending).toBe(true)
    expect(s.error).toBeTruthy()
    expect(await read(join(otherSaves, 'a.sav'))).toBe('B own')
  })

  it('a save folder that cannot be read is never taken for an empty one and restored over', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await write(join(saves, 'locked', 'x.sav'), 'X1')
    await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    await write(join(otherSaves, 'locked', 'x.sav'), 'B own')
    const locked = join(otherSaves, 'locked')
    const real = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown>
    const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (p: unknown, o?: unknown) => {
      if (String(p) === locked) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      return real(p, o)
    }) as never)
    let s: RecompCloudState
    try {
      s = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    } finally {
      spy.mockRestore()
    }
    expect(s.pending).toBe(true)
    expect(s.error).toContain(locked)
    expect(await read(join(locked, 'x.sav'))).toBe('B own')
    expect(await exists(join(otherSaves, 'a.sav'))).toBe(false)
  })

  it("a restore that fails part way puts this PC's saves back as they were", async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await write(join(saves, 'b.sav'), 'B1')
    const sA = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    await write(join(otherSaves, 'a.sav'), 'A2')
    await write(join(otherSaves, 'a0.sav'), 'new')
    await write(join(otherSaves, 'b.sav'), 'B2')
    await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    const fromCopy = join(base(), 'current')
    const real = fs.copyFile.bind(fs)
    const spy = vi.spyOn(fs, 'copyFile').mockImplementation((async (
      from: unknown,
      to: unknown,
      mode?: unknown
    ) => {
      if (String(from).startsWith(fromCopy) && String(from).endsWith('b.sav'))
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      return real(from as string, to as string, mode as number)
    }) as never)
    let s: RecompCloudState
    try {
      s = await syncSaves(ID, [saves], sA, deps('PC-A'), 'before-play')
    } finally {
      spy.mockRestore()
    }
    expect(s.pending).toBe(true)
    expect(await read(join(saves, 'a.sav'))).toBe('A1')
    expect(await read(join(saves, 'b.sav'))).toBe('B1')
    expect(await exists(join(saves, 'a0.sav'))).toBe(false)
    expect((await hashSaves([saves])).hash).toBe(sA.syncedHash)
    // The backup made before the restore is kept, and nothing else is left in the backups folder.
    const dir = join(tmp, 'backups-PC-A', cloudSaveKey(ID))
    expect(await zips(dir)).toHaveLength(1)
    expect(await fs.readdir(dir)).toEqual(await zips(dir))
    // Not stuck: the next try copies back.
    const again = await syncSaves(ID, [saves], s, deps('PC-A'), 'before-play')
    expect(again).toMatchObject({ pending: false, error: null, conflict: null })
    expect(await read(join(saves, 'b.sav'))).toBe('B2')
  })

  it('the different-save-folders refusal is translated', async () => {
    await write(join(otherSaves, 'a.sav'), 'B')
    await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'after-play')
    const two = [join(tmp, 'C', 'one'), join(tmp, 'C', 'two')]
    setMainLanguage('es')
    let s: RecompCloudState
    try {
      s = await syncSaves(ID, two, state(), deps('PC-A'), 'before-play')
    } finally {
      setMainLanguage('en')
    }
    expect(s.pending).toBe(true)
    expect(s.error).not.toMatch(/same save folders/)
    expect(s.error).toContain('{local}/Zelda64Recompiled/saves')
  })
})

describe('interrupted copies, read-only saves and PCs sharing a name', () => {
  /** A rename spy that fails (EBUSY) for the targets `fails` picks, until `off`. */
  function busyRenames(fails: (to: string) => boolean): { off: () => void } {
    const real = fs.rename.bind(fs)
    let on = true
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (on && fails(String(to))) {
        const e = new Error('EBUSY: held') as NodeJS.ErrnoException
        e.code = 'EBUSY'
        throw e
      }
      return real(from, to)
    })
    return {
      off: () => {
        on = false
        spy.mockRestore()
      }
    }
  }

  const leftovers = async (): Promise<string[]> =>
    (await fs.readdir(base())).filter((n) => /\.playout-(new|old)$/.test(n))

  it('an upload cut off after the swap (meta.json and the take-out held) is finished by the next copy', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const a1 = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const b1 = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    expect(await read(join(otherSaves, 'a.sav'))).toBe('A1')
    await write(join(saves, 'a.sav'), 'A2')
    const busy = busyRenames((to) => to.endsWith('meta.json') || to.includes('current.failed'))
    let cut: RecompCloudState
    try {
      cut = await syncSaves(ID, [saves], a1, deps('PC-A'), 'after-play')
    } finally {
      busy.off()
    }
    expect(cut.error).toBeTruthy()
    // current/ holds A2 while meta.json still names A1: every PC would read "still arriving" for good.
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A2')
    expect((await readCopyMeta(base()))?.hash).toBe(a1.syncedHash)
    // The faults are over: the next copy finishes the upload, and the other PC then takes A2.
    const again = await syncSaves(ID, [saves], cut, deps('PC-A'), 'before-play')
    expect(again).toMatchObject({ pending: false, error: null, conflict: null })
    expect((await readCopyMeta(base()))?.hash).toBe((await hashSaves([saves])).hash)
    expect(await leftovers()).toEqual([])
    const b2 = await syncSaves(ID, [otherSaves], b1, deps('PC-B'), 'before-play')
    expect(b2).toMatchObject({ pending: false, error: null, conflict: null })
    expect(await read(join(otherSaves, 'a.sav'))).toBe('A2')
  })

  it('an upload stopped at meta.json (PlayOut closed) is finished after a restart, also with new saves since', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const a1 = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    await write(join(saves, 'a.sav'), 'A2')
    const real = fs.rename.bind(fs)
    let reached: () => void = noop
    const atMeta = new Promise<void>((ok) => (reached = ok))
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('meta.json')) {
        reached()
        return new Promise<void>(() => undefined) // PlayOut stops here
      }
      return real(from, to)
    })
    void syncSaves(ID, [saves], a1, deps('PC-A'), 'after-play')
    await atMeta
    spy.mockRestore()
    // Restarted: the stored state is still A1's, and the player has changed the saves again since.
    await write(join(saves, 'a.sav'), 'A3')
    const next = await syncSaves(ID, [saves], a1, deps('PC-A'), 'manual')
    expect(next).toMatchObject({ pending: false, error: null, conflict: null })
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A3')
    expect((await readCopyMeta(base()))?.hash).toBe((await hashSaves([saves])).hash)
    expect(await leftovers()).toEqual([])
  })

  it('an unfinished current/ next to the set-aside copy is undone (and backed up), then the copy goes on', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    const a1 = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    // Left by an upload cut off before a pending meta.json was written (older versions wrote none).
    await fs.rename(join(base(), 'current'), join(base(), 'current.0a1b2c3d.playout-old'))
    await write(join(base(), 'current', '0', 'a.sav'), 'HALF')
    await write(join(saves, 'a.sav'), 'A2')
    const next = await syncSaves(ID, [saves], a1, deps('PC-A'), 'after-play')
    expect(next).toMatchObject({ pending: false, error: null, conflict: null })
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A2')
    expect(await leftovers()).toEqual([])
    expect((await zips(copyBackups())).some((z) => z.includes('unfinished copy'))).toBe(true)
  })

  it('another PC with the same name never counts as this one: its copy still arriving is waited for', async () => {
    const pcA = deps('GAMING-PC', { machineId: 'id-a', backupsDir: join(tmp, 'backups-a') })
    const pcB = deps('GAMING-PC', { machineId: 'id-b', backupsDir: join(tmp, 'backups-b') })
    await write(join(saves, 'a.sav'), 'A1')
    const a1 = await syncSaves(ID, [saves], state(), pcA, 'after-play')
    const b1 = await syncSaves(ID, [otherSaves], state(), pcB, 'before-play')
    await write(join(otherSaves, 'a.sav'), 'B2-NEWEST')
    await syncSaves(ID, [otherSaves], b1, pcB, 'after-play')
    const bMeta = await readCopyMeta(base())
    expect(bMeta?.machineId).toBe('id-b')
    // On this side of the sync, the other PC's meta.json has arrived and its save not yet.
    await write(join(base(), 'current', '0', 'a.sav'), 'A1')
    const a2 = await syncSaves(ID, [saves], a1, pcA, 'manual')
    expect(a2.pending).toBe(true)
    expect(a2.error).toMatch(/still arriving/)
    expect((await readCopyMeta(base()))?.hash).toBe(bMeta?.hash)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
  })

  it('a read-only save is restored over (and stays read-only), on every PC', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await fs.chmod(join(saves, 'a.sav'), 0o444)
    const a1 = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const b1 = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    expect(await read(join(otherSaves, 'a.sav'))).toBe('A1')
    await fs.chmod(join(saves, 'a.sav'), 0o666)
    await write(join(saves, 'a.sav'), 'A2')
    await fs.chmod(join(saves, 'a.sav'), 0o444)
    const a2 = await syncSaves(ID, [saves], a1, deps('PC-A'), 'after-play')
    expect(a2).toMatchObject({ pending: false, error: null })
    const b2 = await syncSaves(ID, [otherSaves], b1, deps('PC-B'), 'before-play')
    expect(b2).toMatchObject({ pending: false, error: null, conflict: null })
    expect(await read(join(otherSaves, 'a.sav'))).toBe('A2')
    expect((await fs.stat(join(otherSaves, 'a.sav'))).mode & 0o200).toBe(0)
    // Writable again, so the temp folder can be removed.
    for (const f of [join(saves, 'a.sav'), join(otherSaves, 'a.sav')]) await fs.chmod(f, 0o666)
  })
})

describe('saves gone from a PC that synced them before (asked first)', () => {
  /** PC-A copied its saves, then they were deleted from PC-A. */
  async function deletedAfterSync(): Promise<RecompCloudState> {
    await write(join(saves, 'a.sav'), 'A1')
    const s = await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    expect(s.syncedHash).not.toBeNull()
    await fs.rm(saves, { recursive: true })
    return s
  }

  it('asks instead of copying back, and touches nothing', async () => {
    const s0 = await deletedAfterSync()
    const s = await syncSaves(ID, [saves], s0, deps('PC-A'), 'before-play')
    expect(s.conflict).toMatchObject({ gone: true, cloudDevice: 'PC-A' })
    expect(s).toMatchObject({ localHash: null, pending: false, error: null })
    expect(await exists(join(saves, 'a.sav'))).toBe(false)
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    // Asked again until answered.
    const again = await syncSaves(ID, [saves], s, deps('PC-A'), 'before-play')
    expect(again.conflict?.gone).toBe(true)
  })

  it('Restore from the Emulation folder copies them back', async () => {
    const asked = await syncSaves(ID, [saves], await deletedAfterSync(), deps(), 'before-play')
    const s = await resolveConflict(ID, [saves], asked, 'cloud', deps())
    expect(s).toMatchObject({ conflict: null, pending: false, error: null })
    expect(s.freshStart).toBeUndefined()
    expect(await read(join(saves, 'a.sav'))).toBe('A1')
    expect(s.syncedHash).toBe((await hashSaves([saves])).hash)
  })

  it('Start fresh: the game starts with none, then the next upload replaces the copy (backed up first)', async () => {
    const s0 = await deletedAfterSync()
    const copied = s0.syncedHash
    const asked = await syncSaves(ID, [saves], s0, deps(), 'before-play')
    const fresh = await resolveConflict(ID, [saves], asked, 'fresh', deps())
    expect(fresh).toMatchObject({ conflict: null, pending: false, error: null, freshStart: true })
    expect(fresh.syncedHash).toBe(copied)
    // Nothing deleted: the copy stays as it was.
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    // The next start: no question, nothing copied back.
    const before = await syncSaves(ID, [saves], fresh, deps(), 'before-play')
    expect(before.conflict).toBeNull()
    expect(before.freshStart).toBe(true)
    expect(await exists(join(saves, 'a.sav'))).toBe(false)
    // An after-play with still no saves keeps the copy.
    const empty = await syncSaves(ID, [saves], before, deps(), 'after-play')
    expect(empty.conflict).toBeNull()
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    // The game made new saves: they are newer, the copy is backed up into "replaced copies" and replaced.
    await write(join(saves, 'new.sav'), 'N1')
    const after = await syncSaves(ID, [saves], empty, deps(), 'after-play')
    expect(after).toMatchObject({ conflict: null, pending: false, error: null })
    expect(after.freshStart).toBeUndefined()
    expect(after.syncedHash).toBe((await hashSaves([saves])).hash)
    expect(await read(join(base(), 'current', '0', 'new.sav'))).toBe('N1')
    expect(await exists(join(base(), 'current', '0', 'a.sav'))).toBe(false)
    const backups = await zips(copyBackups())
    expect(backups).toHaveLength(1)
    const zipPath = join(copyBackups(), backups[0])
    const entry = (await listZip(zipPath)).find((e) => e.name === '0/a.sav')!
    expect((await readZipEntry(zipPath, entry)).toString()).toBe('A1')
    expect((await readCopyMeta(base()))?.history).toEqual([copied])
  })

  it('after Start fresh, a copy another PC moved on asks again', async () => {
    const s0 = await deletedAfterSync()
    const asked = await syncSaves(ID, [saves], s0, deps('PC-A'), 'before-play')
    const fresh = await resolveConflict(ID, [saves], asked, 'fresh', deps('PC-A'))
    const sB = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    await write(join(otherSaves, 'a.sav'), 'B2')
    await syncSaves(ID, [otherSaves], sB, deps('PC-B'), 'after-play')
    const s = await syncSaves(ID, [saves], fresh, deps('PC-A'), 'before-play')
    expect(s.conflict).toMatchObject({ gone: true, cloudDevice: 'PC-B' })
    expect(await exists(join(saves, 'a.sav'))).toBe(false)
  })

  it('a PC that never synced the game and has no saves still takes the copy silently', async () => {
    await write(join(saves, 'a.sav'), 'A1')
    await syncSaves(ID, [saves], state(), deps('PC-A'), 'after-play')
    const s = await syncSaves(ID, [otherSaves], state(), deps('PC-B'), 'before-play')
    expect(s.conflict).toBeNull()
    expect(await read(join(otherSaves, 'a.sav'))).toBe('A1')
  })

  it('unanswered while new saves appear (a stream started the game): both sides are asked about, nothing replaced', async () => {
    const asked = await syncSaves(ID, [saves], await deletedAfterSync(), deps(), 'before-play')
    await write(join(saves, 'new.sav'), 'N1')
    const s = await syncSaves(ID, [saves], asked, deps(), 'after-play')
    expect(s.conflict).not.toBeNull()
    expect(s.conflict?.gone).toBeUndefined()
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    expect(await exists(join(base(), 'current', '0', 'new.sav'))).toBe(false)
    expect(await zips(copyBackups())).toHaveLength(0)
  })

  it('Start fresh pressed after the saves came back changes nothing (never uploads them over the copy)', async () => {
    const asked = await syncSaves(ID, [saves], await deletedAfterSync(), deps(), 'before-play')
    expect(asked.conflict?.gone).toBe(true)
    // A stream made saves meanwhile; the player still sees (and answers) the older question.
    await write(join(saves, 'new.sav'), 'N1')
    await expect(resolveConflict(ID, [saves], asked, 'fresh', deps())).rejects.toBeInstanceOf(
      FreshChangedError
    )
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
    expect(await exists(join(base(), 'current', '0', 'new.sav'))).toBe(false)
    // Not to a two-sided conflict either, and 'local' no longer means Start fresh with no saves here.
    await expect(
      resolveConflict(
        ID,
        [saves],
        { ...asked, conflict: { ...asked.conflict!, gone: undefined } },
        'fresh',
        deps()
      )
    ).rejects.toBeInstanceOf(FreshChangedError)
    await fs.rm(join(saves, 'new.sav'))
    const noLocal = await resolveConflict(ID, [saves], asked, 'local', deps())
    expect(noLocal.error).toBeTruthy()
    expect(noLocal.freshStart).toBeUndefined()
    expect(await read(join(base(), 'current', '0', 'a.sav'))).toBe('A1')
  })
})
