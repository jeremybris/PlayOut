import { constants, existsSync, promises as fs, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConvertRequest, ConvertStatus } from '../../shared/convert'
import type { Game } from '../../shared/types'
import { isHiddenName } from '../emulation/rom-scanner'
import {
  createAutoTrimService,
  helperXboxInfo,
  planTrim,
  type AutoTrimDeps,
  type XboxInfo
} from './auto-trim'
import { createConvertService, type ConvertServiceDeps } from './convert-service'
import {
  parseHelperLine,
  spawnHelper,
  sweepPartials,
  xboxImageInfo,
  type HelperRun
} from './xbox-helper'

// Temporary files only: fake helper processes for the PlayOut side, and the real helper (resources\xbox) only on
// synthetic images it packs itself from made-up game folders.

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-xbox-fixes-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(path: string, data: string | Buffer = 'x'): Promise<string> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
  return path
}

function rom(platformId: string, romPath: string): Game {
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
function convertSetup(over: Partial<ConvertServiceDeps> = {}, games: Game[] = []) {
  const statuses: ConvertStatus[] = []
  const trash = vi.fn(async (path: string) => {
    await fs.rm(path, { recursive: true, force: true })
  })
  const exe = join(dir, 'helper', 'PlayOutXbox.exe')
  const service = createConvertService({
    toolRoot: join(dir, 'tool'),
    workDir: join(dir, 'work'),
    emulationDir: () => join(dir, 'Emulation'),
    emulatorPath: async () => null,
    library: { games: () => games, rekeyRom: vi.fn(() => 'moved') },
    romExtensions: () => ['.iso', '.zar', '.xex'],
    imageCache: { moveGame: async () => (url: string) => url },
    trash,
    rescanRoms: vi.fn(async () => {}),
    emit: (s) => statuses.push(s),
    log: log as never,
    run: vi.fn(async () => 0),
    ensure: vi.fn(async () => ({ version: '2.1.0', exe: 'gfc.exe' })),
    xboxHelper: exe,
    ...over
  })
  const finished = async (): Promise<ConvertStatus> => {
    await vi.waitFor(() => expect(statuses.at(-1)?.running).toBe(false), { timeout: 60_000 })
    return statuses.at(-1)!
  }
  return { service, statuses, trash, exe, finished }
}

/**
 * A helper process played by a function. `untilStopped()` is how it keeps running until PlayOut stops it, and
 * `waiting` resolves when it gets there: a test stops the run only then, once everything the helper wrote and
 * printed before it is done. (Watching for the helper's file instead stops too early under load: a file exists from
 * the moment it is opened, before its bytes are written and before the helper's next line, and a helper that began
 * listening for the stop only after it had come would never end.)
 */
function fakeHelper(
  behave: (
    args: string[],
    print: (v: object) => void,
    signal: AbortSignal,
    untilStopped: () => Promise<void>
  ) => Promise<number>
): { runHelper: HelperRun; calls: string[][]; waiting: Promise<void> } {
  const calls: string[][] = []
  let nowWaiting = (): void => {}
  const waiting = new Promise<void>((r) => (nowWaiting = r))
  const runHelper: HelperRun = async (_exe, args, onLine, signal) => {
    calls.push(args)
    const untilStopped = (): Promise<void> => {
      nowWaiting()
      return new Promise<void>((r) => {
        // A stop that already came is a stop: an 'abort' listener added now would never be called.
        if (signal.aborted) r()
        else signal.addEventListener('abort', () => r(), { once: true })
      })
    }
    return behave(args, (v) => onLine(JSON.stringify(v)), signal, untilStopped)
  }
  return { runHelper, calls, waiting }
}

/** The fake helper got as far as waiting for the stop: within 5 s, or the test says what never happened. */
async function reached(waiting: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      waiting,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('the helper never got to waiting for the stop')),
          5_000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('1. quitting mid-conversion; unfinished outputs are never games', () => {
  it('stop() resolves only once the helper has ended and its partial output is gone', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const partial = join(dir, 'roms', 'Game.playout-partial.xiso.iso')
    const helper = fakeHelper(async (_args, print, _signal, untilStopped) => {
      await put(partial, 'half')
      print({ type: 'progress', phase: 'trim', percent: 5 })
      await untilStopped()
      // The killed process takes a moment to close.
      await new Promise((r) => setTimeout(r, 150))
      return 3
    })
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-xiso',
      reversed: false,
      paths: [iso]
    })
    await reached(helper.waiting)
    expect(existsSync(partial)).toBe(true)
    await t.service.stop()
    expect(existsSync(partial)).toBe(false)
    expect(t.statuses.at(-1)).toMatchObject({ running: false, items: [{ state: 'stopped' }] })
    expect(existsSync(iso)).toBe(true)
    // Nothing running: at once.
    await t.service.stop()
  })

  it('the ROM scan and Trim Games ignore .playout-partial names', async () => {
    expect(isHiddenName('Game.playout-partial.iso')).toBe(true)
    expect(isHiddenName('Game.PLAYOUT-PARTIAL')).toBe(true)
    expect(isHiddenName('Game.playout-partial-source.iso')).toBe(true)
    expect(isHiddenName('Game (partial).iso')).toBe(false)
    const path = await put(join(dir, 'xbox360', 'Game.playout-partial.iso'))
    const xboxInfo = vi.fn<XboxInfo>(async () => null)
    expect(await planTrim(rom('xbox360', path), xboxInfo)).toBeNull()
    expect(xboxInfo).not.toHaveBeenCalled()
  })

  it('the start-up sweep removes only names with the marker, a few levels deep', async () => {
    const x = join(dir, 'roms', 'xbox360')
    await put(join(x, 'A.playout-partial.iso'))
    await put(join(x, 'B.playout-partial', 'default.xex'))
    await put(join(x, 'Sub', 'C.playout-partial-source.iso'))
    await put(join(x, 'Keep.iso'))
    await put(join(x, 'Keep partial.iso'))
    await put(join(x, 'playout-partial notes.txt'))
    await put(join(x, 'Sub', 'Keep.xiso.iso'))
    const removed = await sweepPartials([x, join(dir, 'missing')])
    expect(removed.map((p) => p.slice(x.length + 1)).sort()).toEqual([
      'A.playout-partial.iso',
      'B.playout-partial',
      join('Sub', 'C.playout-partial-source.iso')
    ])
    expect((await fs.readdir(x)).sort()).toEqual([
      'Keep partial.iso',
      'Keep.iso',
      'Sub',
      'playout-partial notes.txt'
    ])
    expect(await fs.readdir(join(x, 'Sub'))).toEqual(['Keep.xiso.iso'])
  })
})

