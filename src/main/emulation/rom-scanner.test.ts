import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import {
  extensionOf,
  isHiddenName,
  loadMameAssets,
  parseCueFiles,
  parseM3u,
  parseMameAssets,
  romGameFolder,
  scanRomRoot,
  systemFolderOf
} from './rom-scanner'
import { loadSystemCatalog } from './systems'

const ROOT = resolve(__dirname, '../../..')
const catalog = loadSystemCatalog(join(ROOT, 'resources', 'systems', 'systems.json'))
const arcadeAssets = loadMameAssets(join(ROOT, 'resources', 'systems', 'mame-assets.json'))
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

let romsRoot: string

async function file(rel: string, content = 'data'): Promise<string> {
  const full = join(romsRoot, ...rel.split('/'))
  await fs.mkdir(join(full, '..'), { recursive: true })
  await fs.writeFile(full, content)
  return full
}

async function folder(rel: string): Promise<string> {
  const full = join(romsRoot, ...rel.split('/'))
  await fs.mkdir(full, { recursive: true })
  return full
}

beforeEach(async () => {
  romsRoot = join(await fs.mkdtemp(join(tmpdir(), 'playout-roms-')), 'My ROMs')
  await fs.mkdir(romsRoot)
})

afterEach(async () => {
  await fs.rm(join(romsRoot, '..'), { recursive: true, force: true })
})

describe('helpers', () => {
  it('extracts extensions from the last dot and flags hidden names', () => {
    expect(extensionOf('Game (USA).sfc')).toBe('.sfc')
    expect(extensionOf('Game.v1.2.ZIP')).toBe('.zip')
    expect(extensionOf('README')).toBe('.')
    expect(extensionOf('.hidden')).toBe('.')
    expect(isHiddenName('.DS_Store')).toBe(true)
    // ES-DE only hides '.'-prefixed names; '_Unsorted' and '_wip.sfc' are ordinary entries.
    expect(isHiddenName('_backup')).toBe(false)
    expect(isHiddenName('Thumbs.db')).toBe(true)
    expect(isHiddenName('gamelist.xml')).toBe(true)
    expect(isHiddenName('Game.sfc')).toBe(false)
    // A PS5 package being unpacked (PS5PKGTool's staging folder) is not a game yet.
    expect(isHiddenName(`PPSA01234-app.extracting.${'a1'.repeat(16)}`)).toBe(true)
    expect(isHiddenName('Game.extracting.notaguid')).toBe(false)
    expect(isHiddenName('.playout-held')).toBe(true)
  })

  it('loads the MAME BIOS/device lists and rejects malformed ones', () => {
    // ES-DE's MAME 0.289 lists: 95 BIOS sets + 1414 device sets, lower-cased.
    expect(arcadeAssets.size).toBeGreaterThan(1400)
    for (const name of ['neogeo', 'sys573', 'coh1002m', 'qsound', 'ym2608', 'm68705p3'])
      expect(arcadeAssets.has(name)).toBe(true)
    expect(arcadeAssets.has('mslug')).toBe(false)
    expect(parseMameAssets('{"bioses":["NeoGeo"],"devices":["QSound"]}')).toEqual(
      new Set(['neogeo', 'qsound'])
    )
    expect(() => parseMameAssets('{"bioses":[]}')).toThrow(/malformed/)
    expect(() => parseMameAssets('{"bioses":[],"devices":[]}')).toThrow(/lists no MAME/)
    expect(() => parseMameAssets('not json')).toThrow(/not valid JSON/)
    expect(() => loadMameAssets(join(ROOT, 'nope.json'))).toThrow(/Cannot read the MAME/)
  })

  it('parses m3u playlists and cue sheets relative to their folder', () => {
    expect(
      parseM3u('# comment\r\nGame (Disc 1).chd\r\n\r\n  Game (Disc 2).chd \r\n', 'C:\\r\\psx')
    ).toEqual(['C:\\r\\psx\\Game (Disc 1).chd', 'C:\\r\\psx\\Game (Disc 2).chd'])
    expect(
      parseCueFiles(
        'FILE "Track 01.bin" BINARY\n  TRACK 01 MODE2/2352\nFILE track02.bin BINARY\n',
        'C:\\r\\psx'
      )
    ).toEqual(['C:\\r\\psx\\Track 01.bin', 'C:\\r\\psx\\track02.bin'])
  })

  it('names the system folder of a ROM', () => {
    expect(systemFolderOf('C:\\ROMs', 'C:\\ROMs\\snes\\Sub\\Game.sfc')).toBe('snes')
  })
})

