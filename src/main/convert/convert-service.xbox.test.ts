import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertPair, type ConvertStatus } from '../../shared/convert'
import type { Game } from '../../shared/types'
import { createConvertService, type ConvertServiceDeps } from './convert-service'
import { helperOutput, parseHelperLine, xboxImageInfo, type HelperRun } from './xbox-helper'

// Temporary files only: a fake helper process for the routing, and the real helper only on synthetic images it makes
// itself from a made-up game folder.

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-convert-xbox-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const line = (value: object): string => JSON.stringify(value)

function game(platformId: string, romPath: string): Game {
  return {
    id: `rom:${platformId}:${basename(romPath)}`,
    source: 'rom',
    externalId: basename(romPath),
    platformId,
    title: basename(romPath),
    installed: true,
    romPath
  } as Game
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function setup(over: Partial<ConvertServiceDeps> = {}, games: Game[] = []) {
  const statuses: ConvertStatus[] = []
  const ensure = vi.fn(async () => ({ version: '2.1.0', exe: 'gfc.exe' }))
  const run = vi.fn(async () => 0)
  const trash = vi.fn(async (path: string) => {
    await fs.rm(path, { recursive: true, force: true })
  })
  const rescans = vi.fn(async () => {})
  const rekeyRom = vi.fn(() => 'moved')
  const exe = join(dir, 'helper', 'PlayOutXbox.exe')
  const service = createConvertService({
    toolRoot: join(dir, 'tool'),
    workDir: join(dir, 'work'),
    emulationDir: () => join(dir, 'Emulation'),
    emulatorPath: async () => null,
    library: { games: () => games, rekeyRom },
    romExtensions: (id) => (id === 'xbox360' ? ['.iso', '.zar', '.xex'] : ['.iso', '.xbe']),
    imageCache: { moveGame: async () => (url: string) => url },
    trash,
    rescanRoms: rescans,
    emit: (s) => statuses.push(s),
    log,
    run,
    ensure,
    xboxHelper: exe,
    ...over
  })
  const finished = async (): Promise<ConvertStatus> => {
    await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false), { timeout: 60_000 })
    return statuses.at(-1)!
  }
  return { service, statuses, ensure, run, trash, rescans, rekeyRom, exe, finished }
}

/** A stand-in helper: writes its partial, then its result, printing progress and done as the real one does. */
function fakeHelper(
  behave: (args: string[], print: (v: object) => void, signal: AbortSignal) => Promise<number>
): { runHelper: HelperRun; calls: string[][] } {
  const calls: string[][] = []
  const runHelper: HelperRun = async (_exe, args, onLine, signal) => {
    calls.push(args)
    return behave(args, (v) => onLine(line(v)), signal)
  }
  return { runHelper, calls }
}

async function put(path: string, data: string | Buffer = 'x'): Promise<string> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
  return path
}

const partialOf = (out: string): string => out.replace(/(\.[^.\\/]+)$/, '.playout-partial$1')