describe('2. an extract that renamed files for Windows keeps the original', () => {
  it('done with renamed > 0: result kept, original not recycled, and why', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const out = join(dir, 'roms', 'Game')
    const helper = fakeHelper(async (_args, print) => {
      await put(join(out, '_ux.txt'))
      print({ type: 'done', output: out, files: 1, bytes: 1, renamed: 2 })
      return 0
    })
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-folder',
      reversed: false,
      paths: [iso]
    })
    const item = (await t.finished()).items[0]!
    expect(item).toMatchObject({
      state: 'done',
      output: out,
      detail: '→ Game (verified) (original kept: 2 names were changed for Windows)'
    })
    expect(t.trash).not.toHaveBeenCalled()
  })
})

describe('4. progress never goes backwards', () => {
  it('maps the helper’s overall percent and clamps within an item', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const out = join(dir, 'roms', 'Game.chd')
    let clock = 0
    const helper = fakeHelper(async (_args, print) => {
      // Every line a second apart: none is held back by the half-second emit throttle.
      const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000))
      const step = (phase: string, percent: number, stage: number, overall: number): void =>
        print({ type: 'progress', phase, percent, stage, stages: 4, overall })
      step('trim', 0, 1, 0)
      step('trim', 100, 1, 25)
      step('verify', 0, 2, 25)
      step('verify', 100, 2, 50)
      step('chd', 0, 3, 50)
      // A stray lower value (an older helper, a reordered line) does not pull the bar back.
      step('chd', 20, 3, 40)
      step('verify', 50, 4, 87)
      now.mockRestore()
      await put(out)
      print({ type: 'done', output: out })
      return 0
    })
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    await t.service.start({
      platformId: 'xbox',
      pairId: 'xbox-iso-chd',
      reversed: false,
      paths: [iso]
    })
    expect((await t.finished()).items[0]).toMatchObject({ state: 'done', output: out })
    const seen = t.statuses.flatMap((s) =>
      s.items[0]?.progress === undefined ? [] : [s.items[0].progress]
    )
    expect(seen).toEqual([0, 0.25, 0.25, 0.5, 0.5, 0.5, 0.87])
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
    expect(
      parseHelperLine(
        '{"type":"progress","phase":"chd","percent":5,"stage":3,"stages":4,"overall":51}'
      )
    ).toMatchObject({ stage: 3, stages: 4, overall: 51 })
  })
})

