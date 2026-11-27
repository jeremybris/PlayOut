import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cachedModified,
  ensurePcsx2GameListed,
  folderCovered,
  listPcsx2Games,
  pcsx2GamesNeedingWork,
  pcsx2Scannable,
  RESTORE_MARKER,
  restoreAfterScan,
  UNLISTED_FILE,
  type FileStamp,
  type Pcsx2GameListDeps
} from './pcsx2-game-list'
import type { HiddenProcess } from './presets/types'

let dir: string
let emu: string
let ini: string
let cache: string
let roms: string
let rom: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const INI = '[UI]\nSettingsVersion = 1\nStartBigPictureMode = true\n\n[Folders]\nCache = cache\n'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-pcsx2-list-'))
  emu = join(dir, 'PCSX2')
  ini = join(emu, 'inis', 'PCSX2.ini')
  cache = join(emu, 'cache', 'gamelist.cache')
  roms = join(dir, 'Emulation', 'roms', 'ps2')
  rom = join(roms, '007 - From Russia with Love (USA).chd')
  await mkdir(join(emu, 'inis'), { recursive: true })
  await mkdir(join(emu, 'cache'), { recursive: true })
  await mkdir(roms, { recursive: true })
  await writeFile(rom, 'disc')
  await writeFile(ini, INI)
  vi.clearAllMocks()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const str = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8')
  const n = Buffer.alloc(4)
  n.writeUInt32LE(b.length)
  return Buffer.concat([n, b])
}
/** One cache record as PCSX2 2.8.2 writes it (GameList.cpp WriteEntryToCache). */
function record(path: string, modified: number): Buffer {
  const tail = Buffer.alloc(2 + 8 + 8 + 4 + 1)
  tail.writeUInt8(0, 0) // type: PS2 disc
  tail.writeUInt8(1, 1) // region
  tail.writeBigUInt64LE(2_000_000_000n, 2) // size
  tail.writeBigUInt64LE(BigInt(modified), 10)
  tail.writeUInt32LE(0x1234abcd, 18) // CRC
  tail.writeUInt8(5, 22)
  return Buffer.concat([
    str(path),
    str('SLUS-21282'),
    str('007 - From Russia with Love'),
    str(''),
    str(''),
    tail
  ])
}
/** A whole cache: signature and version 34, then the records. */
const cacheOf = (...records: Buffer[]): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(0x45434c47, 0)
  head.writeUInt32LE(34, 4)
  return Buffer.concat([head, ...records])
}
const mtimeOf = async (file: string): Promise<number> =>
  Math.floor((await stat(file)).mtimeMs / 1000)

/** A hidden PCSX2: scans (writes a current cache record) after `scanMs`, and exits when asked to close. */
function fakePcsx2(scanMs: number | null): {
  start: Pcsx2GameListDeps['startHidden']
  started: string[][]
  iniWhileRunning: string[]
} {
  const started: string[][] = []
  const iniWhileRunning: string[] = []
  return {
    started,
    iniWhileRunning,
    start: (file, args) => {
      started.push([file, ...args])
      let resolveExit!: (c: number | null) => void
      const exited = new Promise<number | null>((r) => (resolveExit = r))
      void readFile(ini, 'utf8').then((t) => iniWhileRunning.push(t))
      const timer =
        scanMs === null
          ? null
          : setTimeout(async () => {
              await writeFile(cache, cacheOf(record(rom, await mtimeOf(rom))))
            }, scanMs)
      const proc: HiddenProcess = {
        exited,
        stop: async () => {
          if (timer) clearTimeout(timer)
          resolveExit(null)
        },
        close: async () => {
          if (timer) clearTimeout(timer)
          resolveExit(0)
        }
      }
      return proc
    }
  }
}

const deps = (over: Partial<Pcsx2GameListDeps>): Pcsx2GameListDeps => ({
  emuDir: emu,
  exe: join(emu, 'pcsx2-qt.exe'),
  rom,
  log,
  startHidden: fakePcsx2(10).start,
  isRunning: async () => false,
  ...over
})

