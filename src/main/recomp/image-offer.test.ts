import { describe, expect, it } from 'vitest'
import type { GameFileState, InstalledRecomp } from '../../shared/recomp'
import type { Game } from '../../shared/types'
import {
  countStart,
  folderOfferKey,
  hasDiscImage,
  imageOfferKey,
  imageStays,
  isDiscImage,
  notePlayerExe,
  readsImageAtStart,
  unpackedFolderUse,
  type RecompDiskUse
} from './image-offer'

const rec = (over: Partial<InstalledRecomp> = {}): InstalledRecomp =>
  ({ id: 'github:a/b', dir: 'C:\\R\\b', exe: 'Game.exe', ...over }) as InstalledRecomp

const state = (over: Partial<GameFileState>): GameFileState =>
  ({
    id: 'game',
    label: 'Game',
    description: '',
    kind: 'game',
    how: 'flag',
    accepts: 'file',
    formats: [],
    optional: false,
    hashes: [],
    path: null,
    source: null,
    verified: null,
    ready: true,
    ...over
  }) as GameFileState

const game = (over: Partial<Game> = {}): Game =>
  ({
    id: 'rom:xbox360:x',
    source: 'rom',
    installed: true,
    romPath: 'D:\\ROMs\\xbox360\\Burnout Revenge (USA).iso',
    ...over
  }) as Game

describe('image offer: what is a disc image', () => {
  it('knows disc images and sheets, not cartridges', () => {
    for (const p of ['a.iso', 'b.CHD', 'c.cue', 'd.rvz', 'e.m3u', 'f.xiso', 'g.cso'])
      expect(isDiscImage(p)).toBe(true)
    for (const p of ['a.z64', 'b.sfc', 'c.md', 'eboot.bin', 'd.nsp'])
      expect(isDiscImage(p)).toBe(false)
  })

  it('asks only about a local, installed ROM card with its image still there', () => {
    expect(hasDiscImage(game())).toBe(true)
    expect(hasDiscImage(game({ remote: { hostId: 'h' } as never }))).toBe(false)
    expect(hasDiscImage(game({ id: 'remote:h:rom:x' }))).toBe(false)
    expect(hasDiscImage(game({ installed: false }))).toBe(false)
    expect(hasDiscImage(game({ source: 'steam' }))).toBe(false)
    expect(hasDiscImage(game({ romPath: 'D:\\ROMs\\n64\\mm.z64' }))).toBe(false)
    expect(
      hasDiscImage(
        game({ romPath: undefined, romRemoved: { at: '', recompId: 'x', romPath: 'a.iso' } })
      )
    ).toBe(false)
  })

  it('keys one question per recompilation and image, whatever the case and slashes', () => {
    expect(imageOfferKey('github:a/b', 'D:/ROMs/Game.ISO')).toBe(
      imageOfferKey('github:a/b', 'd:\\roms\\game.iso')
    )
    expect(imageOfferKey('github:a/b', 'x.iso')).not.toBe(imageOfferKey('github:a/c', 'x.iso'))
  })
})

describe('image offer: needs that read the image at every start', () => {
  const iso = 'D:\\ROMs\\game.iso'
  it('a flag, an environment variable or a copy into the folder reads it; the recomp asking itself does not', () => {
    expect(readsImageAtStart([state({ how: 'flag', path: iso })], [iso])).toBe(true)
    expect(readsImageAtStart([state({ how: 'env', env: 'GAME', path: iso })], [iso])).toBe(true)
    expect(readsImageAtStart([state({ how: 'folder', folder: 'game', path: iso })], [iso])).toBe(
      true
    )
    expect(readsImageAtStart([state({ how: 'self', path: iso })], [iso])).toBe(false)
    expect(readsImageAtStart([state({ how: 'flag', path: null })], [iso])).toBe(false)
    expect(readsImageAtStart([state({ how: 'flag', path: 'D:\\other.iso' })], [iso])).toBe(false)
  })

  it('any file of the set counts (a .cue track)', () => {
    const cue = 'D:\\ROMs\\game.cue'
    const bin = 'D:\\ROMs\\game (Track 1).bin'
    expect(readsImageAtStart([state({ how: 'flag', path: bin.toUpperCase() })], [cue, bin])).toBe(
      true
    )
  })

  it('a folder holding the image counts (a need that takes a folder); a folder beside it does not', () => {
    const iso = 'D:\\ROMs\\xbox360\\Game\\Game.iso'
    expect(
      readsImageAtStart(
        [state({ how: 'flag', accepts: 'either', path: 'D:\\ROMs\\xbox360\\Game\\' })],
        [iso]
      )
    ).toBe(true)
    expect(
      readsImageAtStart(
        [state({ how: 'folder', accepts: 'folder', path: 'd:/roms/xbox360' })],
        [iso]
      )
    ).toBe(true)
    expect(
      readsImageAtStart(
        [state({ how: 'flag', accepts: 'folder', path: 'D:\\ROMs\\xbox360\\Gam' })],
        [iso]
      )
    ).toBe(false)
  })

  it('the image stays while a game file the recompilation needs is not chosen', () => {
    const iso = 'D:\\ROMs\\game.iso'
    expect(imageStays([state({ how: 'flag', path: iso })], [iso])).toBe('reads')
    expect(imageStays([state({ how: 'flag', path: null, ready: false })], [iso])).toBe('not-ready')
    expect(
      imageStays([state({ how: 'flag', path: null, optional: true, ready: true })], [iso])
    ).toBeNull()
    expect(imageStays([state({ how: 'flag', path: 'D:\\own.z64' })], [iso])).toBeNull()
  })
})

