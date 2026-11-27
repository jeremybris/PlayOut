import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadRomSet,
  openRomFile,
  parseGdiFiles,
  romFileSet,
  RomDownloadCancelled,
  romTarget,
  type RomArea,
  type RomFetchRequest,
  type RomDownloadStep,
  type RomFile,
  writeOrder
} from './rom-transfer'
import { ps3HddDir } from '../emulation/ps3-hdd'
import { scanRomRoot } from '../emulation/rom-scanner'
import { loadSystemCatalog } from '../emulation/systems'
import type { Logger } from '../logger'
import { MAX_FILE_STREAMS_PER_CLIENT } from './host-server'

const catalog = loadSystemCatalog(
  join(resolve(__dirname, '../../..'), 'resources', 'systems', 'systems.json')
)
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

let dir: string
let roms: string

async function put(rel: string, content: string | Buffer): Promise<void> {
  const path = join(roms, rel)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-rom-transfer-'))
  roms = join(dir, 'roms')
  await fs.mkdir(roms)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('romFileSet', () => {
  it('lists a single ROM file', async () => {
    await put('snes/Super Metroid (USA).sfc', 'abcd')
    const set = await romFileSet({ externalId: 'snes/Super Metroid (USA).sfc' }, roms)
    expect(set).toEqual({
      files: [{ path: 'snes/Super Metroid (USA).sfc', size: 4 }],
      totalBytes: 4
    })
  })

  it('uses the absolute romPath when there is one', async () => {
    await put('snes/Game.sfc', 'ab')
    const set = await romFileSet(
      { externalId: 'ignored', romPath: join(roms, 'snes', 'Game.sfc') },
      roms
    )
    expect(set.files.map((f) => f.path)).toEqual(['snes/Game.sfc'])
  })

  it('includes a cue sheet and its tracks', async () => {
    await put(
      'psx/Game/Game.cue',
      'FILE "Game (Track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\nFILE Track2.bin BINARY\r\n'
    )
    await put('psx/Game/Game (Track 1).bin', '12345')
    await put('psx/Game/Track2.bin', '12')
    const set = await romFileSet({ externalId: 'psx/Game/Game.cue' }, roms)
    expect(set.files.map((f) => f.path)).toEqual([
      'psx/Game/Game.cue',
      'psx/Game/Game (Track 1).bin',
      'psx/Game/Track2.bin'
    ])
    expect(set.totalBytes).toBe(set.files.reduce((s, f) => s + f.size, 0))
  })

  it('follows an m3u to its discs and their cue tracks, once each', async () => {
    await put('psx/FF7.m3u', '# discs\nFF7 (Disc 1).cue\nFF7 (Disc 2).chd\nFF7 (Disc 1).cue\n')
    await put('psx/FF7 (Disc 1).cue', 'FILE "FF7 (Disc 1).bin" BINARY\n')
    await put('psx/FF7 (Disc 1).bin', 'x')
    await put('psx/FF7 (Disc 2).chd', 'y')
    const set = await romFileSet({ externalId: 'psx/FF7.m3u' }, roms)
    expect(set.files.map((f) => f.path)).toEqual([
      'psx/FF7.m3u',
      'psx/FF7 (Disc 1).cue',
      'psx/FF7 (Disc 1).bin',
      'psx/FF7 (Disc 2).chd'
    ])
  })

  it('stops at a playlist that lists itself', async () => {
    await put('psx/Loop.m3u', 'Loop.m3u\n')
    const set = await romFileSet({ externalId: 'psx/Loop.m3u' }, roms)
    expect(set.files.map((f) => f.path)).toEqual(['psx/Loop.m3u'])
  })

  it('reads each sheet once, however often it is listed', async () => {
    await put('psx/Loop.m3u', 'Loop.m3u\n'.repeat(50) + 'A.cue\nB.cue\n')
    await put('psx/A.cue', 'FILE "B.cue" BINARY\nFILE "a.bin" BINARY\n')
    await put('psx/B.cue', 'FILE "A.cue" BINARY\nFILE "b.bin" BINARY\n')
    await put('psx/a.bin', 'a')
    await put('psx/b.bin', 'b')
    const reads = vi.spyOn(fs, 'readFile')
    const started = Date.now()
    const set = await romFileSet({ externalId: 'psx/Loop.m3u' }, roms)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(reads).toHaveBeenCalledTimes(3)
    reads.mockRestore()
    expect(set.files.map((f) => f.path).sort()).toEqual([
      'psx/A.cue',
      'psx/B.cue',
      'psx/Loop.m3u',
      'psx/a.bin',
      'psx/b.bin'
    ])
  })

  it('includes gdi tracks', async () => {
    await put('dreamcast/Game.gdi', '2\n1 0 4 2352 track01.bin 0\n2 600 0 2352 "track 02.raw" 0\n')
    await put('dreamcast/track01.bin', 'a')
    await put('dreamcast/track 02.raw', 'b')
    const set = await romFileSet({ externalId: 'dreamcast/Game.gdi' }, roms)
    expect(set.files.map((f) => f.path)).toEqual([
      'dreamcast/Game.gdi',
      'dreamcast/track01.bin',
      'dreamcast/track 02.raw'
    ])
  })

  it('lists every file under a game directory', async () => {
    await put('ps3/Game.ps3/PS3_GAME/PARAM.SFO', 'p')
    await put('ps3/Game.ps3/PS3_GAME/USRDIR/EBOOT.BIN', 'ee')
    const set = await romFileSet({ externalId: 'ps3/Game.ps3' }, roms)
    expect(set.files.map((f) => f.path).sort()).toEqual([
      'ps3/Game.ps3/PS3_GAME/PARAM.SFO',
      'ps3/Game.ps3/PS3_GAME/USRDIR/EBOOT.BIN'
    ])
    expect(set.totalBytes).toBe(3)
  })

  it('leaves out sheet references outside the ROM root and missing files', async () => {
    await fs.writeFile(join(dir, 'secret.bin'), 'secret')
    await put('psx/Bad.cue', 'FILE "../../secret.bin" BINARY\nFILE "missing.bin" BINARY\n')
    const set = await romFileSet({ externalId: 'psx/Bad.cue' }, roms)
    expect(set.files.map((f) => f.path)).toEqual(['psx/Bad.cue'])
  })

  it('refuses a game outside the ROM root or missing', async () => {
    await fs.writeFile(join(dir, 'outside.sfc'), 'x')
    await expect(romFileSet({ externalId: '../outside.sfc' }, roms)).rejects.toThrow(/outside/)
    await expect(romFileSet({ externalId: 'snes/none.sfc' }, roms)).rejects.toThrow(/no longer/)
  })
})

describe('parseGdiFiles', () => {
  it('skips the count line and junk', () => {
    expect(parseGdiFiles('1\n1 0 4 2352 a.bin 0\nnot a track\n', 'C:\\r').length).toBe(1)
  })
})

describe('openRomFile', () => {
  it('returns files of the set and refuses everything else', async () => {
    await put('psx/Game.cue', 'FILE "Game.bin" BINARY\n')
    await put('psx/Game.bin', '123')
    await put('psx/Other.bin', '1')
    const game = { externalId: 'psx/Game.cue' }
    const file = await openRomFile(game, roms, 'psx/game.BIN')
    expect(file).toEqual({ path: join(roms, 'psx', 'Game.bin'), size: 3 })
    await expect(openRomFile(game, roms, 'psx/Other.bin')).rejects.toThrow(/Not a file/)
    await expect(openRomFile(game, roms, '../roms/psx/Game.bin')).rejects.toThrow(/Not a file/)
  })
})

describe('writeOrder', () => {
  it('writes the sheets after their tracks and the game file last', () => {
    const order = writeOrder([
      { path: 'psx/Game.m3u', size: 1 },
      { path: 'psx/Disc 1.cue', size: 1 },
      { path: 'psx/Disc 1.bin', size: 1 },
      { path: 'psx/Disc 2.CUE', size: 1 },
      { path: 'psx/Disc 2.bin', size: 1 }
    ]).map((f) => f.path)
    expect(order).toEqual([
      'psx/Disc 1.bin',
      'psx/Disc 2.bin',
      'psx/Disc 2.CUE',
      'psx/Disc 1.cue',
      'psx/Game.m3u'
    ])
    expect(writeOrder([{ path: 'snes/a.sfc', size: 1 }])).toEqual([{ path: 'snes/a.sfc', size: 1 }])
  })
})

describe('downloadRomSet', () => {
  const content: Record<string, Buffer> = {
    'snes/a.sfc': Buffer.from('0123456789'),
    'snes/sub/b.bin': Buffer.from('abcdef')
  }
  const files = Object.entries(content).map(([path, data]) => ({ path, size: data.length }))

  function fetcher(calls: RomFetchRequest[], chunk = 4) {
    return async (req: RomFetchRequest): Promise<void> => {
      calls.push(req)
      const data = content[req.path].subarray(req.from)
      for (let i = 0; i < data.length; i += chunk) {
        const piece = data.subarray(i, i + chunk)
        await fs.appendFile(req.dest, piece)
        req.onBytes(piece.length)
      }
    }
  }

  it('downloads every file to the same relative path', async () => {
    const dest = join(dir, 'client')
    const calls: RomFetchRequest[] = []
    const steps: RomDownloadStep[] = []
    let t = 0
    const written = await downloadRomSet({
      files,
      destRoot: dest,
      fetchFile: fetcher(calls),
      onProgress: (s) => steps.push(s),
      now: () => (t += 10),
      freeBytes: async () => null
    })
    expect(written).toEqual([join(dest, 'snes', 'a.sfc'), join(dest, 'snes', 'sub', 'b.bin')])
    expect(await fs.readFile(written[0], 'utf8')).toBe('0123456789')
    expect(await fs.readFile(written[1], 'utf8')).toBe('abcdef')
    expect(calls.map((c) => c.from)).toEqual([0, 0])
    expect(steps.at(-1)).toMatchObject({ bytesDone: 16, bytesTotal: 16, percent: 100 })
    // Throttled: the 10 ms clock never lets the in-between byte reports through.
    expect(steps.every((s) => s.bytesDone <= 16)).toBe(true)
    expect(steps.length).toBeLessThan(6)
  })

  it('resumes from a .part file and skips finished files', async () => {
    const dest = join(dir, 'client')
    await fs.mkdir(join(dest, 'snes', 'sub'), { recursive: true })
    await fs.writeFile(join(dest, 'snes', 'a.sfc'), '0123456789')
    await fs.writeFile(join(dest, 'snes', 'sub', 'b.bin.part'), 'abc')
    const calls: RomFetchRequest[] = []
    const steps: RomDownloadStep[] = []
    await downloadRomSet({
      files,
      destRoot: dest,
      fetchFile: fetcher(calls),
      onProgress: (s) => steps.push(s),
      freeBytes: async () => null
    })
    expect(calls.map((c) => [c.path, c.from])).toEqual([['snes/sub/b.bin', 3]])
    expect(steps[0].bytesDone).toBe(13)
    expect(await fs.readFile(join(dest, 'snes', 'sub', 'b.bin'), 'utf8')).toBe('abcdef')
    await expect(fs.stat(join(dest, 'snes', 'sub', 'b.bin.part'))).rejects.toThrow()
  })

  it('restarts a .part that is bigger than the file', async () => {
    const dest = join(dir, 'client')
    await fs.mkdir(join(dest, 'snes'), { recursive: true })
    await fs.writeFile(join(dest, 'snes', 'a.sfc.part'), 'x'.repeat(50))
    const calls: RomFetchRequest[] = []
    await downloadRomSet({
      files: [files[0]],
      destRoot: dest,
      fetchFile: fetcher(calls),
      freeBytes: async () => null
    })
    expect(calls[0].from).toBe(0)
    expect(await fs.readFile(join(dest, 'snes', 'a.sfc'), 'utf8')).toBe('0123456789')
  })

  it('refuses paths that leave the destination before writing anything', async () => {
    const dest = join(dir, 'client')
    for (const path of ['../evil.bin', 'C:/evil.bin', '/abs.bin', 'a/../../b.bin', 'bad:name.bin'])
      await expect(
        downloadRomSet({
          files: [files[0], { path, size: 1 }],
          destRoot: dest,
          fetchFile: async () => {},
          freeBytes: async () => null
        })
      ).rejects.toThrow(/Unsafe/)
    await expect(fs.stat(dest)).rejects.toThrow()
  })

  it('fails when the host stops early, keeping the .part to resume', async () => {
    const dest = join(dir, 'client')
    await expect(
      downloadRomSet({
        files: [files[0]],
        destRoot: dest,
        fetchFile: async (req) => {
          await fs.appendFile(req.dest, '0123')
        },
        freeBytes: async () => null
      })
    ).rejects.toThrow(/stopped before the end/)
    expect(await fs.readFile(join(dest, 'snes', 'a.sfc.part'), 'utf8')).toBe('0123')
  })

  it('stops a host that sends more than the listed size, without waiting for it to finish', async () => {
    const dest = join(dir, 'client')
    let sent = 0
    const seen: RomFetchRequest[] = []
    await expect(
      downloadRomSet({
        files: [files[0]],
        destRoot: dest,
        freeBytes: async () => null,
        fetchFile: async (req) => {
          seen.push(req)
          // An endless sender: only our abort stops it.
          while (!req.signal?.aborted) {
            await fs.appendFile(req.dest, '0123')
            sent += 4
            req.onBytes(4)
            if (sent > 1000) throw new Error('never stopped')
          }
          throw new Error('aborted')
        }
      })
    ).rejects.toThrow(/more data than expected/)
    expect(seen[0].size).toBe(10)
    expect(sent).toBe(12)
    await expect(fs.stat(join(dest, 'snes', 'a.sfc.part'))).rejects.toThrow()
  })

  it('checks the free space for what is still missing', async () => {
    await expect(
      downloadRomSet({
        files,
        destRoot: join(dir, 'client'),
        fetchFile: async () => {},
        freeBytes: async () => 5
      })
    ).rejects.toThrow(/Not enough free space/)
  })

  it('cancels, keeping or removing the .part files as asked', async () => {
    for (const removePartsOnCancel of [false, true]) {
      const dest = join(dir, `client-${removePartsOnCancel}`)
      const controller = new AbortController()
      await expect(
        downloadRomSet({
          files,
          destRoot: dest,
          signal: controller.signal,
          removePartsOnCancel,
          freeBytes: async () => null,
          fetchFile: async (req) => {
            await fs.appendFile(req.dest, '01')
            controller.abort()
            throw new Error('aborted by fetch')
          }
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      const part = fs.stat(join(dest, 'snes', 'a.sfc.part'))
      if (removePartsOnCancel) await expect(part).rejects.toThrow()
      else expect((await part).size).toBe(2)
    }
  })
})

describe('the PS3 HDD area', () => {
  it('maps paths under the area name to its folder, anywhere the ROM folder is', () => {
    const hdd = ps3HddDir(join(dir, 'Emulation'))
    expect(hdd).toBe(join(dir, 'Emulation', 'Updates and DLC', 'PS3'))
    const areas = [{ name: 'PS3 HDD', dir: hdd }]
    expect(romTarget(roms, 'ps3 hdd/dev_hdd0/game/BLUS30443/PARAM.SFO', areas)).toBe(
      join(hdd, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO')
    )
    expect(romTarget(roms, 'ps3/Game.iso', areas)).toBe(join(roms, 'ps3', 'Game.iso'))
    // Without the area (an older PC) the path stays in the ROM folder.
    expect(romTarget(roms, 'PS3 HDD/dev_hdd0/x', [])).toBe(join(roms, 'PS3 HDD', 'dev_hdd0', 'x'))
    for (const bad of ['PS3 HDD', 'PS3 HDD/', 'PS3 HDD/../x', '../x', 'C:/x', ''])
      expect(romTarget(roms, bad, areas)).toBeNull()
  })

  it('serves and downloads a PS3 HDD file through the area', async () => {
    const hostHdd = join(dir, 'host', 'PS3 HDD')
    await fs.mkdir(join(hostHdd, 'dev_hdd0', 'game', 'BLUS30443'), { recursive: true })
    await fs.writeFile(join(hostHdd, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO'), 'update')
    await put('ps3/Game.iso', 'disc')
    const game = { externalId: 'ps3/Game.iso' }
    const set = {
      files: [
        { path: 'ps3/Game.iso', size: 4 },
        { path: 'PS3 HDD/dev_hdd0/game/BLUS30443/PARAM.SFO', size: 6 }
      ],
      totalBytes: 10
    }
    const hostAreas = [{ name: 'PS3 HDD', dir: hostHdd }]
    const served = await openRomFile(
      game,
      roms,
      'PS3 HDD/dev_hdd0/game/BLUS30443/PARAM.SFO',
      set,
      hostAreas
    )
    expect(served).toEqual({
      path: join(hostHdd, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO'),
      size: 6
    })
    await expect(openRomFile(game, roms, 'PS3 HDD/dev_hdd0/other', set, hostAreas)).rejects.toThrow(
      /Not a file/
    )

    const clientRoms = join(dir, 'client', 'roms')
    const clientHdd = ps3HddDir(join(dir, 'client', 'Emulation'))
    const written = await downloadRomSet({
      files: set.files,
      destRoot: clientRoms,
      areas: [{ name: 'PS3 HDD', dir: clientHdd }],
      fetchFile: async (req) => {
        const from = req.path.startsWith('PS3 HDD/') ? served.path : join(roms, 'ps3', 'Game.iso')
        await fs.appendFile(req.dest, await fs.readFile(from))
      },
      freeBytes: async () => null
    })
    // The updates first, the game (which a ROM scan picks up) last.
    expect(written).toEqual([
      join(clientHdd, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO'),
      join(clientRoms, 'ps3', 'Game.iso')
    ])
    expect(await fs.readFile(written[0], 'utf8')).toBe('update')
    await expect(fs.stat(join(clientRoms, 'PS3 HDD'))).rejects.toThrow()
  })
})

describe('PS3 HDD files that change in place', () => {
  it('replaces a copy of another time even at the same size, keeps one of the same time, and stamps the time', async () => {
    const dest = join(dir, 'client')
    const hdd = join(dir, 'client-hdd')
    const areas = [{ name: 'PS3 HDD', dir: hdd }]
    const time = Date.UTC(2026, 0, 2, 3, 4, 5)
    const sfo = join(hdd, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO')
    const eboot = join(hdd, 'dev_hdd0', 'game', 'BLUS30443', 'EBOOT.BIN')
    await fs.mkdir(join(sfo, '..'), { recursive: true })
    // Update 1.01 here, 1.05 on the host: same size, another time.
    await fs.writeFile(sfo, '0101')
    await fs.utimes(sfo, new Date(time - 86_400_000), new Date(time - 86_400_000))
    // Already the host's copy: kept.
    await fs.writeFile(eboot, 'same')
    await fs.utimes(eboot, new Date(time), new Date(time))
    const fetched: string[] = []
    await downloadRomSet({
      files: [
        { path: 'PS3 HDD/dev_hdd0/game/BLUS30443/PARAM.SFO', size: 4, mtimeMs: time },
        { path: 'PS3 HDD/dev_hdd0/game/BLUS30443/EBOOT.BIN', size: 4, mtimeMs: time }
      ],
      destRoot: dest,
      areas,
      fetchFile: async (req) => {
        fetched.push(req.path)
        await fs.appendFile(req.dest, '0105')
      },
      freeBytes: async () => null
    })
    expect(fetched).toEqual(['PS3 HDD/dev_hdd0/game/BLUS30443/PARAM.SFO'])
    expect(await fs.readFile(sfo, 'utf8')).toBe('0105')
    expect(Math.abs((await fs.stat(sfo)).mtimeMs - time)).toBeLessThan(1000)
    await expect(
      downloadRomSet({
        files: [{ path: 'PS3 HDD/x', size: 1, mtimeMs: -5 }],
        destRoot: dest,
        areas,
        fetchFile: async () => {},
        freeBytes: async () => null
      })
    ).rejects.toThrow(/Bad file time/)
  })

  it('checks the free space of the drive the PS3 HDD is on too', async () => {
    const asked: string[] = []
    await expect(
      downloadRomSet({
        files: [
          { path: 'ps3/Game.iso', size: 10 },
          { path: 'PS3 HDD/dev_hdd0/game/BLUS30443/big.edat', size: 500 }
        ],
        destRoot: join(dir, 'client'),
        areas: [{ name: 'PS3 HDD', dir: 'Q:/Emulation/Updates and DLC/PS3' }],
        fetchFile: async () => {
          throw new Error('nothing is fetched')
        },
        freeBytes: async (d) => {
          asked.push(d)
          return d.toUpperCase().startsWith('Q:') ? 100 : 1_000_000
        }
      })
    ).rejects.toThrow(/Not enough free space in the PS3 HDD/)
    expect(asked[0]).toMatch(/^Q:/i)
  })
})

describe('PS3 HDD partial files and limits', () => {
  it('never resumes a part of another version of a file, and drops it', async () => {
    const hdd = join(dir, 'hdd')
    const areas = [{ name: 'PS3 HDD', dir: hdd }]
    const target = join(hdd, 'dev_hdd0', 'game', 'BLUS30443', 'EBOOT.BIN')
    await fs.mkdir(join(target, '..'), { recursive: true })
    // Half of version 1 (time 1000) is there; the host now has version 2 (time 2000).
    await fs.writeFile(`${target}.t1000.part`, 'OLD')
    const froms: number[] = []
    await downloadRomSet({
      files: [{ path: 'PS3 HDD/dev_hdd0/game/BLUS30443/EBOOT.BIN', size: 6, mtimeMs: 2000 }],
      destRoot: join(dir, 'client'),
      areas,
      fetchFile: async (req) => {
        froms.push(req.from)
        await fs.appendFile(req.dest, 'NEWNEW'.slice(req.from))
      },
      freeBytes: async () => null
    })
    expect(froms).toEqual([0])
    expect(await fs.readFile(target, 'utf8')).toBe('NEWNEW')
    expect((await fs.readdir(join(target, '..'))).sort()).toEqual(['EBOOT.BIN'])

    // A part of the same version resumes.
    await fs.rm(target)
    await fs.writeFile(`${target}.t3000.part`, 'abc')
    froms.length = 0
    await downloadRomSet({
      files: [{ path: 'PS3 HDD/dev_hdd0/game/BLUS30443/EBOOT.BIN', size: 6, mtimeMs: 3000 }],
      destRoot: join(dir, 'client'),
      areas,
      fetchFile: async (req) => {
        froms.push(req.from)
        await fs.appendFile(req.dest, 'abcdef'.slice(req.from))
      },
      freeBytes: async () => null
    })
    expect(froms).toEqual([3])
    expect(await fs.readFile(target, 'utf8')).toBe('abcdef')
  })

  it('keeps a copy an hour off (a FAT drive after a daylight saving change)', async () => {
    const hdd = join(dir, 'hdd')
    const target = join(hdd, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO')
    await fs.mkdir(join(target, '..'), { recursive: true })
    await fs.writeFile(target, 'same')
    const time = Date.UTC(2026, 2, 1)
    await fs.utimes(target, new Date(time + 3_600_000), new Date(time + 3_600_000))
    const fetched: string[] = []
    await downloadRomSet({
      files: [{ path: 'PS3 HDD/dev_hdd0/game/BLUS30443/PARAM.SFO', size: 4, mtimeMs: time }],
      destRoot: join(dir, 'client'),
      areas: [{ name: 'PS3 HDD', dir: hdd }],
      fetchFile: async (req) => {
        fetched.push(req.path)
      },
      freeBytes: async () => null
    })
    expect(fetched).toEqual([])
  })

  it('refuses area paths the area does not take', async () => {
    const areas = [
      { name: 'PS3 HDD', dir: join(dir, 'hdd'), allows: (s: string[]) => s[0] === 'ok' }
    ]
    expect(romTarget(roms, 'PS3 HDD/ok/file', areas)).toBe(join(dir, 'hdd', 'ok', 'file'))
    expect(romTarget(roms, 'PS3 HDD/no/file', areas)).toBeNull()
    await expect(
      downloadRomSet({
        files: [{ path: 'PS3 HDD/no/file', size: 1 }],
        destRoot: join(dir, 'client'),
        areas,
        fetchFile: async () => {},
        freeBytes: async () => null
      })
    ).rejects.toThrow(/Unsafe file path/)
  })
})

describe('a newer PS3 HDD copy on the client', () => {
  it('is kept (an update installed on this PC itself is never downgraded)', async () => {
    const hdd = join(dir, 'hdd')
    const target = join(hdd, 'dev_hdd0', 'game', 'BLUS30443', 'PARAM.SFO')
    await fs.mkdir(join(target, '..'), { recursive: true })
    await fs.writeFile(target, '0105')
    const host = Date.UTC(2026, 0, 1)
    await fs.utimes(target, new Date(host + 86_400_000), new Date(host + 86_400_000))
    const fetched: string[] = []
    await downloadRomSet({
      // The host's older copy is another size: still not downloaded.
      files: [{ path: 'PS3 HDD/dev_hdd0/game/BLUS30443/PARAM.SFO', size: 9, mtimeMs: host }],
      destRoot: join(dir, 'client'),
      areas: [{ name: 'PS3 HDD', dir: hdd }],
      fetchFile: async (req) => {
        fetched.push(req.path)
      },
      freeBytes: async () => null
    })
    expect(fetched).toEqual([])
    expect(await fs.readFile(target, 'utf8')).toBe('0105')
  })
})

describe('a keep-existing area (texture packs)', () => {
  it('never replaces a file already on this PC, whatever its size, and fetches only what is missing', async () => {
    const dest = join(dir, 'client')
    const tex = join(dir, 'texturepacks')
    const area = { name: 'Texture Packs', dir: tex, keepExisting: true }
    await fs.mkdir(join(tex, 'pcsx2', 'SLUS-20777'), { recursive: true })
    // The client's own edit: another size than the host's.
    await fs.writeFile(join(tex, 'pcsx2', 'SLUS-20777', 'a.png'), 'mine, edited')
    const fetched: string[] = []
    const steps: RomDownloadStep[] = []
    const written = await downloadRomSet({
      files: [
        { path: 'ps2/Game.iso', size: 3 },
        { path: 'Texture Packs/pcsx2/SLUS-20777/a.png', size: 2 },
        { path: 'Texture Packs/pcsx2/SLUS-20777/b.png', size: 2 }
      ],
      destRoot: dest,
      areas: [area],
      fetchFile: async (req) => {
        fetched.push(req.path)
        await fs.appendFile(req.dest, Buffer.alloc(req.size, 1))
        req.onBytes(req.size)
      },
      onProgress: (s) => steps.push(s),
      freeBytes: async () => null
    })
    expect(fetched.sort()).toEqual(['Texture Packs/pcsx2/SLUS-20777/b.png', 'ps2/Game.iso'])
    expect(await fs.readFile(join(tex, 'pcsx2', 'SLUS-20777', 'a.png'), 'utf8')).toBe(
      'mine, edited'
    )
    expect(written).toContain(join(tex, 'pcsx2', 'SLUS-20777', 'a.png'))
    expect(steps.at(-1)).toMatchObject({ bytesDone: 7, bytesTotal: 7, percent: 100 })
    // Without the flag (the PS3 HDD), a copy of another size is replaced.
    fetched.length = 0
    await downloadRomSet({
      files: [{ path: 'Texture Packs/pcsx2/SLUS-20777/a.png', size: 2 }],
      destRoot: dest,
      areas: [{ ...area, keepExisting: false }],
      fetchFile: async (req) => {
        fetched.push(req.path)
        await fs.appendFile(req.dest, Buffer.alloc(req.size, 1))
        req.onBytes(req.size)
      },
      freeBytes: async () => null
    })
    expect(fetched).toEqual(['Texture Packs/pcsx2/SLUS-20777/a.png'])
  })

  it('keepSameSize: keeps a copy of the same size whatever its time, a newer one too, and replaces an older one', async () => {
    const dest = join(dir, 'client')
    const upd = join(dir, 'Updates and DLC')
    const area = { name: 'Updates and DLC', dir: upd, keepSameSize: true }
    const sw = join(upd, 'Switch')
    await fs.mkdir(sw, { recursive: true })
    const host = Date.parse('2026-06-01T00:00:00Z')
    // Same size, older: copied by hand. Other size, newer: installed here. Other size, older: replaced.
    await fs.writeFile(join(sw, 'same.nsp'), 'abc')
    await fs.utimes(join(sw, 'same.nsp'), new Date(host - 86_400_000), new Date(host - 86_400_000))
    await fs.writeFile(join(sw, 'newer.nsp'), 'mine!')
    await fs.utimes(join(sw, 'newer.nsp'), new Date(host + 86_400_000), new Date(host + 86_400_000))
    await fs.writeFile(join(sw, 'older.nsp'), 'x')
    await fs.utimes(join(sw, 'older.nsp'), new Date(host - 86_400_000), new Date(host - 86_400_000))
    const fetched: string[] = []
    await downloadRomSet({
      files: ['same', 'newer', 'older', 'missing'].map((n) => ({
        path: `Updates and DLC/Switch/${n}.nsp`,
        size: 3,
        mtimeMs: host
      })),
      destRoot: dest,
      areas: [area],
      fetchFile: async (req) => {
        fetched.push(req.path)
        await fs.appendFile(req.dest, Buffer.from('new'))
        req.onBytes(req.size)
      },
      freeBytes: async () => null
    })
    expect(fetched.sort()).toEqual([
      'Updates and DLC/Switch/missing.nsp',
      'Updates and DLC/Switch/older.nsp'
    ])
    expect(await fs.readFile(join(sw, 'same.nsp'), 'utf8')).toBe('abc')
    expect(await fs.readFile(join(sw, 'newer.nsp'), 'utf8')).toBe('mine!')
    expect(await fs.readFile(join(sw, 'older.nsp'), 'utf8')).toBe('new')
  })
})

describe('an optional area (a Switch game updates)', () => {
  const upd = (): string => join(dir, 'Updates and DLC')
  const area = (): RomArea => ({ name: 'Updates and DLC', dir: upd(), optional: true })
  const files = [
    { path: 'Updates and DLC/Switch/a.nsp', size: 3 },
    { path: 'switch/Game.xci', size: 4 },
    { path: 'Updates and DLC/Switch/b.nsp', size: 3 }
  ]

  it('comes after the game, and a file that fails is skipped, never the game', async () => {
    const order: string[] = []
    const skipped: string[] = []
    const written = await downloadRomSet({
      files,
      destRoot: join(dir, 'client'),
      areas: [area()],
      concurrency: 1,
      fetchFile: async (req) => {
        order.push(req.path)
        if (req.path.endsWith('a.nsp')) throw new Error('the host is still writing it')
        await fs.appendFile(req.dest, Buffer.alloc(req.size))
        req.onBytes(req.size)
      },
      onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`),
      freeBytes: async () => null
    })
    expect(order[0]).toBe('switch/Game.xci')
    expect(skipped).toEqual(['Updates and DLC/Switch/a.nsp: the host is still writing it'])
    expect(written.map((p) => basename(p)).sort()).toEqual(['Game.xci', 'b.nsp'])
    await expect(fs.stat(join(upd(), 'Switch', 'a.nsp'))).rejects.toThrow()
  })

  it('is left out when there is room for the game but not for it too', async () => {
    const skipped: string[] = []
    const fetched: string[] = []
    await downloadRomSet({
      files,
      destRoot: join(dir, 'client'),
      areas: [area()],
      fetchFile: async (req) => {
        fetched.push(req.path)
        await fs.appendFile(req.dest, Buffer.alloc(req.size))
        req.onBytes(req.size)
      },
      onSkipped: (path) => skipped.push(path),
      freeBytes: async () => 6
    })
    expect(fetched).toEqual(['switch/Game.xci'])
    expect(skipped.sort()).toEqual(['Updates and DLC/Switch/a.nsp', 'Updates and DLC/Switch/b.nsp'])
  })

  it('a cancel still cancels', async () => {
    const ac = new AbortController()
    await expect(
      downloadRomSet({
        files,
        destRoot: join(dir, 'client'),
        areas: [area()],
        signal: ac.signal,
        fetchFile: async (req) => {
          if (req.path.endsWith('.nsp')) ac.abort()
          await fs.appendFile(req.dest, Buffer.alloc(req.size))
          req.onBytes(req.size)
        },
        freeBytes: async () => null
      })
    ).rejects.toBeInstanceOf(RomDownloadCancelled)
  })
})

describe('many small files', () => {
  it('fetches a few at once, an area all before the game, and the sheets last', async () => {
    const dest = join(dir, 'client')
    const tex = join(dir, 'texturepacks')
    const files = [
      { path: 'psx/Game.cue', size: 2 },
      { path: 'psx/Game.bin', size: 3 },
      { path: 'psx/extra1.bin', size: 1 },
      { path: 'psx/extra2.bin', size: 1 },
      ...Array.from({ length: 12 }, (_, i) => ({
        path: `Texture Packs/duckstation/SCUS-99998/t${i}.png`,
        size: 4
      }))
    ]
    let running = 0
    let most = 0
    const started: string[] = []
    const finished: string[] = []
    const written = await downloadRomSet({
      files,
      destRoot: dest,
      areas: [{ name: 'Texture Packs', dir: tex, keepExisting: true }],
      fetchFile: async (req) => {
        started.push(req.path)
        running++
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, 5))
        await fs.appendFile(req.dest, Buffer.alloc(req.size, 1))
        req.onBytes(req.size)
        running--
        finished.push(req.path)
      },
      freeBytes: async () => null
    })
    expect(written).toHaveLength(files.length)
    expect(most).toBeGreaterThan(1)
    // One short of the host's per-client stream limit, so Emulation sync still gets a turn.
    expect(most).toBeLessThanOrEqual(MAX_FILE_STREAMS_PER_CLIENT - 1)
    const isTex = (p: string): boolean => p.startsWith('Texture Packs/')
    // Every texture file is in place before a file of the game starts.
    const firstGame = started.findIndex((p) => !isTex(p))
    expect(finished.slice(0, 12).every(isTex)).toBe(true)
    expect(started.slice(0, firstGame).length).toBe(12)
    // The sheet starts only once everything else is done.
    expect(started.at(-1)).toBe('psx/Game.cue')
    expect(finished.slice(0, -1)).not.toContain('psx/Game.cue')
    for (let i = 0; i < 12; i++)
      expect(await fs.stat(join(tex, 'duckstation', 'SCUS-99998', `t${i}.png`))).toBeTruthy()
  })

  it('hundreds of tiny files do not flood the progress (the first and the last still go out)', async () => {
    const dest = join(dir, 'client')
    const files = Array.from({ length: 300 }, (_, i) => ({ path: `snes/t${i}.png`, size: 2 }))
    const steps: RomDownloadStep[] = []
    await downloadRomSet({
      files,
      destRoot: dest,
      fetchFile: async (req) => {
        await fs.appendFile(req.dest, Buffer.alloc(req.size, 1))
        req.onBytes(req.size)
      },
      onProgress: (s) => steps.push(s),
      // A fixed clock: only the forced emits can go out.
      now: () => 1000,
      freeBytes: async () => null
    })
    expect(steps.length).toBeLessThanOrEqual(3)
    expect(steps[0]).toMatchObject({ bytesDone: 0, fileIndex: 0 })
    expect(steps.at(-1)).toMatchObject({ bytesDone: 600, bytesTotal: 600, percent: 100 })
  })

  it('a failure stops the other files of the batch and is the one reported', async () => {
    const dest = join(dir, 'client')
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `snes/f${i}.bin`, size: 2 }))
    const aborted: string[] = []
    await expect(
      downloadRomSet({
        files,
        destRoot: dest,
        fetchFile: async (req) => {
          if (req.path === 'snes/f1.bin') {
            // Once its siblings are under way.
            await new Promise((r) => setTimeout(r, 30))
            throw new Error('host fell over')
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 200)
            req.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              aborted.push(req.path)
              reject(new Error('aborted'))
            })
          })
          await fs.appendFile(req.dest, Buffer.alloc(req.size, 1))
          req.onBytes(req.size)
        },
        freeBytes: async () => null
      })
    ).rejects.toThrow('host fell over')
    expect(aborted.length).toBeGreaterThan(0)
    // Nothing after the batch's workers was started.
    expect(aborted.length).toBeLessThanOrEqual(3)
  })
})

describe('openRomFile on a large set', () => {
  it('looks files up by path, whatever their case', async () => {
    await put('snes/Game.sfc', 'ab')
    const set = {
      files: [
        { path: 'snes/Game.sfc', size: 2 },
        ...Array.from({ length: 5000 }, (_, i) => ({ path: `snes/missing${i}.bin`, size: 1 }))
      ],
      totalBytes: 5002
    }
    const game = { externalId: 'snes/Game.sfc' }
    expect(await openRomFile(game, roms, 'SNES/game.SFC', set)).toEqual({
      path: join(roms, 'snes', 'Game.sfc'),
      size: 2
    })
    await expect(openRomFile(game, roms, 'snes/missing4999.bin', set)).rejects.toThrow(
      /no longer on this PC/
    )
    await expect(openRomFile(game, roms, 'snes/other.bin', set)).rejects.toThrow(/Not a file/)
    // A set whose list grew is indexed again.
    set.files.push({ path: 'snes/late.bin', size: 1 })
    await put('snes/late.bin', 'x')
    expect((await openRomFile(game, roms, 'snes/late.bin', set)).size).toBe(1)
  })
})

describe('a dumped PS4 game folder', () => {
  const ps4 = 'ps4/GRAVITY RUSH 2 - [EU]'
  async function dump(): Promise<void> {
    await put(`${ps4}/eboot.bin`, 'EEEE')
    await put(`${ps4}/sce_sys/param.sfo`, 'pp')
    await put(`${ps4}/sce_module/libc.prx`, 'mmmmmm')
    await put(`${ps4}/data/level/a.pak`, '0123456789')
  }

  it('is the whole folder, subfolders included, with the eboot.bin first', async () => {
    await dump()
    await put('ps4/Other Game/eboot.bin', 'x')
    const set = await romFileSet(
      {
        externalId: `${ps4}/eboot.bin`,
        romPath: join(roms, 'ps4', 'GRAVITY RUSH 2 - [EU]', 'eboot.bin'),
        platformId: 'ps4',
        extra: { gameFolder: join(roms, 'ps4', 'GRAVITY RUSH 2 - [EU]') }
      },
      roms
    )
    expect(set.files[0].path).toBe(`${ps4}/eboot.bin`)
    expect(set.files.map((f) => f.path).sort()).toEqual(
      [
        `${ps4}/data/level/a.pak`,
        `${ps4}/eboot.bin`,
        `${ps4}/sce_module/libc.prx`,
        `${ps4}/sce_sys/param.sfo`
      ].sort()
    )
    expect(set.totalBytes).toBe(22)
  })

  it('is found by the platform rule when the record has no gameFolder', async () => {
    await dump()
    const set = await romFileSet({ externalId: `${ps4}/eboot.bin`, platformId: 'ps4' }, roms)
    expect(set.totalBytes).toBe(22)
  })

  it('stays a lone file for other platforms and for an eboot.bin right in the system folder', async () => {
    await dump()
    await put('ps4/eboot.bin', 'abc')
    await put('ps4/stray.bin', 'zz')
    expect(
      (await romFileSet({ externalId: 'ps4/eboot.bin', platformId: 'ps4' }, roms)).files
    ).toEqual([{ path: 'ps4/eboot.bin', size: 3 }])
    expect(
      (await romFileSet({ externalId: `${ps4}/eboot.bin`, platformId: 'psvita' }, roms)).files
    ).toEqual([{ path: `${ps4}/eboot.bin`, size: 4 }])
    // A gameFolder that is not the eboot's folder is not trusted.
    expect(
      (
        await romFileSet(
          { externalId: `${ps4}/eboot.bin`, extra: { gameFolder: join(roms, 'ps4') } },
          roms
        )
      ).files
    ).toEqual([{ path: `${ps4}/eboot.bin`, size: 4 }])
  })

  it('has its own, higher file cap; other folders keep theirs', async () => {
    await dump()
    await put('ps3/Game.ps3/PS3_GAME/PARAM.SFO', 'p')
    await put('ps3/Game.ps3/PS3_GAME/USRDIR/EBOOT.BIN', 'e')
    await put('ps3/Game.ps3/PS3_GAME/ICON0.PNG', 'i')
    const limits = { directoryFiles: 2, gameFolderFiles: 4 }
    const game = { externalId: `${ps4}/eboot.bin`, platformId: 'ps4' }
    expect((await romFileSet(game, roms, limits)).files).toHaveLength(4)
    await expect(romFileSet({ externalId: 'ps3/Game.ps3' }, roms, limits)).rejects.toThrow(
      /too many files/
    )
    await put(`${ps4}/data/level/b.pak`, 'b')
    await expect(romFileSet(game, roms, limits)).rejects.toThrow(/too many files/)
  })

  it('downloads to the same relative paths, the eboot.bin last, completing an eboot-only copy', async () => {
    await dump()
    const set = await romFileSet({ externalId: `${ps4}/eboot.bin`, platformId: 'ps4' }, roms)
    const dest = join(dir, 'client')
    // What an older PlayOut downloaded: the eboot.bin alone.
    await fs.mkdir(join(dest, 'ps4', 'GRAVITY RUSH 2 - [EU]'), { recursive: true })
    await fs.writeFile(join(dest, 'ps4', 'GRAVITY RUSH 2 - [EU]', 'eboot.bin'), 'EEEE')
    const fetched: string[] = []
    const steps: RomDownloadStep[] = []
    await downloadRomSet({
      files: set.files,
      destRoot: dest,
      fetchFile: async (req) => {
        fetched.push(req.path)
        const data = await fs.readFile(join(roms, ...req.path.split('/')))
        await fs.appendFile(req.dest, data.subarray(req.from))
        req.onBytes(data.length - req.from)
      },
      onProgress: (s) => steps.push(s),
      freeBytes: async () => null
    })
    expect(fetched.sort()).toEqual(
      [`${ps4}/data/level/a.pak`, `${ps4}/sce_module/libc.prx`, `${ps4}/sce_sys/param.sfo`].sort()
    )
    expect(steps.at(-1)).toMatchObject({ bytesDone: 22, bytesTotal: 22, percent: 100 })
    expect(
      await fs.readFile(
        join(dest, 'ps4', 'GRAVITY RUSH 2 - [EU]', 'sce_module', 'libc.prx'),
        'utf8'
      )
    ).toBe('mmmmmm')
    expect(writeOrder(set.files).at(-1)?.path).toBe(`${ps4}/eboot.bin`)
  })

  describe('an eboot-only copy completed in steps', () => {
    const folder = (): string => join(dir, 'client', 'ps4', 'GRAVITY RUSH 2 - [EU]')
    const scan = async (): Promise<string[]> =>
      (
        await scanRomRoot({
          romsRoot: join(dir, 'client'),
          findSystemForFolder: catalog.findSystemForFolder,
          log: silent
        })
      ).games.map((g) => g.romPath ?? '')
    const copy = async (req: RomFetchRequest): Promise<void> => {
      const data = await fs.readFile(join(roms, ...req.path.split('/')))
      await fs.appendFile(req.dest, data.subarray(req.from))
      req.onBytes(data.length - req.from)
    }
    async function ebootOnly(): Promise<RomFile[]> {
      await dump()
      await fs.mkdir(folder(), { recursive: true })
      await fs.writeFile(join(folder(), 'eboot.bin'), 'EEEE')
      return (await romFileSet({ externalId: `${ps4}/eboot.bin`, platformId: 'ps4' }, roms)).files
    }

    for (const stop of ['pause', 'cancel', 'fail'] as const) {
      it(`moves the eboot.bin aside first, so a ${stop} after one file leaves no game to scan`, async () => {
        const files = await ebootOnly()
        const control = new AbortController()
        const steps: RomDownloadStep[] = []
        let n = 0
        const run = downloadRomSet({
          files,
          destRoot: join(dir, 'client'),
          signal: control.signal,
          removePartsOnCancel: stop === 'cancel',
          concurrency: 1,
          onProgress: (s) => steps.push(s),
          fetchFile: async (req) => {
            // Mid-download the folder is no game either.
            if (n === 0) expect(await scan()).toEqual([])
            if (n++ === 1) {
              if (stop === 'fail') throw new Error('connection lost')
              control.abort()
              throw new Error('aborted')
            }
            await copy(req)
          }
        })
        await expect(run).rejects.toThrow(stop === 'fail' ? /connection lost/ : /cancel/i)
        // The eboot.bin counted as done from the start: nothing of it was fetched.
        expect(steps[0]).toMatchObject({ bytesDone: 4, bytesTotal: 22 })
        await expect(fs.stat(join(folder(), 'eboot.bin'))).rejects.toThrow()
        expect(await scan()).toEqual([])
      })
    }

    it('puts the eboot.bin back last once the rest is in, without fetching it', async () => {
      const files = await ebootOnly()
      const control = new AbortController()
      let n = 0
      await expect(
        downloadRomSet({
          files,
          destRoot: join(dir, 'client'),
          signal: control.signal,
          concurrency: 1,
          fetchFile: async (req) => {
            if (n++ === 1) {
              control.abort()
              throw new Error('aborted')
            }
            await copy(req)
          }
        })
      ).rejects.toThrow(/cancel/i)
      // Resumed: the eboot.bin is back only after the last other file.
      const order: string[] = []
      const steps: RomDownloadStep[] = []
      await downloadRomSet({
        files,
        destRoot: join(dir, 'client'),
        onProgress: (s) => steps.push(s),
        fetchFile: async (req) => {
          order.push(req.path)
          expect(await scan()).toEqual([])
          await copy(req)
        },
        freeBytes: async () => null
      })
      expect(order).not.toContain(`${ps4}/eboot.bin`)
      expect(await fs.readFile(join(folder(), 'eboot.bin'), 'utf8')).toBe('EEEE')
      expect((await fs.readdir(folder())).filter((f) => f.endsWith('.part'))).toEqual([])
      expect(steps[0].bytesDone).toBeGreaterThanOrEqual(4)
      expect(steps.at(-1)).toMatchObject({ bytesDone: 22, bytesTotal: 22, percent: 100 })
      expect(await scan()).toEqual([join(folder(), 'eboot.bin')])
    })

    it('leaves a complete copy alone', async () => {
      await dump()
      const files = (await romFileSet({ externalId: `${ps4}/eboot.bin`, platformId: 'ps4' }, roms))
        .files
      await downloadRomSet({ files, destRoot: join(dir, 'client'), fetchFile: copy })
      const fetched: string[] = []
      await downloadRomSet({
        files,
        destRoot: join(dir, 'client'),
        fetchFile: async (req) => {
          fetched.push(req.path)
        }
      })
      expect(fetched).toEqual([])
      expect(await fs.readFile(join(folder(), 'eboot.bin'), 'utf8')).toBe('EEEE')
      expect(await scan()).toEqual([join(folder(), 'eboot.bin')])
    })
  })

  it('downloads a whole folder to an empty client, the eboot.bin last', async () => {
    await dump()
    const set = await romFileSet({ externalId: `${ps4}/eboot.bin`, platformId: 'ps4' }, roms)
    const order: string[] = []
    await downloadRomSet({
      files: set.files,
      destRoot: join(dir, 'client'),
      concurrency: 1,
      fetchFile: async (req) => {
        order.push(req.path)
        const data = await fs.readFile(join(roms, ...req.path.split('/')))
        await fs.appendFile(req.dest, data)
        req.onBytes(data.length)
      },
      freeBytes: async () => null
    })
    expect(order).toHaveLength(4)
    expect(order.at(-1)).toBe(`${ps4}/eboot.bin`)
    expect(
      await fs.readFile(
        join(dir, 'client', 'ps4', 'GRAVITY RUSH 2 - [EU]', 'data', 'level', 'a.pak'),
        'utf8'
      )
    ).toBe('0123456789')
  })

  it('checks the free space for the whole folder', async () => {
    await dump()
    const set = await romFileSet({ externalId: `${ps4}/eboot.bin`, platformId: 'ps4' }, roms)
    await expect(
      downloadRomSet({
        files: set.files,
        destRoot: join(dir, 'client'),
        fetchFile: async () => {},
        freeBytes: async () => 10
      })
    ).rejects.toThrow(/Not enough free space/)
  })
})