describe('PCSX2 game list helpers', () => {
  it('knows when a folder is listed, directly or under a recursive folder', () => {
    expect(folderCovered('C:\\Games\\PS2', ['c:\\games\\ps2\\'], [])).toBe(true)
    expect(folderCovered('C:\\Games\\PS2', ['C:/Games/PS2'], [])).toBe(true)
    expect(folderCovered('C:\\Games\\PS2\\Sub', ['C:\\Games\\PS2'], [])).toBe(false)
    expect(folderCovered('C:\\Games\\PS2\\Sub', [], ['C:\\Games'])).toBe(true)
    expect(folderCovered('C:\\GamesOther', [], ['C:\\Games'])).toBe(false)
  })

  it('reads the newest record of a path, however PCSX2 spelled the separators', () => {
    const path = 'E:\\Game.iso'
    expect(cachedModified(cacheOf(record('E:\\\\Game.iso', 5)), path)).toBe(5)
    expect(cachedModified(cacheOf(record('e:/game.ISO', 5), record('E:\\Game.iso', 9)), path)).toBe(
      9
    )
    // Only the whole path: a longer name that starts the same is another game.
    expect(cachedModified(cacheOf(record('E:\\Game.iso.bak', 5)), path)).toBeNull()
    expect(cachedModified(cacheOf(), path)).toBeNull()
    expect(cachedModified(null, path)).toBeNull()
    // A record cut short (PCSX2 still writing) is not read.
    const full = cacheOf(record(path, 5), record('E:\\Other.iso', 6))
    expect(cachedModified(full.subarray(0, full.length - 3), path)).toBe(5)
  })

  it('knows the files PCSX2 lists', () => {
    expect(pcsx2Scannable('C:\\g\\Game.CHD')).toBe(true)
    expect(pcsx2Scannable('C:\\g\\Game.iso.gz')).toBe(true)
    expect(pcsx2Scannable('C:\\g\\Game.m3u')).toBe(false)
    expect(pcsx2Scannable('C:\\g\\Game.dump')).toBe(false)
  })
})

