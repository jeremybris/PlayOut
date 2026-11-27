import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConvertStatus } from '../../shared/convert'
import type { Game } from '../../shared/types'
import { createConvertService, type ConvertServiceDeps } from './convert-service'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-convert-edge-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const file = async (name: string, text = 'data'): Promise<string> => {
  const path = join(dir, name)
  await fs.writeFile(path, text)
  return path
}

type Run = NonNullable<ConvertServiceDeps['run']>

/** A converter stand-in: `write` makes the result in -o, `verdictFor` is the line it prints. */
function converter(
  write: (out: string, input: string, target: string) => Promise<void>,
  verdictFor: (input: string, target: string) => string = (input) => `OK   ${basename(input)}: done`
): Run & { calls: string[][] } {
  const calls: string[][] = []
  const fn: Run = async (_exe, args, onLine) => {
    calls.push(args)
    const input = args[1]!
    const target = args[args.indexOf('--to') + 1]!
    const out = args[args.indexOf('-o') + 1]!
    const line = verdictFor(input, target)
    if (line.startsWith('OK')) await write(out, input, target)
    onLine(line)
    return line.startsWith('OK') ? 0 : 1
  }
  return Object.assign(fn, { calls })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function setup(
  options: { run: Run; games?: Game[]; ensure?: ConvertServiceDeps['ensure'] } = {
    run: converter(async () => {})
  }
) {
  const statuses: ConvertStatus[] = []
  const trashed: string[] = []
  const rekeyed: string[][] = []
  const service = createConvertService({
    toolRoot: join(dir, 'tool'),
    workDir: join(dir, 'work'),
    emulationDir: () => join(dir, 'Emulation'),
    emulatorPath: async () => null,
    library: {
      games: () => options.games ?? [],
      rekeyRom: (...args) => {
        rekeyed.push(args.slice(0, 3) as string[])
        return 'new'
      }
    },
    romExtensions: () => ['.iso', '.chd', '.cue', '.ps3'],
    imageCache: { moveGame: async () => (url: string) => url },
    trash: async (path) => {
      trashed.push(path)
      await fs.rm(path, { recursive: true, force: true })
    },
    rescanRoms: async () => {},
    emit: (s) => statuses.push(s),
    log,
    run: options.run,
    ensure: options.ensure ?? (async () => ({ version: '2.1.0', exe: 'gfc.exe' }))
  })
  const finished = async (): Promise<ConvertStatus> => {
    await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false))
    return statuses.at(-1)!
  }
  return { service, statuses, trashed, rekeyed, finished }
}

const made =
  (...names: string[]) =>
  async (out: string) => {
    for (const n of names) await fs.writeFile(join(out, n), 'x')
  }