/** A Trim Games service over one fake Convert that finishes each run at once. */
function trimHarness(
  games: Game[],
  over: Partial<AutoTrimDeps> = {}
): { started: ConvertRequest[]; service: ReturnType<typeof createAutoTrimService> } {
  const started: ConvertRequest[] = []
  const service = createAutoTrimService({
    enabled: () => true,
    library: { games: () => games },
    convert: {
      status: async () => ({ tool: null, downloading: null, running: false, items: [] }),
      check: async () => [],
      start: async (request) => {
        started.push(request)
        return { tool: null, downloading: null, running: false, items: [] }
      }
    },
    waitReason: () => null,
    events: { emit: () => {} },
    log: log as never,
    settleMs: 0,
    pollMs: 1,
    sleep: () => Promise.resolve(),
    ...over
  })
  return { started, service }
}

describe('5. Trim Games asks the helper once a file has settled, and remembers the answer', () => {
  it('no info while the file is still being copied; one look once it has settled', async () => {
    const path = await put(join(dir, 'xbox360', 'Copying.iso'), 'a')
    const game = rom('xbox360', path)
    let clock = 0
    let looks = 0
    const xboxInfo = vi.fn<XboxInfo>(async () => ({
      format: 'redump',
      optimized: false,
      platform: 'xbox360',
      xgd: 2
    }))
    const h = trimHarness([game], {
      xboxInfo,
      settleMs: 100,
      now: () => clock,
      sleep: async () => {
        looks++
        clock += 60
        if (looks <= 3) await fs.appendFile(path, 'more')
      }
    })
    h.service.add([game.id])
    await h.service.idle()
    expect(looks).toBeGreaterThanOrEqual(5)
    expect(xboxInfo).toHaveBeenCalledTimes(1)
    expect(h.started).toEqual([
      { platformId: 'xbox360', pairId: 'x360-iso-xiso', reversed: false, paths: [path] }
    ])
  })

  it('the same file (size and time) is not looked at twice; a changed one is', async () => {
    const path = await put(join(dir, 'xbox', 'Done.iso'), 'a')
    const game = rom('xbox', path)
    const xboxInfo = vi.fn<XboxInfo>(async () => ({
      format: 'xiso',
      optimized: true,
      platform: 'xbox',
      xgd: null
    }))
    const h = trimHarness([game], { xboxInfo })
    h.service.add([game.id])
    await h.service.idle()
    h.service.add([game.id])
    await h.service.idle()
    expect(xboxInfo).toHaveBeenCalledTimes(1)
    await fs.appendFile(path, 'b')
    h.service.add([game.id])
    await h.service.idle()
    expect(xboxInfo).toHaveBeenCalledTimes(2)
    expect(h.started).toEqual([])
  })
})

describe('6. an image the helper refused is skipped, never sent to Convert', () => {
  it('exit 1 with an error line is a refusal; a helper that cannot start is no answer', async () => {
    const refusing: HelperRun = async (_exe, _args, onLine) => {
      onLine('{"type":"error","message":"not an Xbox or Xbox 360 disc image","refused":true}')
      return 1
    }
    expect(await xboxImageInfo('x.exe', 'Game.iso', refusing)).toEqual({
      rejected: 'not an Xbox or Xbox 360 disc image'
    })
    const missing: HelperRun = async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    expect(await xboxImageInfo('x.exe', 'Game.iso', missing)).toBeNull()
    // Killed or crashed (no error line): no answer either.
    expect(await xboxImageInfo('x.exe', 'Game.iso', async () => 3)).toBeNull()
    expect(await xboxImageInfo('x.exe', 'Game.iso', async () => 1)).toBeNull()

    const path = await put(join(dir, 'xbox360', 'Broken.iso'), Buffer.alloc(0x10000 + 64))
    const game = rom('xbox360', path)
    const xboxInfo: XboxInfo = (p) => xboxImageInfo('x.exe', p, refusing)
    expect(await planTrim(game, xboxInfo)).toEqual({
      skip: 'Broken.iso: not an Xbox or Xbox 360 disc image'
    })
    // Without an answer the header decides (no XDVDFS magic here: trimmed).
    expect(await planTrim(game, async () => null)).toMatchObject({ pairId: 'x360-iso-xiso' })
    const h = trimHarness([game], { xboxInfo })
    h.service.add([game.id])
    await h.service.idle()
    expect(h.started).toEqual([])
    expect(log.info).toHaveBeenCalledWith(
      'Trim Games: Broken.iso skipped: Broken.iso: not an Xbox or Xbox 360 disc image'
    )
  })
})

