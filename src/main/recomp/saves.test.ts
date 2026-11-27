import { promises as fs, type Dirent } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledRecomp, RecompEntry } from '../../shared/recomp'
import type { KnownFolders } from '../util/paths'
import {
  detectSaveFolders,
  expandSavePaths,
  expandSaveTemplate,
  FIND_MAX_FILES,
  findSaveFolders,
  hashSaves,
  isPlausibleSaveFolder,
  isSafeSaveRoot,
  listSaveFiles,
  looksLikeSave,
  nameTokens,
  readDeveloperSaves,
  resolveSavePaths,
  snapshotSaveCandidates,
  toSaveTemplate,
  type SaveContext
} from './saves'

const PROFILE = 'C:\\Users\\Ann'
const FOLDERS: KnownFolders = {
  userProfile: PROFILE,
  appData: 'C:\\Users\\Ann\\AppData\\Roaming',
  localAppData: 'C:\\Users\\Ann\\AppData\\Local',
  programData: 'C:\\ProgramData',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  publicDir: 'C:\\Users\\Public',
  systemDrive: 'C:'
}
const CTX: SaveContext = { install: 'D:\\Games\\Recompilations\\Zelda64', folders: FOLDERS }

describe('expandSaveTemplate', () => {
  it('expands environment variables', () => {
    expect(expandSaveTemplate('%LOCALAPPDATA%\\Zelda64Recompiled\\saves', CTX)).toBe(
      'C:\\Users\\Ann\\AppData\\Local\\Zelda64Recompiled\\saves'
    )
    expect(expandSaveTemplate('%APPDATA%/sm64/saves/', CTX)).toBe(
      'C:\\Users\\Ann\\AppData\\Roaming\\sm64\\saves'
    )
    expect(expandSaveTemplate('%USERPROFILE%\\Saved Games\\X', CTX)).toBe(
      'C:\\Users\\Ann\\Saved Games\\X'
    )
    expect(expandSaveTemplate('%HOME%/X', CTX)).toBe('C:\\Users\\Ann\\X')
    expect(expandSaveTemplate('%Documents%/My Games/Foo', CTX)).toBe(
      'C:\\Users\\Ann\\Documents\\My Games\\Foo'
    )
    expect(expandSaveTemplate('$HOME/Foo', CTX)).toBe('C:\\Users\\Ann\\Foo')
  })

  it('expands RecompLauncher placeholders', () => {
    expect(expandSaveTemplate('{install}/saves', CTX)).toBe(
      'D:\\Games\\Recompilations\\Zelda64\\saves'
    )
    expect(expandSaveTemplate('{install}', CTX)).toBe('D:\\Games\\Recompilations\\Zelda64')
    expect(expandSaveTemplate('{local}/Zelda64Recompiled/saves', CTX)).toBe(
      'C:\\Users\\Ann\\AppData\\Local\\Zelda64Recompiled\\saves'
    )
    expect(expandSaveTemplate('{config}/X', CTX)).toBe('C:\\Users\\Ann\\AppData\\Roaming\\X')
    expect(expandSaveTemplate('{documents}/X', { ...CTX, documents: 'E:\\OneDrive\\Docs' })).toBe(
      'E:\\OneDrive\\Docs\\X'
    )
    expect(expandSaveTemplate('{home}/X', CTX)).toBe('C:\\Users\\Ann\\X')
    expect(expandSaveTemplate('{savedgames}/X', CTX)).toBe('C:\\Users\\Ann\\Saved Games\\X')
    expect(expandSaveTemplate('{LocalLow}/Dev/X', CTX)).toBe(
      'C:\\Users\\Ann\\AppData\\LocalLow\\Dev\\X'
    )
  })

  it('treats <game folder> and relative paths as inside the install', () => {
    expect(expandSaveTemplate('<game folder>/saves', CTX)).toBe(
      'D:\\Games\\Recompilations\\Zelda64\\saves'
    )
    expect(expandSaveTemplate('<install dir>\\save', CTX)).toBe(
      'D:\\Games\\Recompilations\\Zelda64\\save'
    )
    expect(expandSaveTemplate('saves', CTX)).toBe('D:\\Games\\Recompilations\\Zelda64\\saves')
    expect(expandSaveTemplate('./saves/slot', CTX)).toBe(
      'D:\\Games\\Recompilations\\Zelda64\\saves\\slot'
    )
    expect(expandSaveTemplate('C:\\Users\\<username>\\X', CTX)).toBe('C:\\Users\\Ann\\X')
    expect(expandSaveTemplate('~/X', CTX)).toBe('C:\\Users\\Ann\\X')
    expect(expandSaveTemplate('Documents/My Games/Foo', CTX)).toBe(
      'C:\\Users\\Ann\\Documents\\My Games\\Foo'
    )
    expect(expandSaveTemplate('AppData/Roaming/Foo', CTX)).toBe(
      'C:\\Users\\Ann\\AppData\\Roaming\\Foo'
    )
  })

  it('drops a trailing wildcard part', () => {
    expect(expandSaveTemplate('{install}/save/*.sav', CTX)).toBe(
      'D:\\Games\\Recompilations\\Zelda64\\save'
    )
    expect(expandSaveTemplate('*.sav', CTX)).toBeNull()
  })

  it('rejects prose, unknown variables, escapes and non-Windows paths', () => {
    expect(expandSaveTemplate('', CTX)).toBeNull()
    expect(expandSaveTemplate('In the same folder as the executable', CTX)).toBeNull()
    expect(expandSaveTemplate('%WEIRDVAR%/x', CTX)).toBeNull()
    expect(expandSaveTemplate('$XDG_DATA_HOME/x', CTX)).toBeNull()
    expect(expandSaveTemplate('{nope}/x', CTX)).toBeNull()
    expect(expandSaveTemplate('<some other thing>/x', CTX)).toBeNull()
    expect(expandSaveTemplate('../../Windows', CTX)).toBeNull()
    expect(expandSaveTemplate('{install}/../../x', CTX)).toBeNull()
    expect(expandSaveTemplate('/home/user/.local/share/x', CTX)).toBeNull()
    expect(expandSaveTemplate('foo/{install}/x', CTX)).toBeNull()
    expect(expandSaveTemplate('line one\nline two', CTX)).toBeNull()
  })

  it('keeps absolute Windows paths', () => {
    expect(expandSaveTemplate('E:\\Saves\\Game', CTX)).toBe('E:\\Saves\\Game')
  })
})