describe('ensurePcsx2GameListed', () => {
  it('adds the folder, scans hidden with Big Picture and the update check off, then puts both back', async () => {
    const pcsx2 = fakePcsx2(10)
    expect(await ensurePcsx2GameListed(deps({ startHidden: pcsx2.start }))).toBe('scanned')
    // Started without -batch (it scans its folders then) and without arguments.
    expect(pcsx2.started).toEqual([[join(emu, 'pcsx2-qt.exe')]])
    expect(pcsx2.iniWhileRunning[0]).toContain('StartBigPictureMode = false')
    expect(pcsx2.iniWhileRunning[0]).toContain('[AutoUpdater]\nCheckAtStartup = false')
    const text = await readFile(ini, 'utf8')
    expect(text).toContain('StartBigPictureMode = true')
    expect(text).toContain('CheckAtStartup = true')
    // The file keeps PCSX2's own LF line endings.
    expect(text).toContain(`[GameList]\nPaths = ${roms}\n`)
    await expect(stat(join(emu, RESTORE_MARKER))).rejects.toThrow()

    // Listed now: no second scan, no second Paths line.
    const again = fakePcsx2(10)
    expect(await ensurePcsx2GameListed(deps({ startHidden: again.start }))).toBe('listed')
    expect(again.started).toEqual([])
    expect((await readFile(ini, 'utf8')).match(/^Paths = /gm)).toHaveLength(1)
  })

  it('scans again when the game file changed since PCSX2 cached it (batch mode skips a stale record)', async () => {
    await writeFile(cache, cacheOf(record(rom, (await mtimeOf(rom)) - 100)))
    const pcsx2 = fakePcsx2(10)
    expect(await ensurePcsx2GameListed(deps({ startHidden: pcsx2.start }))).toBe('scanned')
    expect(pcsx2.started).toHaveLength(1)
  })

  it('keeps a recursive folder that covers the game, Big Picture the user turned off, and their update choice', async () => {
    await writeFile(
      ini,
      `[UI]\nStartBigPictureMode = false\n\n[AutoUpdater]\nCheckAtStartup = false\n\n[GameList]\nRecursivePaths = ${join(dir, 'Emulation')}\n`
    )
    expect(await ensurePcsx2GameListed(deps({}))).toBe('scanned')
    const text = await readFile(ini, 'utf8')
    expect(text).not.toMatch(/^Paths = /m)
    expect(text).toContain('StartBigPictureMode = false')
    expect(text).toContain('CheckAtStartup = false')
  })

  it('does nothing while PCSX2 runs, for a file PCSX2 never lists, or under an excluded path', async () => {
    const pcsx2 = fakePcsx2(10)
    expect(
      await ensurePcsx2GameListed(deps({ startHidden: pcsx2.start, isRunning: async () => true }))
    ).toBe('skipped')
    const m3u = join(roms, 'Game.m3u')
    await writeFile(m3u, 'Game.chd')
    expect(await ensurePcsx2GameListed(deps({ startHidden: pcsx2.start, rom: m3u }))).toBe(
      'skipped'
    )
    await writeFile(ini, `${INI}\n[GameList]\nExcludedPaths = ${roms}\n`)
    expect(await ensurePcsx2GameListed(deps({ startHidden: pcsx2.start }))).toBe('skipped')
    expect(pcsx2.started).toEqual([])
    expect(await readFile(ini, 'utf8')).not.toMatch(/^Paths = /m)
  })

  it('gives up within its time, closes PCSX2 and puts the settings back', async () => {
    let t = 0
    const pcsx2 = fakePcsx2(null)
    const result = await ensurePcsx2GameListed(
      deps({
        startHidden: pcsx2.start,
        timeoutMs: 12_000,
        now: () => t,
        sleep: async (ms) => void (t += ms)
      })
    )
    expect(result).toBe('timeout')
    const text = await readFile(ini, 'utf8')
    expect(text).toContain('StartBigPictureMode = true')
    expect(text).toContain('CheckAtStartup = true')
  })

  it('puts the settings back after a scan that was cut short', async () => {
    await writeFile(
      ini,
      '[UI]\nStartBigPictureMode = false\n\n[AutoUpdater]\nCheckAtStartup = false\n'
    )
    await writeFile(
      join(emu, RESTORE_MARKER),
      JSON.stringify({ bigPicture: true, checkAtStartup: null })
    )
    await restoreAfterScan(emu, log)
    const text = await readFile(ini, 'utf8')
    expect(text).toContain('StartBigPictureMode = true')
    expect(text).toContain('CheckAtStartup = true')
    await expect(stat(join(emu, RESTORE_MARKER))).rejects.toThrow()
    // Nothing to put back: the file stays as it is.
    await restoreAfterScan(emu, log)
    expect(await readFile(ini, 'utf8')).toBe(text)
  })

  it('takes no process list in the steady state (folder covered, record current)', async () => {
    await writeFile(ini, `${INI}\n[GameList]\nPaths = ${roms}\n`)
    await writeFile(cache, cacheOf(record(rom, await mtimeOf(rom))))
    const isRunning = vi.fn(async () => true)
    const before = await readFile(ini, 'utf8')
    expect(await ensurePcsx2GameListed(deps({ isRunning }))).toBe('listed')
    expect(isRunning).not.toHaveBeenCalled()
    expect(await readFile(ini, 'utf8')).toBe(before)
    // Neither when a scan is needed but not asked for (a launch): only a write asks.
    await writeFile(cache, cacheOf())
    expect(await ensurePcsx2GameListed(deps({ isRunning, scan: false }))).toBe('pending')
    expect(isRunning).not.toHaveBeenCalled()
    // A marker left by a cut-short scan is put back only while PCSX2 is closed: that asks.
    await writeFile(join(emu, RESTORE_MARKER), JSON.stringify({ bigPicture: true }))
    expect(await ensurePcsx2GameListed(deps({ isRunning, scan: false }))).toBe('skipped')
    expect(isRunning).toHaveBeenCalledTimes(1)
  })

  it('at a launch (scan off) adds the folder but never starts PCSX2', async () => {
    const pcsx2 = fakePcsx2(10)
    const isRunning = vi.fn(async () => false)
    expect(
      await ensurePcsx2GameListed(deps({ startHidden: pcsx2.start, isRunning, scan: false }))
    ).toBe('pending')
    expect(pcsx2.started).toEqual([])
    expect(isRunning).toHaveBeenCalledTimes(1)
    expect(await readFile(ini, 'utf8')).toContain(`Paths = ${roms}`)
    // Not even the folder while PCSX2 runs.
    await writeFile(ini, INI)
    expect(
      await ensurePcsx2GameListed(
        deps({ startHidden: pcsx2.start, isRunning: async () => true, scan: false })
      )
    ).toBe('skipped')
    expect(await readFile(ini, 'utf8')).toBe(INI)
  })

  it('stops a scan when asked (a launch), puts the settings back and counts no attempt', async () => {
    let stop = false
    const pcsx2 = fakePcsx2(null)
    const result = await ensurePcsx2GameListed(
      deps({
        startHidden: pcsx2.start,
        shouldStop: () => stop,
        sleep: async () => void (stop = true)
      })
    )
    expect(result).toBe('aborted')
    const text = await readFile(ini, 'utf8')
    expect(text).toContain('StartBigPictureMode = true')
    expect(text).toContain('CheckAtStartup = true')
    await expect(stat(join(emu, RESTORE_MARKER))).rejects.toThrow()
    await expect(stat(join(emu, UNLISTED_FILE))).rejects.toThrow()
    expect(await ensurePcsx2GameListed(deps({ scan: false }))).toBe('pending')
  })

  it('lists several folders with one hidden scan', async () => {
    const other = join(dir, 'Emulation', 'roms', 'ps2b')
    await mkdir(other, { recursive: true })
    const second = join(other, 'Game Two.iso')
    await writeFile(second, 'disc')
    const started: string[] = []
    const start: Pcsx2GameListDeps['startHidden'] = (file) => {
      started.push(file)
      let resolveExit!: (c: number | null) => void
      const exited = new Promise<number | null>((r) => (resolveExit = r))
      const timer = setTimeout(async () => {
        await writeFile(
          cache,
          cacheOf(record(rom, await mtimeOf(rom)), record(second, await mtimeOf(second)))
        )
      }, 10)
      return {
        exited,
        stop: async () => resolveExit(null),
        close: async () => {
          clearTimeout(timer)
          resolveExit(0)
        }
      }
    }
    const base = deps({ startHidden: start })
    expect(await listPcsx2Games({ ...base, roms: [rom, second, join(roms, 'x.m3u')] })).toBe(
      'scanned'
    )
    expect(started).toHaveLength(1)
    const text = await readFile(ini, 'utf8')
    expect(text).toContain(`Paths = ${roms}\nPaths = ${other}\n`)
    expect(await listPcsx2Games({ ...base, roms: [rom, second] })).toBe('listed')
  })

  it('treats a cached game as listed only while the file is unchanged', async () => {
    await writeFile(cache, cacheOf(record(rom, await mtimeOf(rom))))
    expect(await ensurePcsx2GameListed(deps({}))).toBe('listed')
    const later = new Date(Date.now() + 60_000)
    await utimes(rom, later, later)
    const pcsx2 = fakePcsx2(10)
    expect(await ensurePcsx2GameListed(deps({ startHidden: pcsx2.start }))).toBe('scanned')
  })
})

