import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KnownFolders } from '../util/paths'
import { checkSaveFolder, refusePath, type SaveFolderRules } from './folders'

let root: string
let folders: KnownFolders
let rules: SaveFolderRules

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-pcsaves-folders-'))
  const profile = join(root, 'Users', 'me')
  folders = {
    userProfile: profile,
    appData: join(profile, 'AppData', 'Roaming'),
    localAppData: join(profile, 'AppData', 'Local'),
    programData: join(root, 'ProgramData'),
    programFiles: join(root, 'Program Files'),
    programFilesX86: join(root, 'Program Files (x86)'),
    publicDir: join(root, 'Users', 'Public'),
    systemDrive: root
  }
  rules = {
    folders,
    documents: join(profile, 'Documents'),
    install: join(root, 'Games', 'Hollow'),
    exePath: join(root, 'Games', 'Hollow', 'Hollow.exe'),
    own: [join(root, 'Emulation'), join(root, 'PlayOutData'), join(root, 'PlayOut', 'Emulators')],
    others: [{ title: 'Other Game', folder: join(folders.appData, 'Other', 'saves') }]
  }
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('refusePath', () => {
  it('accepts a game’s own save folder under AppData, Documents\\My Games or Saved Games', () => {
    for (const p of [
      join(folders.appData, 'Team Cherry', 'Hollow'),
      join(folders.localAppData, 'Hollow', 'Saved'),
      join(folders.userProfile, 'AppData', 'LocalLow', 'Team Cherry', 'Hollow'),
      join(rules.documents!, 'My Games', 'Hollow'),
      join(folders.userProfile, 'Saved Games', 'Hollow'),
      join(root, 'Games', 'Hollow', 'saves')
    ])
      expect(refusePath(p, rules)).toBeNull()
  })

  it('refuses the broad folders themselves and anything above them', () => {
    for (const p of [
      'C:\\',
      folders.userProfile,
      join(folders.userProfile, 'AppData'),
      folders.appData,
      folders.localAppData,
      join(folders.userProfile, 'AppData', 'LocalLow'),
      rules.documents!,
      join(rules.documents!, 'My Games'),
      join(folders.userProfile, 'Saved Games'),
      join(root, 'Users')
    ])
      expect(refusePath(p, rules), p).toMatch(/too broad/)
  })

  it('refuses a relative path, the game’s own folder, PlayOut’s folders and another game’s', () => {
    expect(refusePath('saves', rules)).toMatch(/whole folder path/)
    expect(refusePath(join(root, 'Games', 'Hollow'), rules)).toMatch(/too broad/)
    expect(refusePath(join(root, 'Games'), rules)).toMatch(/too broad/)
    const inBin = { ...rules, exePath: join(root, 'Games', 'Hollow', 'bin', 'Hollow.exe') }
    expect(refusePath(join(root, 'Games', 'Hollow', 'bin'), inBin)).toMatch(/holds the game/)
    expect(refusePath(join(root, 'Emulation', 'saves'), rules)).toMatch(/PlayOut’s own/)
    expect(refusePath(join(root, 'PlayOutData', 'x'), rules)).toMatch(/PlayOut’s own/)
    expect(refusePath(join(root, 'PlayOut'), rules)).toMatch(/PlayOut’s own/)
    expect(refusePath(join(folders.appData, 'Other', 'saves', 'slot1'), rules)).toMatch(
      /Other Game/
    )
    expect(refusePath(join(folders.appData, 'Other'), rules)).toMatch(/Other Game/)
  })
})

describe('checkSaveFolder', () => {
  it('measures a real folder', async () => {
    const dir = join(folders.appData, 'Hollow')
    await fs.mkdir(join(dir, 'slot'), { recursive: true })
    await fs.writeFile(join(dir, 'user1.dat'), 'abc')
    await fs.writeFile(join(dir, 'slot', 'user2.dat'), 'defg')
    const m = await checkSaveFolder(dir, rules)
    expect(m.files).toHaveLength(2)
    expect(m.bytes).toBe(7)
  })

  it('refuses a missing folder, a file, a junction and a folder holding programs', async () => {
    const dir = join(folders.appData, 'Hollow')
    await expect(checkSaveFolder(dir, rules)).rejects.toThrow(/is not a folder/)
    await fs.mkdir(folders.appData, { recursive: true })
    await fs.writeFile(dir, 'x')
    await expect(checkSaveFolder(dir, rules)).rejects.toThrow(/is not a folder/)
    await fs.rm(dir)
    const target = join(root, 'elsewhere')
    await fs.mkdir(target)
    await fs.symlink(target, dir, 'junction')
    await expect(checkSaveFolder(dir, rules)).rejects.toThrow(/link or junction/)
    // A folder reached through a junction above it.
    await fs.mkdir(join(target, 'saves'))
    await expect(checkSaveFolder(join(dir, 'saves'), rules)).rejects.toThrow(/link or junction/)
    const progs = join(folders.appData, 'Progs')
    await fs.mkdir(progs)
    await fs.writeFile(join(progs, 'save.dat'), 'x')
    await fs.writeFile(join(progs, 'steam_api64.dll'), 'x')
    await expect(checkSaveFolder(progs, rules)).rejects.toThrow(/holds programs/)
  })

  it('refuses a folder over 512 MB', async () => {
    const dir = join(folders.appData, 'Big')
    await fs.mkdir(dir, { recursive: true })
    const h = await fs.open(join(dir, 'world.dat'), 'w')
    await h.truncate(513 * 1024 * 1024)
    await h.close()
    await expect(checkSaveFolder(dir, rules)).rejects.toThrow(/513 MB, more than the 512 MB/)
  })
})

describe('refusePath: aliases and personal folders', () => {
  it('refuses network, device and stream paths (aliases the rules cannot see through)', () => {
    for (const p of [
      `\\\\?\\${join(folders.userProfile, 'Saved Games')}`,
      `\\\\.\\${join(folders.appData, 'Hollow')}`,
      '\\\\localhost\\C$\\Users\\me\\Documents\\My Games\\Hollow',
      '\\\\server\\share\\saves',
      '//server/share/saves',
      `${join(folders.userProfile, 'Saved Games')}::$INDEX_ALLOCATION`,
      `${join(folders.appData, 'Hollow')}:stream`
    ])
      expect(refusePath(p, rules), p).toMatch(/plain folder/)
  })

  it('refuses Desktop, Downloads, Pictures, Videos, Music, OneDrive, other profiles and folders below a drive root', () => {
    for (const p of [
      ...['Desktop', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'].map((n) =>
        join(folders.userProfile, n)
      ),
      join(root, 'Users', 'someone-else'),
      'D:\\Stuff',
      'E:\\'
    ])
      expect(refusePath(p, rules), p).toMatch(/too broad/)
    // A game's own folder inside them is fine.
    expect(refusePath(join(folders.userProfile, 'Desktop', 'Hollow', 'saves'), rules)).toBeNull()
    expect(refusePath(join(folders.userProfile, 'OneDrive', 'Hollow Saves'), rules)).toBeNull()
  })
})

describe('checkSaveFolder: links inside', () => {
  it('refuses a folder holding a junction, naming it', async () => {
    const dir = join(folders.appData, 'Hollow')
    await fs.mkdir(join(dir, 'slots'), { recursive: true })
    await fs.writeFile(join(dir, 'user1.dat'), 'abc')
    const target = join(root, 'OtherDrive', 'profile1')
    await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, join(dir, 'slots', 'profile1'), 'junction')
    await expect(checkSaveFolder(dir, rules)).rejects.toThrow(
      /link or junction \(slots[\\/]profile1\)/
    )
  })
})