describe('Convert runs, edge cases', () => {
  it('tries the next target when the converter refuses one (a CD with audio tracks becomes one BIN)', async () => {
    const chd = await file('Game.chd')
    const r = converter(made('Game.cue', 'Game.bin'), (input, target) =>
      target === 'cue'
        ? `FAIL ${basename(input)}: can't become 'cue' (it can become: cue_split, cue_single)`
        : `OK   ${basename(input)}: → Game.cue`
    )
    const t = setup({ run: r })
    await t.service.start({
      platformId: 'psx',
      pairId: 'psx-cue-chd',
      reversed: true,
      paths: [chd]
    })
    const done = await t.finished()
    expect(r.calls.map((c) => c[c.indexOf('--to') + 1])).toEqual(['cue', 'cue_single'])
    expect(done.items[0]).toMatchObject({ state: 'done', output: join(dir, 'Game.cue') })
  })

  it('moves a result the converter put in a folder of its own up next to the original', async () => {
    const ecm = await file('Game.ecm')
    const r = converter(async (out) => {
      await fs.mkdir(join(out, 'Game'))
      await fs.writeFile(join(out, 'Game', 'Game.cue'), 'x')
      await fs.writeFile(join(out, 'Game', 'Game.bin'), 'x')
    })
    const t = setup({ run: r })
    await t.service.start({
      platformId: 'psx',
      pairId: 'psx-cue-ecm',
      reversed: true,
      paths: [ecm]
    })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'done', output: join(dir, 'Game.cue') })
    expect((await fs.readdir(dir)).sort()).toEqual(['Game.bin', 'Game.cue'])
  })

  it('keeps the original of a result the converter does not check', async () => {
    const rvz = await file('Game.rvz')
    const t = setup({ run: converter(made('Game.iso')) })
    await t.service.start({ platformId: 'gc', pairId: 'gc-iso-rvz', reversed: true, paths: [rvz] })
    expect((await t.finished()).items[0]!.detail).toContain('original kept')
    expect(t.trashed).toEqual([])
  })

  it('keeps the original when some results were already there', async () => {
    const pbp = await file('Multi.pbp')
    const t = setup({
      run: converter(
        made('Multi (Disc 1).chd'),
        (input) => `OK   ${basename(input)}: → 2 CHDs (1 already existed)`
      )
    })
    await t.service.start({
      platformId: 'psx',
      pairId: 'psx-chd-pbp',
      reversed: true,
      paths: [pbp]
    })
    expect((await t.finished()).items[0]!.detail).toContain('some results were already there')
    expect(t.trashed).toEqual([])
  })

  it('makes a playlist that named a converted disc name its result', async () => {
    const cue = await file('Game (Disc 1).cue', 'FILE "d1.bin" BINARY')
    await file('d1.bin')
    const m3u = await file('Game.m3u', 'Game (Disc 1).cue\r\nGame (Disc 2).cue\r\n')
    const t = setup({ run: converter(made('Game (Disc 1).chd')) })
    await t.service.start({
      platformId: 'psx',
      pairId: 'psx-cue-chd',
      reversed: false,
      paths: [cue]
    })
    await t.finished()
    expect(await fs.readFile(m3u, 'utf8')).toBe('Game (Disc 1).chd\r\nGame (Disc 2).cue\r\n')
  })

  it('refuses a folder that holds other games, taking away what was made of them', async () => {
    await fs.mkdir(join(dir, 'Games'))
    const t = setup({ run: converter(made('Inner.iso'), () => 'OK   Inner: → Inner.iso') })
    await t.service.start({
      platformId: 'ps3',
      pairId: 'ps3-folder-iso',
      reversed: false,
      paths: [join(dir, 'Games')]
    })
    const done = await t.finished()
    expect(done.items[0]).toMatchObject({ state: 'failed' })
    expect(done.items[0]!.detail).toContain('not one game')
    expect(await fs.readdir(dir)).toEqual(['Games'])
    expect(t.trashed).toEqual([])
  })

  it('removes what a stopped conversion wrote', async () => {
    const a = await file('A.iso')
    const t: ReturnType<typeof setup> = setup({
      run: async (_exe, args) => {
        await fs.writeFile(join(args[args.indexOf('-o') + 1]!, 'A.chd'), 'half')
        t.service.stop()
        return 130
      }
    })
    await t.service.start({ platformId: 'ps2', pairId: 'ps2-iso-chd', reversed: false, paths: [a] })
    expect((await t.finished()).items[0]!.state).toBe('stopped')
    expect(await fs.readdir(dir)).toEqual(['A.iso'])
  })

  it('stops during the first-run download, converting nothing', async () => {
    const a = await file('A.iso')
    let finish: () => void = () => {}
    const r = converter(made('A.chd'))
    const t = setup({
      run: r,
      ensure: () =>
        new Promise((resolve) => {
          finish = () => resolve({ version: '2.1.0', exe: 'gfc.exe' })
        })
    })
    await t.service.start({ platformId: 'ps2', pairId: 'ps2-iso-chd', reversed: false, paths: [a] })
    t.service.stop()
    finish()
    expect((await t.finished()).items[0]!.state).toBe('stopped')
    expect(r.calls).toEqual([])
  })

  it('refuses a second start made while the first is still being checked', async () => {
    const a = await file('A.iso')
    const t = setup({ run: converter(made('A.chd')) })
    const request = { platformId: 'ps2', pairId: 'ps2-iso-chd', reversed: false, paths: [a] }
    const first = t.service.start(request)
    await expect(t.service.start(request)).rejects.toThrow('already running')
    await first
    await t.finished()
  })

  it("converts a game's packages together, recycling them only when everything was made", async () => {
    const base = await file('Game.pkg')
    const update = await file('Game-Update.pkg')
    const r = converter(
      async (out) => {
        await fs.mkdir(join(out, 'BLUS00001'))
      },
      () => 'OK   Game.pkg: → BLUS00001'
    )
    await fs.mkdir(join(dir, 'Emulation', 'bios', 'ps3'), { recursive: true })
    await fs.writeFile(
      join(dir, 'Emulation', 'bios', 'ps3', 'pkg-key.txt'),
      '00112233445566778899aabbccddeeff'
    )
    const t = setup({ run: r })
    await t.service.start({
      platformId: 'ps3',
      pairId: 'ps3-pkg-folder',
      reversed: false,
      paths: [base, update]
    })
    const done = await t.finished()
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.slice(0, 3)).toEqual(['cli', base, update])
    expect(done.items.map((i) => i.state)).toEqual(['done', 'done'])
    expect(done.items[0]!.output).toBe(join(dir, 'BLUS00001'))
    expect(t.trashed.sort()).toEqual([base, update].sort())
  })

  it('does not move the record to a folder the ROM scan will not know as a game', async () => {
    const iso = await file('Game.iso')
    const game = {
      id: 'rom:ps3:old',
      source: 'rom',
      externalId: 'ps3/Game.iso',
      platformId: 'ps3',
      title: 'Game',
      romPath: iso
    } as unknown as Game
    const t = setup({
      games: [game],
      run: converter(async (out) => {
        await fs.mkdir(join(out, 'Game'))
      })
    })
    await t.service.start({
      platformId: 'ps3',
      pairId: 'ps3-folder-iso',
      reversed: true,
      paths: [iso]
    })
    expect((await t.finished()).items[0]!.state).toBe('done')
    expect(t.rekeyed).toEqual([])
  })

  it('moves the record onto an unpacked PS3 disc folder (PS3_GAME), which the ROM scan lists as the game', async () => {
    const iso = await file('Game.iso')
    const game = {
      id: 'rom:ps3:old',
      source: 'rom',
      externalId: 'ps3/Game.iso',
      platformId: 'ps3',
      title: 'Game',
      romPath: iso
    } as unknown as Game
    const t = setup({
      games: [game],
      run: converter(async (out) => {
        await fs.mkdir(join(out, 'Game', 'PS3_GAME', 'USRDIR'), { recursive: true })
        await fs.writeFile(join(out, 'Game', 'PS3_DISC.SFB'), 'sfb')
      })
    })
    await t.service.start({
      platformId: 'ps3',
      pairId: 'ps3-folder-iso',
      reversed: true,
      paths: [iso]
    })
    expect((await t.finished()).items[0]!.state).toBe('done')
    expect(t.rekeyed).toEqual([['rom:ps3:old', 'ps3/Game', join(dirname(iso), 'Game')]])
  })
})
