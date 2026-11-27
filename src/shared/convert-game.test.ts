import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { conversionsForGame, type GameConversionSystem } from './convert'

// The real system definitions (what the renderer's system list carries).
const SYSTEMS = (
  JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'resources', 'systems', 'systems.json'), 'utf8')
  ) as { systems: GameConversionSystem[] }
).systems
const system = (id: string): GameConversionSystem => {
  const found = SYSTEMS.find((s) => s.id === id)
  if (!found) throw new Error(`no system ${id}`)
  return found
}

type GameArg = Parameters<typeof conversionsForGame>[0]
const rom = (platformId: string, romPath: string, extra?: Record<string, unknown>): GameArg => ({
  source: 'rom',
  platformId,
  installed: true,
  romPath,
  ...(extra ? { extra } : {})
})
const labels = (game: GameArg): string[] =>
  conversionsForGame(game, system(game.platformId)).map((c) => `${c.from.label}->${c.to.label}`)

describe('conversionsForGame', () => {
  it('offers the game platform’s conversions from its own format only', () => {
    expect(labels(rom('ps2', 'D:/ROMs/ps2/SSX (USA).chd'))).toEqual(
      expect.arrayContaining(['CHD->ISO'])
    )
    expect(labels(rom('ps2', 'D:/ROMs/ps2/SSX (USA).chd')).every((l) => l.startsWith('CHD'))).toBe(
      true
    )
    expect(labels(rom('psx', 'D:/ROMs/psx/Game.cue'))).toContain('CUE/BIN->CHD')
    // Game Format Converter 2.1.1's ROM tools: a cartridge ROM offers its own format's others.
    expect(labels(rom('snes', 'D:/ROMs/snes/Mario.sfc'))).toEqual(['SFC->SMC (copier header)'])
    expect(labels(rom('n64', 'D:/ROMs/n64/Mario.z64'))).toEqual([
      'Z64 (big-endian)->V64 (byte-swapped)',
      'Z64 (big-endian)->N64 (little-endian)'
    ])
    expect(labels(rom('genesis', 'D:/ROMs/genesis/Sonic.smd'))).toEqual(['SMD (interleaved)->MD'])
    expect(labels(rom('nds', 'D:/ROMs/nds/Mario.nds'))).toEqual([
      'NDS (full size)->NDS (trimmed)',
      'NDS (trimmed)->NDS (full size)'
    ])
  })

  it('never offers Games on Demand → ISO for an Xbox 360 game folder', () => {
    const game = rom('xbox360', 'D:/ROMs/xbox360/Halo 3/default.xex', {
      gameFolder: 'D:/ROMs/xbox360/Halo 3'
    })
    expect(labels(game).some((l) => l.startsWith('Games on Demand'))).toBe(false)
  })

  it('lists every conversion from the game’s format, flagging results its system does not play', () => {
    const x360 = conversionsForGame(rom('xbox360', 'D:/ROMs/xbox360/Halo 3.iso'), system('xbox360'))
    const by = (to: string): boolean | undefined => x360.find((c) => c.to.label === to)?.playable
    // ISO to XISO, ZAR, Game Folder and CHD: all listed.
    expect(x360.map((c) => c.to.label)).toEqual(
      expect.arrayContaining(['XISO (trimmed)', 'ZAR', 'Game Folder', 'CHD'])
    )
    // Xbox 360 plays ISO / ZAR and an extracted folder (its default.xex), not CHD.
    expect([by('ZAR'), by('Game Folder'), by('CHD')]).toEqual([true, true, false])
    expect(
      conversionsForGame(rom('psx', 'D:/ROMs/psx/Game.cue'), system('psx')).find((c) =>
        c.to.label.includes('VCD')
      )?.playable
    ).toBe(false)
    // A folder is a game only where the ROM scan lists one: a PS3 JB folder is, a Switch 2 folder is not.
    expect(
      conversionsForGame(rom('ps3', 'D:/ROMs/ps3/Game.iso'), system('ps3')).find(
        (c) => c.to.label === 'JB Folder'
      )?.playable
    ).toBe(true)
    const nup = conversionsForGame(rom('switch2', 'D:/ROMs/switch2/Game.nup'), system('switch2'))
    expect(nup.map((c) => [c.to.label, c.playable])).toEqual([['Game Folder', false]])
  })

  it('keeps directions that keep the original (a PS4 package unpacked beside it)', () => {
    const pkg = conversionsForGame(rom('ps4', 'D:/ROMs/ps4/Game.pkg'), system('ps4'))
    expect(pkg.map((c) => [c.to.label, c.path])).toEqual([['Game Folder', 'D:/ROMs/ps4/Game.pkg']])
    // A PS4 dump is a folder: no file format of it applies.
    expect(
      conversionsForGame(
        rom('ps4', 'D:/ROMs/ps4/GR2/eboot.bin', { gameFolder: 'D:/ROMs/ps4/GR2' }),
        system('ps4')
      )
    ).toEqual([])
  })

  it('no trim for an image already trimmed', () => {
    expect(
      labels(rom('xbox360', 'D:/ROMs/xbox360/Halo 3.xiso.iso')).some((l) => l.includes('XISO'))
    ).toBe(false)
  })

  it('one entry per result: PSP CSO reads back to ISO once', () => {
    expect(
      labels(rom('psp', 'D:/ROMs/psp/Game.cso')).filter((l) => l.endsWith('->ISO'))
    ).toHaveLength(1)
  })

  it('a PS3 disc folder becomes an ISO, a PSN folder a package, and an unknown folder neither', () => {
    const folder = (kind?: string): string[] =>
      labels(
        rom('ps3', 'D:/ROMs/ps3/Game.ps3', { directory: true, ...(kind ? { ps3Kind: kind } : {}) })
      )
    expect(folder('disc').some((l) => l.endsWith('->ISO'))).toBe(true)
    expect(folder('disc').some((l) => l.endsWith('->PKG'))).toBe(false)
    expect(folder('psn').some((l) => l.endsWith('->ISO'))).toBe(false)
    expect(folder()).toEqual([])
  })

  it('converts Mega-CD, Japanese Saturn and TurboGrafx-CD games as Sega CD, Saturn and PC Engine CD', () => {
    for (const id of ['megacd', 'saturnjp', 'tg-cd'])
      expect(
        conversionsForGame(rom(id, `D:/ROMs/${id}/Game.cue`), system(id)).length
      ).toBeGreaterThan(0)
  })

  it('nothing without the system yet, or for a game that is not a ROM on this PC', () => {
    const iso = rom('ps2', 'D:/x.iso')
    expect(conversionsForGame(iso, null)).toEqual([])
    const ps2 = system('ps2')
    expect(conversionsForGame({ ...iso, installed: false }, ps2)).toEqual([])
    expect(conversionsForGame({ ...iso, remote: { hostId: 'h' } }, ps2)).toEqual([])
    expect(conversionsForGame({ ...iso, romRemoved: { recompId: 'r' } }, ps2)).toEqual([])
    expect(conversionsForGame({ ...iso, source: 'steam' }, ps2)).toEqual([])
  })
})