describe('image offer: when to ask', () => {
  it('asks at the second successful start of PlayOut’s own pick, not at the first', () => {
    const r = rec()
    expect(countStart(r, 'C:\\R\\b\\Game.exe', false)).toBe(false)
    expect(r.exeIdentified).toEqual({ exe: 'c:\\r\\b\\game.exe', by: 'auto', starts: 1 })
    expect(countStart(r, 'C:\\R\\b\\Game.exe', false)).toBe(true)
    expect(r.exeIdentified?.starts).toBe(2)
  })

  it('starts counting again when the program changes', () => {
    const r = rec()
    countStart(r, 'C:\\R\\b\\Game.exe', false)
    expect(countStart(r, 'C:\\R\\b\\Other.exe', false)).toBe(false)
    expect(r.exeIdentified).toMatchObject({ exe: 'c:\\r\\b\\other.exe', starts: 1 })
    expect(countStart(r, 'C:\\R\\b\\Other.exe', false)).toBe(true)
  })

  it('a program the player picked or confirmed asks (also at its next start, for older picks)', () => {
    const r = rec()
    notePlayerExe(r, 'C:\\R\\b\\Game.exe')
    expect(r.exeIdentified).toEqual({ exe: 'c:\\r\\b\\game.exe', by: 'player', starts: 0 })
    // Confirmed by the player (Automatic): its starts ask (the question itself is asked once, by key).
    expect(countStart(r, 'C:\\R\\b\\Game.exe', false)).toBe(true)
    const old = rec()
    expect(countStart(old, 'D:\\Games\\Burnout\\Burnout.exe', true)).toBe(true)
    expect(old.exeIdentified).toMatchObject({ by: 'player', starts: 1 })
  })

  it('a player-confirmed program that is replaced by another automatically counts from one', () => {
    const r = rec()
    notePlayerExe(r, 'C:\\R\\b\\Game.exe')
    expect(countStart(r, 'C:\\R\\b\\New.exe', false)).toBe(false)
    expect(r.exeIdentified).toMatchObject({ by: 'auto', starts: 1 })
  })
})

describe('unpackedFolderUse', () => {
  const folder = 'C:\\Users\\me\\Games\\Burnout Revenge\\game'
  const use = (over: Partial<RecompDiskUse> = {}): RecompDiskUse => ({
    program: 'D:\\BR\\bin\\burnout.exe',
    cwd: 'D:\\BR\\bin',
    installDirs: ['C:\\PlayOut\\Recompilations\\Xerenge', 'C:\\PlayOut\\Recompilations'],
    gameFiles: [],
    ...over
  })

  it('lets the folder go when the game is installed elsewhere and uses nothing in or around it', () => {
    expect(unpackedFolderUse(folder, use())).toBeNull()
  })

  it('keeps it while the program is not identified', () => {
    expect(unpackedFolderUse(folder, use({ program: null }))).toMatch(/not identified/)
  })

  it("keeps it when the game is installed around it (Xerenge's <install>\\bin reads <install>\\game)", () => {
    const install = 'C:\\Users\\me\\Games\\Burnout Revenge'
    expect(
      unpackedFolderUse(
        folder,
        use({ program: install + '\\bin\\burnout.exe', cwd: install + '\\bin' })
      )
    ).toMatch(/installed around it/)
    expect(
      unpackedFolderUse(folder, use({ program: install + '\\burnout.exe', cwd: install }))
    ).toMatch(/installed around it/)
  })

  it('keeps it when the program is inside it or right above it', () => {
    expect(unpackedFolderUse(folder, use({ program: folder + '\\x\\game.exe' }))).toMatch(/in it/)
    expect(
      unpackedFolderUse(folder, use({ program: 'C:\\Users\\me\\game.exe', cwd: 'D:\\other' }))
    ).toMatch(/holds it/)
  })

  it('keeps it when the start folder, an install folder or a game file is in or around it', () => {
    expect(unpackedFolderUse(folder, use({ cwd: 'C:\\Users\\me' }))).toMatch(/started in/)
    expect(unpackedFolderUse(folder, use({ cwd: folder + '\\sub' }))).toMatch(/started in/)
    expect(unpackedFolderUse(folder, use({ installDirs: [folder + '\\Xerenge'] }))).toMatch(
      /installed in or around/
    )
    expect(unpackedFolderUse(folder, use({ installDirs: ['C:\\Users'] }))).toMatch(
      /installed in or around/
    )
    expect(unpackedFolderUse(folder, use({ gameFiles: [folder + '\\default.xex'] }))).toMatch(
      /game file/
    )
  })

  it('keys a folder-only question apart from an image question', () => {
    expect(folderOfferKey('github:shipa-2/xerenge', 'C:\\Games\\BR\\game\\')).toBe(
      'github:shipa-2/xerenge|folder|c:\\games\\br\\game'
    )
  })
})
