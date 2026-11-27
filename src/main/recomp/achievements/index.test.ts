import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Game } from '../../../shared/types'
import {
  achievementsInfo,
  createRecompAchievements,
  expandAchievementsFolder,
  isSafeUserRoot,
  type RecompAchievementSource,
  type RecompAchievementsReader
} from '.'
import { parseAchievementsToml } from './meta-toml'
import { buildXdbf, buildXex, buildXiso, fakeImage } from './testing'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const TID = '4D5307E6'
const RECOMP = 'github:someone/game-recomp'
const ft = (iso: string): bigint => (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n

const ACHIEVEMENTS = [
  { id: 1, name: 'First Blood', description: 'Win a race.', gamerscore: 10 },
  {
    id: 7,
    name: 'Secret Road',
    description: 'Find the hidden road.',
    unachieved: 'Keep exploring.',
    gamerscore: 25,
    flags: 0x2
  },
  { id: 12, name: 'Champion', description: 'Win every cup.', gamerscore: 50 }
]

let dir: string
let install: string
let ctx: RecompAchievementSource['ctx']

beforeEach(async () => {
  language = 'en'
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-recomp-ach-'))
  install = join(dir, 'Recompilations', 'game')
  await fs.mkdir(install, { recursive: true })
  const profile = join(dir, 'profile')
  ctx = {
    install,
    folders: {
      userProfile: profile,
      appData: join(profile, 'AppData', 'Roaming'),
      localAppData: join(profile, 'AppData', 'Local'),
      programData: join(dir, 'ProgramData'),
      programFiles: join(dir, 'Program Files'),
      programFilesX86: join(dir, 'Program Files (x86)'),
      publicDir: join(dir, 'Public'),
      systemDrive: dir
    },
    documents: join(profile, 'Documents')
  }
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(path: string, data: string | Buffer): Promise<string> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
  return path
}

const game = (over: Partial<Game> = {}): Game => ({ id: 'rom:xbox360:abc', ...over }) as Game

let language = 'en'

function reader(over: Partial<RecompAchievementSource> = {}): {
  sourceFn: Mock<(id: string) => Promise<RecompAchievementSource | null>>
  r: RecompAchievementsReader
} {
  const source: RecompAchievementSource = {
    recompId: RECOMP,
    titleId: TID,
    folder: '{game}\\userdata',
    install,
    ctx,
    saveTemplates: [],
    gameFiles: [],
    ...over
  }
  const sourceFn = vi.fn(async (id: string) => (id === RECOMP ? source : null))
  return {
    sourceFn,
    r: createRecompAchievements({
      dir: join(dir, 'cache'),
      source: sourceFn,
      log,
      language: () => language
    })
  }
}

const unlockFile = (): string =>
  [
    '# Achievement unlock state managed by the ReXGlue runtime',
    '',
    '[unlocked.1]',
    `filetime = ${ft('2026-11-01T10:00:00Z')}`,
    '',
    '[unlocked.12]',
    `filetime = ${ft('2026-11-03T12:00:00Z')}`,
    ''
  ].join('\n')

describe('expandAchievementsFolder', () => {
  it('expands {game} as the install folder and the usual variables', () => {
    expect(expandAchievementsFolder('{game}\\userdata', ctx)).toBe(join(install, 'userdata'))
    expect(expandAchievementsFolder('%LOCALAPPDATA%\\Game\\user', ctx)).toBe(
      join(ctx.folders.localAppData, 'Game', 'user')
    )
    expect(expandAchievementsFolder('%DOCUMENTS%\\game', ctx)).toBe(join(ctx.documents!, 'game'))
    expect(expandAchievementsFolder('{nope}\\x', ctx)).toBeNull()
  })
})

describe('parseAchievementsToml', () => {
  it('reads [[achievements]] tables', () => {
    const list = parseAchievementsToml(
      [
        '# metadata',
        '[[achievements]]',
        'id = 3',
        'label = "Quoted \\"name\\""',
        "description = 'Literal text'",
        'gamerscore = 20',
        'flags = 0x8',
        '',
        '[[achievements]]',
        'id = 0',
        'label = "Refused: id 0"',
        '[[achievements]]',
        'id = 4',
        'label = "Four"',
        'unachieved_description = "Hidden until done"'
      ].join('\n')
    )
    expect(list).toEqual([
      {
        id: 3,
        name: 'Quoted "name"',
        description: 'Literal text',
        unachieved: '',
        gamerscore: 20,
        flags: 8
      },
      {
        id: 4,
        name: 'Four',
        description: '',
        unachieved: 'Hidden until done',
        gamerscore: 0,
        flags: 0
      }
    ])
    expect(parseAchievementsToml('title = "nothing"')).toBeNull()
  })

  it('reads multi-line strings, basic and literal', () => {
    const list = parseAchievementsToml(
      [
        '[[achievements]]',
        'id = 9',
        'label = """One line"""',
        'description = """',
        'First line',
        'second \\"quoted\\" line"""',
        "unachieved_description = '''",
        'Raw \\n text',
        "kept as is'''",
        'gamerscore = 30',
        'flags = 8',
        '[[achievements]]',
        'id = 10',
        'description = """Joined \\',
        '    here"""'
      ].join('\r\n')
    )
    expect(list).toEqual([
      {
        id: 9,
        name: 'One line',
        description: 'First line\nsecond "quoted" line',
        unachieved: 'Raw \\n text\nkept as is',
        gamerscore: 30,
        flags: 8
      },
      { id: 10, name: '', description: 'Joined here', unachieved: '', gamerscore: 0, flags: 0 }
    ])
  })
})

describe('achievementsInfo', () => {
  it('counts only the unlocks when the list cannot be read', () => {
    expect(achievementsInfo(null, new Map([[3, null]]))).toEqual({
      provider: 'recomp',
      total: 0,
      unlocked: 1,
      list: []
    })
    expect(achievementsInfo(null, new Map())).toBeNull()
    expect(achievementsInfo(null, null)).toBeNull()
  })
})

describe('createRecompAchievements', () => {
  it("reads the game's own list from its executable and the unlocks from the unlock file", async () => {
    await put(
      join(install, 'game', 'default.xex'),
      buildXex({ image: fakeImage(buildXdbf(ACHIEVEMENTS)), titleId: TID, compression: 1 })
    )
    await put(join(install, 'userdata', 'achievements', `${TID}.toml`), unlockFile())
    const { r } = reader()
    const info = await r.read(game(), RECOMP)
    expect(info).toEqual({
      provider: 'recomp',
      total: 3,
      unlocked: 2,
      points: { earned: 60, total: 85 },
      list: [
        {
          id: '1',
          name: 'First Blood',
          description: 'Win a race.',
          unlocked: true,
          unlockedAt: '2026-11-01T10:00:00.000Z',
          points: 10
        },
        {
          id: '7',
          name: 'Secret Road',
          description: 'Keep exploring.',
          unlocked: false,
          hidden: true,
          points: 25
        },
        {
          id: '12',
          name: 'Champion',
          description: 'Win every cup.',
          unlocked: true,
          unlockedAt: '2026-11-03T12:00:00.000Z',
          points: 50
        }
      ]
    })
    // The list is kept: without the executable, the next read still has it.
    await fs.rm(join(install, 'game'), { recursive: true })
    expect((await r.read(game(), RECOMP))?.list).toHaveLength(3)
    const [name] = await fs.readdir(join(dir, 'cache'))
    const kept = JSON.parse(await fs.readFile(join(dir, 'cache', name!), 'utf8'))
    expect(kept).toMatchObject({ version: 2, recompId: RECOMP, titleId: TID })
    expect(kept.lists.en).toHaveLength(3)
  })

  it("takes the executable from the player's disc image, and the title id from it when the catalog has none", async () => {
    const xex = buildXex({
      image: fakeImage(buildXdbf(ACHIEVEMENTS)),
      titleId: TID,
      compression: 2
    })
    const iso = await put(join(dir, 'images', 'Game.iso'), buildXiso({ 'default.xex': xex }))
    await put(join(install, 'user', 'achievements', `${TID}.toml`), unlockFile())
    const { r } = reader({ titleId: null, folder: null, gameFiles: [iso] })
    const info = await r.read(game(), RECOMP)
    expect(info).toMatchObject({ total: 3, unlocked: 2 })
    // The card's own disc image works too.
    const { r: r2 } = reader({ titleId: null, folder: null })
    expect(await r2.read(game({ romPath: iso }), RECOMP)).toMatchObject({ total: 3, unlocked: 2 })
  })

  it("lays the recompilation's metadata\\achievements.toml over the game's list, as the runtime does", async () => {
    await put(
      join(install, 'game', 'default.xex'),
      buildXex({ image: fakeImage(buildXdbf(ACHIEVEMENTS)), titleId: TID, compression: 0 })
    )
    await put(
      join(install, 'game', 'metadata', 'achievements.toml'),
      [
        '[[achievements]]\nid = 1\nlabel = "Own name"\ndescription = "Own text"\ngamerscore = 5\nflags = 8\n',
        '[[achievements]]\nid = 40\nlabel = "Extra"\ndescription = "Added by the recompilation"\ngamerscore = 15\nflags = 8\n'
      ].join('\n')
    )
    await put(join(install, 'userdata', 'achievements', `${TID}.toml`), unlockFile())
    const { r } = reader()
    const info = await r.read(game(), RECOMP)
    // The game's three, the first replaced, plus the recompilation's own one; unlocks of every id count.
    expect(info).toMatchObject({ total: 4, unlocked: 2, points: { earned: 55, total: 95 } })
    expect(info?.list.map((a) => [a.id, a.name])).toEqual([
      ['1', 'Own name'],
      ['7', 'Secret Road'],
      ['12', 'Champion'],
      ['40', 'Extra']
    ])
    expect(info?.list[0]).toMatchObject({ unlockedAt: '2026-11-01T10:00:00.000Z' })
  })

  it('takes the achievements.toml alone when the game has no list, and finds it where the runtime looks', async () => {
    const toml = '[[achievements]]\nid = 3\nlabel = "Only"\ngamerscore = 10\nflags = 8\n'
    // Beside the install folder (the recompilations' shared folder): not this game's.
    await put(join(dir, 'Recompilations', 'metadata', 'achievements.toml'), toml)
    const { r } = reader()
    expect(await r.read(game(), RECOMP)).toBeNull()
    // In the install folder itself, without a metadata folder.
    await put(join(install, 'achievements.toml'), toml)
    expect((await r.read(game(), RECOMP))?.list.map((a) => a.name)).toEqual(['Only'])
    // Beside the game files picked outside the install folder: <folder>\metadata, then its parent's.
    const files = join(dir, 'picked', 'Game')
    await fs.mkdir(files, { recursive: true })
    await put(join(dir, 'picked', 'metadata', 'achievements.toml'), toml.replace('Only', 'Parent'))
    const { r: r2 } = reader({ gameFiles: [files] })
    expect((await r2.read(game(), RECOMP))?.list.map((a) => a.name)).toEqual(['Parent'])
    await put(join(files, 'metadata', 'achievements.toml'), toml.replace('Only', 'Own'))
    expect((await r2.read(game(), RECOMP))?.list.map((a) => a.name)).toEqual(['Own'])
  })

  it("skips another game's executable, and shows every achievement locked before the first unlock", async () => {
    const xex = await put(
      join(install, 'default.xex'),
      buildXex({ image: fakeImage(buildXdbf(ACHIEVEMENTS)), titleId: '11112222', compression: 1 })
    )
    const { r } = reader()
    expect(await r.read(game(), RECOMP)).toBeNull()
    await put(
      xex,
      buildXex({ image: fakeImage(buildXdbf(ACHIEVEMENTS)), titleId: TID, compression: 1 })
    )
    // The kept "none" is tried again because the file changed.
    await fs.utimes(xex, new Date('2026-01-01'), new Date('2026-01-02'))
    const info = await r.read(game(), RECOMP)
    expect(info).toMatchObject({ total: 3, unlocked: 0 })
    expect(info?.list.every((a) => !a.unlocked)).toBe(true)
  })

  it('counts the unlocks when the list cannot be read, and reads them fresh each time', async () => {
    const file = await put(
      join(ctx.folders.appData, 'Studio', 'Game', 'achievements', `${TID}.toml`),
      unlockFile()
    )
    const { r } = reader({ folder: null })
    expect(await r.read(game(), RECOMP)).toEqual({
      provider: 'recomp',
      total: 0,
      unlocked: 2,
      list: []
    })
    await fs.appendFile(file, `[unlocked.7]\nfiletime = ${ft('2026-11-05T00:00:00Z')}\n`)
    expect((await r.read(game(), RECOMP))?.unlocked).toBe(3)
  })

  it('returns null for a recompilation it cannot read achievements of', async () => {
    const { r, sourceFn } = reader()
    expect(await r.read(game(), 'github:other/recomp')).toBeNull()
    expect(sourceFn).toHaveBeenCalledWith('github:other/recomp')
    expect(await r.read(game(), RECOMP)).toBeNull()
  })
})

describe('the catalog folder', () => {
  it('is refused when it names a network share, another drive or a system folder', () => {
    expect(expandAchievementsFolder('\\\\attacker.example\\share\\game', ctx)).toBeNull()
    expect(expandAchievementsFolder('//attacker.example/share/game', ctx)).toBeNull()
    expect(expandAchievementsFolder('\\\\.\\C:\\game', ctx)).toBeNull()
    expect(isSafeUserRoot('\\\\?\\C:\\game', ctx)).toBe(false)
    expect(expandAchievementsFolder('C:\\Windows\\System32', ctx)).toBeNull()
    expect(expandAchievementsFolder('D:\\Games\\user', ctx)).toBeNull()
    // Climbing out of AppData to the profile itself, or above it.
    expect(expandAchievementsFolder('%APPDATA%\\..\\..', ctx)).toBeNull()
    expect(expandAchievementsFolder('%APPDATA%\\..\\..\\..\\other', ctx)).toBeNull()
    expect(isSafeUserRoot(ctx.folders.userProfile, ctx)).toBe(false)
  })

  it('is kept inside the install folder, the save places and below the profile', () => {
    expect(expandAchievementsFolder('{game}', ctx)).toBe(install)
    expect(expandAchievementsFolder('%USERPROFILE%\\Saved Games\\Studio\\content', ctx)).toBe(
      join(ctx.folders.userProfile, 'Saved Games', 'Studio', 'content')
    )
    expect(expandAchievementsFolder('%USERPROFILE%\\.local\\share\\game', ctx)).toBe(
      join(ctx.folders.userProfile, '.local', 'share', 'game')
    )
  })

  it('is never looked in when it names a network share', async () => {
    const stat = vi.spyOn(fs, 'stat')
    const readdir = vi.spyOn(fs, 'readdir')
    const share = '\\\\127.0.0.1\\nonexistent-share\\game'
    const { r } = reader({ folder: share, saveTemplates: [share] })
    expect(await r.read(game(), RECOMP)).toBeNull()
    const { r: noId } = reader({ titleId: null, folder: share })
    expect(await noId.read(game(), RECOMP)).toBeNull()
    const touched = [...stat.mock.calls, ...readdir.mock.calls].map((c) => String(c[0]))
    expect(touched.length).toBeGreaterThan(0)
    expect(touched.filter((p) => /^[\\/]{2}/.test(p))).toEqual([])
    stat.mockRestore()
    readdir.mockRestore()
  })
})

describe('what is kept between reads', () => {
  const xexReads = (spy: { mock: { calls: unknown[][] } }): number =>
    spy.mock.calls.filter((c) => /default\.xex$/i.test(String(c[0]))).length

  it('reads an executable with no achievement table once, until it changes', async () => {
    const noTable = fakeImage(Buffer.from('XDBX not an achievement table at all.....'))
    const xex = await put(
      join(install, 'default.xex'),
      buildXex({ image: noTable, titleId: TID, compression: 2 })
    )
    const readFile = vi.spyOn(fs, 'readFile')
    const { r } = reader()
    for (let i = 0; i < 3; i++) expect(await r.read(game(), RECOMP)).toBeNull()
    expect(xexReads(readFile)).toBe(1)
    // Kept on disk too: a new session does not read it again.
    const { r: next } = reader()
    expect(await next.read(game(), RECOMP)).toBeNull()
    expect(xexReads(readFile)).toBe(1)
    // A changed executable is read again.
    await put(
      xex,
      buildXex({ image: fakeImage(buildXdbf(ACHIEVEMENTS)), titleId: TID, compression: 2 })
    )
    await fs.utimes(xex, new Date('2026-01-01'), new Date('2026-01-02'))
    expect(await next.read(game(), RECOMP)).toMatchObject({ total: 3 })
    expect(xexReads(readFile)).toBe(2)
    readFile.mockRestore()
  })

  it("keeps the list of a recompilation the catalog gives no title id for, under the executable's", async () => {
    await put(
      join(install, 'default.xex'),
      buildXex({ image: fakeImage(buildXdbf(ACHIEVEMENTS)), titleId: TID, compression: 1 })
    )
    await put(join(install, 'userdata', 'achievements', `${TID}.toml`), unlockFile())
    const readFile = vi.spyOn(fs, 'readFile')
    const { r } = reader({ titleId: null })
    expect(await r.read(game(), RECOMP)).toMatchObject({ total: 3, unlocked: 2 })
    expect(await r.read(game(), RECOMP)).toMatchObject({ total: 3, unlocked: 2 })
    const { r: next } = reader({ titleId: null })
    expect(await next.read(game(), RECOMP)).toMatchObject({ total: 3, unlocked: 2 })
    expect(xexReads(readFile)).toBe(1)
    readFile.mockRestore()
  })

  it('looks for a missing unlock file again only after the recompilation is played', async () => {
    const { r } = reader({ folder: null })
    expect(await r.read(game(), RECOMP)).toBeNull()
    await put(join(ctx.folders.localAppData, 'Game', 'achievements', `${TID}.toml`), unlockFile())
    expect(await r.read(game(), RECOMP)).toBeNull()
    r.played(RECOMP)
    expect(await r.read(game(), RECOMP)).toMatchObject({ unlocked: 2 })
  })

  it('does not read an unlock file too big to be one', async () => {
    const big = `${unlockFile()}\n${'#'.repeat(2 * 1024 * 1024)}\n`
    await put(join(install, 'userdata', 'achievements', `${TID}.toml`), big)
    const { r } = reader()
    expect(await r.read(game(), RECOMP)).toBeNull()
  })
})

describe('languages', () => {
  it("shows the game's texts in the UI language when it has them", async () => {
    const spanish = (s: string): string => (s ? `ES ${s}` : s)
    await put(
      join(install, 'default.xex'),
      buildXex({
        image: fakeImage(buildXdbf(ACHIEVEMENTS, { other: { 5: spanish } })),
        titleId: TID,
        compression: 1
      })
    )
    const { r } = reader()
    expect((await r.read(game(), RECOMP))?.list[0]?.name).toBe('First Blood')
    language = 'es'
    expect((await r.read(game(), RECOMP))?.list[0]?.name).toBe('ES First Blood')
  })
})