describe('scanRomRoot', () => {
  it('returns nothing for a missing root', async () => {
    const result = await scanRomRoot({
      romsRoot: join(romsRoot, 'nope'),
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    expect(result).toEqual({ games: [], unknownFolders: [], systemsScanned: [] })
  })

  it('scans a mixed ROM tree the way ES-DE would', async () => {
    // snes: plain files, a zip, an unrelated text file, a hidden name, underscore names (not hidden, as in ES-DE),
    // a media folder and a nested sub-folder.
    const mario = await file('snes/Super Mario World (USA) [!].sfc')
    const zelda = await file('snes/Legend of Zelda, The - A Link to the Past (Europe).zip', 'PK')
    await file('snes/readme.txt')
    await file('snes/.hidden.sfc')
    await file('snes/.git/objects/x.sfc')
    const wip = await file('snes/_wip.sfc')
    const unsorted = await file('snes/_Unsorted/Hidden.sfc')
    await file('snes/media/covers/Super Mario World (USA).png')
    await file('snes/images/Super Mario World (USA).sfc')
    await file('snes/downloaded_media/x.sfc')
    await file('snes/manuals/x.sfc')
    await file('snes/videos/x.sfc')
    const hack = await file('snes/Hacks/Kaizo Mario (Hack).SFC')
    await file('snes/Broken/noload.txt')
    await file('snes/Broken/Should Not Appear.sfc')

    // psx: an m3u listing two discs plus a single-disc chd and a cue/bin pair.
    const ff7 = await file(
      'psx/Final Fantasy VII (USA).m3u',
      'Final Fantasy VII (USA) (Disc 1).chd\nFinal Fantasy VII (USA) (Disc 2).chd\n'
    )
    await file('psx/Final Fantasy VII (USA) (Disc 1).chd')
    await file('psx/Final Fantasy VII (USA) (Disc 2).chd')
    const crash = await file('psx/Crash Bandicoot (USA).chd')
    const cue = await file(
      'psx/Tekken (USA).cue',
      'FILE "Tekken (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n'
    )
    await file('psx/Tekken (USA).bin')
    // A multi-disc game modelled as a Game.m3u directory holding the discs: the directory is the game.
    const m3uDir = await folder('psx/Chrono Cross (USA).m3u')
    await file(
      'psx/Chrono Cross (USA).m3u/Chrono Cross (USA).m3u',
      'Chrono Cross (USA) (Disc 1).chd\n'
    )
    await file('psx/Chrono Cross (USA).m3u/Chrono Cross (USA) (Disc 1).chd')

    // ps3: a directory game that must not be descended into.
    const sotc = await folder('ps3/Shadow of the Colossus.ps3')
    await file('ps3/Shadow of the Colossus.ps3/PS3_GAME/USRDIR/EBOOT.BIN')
    await file('ps3/Shadow of the Colossus.ps3/PS3_GAME/ICON0.PNG')

    // Folders that match no system, a noload.txt system, a disabled folder and plain files at the root.
    await file('unknownsystem/game.bin')
    await file('Not A System/thing.sfc')
    await file('gba/noload.txt')
    await file('gba/Pokemon.gba')
    await file('stray.sfc')
    await folder('.git')
    await folder('media')
    await file('media/snes.png')
    // RPCS3's hard drive (updates, DLC): neither a system nor an unknown folder.
    await file('PS3 HDD/dev_hdd0/game/BLUS30443/USRDIR/EBOOT.BIN')
    // What the move to Updates and DLC set aside, and PlayOut's in-progress copies: never systems or unknown folders.
    await file('PS3 HDD.playout-old/dev_hdd0/game/BLUS30443/PARAM.SFO')
    await file('snes/Copy.playout-new/game.sfc')
    // A disc image moved aside while its recompilation is tested (services/held-files.ts): never a game.
    await file(
      'psx/.playout-held/m3x9k2-4f7a1c/Held Game (USA).cue',
      'FILE "Held Game (USA).bin" BINARY'
    )
    await file('psx/.playout-held/m3x9k2-4f7a1c/Held Game (USA).bin')
    await file('snes/Hacks/.playout-held/m3x9k2-4f7a1c/Held.sfc')

    const progress: [number, string | undefined][] = []
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent,
      progress: (n, m) => progress.push([n, m])
    })

    expect(result.unknownFolders).toEqual(['Not A System', 'unknownsystem'])
    expect(result.systemsScanned).toEqual(['ps3', 'psx', 'snes'])

    const byPath = new Map(result.games.map((g) => [g.romPath, g]))
    expect([...byPath.keys()].sort()).toEqual(
      [mario, zelda, wip, unsorted, hack, ff7, crash, cue, m3uDir, sotc].sort()
    )
    expect(byPath.get(unsorted)?.externalId).toBe('snes/_Unsorted/Hidden.sfc')

    const game = byPath.get(mario)!
    expect(game).toEqual({
      source: 'rom',
      externalId: 'snes/Super Mario World (USA) [!].sfc',
      platformId: 'snes',
      title: 'Super Mario World',
      romPath: mario,
      launch: { kind: 'emulator', systemId: 'snes', romPath: mario },
      tracking: { mode: 'spawned' },
      extra: { tags: 'USA, !', extension: '.sfc', fileSize: 4 }
    })
    expect(byPath.get(zelda)?.title).toBe('Legend of Zelda, The - A Link to the Past')
    expect(byPath.get(zelda)?.extra).toMatchObject({
      extension: '.zip',
      fileSize: 2,
      tags: 'Europe'
    })
    expect(byPath.get(hack)?.externalId).toBe('snes/Hacks/Kaizo Mario (Hack).SFC')
    expect(byPath.get(hack)?.extra?.extension).toBe('.sfc')

    expect(byPath.get(ff7)?.title).toBe('Final Fantasy VII')
    expect(byPath.get(ff7)?.extra).toMatchObject({ extension: '.m3u', tags: 'USA' })
    expect(byPath.get(crash)?.title).toBe('Crash Bandicoot')
    expect(byPath.get(cue)?.title).toBe('Tekken')
    expect(byPath.get(m3uDir)).toMatchObject({
      title: 'Chrono Cross',
      externalId: 'psx/Chrono Cross (USA).m3u',
      extra: { directory: true, extension: '.m3u', fileSize: 0 }
    })

    expect(byPath.get(sotc)).toMatchObject({
      platformId: 'ps3',
      title: 'Shadow of the Colossus',
      externalId: 'ps3/Shadow of the Colossus.ps3',
      launch: { kind: 'emulator', systemId: 'ps3', romPath: sotc },
      // It holds PS3_GAME: a disc dump (Convert makes an ISO of it, not a package).
      extra: { directory: true, extension: '.ps3', ps3Kind: 'disc' }
    })

    const titles = result.games.map((g) => g.title)
    expect(titles).not.toContain('Should Not Appear')
    expect(titles).not.toContain('Pokemon')
    expect(titles).not.toContain('stray')
    expect(
      result.games.some((g) => g.romPath?.includes('Disc 1') || g.romPath?.includes('Disc 2'))
    ).toBe(false)
    expect(result.games.some((g) => g.romPath?.endsWith('.bin'))).toBe(false)
    expect(result.games.some((g) => g.romPath?.includes('EBOOT'))).toBe(false)

    // Progress was reported per system with a running total.
    expect(
      progress.some(([, m]) => m === 'Scanning snes…' || m?.startsWith('Scanning Nintendo'))
    ).toBe(true)
    expect(progress.at(-1)?.[0]).toBe(result.games.length)
    expect(progress.filter(([, m]) => m?.endsWith('games')).length).toBe(3)
  })

  it('matches system folders by alias and case', async () => {
    const rom = await file('MegaDrive/Sonic (USA).md')
    await file('PS1/Spyro (USA).chd')
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    expect(result.games.map((g) => g.platformId).sort()).toEqual(['megadrive', 'psx'])
    expect(result.games.find((g) => g.platformId === 'megadrive')?.romPath).toBe(rom)
    expect(result.games.find((g) => g.platformId === 'megadrive')?.externalId).toBe(
      'MegaDrive/Sonic (USA).md'
    )
  })

  it('lists Nintendo Switch 2 games from the switch2 folder (and its aliases)', async () => {
    const nup = await file('switch2/Mario Kart World.nup')
    await file('switch2/Donkey Kong Bananza.nx')
    await file('switch2/Kirby Air Riders.xci')
    await file('switch2/Pokemon Legends Z-A.nsp')
    await file('switch2/readme.txt')
    await file('Switch 2/Drag x Drive.nup')
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    expect(result.games.every((g) => g.platformId === 'switch2')).toBe(true)
    expect(result.games.map((g) => g.externalId).sort()).toEqual([
      'Switch 2/Drag x Drive.nup',
      'switch2/Donkey Kong Bananza.nx',
      'switch2/Kirby Air Riders.xci',
      'switch2/Mario Kart World.nup',
      'switch2/Pokemon Legends Z-A.nsp'
    ])
    expect(result.games.find((g) => g.externalId.endsWith('.nup'))?.romPath).toBeDefined()
    expect(result.games.some((g) => g.romPath === nup)).toBe(true)
  })

  it('drops MAME BIOS and device sets from arcade folders but keeps them elsewhere', async () => {
    await file('arcade/neogeo.zip')
    await file('arcade/NeoGeo.7z')
    await file('arcade/mslug.zip')
    // BIOS sets missing from the old hand-written list, and device sets of a full non-merged set.
    await file('arcade/sys573.zip')
    await file('arcade/coh1002m.zip')
    await file('arcade/qsound.zip')
    await file('arcade/qsound_hle.zip')
    await file('arcade/ym2608.zip')
    await file('arcade/m68705p3.zip')
    await file('mame/sys573.zip')
    await file('mame/sf2.zip')
    await file('neogeo/neogeo.zip')
    await file('neogeo/kof98.zip')
    await file('fbneo/neogeo.zip')
    await file('snes/neogeo.zip')
    await file('snes/qsound.zip')
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent,
      arcadeAssets
    })
    const ids = result.games.map((g) => g.externalId).sort()
    expect(ids).toEqual([
      'arcade/mslug.zip',
      'mame/sf2.zip',
      'neogeo/kof98.zip',
      'snes/neogeo.zip',
      'snes/qsound.zip'
    ])

    // Without the list nothing is filtered (the service always passes the bundled one).
    const unfiltered = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    expect(unfiltered.games.map((g) => g.externalId)).toContain('arcade/qsound.zip')
  })

  it('treats a directory named like a game file as the game, as ES-DE does', async () => {
    // ROM hack folder: the folder holds the ROM and a patch; the folder is the game, not its content.
    const hackDir = await folder('snes/Hacks/Game.zip')
    await file('snes/Hacks/Game.zip/Game.zip', 'PK')
    await file('snes/Hacks/Game.zip/patch.ips')
    // A multi-file dump folder yields one game, not one per inner file.
    const chdDir = await folder('psx/Game.chd')
    await file('psx/Game.chd/Disc1.chd')
    await file('psx/Game.chd/Disc2.chd')
    // xbox360 lists the extensionless '.' marker: a plain sub-folder is still descended into.
    const sports = await file('xbox360/Sports/game.iso')
    // Plain sub-folders are still descended into (the existing Kaizo case).
    const kaizo = await file('snes/Hacks/Kaizo Mario (Hack).sfc')

    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    const byPath = new Map(result.games.map((g) => [g.romPath, g]))
    expect([...byPath.keys()].sort()).toEqual([hackDir, chdDir, sports, kaizo].sort())
    expect(byPath.get(hackDir)).toMatchObject({
      externalId: 'snes/Hacks/Game.zip',
      extra: { directory: true, extension: '.zip' }
    })
    expect(byPath.get(chdDir)).toMatchObject({
      externalId: 'psx/Game.chd',
      extra: { directory: true, extension: '.chd' }
    })
    expect(byPath.get(sports)?.externalId).toBe('xbox360/Sports/game.iso')
    expect(result.games.some((g) => g.externalId === 'snes/Hacks/Game.zip/Game.zip')).toBe(false)
  })
})

