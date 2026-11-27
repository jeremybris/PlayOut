import { describe, expect, it } from 'vitest'
import type { RecompTitle } from '@shared/recomp'
import type { Game, GameRecompInfo } from '@shared/types'
import {
  buildTitleIndex,
  defaultPreferred,
  mainTitle,
  matchGameToTitle,
  recompInfo,
  sameRecompInfo,
  stripEdition,
  systemGroup
} from './match'
import { titleKeyOf } from './titles'

function title(systemId: string, game: string, entries: string[] = [`id:${game}`]): RecompTitle {
  return { key: titleKeyOf(systemId, game), game, systemId, console: systemId, entries }
}

function catalogOf(...titles: RecompTitle[]): { titles: Map<string, RecompTitle> } {
  return { titles: new Map(titles.map((t) => [t.key, t])) }
}

type G = Parameters<typeof matchGameToTitle>[0]

function rom(platformId: string, title: string, extra: Partial<G> = {}): G {
  return { source: 'rom', platformId, title, metadata: {}, ...extra }
}

function pc(title: string, source: Game['source'] = 'steam'): G {
  return { source, platformId: source === 'manual' ? 'pc' : source, title, metadata: {} }
}

const CATALOG = catalogOf(
  title('n64', "The Legend of Zelda: Majora's Mask", [
    'github:zelda64recomp/zelda64recomp',
    'github:other/mm'
  ]),
  title('n64', 'The Legend of Zelda: Ocarina of Time'),
  title('n64', 'Super Mario 64'),
  title('n64', 'Star Fox 64'),
  title('n64', 'Mystical Ninja Starring Goemon (Nintendo 64)'),
  title('n64', 'Pokémon Snap'),
  title('xbox360', 'Sonic Unleashed'),
  title('psx', 'Castlevania: Symphony of the Night'),
  title('xbox360', 'Symphony of the Night'),
  title('xbox', '007: Agent Under Fire'),
  title('gc', 'Sonic Adventure DX: Director’s Cut'),
  title('pc', 'Diablo', ['github:diasurgical/devilutionx']),
  title('pc', 'Fallout 2'),
  title('pc', "Sid Meier's Civilization II"),
  title('pc', 'Plants vs. Zombies'),
  title('dos', 'Commander Keen'),
  title('other', 'Mercenaries: Playground of Destruction')
)
const INDEX = buildTitleIndex(CATALOG)

const match = (game: G): string | null => matchGameToTitle(game, CATALOG, INDEX)?.game ?? null

describe('systemGroup', () => {
  it('treats the same hardware under different ids as one', () => {
    expect(systemGroup('ps1')).toBe('psx')
    expect(systemGroup('x360')).toBe('xbox360')
    expect(systemGroup('ngc')).toBe('gc')
    expect(systemGroup('ds')).toBe('nds')
    expect(systemGroup('megadrive')).toBe('genesis')
    expect(systemGroup('n64')).toBe('n64')
    expect(systemGroup('dos')).toBe('pc')
    expect(systemGroup('windows9x')).toBe('pc')
  })
})

