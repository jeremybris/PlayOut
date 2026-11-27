import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { filterFolders, gameFolderOf, MAX_FOLDERS, missingFoldersMessage } from './libraryFolders'

function game(id: string, over: Partial<Game>): Game {
  return {
    id,
    source: 'steam',
    title: id,
    installed: true,
    platformId: 'steam',
    externalId: id,
    metadata: {},
    media: {},
    user: {},
    ...over
  } as Game
}

describe('gameFolderOf', () => {
  it("is a store game's library folder, a ROM's system folder", () => {
    expect(
      gameFolderOf(
        game('steam:1', {
          installDir: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Celeste'
        })
      )
    ).toBe('C:\\Program Files (x86)\\Steam\\steamapps\\common')
    // An Xbox app game: <Game>\Content; its library is XboxGames.
    expect(
      gameFolderOf(game('xbox:1', { source: 'xbox', installDir: 'C:\\XboxGames\\Forza\\Content' }))
    ).toBe('C:\\XboxGames')
    expect(
      gameFolderOf(
        game('rom:1', {
          source: 'rom',
          externalId: 'xbox360/Halo 3/default.xex',
          romPath: 'D:\\ROMs\\xbox360\\Halo 3\\default.xex'
        })
      )
    ).toBe('D:\\ROMs\\xbox360')
    expect(
      gameFolderOf(
        game('rom:2', {
          source: 'rom',
          externalId: 'snes/Mario.sfc',
          romPath: 'D:/ROMs/snes/Mario.sfc'
        })
      )
    ).toBe('D:/ROMs/snes')
  })

  it('is nothing for a game not on this PC or in a protected Windows folder', () => {
    expect(gameFolderOf(game('steam:2', { installed: false }))).toBeNull()
    expect(
      gameFolderOf(game('remote:h:1', { remote: { hostId: 'h' } as never, installDir: 'C:\\A\\B' }))
    ).toBeNull()
    expect(
      gameFolderOf(
        game('xbox:2', {
          source: 'xbox',
          installDir: 'C:\\Program Files\\WindowsApps\\Game_1.0_x64__abc'
        })
      )
    ).toBeNull()
  })
})

describe('filterFolders', () => {
  it("opens each store's and system's folder once, the most games first, and a picked system's empty folder", () => {
    const games = [
      game('steam:1', { installDir: 'C:\\Steam\\steamapps\\common\\A' }),
      game('steam:2', { installDir: 'c:\\steam\\steamapps\\common\\B' }),
      game('xbox:1', { source: 'xbox', installDir: 'C:\\XboxGames\\X\\Content' }),
      game('rom:1', {
        source: 'rom',
        externalId: 'xbox/Halo.iso',
        romPath: 'D:\\ROMs\\xbox\\Halo.iso'
      })
    ]
    expect(filterFolders(games, ['xbox', 'gc'], 'D:\\ROMs\\')).toEqual({
      // Steam's folder holds two games; the picked GameCube system has none yet: last.
      folders: ['C:\\Steam\\steamapps\\common', 'C:\\XboxGames', 'D:\\ROMs\\xbox', 'D:\\ROMs\\gc'],
      more: 0
    })
  })

  it(`opens at most ${MAX_FOLDERS} folders and counts the rest`, () => {
    const games = Array.from({ length: 13 }, (_, i) =>
      game(`m:${i}`, { source: 'manual', installDir: `C:\\Games${i}\\Game` })
    )
    const { folders, more } = filterFolders(games, [], null)
    expect(folders).toHaveLength(MAX_FOLDERS)
    expect(more).toBe(3)
  })
})

describe('missingFoldersMessage', () => {
  const steam = game('steam:1', { installDir: 'D:\\SteamLibrary\\steamapps\\common\\A' })
  const oldRom = game('rom:1', {
    source: 'rom',
    externalId: 'snes/Mario.sfc',
    romPath: 'E:\\Old ROMs\\snes\\Mario.sfc'
  })
  const romsRoot = 'C:\\Emulation\\roms'

  it("gives a store's missing folder no Emulation-folder advice", () => {
    const text = missingFoldersMessage(['D:\\SteamLibrary\\steamapps\\common'], [steam], romsRoot)
    expect(text).toMatch(/^D:\\SteamLibrary\\steamapps\\common not found\./)
    expect(text).not.toMatch(/Emulation folder/)
    expect(text).toMatch(/store or launcher/)
  })

  it('points missing ROM folders (in the ROM folder, or a ROM game’s own) at the Emulation folder', () => {
    for (const missing of [['c:/emulation/roms/gc'], ['E:\\Old ROMs\\snes']]) {
      const text = missingFoldersMessage(missing, [steam, oldRom], romsRoot)
      expect(text).toMatch(/choose the Emulation folder/)
      expect(text).not.toMatch(/store or launcher/)
    }
    // Both kinds missing: both pieces of advice, and the count of the others.
    const both = missingFoldersMessage(
      ['C:\\Emulation\\roms\\snes', 'D:\\SteamLibrary\\steamapps\\common'],
      [steam],
      romsRoot
    )
    expect(both).toMatch(/^C:\\Emulation\\roms\\snes and 1 more not found\./)
    expect(both).toMatch(/Emulation folder.*store or launcher/)
    // A folder merely starting with the ROM folder's name is not in it.
    expect(missingFoldersMessage(['C:\\Emulation\\roms2'], [], romsRoot)).not.toMatch(
      /Emulation folder/
    )
  })
})
