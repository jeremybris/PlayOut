import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  filetimeToIso,
  locateUnlockFile,
  parseUnlockFile,
  readUnlockFile,
  type UnlockLookup
} from './unlock-file'

/** FILETIME of an ISO time (100 ns intervals since 1601). */
const ft = (iso: string): bigint => (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n

describe('filetimeToIso', () => {
  it('turns a FILETIME into the time it names', () => {
    expect(filetimeToIso(ft('2026-11-20T18:30:05.000Z'))).toBe('2026-11-20T18:30:05.000Z')
    // 1601 + 0 and before 1970 or after the year 3000 are not real unlock times.
    expect(filetimeToIso(0n)).toBeNull()
    expect(filetimeToIso(5n)).toBeNull()
    expect(filetimeToIso(ft('3100-01-01T00:00:00Z'))).toBeNull()
  })
})

describe('parseUnlockFile', () => {
  it('reads [unlocked.<id>] tables with decimal ids and their times, as the runtime writes them', () => {
    const text = [
      '# Achievement unlock state managed by the ReXGlue runtime',
      '',
      '[unlocked.3]',
      `filetime = ${ft('2026-11-01T10:00:00Z')}`,
      '',
      '[unlocked.12]',
      `filetime = ${ft('2026-11-02T11:00:00Z')} # comment`,
      '',
      '[unlocked.7]',
      'filetime = 0'
    ].join('\r\n')
    const unlocks = parseUnlockFile(text)
    expect([...unlocks.entries()]).toEqual([
      [3, '2026-11-01T10:00:00.000Z'],
      [12, '2026-11-02T11:00:00.000Z'],
      [7, null]
    ])
  })

  it('reads the older unlocked = [ids] list, on one line or several', () => {
    expect([...parseUnlockFile('unlocked = [1, 0x2, 3]').keys()]).toEqual([1, 2, 3])
    expect([...parseUnlockFile('unlocked = [\n  4,\n  5, # five\n]\n').entries()]).toEqual([
      [4, null],
      [5, null]
    ])
  })

  it('takes only decimal [unlocked.<id>] ids, the only ones the runtime writes and reads', () => {
    const text = [
      '[unlocked.0x0C]',
      'filetime = 1',
      '[unlocked."8"]',
      'filetime = 2',
      '[unlocked]',
      `9 = { filetime = ${ft('2026-01-01T00:00:00Z')} }`,
      '[unlocked.10]'
    ].join('\n')
    expect([...parseUnlockFile(text).keys()]).toEqual([10])
    // The older list is a top-level key only.
    expect(parseUnlockFile('[other]\nunlocked = [1, 2]').size).toBe(0)
  })

  it('skips what it cannot read in a damaged file and keeps the rest', () => {
    const text = [
      '[unlocked.0]',
      'filetime = 1',
      '[unlocked.abc]',
      'filetime = 2',
      '[unlocked.99999999999]',
      '[unlocked.4',
      'garbage line',
      '[unlocked.5]',
      'filetime = "not a number"',
      '[other.6]',
      'filetime = 3',
      '\u0000\u0001binary'
    ].join('\n')
    expect([...parseUnlockFile(text).entries()]).toEqual([[5, null]])
    expect(parseUnlockFile('').size).toBe(0)
  })
})

describe('locateUnlockFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-unlock-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function put(path: string, text = '[unlocked.1]\nfiletime = 0\n'): Promise<string> {
    const full = join(dir, path)
    await fs.mkdir(join(full, '..'), { recursive: true })
    await fs.writeFile(full, text)
    return full
  }

  const lookup = (over: Partial<UnlockLookup> = {}): UnlockLookup => ({
    titleId: '4D5307E6',
    catalogFolder: null,
    saveFolders: [],
    install: join(dir, 'install'),
    roots: [join(dir, 'appdata')],
    ...over
  })

  it("takes the catalog folder first, as the runtime's user_root (the file in its achievements folder)", async () => {
    await put('user\\4D5307E6.toml')
    const installed = await put('install\\userdata\\achievements\\4D5307E6.toml')
    // A file directly in the folder is not where the runtime keeps it.
    expect(await locateUnlockFile(lookup({ catalogFolder: join(dir, 'user') }))).toBe(installed)
    const inSub = await put('user\\achievements\\4D5307E6.toml')
    expect(await locateUnlockFile(lookup({ catalogFolder: join(dir, 'user') }))).toBe(inSub)
  })

  it('looks in the save folders, then the install folder, then the user folders', async () => {
    const roaming = await put('appdata\\Studio\\Game\\achievements\\4D5307E6.toml')
    expect(await locateUnlockFile(lookup())).toBe(roaming)
    const installed = await put('install\\game\\user\\achievements\\4D5307E6.toml')
    expect(await locateUnlockFile(lookup())).toBe(installed)
    const saves = await put('saves\\achievements\\4D5307E6.toml')
    expect(await locateUnlockFile(lookup({ saveFolders: [join(dir, 'saves')] }))).toBe(saves)
  })

  it("takes only the file named after the game's title id", async () => {
    await put('install\\achievements\\11111111.toml')
    await put('appdata\\Other\\achievements\\22222222.toml')
    expect(await locateUnlockFile(lookup())).toBeNull()
    // Too deep under a user folder.
    await put('appdata\\a\\b\\c\\achievements\\4D5307E6.toml')
    expect(await locateUnlockFile(lookup())).toBeNull()
  })

  it('without a title id, takes a lone unlock file in the catalog folder only', async () => {
    const lone = await put('user\\achievements\\4D5307E6.toml')
    await put('install\\achievements\\33333333.toml')
    const noId = lookup({ titleId: null, catalogFolder: join(dir, 'user') })
    expect(await locateUnlockFile(noId)).toBe(lone)
    await put('user\\achievements\\44444444.toml')
    expect(await locateUnlockFile(noId)).toBeNull()
    expect(await locateUnlockFile(lookup({ titleId: null }))).toBeNull()
  })

  it('reads the file it found', async () => {
    const path = await put(
      'x\\4D5307E6.toml',
      `[unlocked.2]\nfiletime = ${ft('2026-05-05T05:05:05Z')}\n`
    )
    expect([...(await readUnlockFile(path))!.entries()]).toEqual([[2, '2026-05-05T05:05:05.000Z']])
    expect(await readUnlockFile(join(dir, 'missing.toml'))).toBeNull()
  })
})