/**
 * A hidden scan that runs to its time limit (60 s on a fake clock) and lists nothing: PCSX2 cannot read the images, or
 * it stalled (an offline share, a dialog it waits on) - the same from outside. `sleepAt(n)` may change the time the
 * n-th poll's sleep took.
 */
async function timedOut(
  over: Partial<Pcsx2GameListDeps> & { roms?: string[] } = {},
  sleepAt?: (n: number) => number | undefined
): Promise<string> {
  let t = 0
  let n = 0
  const { roms: list = [rom], ...rest } = over
  return listPcsx2Games({
    ...deps({ startHidden: fakePcsx2(null).start, timeoutMs: 60_000 }),
    now: () => t,
    sleep: async (ms) => void (t += sleepAt?.(++n) ?? ms),
    ...rest,
    roms: list
  })
}

/** The remembered attempts by file name (lower case), from .playout-unlisted.json; {} when there is no file. */
async function attempts(): Promise<Record<string, number>> {
  try {
    const file = JSON.parse(await readFile(join(emu, UNLISTED_FILE), 'utf8')) as {
      images: { path: string; attempts: number }[]
    }
    return Object.fromEntries(file.images.map((e) => [basename(e.path), e.attempts]))
  } catch {
    return {}
  }
}
const romKey = (): string => basename(rom).toLowerCase()