describe('PS4 game folders', () => {
  it('lists a dumped PS4 folder as one game launched through its eboot.bin', async () => {
    const drive = 'ps4/DRIVECLUB - [EU] [EN] [1.28]'
    const eboot = await file(`${drive}/eboot.bin`, 'ELF')
    await file(`${drive}/game000.dat`)
    await file(`${drive}/sce_module/libc.bin`)
    await file(`${drive}/sce_module/libSceFios2.bin`)
    await file(`${drive}/sce_sys/param.bin`)
    await file(`${drive}/dlc00/data.bin`)
    // Upper-case EBOOT.BIN in a nested folder (sorting folders by genre), plus a patch folder of its own.
    const gt = await file('ps4/Racing/Gran Turismo 7/EBOOT.BIN')
    await file('ps4/Racing/Gran Turismo 7/sce_module/libfoo.bin')
    // ES-DE's own layouts stay: a .ps4 directory is the game, as is a shortcut.
    const serialDir = await folder('ps4/Bloodborne.ps4')
    await file('ps4/Bloodborne.ps4/eboot.bin')
    const shortcut = await file('ps4/shortcuts/Astro Bot.lnk')
    // A loose .bin outside any game folder is still listed, as ES-DE would.
    const loose = await file('ps4/Loose Game.bin')

    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    const byPath = new Map(result.games.map((g) => [g.romPath, g]))
    expect([...byPath.keys()].sort()).toEqual([serialDir, shortcut, loose, eboot, gt].sort())

    const dc = byPath.get(eboot)!
    expect(dc.title).toBe('DRIVECLUB')
    expect(dc.externalId).toBe('ps4/DRIVECLUB - [EU] [EN] [1.28]/eboot.bin')
    expect(dc.platformId).toBe('ps4')
    expect(dc.launch).toEqual({
      kind: 'emulator',
      systemId: 'ps4',
      romPath: eboot,
      emulatorId: 'shadps4-eboot-bin-standalone'
    })
    expect(dc.extra?.tags).toBe('EU, EN, 1.28')
    expect(dc.extra?.gameFolder).toBe(join(romsRoot, 'ps4', 'DRIVECLUB - [EU] [EN] [1.28]'))
    expect(byPath.get(gt)?.title).toBe('Gran Turismo 7')

    const bb = byPath.get(serialDir)!
    expect(bb.title).toBe('Bloodborne')
    expect(bb.extra?.directory).toBe(true)
    expect(bb.launch).toEqual({ kind: 'emulator', systemId: 'ps4', romPath: serialDir })
    expect(byPath.get(shortcut)?.title).toBe('Astro Bot')
    expect(byPath.get(loose)?.launch).not.toHaveProperty('emulatorId')
  })

  it('leaves out a folder holding nothing but its eboot.bin (an earlier download of the eboot alone)', async () => {
    await file('ps4/Gravity Rush 2/eboot.bin', 'ELF')
    const whole = await file('ps4/Knack/eboot.bin', 'ELF')
    await file('ps4/Knack/sce_sys/param.sfo')
    const warned: string[] = []
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: { ...silent, warn: (...a) => warned.push(a.join(' ')) }
    })
    expect(result.games.map((g) => g.romPath)).toEqual([whole])
    // Left out, but not silently: the log says which folder and why.
    expect(warned).toEqual([
      `not listing ${join(romsRoot, 'ps4', 'Gravity Rush 2')}: it holds only eboot.bin, not a whole game`
    ])
  })

  it('leaves out a PS4 folder a download is still filling (a .part in it)', async () => {
    await file('ps4/Gravity Rush 2/eboot.bin', 'ELF')
    await file('ps4/Gravity Rush 2/sce_module/libc.prx.part')
    await file('ps4/Gravity Rush 2/patch.pkg.t1700000000000.part')
    const whole = await file('ps4/Knack/eboot.bin', 'ELF')
    await file('ps4/Knack/sce_sys/param.sfo')
    const warned: string[] = []
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: { ...silent, warn: (...a) => warned.push(a.join(' ')) }
    })
    expect(result.games.map((g) => g.romPath)).toEqual([whole])
    expect(warned).toEqual([
      `not listing ${join(romsRoot, 'ps4', 'Gravity Rush 2')}: a download into it is not finished (patch.pkg.t1700000000000.part is still there)`
    ])
  })

  it('lists a dumped PS5 folder as one game with no emulator, and PS5 images and packages as games', async () => {
    const astro = 'ps5/Astro Bot - [US] [1.05]'
    const eboot = await file(`${astro}/eboot.bin`, 'ELF')
    await file(`${astro}/sce_sys/param.json`, '{"titleId":"PPSA01325"}')
    await file(`${astro}/sce_module/libc.bin`)
    await file(`${astro}/sce_sys/about/right.pkg`)
    await file(`${astro}/data.exfat`)
    const ffpkg = await file('ps5/Demon Souls.ffpkg')
    const ffpfs = await file('ps5/Returnal.ffpfs')
    const ffpfsc = await file('ps5/Ratchet.ffpfsc')
    const exfat = await file('ps5/Spider-Man 2.exfat')
    const pkg = await file('ps5/Gran Turismo 7 (USA).pkg')
    const lnk = await file('ps5/Stellar Blade.lnk')
    await file('ps5/Loose.bin')
    await file('ps5/readme.txt')
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    expect(result.games.every((g) => g.platformId === 'ps5')).toBe(true)
    const byPath = new Map(result.games.map((g) => [g.romPath, g]))
    expect([...byPath.keys()].sort()).toEqual([eboot, ffpkg, ffpfs, ffpfsc, exfat, pkg, lnk].sort())
    const game = byPath.get(eboot)!
    expect(game.title).toBe('Astro Bot')
    expect(game.extra?.gameFolder).toBe(join(romsRoot, 'ps5', 'Astro Bot - [US] [1.05]'))
    expect(game.launch).toEqual({ kind: 'emulator', systemId: 'ps5', romPath: eboot })
    expect(romGameFolder(eboot, game)).toBe(join(romsRoot, 'ps5', 'Astro Bot - [US] [1.05]'))
    expect(byPath.get(pkg)?.title).toBe('Gran Turismo 7')
  })

  it('does not treat eboot.bin as special on other systems', async () => {
    await file('psx/Game/eboot.bin')
    await file('psx/Game/track.bin')
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    expect(result.games.map((g) => g.title).sort()).toEqual(['eboot', 'track'])
  })
})

