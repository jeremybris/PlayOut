import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { existsSync, promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRecompState,
  emptyManifest,
  parseRecompManifest,
  recompManifestPath,
  resolveRecompRoot
} from './state'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'recomp-state-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createRecompState', () => {
  it('reads empty when there is no manifest', async () => {
    expect(await createRecompState(root).read()).toEqual(emptyManifest())
  })

  it('writes atomically and reads back', async () => {
    const state = createRecompState(root)
    await state.update((m) => {
      m.preferred['n64:majoras mask'] = 'github:zelda64recomp/zelda64recomp'
      m.cloudDir = 'G:\\My Drive'
    })
    const text = await readFile(recompManifestPath(root), 'utf8')
    expect(JSON.parse(text).cloudDir).toBe('G:\\My Drive')
    const fresh = await createRecompState(root).read()
    expect(fresh.preferred['n64:majoras mask']).toBe('github:zelda64recomp/zelda64recomp')
  })

  it('serializes concurrent updates', async () => {
    const state = createRecompState(root)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        state.update(async (m) => {
          const n = Number(m.preferred.count ?? '0')
          await new Promise((r) => setTimeout(r, i % 3))
          m.preferred.count = String(n + 1)
        })
      )
    )
    expect((await state.read()).preferred.count).toBe('20')
  })

  it('writes nothing when the change throws, and keeps going', async () => {
    const state = createRecompState(root)
    await expect(
      state.update((m) => {
        m.cloudDir = 'X:\\nope'
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect((await state.read()).cloudDir).toBeNull()
    await state.update((m) => {
      m.cloudDir = 'D:\\Dropbox'
    })
    expect((await state.read()).cloudDir).toBe('D:\\Dropbox')
  })

  it('returns copies (callers cannot change the cached manifest)', async () => {
    const state = createRecompState(root)
    const a = await state.read()
    a.preferred.x = 'y'
    expect((await state.read()).preferred.x).toBeUndefined()
  })

  it('never takes a manifest it cannot read for an empty one (a write would erase it)', async () => {
    const seed = createRecompState(root)
    await seed.update((m) => {
      m.cloudDir = 'G:\\My Drive'
    })
    const before = await readFile(recompManifestPath(root), 'utf8')
    const realRead = fsp.readFile
    let fails = Infinity
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation(((
      ...args: Parameters<typeof realRead>
    ) => {
      if (fails-- > 0) return Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' }))
      return realRead(...args)
    }) as typeof realRead)
    try {
      const state = createRecompState(root)
      await expect(state.read()).rejects.toThrow(/cannot be read/)
      await expect(
        state.update((m) => {
          m.preferred.x = 'y'
        })
      ).rejects.toThrow(/cannot be read/)
      expect(await readFile(recompManifestPath(root), 'utf8')).toBe(before)
      // A lock that clears: read again, nothing lost.
      fails = 2
      expect((await state.read()).cloudDir).toBe('G:\\My Drive')
    } finally {
      spy.mockRestore()
    }
  }, 20_000)

  it('sets a damaged manifest aside as .bad', async () => {
    const file = recompManifestPath(root)
    await mkdir(join(root, '.playout'), { recursive: true })
    await writeFile(file, '{ not json')
    expect(await createRecompState(root).read()).toEqual(emptyManifest())
    expect(existsSync(`${file}.bad`)).toBe(true)
  })

  it('fills in missing fields of installed records and drops unusable ones', () => {
    const m = parseRecompManifest(
      JSON.stringify({
        version: 1,
        installed: {
          'github:a/b': {
            dir: 'C:\\R\\B',
            tag: 'v1',
            releaseFiles: ['b.exe', 3],
            gameFiles: { game: { path: 'C:\\rom.z64' } }
          },
          broken: { tag: 'v1' },
          worse: 'nope'
        },
        preferred: { k: 'github:a/b', bad: 4 },
        cloudDir: 7
      })
    )
    expect(Object.keys(m.installed)).toEqual(['github:a/b'])
    const rec = m.installed['github:a/b']!
    expect(rec).toMatchObject({
      id: 'github:a/b',
      dir: 'C:\\R\\B',
      releaseFiles: ['b.exe'],
      autoUpdate: false,
      verified: 'unverified',
      saveSource: null,
      gameFiles: { game: { path: 'C:\\rom.z64', source: 'picked' } },
      // No stored state: copying the saves to the Emulation folder is on, as for a new install.
      cloud: { enabled: true, conflict: null }
    })
    expect(rec.saveSuggestions).toBeUndefined()
    // No program choice in an older manifest: PlayOut's pick.
    expect(rec.exeChosen).toBeUndefined()
    expect(rec.autoExe).toBeUndefined()
    expect(m.preferred).toEqual({ k: 'github:a/b' })
    expect(m.cloudDir).toBeNull()
    expect(m.savesMigrated).toBe(false)
    // No pin in an older manifest: it follows the newest release.
    expect(rec.pinnedTag).toBeNull()
  })

  it('reads the disc-image questions and the identified program back, dropping broken ones', () => {
    const m = parseRecompManifest(
      JSON.stringify({
        version: 1,
        installed: {
          'github:a/b': {
            dir: 'C:\\R\\B',
            tag: 'v1',
            exeIdentified: { exe: 'c:\\r\\b\\game.exe', by: 'auto', starts: 2 }
          },
          'github:c/d': { dir: 'C:\\R\\D', tag: 'v1', exeIdentified: { exe: 'x', by: 'robot' } }
        },
        imageOffers: {
          'github:a/b|d:\\game.iso': {
            state: 'kept',
            recompId: 'github:a/b',
            gameId: 'rom:ps2:x',
            image: 'D:\\Game.iso',
            at: '2026-11-18T00:00:00.000Z'
          },
          bad: { state: 'maybe', recompId: 'x', gameId: 'y', image: 'z' },
          'no-image': { state: 'pending', recompId: 'x', gameId: 'y' }
        }
      })
    )
    expect(m.installed['github:a/b']?.exeIdentified).toEqual({
      exe: 'c:\\r\\b\\game.exe',
      by: 'auto',
      starts: 2
    })
    expect(m.installed['github:c/d']?.exeIdentified).toBeUndefined()
    expect(Object.keys(m.imageOffers)).toEqual(['github:a/b|d:\\game.iso'])
    expect(m.imageOffers['github:a/b|d:\\game.iso']?.state).toBe('kept')
    expect(parseRecompManifest('{}').imageOffers).toEqual({})
  })

  it('reads the unpacked game folders and folder questions back, dropping broken ones', () => {
    const folder = 'C:\\Users\\me\\Games\\BR\\game'
    const m = parseRecompManifest(
      JSON.stringify({
        imageOffers: {
          'x|folder|c:\\users\\me\\games\\br\\game': {
            state: 'pending',
            recompId: 'x',
            gameId: 'rom:xbox360:br',
            image: null,
            folder,
            at: '2026-11-18T00:00:00.000Z'
          },
          'x|d:\\br.iso': {
            state: 'kept',
            recompId: 'x',
            gameId: 'rom:xbox360:br',
            image: 'D:\\BR.iso',
            folder,
            at: '2026-11-18T00:00:00.000Z'
          }
        },
        unpackedFolders: {
          'c:\\users\\me\\games\\br\\game': {
            folder,
            recompId: 'x',
            gameId: 'rom:xbox360:br',
            at: '2026-11-18T00:00:00.000Z',
            state: 'kept'
          },
          bad: { folder, recompId: 'x', gameId: 'y', state: 'gone' },
          nofolder: { recompId: 'x', gameId: 'y', state: 'unpacked' }
        }
      })
    )
    expect(m.imageOffers['x|folder|c:\\users\\me\\games\\br\\game']).toMatchObject({
      image: null,
      folder
    })
    expect(m.imageOffers['x|d:\\br.iso']).toMatchObject({ image: 'D:\\BR.iso', folder })
    expect(Object.keys(m.unpackedFolders)).toEqual(['c:\\users\\me\\games\\br\\game'])
    expect(m.unpackedFolders['c:\\users\\me\\games\\br\\game']?.state).toBe('kept')
    expect(parseRecompManifest('{}').unpackedFolders).toEqual({})
  })

  it('reads held images back, keeping only entries PlayOut made for that hold', () => {
    const id = 'm3x9k2-4f7a1c'
    const iso = 'D:\\ROMs\\ps2\\Okami.iso'
    const held = 'D:\\ROMs\\ps2\\.playout-held\\m3x9k2-4f7a1c\\Okami.iso'
    const m = parseRecompManifest(
      JSON.stringify({
        heldImages: {
          [id]: {
            recompId: 'x',
            gameId: 'rom:ps2:okami',
            offerKey: 'x|d:\\roms\\ps2\\okami.iso',
            image: iso,
            folder: null,
            entries: [
              { original: iso, held },
              // Not this hold's path: dropped (never renamed or trashed).
              { original: 'D:\\ROMs\\ps2\\Other.iso', held: 'C:\\Windows\\Other.iso' }
            ],
            at: '2026-11-18T00:00:00.000Z',
            state: 'crashed',
            reason: 'it closed',
            decidedAt: '2026-11-18T00:00:21.000Z'
          },
          '../bad': { recompId: 'x', gameId: 'y', entries: [], state: 'testing' },
          'okid-123456': { recompId: 'x', gameId: 'y', entries: [], state: 'gone' }
        }
      })
    )
    expect(Object.keys(m.heldImages)).toEqual([id])
    expect(m.heldImages[id]).toEqual({
      holdId: id,
      recompId: 'x',
      gameId: 'rom:ps2:okami',
      offerKey: 'x|d:\\roms\\ps2\\okami.iso',
      image: iso,
      folder: null,
      entries: [{ original: iso, held }],
      at: '2026-11-18T00:00:00.000Z',
      state: 'crashed',
      reason: 'it closed',
      decidedAt: '2026-11-18T00:00:21.000Z'
    })
    expect(parseRecompManifest('{}').heldImages).toEqual({})
  })

  it('reads a pinned version back', () => {
    const m = parseRecompManifest(
      JSON.stringify({
        version: 1,
        installed: {
          'github:a/b': { dir: 'C:\\R\\B', tag: 'v1', prevTag: 'v2', pinnedTag: 'v1' },
          'github:c/d': { dir: 'C:\\R\\D', tag: 'v1', pinnedTag: 5 }
        }
      })
    )
    expect(m.installed['github:a/b']).toMatchObject({ pinnedTag: 'v1', prevTag: 'v2' })
    expect(m.installed['github:c/d']?.pinnedTag).toBeNull()
  })
})

describe('the program the user chose', () => {
  it('reads back, and an incomplete choice is dropped', () => {
    const m = parseRecompManifest(
      JSON.stringify({
        installed: {
          chosen: {
            dir: 'C:\\R\\A',
            tag: 'v1',
            exe: 'D:\\Games\\A\\A.exe',
            exeChosen: 'user',
            autoExe: 'A_Installer.exe'
          },
          noExe: { dir: 'C:\\R\\B', tag: 'v1', exe: null, exeChosen: 'user' },
          other: { dir: 'C:\\R\\C', tag: 'v1', exe: 'c.exe', exeChosen: 'robot' },
          confirmed: { dir: 'C:\\R\\D', tag: 'v1', exe: 'd.exe', exeChosen: 'confirmed' }
        }
      })
    )
    expect(m.installed.chosen).toMatchObject({
      exe: 'D:\\Games\\A\\A.exe',
      exeChosen: 'user',
      autoExe: 'A_Installer.exe'
    })
    expect(m.installed.noExe?.exeChosen).toBeUndefined()
    expect(m.installed.other?.exeChosen).toBeUndefined()
    // PlayOut's pick, accepted by the player (Automatic, or it started the game).
    expect(m.installed.confirmed).toMatchObject({ exe: 'd.exe', exeChosen: 'confirmed' })
    expect(m.installed.confirmed?.autoExe).toBeUndefined()
  })
})

describe('resolveRecompRoot', () => {
  it('uses the folder next to PlayOut.exe when it can be written', async () => {
    const exeDir = join(root, 'PlayOut')
    const userData = join(root, 'userData')
    expect(await resolveRecompRoot(exeDir, userData, { programFilesDirs: [] })).toBe(
      join(exeDir, 'Recompilations')
    )
  })

  it('never uses Program Files', async () => {
    const pf = join(root, 'Program Files')
    const exeDir = join(pf, 'PlayOut')
    const userData = join(root, 'userData')
    expect(await resolveRecompRoot(exeDir, userData, { programFilesDirs: [pf] })).toBe(
      join(userData, 'Recompilations')
    )
    expect(existsSync(join(userData, 'Recompilations'))).toBe(true)
  })

  it('keeps a root that already holds installs', async () => {
    const exeDir = join(root, 'PlayOut')
    const userData = join(root, 'userData')
    const fallback = join(userData, 'Recompilations')
    await createRecompState(fallback).update((m) => {
      m.installed['github:a/b'] = parseRecompManifest(
        JSON.stringify({ installed: { 'github:a/b': { dir: join(fallback, 'B'), tag: 'v1' } } })
      ).installed['github:a/b']!
    })
    expect(await resolveRecompRoot(exeDir, userData, { programFilesDirs: [] })).toBe(fallback)
  })
})