describe('toSaveTemplate', () => {
  it('uses the longest base and round-trips', () => {
    const cases: [string, string][] = [
      [
        'C:\\Users\\Ann\\AppData\\Local\\Zelda64Recompiled\\saves',
        '{local}/Zelda64Recompiled/saves'
      ],
      ['C:\\Users\\Ann\\AppData\\Roaming\\sm64', '{config}/sm64'],
      ['C:\\Users\\Ann\\Documents\\My Games\\X', '{documents}/My Games/X'],
      ['C:\\Users\\Ann\\Saved Games\\X', '{savedgames}/X'],
      ['C:\\Users\\Ann\\AppData\\LocalLow\\Dev\\X', '{locallow}/Dev/X'],
      ['C:\\Users\\Ann\\Elsewhere', '{home}/Elsewhere'],
      ['D:\\Games\\Recompilations\\Zelda64\\saves', '{install}/saves'],
      ['D:\\Games\\Recompilations\\Zelda64', '{install}'],
      ['E:\\Other\\Place', 'E:/Other/Place']
    ]
    for (const [real, template] of cases) {
      expect(toSaveTemplate(real, CTX)).toBe(template)
      expect(expandSaveTemplate(template, CTX)).toBe(real)
    }
  })

  it('prefers {install} when the install lives under AppData', () => {
    const ctx = { ...CTX, install: 'C:\\Users\\Ann\\AppData\\Roaming\\PlayOut\\Recompilations\\Z' }
    expect(
      toSaveTemplate('C:\\Users\\Ann\\AppData\\Roaming\\PlayOut\\Recompilations\\Z\\save', ctx)
    ).toBe('{install}/save')
  })

  it('is case-insensitive about the base', () => {
    expect(toSaveTemplate('c:\\users\\ann\\appdata\\local\\X', CTX)).toBe('{local}/X')
  })
})

