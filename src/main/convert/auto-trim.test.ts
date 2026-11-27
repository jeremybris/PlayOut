import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConvertMissing, ConvertRequest, ConvertStatus } from '../../shared/convert'
import type { Game, PlayOutEvents } from '../../shared/types'
import {
  createAutoTrimService,
  fileInUse,
  isXiso,
  planTrim,
  type AutoTrimDeps,
  type AutoTrimService,
  type XboxInfo
} from './auto-trim'
import type { XboxImageInfo } from './xbox-helper'

// Temporary files only: no real ROM folder, and a fake convert service instead of the converter.

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-trim-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(path: string, data: string | Buffer = 'x'): Promise<string> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
  return path
}

function rom(platformId: string, romPath: string, over: Partial<Game> = {}): Game {
  return {
    id: `rom:${platformId}:${romPath}`,
    source: 'rom',
    externalId: romPath,
    platformId,
    title: `Game ${romPath.split(/[\\/]/).pop()}`,
    sortTitle: '',
    installed: true,
    romPath,
    launch: { kind: 'emulator', systemId: platformId, romPath },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    ...over
  } as Game
}

describe('planTrim', () => {
  it('converts PS2 and PSP ISOs, Wii and GameCube ISO/GCM images; other formats are left alone', async () => {
    const iso = await put(join(dir, 'ps2', 'Game.iso'))
    expect(await planTrim(rom('ps2', iso))).toEqual({
      platformId: 'ps2',
      pairId: 'ps2-iso-chd',
      paths: [iso]
    })
    expect(await planTrim(rom('psp', iso))).toMatchObject({ pairId: 'psp-iso-cso' })
    expect(await planTrim(rom('wii', iso))).toMatchObject({ pairId: 'wii-iso-rvz' })
    const gcm = await put(join(dir, 'gc', 'Game.gcm'))
    expect(await planTrim(rom('gc', gcm))).toMatchObject({ pairId: 'gc-iso-rvz', paths: [gcm] })
    for (const [platform, file] of [
      ['ps2', 'Game.chd'],
      ['psp', 'Game.cso'],
      ['wii', 'Game.rvz'],
      ['gc', 'Game.rvz'],
      ['snes', 'Game.iso']
    ] as const)
      expect(await planTrim(rom(platform, await put(join(dir, platform, file))))).toBeNull()
    expect(await planTrim({ ...rom('ps2', iso), source: 'manual' })).toBeNull()
  })

  it('trims a full Xbox dump, never an image that is an XISO already', async () => {
    const full = Buffer.alloc(0x10000 + 64)
    const fullPath = await put(join(dir, 'xbox', 'Full.iso'), full)
    expect(await planTrim(rom('xbox', fullPath))).toMatchObject({ pairId: 'xbox-iso-xiso' })

    const xiso = Buffer.alloc(0x10000 + 64)
    xiso.write('MICROSOFT*XBOX*MEDIA', 0x10000, 'latin1')
    const xisoPath = await put(join(dir, 'xbox', 'Trimmed.iso'), xiso)
    expect(await isXiso(xisoPath)).toBe(true)
    expect(await planTrim(rom('xbox', xisoPath))).toBeNull()

    const named = await put(join(dir, 'xbox', 'Halo.xiso.iso'), full)
    expect(await planTrim(rom('xbox', named))).toBeNull()
    // Too short to hold the descriptor: not an XISO.
    expect(await isXiso(await put(join(dir, 'xbox', 'Tiny.iso'), 'x'))).toBe(false)
  })

  it('PlayStation: a .cue, a .bin through its .cue, the discs of a playlist; a bare .bin is skipped', async () => {
    const psx = join(dir, 'psx')
    const cue = await put(join(psx, 'Game.cue'), 'FILE "Game.bin" BINARY')
    const bin = await put(join(psx, 'Game.bin'))
    expect(await planTrim(rom('psx', cue))).toEqual({
      platformId: 'psx',
      pairId: 'psx-cue-chd',
      paths: [cue]
    })
    expect(await planTrim(rom('psx', bin))).toMatchObject({ paths: [cue] })
    const bare = await put(join(psx, 'Lonely.bin'))
    expect(await planTrim(rom('psx', bare))).toEqual({
      skip: 'Lonely.bin has no .cue sheet next to it'
    })

    const d1 = await put(join(psx, 'FF (Disc 1).cue'), 'FILE "FF (Disc 1).bin" BINARY')
    const d2 = await put(join(psx, 'FF (Disc 2).cue'), 'FILE "FF (Disc 2).bin" BINARY')
    await put(join(psx, 'FF (Disc 3).chd'))
    const m3u = await put(
      join(psx, 'FF.m3u'),
      '#EXTM3U\nFF (Disc 1).cue\r\nFF (Disc 2).cue\nFF (Disc 3).chd\nMissing.cue\n'
    )
    expect(await planTrim(rom('psx', m3u))).toMatchObject({ paths: [d1, d2] })
    const done = await put(join(psx, 'Done.m3u'), 'FF (Disc 3).chd\n')
    expect(await planTrim(rom('psx', done))).toBeNull()
    expect(await planTrim(rom('psx', await put(join(psx, 'Game.chd'))))).toBeNull()
  })

  it('PS3: a disc folder (PS3_GAME) becomes an ISO; PSN and HDD games stay folders', async () => {
    const disc = join(dir, 'ps3', 'Game.ps3')
    await put(join(disc, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'))
    expect(await planTrim(rom('ps3', disc))).toEqual({
      platformId: 'ps3',
      pairId: 'ps3-folder-iso',
      paths: [disc]
    })
    const psn = join(dir, 'ps3', 'PsnGame.ps3')
    await put(join(psn, 'USRDIR', 'EBOOT.BIN'))
    expect(await planTrim(rom('ps3', psn))).toBeNull()
    const hdd = join(dir, 'Updates and DLC', 'PS3', 'dev_hdd0', 'game', 'BLUS30443')
    await put(join(hdd, 'PS3_GAME', 'PARAM.SFO'))
    expect(await planTrim(rom('ps3', hdd))).toBeNull()
    expect(await planTrim(rom('ps3', await put(join(dir, 'ps3', 'Game.iso'))))).toBeNull()
  })
})

/** A stand-in convert service: busy for `busyLooks` status calls, records each request. */
function fakeConvert(
  options: {
    busyLooks?: number
    missing?: ConvertMissing[]
    output?: (path: string) => string
  } = {}
): { convert: AutoTrimDeps['convert']; started: ConvertRequest[] } {
  let busy = options.busyLooks ?? 0
  let running = false
  let looksWhileRunning = 0
  let items: ConvertStatus['items'] = []
  const started: ConvertRequest[] = []
  const status = (): ConvertStatus => ({ tool: null, downloading: null, running, items })
  const convert: AutoTrimDeps['convert'] = {
    status: vi.fn(async () => {
      if (busy > 0) {
        busy--
        return { ...status(), running: true }
      }
      // A run lasts two looks, then it is done.
      if (running && ++looksWhileRunning >= 2) {
        running = false
        looksWhileRunning = 0
      }
      return status()
    }),
    check: vi.fn(async () => options.missing ?? []),
    start: vi.fn(async (request: ConvertRequest) => {
      if (busy > 0 || running) throw new Error('A conversion is already running.')
      started.push(request)
      running = true
      items = request.paths.map((path) => ({
        path,
        state: 'done',
        output: options.output ? options.output(path) : `${path}.chd`
      }))
      return status()
    })
  }
  return { convert, started }
}

function harness(
  games: Game[],
  convert: AutoTrimDeps['convert'],
  over: Partial<AutoTrimDeps> = {}
): {
  service: AutoTrimService
  events: { event: keyof PlayOutEvents; payload: unknown }[]
  setEnabled: (v: boolean) => void
} {
  const events: { event: keyof PlayOutEvents; payload: unknown }[] = []
  let enabled = true
  const service = createAutoTrimService({
    enabled: () => enabled,
    library: { games: () => games },
    convert,
    waitReason: () => null,
    events: { emit: (event, payload) => events.push({ event, payload }) },
    log,
    settleMs: 0,
    pollMs: 1,
    sleep: () => Promise.resolve(),
    ...over
  })
  return {
    service,
    events,
    setEnabled: (v: boolean) => {
      enabled = v
    }
  }
}

describe('auto-trim service', () => {
  it('does nothing while Trim Games is off', async () => {
    const iso = await put(join(dir, 'ps2', 'Game.iso'))
    const { convert, started } = fakeConvert()
    const h = harness([rom('ps2', iso)], convert)
    h.setEnabled(false)
    h.service.add([rom('ps2', iso).id])
    await h.service.idle()
    expect(started).toEqual([])
    expect(convert.status).not.toHaveBeenCalled()
  })

  it('groups new games by direction, one run at a time, waiting for a run already going', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const b = rom('ps2', await put(join(dir, 'ps2', 'B.iso')))
    const c = rom('psp', await put(join(dir, 'psp', 'C.iso')))
    const skipped = rom('ps2', await put(join(dir, 'ps2', 'D.chd')))
    const fake = fakeConvert({ busyLooks: 3 })
    const h = harness([a, b, c, skipped], fake.convert)
    h.service.add([a.id, c.id, b.id, skipped.id])
    await h.service.idle()
    expect(fake.started).toEqual([
      { platformId: 'ps2', pairId: 'ps2-iso-chd', reversed: false, paths: [a.romPath, b.romPath] },
      { platformId: 'psp', pairId: 'psp-iso-cso', reversed: false, paths: [c.romPath] }
    ])
    expect(h.events.filter((e) => e.event === 'trim:started').map((e) => e.payload)).toEqual([
      { count: 2, titles: [a.title, b.title], fromLibrary: false },
      { count: 1, titles: [c.title], fromLibrary: false }
    ])
  })

  it('retries when a manual Convert run starts between its look and its start', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const fake = fakeConvert()
    const start = fake.convert.start
    let refused = false
    fake.convert.start = vi.fn(async (request: ConvertRequest) => {
      if (!refused) {
        refused = true
        throw new Error('A conversion is already running.')
      }
      return start(request)
    })
    const h = harness([a], fake.convert)
    h.service.add([a.id])
    await h.service.idle()
    expect(fake.started).toHaveLength(1)
    expect(h.events.some((e) => e.event === 'trim:skipped')).toBe(false)
  })

  it('skips games whose direction is blocked (no Wii key), telling the renderer', async () => {
    const wii = rom('wii', await put(join(dir, 'wii', 'W.iso')))
    const fake = fakeConvert({
      missing: [
        {
          need: 'wiiKey',
          message: 'This Wii conversion needs your Wii common key.',
          place: 'bios\\wii\\common-key.bin',
          blocking: true
        }
      ]
    })
    const h = harness([wii], fake.convert)
    h.service.add([wii.id])
    await h.service.idle()
    expect(fake.started).toEqual([])
    expect(h.events).toEqual([
      {
        event: 'trim:skipped',
        payload: { title: wii.title, reason: 'This Wii conversion needs your Wii common key.' }
      }
    ])
  })

  it('waits while a game runs or a ROM downloads, and keeps games added meanwhile', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const b = rom('ps2', await put(join(dir, 'ps2', 'B.iso')))
    const fake = fakeConvert()
    let waits = 3
    let h: ReturnType<typeof harness> | null = null
    h = harness([a, b], fake.convert, {
      waitReason: () => {
        if (waits <= 0) return null
        waits--
        // A game added while the queue waits is not lost.
        if (waits === 1) h!.service.add([b.id])
        return 'a game is running'
      }
    })
    h.service.add([a.id])
    await h.service.idle()
    expect(fake.started).toEqual([expect.objectContaining({ paths: [a.romPath, b.romPath] })])
  })

  it('never takes its own results, games downloaded from another PC, or games gone meanwhile', async () => {
    const a = rom('xbox', await put(join(dir, 'xbox', 'A.iso'), Buffer.alloc(16)))
    const outPath = join(dir, 'xbox', 'A (trimmed).iso')
    const fake = fakeConvert({ output: () => outPath })
    const games = [a]
    const h = harness(games, fake.convert)
    h.service.add([a.id])
    await h.service.idle()
    expect(fake.started).toHaveLength(1)
    // The rescan found the result as a new game (the record did not move): never a source, whatever it looks like.
    const out = rom('xbox', await put(outPath, Buffer.alloc(16)))
    const fromHost = rom('ps2', await put(join(dir, 'ps2', 'Host.iso')))
    games.push(out, fromHost)
    h.service.markHostDownload(fromHost.id)
    h.service.add([out.id, fromHost.id, 'rom:ps2:gone'])
    await h.service.idle()
    expect(fake.started).toHaveLength(1)
  })

  it('waits for files that are still changing', async () => {
    const path = await put(join(dir, 'ps2', 'Copying.iso'), 'a')
    const a = rom('ps2', path)
    const fake = fakeConvert()
    let clock = 0
    let looks = 0
    const h = harness([a], fake.convert, {
      settleMs: 100,
      now: () => clock,
      sleep: async () => {
        looks++
        clock += 60
        // The copy goes on for the first two looks.
        if (looks <= 2) await fs.appendFile(path, 'more')
      }
    })
    h.service.add([a.id])
    await h.service.idle()
    expect(fake.started).toHaveLength(1)
    // Not before the file had stayed the same for settleMs.
    expect(looks).toBeGreaterThanOrEqual(4)
  })

  it('drops its queue when Trim Games is turned off', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const fake = fakeConvert()
    let h: ReturnType<typeof harness> | null = null
    h = harness([a], fake.convert, {
      waitReason: () => {
        h!.setEnabled(false)
        return 'a game is running'
      }
    })
    h.service.add([a.id])
    await h.service.idle()
    expect(fake.started).toEqual([])
  })
})