describe('Xbox and Xbox 360 directions run on the Xbox helper', () => {
  it('routes every Xbox / Xbox 360 direction to a helper command, with no converter', () => {
    const expected: [string, string, string, string?][] = [
      ['xbox', 'xbox-iso-xiso', 'trim'],
      ['xbox', 'xbox-iso-folder', 'extract', 'pack'],
      ['xbox', 'xbox-iso-chd', 'chd', 'toiso'],
      ['xbox360', 'x360-iso-xiso', 'trim'],
      ['xbox360', 'x360-iso-zar', 'zar', 'toiso'],
      ['xbox360', 'x360-iso-folder', 'extract', 'pack'],
      ['xbox360', 'x360-folder-zar', 'zar', 'extract'],
      ['xbox360', 'x360-iso-chd', 'chd', 'toiso']
    ]
    for (const [platform, id, forward, backward] of expected) {
      const pair = convertPair(platform, id)!
      expect(pair.forward).toMatchObject({ builtIn: 'xbox', steps: [forward] })
      expect(pair.forward.unverified).toBeUndefined()
      if (backward) expect(pair.backward).toMatchObject({ builtIn: 'xbox', steps: [backward] })
      else expect(pair.backward).toBeUndefined()
    }
    expect(convertPair('xbox360', 'x360-iso-xiso')!.forward.note).toBe('x360Xiso')
  })

  it('names results after the original, next to it', () => {
    const d = join('D:', 'Roms', 'xbox360')
    expect(helperOutput('trim', join(d, 'Halo 3.iso'))).toBe(join(d, 'Halo 3.xiso.iso'))
    expect(helperOutput('trim', join(d, 'Halo 3.xiso.iso'))).toBe(
      join(d, 'Halo 3 (trimmed).xiso.iso')
    )
    expect(helperOutput('extract', join(d, 'Halo 3.xiso.iso'))).toBe(join(d, 'Halo 3'))
    expect(helperOutput('pack', join(d, 'Halo v1.0'))).toBe(join(d, 'Halo v1.0.iso'))
    expect(helperOutput('zar', join(d, 'Halo v1.0'), true)).toBe(join(d, 'Halo v1.0.zar'))
    expect(helperOutput('zar', join(d, 'Halo.iso'))).toBe(join(d, 'Halo.zar'))
    expect(helperOutput('chd', join(d, 'Halo.iso'))).toBe(join(d, 'Halo.chd'))
    expect(helperOutput('toiso', join(d, 'Halo.chd'))).toBe(join(d, 'Halo.iso'))
    expect(parseHelperLine('{"type":"progress","phase":"trim","percent":5}')).toEqual({
      type: 'progress',
      phase: 'trim',
      percent: 5
    })
    expect(parseHelperLine('   at XISOSharp.XisoReader.Rewrite()')).toBeNull()
    expect(parseHelperLine('{"type":"other"}')).toBeNull()
  })

  it('trims a 360 dump: verified result, original to the Recycle Bin, the library record moves', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'), 'full dump')
    const out = join(dir, 'roms', 'Game.xiso.iso')
    const helper = fakeHelper(async (_args, print) => {
      print({ type: 'progress', phase: 'trim', percent: 50 })
      await put(partialOf(out), 'half')
      await fs.rename(partialOf(out), out)
      print({ type: 'progress', phase: 'verify', percent: 100 })
      print({ type: 'done', output: out, inputBytes: 9, outputBytes: 4 })
      return 0
    })
    const t = setup({ runHelper: helper.runHelper }, [game('xbox360', iso)])
    await put(t.exe, 'helper')
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-xiso',
      reversed: false,
      paths: [iso]
    })
    const done = await t.finished()
    expect(helper.calls).toEqual([['trim', iso, out]])
    expect(done.items).toEqual([
      { path: iso, state: 'done', detail: '→ Game.xiso.iso (verified)', output: out }
    ])
    expect(t.trash).toHaveBeenCalledWith(iso)
    expect(t.rekeyRom).toHaveBeenCalledWith(
      'rom:xbox360:Game.iso',
      'Game.xiso.iso',
      out,
      expect.any(Function)
    )
    expect(t.ensure).not.toHaveBeenCalled()
    expect(t.run).not.toHaveBeenCalled()
    expect(t.rescans).toHaveBeenCalledOnce()
    // Progress was shown while it ran (work 80 %, verify 20 %).
    expect(t.statuses.some((s) => s.items[0]?.progress === 0.4)).toBe(true)
  })

  it('an image that is already trimmed is skipped and kept', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const helper = fakeHelper(async (_args, print) => {
      print({ type: 'done', skipped: 'already optimized', platform: 'xbox' })
      return 0
    })
    const t = setup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox',
      pairId: 'xbox-iso-xiso',
      reversed: false,
      paths: [iso]
    })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'skipped', detail: 'already a trimmed XISO' })
    expect(t.trash).not.toHaveBeenCalled()
  })

  it('a failed check keeps the original, says why and removes the partial result', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const out = join(dir, 'roms', 'Game.chd')
    const helper = fakeHelper(async (_args, print) => {
      await put(partialOf(out), 'half')
      await put(`${out}.playout-partial-source.iso`, 'temp')
      print({ type: 'error', message: 'the CHD failed verification: Decompression failed' })
      return 1
    })
    const t = setup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox',
      pairId: 'xbox-iso-chd',
      reversed: false,
      paths: [iso]
    })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({
      state: 'failed',
      detail: 'the CHD failed verification: Decompression failed'
    })
    expect(t.trash).not.toHaveBeenCalled()
    expect((await fs.readdir(join(dir, 'roms'))).sort()).toEqual(['Game.iso'])
  })

  it('exit 0 without a result it names is not a success', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const helper = fakeHelper(async (_args, print) => {
      print({ type: 'done', output: join(dir, 'roms', 'Else.zar') })
      return 0
    })
    const t = setup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-zar',
      reversed: false,
      paths: [iso]
    })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({
      state: 'failed',
      detail: 'the Xbox helper reported success but its result was not found'
    })
    expect(t.trash).not.toHaveBeenCalled()
  })

  it('an extracted 360 game folder: the original goes, and the record moves onto its default.xex', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'), 'image')
    const out = join(dir, 'roms', 'Game')
    const helper = fakeHelper(async (_args, print) => {
      await fs.mkdir(`${out}.playout-partial`, { recursive: true })
      await put(join(`${out}.playout-partial`, 'default.xex'), 'xex')
      await put(join(`${out}.playout-partial`, 'media', 'other.xex'), 'xex')
      await fs.rename(`${out}.playout-partial`, out)
      print({ type: 'done', output: out })
      return 0
    })
    const t = setup({ runHelper: helper.runHelper }, [game('xbox360', iso)])
    await put(t.exe, 'helper')
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-folder',
      reversed: false,
      paths: [iso]
    })
    expect((await t.finished()).items[0]).toMatchObject({ state: 'done', output: out })
    expect(t.trash).toHaveBeenCalledWith(iso)
    expect(t.rekeyRom).toHaveBeenCalledWith(
      'rom:xbox360:Game.iso',
      'Game/default.xex',
      join(out, 'default.xex'),
      expect.any(Function)
    )
  })

  it('a folder game packed back to an ISO: the folder goes, and the record moves onto the ISO beside it', async () => {
    const folderPath = join(dir, 'roms', 'xbox360', 'Racing', 'Game')
    const xex = await put(join(folderPath, 'default.xex'), 'xex')
    await put(join(folderPath, 'data.bin'), 'data')
    const out = join(dir, 'roms', 'xbox360', 'Racing', 'Game.iso')
    const helper = fakeHelper(async (_args, print) => {
      await put(partialOf(out), 'iso')
      await fs.rename(partialOf(out), out)
      print({ type: 'done', output: out })
      return 0
    })
    const record = {
      ...game('xbox360', xex),
      id: 'rom:xbox360:folder',
      externalId: 'xbox360/Racing/Game/default.xex',
      extra: { gameFolder: folderPath }
    } as Game
    const t = setup({ runHelper: helper.runHelper }, [record])
    await put(t.exe, 'helper')
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-folder',
      reversed: true,
      paths: [folderPath]
    })
    expect((await t.finished()).items[0]).toMatchObject({ state: 'done', output: out })
    expect(t.trash).toHaveBeenCalledWith(folderPath)
    expect(t.rekeyRom).toHaveBeenCalledWith(
      'rom:xbox360:folder',
      'xbox360/Racing/Game.iso',
      out,
      expect.any(Function)
    )
  })

  it('a result the system does not play: the original still goes to the Recycle Bin, the record stays', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'), 'image')
    const out = join(dir, 'roms', 'Game.chd')
    const helper = fakeHelper(async (_args, print) => {
      await put(partialOf(out), 'chd')
      await fs.rename(partialOf(out), out)
      print({ type: 'done', output: out })
      return 0
    })
    const t = setup({ runHelper: helper.runHelper }, [game('xbox360', iso)])
    await put(t.exe, 'helper')
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-chd',
      reversed: false,
      paths: [iso]
    })
    expect((await t.finished()).items[0]).toMatchObject({ state: 'done', output: out })
    expect(t.trash).toHaveBeenCalledWith(iso)
    expect(t.rekeyRom).not.toHaveBeenCalled()
  })

  it('stop kills the helper and removes what it wrote; the original stays', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const out = join(dir, 'roms', 'Game')
    const helper = fakeHelper(async (_args, print, signal) => {
      await fs.mkdir(`${out}.playout-partial`, { recursive: true })
      await put(join(`${out}.playout-partial`, 'default.xex'))
      print({ type: 'progress', phase: 'extract', percent: 10 })
      await new Promise<void>((r) => signal.addEventListener('abort', () => r()))
      return 3
    })
    const t = setup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-folder',
      reversed: false,
      paths: [iso]
    })
    await vi.waitFor(() => expect(helper.calls).toHaveLength(1))
    await vi.waitFor(() => expect(existsSync(`${out}.playout-partial`)).toBe(true))
    t.service.stop()
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'stopped' })
    expect(await fs.readdir(join(dir, 'roms'))).toEqual(['Game.iso'])
    expect(t.trash).not.toHaveBeenCalled()
  })

  it('a result already there is left alone, and a missing helper is said', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    await put(join(dir, 'roms', 'Game.zar'), 'mine')
    const helper = fakeHelper(async () => 0)
    const t = setup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-zar',
      reversed: false,
      paths: [iso]
    })
    expect((await t.finished()).items[0]).toMatchObject({
      state: 'skipped',
      detail: 'already converted: Game.zar is there'
    })
    expect(helper.calls).toEqual([])

    const missing = setup({ runHelper: helper.runHelper, xboxHelper: join(dir, 'none.exe') })
    await missing.service.start({
      platformId: 'xbox',
      pairId: 'xbox-iso-xiso',
      reversed: false,
      paths: [iso]
    })
    expect((await missing.finished()).items[0]!.detail).toMatch(/Xbox helper is missing/)
    expect(helper.calls).toEqual([])
  })

  it('a folder goes to ZAR under the folder’s own name', async () => {
    const folder = join(dir, 'roms', 'Game v1.0')
    await put(join(folder, 'default.xex'))
    const out = join(dir, 'roms', 'Game v1.0.zar')
    const helper = fakeHelper(async (_args, print) => {
      await put(out, 'zar')
      print({ type: 'done', output: out })
      return 0
    })
    const t = setup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-folder-zar',
      reversed: false,
      paths: [folder]
    })
    const done = await t.finished()
    expect(helper.calls).toEqual([['zar', folder, out]])
    expect(done.items[0]).toMatchObject({ state: 'done', output: out })
    expect(t.trash).toHaveBeenCalledWith(folder)
  })
})