describe('isSafeSaveRoot', () => {
  it('refuses broad folders and the install', () => {
    for (const p of [
      'C:\\',
      'D:\\',
      'C:\\Users',
      PROFILE,
      FOLDERS.appData,
      FOLDERS.localAppData,
      'C:\\Users\\Ann\\AppData',
      'C:\\Users\\Ann\\Documents',
      'C:\\Users\\Ann\\Documents\\My Games',
      'C:\\Users\\Ann\\Saved Games',
      'C:\\Program Files',
      CTX.install,
      'D:\\Games',
      'relative\\path'
    ]) {
      expect(isSafeSaveRoot(p, CTX), p).toBe(false)
    }
  })
  it('accepts a game folder', () => {
    expect(isSafeSaveRoot('C:\\Users\\Ann\\AppData\\Local\\Zelda64Recompiled', CTX)).toBe(true)
    expect(isSafeSaveRoot('D:\\Games\\Recompilations\\Zelda64\\saves', CTX)).toBe(true)
  })
})

describe('nameTokens / looksLikeSave', () => {
  it('skips generic words', () => {
    expect(nameTokens(['Zelda 64: Recompiled', "The Legend of Zelda: Majora's Mask"])).toEqual(
      ['thelegendofzeldamajorasmask', 'majoras', 'mask', 'zelda', 'zelda64recompiled'].sort()
    )
  })
  it('filters save-looking files', () => {
    expect(looksLikeSave('slot1.sav', 1000)).toBe(true)
    expect(looksLikeSave('save.bin', 1000)).toBe(true)
    expect(looksLikeSave('track.bin', 20 * 1024 * 1024)).toBe(false)
    expect(looksLikeSave('huge.sav', 65 * 1024 * 1024)).toBe(false)
    expect(looksLikeSave('settings.ini', 10)).toBe(false)
    expect(looksLikeSave('game.cfg', 10)).toBe(false)
    expect(looksLikeSave('log.txt', 10)).toBe(false)
    expect(looksLikeSave('crash-123.json', 10)).toBe(false)
    expect(looksLikeSave('x.exe', 10)).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------------------
// On disk

let tmp: string
let folders: KnownFolders
let install: string
let ctx: SaveContext

function entry(over: Partial<RecompEntry> = {}): RecompEntry {
  return {
    id: 'github:mr-wiseguy/zelda64recomp',
    name: 'Zelda 64: Recompiled',
    game: "The Legend of Zelda: Majora's Mask",
    systemId: 'n64',
    console: 'Nintendo 64',
    host: 'github',
    repo: 'Mr-Wiseguy/Zelda64Recomp',
    repoUrl: 'https://github.com/Mr-Wiseguy/Zelda64Recomp',
    author: 'Mr-Wiseguy',
    blurb: '',
    description: '',
    features: [],
    tags: [],
    latestTag: null,
    released: null,
    downloadBytes: null,
    stars: null,
    downloads: null,
    license: null,
    completeness: null,
    recommended: false,
    assetPattern: null,
    exe: null,
    installer: false,
    scannedSha256: null,
    needs: [],
    setupNotes: [],
    savePaths: [],
    iconUrl: null,
    coverUrl: null,
    heroUrl: null,
    archived: false,
    sources: ['decomp-buddy'],
    ...over
  }
}

function installed(over: Partial<InstalledRecomp> = {}): InstalledRecomp {
  return {
    id: 'github:mr-wiseguy/zelda64recomp',
    dir: install,
    tag: 'v1.2.0',
    asset: 'a.zip',
    downloadBytes: 1,
    diskBytes: null,
    sha256: '',
    verified: 'unverified',
    exe: 'Zelda64Recompiled.exe',
    installedAt: '',
    updatedAt: '',
    releaseFiles: ['zelda64recompiled.exe', 'assets/data.bin', 'readme.txt'],
    autoUpdate: false,
    gameFiles: {},
    savePaths: [],
    saveSource: null,
    cloud: {
      enabled: false,
      syncedHash: null,
      localHash: null,
      syncedAt: null,
      pending: false,
      error: null,
      conflict: null
    },
    prevTag: null,
    ...over
  }
}

async function write(p: string, content: string | Buffer = 'x'): Promise<void> {
  await fs.mkdir(join(p, '..'), { recursive: true })
  await fs.writeFile(p, content)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'playout-saves-'))
  const profile = join(tmp, 'Users', 'Ann')
  folders = {
    userProfile: profile,
    appData: join(profile, 'AppData', 'Roaming'),
    localAppData: join(profile, 'AppData', 'Local'),
    programData: join(tmp, 'ProgramData'),
    programFiles: join(tmp, 'Program Files'),
    programFilesX86: join(tmp, 'Program Files (x86)'),
    publicDir: join(tmp, 'Users', 'Public'),
    systemDrive: 'C:'
  }
  install = join(tmp, 'Recompilations', 'Zelda64')
  ctx = { install, folders }
  await fs.mkdir(install, { recursive: true })
  await write(join(install, 'Zelda64Recompiled.exe'), 'exe')
  await write(join(install, 'assets', 'data.bin'), 'data')
  await write(join(install, 'readme.txt'), 'hi')
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('snapshotSaveCandidates + detectSaveFolders', () => {
  it('finds a new save folder under AppData named like the game', async () => {
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'config.ini'), 'a')
    await write(join(folders.localAppData, 'SomethingElse', 'x.sav'), 'a')
    const before = await snapshotSaveCandidates(entry(), installed(), folders)
    expect(before.roots).toContain(join(folders.localAppData, 'Zelda64Recompiled'))
    expect(before.roots).not.toContain(join(folders.localAppData, 'SomethingElse'))
    // Play: a save appears, the config changes (not a save), an unrelated folder changes (not watched).
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'saves', 'file1.bin'), 'save')
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'config.ini'), 'b-changed')
    await write(join(folders.localAppData, 'SomethingElse', 'x.sav'), 'changed')
    const after = await snapshotSaveCandidates(entry(), installed(), folders)
    expect(detectSaveFolders(before, after, installed(), ctx)).toEqual([
      '{local}/Zelda64Recompiled'
    ])
  })

  it('finds a save in the install folder and ignores release files, mods, logs and program folders', async () => {
    const before = await snapshotSaveCandidates(entry(), installed(), folders)
    await write(join(install, 'saves', 'slot1.sav'), 'save')
    await write(join(install, 'assets', 'data.bin'), 'data-modified') // release file
    await write(join(install, 'mods', 'm.sav'), 'mod')
    await write(join(install, 'logs', 'today.dat'), 'log')
    await write(join(install, 'runtime', 'java.dll'), 'dll')
    await write(join(install, 'runtime', 'state.dat'), 'x')
    await write(join(install, 'top.sav'), 'x')
    const after = await snapshotSaveCandidates(entry(), installed(), folders)
    expect(detectSaveFolders(before, after, installed(), ctx)).toEqual([
      '{install}/saves',
      '{install}/top.sav'
    ])
  })

  it('finds nothing when nothing changed', async () => {
    await write(join(install, 'saves', 'slot1.sav'), 'save')
    const before = await snapshotSaveCandidates(entry(), installed(), folders)
    const after = await snapshotSaveCandidates(entry(), installed(), folders)
    expect(detectSaveFolders(before, after, installed(), ctx)).toEqual([])
  })

  it('looks in Documents/My Games and Saved Games', async () => {
    await fs.mkdir(join(folders.userProfile, 'Documents', 'My Games', 'MajorasMask'), {
      recursive: true
    })
    await fs.mkdir(join(folders.userProfile, 'Saved Games', 'Zelda64'), { recursive: true })
    const before = await snapshotSaveCandidates(entry(), installed(), folders)
    await write(join(folders.userProfile, 'Documents', 'My Games', 'MajorasMask', 'a.sav'), 'x')
    await write(join(folders.userProfile, 'Saved Games', 'Zelda64', 'b.sav'), 'x')
    const after = await snapshotSaveCandidates(entry(), installed(), folders)
    expect(detectSaveFolders(before, after, installed(), ctx)).toEqual([
      '{documents}/My Games/MajorasMask',
      '{savedgames}/Zelda64'
    ])
  })
})