describe('auto-trim: switching it on, other runs, open files and last looks', () => {
  it('checks the ROM games already in the library once, only when asked (the switch-on)', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const small = rom('ps2', await put(join(dir, 'ps2', 'B.chd')))
    const snes = rom('snes', await put(join(dir, 'snes', 'C.sfc')))
    const notInstalled = rom('psp', join(dir, 'psp', 'Gone.iso'), { installed: false })
    const steam = { ...rom('ps2', a.romPath!), id: 'steam:1', source: 'steam' } as Game
    const fake = fakeConvert()
    const h = harness([a, small, snes, notInstalled, steam], fake.convert)
    // Created (app start): nothing is looked at.
    await h.service.idle()
    expect(fake.convert.status).not.toHaveBeenCalled()
    h.service.checkLibrary()
    await h.service.idle()
    expect(fake.started).toEqual([expect.objectContaining({ paths: [a.romPath] })])
    // Off: the switch does nothing.
    h.setEnabled(false)
    h.service.checkLibrary()
    await h.service.idle()
    expect(fake.started).toHaveLength(1)
  })

  it('never trims back what a Convert run of the user made', async () => {
    const iso = await put(join(dir, 'wii', 'Back.iso'))
    const back = rom('wii', iso)
    const fake = fakeConvert()
    const h = harness([back], fake.convert)
    h.service.noteConvertStatus({
      tool: null,
      downloading: null,
      running: false,
      items: [{ path: join(dir, 'wii', 'Back.rvz'), state: 'done', output: iso.toUpperCase() }]
    })
    h.service.add([back.id])
    await h.service.idle()
    expect(fake.started).toEqual([])
  })

  it('waits while any file of a PS3 disc folder is open elsewhere', async () => {
    const disc = join(dir, 'ps3', 'Game.ps3')
    const eboot = await put(join(disc, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'))
    const game = rom('ps3', disc)
    const fake = fakeConvert()
    let open = 3
    const looked: string[] = []
    const h = harness([game], fake.convert, {
      inUse: async (file) => {
        looked.push(file)
        return file === eboot && open-- > 0
      }
    })
    h.service.add([game.id])
    await h.service.idle()
    expect(looked).toContain(eboot)
    expect(open).toBeLessThan(0)
    expect(fake.started).toEqual([expect.objectContaining({ pairId: 'ps3-folder-iso' })])
  })

  it.runIf(process.platform === 'win32')(
    'sees a file another handle holds open (exclusive open on Windows)',
    async () => {
      const path = await put(join(dir, 'ps2', 'Open.iso'))
      const handle = await fs.open(path, 'r')
      try {
        expect(await fileInUse(path)).toBe(true)
      } finally {
        await handle.close()
      }
      expect(await fileInUse(path)).toBe(false)
      expect(await fileInUse(join(dir, 'nothing.iso'))).toBe(false)
    }
  )

  it('looks at every gate again right before starting: a game started, a file changed', async () => {
    const path = await put(join(dir, 'ps2', 'A.iso'), 'a')
    const a = rom('ps2', path)
    const fake = fakeConvert()
    let checks = 0
    let gameRunning = false
    const check = fake.convert.check
    fake.convert.check = vi.fn(async (request: ConvertRequest) => {
      checks++
      // First batch: a game starts between the look and the start. Second: the file changes.
      if (checks === 1) gameRunning = true
      if (checks === 2) await fs.appendFile(path, 'more')
      return check(request)
    })
    let waits = 0
    const h = harness([a], fake.convert, {
      waitReason: () => {
        if (!gameRunning) return null
        if (++waits >= 2) gameRunning = false
        return 'a game is running'
      }
    })
    h.service.add([a.id])
    await h.service.idle()
    expect(checks).toBe(3)
    expect(fake.started).toHaveLength(1)
  })

  it('starts nothing when Trim Games is turned off between the look and the start', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const fake = fakeConvert()
    let h: ReturnType<typeof harness> | null = null
    const check = fake.convert.check
    fake.convert.check = vi.fn(async (request: ConvertRequest) => {
      h!.setEnabled(false)
      return check(request)
    })
    h = harness([a], fake.convert)
    h.service.add([a.id])
    await h.service.idle()
    expect(fake.started).toEqual([])
  })

  it('drops games whose file is gone right before the start; the others still go', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const b = rom('ps2', await put(join(dir, 'ps2', 'B.iso')))
    const fake = fakeConvert()
    const check = fake.convert.check
    fake.convert.check = vi.fn(async (request: ConvertRequest) => {
      await fs.rm(a.romPath!, { force: true })
      return check(request)
    })
    const h = harness([a, b], fake.convert)
    h.service.add([a.id, b.id])
    await h.service.idle()
    expect(fake.started).toEqual([expect.objectContaining({ paths: [b.romPath] })])
  })

  it('a bad path refused by start() costs only its own game: the others go one by one', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const b = rom('ps2', await put(join(dir, 'ps2', 'B.iso')))
    const fake = fakeConvert()
    const start = fake.convert.start
    fake.convert.start = vi.fn(async (request: ConvertRequest) => {
      if (request.paths.includes(a.romPath!)) throw new Error('A.iso is not a PS2 ISO file.')
      return start(request)
    })
    const h = harness([a, b], fake.convert)
    h.service.add([a.id, b.id])
    await h.service.idle()
    expect(fake.started).toEqual([expect.objectContaining({ paths: [b.romPath] })])
    expect(h.events.filter((e) => e.event === 'trim:skipped').map((e) => e.payload)).toEqual([
      { title: a.title, reason: 'A.iso is not a PS2 ISO file.' }
    ])
  })

  it('a start() failure not about a game puts the games back; one that keeps failing skips them', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const fake = fakeConvert()
    const start = fake.convert.start
    let fails = 1
    fake.convert.start = vi.fn(async (request: ConvertRequest) => {
      if (fails-- > 0) throw new Error('The work folder could not be made.')
      return start(request)
    })
    const h = harness([a], fake.convert)
    h.service.add([a.id])
    await h.service.idle()
    expect(fake.started).toHaveLength(1)
    expect(h.events.some((e) => e.event === 'trim:skipped')).toBe(false)

    const b = rom('ps2', await put(join(dir, 'ps2', 'B.iso')))
    const always = fakeConvert()
    always.convert.start = vi.fn(async () => {
      throw new Error('The work folder could not be made.')
    })
    const h2 = harness([b], always.convert)
    h2.service.add([b.id])
    await h2.service.idle()
    expect(always.convert.start).toHaveBeenCalledTimes(3)
    expect(h2.events.filter((e) => e.event === 'trim:skipped')).toHaveLength(1)
  })
})