// The real helper (resources\xbox) on synthetic images only.
const REAL_HELPER = resolve(__dirname, '..', '..', '..', 'resources', 'xbox', 'PlayOutXbox.exe')

/** Run the real helper: exit code and its JSON lines. */
async function helper(
  args: string[],
  onLine?: (line: ReturnType<typeof parseHelperLine>) => void
): Promise<{ code: number; lines: NonNullable<ReturnType<typeof parseHelperLine>>[] }> {
  const lines: NonNullable<ReturnType<typeof parseHelperLine>>[] = []
  const code = await spawnHelper(
    REAL_HELPER,
    args,
    (line) => {
      const parsed = parseHelperLine(line)
      if (!parsed) return
      lines.push(parsed)
      onLine?.(parsed)
    },
    new AbortController().signal
  )
  return { code, lines }
}

describe.runIf(process.platform === 'win32' && existsSync(REAL_HELPER))(
  'the real Xbox helper: review fixes on synthetic images',
  () => {
    async function synthetic(name: string, files: Record<string, Buffer>): Promise<string> {
      const tree = join(dir, 'src', name)
      for (const [path, data] of Object.entries(files)) await put(join(tree, path), data)
      const iso = join(dir, `${name}.iso`)
      const packed = await helper(['pack', tree, iso])
      expect(packed.code, JSON.stringify(packed.lines.at(-1))).toBe(0)
      return iso
    }
    const xex = (): Buffer => {
      const b = Buffer.alloc(4096)
      b.write('XEX2', 0, 'latin1')
      return b
    }

    it('3. an output that appears during the run is never replaced; the partial goes', async () => {
      const iso = await synthetic('Big', {
        'default.xex': xex(),
        'media/big.bin': Buffer.alloc(48 * 1024 * 1024, 3)
      })
      const out = join(dir, 'out', 'Big.zar')
      await fs.mkdir(join(dir, 'out'))
      let placed = false
      const run = await helper(['zar', iso, out], (line) => {
        if (!placed && line?.type === 'progress') {
          placed = true
          writeFileSync(out, 'mine')
        }
      })
      expect(placed).toBe(true)
      expect(run.code).toBe(1)
      expect(run.lines.at(-1)).toEqual({
        type: 'error',
        message: `${out} appeared during the conversion`,
        refused: true
      })
      expect(await fs.readFile(out, 'utf8')).toBe('mine')
      expect(await fs.readdir(join(dir, 'out'))).toEqual(['Big.zar'])
      // Every progress line carries the overall percent, never going back.
      const overall = run.lines.flatMap((l) => (l.type === 'progress' ? [l.overall!] : []))
      expect(overall.length).toBeGreaterThan(1)
      for (let i = 1; i < overall.length; i++)
        expect(overall[i]).toBeGreaterThanOrEqual(overall[i - 1]!)
    }, 120_000)

    it('2. names Windows cannot hold: every file is still hashed at its renamed path; Convert keeps the image', async () => {
      const data = Buffer.alloc(70_000, 9)
      const iso = await synthetic('Odd', {
        'default.xex': xex(),
        'aux-txt': data,
        trail_: Buffer.from('trailing'),
        'media/plain.bin': Buffer.alloc(5000, 1)
      })
      // Rename two entries inside the image to names Windows cannot hold (same length: the tree stays valid).
      const bytes = await fs.readFile(iso)
      for (const [from, to] of [
        ['aux-txt', 'aux.txt'],
        ['trail_', 'trail.']
      ]) {
        const at = bytes.indexOf(Buffer.from(from, 'latin1'))
        expect(at).toBeGreaterThan(0)
        bytes.write(to, at, 'latin1')
      }
      const roms = join(dir, 'roms')
      const odd = join(roms, 'Odd.iso')
      await put(odd, bytes)

      const extracted = await helper(['extract', odd, join(dir, 'check')])
      expect(extracted.code, JSON.stringify(extracted.lines.at(-1))).toBe(0)
      expect(extracted.lines.at(-1)).toMatchObject({ type: 'done', files: 4, renamed: 2 })
      expect((await fs.readdir(join(dir, 'check'))).sort()).toEqual([
        '_ux.txt',
        'default.xex',
        'media',
        'trail_'
      ])
      expect(await fs.readFile(join(dir, 'check', '_ux.txt'))).toEqual(data)

      const t = convertSetup({ xboxHelper: REAL_HELPER })
      await t.service.start({
        platformId: 'xbox360',
        pairId: 'x360-iso-folder',
        reversed: false,
        paths: [odd]
      })
      const item = (await t.finished()).items[0]!
      expect(item).toMatchObject({
        state: 'done',
        output: join(roms, 'Odd'),
        detail: '→ Odd (verified) (original kept: 2 names were changed for Windows)'
      })
      expect(t.trash).not.toHaveBeenCalled()
      expect(existsSync(odd)).toBe(true)
    }, 120_000)

    it('6. info: a file that is not an Xbox image is refused; a missing helper is no answer', async () => {
      const junk = await put(join(dir, 'Junk.iso'), Buffer.alloc(3 * 1024 * 1024, 0x5a))
      expect(await xboxImageInfo(REAL_HELPER, junk)).toEqual({
        rejected: 'not an Xbox or Xbox 360 disc image (no XDVDFS file system found)'
      })
      expect(await xboxImageInfo(join(dir, 'None.exe'), junk)).toBeNull()
    }, 60_000)
  }
)