describe('ROM games', () => {
  it('matches a trimmed Xbox image (Trim Games, Convert) like its full dump', () => {
    const catalog = catalogOf(title('xbox', '007: From Russia with Love'))
    const index = buildTitleIndex(catalog)
    const xbox = (t: string, romPath?: string): string | null =>
      matchGameToTitle(rom('xbox', t, romPath ? { romPath } : {}), catalog, index)?.game ?? null
    const file = 'C:/ROMs/xbox/007 - From Russia with Love (USA).xiso.iso'
    expect(xbox('007 - From Russia with Love', file)).toBe('007: From Russia with Love')
    // A record still titled by the old scan: its file's name matches.
    expect(xbox('007 - From Russia with Love.xiso', file)).toBe('007: From Russia with Love')
    expect(xbox('Bond', 'C:/ROMs/xbox/007 - From Russia with Love (trimmed).XISO.iso')).toBe(
      '007: From Russia with Love'
    )
  })

  it('matches a trimmed Xbox 360 image the same way', () => {
    const catalog = catalogOf(title('xbox360', 'Halo 3'))
    const index = buildTitleIndex(catalog)
    const x360 = (t: string, romPath: string): string | null =>
      matchGameToTitle(rom('xbox360', t, { romPath }), catalog, index)?.game ?? null
    const file = 'C:/ROMs/xbox360/Halo 3 (USA).xiso.iso'
    expect(x360('Halo 3', file)).toBe('Halo 3')
    expect(x360('Halo 3.xiso', file)).toBe('Halo 3')
  })

  it('matches No-Intro names with region and revision tags', () => {
    expect(match(rom('n64', 'Super Mario 64 (USA)'))).toBe('Super Mario 64')
    expect(match(rom('n64', 'Star Fox 64 (USA) (Rev 1)'))).toBe('Star Fox 64')
    expect(match(rom('n64', 'Pokemon Snap (USA) [!]'))).toBe('Pokémon Snap')
    expect(match(rom('n64', 'Mystical Ninja Starring Goemon (USA)'))).toBe(
      'Mystical Ninja Starring Goemon (Nintendo 64)'
    )
  })

  it('handles ", The" moved to the end', () => {
    expect(match(rom('n64', "Legend of Zelda, The - Majora's Mask (USA)"))).toBe(
      "The Legend of Zelda: Majora's Mask"
    )
    expect(match(rom('n64', "The Legend of Zelda - Majora's Mask"))).toBe(
      "The Legend of Zelda: Majora's Mask"
    )
  })

  it('matches on the system only', () => {
    expect(match(rom('psx', 'Super Mario 64 (USA)'))).toBeNull()
    expect(match(rom('xbox360', 'Sonic Unleashed (USA, Europe) (En,Ja,Fr,De,Es,It)'))).toBe(
      'Sonic Unleashed'
    )
    expect(match(rom('n64', 'Sonic Unleashed'))).toBeNull()
    // The same name on two systems is two games.
    expect(match(rom('psx', 'Castlevania - Symphony of the Night (USA)'))).toBe(
      'Castlevania: Symphony of the Night'
    )
    expect(match(rom('xbox360', 'Castlevania - Symphony of the Night'))).toBeNull()
    expect(match(rom('xbox360', 'Symphony of the Night'))).toBe('Symphony of the Night')
  })

  it('accepts aliased system ids', () => {
    expect(match(rom('ps1', 'Castlevania - Symphony of the Night (USA)'))).toBe(
      'Castlevania: Symphony of the Night'
    )
    expect(match(rom('x360', 'Sonic Unleashed'))).toBe('Sonic Unleashed')
    const aliased = catalogOf(title('ps1', 'Silent Hill'), title('megadrive', 'Sonic the Hedgehog'))
    const index = buildTitleIndex(aliased)
    expect(matchGameToTitle(rom('psx', 'Silent Hill (USA)'), aliased, index)?.game).toBe(
      'Silent Hill'
    )
    expect(
      matchGameToTitle(rom('genesis', 'Sonic The Hedgehog (USA, Europe)'), aliased, index)?.game
    ).toBe('Sonic the Hedgehog')
  })

  it('matches "007 - Agent Under Fire" to "007: Agent Under Fire"', () => {
    expect(match(rom('xbox', '007 - Agent Under Fire (USA)'))).toBe('007: Agent Under Fire')
  })

  it('uses the subtitle rule only when one title fits', () => {
    // The catalog's name adds a subtitle; only one GameCube title starts with "Sonic Adventure DX".
    expect(match(rom('gc', 'Sonic Adventure DX (USA)'))).toBe('Sonic Adventure DX: Director’s Cut')
    // "Legend of Zelda, The" is the base of two N64 titles: no guess.
    expect(match(rom('n64', 'Legend of Zelda, The (USA)'))).toBeNull()
    // The ROM's name adds a subtitle the catalog lacks.
    expect(match(rom('n64', 'Super Mario 64 - Shindou Edition'))).toBe('Super Mario 64')
    // Both sides with different subtitles never match.
    expect(match(rom('xbox', '007 - Nightfire (USA)'))).toBeNull()
  })

  it('is never fuzzy', () => {
    expect(match(rom('n64', 'Super Mario 64 DS'))).toBeNull()
    expect(match(rom('n64', 'Star Fox'))).toBeNull()
    expect(match(rom('n64', 'Mario 64'))).toBeNull()
  })

  it('falls back to the user override and the ROM file name', () => {
    expect(
      match(rom('n64', 'Zelda MM', { user: { titleOverride: "Legend of Zelda: Majora's Mask" } }))
    ).toBe("The Legend of Zelda: Majora's Mask")
    expect(
      match(
        rom('n64', 'Some scraped name', { romPath: 'D:\\ROMs\\n64\\Star Fox 64 (USA) (Rev 1).z64' })
      )
    ).toBe('Star Fox 64')
  })

  it('never matches catalog titles of unknown systems', () => {
    expect(match(rom('other', 'Mercenaries - Playground of Destruction'))).toBeNull()
    expect(match(rom('ps2', 'Mercenaries - Playground of Destruction (USA)'))).toBeNull()
  })

  it('ignores systems without any recompilation', () => {
    expect(match(rom('snes', 'Super Mario World (USA)'))).toBeNull()
  })
})