describe('findSaveFolders', () => {
  const paths = async (exclude?: string[]): Promise<string[]> =>
    (await findSaveFolders(entry(), installed(), ctx, exclude ? { exclude } : {})).map(
      (f) => f.path
    )

  it('finds a folder named like the game that holds saves, in the usual places', async () => {
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'saves', 'file1.bin'), 'save')
    await write(join(folders.localAppData, 'SomethingElse', 'x.sav'), 'not this game')
    // Named like it but nothing save-like (only logs and pictures): not a save folder.
    await write(join(folders.appData, 'Zelda64', 'logs', 'today.log'), 'log')
    await write(join(folders.appData, 'Zelda64', 'shot.png'), 'png')
    expect(await paths()).toEqual([join(folders.localAppData, 'Zelda64Recompiled')])
  })

  it('looks into Documents, My Games, Saved Games, LocalLow (and its company folders) and the install', async () => {
    const docs = join(folders.userProfile, 'Documents')
    await write(join(docs, 'My Games', 'MajorasMask', 'a.sav'), 'x')
    await write(join(folders.userProfile, 'Saved Games', 'Zelda64', 'b.sav'), 'x')
    await write(join(folders.userProfile, 'AppData', 'LocalLow', 'Studio', 'Zelda64', 'c.dat'), 'x')
    await write(join(install, 'savedata', 'slot.sav'), 'x')
    expect((await paths()).sort()).toEqual(
      [
        join(docs, 'My Games', 'MajorasMask'),
        join(folders.userProfile, 'Saved Games', 'Zelda64'),
        join(folders.userProfile, 'AppData', 'LocalLow', 'Studio', 'Zelda64'),
        join(install, 'savedata')
      ].sort()
    )
  })

  it('names the best candidate first', async () => {
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'a.sav'), 'x')
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'b.sav'), 'x')
    await write(join(folders.userProfile, 'Saved Games', 'Zelda64', 'c.sav'), 'x')
    expect(await paths()).toEqual([
      join(folders.localAppData, 'Zelda64Recompiled'),
      join(folders.userProfile, 'Saved Games', 'Zelda64')
    ])
  })

  it('never offers program folders, release folders, other programs or excluded folders', async () => {
    // A program folder named like the game (another install).
    await write(join(folders.localAppData, 'Zelda64Launcher', 'tool.exe'), 'MZ')
    await write(join(folders.localAppData, 'Zelda64Launcher', 'state.dat'), 'x')
    // An install folder holding release files.
    await write(join(install, 'saves', 'slot.sav'), 'x')
    const rec = installed({ releaseFiles: ['zelda64recompiled.exe', 'saves/default.sav'] })
    // Another program's data named like the game.
    await write(join(folders.appData, 'Microsoft', 'x.sav'), 'x')
    // PlayOut's own folder (excluded by the caller).
    const own = join(folders.appData, 'Zelda64 Saves Copy')
    await write(join(own, 'a.sav'), 'x')
    const found = await findSaveFolders(entry(), rec, ctx, { exclude: [own] })
    expect(found).toEqual([])
  })

  it('marks only whole-name matches and install save folders as strong', async () => {
    // Named like the program / repository (whole name, or starting with it).
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'a.sav'), 'x')
    await write(join(folders.appData, 'Zelda64RecompData', 'b.sav'), 'x')
    // Sharing only a word with the game ("majoras", "zelda64" is the repo's word, not its whole name).
    await write(join(folders.appData, 'MajorasMaskFanGame', 'c.sav'), 'x')
    await write(join(folders.userProfile, 'Saved Games', 'Zelda64', 'd.sav'), 'x')
    await write(join(install, 'savedata', 'slot.sav'), 'x')
    const found = await findSaveFolders(entry(), installed(), ctx)
    const strong = Object.fromEntries(found.map((f) => [f.path, f.strong]))
    expect(strong).toEqual({
      [join(folders.localAppData, 'Zelda64Recompiled')]: true,
      [join(folders.appData, 'Zelda64RecompData')]: true,
      [join(folders.appData, 'MajorasMaskFanGame')]: false,
      [join(folders.userProfile, 'Saved Games', 'Zelda64')]: false,
      [join(install, 'savedata')]: true
    })
  })

  it('another game sharing a word (StardewValley for Star Fox 64) is found but never strong', async () => {
    await write(join(folders.appData, 'StardewValley', 'Saves', 'Farm_1', 'Farm_1'), 'x'.repeat(64))
    await write(join(folders.appData, 'StardewValley', 'Saves', 'Farm_1', 'x.sav'), 'x')
    const found = await findSaveFolders(
      entry({ name: 'Starship', game: 'Star Fox 64', repo: 'sonicdcer/Starship' }),
      installed({ exe: 'Starship.exe', releaseFiles: [] }),
      ctx
    )
    expect(found.map((f) => [f.path, f.strong])).toEqual([
      [join(folders.appData, 'StardewValley'), false]
    ])
  })

  it('skips a folder with too many files to be just saves', async () => {
    const big = join(folders.localAppData, 'Zelda64Recompiled')
    await fs.mkdir(big, { recursive: true })
    await Promise.all(
      Array.from({ length: FIND_MAX_FILES + 1 }, (_, i) => fs.writeFile(join(big, `${i}.sav`), 'x'))
    )
    expect(await paths()).toEqual([])
  })
})