describe('7. a stop removes only what this run made at the output', () => {
  const start = (t: ReturnType<typeof convertSetup>, iso: string): Promise<ConvertStatus> =>
    t.service.start({
      platformId: 'xbox360',
      pairId: 'x360-iso-xiso',
      reversed: false,
      paths: [iso]
    })

  it('a result the helper reported (exit 0, done names it, size matches) goes', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const out = join(dir, 'roms', 'Game.xiso.iso')
    const helper = fakeHelper(async (_args, print, _signal, untilStopped) => {
      await put(out, 'xiso')
      print({ type: 'done', output: out, outputBytes: 4 })
      await untilStopped()
      return 0
    })
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    await start(t, iso)
    await reached(helper.waiting)
    expect(existsSync(out)).toBe(true)
    await t.service.stop()
    expect(existsSync(out)).toBe(false)
    expect(existsSync(iso)).toBe(true)
    expect(t.statuses.at(-1)).toMatchObject({ running: false, items: [{ state: 'stopped' }] })
  })

  it('something that appeared at the output from elsewhere (the helper refused it) stays', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const out = join(dir, 'roms', 'Game.xiso.iso')
    const partial = join(dir, 'roms', 'Game.playout-partial.xiso.iso')
    const helper = fakeHelper(async (_args, print, _signal, untilStopped) => {
      await put(partial, 'half')
      // Another program writes the output meanwhile; the helper will not replace it.
      await put(out, 'mine')
      print({ type: 'error', message: `${out} appeared during the conversion`, refused: true })
      await untilStopped()
      return 1
    })
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    await start(t, iso)
    await reached(helper.waiting)
    expect(existsSync(out)).toBe(true)
    await t.service.stop()
    expect(await fs.readFile(out, 'utf8')).toBe('mine')
    expect(existsSync(partial)).toBe(false)
    expect(existsSync(iso)).toBe(true)
  })

  it('a done line naming the output but of another size does not make it this run’s', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const out = join(dir, 'roms', 'Game.xiso.iso')
    const helper = fakeHelper(async (_args, print, _signal, untilStopped) => {
      await put(out, 'replaced by someone else')
      print({ type: 'done', output: out, outputBytes: 4 })
      await untilStopped()
      return 0
    })
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    await start(t, iso)
    await reached(helper.waiting)
    expect(existsSync(out)).toBe(true)
    await t.service.stop()
    expect(await fs.readFile(out, 'utf8')).toBe('replaced by someone else')
  })
})