describe('Trim Games: Xbox and Xbox 360 through the Xbox helper', () => {
  const info =
    (by: Record<string, XboxImageInfo | null>): XboxInfo =>
    async (path) =>
      by[path.split(/[\\/]/).pop()!] ?? null

  it('trims a full Xbox 360 dump to XISO; an optimized image, another platform or a non-ISO stays', async () => {
    const x = join(dir, 'xbox360')
    const full = await put(join(x, 'Full.iso'))
    const done = await put(join(x, 'Done.iso'))
    const og = await put(join(x, 'Og.iso'))
    const zar = await put(join(x, 'Game.zar'))
    const lookup = info({
      'Full.iso': { format: 'redump', optimized: false, platform: 'xbox360', xgd: 3 },
      'Done.iso': { format: 'xiso', optimized: true, platform: 'xbox360', xgd: null },
      'Og.iso': { format: 'redump', optimized: false, platform: 'xbox', xgd: 1 }
    })
    expect(await planTrim(rom('xbox360', full), lookup)).toEqual({
      platformId: 'xbox360',
      pairId: 'x360-iso-xiso',
      paths: [full]
    })
    expect(await planTrim(rom('xbox360', done), lookup)).toBeNull()
    expect(await planTrim(rom('xbox360', og), lookup)).toEqual({
      skip: 'Og.iso is an Xbox game'
    })
    expect(await planTrim(rom('xbox360', zar), lookup)).toBeNull()
  })

  it('Xbox: a bare but unoptimized XISO is trimmed when the helper says so; without it the header decides', async () => {
    const bare = Buffer.alloc(0x10000 + 64)
    bare.write('MICROSOFT*XBOX*MEDIA', 0x10000, 'latin1')
    const path = await put(join(dir, 'xbox', 'Bare.iso'), bare)
    const lookup = info({
      'Bare.iso': { format: 'xiso', optimized: false, platform: 'xbox', xgd: null }
    })
    expect(await planTrim(rom('xbox', path), lookup)).toMatchObject({ pairId: 'xbox-iso-xiso' })
    // The helper cannot read it (missing, or not an image it knows): the magic sniff stands in.
    expect(await planTrim(rom('xbox', path), info({}))).toBeNull()
    expect(await planTrim(rom('xbox', path))).toBeNull()
  })

  it('the service sends Xbox 360 dumps the helper did not see as optimized through x360-iso-xiso', async () => {
    const a = rom('xbox360', await put(join(dir, 'xbox360', 'A.iso')))
    const b = rom('xbox360', await put(join(dir, 'xbox360', 'B.iso')))
    const fake = fakeConvert({ output: (p) => p.replace(/\.iso$/, '.xiso.iso') })
    const h = harness([a, b], fake.convert, {
      xboxInfo: info({
        'A.iso': { format: 'redump', optimized: false, platform: 'xbox360', xgd: 2 },
        'B.iso': { format: 'xiso', optimized: true, platform: 'xbox360', xgd: null }
      })
    })
    h.service.add([a.id, b.id])
    await h.service.idle()
    expect(fake.started).toEqual([
      { platformId: 'xbox360', pairId: 'x360-iso-xiso', reversed: false, paths: [a.romPath] }
    ])
  })
})