describe('PC games', () => {
  it('matches source ports of PC originals by name', () => {
    expect(match(pc('Diablo', 'gog'))).toBe('Diablo')
    expect(match(pc('Diablo', 'manual'))).toBe('Diablo')
    expect(match(pc('DIABLO™'))).toBe('Diablo')
  })

  it('matches MS-DOS originals too', () => {
    expect(match(pc('Commander Keen', 'gog'))).toBe('Commander Keen')
    expect(match(rom('dos', 'Commander Keen'))).toBe('Commander Keen')
  })

  it('drops store edition words on either side', () => {
    expect(match(pc('Diablo + Hellfire'))).toBeNull()
    expect(match(pc('Plants vs. Zombies GOTY Edition'))).toBe('Plants vs. Zombies')
    expect(match(pc('Plants vs. Zombies: Game of the Year Edition'))).toBe('Plants vs. Zombies')
    expect(match(pc('Diablo Gold'))).toBe('Diablo')
    const goty = catalogOf(title('pc', 'Fallout 3 Game of the Year Edition'))
    expect(matchGameToTitle(pc('Fallout 3'), goty, buildTitleIndex(goty))?.game).toBe(
      'Fallout 3 Game of the Year Edition'
    )
  })

  it('accepts a subtitle the catalog lacks, and a possessive in front', () => {
    expect(match(pc('Fallout 2: A Post Nuclear Role Playing Game'))).toBe('Fallout 2')
    expect(match(pc('Civilization II'))).toBe("Sid Meier's Civilization II")
    expect(match(pc('Fallout'))).toBeNull()
  })

  it('does not match console titles to PC games', () => {
    expect(match(pc('Super Mario 64'))).toBeNull()
    expect(match(pc('Sonic Unleashed'))).toBeNull()
  })
})

describe('helpers', () => {
  it('stripEdition', () => {
    expect(stripEdition('Diablo Gold')).toBe('Diablo')
    expect(stripEdition('Doom Classic')).toBe('Doom')
    expect(stripEdition('Some Game Steam Edition')).toBe('Some Game')
    expect(stripEdition('Gold')).toBeNull()
    expect(stripEdition('Golden Sun')).toBeNull()
    expect(stripEdition('Diablo')).toBeNull()
  })

  it('mainTitle', () => {
    expect(mainTitle("Legend of Zelda, The - Majora's Mask")).toBe('legendofzelda')
    expect(mainTitle('Spider-Man')).toBeNull()
    expect(mainTitle('X: The Game')).toBeNull()
    expect(mainTitle('Super Mario 64')).toBeNull()
  })
})