describe('resolveSavePaths', () => {
  it("uses the user's folders first", async () => {
    await write(join(install, 'recomplauncher.json'), JSON.stringify({ saves: ['{install}/dev'] }))
    const r = await resolveSavePaths(
      entry({ savePaths: ['%LOCALAPPDATA%\\Zelda64Recompiled\\saves'] }),
      installed({ saveSource: 'user', savePaths: ['{install}/mine'] }),
      ctx
    )
    expect(r).toEqual({ paths: ['{install}/mine'], source: 'user' })
  })

  it('then the developer profile, then the catalog, then detected', async () => {
    const e = entry({
      savePaths: ['%LOCALAPPDATA%\\Zelda64Recompiled\\saves', 'prose that is not a path at all']
    })
    const detected = installed({ saveSource: 'detected', savePaths: ['{install}/found'] })
    expect(await resolveSavePaths(e, detected, ctx)).toEqual({
      paths: ['%LOCALAPPDATA%\\Zelda64Recompiled\\saves'],
      source: 'catalog'
    })
    await write(
      join(install, 'recomplauncher.json'),
      JSON.stringify({
        format: 1,
        saves: ['{local}/Zelda64Recompiled/saves', { path: '{install}/s2', platform: 'linux' }]
      })
    )
    expect(await resolveSavePaths(e, detected, ctx)).toEqual({
      paths: ['{local}/Zelda64Recompiled/saves'],
      source: 'developer'
    })
    await fs.rm(join(install, 'recomplauncher.json'))
    expect(await resolveSavePaths(entry(), detected, ctx)).toEqual({
      paths: ['{install}/found'],
      source: 'detected'
    })
    expect(await resolveSavePaths(entry(), installed(), ctx)).toEqual({ paths: [], source: null })
  })

  it('drops unsafe folders (the install itself, a known folder)', async () => {
    const r = await resolveSavePaths(
      entry({ savePaths: ['{install}', '%APPDATA%', '{local}/Zelda64Recompiled'] }),
      installed(),
      ctx
    )
    expect(r).toEqual({ paths: ['{local}/Zelda64Recompiled'], source: 'catalog' })
    expect(expandSavePaths(r.paths, ctx)).toEqual([join(folders.localAppData, 'Zelda64Recompiled')])
  })

  it('reads a corrupt developer profile as nothing', async () => {
    await write(join(install, 'recomplauncher.json'), '{nope')
    expect(await readDeveloperSaves(install)).toEqual([])
  })
})

