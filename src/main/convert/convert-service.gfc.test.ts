import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConvertStatus } from '../../shared/convert'
import { createConvertService } from './convert-service'

/**
 * Against the real Game Format Converter (opt-in: PLAYOUT_GFC_EXE = its "Game Format Converter.exe"), on made-up
 * discs in a temporary folder: PlayOut's runner, its verdict and output reading, the two-step route, and recycling.
 */
const EXE = process.env['PLAYOUT_GFC_EXE']
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

describe.skipIf(!EXE)('Convert with the real converter', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-gfc-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function convert(
    platformId: string,
    pairId: string,
    reversed: boolean,
    paths: string[]
  ): Promise<{
    status: ConvertStatus
    trashed: string[]
  }> {
    const statuses: ConvertStatus[] = []
    const trashed: string[] = []
    const service = createConvertService({
      toolRoot: join(dir, 'tool'),
      workDir: join(dir, 'work'),
      emulationDir: () => join(dir, 'Emulation'),
      emulatorPath: async () => null,
      library: { games: () => [], rekeyRom: () => null },
      romExtensions: () => null,
      imageCache: { moveGame: async () => (url: string) => url },
      trash: async (path) => {
        trashed.push(path)
        await fs.rm(path, { recursive: true, force: true })
      },
      rescanRoms: async () => {},
      emit: (s) => statuses.push(s),
      log,
      ensure: async () => ({ version: 'test', exe: EXE! })
    })
    await service.start({ platformId, pairId, reversed, paths })
    await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false), { timeout: 120_000 })
    return { status: statuses.at(-1)!, trashed }
  }

  it('ISO → CHD → ISO gives the same disc back', async () => {
    const data = Buffer.alloc(2048 * 600, 7)
    const iso = join(dir, 'Disc.iso')
    await fs.writeFile(iso, data)
    const there = await convert('ps2', 'ps2-iso-chd', false, [iso])
    expect(there.status.items[0]).toMatchObject({ state: 'done', output: join(dir, 'Disc.chd') })
    expect(there.trashed).toEqual([iso])
    const back = await convert('ps2', 'ps2-iso-chd', true, [join(dir, 'Disc.chd')])
    expect(back.status.items[0]).toMatchObject({ state: 'done', output: iso })
    expect((await fs.readFile(iso)).equals(data)).toBe(true)
  }, 180_000)

  it('ISO → CUE/BIN goes through a CHD and back to an ISO', async () => {
    const data = Buffer.alloc(2048 * 600, 9)
    const iso = join(dir, 'Bin Game.iso')
    await fs.writeFile(iso, data)
    const there = await convert('ps2', 'ps2-iso-bin', false, [iso])
    expect(there.status.items[0]).toMatchObject({
      state: 'done',
      output: join(dir, 'Bin Game.cue')
    })
    const cue = join(dir, 'Bin Game.cue')
    const back = await convert('ps2', 'ps2-iso-bin', true, [cue])
    expect(back.status.items[0]).toMatchObject({ state: 'done', output: iso })
    expect(back.trashed.sort()).toEqual([join(dir, 'Bin Game.bin'), cue].sort())
    expect((await fs.readFile(iso)).equals(data)).toBe(true)
  }, 240_000)

  it('ISO → CSO and ZSO and back', async () => {
    const data = Buffer.alloc(2048 * 600, 3)
    for (const [pairId, ext] of [
      ['psp-iso-cso', '.cso'],
      ['psp-iso-zso', '.zso']
    ] as const) {
      const iso = join(dir, `Psp${ext}.iso`.replace(ext, ''))
      await fs.writeFile(iso, data)
      const there = await convert('psp', pairId, false, [iso])
      expect(there.status.items[0]).toMatchObject({ state: 'done' })
      const made = there.status.items[0]!.output!
      expect(made.endsWith(ext)).toBe(true)
      const back = await convert('psp', pairId, true, [made])
      expect(back.status.items[0]).toMatchObject({ state: 'done', output: iso })
      expect((await fs.readFile(iso)).equals(data)).toBe(true)
    }
  }, 240_000)

  it('a CD with an audio track goes to CHD and back to CUE/BIN (one BIN)', async () => {
    const data = Buffer.alloc(2352 * 300, 5)
    const audio = Buffer.alloc(2352 * 300, 0x21)
    await fs.writeFile(join(dir, 'Two Track (Track 1).bin'), data)
    await fs.writeFile(join(dir, 'Two Track (Track 2).bin'), audio)
    const cue = join(dir, 'Two Track.cue')
    await fs.writeFile(
      cue,
      [
        'FILE "Two Track (Track 1).bin" BINARY',
        '  TRACK 01 MODE2/2352',
        '    INDEX 01 00:00:00',
        'FILE "Two Track (Track 2).bin" BINARY',
        '  TRACK 02 AUDIO',
        '    INDEX 00 00:00:00',
        '    INDEX 01 00:02:00',
        ''
      ].join('\r\n')
    )
    const there = await convert('psx', 'psx-cue-chd', false, [cue])
    expect(there.status.items[0]).toMatchObject({
      state: 'done',
      output: join(dir, 'Two Track.chd')
    })
    expect(there.trashed).toHaveLength(3)
    const back = await convert('psx', 'psx-cue-chd', true, [join(dir, 'Two Track.chd')])
    expect(back.status.items[0]).toMatchObject({ state: 'done' })
    expect(back.status.items[0]!.output!.toLowerCase().endsWith('.cue')).toBe(true)
  }, 240_000)

  it("reports the converter's refusal and keeps the file", async () => {
    const iso = join(dir, 'NotXbox.iso')
    await fs.writeFile(iso, Buffer.alloc(2048 * 600, 1))
    const result = await convert('xbox360', 'x360-iso-zar', false, [iso])
    expect(result.status.items[0]!.state).toBe('failed')
    expect(result.status.items[0]!.detail).toBeTruthy()
    expect(result.trashed).toEqual([])
    await fs.access(iso)
  }, 120_000)
})
