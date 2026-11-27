import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import type { HelperRun } from '../convert/xbox-helper'
import type { Logger } from '../logger'
import {
  copyFolder,
  findSetupImage,
  helperExtractor,
  markerPresent,
  setupGameFolder,
  unpackedSetupFor,
  unpackSetupGame,
  type ExtractImage
} from './game-folder'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'playout-game-folder-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

const XERENGE = unpackedSetupFor('github:shipa-2/xerenge')!

function rom(id: string, romPath: string, over: Partial<Game> = {}): Game {
  return {
    id,
    source: 'rom',
    platformId: id.split(':')[1],
    title: 'Burnout Revenge',
    romPath,
    ...over
  } as Game
}

/** An extractor that writes `files` into the output folder like the helper (whole folder at once). */
const fakeExtract =
  (files: Record<string, string>, calls: { image: string; outDir: string }[] = []): ExtractImage =>
  async (image, outDir, onPercent) => {
    calls.push({ image, outDir })
    onPercent(50)
    await fs.mkdir(outDir, { recursive: true })
    for (const [name, data] of Object.entries(files)) await fs.writeFile(join(outDir, name), data)
    onPercent(100)
  }

describe('unpacked game setups table', () => {
  it('knows Xerenge, without regard to case', () => {
    expect(unpackedSetupFor('GitHub:Shipa-2/Xerenge')?.game).toBe('Burnout Revenge')
    expect(unpackedSetupFor('github:shipa-2/xerenge#win')).not.toBeNull()
    expect(unpackedSetupFor('github:shipa-2/xerenge2')).toBeNull()
    expect(setupGameFolder(XERENGE, 'C:\\Users\\me')).toBe(
      join('C:\\Users\\me', 'Games', 'Burnout Revenge', 'game')
    )
  })
})

describe('findSetupImage', () => {
  it('prefers the launched Xbox 360 game, then a matched library game whose file exists', async () => {
    const a = join(tmp, 'a.xiso.iso')
    const b = join(tmp, 'b.iso')
    await fs.writeFile(a, 'x')
    await fs.writeFile(b, 'x')
    const launched = rom('rom:xbox360:a', a)
    const other = rom('rom:xbox360:b', b)
    expect(await findSetupImage(XERENGE, launched, [launched, other], () => true)).toBe(a)

    const pc = { id: 'manual:br', source: 'manual', platformId: 'pc', title: 'BR' } as Game
    expect(await findSetupImage(XERENGE, pc, [pc, other], () => true)).toBe(b)
    expect(await findSetupImage(XERENGE, pc, [pc, other], () => false)).toBeNull()
    // Missing files, other platforms and remote games are skipped.
    const gone = rom('rom:xbox360:c', join(tmp, 'gone.iso'))
    const ps2 = rom('rom:ps2:d', b)
    const remote = rom('rom:xbox360:e', b, { remote: { hostId: 'h' } as never })
    expect(await findSetupImage(XERENGE, gone, [gone, ps2, remote], () => true)).toBeNull()
  })
})

describe('an extracted game folder in the library', () => {
  it('is the setup image (its folder), and is copied where the setup looks, the folder kept', async () => {
    const folderPath = join(tmp, 'roms', 'xbox360', 'Burnout Revenge')
    await fs.mkdir(join(folderPath, 'media'), { recursive: true })
    await fs.writeFile(join(folderPath, 'default.xex'), 'xex')
    await fs.writeFile(join(folderPath, 'media', 'a.bin'), 'a')
    const launched = rom('rom:xbox360:br', join(folderPath, 'default.xex'), {
      externalId: 'xbox360/Burnout Revenge/default.xex',
      extra: { gameFolder: folderPath }
    })
    const image = await findSetupImage(XERENGE, launched, [launched], () => true)
    expect(image).toBe(folderPath)
    const home = join(tmp, 'home')
    const result = await unpackSetupGame(XERENGE, image!, { home, extract: copyFolder, log })
    expect(result.ok).toBe(true)
    const target = setupGameFolder(XERENGE, home)
    expect(await fs.readFile(join(target, 'media', 'a.bin'), 'utf8')).toBe('a')
    expect(await fs.readFile(join(folderPath, 'default.xex'), 'utf8')).toBe('xex')
  })
})

describe('unpackSetupGame', () => {
  it('unpacks the image into the folder the setup reads', async () => {
    const calls: { image: string; outDir: string }[] = []
    const percents: number[] = []
    const result = await unpackSetupGame(XERENGE, 'D:\\roms\\br.xiso.iso', {
      home: tmp,
      extract: fakeExtract({ 'default.xex': 'xex', 'data.bin': 'd' }, calls),
      log,
      onPercent: (p) => percents.push(p)
    })
    const folder = join(tmp, 'Games', 'Burnout Revenge', 'game')
    expect(result).toEqual({ ok: true, folder })
    expect(calls).toEqual([{ image: 'D:\\roms\\br.xiso.iso', outDir: folder }])
    expect(percents).toEqual([50, 100])
    expect(await markerPresent(XERENGE, tmp)).toBe(true)
  })

  it('never touches a folder that already holds files', async () => {
    const folder = join(tmp, 'Games', 'Burnout Revenge', 'game')
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(join(folder, 'mine.txt'), 'keep')
    const calls: { image: string; outDir: string }[] = []
    const result = await unpackSetupGame(XERENGE, 'img', {
      home: tmp,
      extract: fakeExtract({ 'default.xex': 'x' }, calls),
      log
    })
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await fs.readdir(folder)).toEqual(['mine.txt'])
  })

  it('removes a folder unpacked without the marker (not this game)', async () => {
    const result = await unpackSetupGame(XERENGE, 'img', {
      home: tmp,
      extract: fakeExtract({ 'other.xex': 'x' }),
      log
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('not Burnout Revenge')
    await expect(fs.stat(setupGameFolder(XERENGE, tmp))).rejects.toThrow()
  })

  it('tells why when the unpacking fails', async () => {
    const result = await unpackSetupGame(XERENGE, 'img', {
      home: tmp,
      extract: async () => {
        throw new Error('not an Xbox image')
      },
      log
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('not an Xbox image')
  })
})

describe('helperExtractor', () => {
  it("runs the helper's extract and reports its overall progress", async () => {
    const exe = join(tmp, 'PlayOutXbox.exe')
    await fs.writeFile(exe, 'MZ')
    const runs: string[][] = []
    const run: HelperRun = async (_exe, args, onLine) => {
      runs.push(args)
      onLine('{"type":"progress","phase":"extract","percent":80,"overall":40}')
      onLine('{"type":"done","output":"x"}')
      return 0
    }
    const percents: number[] = []
    await helperExtractor(exe, run)(
      'in.iso',
      'out',
      (p) => percents.push(p),
      new AbortController().signal
    )
    expect(runs).toEqual([['extract', 'in.iso', 'out']])
    expect(percents).toEqual([40])
  })

  it("rejects with the helper's error, or when the helper is missing", async () => {
    const exe = join(tmp, 'PlayOutXbox.exe')
    const signal = new AbortController().signal
    await expect(helperExtractor(exe)('a', 'b', () => {}, signal)).rejects.toThrow(/missing/)
    await fs.writeFile(exe, 'MZ')
    const run: HelperRun = async (_e, _a, onLine) => {
      onLine('{"type":"error","message":"damaged image"}')
      return 1
    }
    await expect(helperExtractor(exe, run)('a', 'b', () => {}, signal)).rejects.toThrow(
      'damaged image'
    )
  })
})