describe('8. a stop or PlayOut closing while a run is still being checked', () => {
  const request = (iso: string): ConvertRequest => ({
    platformId: 'xbox360',
    pairId: 'x360-iso-xiso',
    reversed: false,
    paths: [iso]
  })

  it('stop() during the checks: the run never starts, its items are stopped', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const helper = fakeHelper(async () => 0)
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    const started = t.service.start(request(iso))
    await t.service.stop()
    expect(await started).toMatchObject({
      running: false,
      items: [{ path: iso, state: 'stopped' }]
    })
    expect(helper.calls).toEqual([])
    expect((await t.service.status()).running).toBe(false)
    // Not closed: the next start runs.
    await put(join(dir, 'roms', 'Game.xiso.iso'))
    await t.service.start(request(iso))
    expect((await t.finished()).items[0]).toMatchObject({ state: 'skipped' })
  })

  it('close() during the checks stops that run; every later start() rejects at once', async () => {
    const iso = await put(join(dir, 'roms', 'Game.iso'))
    const helper = fakeHelper(async () => 0)
    const t = convertSetup({ runHelper: helper.runHelper })
    await put(t.exe)
    const started = t.service.start(request(iso))
    await t.service.close()
    expect(await started).toMatchObject({ running: false, items: [{ state: 'stopped' }] })
    await expect(t.service.start(request(iso))).rejects.toThrow(/closing/)
    expect(helper.calls).toEqual([])
  })

  it('Trim Games disposed while the last gate is looked at starts nothing', async () => {
    const path = await put(join(dir, 'ps2', 'Game.iso'))
    const game = rom('ps2', path)
    let looks = 0
    const h = trimHarness([game], {
      // The first look is the queue's; the second is the gate's, right before start().
      inUse: async () => {
        if (++looks === 2) h.service.dispose()
        return false
      }
    })
    h.service.add([game.id])
    await h.service.idle()
    expect(looks).toBe(2)
    expect(h.started).toEqual([])
  })
})