describe('hashSaves', () => {
  it('is content-based, order-independent and null when empty', async () => {
    const a = join(tmp, 'a')
    const b = join(tmp, 'b')
    expect((await hashSaves([a])).hash).toBeNull()
    await write(join(a, 'x', 'one.sav'), '1')
    await write(join(a, 'two.sav'), '2')
    const h1 = await hashSaves([a])
    expect(h1.files.map((f) => f.rel)).toEqual(['two.sav', 'x/one.sav'])
    expect(h1.hash).toMatch(/^[0-9a-f]{64}$/)
    // Same content elsewhere, written in another order, later: same hash.
    await write(join(b, 'two.sav'), '2')
    await write(join(b, 'x', 'one.sav'), '1')
    expect((await hashSaves([b])).hash).toBe(h1.hash)
    // Content change → different; root index matters.
    await write(join(b, 'two.sav'), '3')
    expect((await hashSaves([b])).hash).not.toBe(h1.hash)
    expect((await hashSaves([join(tmp, 'none'), a])).hash).not.toBe(h1.hash)
  })

  it('accepts a single file as a root', async () => {
    const f = join(tmp, 'game.sav')
    await write(f, 'save')
    const h = await hashSaves([f])
    expect(h.files).toEqual([expect.objectContaining({ rel: 'game.sav', root: 0, size: 4 })])
  })
})

