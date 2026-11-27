import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameFileNeed, GameFileState } from '../../shared/recomp'
import type { Logger } from '../logger'
import {
  applyCopies,
  autoPick,
  dropMissingPaths,
  gameFileStates,
  libraryFilesFor,
  mergeProfileNeeds,
  prepareLaunch,
  readDeveloperProfile,
  verifyGameFile,
  type DigestCache
} from './gamefiles'

const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function need(over: Partial<GameFileNeed> = {}): GameFileNeed {
  return {
    id: 'game',
    label: 'Your ROM',
    description: 'The USA N64 ROM',
    kind: 'game',
    how: 'flag',
    accepts: 'file',
    formats: ['.z64'],
    optional: false,
    hashes: [],
    ...over
  }
}

function state(over: Partial<GameFileState> = {}): GameFileState {
  return { ...need(), path: null, source: null, verified: null, ready: false, ...over }
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-gamefiles-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('libraryFilesFor', () => {
  it('lists the ROM of an emulated game once', () => {
    const rom = 'D:\\Roms\\n64\\Zelda (USA).z64'
    expect(
      libraryFilesFor({
        source: 'rom',
        romPath: rom,
        installDir: 'D:\\Roms\\n64',
        launch: { kind: 'emulator', systemId: 'n64', romPath: rom.toUpperCase() }
      })
    ).toEqual([rom])
  })

  it('lists the install folder of a PC game', () => {
    expect(
      libraryFilesFor({
        source: 'gog',
        installDir: 'C:\\GOG Games\\Diablo',
        launch: { kind: 'exec', file: 'x.exe', args: [] }
      })
    ).toEqual(['C:\\GOG Games\\Diablo'])
  })
})

describe('autoPick', () => {
  const rom = 'D:\\Roms\\mm.z64'
  it('picks a library file with an accepted extension for game needs only', () => {
    const states = [
      state({ id: 'game' }),
      state({ id: 'bios', kind: 'bios', formats: [] }),
      state({ id: 'iso', formats: ['.iso'] })
    ]
    expect(autoPick(states, [rom])).toEqual({ game: { path: rom, source: 'library' } })
  })

  it('accepts any file when no formats are listed, folders only for folder needs', () => {
    const folder = 'C:\\Games\\Diablo 1.09'
    expect(autoPick([state({ formats: [] })], [folder, rom])).toEqual({
      game: { path: rom, source: 'library' }
    })
    expect(autoPick([state({ accepts: 'folder', formats: [] })], [rom, folder])).toEqual({
      game: { path: folder, source: 'library' }
    })
    expect(autoPick([state({ accepts: 'either', formats: ['.iso'] })], [rom, folder])).toEqual({
      game: { path: folder, source: 'library' }
    })
  })

  it('leaves needs that already have a path and never gives one file to two needs', () => {
    const states = [
      state({ id: 'a', path: 'E:\\other.z64', source: 'picked' }),
      state({ id: 'b' }),
      state({ id: 'c' })
    ]
    expect(autoPick(states, [rom])).toEqual({ b: { path: rom, source: 'library' } })
    expect(
      autoPick([state({ id: 'x', path: rom, source: 'picked' }), state({ id: 'y' })], [rom])
    ).toEqual({})
  })
})

describe('gameFileStates', () => {
  const rom = 'D:\\Roms\\mm.z64'
  it('uses the stored pick, else the library, and works out readiness', () => {
    const entry = {
      needs: [
        need({ id: 'game' }),
        need({ id: 'dlc', kind: 'dlc', optional: true }),
        need({ id: 'self', how: 'self' }),
        need({ id: 'none', how: 'none' })
      ]
    }
    const s = gameFileStates(entry, null, [rom], { [rom]: 'match' })
    expect(s.map((x) => x.id)).toEqual(['game', 'dlc', 'self'])
    expect(s[0]).toMatchObject({ path: rom, source: 'library', verified: 'match', ready: true })
    expect(s[1]).toMatchObject({ path: null, ready: true })
    expect(s[2]).toMatchObject({ path: null, ready: true })

    const picked = gameFileStates(
      entry,
      { gameFiles: { game: { path: 'E:\\mine.z64', source: 'picked' } } },
      [rom],
      {}
    )
    expect(picked[0]).toMatchObject({
      path: 'E:\\mine.z64',
      source: 'picked',
      verified: null,
      ready: true
    })
  })

  it('does not trust a library file known to be the wrong dump, but respects an explicit pick', () => {
    const entry = { needs: [need()] }
    expect(gameFileStates(entry, null, [rom], { [rom]: 'mismatch' })[0]).toMatchObject({
      path: rom,
      verified: 'mismatch',
      ready: false
    })
    const picked = { gameFiles: { game: { path: rom, source: 'picked' as const } } }
    expect(gameFileStates(entry, picked, [], { [rom]: 'mismatch' })[0].ready).toBe(true)
  })

  it('is not ready without a file', () => {
    expect(gameFileStates({ needs: [need()] }, null, [], {})[0]).toMatchObject({
      path: null,
      ready: false
    })
  })
})

describe('dropMissingPaths', () => {
  it('clears paths that are gone or of the wrong type', async () => {
    const file = join(dir, 'a.z64')
    await fs.writeFile(file, 'x')
    const out = await dropMissingPaths([
      state({ id: 'ok', path: file, source: 'picked', ready: true }),
      state({ id: 'gone', path: join(dir, 'nope.z64'), source: 'picked', ready: true }),
      state({ id: 'dir', path: dir, source: 'library', ready: true }),
      state({ id: 'opt', optional: true, path: join(dir, 'nope'), ready: true })
    ])
    expect(out.map((s) => [s.id, s.path, s.ready])).toEqual([
      ['ok', file, true],
      ['gone', null, false],
      ['dir', null, false],
      ['opt', null, true]
    ])
  })
})

describe('verifyGameFile', () => {
  const data = Buffer.from("The Legend of Zelda: Majora's Mask".repeat(50000))
  const sha1 = createHash('sha1').update(data).digest('hex')
  const md5 = createHash('md5').update(data).digest('hex')
  const sha256 = createHash('sha256').update(data).digest('hex')

  it('matches any known hash, by any algorithm, including crc32', async () => {
    const file = join(dir, 'mm.z64')
    await fs.writeFile(file, data)
    const crc = Buffer.from('123456789')
    const crcFile = join(dir, 'check.bin')
    await fs.writeFile(crcFile, crc)

    expect(
      await verifyGameFile(file, { hashes: [{ algo: 'sha1', value: sha1.toUpperCase() }] })
    ).toBe('match')
    expect(await verifyGameFile(file, { hashes: [{ algo: 'md5', value: md5 }] })).toBe('match')
    expect(
      await verifyGameFile(file, {
        hashes: [
          { algo: 'sha256', value: '0'.repeat(64) },
          { algo: 'sha256', value: sha256 }
        ]
      })
    ).toBe('match')
    // The standard CRC-32 check value of "123456789".
    expect(await verifyGameFile(crcFile, { hashes: [{ algo: 'crc32', value: 'CBF43926' }] })).toBe(
      'match'
    )
    expect(await verifyGameFile(file, { hashes: [{ algo: 'sha1', value: 'f'.repeat(40) }] })).toBe(
      'mismatch'
    )
  })

  it('is unverified without hashes, for folders and for missing files', async () => {
    const file = join(dir, 'a.bin')
    await fs.writeFile(file, 'x')
    expect(await verifyGameFile(file, { hashes: [] })).toBe('unverified')
    expect(await verifyGameFile(dir, { hashes: [{ algo: 'md5', value: md5 }] })).toBe('unverified')
    expect(await verifyGameFile(join(dir, 'nope'), { hashes: [{ algo: 'md5', value: md5 }] })).toBe(
      'unverified'
    )
  })

  it('reuses cached digests until the file changes', async () => {
    const file = join(dir, 'mm.z64')
    await fs.writeFile(file, data)
    const cache: DigestCache = new Map()
    expect(await verifyGameFile(file, { hashes: [{ algo: 'sha1', value: sha1 }] }, cache)).toBe(
      'match'
    )
    const [key] = [...cache.keys()]
    // Poison the cache: a cached digest is trusted while size and mtime are the same.
    cache.set(key, { sha1: 'f'.repeat(40) })
    expect(await verifyGameFile(file, { hashes: [{ algo: 'sha1', value: sha1 }] }, cache)).toBe(
      'mismatch'
    )
    // A new algorithm is computed and added to the same record.
    expect(await verifyGameFile(file, { hashes: [{ algo: 'md5', value: md5 }] }, cache)).toBe(
      'match'
    )
    expect(cache.get(key)).toMatchObject({ md5 })

    await fs.writeFile(file, Buffer.concat([data, Buffer.from('!')]))
    await fs.utimes(file, new Date(), new Date(Date.now() + 10000))
    expect(await verifyGameFile(file, { hashes: [{ algo: 'sha1', value: sha1 }] }, cache)).toBe(
      'mismatch'
    )
    expect(cache.size).toBe(2)
  })
})

describe('prepareLaunch', () => {
  const installed = { dir: 'C:\\Recomps\\Zelda' }
  const entry = { id: 'github:zelda64recomp/zelda64recomp' }

  it('passes flags, bare arguments, "=" flags and environment variables', () => {
    const p = prepareLaunch(entry, installed, [
      state({ id: 'a', how: 'flag', flag: '--rom', path: 'D:\\a.z64', ready: true }),
      state({ id: 'b', how: 'flag', flag: '', path: 'D:\\b.iso', ready: true }),
      state({ id: 'c', how: 'flag', flag: '--game=', path: 'D:\\c', ready: true }),
      state({ id: 'd', how: 'env', env: 'GAME_ISO', path: 'D:\\d.iso', ready: true })
    ])
    expect(p.args).toEqual(['--rom', 'D:\\a.z64', 'D:\\b.iso', '--game=D:\\c'])
    expect(p.env).toEqual({ GAME_ISO: 'D:\\d.iso' })
    expect(p.copies).toEqual([])
    expect(p.missing).toEqual([])
  })

  it('copies folder needs into the install and never outside it', () => {
    const p = prepareLaunch(entry, installed, [
      state({
        id: 'a',
        how: 'folder',
        folder: 'assets',
        fileName: 'baserom.z64',
        path: 'D:\\x.z64',
        ready: true
      }),
      state({ id: 'b', how: 'folder', folder: 'roms', path: 'D:\\y.z64', ready: true }),
      state({
        id: 'c',
        how: 'folder',
        folder: '..\\..\\Windows',
        path: 'D:\\evil.z64',
        ready: true
      }),
      state({
        id: 'd',
        how: 'folder',
        folder: 'assets',
        fileName: 'baserom.z64',
        path: join(installed.dir, 'assets', 'baserom.z64'),
        ready: true
      })
    ])
    expect(p.copies).toEqual([
      { from: 'D:\\x.z64', to: join(installed.dir, 'assets', 'baserom.z64') },
      { from: 'D:\\y.z64', to: join(installed.dir, 'roms', 'y.z64') }
    ])
  })

  it('never copies a picked folder that holds the target (the install or a folder above it)', () => {
    const p = prepareLaunch(entry, installed, [
      state({ id: 'a', how: 'folder', folder: 'Game Files', path: installed.dir, ready: true }),
      state({ id: 'b', how: 'folder', folder: 'Game Files', path: 'C:\\Recomps', ready: true }),
      state({ id: 'c', how: 'folder', folder: 'update', path: 'D:\\Update', ready: true })
    ])
    expect(p.copies).toEqual([{ from: 'D:\\Update', to: join(installed.dir, 'update', 'Update') }])
  })

  it("puts a picked folder's files straight into the folder when the catalog says so", () => {
    const p = prepareLaunch(entry, installed, [
      state({
        id: 'a',
        how: 'folder',
        accepts: 'folder',
        folder: 'game',
        intoFolder: true,
        path: 'D:\\Skate3',
        ready: true
      }),
      state({
        id: 'b',
        how: 'folder',
        accepts: 'folder',
        folder: '.',
        intoFolder: true,
        path: 'D:\\Disc',
        ready: true
      }),
      state({
        id: 'c',
        how: 'folder',
        accepts: 'folder',
        folder: '..',
        intoFolder: true,
        path: 'D:\\Evil',
        ready: true
      })
    ])
    expect(p.copies).toEqual([
      { from: 'D:\\Skate3', to: join(installed.dir, 'game') },
      { from: 'D:\\Disc', to: resolve(installed.dir) }
    ])
  })

  it('lists required needs that are not ready; self and optional needs never block', () => {
    const missing = state({ id: 'game', ready: false })
    const p = prepareLaunch(entry, installed, [
      missing,
      state({ id: 'self', how: 'self', ready: true }),
      state({ id: 'opt', optional: true, ready: true })
    ])
    expect(p.missing).toEqual([missing])
    expect(p.args).toEqual([])
  })
})

describe('applyCopies', () => {
  it('places files and folders, and skips targets that are already the same', async () => {
    const src = join(dir, 'src.z64')
    await fs.writeFile(src, 'rom-data')
    const folder = join(dir, 'update')
    await fs.mkdir(join(folder, 'sub'), { recursive: true })
    await fs.writeFile(join(folder, 'sub', 'patch.bin'), 'patch')
    const install = join(dir, 'install')
    const to = join(install, 'assets', 'baserom.z64')

    await applyCopies(
      [
        { from: src, to },
        { from: folder, to: join(install, 'update', 'update') }
      ],
      log
    )
    expect(await fs.readFile(to, 'utf8')).toBe('rom-data')
    expect(await fs.readFile(join(install, 'update', 'update', 'sub', 'patch.bin'), 'utf8')).toBe(
      'patch'
    )
    const [a, b] = await Promise.all([fs.stat(src), fs.stat(to)])
    expect(Math.abs(a.mtimeMs - b.mtimeMs)).toBeLessThan(2000)

    // Same size and time: left alone (no rewrite).
    const before = (await fs.stat(to)).ino
    await applyCopies([{ from: src, to }], log)
    expect((await fs.stat(to)).ino).toBe(before)

    // A different file at the target is replaced.
    await fs.rm(to)
    await fs.writeFile(to, 'old')
    await applyCopies([{ from: src, to }], log)
    expect(await fs.readFile(to, 'utf8')).toBe('rom-data')
    expect(await fs.readdir(join(install, 'assets'))).toEqual(['baserom.z64'])
  })

  it('refuses to copy a folder into itself instead of recursing without end', async () => {
    const install = join(dir, 'install')
    await fs.mkdir(install, { recursive: true })
    await fs.writeFile(join(install, 'game.exe'), 'exe')
    await expect(
      applyCopies([{ from: install, to: join(install, 'Game Files', 'install') }], log)
    ).rejects.toThrow(/holds/)
    expect(await fs.readdir(install)).toEqual(['game.exe'])
  })

  it('throws when the source is missing', async () => {
    await expect(
      applyCopies([{ from: join(dir, 'nope'), to: join(dir, 'x') }], log)
    ).rejects.toThrow()
  })
})

describe('readDeveloperProfile', () => {
  async function write(profile: unknown, at = dir): Promise<void> {
    await fs.mkdir(at, { recursive: true })
    await fs.writeFile(join(at, 'recomplauncher.json'), JSON.stringify(profile))
  }

  it('returns null without a profile, for broken JSON and other formats', async () => {
    expect(await readDeveloperProfile(dir)).toBeNull()
    await fs.writeFile(join(dir, 'recomplauncher.json'), '{ nope')
    expect(await readDeveloperProfile(dir)).toBeNull()
    await write({ format: 2 })
    expect(await readDeveloperProfile(dir)).toBeNull()
  })

  it('reads a disc-image game passed with a flag (streetball-style)', async () => {
    await fs.mkdir(join(dir, 'bin'))
    await fs.writeFile(join(dir, 'bin', 'street-game.exe'), '')
    await write({
      format: 1,
      repo: 'someone/streetball',
      game: {
        kind: 'iso',
        label: 'Your disc image (.iso) of the USA release, serial SLUS-20651.',
        check: { iso9660: 'SLUS_206.51', ids: ['SLUS-20651'] },
        dumps: [{ name: 'Street (USA).iso', crc32: 'ABCDEF01' }]
      },
      start: {
        program: ['bin/street-game.exe', 'street-game.exe', 'bin/street-game'],
        args: ['--iso', '{game}', '--from_launcher', '--data={documents}/Street']
      },
      folders: { saves: [{ path: '{documents}/Streetball Revival' }] },
      settings: [{ id: 'x', label: 'X', choices: [{ label: 'a' }, { label: 'b' }] }]
    })
    const p = await readDeveloperProfile(dir)
    expect(p?.needs).toEqual([
      {
        id: 'game',
        label: 'Your game',
        description: 'Your disc image (.iso) of the USA release, serial SLUS-20651.',
        kind: 'game',
        how: 'flag',
        flag: '--iso',
        accepts: 'file',
        formats: ['.iso'],
        optional: false,
        hashes: [{ algo: 'crc32', value: 'abcdef01' }],
        serial: 'SLUS-20651'
      }
    ])
    expect(p?.start?.program).toBe('bin/street-game.exe')
    expect(p?.start?.args?.[0]).toBe('--from_launcher')
    expect(p?.start?.args?.[1]).toMatch(/^--data=.*Documents[\\/]Street$/)
    expect(p?.saves).toEqual(['{documents}/Streetball Revival'])
  })

  it('reads a game the recomp finds itself, its update folder and conditional save places', async () => {
    await fs.writeFile(join(dir, 'portable.txt'), '')
    await write({
      format: 1,
      game: {
        kind: 'iso_or_folder',
        label: 'Your copy: the .iso or the folder with default.xex.',
        check: { file: 'default.xex' },
        update: { into: 'update', label: 'Your title update.', accepts: 'folder', optional: true }
      },
      start: { program: ['fifawc14.exe'], args: ['--from_launcher'] },
      saves: ['{local}/Game/saves', '{install}/settings.toml'],
      folders: {
        saves: [
          { path: '{install}/saves', if: '{install}/portable.txt' },
          { path: '{documents}/2014 FIFA' }
        ]
      }
    })
    const p = await readDeveloperProfile(dir)
    expect(p?.needs.map((n) => [n.id, n.how, n.accepts, n.optional, n.folder])).toEqual([
      ['game', 'self', 'either', false, undefined],
      ['update', 'folder', 'folder', true, 'update']
    ])
    expect(p?.start).toEqual({ program: 'fifawc14.exe', args: ['--from_launcher'], env: {} })
    expect(p?.saves).toEqual(['{local}/Game/saves', '{install}/settings.toml', '{install}/saves'])
  })

  it('reads named inputs: discs with "=" flags, optional DLC, env, destinations, skipping DLSS', async () => {
    await write(
      {
        format: 1,
        inputs: [
          {
            id: 'disc1',
            label: 'Disc 1',
            role: 'disc',
            formats: [{ type: 'file', extensions: ['ISO', 'chd'] }]
          },
          {
            id: 'disc2',
            label: 'Disc 2',
            role: 'disc',
            formats: [{ type: 'file', extensions: ['iso'] }, { type: 'folder' }]
          },
          {
            id: 'dlc1',
            label: 'DLC pack 1',
            role: 'dlc',
            optional: true,
            formats: [{ type: 'file' }]
          },
          { id: 'keys', label: 'prod.keys', role: 'key', shared: 'switch.prod-keys' },
          {
            id: 'rom',
            label: 'Base ROM',
            formats: [{ type: 'file', extensions: ['z64'] }],
            destination: 'assets/baserom.z64'
          },
          { id: 'dlss', label: 'DLSS', role: 'runtime', shared: 'nvidia.dlss', optional: true },
          { id: 'bad id!', label: 'skipped', formats: [{ type: 'file' }] }
        ],
        start: {
          program: ['game.exe'],
          args: [
            '--disc1={input:disc1}',
            '{input:disc2}',
            '--dlss={input:dlss}',
            '--rom',
            '{input:rom}',
            '-v'
          ],
          env: { GAME_KEYS: '{input:keys}', PATH: '{input:dlc1}', MODE: 'x' }
        }
      },
      join(dir, 'bin')
    )
    const p = await readDeveloperProfile(dir)
    const byId = Object.fromEntries((p?.needs ?? []).map((n) => [n.id, n]))
    expect(Object.keys(byId)).toEqual(['disc1', 'disc2', 'dlc1', 'keys', 'rom'])
    expect(byId.disc1).toMatchObject({
      kind: 'game',
      how: 'flag',
      flag: '--disc1=',
      accepts: 'file',
      formats: ['.iso', '.chd']
    })
    expect(byId.disc2).toMatchObject({
      how: 'flag',
      flag: '',
      accepts: 'either',
      formats: ['.iso']
    })
    // PATH is a reserved variable: the DLC is left to the recomp.
    expect(byId.dlc1).toMatchObject({ kind: 'dlc', how: 'self', optional: true, formats: [] })
    expect(byId.keys).toMatchObject({
      kind: 'other',
      how: 'env',
      env: 'GAME_KEYS',
      optional: false
    })
    expect(byId.rom).toMatchObject({ how: 'folder', folder: 'assets', fileName: 'baserom.z64' })
    expect(p?.start?.args).toEqual(['--rom', join(dir, 'assets', 'baserom.z64'), '-v'])
    expect(p?.start?.env).toEqual({ MODE: 'x' })
    expect(p?.start?.program).toBe('game.exe')
  })

  it('refuses unsafe destinations', async () => {
    await write({
      format: 1,
      inputs: [{ id: 'a', label: 'A', formats: [{ type: 'file' }], destination: '../outside.bin' }],
      start: { program: ['g.exe'], args: ['--a', '{input:a}'] }
    })
    const p = await readDeveloperProfile(dir)
    expect(p?.needs[0]).toMatchObject({ how: 'flag', flag: '--a' })
    expect(p?.needs[0].folder).toBeUndefined()
  })
})

describe('mergeProfileNeeds', () => {
  it('lets the profile win and keeps the catalog dumps on the game need', () => {
    const catalog = [
      need({
        hashes: [{ algo: 'sha1', value: 'abc' }],
        region: 'USA',
        serial: 'NZSE',
        formats: ['.z64', '.n64']
      })
    ]
    const profile = [
      need({ how: 'self', formats: [], hashes: [] }),
      need({ id: 'dlc', kind: 'dlc' })
    ]
    const merged = mergeProfileNeeds(catalog, profile)
    expect(merged[0]).toMatchObject({
      how: 'self',
      hashes: [{ algo: 'sha1', value: 'abc' }],
      region: 'USA',
      serial: 'NZSE',
      formats: ['.z64', '.n64']
    })
    expect(merged[1]).toBe(profile[1])
    expect(mergeProfileNeeds(catalog, [])).toBe(catalog)
  })
})