describe('the attempt counter (images PCSX2 does not list)', () => {
  it('counts one attempt for a scan that ran to its end; a game listed later is never given up on and is forgotten', async () => {
    expect(await timedOut()).toBe('timeout')
    expect(await attempts()).toEqual({ [romKey()]: 1 })
    // One run proves nothing (PCSX2 may have stalled): still scanned.
    expect(await ensurePcsx2GameListed(deps({ scan: false }))).toBe('pending')
    // The next scan lists it: its entry goes.
    expect(await ensurePcsx2GameListed(deps({ startHidden: fakePcsx2(10).start }))).toBe('scanned')
    expect(await attempts()).toEqual({})
  })

  it('gives up on a batch of unreadable images after two runs and does not scan it a third time', async () => {
    const bad = join(roms, 'Bad.iso')
    await writeFile(bad, 'not a disc')
    const batch = [rom, bad]
    expect(await timedOut({ roms: batch })).toBe('timeout')
    expect(await timedOut({ roms: batch })).toBe('timeout')
    expect(await attempts()).toEqual({ [romKey()]: 2, 'bad.iso': 2 })
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('not scanned again until the file or PCSX2 changes')
    )
    const pcsx2 = fakePcsx2(null)
    const isRunning = vi.fn(async () => false)
    expect(
      await listPcsx2Games({ ...deps({ startHidden: pcsx2.start, isRunning }), roms: batch })
    ).toBe('unlisted')
    expect(pcsx2.started).toHaveLength(0)
    expect(isRunning).not.toHaveBeenCalled()
    expect(
      await pcsx2GamesNeedingWork({ emuDir: emu, exe: join(emu, 'pcsx2-qt.exe'), log, roms: batch })
    ).toEqual([])
    // A changed file is scanned again, from one attempt.
    const later = new Date(Date.now() + 60_000)
    await utimes(bad, later, later)
    expect(await listPcsx2Games({ ...deps({ scan: false }), roms: batch })).toBe('pending')
    expect(await timedOut({ roms: [bad] })).toBe('timeout')
    expect(await attempts()).toEqual({ [romKey()]: 2, 'bad.iso': 1 })
  })

  it('counts nothing for a run that was stopped: asked, the PC slept, another PCSX2', async () => {
    expect(await timedOut()).toBe('timeout')
    // Asked (a launch, setup, quitting).
    let stop = false
    expect(await timedOut({ shouldStop: () => stop }, () => void (stop = true))).toBe('aborted')
    // The 4th poll's sleep took a minute: suspended.
    expect(await timedOut({}, (n) => (n === 4 ? 60_000 : undefined))).toBe('aborted')
    // Another PCSX2 started (and closed again before the settings went back).
    expect(await timedOut({ othersRunning: async () => true })).toBe('aborted')
    expect(await attempts()).toEqual({ [romKey()]: 1 })
    const text = await readFile(ini, 'utf8')
    expect(text).toContain('StartBigPictureMode = true')
    expect(await ensurePcsx2GameListed(deps({ scan: false }))).toBe('pending')
  })

  it('counts a PCSX2 that quits by itself (a crash, or blocked) but tries those games again after a day', async () => {
    const dead: Pcsx2GameListDeps['startHidden'] = () => ({
      exited: Promise.resolve(null),
      stop: async () => undefined,
      close: async () => undefined
    })
    const start = Date.now()
    const day = 24 * 60 * 60 * 1000
    expect(await timedOut({ startHidden: dead, wallNow: () => start })).toBe('timeout')
    expect(await timedOut({ startHidden: dead, wallNow: () => start })).toBe('timeout')
    // Not started again after every session...
    expect(await attempts()).toEqual({ [romKey()]: 2 })
    const at = (ms: number): Pcsx2GameListDeps => deps({ scan: false, wallNow: () => ms })
    expect(await ensurePcsx2GameListed(at(start + day / 2))).toBe('unlisted')
    // ...but a day later (the cause, such as a missing runtime, may be fixed without PCSX2 changing).
    expect(await ensurePcsx2GameListed(at(start + day + 1))).toBe('pending')
    expect(await readFile(ini, 'utf8')).toContain('StartBigPictureMode = true')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('quit by itself'))
  })

  it('counts no attempt for a run still listing games of its batch when time ran out', async () => {
    const bad = join(roms, 'Bad.iso')
    await writeFile(bad, 'not a disc')
    // The good game gets listed; Bad.iso may just not be reached yet (a large or slow library): not counted.
    expect(await timedOut({ roms: [rom, bad], startHidden: fakePcsx2(0).start })).toBe('timeout')
    expect(await attempts()).toEqual({})
    // The next run has nothing else to list: now it counts.
    expect(await timedOut({ roms: [bad] })).toBe('timeout')
    expect(await attempts()).toEqual({ 'bad.iso': 1 })
  })

  it('scans again 14 days after the last attempt and when PCSX2 itself changed', async () => {
    const exe = join(emu, 'pcsx2-qt.exe')
    await writeFile(exe, 'v1')
    const day = 24 * 60 * 60 * 1000
    const start = Date.now()
    expect(await timedOut({ wallNow: () => start - day })).toBe('timeout')
    expect(await timedOut({ wallNow: () => start })).toBe('timeout')
    const at = (ms: number): Pcsx2GameListDeps => deps({ scan: false, wallNow: () => ms })
    expect(await ensurePcsx2GameListed(at(start + 13 * day))).toBe('unlisted')
    expect(await ensurePcsx2GameListed(at(start + 15 * day))).toBe('pending')
    // A PCSX2 update (another executable) may read the image: all of them are scanned again.
    expect(await ensurePcsx2GameListed(at(start + day))).toBe('unlisted')
    await writeFile(exe, 'v2 is longer')
    expect(await ensurePcsx2GameListed(at(start + day))).toBe('pending')
    // Its next timed-out run starts again from one attempt.
    expect(await timedOut({ wallNow: () => start + day })).toBe('timeout')
    expect(await attempts()).toEqual({ [romKey()]: 1 })
  })
})