describe('isPlausibleSaveFolder', () => {
  it('accepts a named folder under the save places, or inside the install', () => {
    for (const p of [
      'C:\\Users\\Ann\\AppData\\Local\\Zelda64Recompiled\\saves',
      'C:\\Users\\Ann\\AppData\\Roaming\\SM64',
      'C:\\Users\\Ann\\AppData\\LocalLow\\Dev\\Game',
      'C:\\Users\\Ann\\Documents\\My Games\\Zelda',
      'C:\\Users\\Ann\\Documents\\Zelda',
      'C:\\Users\\Ann\\Saved Games\\Zelda',
      'D:\\Games\\Recompilations\\Zelda64\\saves'
    ]) {
      expect(isPlausibleSaveFolder(p, CTX), p).toBe(true)
    }
  })

  it('refuses dot-folders, the Start Menu, other programs, Windows and other places', () => {
    for (const p of [
      'C:\\Users\\Ann\\.ssh',
      'C:\\Users\\Ann\\.aws',
      'C:\\Users\\Ann\\Desktop',
      'C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
      'C:\\Users\\Ann\\AppData\\Local\\Google\\Chrome\\User Data',
      'C:\\Users\\Ann\\AppData\\Roaming\\PlayOut',
      'C:\\Users\\Ann\\AppData\\Local\\Game\\.secrets',
      'C:\\Windows\\Fonts',
      'E:\\Anything',
      '\\\\server\\share\\saves'
    ]) {
      expect(isPlausibleSaveFolder(p, CTX), p).toBe(false)
    }
  })
})

describe('save folders that would hold game data or private files', () => {
  it('detects a save next to release files as the narrowest folder without them (or the file)', async () => {
    const before = await snapshotSaveCandidates(entry(), installed(), folders)
    await write(join(install, 'assets', 'slot1.sav'), 'save') // assets/ ships data.bin
    await write(join(install, 'assets', 'saves', 'slot2.sav'), 'save')
    const after = await snapshotSaveCandidates(entry(), installed(), folders)
    expect(detectSaveFolders(before, after, installed(), ctx)).toEqual([
      '{install}/assets/saves',
      '{install}/assets/slot1.sav'
    ])
  })

  it('drops catalog and developer folders outside the save places or holding release files', async () => {
    const bad = [
      '~/.ssh',
      'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup',
      'C:\\Windows\\Fonts',
      '{config}/PlayOut',
      '{install}/assets',
      '{home}/Desktop'
    ]
    expect(await resolveSavePaths(entry({ savePaths: bad }), installed(), ctx)).toEqual({
      paths: [],
      source: null
    })
    const r = await resolveSavePaths(
      entry({ savePaths: [...bad, '{local}/Zelda64Recompiled/saves'] }),
      installed(),
      ctx
    )
    expect(r).toEqual({ paths: ['{local}/Zelda64Recompiled/saves'], source: 'catalog' })
    await write(join(install, 'recomplauncher.json'), JSON.stringify({ saves: bad }))
    expect((await resolveSavePaths(entry(), installed(), ctx)).source).toBeNull()
    // An older detection that picked a folder holding release files is not used either.
    const detected = installed({ saveSource: 'detected', savePaths: ['{install}/assets'] })
    expect(await resolveSavePaths(entry(), detected, ctx)).toEqual({ paths: [], source: null })
  })

  it("still honours the user's own folder choice", async () => {
    const r = await resolveSavePaths(
      entry(),
      installed({ saveSource: 'user', savePaths: ['{install}/assets'] }),
      ctx
    )
    expect(r).toEqual({ paths: ['{install}/assets'], source: 'user' })
  })
})