describe('preferred version and recomp info', () => {
  const mm = title('n64', "The Legend of Zelda: Majora's Mask", ['a', 'b', 'c'])

  it('defaultPreferred: the choice, else an installed one in title order, else the first', () => {
    expect(defaultPreferred(mm, [], 'b')).toBe('b')
    expect(defaultPreferred(mm, ['c'], 'gone')).toBe('c')
    expect(defaultPreferred(mm, ['c', 'b'], null)).toBe('b')
    expect(defaultPreferred(mm, [], null)).toBe('a')
    expect(defaultPreferred({ ...mm, entries: [] }, [], null)).toBe('')
  })

  it('recompInfo lists only this title’s installed entries', () => {
    const info = recompInfo(mm, ['other-game', 'c', 'a'], null, '2026-11-14T00:00:00.000Z')
    expect(info).toEqual<GameRecompInfo>({
      titleKey: mm.key,
      count: 3,
      installed: ['a', 'c'],
      preferred: 'a',
      updatedAt: '2026-11-14T00:00:00.000Z'
    })
  })

  it('sameRecompInfo ignores updatedAt only', () => {
    const a = recompInfo(mm, ['a'], 'b', '2026-01-01T00:00:00.000Z')
    expect(sameRecompInfo(a, recompInfo(mm, ['a'], 'b', '2026-11-14T00:00:00.000Z'))).toBe(true)
    expect(sameRecompInfo(undefined, a)).toBe(false)
    expect(sameRecompInfo(a, recompInfo(mm, ['a', 'b'], 'b', 'x'))).toBe(false)
    expect(sameRecompInfo(a, recompInfo(mm, ['a'], 'c', 'x'))).toBe(false)
    expect(sameRecompInfo(a, recompInfo({ ...mm, entries: ['a', 'b'] }, ['a'], 'b', 'x'))).toBe(
      false
    )
    expect(sameRecompInfo(a, { ...a, titleKey: 'n64:other' })).toBe(false)
  })
})

describe('false friends', () => {
  const cat = catalogOf(
    title('pc', 'Call of Duty'),
    title('dos', 'Grand Theft Auto'),
    title('pc', 'Tomb Raider'),
    title('pc', 'DOOM'),
    title('dos', 'Fallout'),
    title('pc', 'Fallout 2'),
    title('dos', 'Heretic'),
    title('pc', 'Minecraft Classic (CrossCraft Classic Client)'),
    title('pc', 'RuneScape Classic'),
    title('pc', 'Spelunky Classic'),
    title('pc', 'Diablo'),
    title('pc', "Rodent's Revenge (Open Rodent's Revenge)"),
    title('pc', "Chip's Challenge"),
    title('pc', "Sid Meier's Civilization II"),
    title('pc', 'Fallout 3 Game of the Year Edition'),
    title('pc', 'Prey (2006)'),
    title('gba', 'Pokemon Emerald'),
    title('gba', 'Pokémon FireRed'),
    title('nds', 'Pokémon Platinum Version'),
    title('arcade', 'SpikeOut: Final Edition'),
    title('neogeo', "The King of Fighters '98"),
    title('dos', 'Commander Keen')
  )
  const idx = buildTitleIndex(cat)
  const m = (game: G): string | null => matchGameToTitle(game, cat, idx)?.game ?? null

  it('never takes a PC sequel or spin-off for the series’ first game', () => {
    expect(m(pc('Call of Duty: Black Ops'))).toBeNull()
    expect(m(pc('Call of Duty: World at War'))).toBeNull()
    expect(m(pc('Grand Theft Auto: Vice City'))).toBeNull()
    expect(m(pc('Tomb Raider: Legend'))).toBeNull()
    expect(m(pc('DOOM: The Dark Ages'))).toBeNull()
    expect(m(pc('Fallout: London'))).toBeNull()
    // A store tagline on the same game still matches.
    expect(m(pc('Fallout 2: A Post Nuclear Role Playing Game', 'gog'))).toBe('Fallout 2')
    expect(m(pc('Heretic: Shadow of the Serpent Riders'))).toBe('Heretic')
    expect(m(pc('DOOM'))).toBe('DOOM')
  })

  it("drops edition words only from the library's name, but store editions from both", () => {
    expect(m(pc('Minecraft'))).toBeNull()
    expect(m(pc('RuneScape'))).toBeNull()
    expect(m(pc('Spelunky'))).toBeNull()
    expect(m(pc('Diablo Gold'))).toBe('Diablo')
    expect(m(pc('Fallout 3'))).toBe('Fallout 3 Game of the Year Edition')
  })

  it("drops only a publisher's or designer's possessive", () => {
    expect(m(pc("Montezuma's Revenge", 'gog'))).toBeNull()
    expect(m(pc("Hunter's Challenge"))).toBeNull()
    expect(m(pc('Civilization II'))).toBe("Sid Meier's Civilization II")
  })

  it('keeps a year in the name, but not a TOSEC year tag', () => {
    expect(m(pc('Prey'))).toBeNull()
    expect(m(pc('Prey (2006)', 'gog'))).toBe('Prey (2006)')
    expect(m(rom('dos', 'Commander Keen (1990)(Apogee)'))).toBe('Commander Keen')
  })

  it('matches No-Intro "Version" names', () => {
    expect(m(rom('gba', 'Pokemon - Emerald Version (USA, Europe)'))).toBe('Pokemon Emerald')
    expect(m(rom('gba', 'Pokemon - FireRed Version (USA, Europe) (Rev 1)'))).toBe('Pokémon FireRed')
    expect(m(rom('nds', 'Pokemon - Platinum Version (USA)'))).toBe('Pokémon Platinum Version')
    expect(m(rom('nds', 'Pokemon Platinum'))).toBe('Pokémon Platinum Version')
  })

  it('treats every arcade board as arcade', () => {
    expect(systemGroup('model3')).toBe('arcade')
    expect(systemGroup('neogeo')).toBe('arcade')
    expect(m(rom('model3', 'SpikeOut: Final Edition'))).toBe('SpikeOut: Final Edition')
    expect(m(rom('mame', "King of Fighters '98, The"))).toBe("The King of Fighters '98")
    expect(m(rom('neogeo', "The King of Fighters '98 (NGM-2420)"))).toBe("The King of Fighters '98")
  })
})