describe('Trim Games: review fixes', () => {
  it('a file opened between the look and the start sends the game back until it is closed', async () => {
    const a = rom('ps2', await put(join(dir, 'ps2', 'A.iso')))
    const fake = fakeConvert()
    let looks = 0
    const h = harness([a], fake.convert, {
      // Closed at the look (nextBatch), open at the gate right before start(), closed after that.
      inUse: async () => ++looks === 2
    })
    h.service.add([a.id])
    await h.service.idle()
    expect(looks).toBeGreaterThanOrEqual(4)
    expect(fake.started).toHaveLength(1)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('is open in another program'))
  })

  it('runs at most three games per start, so the gates are looked at between runs', async () => {
    const games = await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map(async (n) =>
        rom('ps2', await put(join(dir, 'ps2', `${n}.iso`)))
      )
    )
    const fake = fakeConvert()
    let gateLooks = 0
    const h = harness(games, fake.convert, {
      waitReason: () => {
        gateLooks++
        return null
      }
    })
    h.service.checkLibrary()
    await h.service.idle()
    expect(fake.started.map((r) => r.paths.length)).toEqual([3, 2])
    expect(gateLooks).toBeGreaterThanOrEqual(4)
    expect(h.events.filter((e) => e.event === 'trim:started').map((e) => e.payload)).toEqual([
      { count: 3, titles: games.slice(0, 3).map((g) => g.title), fromLibrary: true },
      { count: 2, titles: games.slice(3).map((g) => g.title), fromLibrary: true }
    ])
  })

  it('remembers Convert results and host downloads across a restart (the switch-on leaves them)', async () => {
    const stateFile = join(dir, 'userData', 'trim-games.json')
    const mine = rom('wii', await put(join(dir, 'wii', 'Mine.iso')))
    const hosted = rom('ps2', await put(join(dir, 'ps2', 'Hosted.iso')))
    const other = rom('ps2', await put(join(dir, 'ps2', 'Other.iso')))
    const first = harness([mine, hosted, other], fakeConvert().convert, { stateFile })
    first.setEnabled(false)
    first.service.noteConvertStatus({
      tool: null,
      downloading: null,
      running: false,
      items: [{ path: join(dir, 'wii', 'Mine.rvz'), state: 'done', output: mine.romPath! }]
    })
    first.service.markHostDownload(hosted.id)
    await first.service.idle()
    first.service.dispose()
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    expect(saved.outputs).toEqual([mine.romPath!.toLowerCase()])
    expect(saved.hostGames).toEqual([hosted.id])
    expect(saved.hostPaths).toEqual([hosted.romPath!.toLowerCase()])

    // Restart: the host game came back with another id (rescanned); only Other is trimmed.
    const rescanned = { ...hosted, id: 'rom:ps2:rescanned' }
    const fake = fakeConvert()
    const second = harness([mine, rescanned, other], fake.convert, { stateFile })
    second.service.checkLibrary()
    await second.service.idle()
    expect(fake.started).toEqual([expect.objectContaining({ paths: [other.romPath] })])
  })

  it('a blocked direction (no Wii key) skips a whole batch with one toast', async () => {
    const games = await Promise.all(
      ['A', 'B', 'C'].map(async (n) => rom('wii', await put(join(dir, 'wii', `${n}.iso`))))
    )
    const fake = fakeConvert({
      missing: [
        {
          need: 'wiiKey',
          message: 'This Wii conversion needs your Wii common key.',
          place: 'bios\\wii\\common-key.bin',
          blocking: true
        }
      ]
    })
    const h = harness(games, fake.convert)
    h.service.add(games.map((g) => g.id))
    await h.service.idle()
    expect(fake.started).toEqual([])
    expect(h.events).toEqual([
      {
        event: 'trim:skipped',
        payload: {
          title: games.map((g) => g.title).join(', '),
          reason: 'This Wii conversion needs your Wii common key.',
          count: 3
        }
      }
    ])
  })
})