/**
 * Make fs.readdir report the entries named `names` as links, the way Windows lists OneDrive placeholders (cloud
 * files, hydrated or not): every reparse point is a link to readdir, while lstat shows the regular file or folder.
 */
function asPlaceholders(names: string[]): { mockRestore: () => void } {
  const real = fs.readdir.bind(fs) as (...a: unknown[]) => Promise<unknown>
  return vi.spyOn(fs, 'readdir').mockImplementation((async (p: unknown, opts?: unknown) => {
    const out = await real(p, opts)
    if (!(opts as { withFileTypes?: boolean } | undefined)?.withFileTypes) return out
    return (out as Dirent[]).map((e) =>
      names.includes(e.name)
        ? Object.assign(Object.create(Object.getPrototypeOf(e) as object) as Dirent, e, {
            isSymbolicLink: () => true,
            isFile: () => false,
            isDirectory: () => false
          })
        : e
    )
  }) as never)
}

describe('OneDrive placeholders (listed as links, regular files to lstat)', () => {
  it('listSaveFiles lists placeholder files and walks placeholder folders', async () => {
    const root = join(folders.localAppData, 'Zelda64Recompiled')
    await write(join(root, 'a.sav'), 'a')
    await write(join(root, 'slots', 'b.sav'), 'b')
    const spy = asPlaceholders(['a.sav', 'slots'])
    try {
      expect((await listSaveFiles([root])).map((f) => f.rel)).toEqual(['a.sav', 'slots/b.sav'])
    } finally {
      spy.mockRestore()
    }
  })

  it('listSaveFiles still skips real links (junctions)', async () => {
    const root = join(folders.localAppData, 'Zelda64Recompiled')
    await write(join(root, 'a.sav'), 'a')
    await write(join(tmp, 'elsewhere', 'big.dat'), 'x')
    await fs.symlink(join(tmp, 'elsewhere'), join(root, 'linked'), 'junction')
    expect((await listSaveFiles([root])).map((f) => f.rel)).toEqual(['a.sav'])
  })

  it('a session snapshot sees placeholder saves', async () => {
    await write(join(install, 'saves', 'slot1.sav'), 'save')
    const spy = asPlaceholders(['saves'])
    try {
      const snap = await snapshotSaveCandidates(entry(), installed(), folders)
      expect([...snap.files.keys()]).toContain(join(install, 'saves', 'slot1.sav'))
    } finally {
      spy.mockRestore()
    }
  })

  it('findSaveFolders finds a placeholder save folder and counts its placeholder saves', async () => {
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'saves', 'file1.bin'), 'save')
    const spy = asPlaceholders(['Zelda64Recompiled', 'saves', 'file1.bin'])
    try {
      expect(
        (await findSaveFolders(entry(), installed(), ctx)).map((f) => [f.path, f.saves])
      ).toEqual([[join(folders.localAppData, 'Zelda64Recompiled'), 1]])
    } finally {
      spy.mockRestore()
    }
  })

  it('a session snapshot walks a placeholder save folder under AppData', async () => {
    await write(join(folders.localAppData, 'Zelda64Recompiled', 'saves', 'file1.bin'), 'save')
    const spy = asPlaceholders(['Zelda64Recompiled'])
    try {
      const snap = await snapshotSaveCandidates(entry(), installed(), folders)
      expect(snap.roots).toContain(join(folders.localAppData, 'Zelda64Recompiled'))
    } finally {
      spy.mockRestore()
    }
  })
})