// The real helper (resources\xbox) on a synthetic game folder only: packed, read, extracted, archived and back.
const REAL_HELPER = resolve(__dirname, '..', '..', '..', 'resources', 'xbox', 'PlayOutXbox.exe')

describe.runIf(process.platform === 'win32' && existsSync(REAL_HELPER))(
  'the real Xbox helper on a synthetic image',
  () => {
    it('folder → XISO → folder and → ZAR → ISO, each verified, through Convert', async () => {
      const roms = join(dir, 'roms')
      const tree = join(roms, 'Synthetic')
      const xex = Buffer.alloc(4096)
      xex.write('XEX2', 0, 'latin1')
      await put(join(tree, 'default.xex'), xex)
      await put(join(tree, 'media', 'data.bin'), Buffer.alloc(300_000, 7))
      await put(join(tree, 'media', 'empty.txt'), '')
      const files = async (root: string): Promise<string[]> =>
        (await fs.readdir(root, { recursive: true, withFileTypes: true }))
          .filter((e) => e.isFile())
          .map((e) => join(e.parentPath, e.name).slice(root.length))
          .sort()
      const before = await files(tree)

      const t = setup({ xboxHelper: REAL_HELPER })
      const go = async (pairId: string, reversed: boolean, path: string): Promise<string> => {
        await t.service.start({ platformId: 'xbox360', pairId, reversed, paths: [path] })
        const item = (await t.finished()).items[0]!
        expect(item, item.detail).toMatchObject({ state: 'done' })
        return item.output!
      }
      // Folder → ISO (the folder goes to the "Recycle Bin", here deleted).
      const iso = await go('x360-iso-folder', true, tree)
      expect(iso).toBe(join(roms, 'Synthetic.iso'))
      expect(await xboxImageInfo(REAL_HELPER, iso)).toMatchObject({
        format: 'xiso',
        optimized: true,
        platform: 'xbox360'
      })
      // An optimized image is not trimmed again.
      await t.service.start({
        platformId: 'xbox360',
        pairId: 'x360-iso-xiso',
        reversed: false,
        paths: [iso]
      })
      expect((await t.finished()).items[0]).toMatchObject({ state: 'skipped' })
      // ISO → ZAR → ISO → folder: the same files.
      const zar = await go('x360-iso-zar', false, iso)
      const back = await go('x360-iso-zar', true, zar)
      const folder = await go('x360-iso-folder', false, back)
      expect(folder).toBe(tree)
      expect(await files(folder)).toEqual(before)
      expect(await fs.readFile(join(folder, 'media', 'data.bin'))).toEqual(Buffer.alloc(300_000, 7))
      expect((await fs.readdir(roms)).filter((n) => n.includes('playout-partial'))).toEqual([])
    }, 120_000)
  }
)
