import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConvertStatus } from '../../shared/convert'
import type { Game } from '../../shared/types'
import { createConvertService, parseVerdict, type ConvertServiceDeps } from './convert-service'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-convert-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const EXT: Record<string, string> = { chd: '.chd', cue: '.cue', iso: '.iso', pkg: '.pkg' }

/** A stand-in converter: writes `<stem><ext>` (a .cue with its .bin) into -o and prints the converter's verdict. */
function fakeConverter(
  verdict: (input: string, target: string) => 'OK' | 'FAIL' | 'SKIP' = () => 'OK'
): ConvertServiceDeps['run'] & { calls: string[][] } {
  const calls: string[][] = []
  const run = async (
    _exe: string,
    args: string[],
    onLine: (line: string) => void
  ): Promise<number> => {
    calls.push(args)
    const input = args[1]!
    const target = args[args.indexOf('--to') + 1]!
    const out = args[args.indexOf('-o') + 1]!
    const name = basename(input)
    const word = verdict(input, target)
    onLine(`[1/1] ${name}`)
    if (word === 'OK') {
      const stem = basename(input, extname(input))
      await fs.writeFile(join(out, `${stem}${EXT[target] ?? `.${target}`}`), 'made')
      if (target === 'cue') await fs.writeFile(join(out, `${stem}.bin`), 'made')
      onLine(`OK   ${name}: 1.2 MB → 300 KB (25%) · 0s`)
      return 0
    }
    onLine(
      word === 'FAIL' ? `FAIL ${name}: Failed damaged image` : `SKIP ${name}: Skipped (exists)`
    )
    return word === 'FAIL' ? 1 : 0
  }
  return Object.assign(run, { calls })
}

function romGame(path: string): Game {
  return {
    id: 'rom:ps2:old',
    source: 'rom',
    externalId: `ps2/${basename(path)}`,
    platformId: 'ps2',
    title: 'Game',
    romPath: path
  } as unknown as Game
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function setup(
  options: {
    run?: ConvertServiceDeps['run']
    games?: Game[]
    trash?: (p: string) => Promise<void>
    ensure?: ConvertServiceDeps['ensure']
  } = {}
) {
  const statuses: ConvertStatus[] = []
  const trashed: string[] = []
  const rekeyed: [string, string, string][] = []
  const rescans = vi.fn(async () => {})
  const deps: ConvertServiceDeps = {
    toolRoot: join(dir, 'tool'),
    workDir: join(dir, 'work'),
    emulationDir: () => join(dir, 'Emulation'),
    emulatorPath: async () => null,
    library: {
      games: () => options.games ?? [],
      rekeyRom: (fromId, externalId, romPath) => {
        rekeyed.push([fromId, externalId, romPath])
        return 'rom:ps2:new'
      }
    },
    romExtensions: () => ['.iso', '.chd', '.cue'],
    imageCache: { moveGame: async () => (url: string) => url },
    trash:
      options.trash ??
      (async (path) => {
        trashed.push(path)
        await fs.rm(path, { recursive: true, force: true })
      }),
    rescanRoms: rescans,
    emit: (s) => statuses.push(s),
    log,
    run: options.run ?? fakeConverter(),
    ensure: options.ensure ?? (async () => ({ version: '2.1.1', exe: 'gfc.exe' }))
  }
  const service = createConvertService(deps)
  const finished = async (): Promise<ConvertStatus> => {
    await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false))
    return statuses.at(-1)!
  }
  return { service, statuses, trashed, rekeyed, rescans, finished }
}

const file = async (name: string, text = 'data'): Promise<string> => {
  const path = join(dir, name)
  await fs.writeFile(path, text)
  return path
}

describe('parseVerdict', () => {
  it("reads the converter's verdict on a named input", () => {
    expect(parseVerdict('OK   Game.iso: 1.2 MB → 326 B (0%) · 0s', 'Game.iso')).toEqual({
      state: 'done',
      detail: '1.2 MB → 326 B (0%) · 0s'
    })
    expect(
      parseVerdict('FAIL Game.iso: Failed (setup needed) needs a key', 'Game.iso')?.state
    ).toBe('failed')
    expect(parseVerdict('SKIP Game.iso: Skipped', 'Game.iso')?.state).toBe('skipped')
    expect(parseVerdict('OK   Other.iso: done', 'Game.iso')).toBeNull()
    expect(parseVerdict('[1/1] Game.iso', 'Game.iso')).toBeNull()
  })
})