describe('another PCSX2 during a background scan', () => {
  it('stops the scan, keeps the marker and leaves the settings to be put back once that PCSX2 is closed', async () => {
    let t = 0
    let userPcsx2 = false
    const othersRunning = vi.fn(async (pid?: number) => pid !== undefined && userPcsx2)
    const start: Pcsx2GameListDeps['startHidden'] = () => ({
      pid: 4242,
      exited: new Promise<number | null>(() => undefined),
      stop: async () => undefined,
      close: async () => undefined
    })
    const result = await ensurePcsx2GameListed(
      deps({
        startHidden: start,
        timeoutMs: 60_000,
        now: () => t,
        sleep: async (ms) => {
          t += ms
          // The user opens PCSX2 3 s into the scan.
          if (t >= 3_000) userPcsx2 = true
        },
        othersRunning,
        isRunning: async () => userPcsx2
      })
    )
    expect(result).toBe('aborted')
    // Checked about every 2 s, without the hidden PCSX2.
    expect(othersRunning).toHaveBeenCalledTimes(2)
    expect(othersRunning).toHaveBeenCalledWith(4242)
    expect(t).toBeLessThan(5_000)
    // Not put back while the user's PCSX2 runs (it writes its own PCSX2.ini when it exits).
    expect(await readFile(ini, 'utf8')).toContain('StartBigPictureMode = false')
    expect(await stat(join(emu, RESTORE_MARKER))).toBeTruthy()
    // Still running at the next step (a launch's): nothing written.
    expect(await ensurePcsx2GameListed(deps({ scan: false, isRunning: async () => true }))).toBe(
      'skipped'
    )
    // Closed: the next step puts them back first.
    userPcsx2 = false
    expect(await ensurePcsx2GameListed(deps({ scan: false }))).toBe('pending')
    const text = await readFile(ini, 'utf8')
    expect(text).toContain('StartBigPictureMode = true')
    expect(text).toContain('CheckAtStartup = true')
    await expect(stat(join(emu, RESTORE_MARKER))).rejects.toThrow()
  })
})