describe('9. only a refusal of the image is a rejection; other helper errors are looked at again', () => {
  const failing =
    (line: string, code = 1): HelperRun =>
    async (_exe, _args, onLine) => {
      onLine(line)
      return code
    }
  const ioLine = JSON.stringify({
    type: 'error',
    message:
      'IOException: The process cannot access the file because it is being used by another process.'
  })

  it('xboxImageInfo: exit 1 without "refused" is no answer (told to onFailed); with it a rejection', async () => {
    const failed = vi.fn()
    expect(await xboxImageInfo('x.exe', 'Game.iso', failing(ioLine), failed)).toBeNull()
    expect(failed).toHaveBeenCalledWith(expect.stringMatching(/^IOException: /))
    // An older helper (no "refused" at all) is never taken as a refusal either.
    const old = failing(JSON.stringify({ type: 'error', message: 'not an Xbox image' }))
    expect(await xboxImageInfo('x.exe', 'Game.iso', old)).toBeNull()
    const refused = vi.fn()
    const refusing = failing(
      JSON.stringify({ type: 'error', message: 'not an Xbox image', refused: true })
    )
    expect(await xboxImageInfo('x.exe', 'Game.iso', refusing, refused)).toEqual({
      rejected: 'not an Xbox image'
    })
    expect(refused).not.toHaveBeenCalled()
    // Cancelled (exit 3) is not a failure of the image.
    const cancelled = vi.fn()
    const cancelling = failing(JSON.stringify({ type: 'error', message: 'cancelled' }), 3)
    expect(await xboxImageInfo('x.exe', 'Game.iso', cancelling, cancelled)).toBeNull()
    expect(cancelled).not.toHaveBeenCalled()
    expect(await helperXboxInfo('x.exe', failing(ioLine))('Game.iso')).toEqual({
      failed: expect.stringMatching(/^IOException: /)
    })
    expect(await helperXboxInfo('x.exe', async () => 3)('Game.iso')).toBeNull()
  })

  it('xboxImageInfo: a helper that does not finish in time is killed and is a failure (a retry), not a refusal', async () => {
    let killed = 0
    // What a killed helper leaves: an error line on its way out and exit 1; its words say nothing about the image.
    const stuck: HelperRun = (_exe, _args, onLine, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          killed++
          onLine(JSON.stringify({ type: 'error', message: 'cancelled', refused: true }))
          resolve(1)
        })
      })
    const failed = vi.fn()
    expect(await xboxImageInfo('x.exe', 'Game.iso', stuck, failed, 50)).toBeNull()
    expect(killed).toBe(1)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledWith('the Xbox helper did not answer in time')
    expect(await helperXboxInfo('x.exe', stuck, 50)('Game.iso')).toEqual({
      failed: 'the Xbox helper did not answer in time'
    })
    // Not trimmed blind (the trim would run the same helper on the same image): looked at again later.
    const path = await put(join(dir, 'xbox', 'Stuck.iso'))
    expect(await planTrim(rom('xbox', path), helperXboxInfo('x.exe', stuck, 50))).toEqual({
      retry: 'Stuck.iso: the Xbox helper did not answer in time'
    })
    expect(killed).toBe(3)
  })

  it('planTrim: a failure is a retry, not a skip', async () => {
    const path = await put(join(dir, 'xbox', 'Locked.iso'))
    expect(await planTrim(rom('xbox', path), helperXboxInfo('x.exe', failing(ioLine)))).toEqual({
      retry: expect.stringMatching(/^Locked\.iso: IOException: /)
    })
  })

  it('Trim Games requeues the game after a failure, never remembers it, and converts once the helper answers', async () => {
    const path = await put(join(dir, 'xbox360', 'Busy.iso'))
    const game = rom('xbox360', path)
    let calls = 0
    const xboxInfo = vi.fn<XboxInfo>(async () =>
      ++calls === 1
        ? { failed: 'IOException: the file is in use' }
        : { format: 'redump', optimized: false, platform: 'xbox360', xgd: 2 }
    )
    const h = trimHarness([game], { xboxInfo })
    h.service.add([game.id])
    await h.service.idle()
    expect(xboxInfo).toHaveBeenCalledTimes(2)
    expect(h.started).toEqual([
      { platformId: 'xbox360', pairId: 'x360-iso-xiso', reversed: false, paths: [path] }
    ])
  })

  it('a failure that does not pass: skipped after a few looks, never sent to Convert', async () => {
    const path = await put(join(dir, 'xbox', 'Stuck.iso'))
    const game = rom('xbox', path)
    const xboxInfo = vi.fn<XboxInfo>(async () => ({ failed: 'IOException: disk error' }))
    const h = trimHarness([game], { xboxInfo })
    h.service.add([game.id])
    await h.service.idle()
    expect(xboxInfo).toHaveBeenCalledTimes(3)
    expect(h.started).toEqual([])
    expect(log.info).toHaveBeenCalledWith(
      'Trim Games: Stuck.iso left as it is: Stuck.iso: IOException: disk error'
    )
  })
})

describe.runIf(process.platform === 'win32' && existsSync(REAL_HELPER))(
  'the real Xbox helper: refusals are marked, I/O errors are not',
  () => {
    it('a junk file is refused ("refused": true); a file locked by another process is not', async () => {
      const junk = await put(join(dir, 'Junk.iso'), Buffer.alloc(3 * 1024 * 1024, 0x5a))
      const refused = await helper(['info', junk])
      expect(refused.code).toBe(1)
      expect(refused.lines.at(-1)).toMatchObject({ type: 'error', refused: true })

      const locked = await put(join(dir, 'Locked.iso'), Buffer.alloc(3 * 1024 * 1024, 0x5a))
      // libuv's exclusive open (share mode 0): the helper cannot open the file at all.
      const handle = await fs.open(locked, constants.O_RDONLY | 0x10000000)
      try {
        const failed = await helper(['info', locked])
        expect(failed.code).toBe(1)
        const last = failed.lines.at(-1)
        expect(last).toMatchObject({ type: 'error' })
        expect(last).not.toHaveProperty('refused')
        const told = vi.fn()
        expect(await xboxImageInfo(REAL_HELPER, locked, undefined, told)).toBeNull()
        expect(told).toHaveBeenCalledTimes(1)
        expect(await helperXboxInfo(REAL_HELPER)(locked)).toMatchObject({
          failed: expect.any(String)
        })
      } finally {
        await handle.close()
      }
    }, 60_000)
  }
)
