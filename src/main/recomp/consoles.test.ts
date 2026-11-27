import { describe, expect, it } from 'vitest'
import { originDisplayName, systemIdForConsole } from './consoles'

const id = (text: string): string | null => systemIdForConsole(text)?.systemId ?? null

describe('systemIdForConsole', () => {
  it.each([
    // decomp-buddy's free text (real spellings from plans.json / finds.json)
    ['Nintendo 64', 'n64'],
    ['N64', 'n64'],
    ['Sony PlayStation', 'psx'],
    ['PlayStation', 'psx'],
    ['PlayStation 1', 'psx'],
    ['PS1', 'psx'],
    ['Sony PlayStation (Steam remaster: Chrono Cross: The Radical Dreamers Edition)', 'psx'],
    ['PlayStation 2', 'ps2'],
    ['Sony PlayStation 3', 'ps3'],
    ['Sony PlayStation 4', 'ps4'],
    ['Sony PlayStation 5', 'ps5'],
    ['Sony PlayStation Portable', 'psp'],
    ['Sony PSP', 'psp'],
    ['Xbox 360', 'xbox360'],
    ['Microsoft Xbox 360 (Xbox Live Arcade)', 'xbox360'],
    ['Xbox 360 (XBLA)', 'xbox360'],
    ['Xbox 360 / Sony PlayStation 3', 'xbox360'],
    ['PlayStation 3 / Xbox 360', 'ps3'],
    ['Microsoft Xbox', 'xbox'],
    ['Xbox', 'xbox'],
    ['Xbox One', 'xboxone'],
    ['Nintendo GameCube', 'gc'],
    ['GameCube', 'gc'],
    ['Nintendo Wii (WiiWare)', 'wii'],
    ['Nintendo Wii U', 'wiiu'],
    ['SNES', 'snes'],
    ['Super Nintendo', 'snes'],
    ['Super Nintendo Entertainment System', 'snes'],
    ['Super Famicom', 'snes'],
    ['Nintendo Entertainment System', 'nes'],
    ['NES', 'nes'],
    ['Famicom Disk System', 'fds'],
    ['Game Boy Advance', 'gba'],
    ['Nintendo Game Boy Color', 'gbc'],
    ['Nintendo Game Boy / Game Boy Color', 'gb'],
    ['Nintendo DS', 'nds'],
    ['Nintendo 3DS', 'n3ds'],
    ['Nintendo Switch', 'switch'],
    ['Nintendo Switch 2', 'switch2'],
    ['Nintendo Virtual Boy', 'virtualboy'],
    ['Sega Dreamcast', 'dreamcast'],
    ['Dreamcast', 'dreamcast'],
    ['Sega Saturn', 'saturn'],
    ['Saturn', 'saturn'],
    ['Genesis', 'genesis'],
    ['Mega Drive', 'genesis'],
    ['Sega Mega Drive / Genesis', 'genesis'],
    ['Sega 32X', 'sega32x'],
    ['Sega Mega-CD / Sega CD', 'segacd'],
    ['Sega Game Gear', 'gamegear'],
    ['Sega Master System', 'mastersystem'],
    ['Arcade', 'arcade'],
    ['Sega OutRun arcade', 'arcade'],
    ['Atari Star Wars arcade (1983)', 'arcade'],
    ['Capcom CP System II (arcade)', 'cps2'],
    ['Capcom CPS-2 arcade', 'cps2'],
    ['SNK Neo Geo MVS (arcade)', 'neogeo'],
    ['Sega Model 2C Arcade / Windows PC (1998)', 'model2'],
    ['Namco Triforce arcade system board', 'triforce'],
    ['Philips CD-i', 'cdimono1'],
    ['Commodore Amiga / PC (MS-DOS)', 'amiga'],
    ['Commodore Amiga CD32 / MS-DOS', 'amigacd32'],
    ['NEC PC-9801', 'pc98'],
    ['Apple Macintosh (classic Mac OS)', 'macintosh'],
    // PCs: Windows originals are 'pc', DOS ones 'dos'
    ['PC (Windows)', 'pc'],
    ['Microsoft Windows (16-bit)', 'pc'],
    ['Windows PC (Steam release)', 'pc'],
    ['PC (Windows) / Sony PlayStation', 'pc'],
    ['Personal Computer', 'pc'],
    ['PC (MS-DOS)', 'dos'],
    ['IBM PC (MS-DOS)', 'dos'],
    ['MS-DOS', 'dos'],
    ['PC (MS-DOS / Windows)', 'dos'],
    ['PC (DOS, Windows, Macintosh)', 'dos'],
    ['IBM PC (CGA)', 'dos'],
    ['Multiple (PC DOS, Atari ST, Amiga, FM Towns)', 'dos'],
    // RecompLauncher origin codes
    ['n64', 'n64'],
    ['x360', 'xbox360'],
    ['xbox', 'xbox'],
    ['ps1', 'psx'],
    ['ps2', 'ps2'],
    ['ps3', 'ps3'],
    ['ps4', 'ps4'],
    ['ps5', 'ps5'],
    ['gc', 'gc'],
    ['wii', 'wii'],
    ['wiiu', 'wiiu'],
    ['snes', 'snes'],
    ['gba', 'gba'],
    ['gb', 'gb'],
    ['gbc', 'gbc'],
    ['ds', 'nds'],
    ['3ds', 'n3ds'],
    ['dc', 'dreamcast'],
    ['saturn', 'saturn'],
    ['psp', 'psp'],
    ['switch', 'switch'],
    ['switch2', 'switch2'],
    ['nes', 'nes'],
    ['vb', 'virtualboy'],
    ['genesis', 'genesis'],
    ['s32x', 'sega32x'],
    ['gg', 'gamegear'],
    ['arcade', 'arcade'],
    ['cdi', 'cdimono1'],
    ['amiga', 'amiga'],
    ['pc', 'pc']
  ])('%s → %s', (text, expected) => {
    expect(id(text)).toBe(expected)
  })

  it.each([
    'other',
    'Others',
    'Unknown',
    '',
    '   ',
    'Android',
    'iOS / Android',
    'Apple iPod Classic',
    'Java ME (J2ME) mobile phone',
    'Windows Mobile / Pocket PC',
    'Windows Phone 7',
    'Mobile and PC (Android, iOS, Windows)',
    'Sony PlayStation Vita',
    'Raspberry Pi'
  ])('%s has no system', (text) => {
    expect(systemIdForConsole(text)).toBeNull()
  })

  it('gives the display name with the id', () => {
    expect(systemIdForConsole('Microsoft Xbox 360')).toEqual({
      systemId: 'xbox360',
      console: 'Xbox 360'
    })
    expect(systemIdForConsole('PS1')).toEqual({ systemId: 'psx', console: 'PlayStation' })
  })

  it('ignores case and surrounding spaces', () => {
    expect(id('  NINTENDO 64  ')).toBe('n64')
    expect(id('X360')).toBe('xbox360')
  })

  it('does not throw on non-strings', () => {
    expect(systemIdForConsole(undefined as unknown as string)).toBeNull()
    expect(systemIdForConsole(null as unknown as string)).toBeNull()
  })
})

describe('originDisplayName', () => {
  it('names known systems', () => {
    expect(originDisplayName('n64')).toBe('Nintendo 64')
    expect(originDisplayName('psx')).toBe('PlayStation')
    expect(originDisplayName('dos')).toBe('MS-DOS')
    expect(originDisplayName('pc')).toBe('PC')
    expect(originDisplayName('other')).toBe('Other')
  })

  it('falls back to the id itself', () => {
    expect(originDisplayName('3do')).toBe('3DO')
    expect(originDisplayName('vec')).toBe('VEC')
    expect(originDisplayName('vectrex')).toBe('Vectrex')
    expect(originDisplayName('')).toBe('Other')
  })
})