describe('the read-only phase', () => {
  it('stops between two games when asked, before anything is written', async () => {
    const second = join(roms, 'Second.iso')
    await writeFile(second, 'disc')
    let stop = false
    const statted: string[] = []
    const statFile = async (file: string): Promise<FileStamp> => {
      statted.push(file)
      stop = true
      return { modified: 1, size: 4 }
    }
    const pcsx2 = fakePcsx2(10)
    expect(
      await listPcsx2Games({
        ...deps({ startHidden: pcsx2.start, stat: statFile, shouldStop: () => stop }),
        roms: [rom, second]
      })
    ).toBe('aborted')
    expect(statted).toHaveLength(1)
    expect(pcsx2.started).toEqual([])
    expect(await readFile(ini, 'utf8')).toBe(INI)
    stop = false
    statted.length = 0
    expect(
      await pcsx2GamesNeedingWork({
        emuDir: emu,
        exe: join(emu, 'pcsx2-qt.exe'),
        log,
        roms: [rom, second],
        stat: statFile,
        shouldStop: () => stop
      })
    ).toBe('aborted')
    expect(statted).toHaveLength(1)
  })

  it('skips a game whose file does not answer in time (an offline share) for this pass', async () => {
    const second = join(roms, 'Second.iso')
    await writeFile(second, 'disc')
    const statFile = async (file: string): Promise<FileStamp | null> =>
      file === rom ? new Promise<FileStamp | null>(() => undefined) : { modified: 1, size: 4 }
    const common = { emuDir: emu, exe: join(emu, 'pcsx2-qt.exe'), log, stat: statFile }
    expect(
      await pcsx2GamesNeedingWork({ ...common, statTimeoutMs: 20, roms: [rom, second] })
    ).toEqual([second])
    expect(
      await ensurePcsx2GameListed(deps({ stat: statFile, statTimeoutMs: 20, scan: false }))
    ).toBe('skipped')
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('did not answer within 20 ms'))
  })

  it('lists for the pre-warm only the games that need a folder or a scan', async () => {
    const second = join(roms, 'Second.iso')
    await writeFile(second, 'disc')
    const common = { emuDir: emu, exe: join(emu, 'pcsx2-qt.exe'), log }
    // The folder is missing: both.
    expect(await pcsx2GamesNeedingWork({ ...common, roms: [rom, second] })).toEqual([rom, second])
    await writeFile(ini, `${INI}\n[GameList]\nPaths = ${roms}\n`)
    await writeFile(cache, cacheOf(record(rom, await mtimeOf(rom))))
    expect(await pcsx2GamesNeedingWork({ ...common, roms: [rom, second] })).toEqual([second])
  })
})
