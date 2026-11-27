import { describe, expect, it } from 'vitest'
import {
  appFps,
  exeBaseName,
  isProfileExe,
  parseRtssSnapshot,
  pickGameEntry,
  type RtssAppEntry,
  type RtssSnapshot
} from './memory'

const entry = (
  pid: number,
  name: string,
  fps: number | null,
  extra: Partial<RtssAppEntry> = {}
): RtssAppEntry => ({
  pid,
  name,
  flags: 0,
  time0: fps === null ? 0 : 10_000,
  time1: fps === null ? 0 : 11_000,
  frames: fps === null ? 0 : fps,
  frameTimeUs: fps ? Math.round(1_000_000 / fps) : 0,
  ...extra
})

describe('appFps', () => {
  it('is frames per second over the window, to 0.1', () => {
    expect(appFps(entry(1, 'a', 60))).toBe(60)
    expect(appFps({ ...entry(1, 'a', 0), time0: 1000, time1: 1300, frames: 37 })).toBe(123.3)
  })

  it('is null once the window ended more than 2.5 s before the snapshot (the game stopped presenting)', () => {
    const e = entry(1, 'a', 60) // window 10 000 - 11 000
    expect(appFps(e, 11_500)).toBe(60)
    expect(appFps(e, 13_500)).toBe(60)
    expect(appFps(e, 13_501)).toBeNull()
    // time1 a little ahead of the tick (read while RTSS wrote it), and ticks that wrapped past 2^32.
    expect(appFps(e, 10_990)).toBe(60)
    expect(appFps({ ...e, time0: 0xffffff00, time1: 0xffffffff, frames: 15 }, 500)).toBe(58.8)
    const snap: RtssSnapshot = { version: 0x20015, foregroundPid: 1, apps: [e], tick: 60_000 }
    expect(pickGameEntry(snap, [1])).toBeNull()
    expect(pickGameEntry({ ...snap, tick: 12_000 }, [1])?.pid).toBe(1)
  })

  it('is null without a valid window or frames', () => {
    expect(appFps(entry(1, 'a', null))).toBeNull()
    expect(appFps({ ...entry(1, 'a', 60), time1: 10_000 })).toBeNull()
    expect(appFps({ ...entry(1, 'a', 60), time0: 0 })).toBeNull()
    expect(appFps({ ...entry(1, 'a', 60), frames: 0 })).toBeNull()
  })
})

describe('pickGameEntry', () => {
  const snap: RtssSnapshot = {
    version: 0x20015,
    foregroundPid: 300,
    apps: [
      entry(100, 'C:\\Games\\Launcher.exe', 30),
      entry(200, 'C:\\Games\\Game.exe', 90),
      entry(300, 'C:\\Games\\Game2.exe', 60),
      entry(400, 'C:\\Tools\\Idle.exe', null)
    ]
  }

  it('prefers the foreground pid among the game pids, then the highest rate', () => {
    expect(pickGameEntry(snap, [100, 200, 300])?.pid).toBe(300)
    expect(pickGameEntry(snap, [100, 200])?.pid).toBe(200)
    expect(pickGameEntry(snap, [100])?.pid).toBe(100)
  })

  it('takes only entries with frames', () => {
    expect(pickGameEntry(snap, [400])).toBeNull()
    expect(pickGameEntry(snap, [999])).toBeNull()
  })

  it('falls back to the foreground entry without pids', () => {
    expect(pickGameEntry(snap, [])?.pid).toBe(300)
    expect(pickGameEntry({ ...snap, foregroundPid: null }, [])).toBeNull()
    expect(pickGameEntry({ ...snap, foregroundPid: 400 }, [])).toBeNull()
  })
})

describe('names', () => {
  it('takes the file name of either slash', () => {
    expect(exeBaseName('C:\\Games\\X\\Game.exe')).toBe('Game.exe')
    expect(exeBaseName('C:/Games/X/Game.exe')).toBe('Game.exe')
    expect(exeBaseName('Game.exe')).toBe('Game.exe')
  })

  it('lets through bare program names only', () => {
    for (const ok of [
      'Game.exe',
      'JWE3.exe',
      'OblivionRemastered-Win64-Shipping.exe',
      'my game (x64).EXE',
      'a.b.exe'
    ])
      expect(isProfileExe(ok), ok).toBe(true)
    for (const bad of [
      'Global',
      'Config',
      'Game',
      '..\\Global.exe',
      '../x.exe',
      'C:\\x.exe',
      'a/b.exe',
      '..exe',
      '...exe',
      '.exe',
      ' x.exe',
      'x..y.exe',
      'a\u0000.exe',
      'x.exe.cfg',
      `${'a'.repeat(201)}.exe`,
      'x?.exe'
    ])
      expect(isProfileExe(bad), bad).toBe(false)
  })
})

describe('parseRtssSnapshot', () => {
  it('parses the native JSON and keeps used entries only', () => {
    const raw = JSON.stringify({
      version: 131093,
      foregroundPid: 10008,
      apps: [
        {
          pid: 11416,
          name: 'C:\\X\\A.exe',
          flags: 268500992,
          time0: 1,
          time1: 2,
          frames: 3,
          frameTimeUs: 4
        },
        { pid: 0, name: 'unused' },
        'junk',
        { pid: -1 }
      ]
    })
    expect(parseRtssSnapshot(raw)).toEqual({
      version: 131093,
      foregroundPid: 10008,
      apps: [
        {
          pid: 11416,
          name: 'C:\\X\\A.exe',
          flags: 268500992,
          time0: 1,
          time1: 2,
          frames: 3,
          frameTimeUs: 4
        }
      ]
    })
  })

  it('keeps the tick when the native host sends it', () => {
    expect(
      parseRtssSnapshot('{"version":131093,"foregroundPid":0,"tick":4000000000,"apps":[]}')
    ).toEqual({
      version: 131093,
      foregroundPid: null,
      apps: [],
      tick: 4000000000
    })
  })

  it('is null when RTSS is not running or the answer is not a snapshot', () => {
    expect(parseRtssSnapshot('null')).toBeNull()
    expect(parseRtssSnapshot(null)).toBeNull()
    expect(parseRtssSnapshot('{nope')).toBeNull()
    expect(parseRtssSnapshot({ apps: [] })).toBeNull()
    expect(parseRtssSnapshot({ version: 0x20015, foregroundPid: 0 })).toEqual({
      version: 0x20015,
      foregroundPid: null,
      apps: []
    })
  })
})