describe("a title's other names (RecompTitle.aliases)", () => {
  const philosopher: RecompTitle = {
    ...title('xbox', "Harry Potter and the Philosopher's Stone"),
    aliases: ["Harry Potter and the Sorcerer's Stone"]
  }

  it("finds a console game under another region's name, on that console only", () => {
    const catalog = catalogOf(philosopher)
    const index = buildTitleIndex(catalog)
    const m = (g: G): string | null => matchGameToTitle(g, catalog, index)?.game ?? null
    const file = "C:/ROMs/xbox/Harry Potter and the Sorcerer's Stone (USA) (En,Es).xiso.iso"
    expect(m(rom('xbox', "Harry Potter and the Sorcerer's Stone", { romPath: file }))).toBe(
      "Harry Potter and the Philosopher's Stone"
    )
    expect(m(rom('xbox', "Harry Potter and the Philosopher's Stone"))).toBe(
      "Harry Potter and the Philosopher's Stone"
    )
    // The PlayStation 2 and PC games of that name are other games.
    expect(m(rom('ps2', "Harry Potter and the Sorcerer's Stone"))).toBeNull()
    expect(m(pc("Harry Potter and the Sorcerer's Stone"))).toBeNull()
  })

  it("lets a title's own name win over another title's alias", () => {
    const sorcerer = title('xbox', "Harry Potter and the Sorcerer's Stone")
    for (const titles of [
      [philosopher, sorcerer],
      [sorcerer, philosopher]
    ]) {
      const catalog = catalogOf(...titles)
      const index = buildTitleIndex(catalog)
      expect(
        matchGameToTitle(rom('xbox', "Harry Potter and the Sorcerer's Stone"), catalog, index)?.key
      ).toBe(sorcerer.key)
    }
  })

  it("lets a title's Version-less name win over an earlier title's alias", () => {
    const both: RecompTitle = {
      ...title('nds', 'Pokemon Black / Pokemon White'),
      aliases: ['Pokémon Black Version']
    }
    const black = title('nds', 'Pokémon Black Version')
    const catalog = catalogOf(both, black)
    const index = buildTitleIndex(catalog)
    expect(matchGameToTitle(rom('nds', 'Pokemon Black'), catalog, index)?.key).toBe(black.key)
  })

  it('ignores the aliases of a PC title', () => {
    const catalog = catalogOf({ ...title('pc', 'Prey (2006)'), aliases: ['Prey'] })
    const index = buildTitleIndex(catalog)
    expect(matchGameToTitle(pc('Prey'), catalog, index)).toBeNull()
    expect(matchGameToTitle(rom('windows', 'Prey'), catalog, index)).toBeNull()
  })
})