describe('Convert runs', () => {
  it('converts next to the original, recycles it with its files, moves its library record and rescans', async () => {
    const cue = await file('Game.cue', 'FILE "Game.bin" BINARY')
    const bin = await file('Game.bin')
    const run = fakeConverter()
    const t = setup({ run, games: [romGame(cue)] })
    await t.service.start({
      platformId: 'ps2',
      pairId: 'ps2-cue-chd',
      reversed: false,
      paths: [cue]
    })
    const done = await t.finished()
    expect(done.items).toEqual([
      {
        path: cue,
        state: 'done',
        detail: '1.2 MB → 300 KB (25%) · 0s',
        output: join(dir, 'Game.chd')
      }
    ])
    expect(run.calls[0]).toEqual(
      expect.arrayContaining(['cli', cue, '--to', 'chd', '-o', dir, '--flat', '--no-m3u'])
    )
    expect(t.trashed).toEqual([cue, bin])
    expect(t.rekeyed).toEqual([['rom:ps2:old', 'ps2/Game.chd', join(dir, 'Game.chd')]])
    expect(t.rescans).toHaveBeenCalledOnce()
  })

  it('updates a converter older than 2.1.1 at the next run, even after the tab read the old one', async () => {
    // A 2.1.0 the user downloaded earlier: the Convert tab's status reads it first.
    const old = join(dir, 'tool', '2.1.0')
    await fs.mkdir(old, { recursive: true })
    await fs.writeFile(join(old, 'Game Format Converter.exe'), '')
    await fs.writeFile(
      join(dir, 'tool', 'playout-converter.json'),
      JSON.stringify({ version: '2.1.0', dir: '2.1.0' })
    )
    const exes: string[] = []
    const fake = fakeConverter()
    const run: ConvertServiceDeps['run'] = (exe, args, onLine, signal) => {
      exes.push(exe)
      return fake(exe, args, onLine, signal)
    }
    const ensure = vi.fn(async () => ({ version: '2.1.1', exe: 'new.exe' }))
    const t = setup({ run, ensure })
    expect((await t.service.status()).tool).toEqual({ version: '2.1.0' })
    const rom = await file('Mario.z64')
    await t.service.start({
      platformId: 'n64',
      pairId: 'n64-z64-v64',
      reversed: false,
      paths: [rom]
    })
    await t.finished()
    expect(ensure).toHaveBeenCalledOnce()
    expect(exes).toEqual(['new.exe'])
    expect(fake.calls[0]).toEqual(expect.arrayContaining(['--to', 'n64_v64']))
  })

  it('runs a two-step direction through a temporary file, leaving only the result', async () => {
    const iso = await file('Game.iso')
    const run = fakeConverter()
    const t = setup({ run })
    await t.service.start({
      platformId: 'ps2',
      pairId: 'ps2-iso-bin',
      reversed: false,
      paths: [iso]
    })
    const done = await t.finished()
    expect(run.calls.map((c) => c[c.indexOf('--to') + 1])).toEqual(['chd', 'cue'])
    expect(run.calls[0]![run.calls[0]!.indexOf('-o') + 1]).toContain(join(dir, 'work'))
    expect(run.calls[1]![1]).toMatch(/Game\.chd$/)
    expect(done.items[0]).toMatchObject({ state: 'done', output: join(dir, 'Game.cue') })
    expect((await fs.readdir(dir)).sort()).toEqual(['Game.bin', 'Game.cue', 'work'])
    expect(await fs.readdir(join(dir, 'work'))).toEqual([])
  })

  it('keeps the original when the converter fails or skips the file', async () => {
    const a = await file('A.iso')
    const b = await file('B.iso')
    const t = setup({ run: fakeConverter((input) => (input.endsWith('A.iso') ? 'FAIL' : 'SKIP')) })
    await t.service.start({
      platformId: 'ps2',
      pairId: 'ps2-iso-chd',
      reversed: false,
      paths: [a, b]
    })
    const done = await t.finished()
    expect(done.items.map((i) => [i.state, i.detail])).toEqual([
      ['failed', 'Failed damaged image'],
      ['skipped', 'Skipped (exists)']
    ])
    expect(t.trashed).toEqual([])
    expect(t.rescans).not.toHaveBeenCalled()
  })

  it('keeps the library record where it is when the original could not be recycled', async () => {
    const iso = await file('Game.iso')
    const t = setup({
      games: [romGame(iso)],
      trash: async () => {
        throw new Error('in use')
      }
    })
    await t.service.start({
      platformId: 'ps2',
      pairId: 'ps2-iso-chd',
      reversed: false,
      paths: [iso]
    })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'done' })
    expect(done.items[0]!.detail).toContain('kept: Game.iso')
    expect(t.rekeyed).toEqual([])
  })

  it('refuses files of the wrong format, and a direction missing what it needs, naming where it goes', async () => {
    const chd = await file('Game.chd')
    const t = setup()
    await expect(
      t.service.start({ platformId: 'ps2', pairId: 'ps2-iso-chd', reversed: false, paths: [chd] })
    ).rejects.toThrow('not a ISO file')
    const pkg = await file('Game.pkg')
    await expect(
      t.service.start({
        platformId: 'ps3',
        pairId: 'ps3-pkg-folder',
        reversed: false,
        paths: [pkg]
      })
    ).rejects.toThrow(join(dir, 'Emulation', 'bios', 'ps3', 'pkg-key.txt'))
    await expect(
      t.service.check({ platformId: 'ps3', pairId: 'ps3-pkg-folder', reversed: false })
    ).resolves.toMatchObject([{ need: 'ps3Unpack', blocking: true }])
  })

  it('stops between files, leaving the rest as they were', async () => {
    const a = await file('A.iso')
    const b = await file('B.iso')
    const inner = fakeConverter()
    const t: ReturnType<typeof setup> = setup({
      run: async (exe, args, onLine, signal) => {
        const code = await inner(exe, args, onLine, signal)
        t.service.stop()
        return code
      }
    })
    await t.service.start({
      platformId: 'ps2',
      pairId: 'ps2-iso-chd',
      reversed: false,
      paths: [a, b]
    })
    const done = await t.finished()
    expect(done.items.map((i) => i.state)).toEqual(['stopped', 'stopped'])
    expect(t.trashed).toEqual([])
  })

  it('never runs two at once', async () => {
    const a = await file('A.iso')
    let release: (() => void) | null = null
    const run: ConvertServiceDeps['run'] = (exe, args, onLine, signal) =>
      new Promise((resolve) => {
        release = () => void fakeConverter()(exe, args, onLine, signal).then(resolve)
      })
    const t = setup({ run })
    await t.service.start({ platformId: 'ps2', pairId: 'ps2-iso-chd', reversed: false, paths: [a] })
    await expect(
      t.service.start({ platformId: 'ps2', pairId: 'ps2-iso-chd', reversed: false, paths: [a] })
    ).rejects.toThrow('already running')
    await vi.waitFor(() => expect(release).not.toBeNull())
    release!()
    await t.finished()
  })
})