/** A PARAM.SFO holding one text key (what ps3FolderKind reads: CATEGORY). */
function sfo(key: string, value: string): Buffer {
  const keyBytes = Buffer.from(`${key}\0`, 'latin1')
  const data = Buffer.from(`${value}\0`, 'latin1')
  const keyTable = 20 + 16
  const dataTable = keyTable + keyBytes.length
  const out = Buffer.alloc(dataTable + data.length)
  out.writeUInt32BE(0x00505346, 0)
  out.writeUInt32LE(0x101, 4)
  out.writeUInt32LE(keyTable, 8)
  out.writeUInt32LE(dataTable, 12)
  out.writeUInt32LE(1, 16)
  out.writeUInt16LE(0, 20)
  out.writeUInt16LE(0x0204, 22)
  out.writeUInt32LE(data.length, 24)
  out.writeUInt32LE(data.length, 28)
  out.writeUInt32LE(0, 32)
  keyBytes.copy(out, keyTable)
  data.copy(out, dataTable)
  return out
}

describe('Xbox and PS3 game folders', () => {
  it('lists an extracted Xbox 360 or Xbox folder as one game through its default.xex / default.xbe', async () => {
    const xex = await file('xbox360/Burnout Revenge/default.xex', 'XEX2')
    await file('xbox360/Burnout Revenge/other.xex')
    await file('xbox360/Burnout Revenge/nxeart')
    await file('xbox360/Burnout Revenge/$SystemUpdate/su20076000_00000000')
    // Homebrew is often just its default.xex: still a game.
    const alone = await file('xbox360/Homebrew/default.xex')
    // In the system folder itself, default.xex is a file like any other, and its neighbours stay listed.
    const loose = await file('xbox360/default.xex')
    const looseZar = await file('xbox360/Other.zar')
    const xbe = await file('xbox/Halo/default.xbe')
    await file('xbox/Halo/dashupdate.xbe')
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    const byPath = new Map(result.games.map((g) => [g.romPath, g]))
    expect([...byPath.keys()].sort()).toEqual([xex, alone, loose, looseZar, xbe].sort())
    expect(byPath.get(xex)?.externalId).toBe('xbox360/Burnout Revenge/default.xex')
    expect(byPath.get(xex)?.title).toBe('Burnout Revenge')
    expect(byPath.get(xex)?.extra?.gameFolder).toBe(join(romsRoot, 'xbox360', 'Burnout Revenge'))
    expect(byPath.get(xbe)?.title).toBe('Halo')
    // xemu boots disc images only: an Xbox folder starts in Cxbx-Reloaded.
    expect(byPath.get(xbe)?.launch).toMatchObject({ emulatorId: 'cxbx-reloaded-standalone' })
    expect(byPath.get(xex)?.launch).not.toHaveProperty('emulatorId')
    expect(byPath.get(loose)?.extra?.gameFolder).toBeUndefined()
  })

  it('lists a PS3 JB or PSN folder named without .ps3 as a game, as RPCS3 boots it', async () => {
    // A dot in the folder name is no extension: the title keeps it.
    const disc = await folder('ps3/Sly Cooper Vol. 1 [BCUS98123] [v1.10]')
    await file('ps3/Sly Cooper Vol. 1 [BCUS98123] [v1.10]/PS3_DISC.SFB')
    await file('ps3/Sly Cooper Vol. 1 [BCUS98123] [v1.10]/PS3_GAME/USRDIR/EBOOT.BIN')
    const psn = await folder('ps3/Journey')
    await fs.writeFile(join(psn, 'PARAM.SFO'), sfo('CATEGORY', 'HG'))
    await file('ps3/Journey/USRDIR/EBOOT.BIN')
    // Not games: a USRDIR without PARAM.SFO, and an update / DLC folder copied from a dev_hdd0 (category GD, AC).
    await file('ps3/Odd/USRDIR/x.bin')
    await file('ps3/dev_hdd0/game/BLUS30001/USRDIR/EBOOT.BIN')
    await fs.writeFile(
      join(romsRoot, 'ps3', 'dev_hdd0', 'game', 'BLUS30001', 'PARAM.SFO'),
      sfo('CATEGORY', 'GD')
    )
    await file('ps3/dev_hdd0/game/BLUS30002/USRDIR/dlc.edat')
    await fs.writeFile(
      join(romsRoot, 'ps3', 'dev_hdd0', 'game', 'BLUS30002', 'PARAM.SFO'),
      sfo('CATEGORY', 'AC')
    )
    const iso = await file('ps3/Sorted/Game.iso')
    const result = await scanRomRoot({
      romsRoot,
      findSystemForFolder: catalog.findSystemForFolder,
      log: silent
    })
    const byPath = new Map(result.games.map((g) => [g.romPath, g]))
    expect([...byPath.keys()].sort()).toEqual([disc, psn, iso].sort())
    expect(byPath.get(disc)?.extra).toMatchObject({ directory: true, ps3Kind: 'disc' })
    expect(byPath.get(disc)?.externalId).toBe('ps3/Sly Cooper Vol. 1 [BCUS98123] [v1.10]')
    expect(byPath.get(disc)?.title).toBe('Sly Cooper Vol. 1')
    expect(byPath.get(disc)?.extra?.extension).toBe('')
    expect(byPath.get(psn)?.extra).toMatchObject({ directory: true, ps3Kind: 'psn' })
  })
})
