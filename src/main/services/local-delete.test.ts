import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, parse } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game } from '../../shared/types'
import { upgradeRunningMessage } from '../../shared/upgrades'
import { tMain } from '../i18n'
import { gogUninstallArgs, isAllowedUninstallUri, uninstallUriFor } from '../installs/install-uri'
import type { UninstallEntry } from '../system/uninstall'
import { HELD_DIR, type HeldEntry } from './held-files'
import {
  createLocalDeleteService,
  folderDeleteRefusal,
  imageTrashOrder,
  sameProduct,
  matchUninstallEntry,
  parseUninstallCommand,
  STORE_RESCAN_DELAYS_MS,
  storeUninstallRefusal,
  type LocalDeleteDeps
} from './local-delete'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function game(partial: Partial<Game> & Pick<Game, 'id' | 'source'>): Game {
  return {
    externalId: partial.id.split(':').slice(1).join(':'),
    platformId: 'pc',
    title: partial.id,
    sortTitle: partial.id,
    installed: true,
    launch: { kind: 'uri', uri: 'x' },
    tracking: { kind: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...partial
  } as Game
}

function entry(partial: Partial<UninstallEntry>): UninstallEntry {
  return {
    keyName: 'k',
    hive: 'HKLM',
    view: 'x64',
    displayName: '',
    installLocation: '',
    uninstallString: '',
    publisher: '',
    displayIcon: '',
    displayVersion: '',
    ...partial
  }
}

function fakeSpawn(): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref(): void }
    child.unref = () => undefined
    setTimeout(() => child.emit('spawn'), 0)
    return child
  })
}

describe('store uninstall specs', () => {
  it('builds each store uninstall URI from the provider ids', () => {
    expect(uninstallUriFor('steam', { externalId: '620', extra: { steamAppId: 620 } })).toBe(
      'steam://uninstall/620'
    )
    expect(uninstallUriFor('epic', { externalId: 'x', extra: { epicAppName: 'Alan Wake' } })).toBe(
      'com.epicgames.launcher://apps/Alan%20Wake?action=uninstall'
    )
    expect(uninstallUriFor('ubisoft', { externalId: '4', extra: { ubisoftId: '4' } })).toBe(
      'uplay://uninstall/4'
    )
    expect(uninstallUriFor('xbox', { externalId: 'Microsoft.Conker' })).toBe(
      'ms-settings:appsfeatures'
    )
    for (const s of ['gog', 'ea', 'battlenet'] as const)
      expect(uninstallUriFor(s, { externalId: '1' })).toBeNull()
    expect(uninstallUriFor('steam', { externalId: '62a0' })).toBeNull()
    expect(gogUninstallArgs({ externalId: '1207658924' })).toEqual([
      '/command=uninstall',
      '/gameId=1207658924'
    ])
    expect(gogUninstallArgs({ externalId: '12; calc' })).toBeNull()
  })

  it('allow-lists the uninstall URIs', () => {
    expect(isAllowedUninstallUri('steam://uninstall/620')).toBe(true)
    expect(isAllowedUninstallUri('ms-settings:appsfeatures')).toBe(true)
    expect(isAllowedUninstallUri('ms-settings:privacy-webcam')).toBe(false)
    expect(isAllowedUninstallUri('file:///C:/Windows/System32/cmd.exe')).toBe(false)
    expect(isAllowedUninstallUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedUninstallUri('C:\\x.exe')).toBe(false)
  })
})

describe('parseUninstallCommand', () => {
  it('splits quoted and unquoted programs from their arguments', () => {
    expect(parseUninstallCommand('"C:\\Games\\Foo\\unins000.exe" /SILENT')).toEqual({
      file: 'C:\\Games\\Foo\\unins000.exe',
      args: ['/SILENT']
    })
    expect(
      parseUninstallCommand(
        'C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe --lang=enUS --uid=d3 --displayname="Diablo III"'
      )
    ).toEqual({
      file: 'C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe',
      args: ['--lang=enUS', '--uid=d3', '--displayname=Diablo III']
    })
  })

  it('runs MSI entries as an uninstall of their product code', () => {
    expect(
      parseUninstallCommand('MsiExec.exe /I{12345678-1234-1234-1234-123456789ABC}', 'C:\\Windows')
    ).toEqual({
      file: 'C:\\Windows\\System32\\msiexec.exe',
      args: ['/X{12345678-1234-1234-1234-123456789ABC}']
    })
    expect(parseUninstallCommand('MsiExec.exe /qn')).toBeNull()
  })

  it('refuses shells, script hosts, relative programs and junk', () => {
    expect(parseUninstallCommand('C:\\Windows\\System32\\cmd.exe /c del C:\\')).toBeNull()
    expect(
      parseUninstallCommand('"C:\\Windows\\System32\\rundll32.exe" x.dll,Uninstall')
    ).toBeNull()
    expect(parseUninstallCommand('powershell.exe -c x')).toBeNull()
    expect(parseUninstallCommand('uninstall.exe /S')).toBeNull()
    expect(parseUninstallCommand('"C:\\x\\uninstall.bat"')).toBeNull()
    expect(parseUninstallCommand('')).toBeNull()
  })
})

describe('matchUninstallEntry', () => {
  const entries = [
    entry({
      installLocation: 'C:\\Games\\Foo\\',
      uninstallString: '"C:\\Games\\Foo\\unins000.exe"'
    }),
    entry({
      installLocation: 'D:\\BNet\\Diablo III',
      uninstallString:
        '"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --uid=diablo3_enus'
    }),
    entry({ installLocation: 'C:\\Games\\Bad', uninstallString: 'cmd.exe /c rd /s /q C:\\' })
  ]
  it('matches on the install folder, then on the Battle.net uid', () => {
    expect(matchUninstallEntry(entries, { installDir: 'c:\\games\\foo' })).toBe(entries[0])
    expect(matchUninstallEntry(entries, { exePath: 'C:\\Games\\Foo\\foo.exe' })).toBe(entries[0])
    expect(
      matchUninstallEntry(entries, { installDir: 'E:\\moved', extra: { uid: 'diablo3_enus' } })
    ).toBe(entries[1])
    expect(
      matchUninstallEntry(entries, { installDir: 'E:\\other', extra: { uid: 'diablo3' } })
    ).toBe(null)
  })
  it('never matches an entry whose command cannot run safely', () => {
    expect(matchUninstallEntry(entries, { installDir: 'C:\\Games\\Bad' })).toBeNull()
  })
})

describe('storeUninstallRefusal', () => {
  it("refuses store clients' programs and entries in a store's library", () => {
    for (const exe of [
      'C:\\Program Files (x86)\\Steam\\steam.exe',
      'C:\\X\\EpicGamesLauncher.exe',
      'C:\\X\\GalaxyClient.exe',
      'C:\\X\\EADesktop.exe',
      'C:\\X\\upc.exe',
      'C:\\X\\Battle.net.exe'
    ])
      expect(storeUninstallRefusal({ installLocation: 'D:\\Games\\A' }, exe)).toMatch(
        /store's program/
      )
    expect(
      storeUninstallRefusal(
        { installLocation: 'D:\\Lib\\steamapps\\common\\A' },
        'D:\\Lib\\steamapps\\common\\A\\unins000.exe'
      )
    ).toMatch(/steamapps/)
    expect(
      storeUninstallRefusal(
        { installLocation: '"C:\\XboxGames\\Halo"' },
        'D:\\Games\\Halo\\unins000.exe'
      )
    ).toMatch(/XboxGames/)
    expect(
      storeUninstallRefusal({ installLocation: 'D:\\Games\\A' }, 'D:\\Games\\A\\unins000.exe')
    ).toBeNull()
    expect(storeUninstallRefusal({ installLocation: '' }, 'D:\\Games\\A\\unins000.exe')).toBeNull()
  })

  it("allows standalone games' own uninstallers in GOG Games, EA Games and Ubisoft folders", () => {
    for (const dir of [
      'C:\\GOG Games\\The Witcher 3',
      'C:\\Program Files (x86)\\EA Games\\Crysis',
      'C:\\Program Files (x86)\\Ubisoft\\Rayman Origins'
    ])
      expect(storeUninstallRefusal({ installLocation: dir }, `${dir}\\unins000.exe`)).toBeNull()
    const ubi = 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\AC'
    expect(storeUninstallRefusal({ installLocation: ubi }, `${ubi}\\unins000.exe`)).toMatch(
      /Ubisoft Game Launcher/
    )
  })
})

describe('folderDeleteRefusal', () => {
  const folders = {
    protectedFolders: ['C:\\Users\\me', 'C:\\Users\\me\\Desktop', 'C:\\Program Files (x86)'],
    appFolders: ['C:\\Apps\\PlayOut', 'D:\\Emulation'],
    windowsDir: 'C:\\Windows'
  }
  it('allows a game folder that holds the game and nothing else of note', () => {
    expect(
      folderDeleteRefusal('D:\\Games\\Foo', 'D:\\Games\\Foo\\bin\\foo.exe', folders)
    ).toBeNull()
    expect(
      folderDeleteRefusal(
        'C:\\Program Files (x86)\\Foo',
        'C:\\Program Files (x86)\\Foo\\foo.exe',
        folders
      )
    ).toBeNull()
  })
  it('refuses drive roots, known folders, their parents and Windows', () => {
    expect(folderDeleteRefusal('D:\\', 'D:\\foo.exe', folders)).toMatch(/top of a drive/)
    expect(
      folderDeleteRefusal('C:\\Users\\me\\Desktop', 'C:\\Users\\me\\Desktop\\a.exe', folders)
    ).toMatch(/system or user folder/)
    expect(folderDeleteRefusal('C:\\Users', 'C:\\Users\\a.exe', folders)).toMatch(/system or user/)
    expect(folderDeleteRefusal('C:\\Windows\\Foo', 'C:\\Windows\\Foo\\a.exe', folders)).toMatch(
      /Windows/
    )
  })
  it('refuses folders that hold PlayOut or the Emulation folder, or sit in them', () => {
    expect(folderDeleteRefusal('C:\\Apps', 'C:\\Apps\\x.exe', folders)).toMatch(/PlayOut/)
    expect(
      folderDeleteRefusal('D:\\Emulation\\tools\\x', 'D:\\Emulation\\tools\\x\\x.exe', folders)
    ).toMatch(/PlayOut/)
  })
  it('refuses when the exe is not inside the folder', () => {
    expect(folderDeleteRefusal('D:\\Games\\Foo', 'D:\\Games\\Bar\\bar.exe', folders)).toMatch(
      /not inside/
    )
    expect(folderDeleteRefusal('D:\\Games\\Foo', undefined, folders)).toMatch(/not inside/)
  })
  it('refuses a folder right below the top of a drive (a games library)', () => {
    expect(folderDeleteRefusal('D:\\Games', 'D:\\Games\\Foo\\foo.exe', folders)).toMatch(
      /right below the top of its drive/
    )
  })
  it("refuses a store's library folder and a game inside steamapps or XboxGames", () => {
    expect(
      folderDeleteRefusal('D:\\Stuff\\SteamLibrary', 'D:\\Stuff\\SteamLibrary\\x.exe', folders)
    ).toMatch(/store's game library or a store's own folder/)
    expect(
      folderDeleteRefusal(
        'D:\\SteamLibrary\\steamapps\\common\\Foo',
        'D:\\SteamLibrary\\steamapps\\common\\Foo\\foo.exe',
        folders
      )
    ).toMatch(/uninstall it from that store/)
    expect(
      folderDeleteRefusal('E:\\XboxGames\\Halo', 'E:\\XboxGames\\Halo\\Content\\h.exe', folders)
    ).toMatch(/XboxGames/)
  })
})

describe('sameProduct', () => {
  it('pairs the programs of one game and tells different games apart', () => {
    expect(sameProduct('Hades.exe', 'Hades-Win64-Shipping.exe')).toBe(true)
    expect(sameProduct('Game_x64.exe', 'Game.exe')).toBe(true)
    expect(sameProduct('Hades.exe', 'Celeste.exe')).toBe(false)
  })
})

describe('createLocalDeleteService', () => {
  let root: string
  let games: Map<string, Game>
  let trash: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>
  let timers: { fn: () => void; ms: number }[]

  function deps(
    overrides: Partial<LocalDeleteDeps> = {},
    io: LocalDeleteDeps['io'] = {}
  ): LocalDeleteDeps {
    return {
      library: {
        getGame: (id) => games.get(id),
        games: () => [...games.values()],
        removeGame: vi.fn((id: string) => void games.delete(id))
      },
      imageCache: { remove: vi.fn(async () => undefined) },
      romsRoot: () => root,
      appFolders: () => [],
      keepFolders: () => [join(root, '..', 'saves')],
      protectedFolders: () => [],
      running: () => null,
      busyIds: () => [],
      storeName: (s) =>
        ({ steam: 'Steam', ea: 'EA app', battlenet: 'Battle.net', gog: 'GOG Galaxy' })[
          s as 'steam'
        ] ?? s,
      client: async () => ({ installed: true, path: 'C:\\GOG\\GalaxyClient.exe' }),
      rescan: vi.fn(async () => undefined),
      log,
      io: {
        trash,
        openExternal: vi.fn(async () => undefined),
        spawn: fakeSpawn() as never,
        runElevated: vi.fn(async () => 0),
        uninstallEntries: async () => [],
        setTimeout: (fn, ms) => void timers.push({ fn, ms }),
        ...io
      },
      ...overrides
    }
  }

  const rom = (id: string, rel: string, extra?: Game['extra']): Game =>
    game({ id, source: 'rom', platformId: 'psx', externalId: rel, romPath: join(root, rel), extra })

  beforeEach(async () => {
    root = join(await fs.mkdtemp(join(tmpdir(), 'playout-del-')), 'roms')
    await fs.mkdir(join(root, 'psx'), { recursive: true })
    games = new Map()
    trash = vi.fn(async () => undefined)
    timers = []
  })
  afterEach(async () => {
    await fs.rm(join(root, '..'), { recursive: true, force: true })
  })

  async function write(rel: string, text: string): Promise<string> {
    const path = join(root, rel)
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, text)
    return path
  }

  it("bins a ROM's whole file set, then forgets the game", async () => {
    const cue = await write('psx/Game.cue', 'FILE "Game.bin" BINARY\n')
    const bin = await write('psx/Game.bin', '0123456789')
    games.set('rom:a', rom('rom:a', 'psx/Game.cue'))
    const d = deps()
    const service = createLocalDeleteService(d)
    const plan = await service.plan('rom:a')
    expect(plan.kind).toBe('files')
    expect(plan.paths.map((p) => p.toLowerCase()).sort()).toEqual(
      [cue, bin].map((p) => p.toLowerCase()).sort()
    )
    expect(plan.totalBytes).toBe(10 + 'FILE "Game.bin" BINARY\n'.length)
    const result = await service.run('rom:a')
    expect(result).toMatchObject({ ok: true, removed: true })
    expect(trash).toHaveBeenCalledTimes(2)
    expect(d.imageCache.remove).toHaveBeenCalledWith('rom:a')
    expect(d.library.removeGame).toHaveBeenCalledWith('rom:a')
  })

  it('keeps files another game of the library also uses', async () => {
    await write('psx/Multi.m3u', 'D1.cue\nD2.cue\n')
    await write('psx/D1.cue', 'FILE "D1.bin" BINARY\n')
    await write('psx/D1.bin', 'x')
    await write('psx/D2.cue', 'FILE "D2.bin" BINARY\n')
    await write('psx/D2.bin', 'y')
    games.set('rom:m', rom('rom:m', 'psx/Multi.m3u'))
    games.set('rom:d1', rom('rom:d1', 'psx/D1.cue'))
    const plan = await createLocalDeleteService(deps()).plan('rom:m')
    expect(plan.kind).toBe('files')
    const names = (list: string[] | undefined): string[] =>
      (list ?? []).map((p) => p.split(/[\\/]/).pop() as string).sort()
    expect(names(plan.paths)).toEqual(['D2.bin', 'D2.cue', 'Multi.m3u'])
    expect(names(plan.kept)).toEqual(['D1.bin', 'D1.cue'])
    // The disc on its own: every file is the playlist's too.
    const solo = await createLocalDeleteService(deps()).plan('rom:d1')
    expect(solo.kind).toBe('remove-only')
  })

  it('bins a PS4 dump folder whole, but never a system folder of the ROM folder', async () => {
    const eboot = await write('ps4/Dump/eboot.bin', 'e')
    games.set('rom:p', {
      ...rom('rom:p', 'ps4/Dump/eboot.bin', { gameFolder: join(root, 'ps4', 'Dump') }),
      platformId: 'ps4'
    })
    const plan = await createLocalDeleteService(deps()).plan('rom:p')
    expect(plan).toMatchObject({ kind: 'files', paths: [join(root, 'ps4', 'Dump')] })
    expect(eboot).toBeTruthy()
    games.set('rom:q', {
      ...rom('rom:q', 'ps4/eboot.bin', { gameFolder: join(root, 'ps4') }),
      platformId: 'ps4'
    })
    await write('ps4/eboot.bin', 'e')
    expect((await createLocalDeleteService(deps()).plan('rom:q')).kind).toBe('remove-only')
  })

  it('refuses a ROM outside the ROM folder', async () => {
    const outside = join(root, '..', 'elsewhere.iso')
    await fs.writeFile(outside, 'x')
    games.set('rom:o', game({ id: 'rom:o', source: 'rom', externalId: 'x', romPath: outside }))
    const plan = await createLocalDeleteService(deps()).plan('rom:o')
    expect(plan.kind).toBe('remove-only')
    expect(trash).not.toHaveBeenCalled()
  })

  describe("a recompilation's original disc image", () => {
    const keep = (): LocalDeleteDeps['library'] => ({
      getGame: (id) => games.get(id),
      games: () => [...games.values()],
      removeGame: vi.fn((id: string) => void games.delete(id)),
      markRomRemoved: vi.fn((id: string, recompId: string) => {
        const g = games.get(id)!
        g.romRemoved = { at: 'now', recompId, romPath: g.romPath! }
        delete g.romPath
      })
    })

    it('bins the whole file set through the injected trash and keeps the card', async () => {
      const cue = await write('psx/Game.cue', 'FILE "Game.bin" BINARY\n')
      const bin = await write('psx/Game.bin', '0123456789')
      games.set('rom:a', rom('rom:a', 'psx/Game.cue'))
      const library = keep()
      const forgetRomSet = vi.fn()
      const service = createLocalDeleteService(deps({ library, forgetRomSet }))
      const plan = await service.imagePlan('rom:a')
      expect('paths' in plan && plan.paths.map((p) => p.toLowerCase()).sort()).toEqual(
        [cue, bin].map((p) => p.toLowerCase()).sort()
      )
      expect(await service.trashImage('rom:a', 'github:a/b')).toEqual({
        ok: true,
        message: 'Moved Game.cue to the Recycle Bin'
      })
      expect(trash).toHaveBeenCalledTimes(2)
      expect(library.markRomRemoved).toHaveBeenCalledWith('rom:a', 'github:a/b')
      expect(library.removeGame).not.toHaveBeenCalled()
      expect(forgetRomSet).toHaveBeenCalledWith('rom:a')
      expect(games.get('rom:a')).toMatchObject({ romRemoved: { recompId: 'github:a/b' } })
      // The kept card: Delete from this PC only offers to remove it, and there is no image left to offer.
      expect(await service.plan('rom:a')).toMatchObject({
        kind: 'remove-only',
        reason: /already in the Recycle Bin/
      })
      expect(await service.imagePlan('rom:a')).toMatchObject({ refusal: /no disc image/ })
    })

    it('never moves an image in use (a conversion, a download by a paired PC, an emulator)', async () => {
      const iso = await write('psx/Solo.iso', 'x')
      games.set('rom:s', rom('rom:s', 'psx/Solo.iso'))
      const library = keep()
      const converting = createLocalDeleteService(
        deps({ library, convertRunning: async () => true })
      )
      expect(await converting.trashImage('rom:s', 'r')).toMatchObject({
        ok: false,
        message: /conversion/
      })
      const sending = createLocalDeleteService(deps({ library, filesBeingSent: () => [iso] }))
      expect(await sending.imagePlan('rom:s')).toMatchObject({ refusal: /downloading/ })
      const running = createLocalDeleteService(
        deps({ library, running: () => ({ gameId: 'rom:s' }) })
      )
      expect(await running.imagePlan('rom:s')).toMatchObject({ refusal: /running/ })
      // The game running is its recompilation (which does not read the image): it may go.
      expect(await running.imagePlan('rom:s', { recompRunning: true })).toMatchObject({
        paths: [iso]
      })
      expect(trash).not.toHaveBeenCalled()
      expect(library.markRomRemoved).not.toHaveBeenCalled()
    })

    it('changes nothing when the Recycle Bin refuses the first file', async () => {
      await write('psx/Solo.iso', 'x')
      games.set('rom:s', rom('rom:s', 'psx/Solo.iso'))
      trash.mockRejectedValueOnce(new Error('no recycle bin'))
      const library = keep()
      const result = await createLocalDeleteService(deps({ library })).trashImage('rom:s', 'r')
      expect(result).toMatchObject({ ok: false, message: /Nothing was deleted/ })
      expect(library.markRomRemoved).not.toHaveBeenCalled()
      expect(games.get('rom:s')?.romPath).toBeTruthy()
    })

    it('moves the tracks first and the sheet last; a set moved only in part keeps its sheet and its ROM card', async () => {
      const cue = await write('psx/Multi.cue', 'FILE "Multi (Track 1).bin" BINARY\n')
      const t1 = await write('psx/Multi (Track 1).bin', '1')
      const t2 = await write('psx/Multi (Track 2).bin', '2')
      await fs.appendFile(cue, 'FILE "Multi (Track 2).bin" BINARY\n')
      games.set('rom:m', rom('rom:m', 'psx/Multi.cue'))
      expect(imageTrashOrder([cue, t2, t1], cue).slice(-1)).toEqual([cue])
      expect(imageTrashOrder(['D:\\g.m3u', 'D:\\d1.cue', 'D:\\d1.bin'], 'D:\\g.m3u')).toEqual([
        'D:\\d1.bin',
        'D:\\d1.cue',
        'D:\\g.m3u'
      ])
      // The second track is locked: the first went, the sheet stays and still lists what is left.
      trash.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('locked'))
      const library = keep()
      const result = await createLocalDeleteService(deps({ library })).trashImage('rom:m', 'r')
      expect(result).toMatchObject({ ok: false, message: /Only 1 of 3 files/ })
      expect(trash.mock.calls.map(([p]) => String(p).toLowerCase())).not.toContain(
        cue.toLowerCase()
      )
      expect(library.markRomRemoved).not.toHaveBeenCalled()
      expect(games.get('rom:m')?.romPath).toBeTruthy()
    })
  })

  describe("a recompilation's disc image moved aside for its test run", () => {
    const keep = (): LocalDeleteDeps['library'] => ({
      getGame: (id) => games.get(id),
      games: () => [...games.values()],
      removeGame: vi.fn((id: string) => void games.delete(id)),
      markRomRemoved: vi.fn((id: string, recompId: string) => {
        const g = games.get(id)!
        g.romRemoved = { at: 'now', recompId, romPath: g.romPath! }
        delete g.romPath
      }),
      restoreRomRemoved: vi.fn((id: string) => {
        const g = games.get(id)!
        g.romPath = g.romRemoved!.romPath
        delete g.romRemoved
      })
    })
    const ID = 'm3x9k2-4f7a1c'
    const there = (p: string): Promise<boolean> =>
      fs.stat(p).then(
        () => true,
        () => false
      )

    it('records, then moves the whole set aside beside it (no Recycle Bin), and keeps the card', async () => {
      const cue = await write('psx/Game.cue', 'FILE "Game.bin" BINARY\n')
      const bin = await write('psx/Game.bin', '0123456789')
      games.set('rom:a', rom('rom:a', 'psx/Game.cue'))
      const library = keep()
      const recorded: HeldEntry[][] = []
      const service = createLocalDeleteService(deps({ library }))
      const held = await service.holdImage('rom:a', 'github:a/b', ID, {
        beforeMove: async (entries) => {
          // Recorded before anything moves.
          expect(await there(cue)).toBe(true)
          recorded.push(entries)
        }
      })
      expect(held).toMatchObject({ ok: true, message: 'Moved Game.cue aside' })
      const entries = held.ok ? held.entries : []
      expect(recorded).toEqual([entries])
      // The data file first, the card's own file last; each beside itself in .playout-held\<id>.
      expect(entries.map((e) => e.original.toLowerCase())).toEqual(
        [bin, cue].map((p) => p.toLowerCase())
      )
      expect(entries[1]!.held).toBe(join(root, 'psx', HELD_DIR, ID, 'Game.cue'))
      expect(await there(cue)).toBe(false)
      expect(await fs.readFile(entries[1]!.held, 'utf8')).toContain('Game.bin')
      expect(trash).not.toHaveBeenCalled()
      expect(library.markRomRemoved).toHaveBeenCalledWith('rom:a', 'github:a/b')

      // Restore: back exactly, an ordinary ROM card again.
      const back = await service.restoreHeld(entries, ID, { gameId: 'rom:a', image: cue })
      expect(back).toMatchObject({ ok: true, left: [] })
      expect(await fs.readFile(cue, 'utf8')).toContain('Game.bin')
      expect(await fs.readFile(bin, 'utf8')).toBe('0123456789')
      expect(library.restoreRomRemoved).toHaveBeenCalledWith('rom:a')
      expect(games.get('rom:a')?.romPath).toBe(join(root, 'psx', 'Game.cue'))
      expect(await there(join(root, 'psx', HELD_DIR))).toBe(false)
    })

    it('Delete anyway / a passed test trashes the held files through the injected trash only', async () => {
      await write('psx/Solo.iso', 'x')
      games.set('rom:s', rom('rom:s', 'psx/Solo.iso'))
      const service = createLocalDeleteService(deps({ library: keep() }))
      const held = await service.holdImage('rom:s', 'r', ID, { beforeMove: async () => {} })
      expect(held.ok).toBe(true)
      const entries = held.ok ? held.entries : []
      expect(await service.releaseHeld(entries, ID)).toMatchObject({ ok: true, left: [] })
      expect(trash).toHaveBeenCalledWith(join(root, 'psx', HELD_DIR, ID, 'Solo.iso'))
    })

    it('keeps every guard of the image (a conversion running) and moves nothing then', async () => {
      const iso = await write('psx/Solo.iso', 'x')
      games.set('rom:s', rom('rom:s', 'psx/Solo.iso'))
      const library = keep()
      const service = createLocalDeleteService(deps({ library, convertRunning: async () => true }))
      const before = vi.fn(async () => {})
      expect(await service.holdImage('rom:s', 'r', ID, { beforeMove: before })).toMatchObject({
        ok: false,
        message: /conversion/,
        stuck: []
      })
      expect(before).not.toHaveBeenCalled()
      expect(await there(iso)).toBe(true)
      expect(library.markRomRemoved).not.toHaveBeenCalled()
    })

    it('a rename that fails puts back what moved, and the card stays a ROM card', async () => {
      const cue = await write('psx/Game.cue', 'FILE "Game.bin" BINARY\n')
      const bin = await write('psx/Game.bin', '0')
      games.set('rom:a', rom('rom:a', 'psx/Game.cue'))
      const library = keep()
      let n = 0
      const service = createLocalDeleteService(
        deps(
          { library },
          {
            rename: async (from, to) => {
              if (++n === 2) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
              await fs.rename(from, to)
            }
          }
        )
      )
      const held = await service.holdImage('rom:a', 'r', ID, { beforeMove: async () => {} })
      expect(held).toMatchObject({ ok: false, message: /Nothing was deleted: .*own drive/ })
      expect(await there(cue)).toBe(true)
      expect(await there(bin)).toBe(true)
      expect(library.markRomRemoved).not.toHaveBeenCalled()
    })

    it('holds an unpacked game folder behind the folder guards', async () => {
      const home = join(root, '..', 'home')
      const dir = join(home, 'Games', 'Burnout Revenge', 'game')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, 'default.xex'), 'xex')
      const service = createLocalDeleteService(deps({ protectedFolders: () => [home] }))
      const held = await service.holdUnpackedFolder(dir, ID, { beforeMove: async () => {} })
      expect(held).toMatchObject({ ok: true })
      expect(await there(join(home, 'Games', 'Burnout Revenge', HELD_DIR, ID, 'game'))).toBe(true)
      expect(await service.restoreHeld(held.ok ? held.entries : [], ID, null)).toMatchObject({
        ok: true
      })
      expect(await fs.readFile(join(dir, 'default.xex'), 'utf8')).toBe('xex')
      // A known folder is never held.
      expect(
        await service.holdUnpackedFolder(home, ID, { beforeMove: async () => {} })
      ).toMatchObject({ ok: false })
    })

    it("Delete from this PC refuses a game folder that holds a recompilation's held image", async () => {
      await write('psx/Folder Game/Game.cue', 'x')
      await fs.mkdir(join(root, 'psx', 'Folder Game', HELD_DIR, ID), { recursive: true })
      games.set(
        'rom:f',
        rom('rom:f', 'psx/Folder Game', { gameFolder: join(root, 'psx', 'Folder Game') })
      )
      const service = createLocalDeleteService(deps())
      expect(await service.plan('rom:f')).toMatchObject({ kind: 'refused', reason: /keeps aside/ })
    })
  })

  describe("a recompilation's unpacked game folder", () => {
    /** A folder like %USERPROFILE%\Games\Burnout Revenge\game in the test's temp folder. */
    async function unpacked(): Promise<{ home: string; dir: string }> {
      const home = join(root, '..', 'home')
      const dir = join(home, 'Games', 'Burnout Revenge', 'game')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, 'default.xex'), 'xex')
      return { home, dir }
    }

    it('moves the folder to the Recycle Bin through the injected trash only', async () => {
      const { home, dir } = await unpacked()
      const service = createLocalDeleteService(deps({ protectedFolders: () => [home] }))
      expect(await service.unpackedFolderPlan(dir)).toEqual({ totalBytes: 3 })
      expect(await service.trashUnpackedFolder(dir)).toEqual({
        ok: true,
        message: `Moved ${dir} to the Recycle Bin`
      })
      expect(trash).toHaveBeenCalledWith(dir)
      expect((await fs.stat(dir)).isDirectory()).toBe(true)
    })

    it('never moves a known folder, a folder right in one, a drive top or PlayOut’s own folders', async () => {
      const { home, dir } = await unpacked()
      const games = join(home, 'Games')
      const service = createLocalDeleteService(
        deps({
          protectedFolders: () => [home, games],
          appFolders: () => [join(home, 'Games', 'Burnout Revenge', 'game', 'Emulation')]
        })
      )
      expect(await service.unpackedFolderPlan(home)).toMatchObject({ refusal: /system or user/ })
      expect(await service.unpackedFolderPlan(games)).toMatchObject({ refusal: /system or user/ })
      expect(await service.unpackedFolderPlan(join(games, 'Burnout Revenge'))).toMatchObject({
        refusal: /right in a system or user folder/
      })
      expect(await service.unpackedFolderPlan(dir)).toMatchObject({ refusal: /PlayOut/ })
      expect(await service.unpackedFolderPlan(parse(dir).root)).toMatchObject({
        refusal: /top of a drive/
      })
      expect(await service.trashUnpackedFolder(dir)).toMatchObject({
        ok: false,
        message: /Nothing was deleted/
      })
      expect(trash).not.toHaveBeenCalled()
    })

    it('never moves a folder a paired PC downloads from, a missing one or a file', async () => {
      const { home, dir } = await unpacked()
      const sending = createLocalDeleteService(
        deps({ protectedFolders: () => [home], filesBeingSent: () => [join(dir, 'default.xex')] })
      )
      expect(await sending.unpackedFolderPlan(dir)).toMatchObject({ refusal: /downloading/ })
      const service = createLocalDeleteService(deps({ protectedFolders: () => [home] }))
      expect(await service.unpackedFolderPlan(join(dir, 'gone'))).toMatchObject({
        refusal: /not there/
      })
      expect(await service.unpackedFolderPlan(join(dir, 'default.xex'))).toMatchObject({
        refusal: /not a folder/
      })
      expect(trash).not.toHaveBeenCalled()
    })

    it('reports a Recycle Bin refusal and deletes nothing', async () => {
      const { home, dir } = await unpacked()
      trash.mockRejectedValueOnce(new Error('no recycle bin'))
      const result = await createLocalDeleteService(
        deps({ protectedFolders: () => [home] })
      ).trashUnpackedFolder(dir)
      expect(result).toMatchObject({ ok: false, message: /Nothing was deleted/ })
      expect((await fs.stat(dir)).isDirectory()).toBe(true)
    })
  })

  it('keeps the record when the Recycle Bin refuses (never deletes for good)', async () => {
    await write('psx/Solo.iso', 'x')
    games.set('rom:s', rom('rom:s', 'psx/Solo.iso'))
    trash.mockRejectedValueOnce(new Error('no recycle bin'))
    const d = deps()
    const result = await createLocalDeleteService(d).run('rom:s')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Nothing was deleted/)
    expect(d.library.removeGame).not.toHaveBeenCalled()
    expect(games.has('rom:s')).toBe(true)
  })

  it('refuses running, queued, host-only and uninstalled games', async () => {
    await write('psx/Solo.iso', 'x')
    games.set('rom:s', rom('rom:s', 'psx/Solo.iso'))
    games.set('steam:1', game({ id: 'steam:1', source: 'steam', installed: false }))
    games.set('remote:h:rom:x', game({ id: 'remote:h:rom:x', source: 'rom', remote: {} as never }))
    const running = createLocalDeleteService(deps({ running: () => ({ gameId: 'rom:s' }) }))
    expect(await running.plan('rom:s')).toMatchObject({ kind: 'refused', reason: /running/ })
    const queued = createLocalDeleteService(deps({ busyIds: () => ['remote:host1:rom:s'] }))
    expect(await queued.plan('rom:s')).toMatchObject({ kind: 'refused', reason: /queue/ })
    const service = createLocalDeleteService(deps())
    expect((await service.plan('steam:1')).kind).toBe('refused')
    expect((await service.plan('remote:h:rom:x')).kind).toBe('refused')
    expect((await service.plan('nope')).kind).toBe('refused')
    const result = await running.run('rom:s')
    expect(result.ok).toBe(false)
    expect(trash).not.toHaveBeenCalled()
  })

  it('refuses a game an upgrade is changing, and starts no uninstall', async () => {
    games.set('steam:620', game({ id: 'steam:620', source: 'steam', extra: { steamAppId: 620 } }))
    const d = deps({ upgradeRunning: (id) => id === 'steam:620' })
    const service = createLocalDeleteService(d)
    expect(await service.plan('steam:620')).toMatchObject({
      kind: 'refused',
      reason: upgradeRunningMessage(tMain)
    })
    expect((await service.run('steam:620')).ok).toBe(false)
    expect(d.library.removeGame).not.toHaveBeenCalled()
  })

  it("starts Steam's uninstall, keeps the record and rescans Steam later", async () => {
    games.set('steam:620', game({ id: 'steam:620', source: 'steam', extra: { steamAppId: 620 } }))
    const d = deps()
    const service = createLocalDeleteService(d)
    expect(await service.plan('steam:620')).toMatchObject({ kind: 'store', storeName: 'Steam' })
    const result = await service.run('steam:620')
    expect(result).toMatchObject({
      ok: true,
      removed: false,
      message: 'Steam is uninstalling steam:620'
    })
    expect(d.io?.openExternal).toHaveBeenCalledWith('steam://uninstall/620')
    expect(d.library.removeGame).not.toHaveBeenCalled()
    expect(timers.map((t) => t.ms)).toEqual(STORE_RESCAN_DELAYS_MS)
    timers.forEach((t) => t.fn())
    expect(d.rescan).toHaveBeenCalledWith('steam')
  })

  it("runs GOG Galaxy's uninstall command with an argv array", async () => {
    games.set('gog:1207658924', game({ id: 'gog:1207658924', source: 'gog' }))
    const d = deps({}, { stat: async () => ({ size: 1, dir: false }) })
    await createLocalDeleteService(d).run('gog:1207658924')
    expect(d.io?.spawn).toHaveBeenCalledWith(
      'C:\\GOG\\GalaxyClient.exe',
      ['/command=uninstall', '/gameId=1207658924'],
      expect.objectContaining({ shell: false })
    )
  })

  it("runs the EA game's registry uninstaller, else opens the store library", async () => {
    games.set('ea:1', game({ id: 'ea:1', source: 'ea', installDir: 'D:\\EA Games\\Foo' }))
    const entries = [
      entry({
        installLocation: 'D:\\EA Games\\Foo',
        uninstallString: '"C:\\EA\\EAUninstall.exe" /id 1'
      })
    ]
    const d = deps(
      {},
      { uninstallEntries: async () => entries, stat: async () => ({ size: 1, dir: false }) }
    )
    const result = await createLocalDeleteService(d).run('ea:1')
    expect(result.ok).toBe(true)
    expect(d.io?.spawn).toHaveBeenCalledWith(
      'C:\\EA\\EAUninstall.exe',
      ['/id', '1'],
      expect.anything()
    )

    games.set(
      'battlenet:d3',
      game({ id: 'battlenet:d3', source: 'battlenet', installDir: 'D:\\D3' })
    )
    const none = deps()
    const fallback = await createLocalDeleteService(none).run('battlenet:d3')
    expect(fallback.message).toMatch(/Battle.net is open/)
    expect(none.io?.openExternal).toHaveBeenCalledWith('battlenet://')
    expect(none.io?.spawn).not.toHaveBeenCalled()
  })

  it("runs a manual game's uninstaller, keeps the record and removes it once the game is gone", async () => {
    games.set(
      'manual:a',
      game({
        id: 'manual:a',
        source: 'manual',
        installDir: 'D:\\Games\\A',
        exePath: 'D:\\Games\\A\\a.exe'
      })
    )
    const entries = [
      entry({ installLocation: 'D:\\Games\\A', uninstallString: '"D:\\Games\\A\\unins000.exe"' })
    ]
    let gone = false
    const d = deps(
      {},
      {
        uninstallEntries: async () => entries,
        stat: async (p: string) => (!gone || p === 'D:\\' ? { size: 1, dir: gone } : null)
      }
    )
    const service = createLocalDeleteService(d)
    expect(await service.plan('manual:a')).toMatchObject({
      kind: 'uninstaller',
      paths: ['D:\\Games\\A\\unins000.exe']
    })
    expect(await service.run('manual:a')).toMatchObject({
      ok: true,
      removed: false,
      message: "manual:a's uninstaller is open"
    })
    // Started, not finished (it may be cancelled): the record stays.
    expect(d.library.removeGame).not.toHaveBeenCalled()
    expect(timers.map((t) => t.ms)).toEqual(STORE_RESCAN_DELAYS_MS)
    // 1 minute: the game is still there.
    timers[0].fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.library.removeGame).not.toHaveBeenCalled()
    // 3 minutes: its program is gone (the drive is there): the record leaves.
    gone = true
    timers[1].fn()
    await vi.waitFor(() => expect(d.library.removeGame).toHaveBeenCalledWith('manual:a'))
    timers[2].fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.library.removeGame).toHaveBeenCalledTimes(1)
  })

  it("never runs an uninstaller whose folder holds another library game (SKSE in Steam's Skyrim folder)", async () => {
    const skyrim = 'C:\\Steam\\steamapps\\common\\Skyrim Special Edition'
    games.set(
      'steam:489830',
      game({
        id: 'steam:489830',
        source: 'steam',
        installDir: skyrim,
        extra: { steamAppId: 489830 }
      })
    )
    games.set(
      'manual:skse',
      game({
        id: 'manual:skse',
        source: 'manual',
        installDir: skyrim,
        exePath: `${skyrim}\\skse64_loader.exe`
      })
    )
    const entries = [
      entry({
        installLocation: skyrim,
        uninstallString: '"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/489830'
      })
    ]
    const d = deps(
      {},
      { uninstallEntries: async () => entries, stat: async () => ({ size: 1, dir: false }) }
    )
    const service = createLocalDeleteService(d)
    expect(await service.plan('manual:skse')).toMatchObject({
      kind: 'remove-only',
      reason: /also holds steam:489830/
    })
    expect((await service.run('manual:skse')).ok).toBe(false)
    expect(d.io?.spawn).not.toHaveBeenCalled()

    // Even its own uninstaller in its own subfolder: that folder is inside steamapps, a store's library.
    games.set(
      'manual:skse',
      game({
        id: 'manual:skse',
        source: 'manual',
        installDir: `${skyrim}\\SKSE`,
        exePath: `${skyrim}\\SKSE\\skse64_loader.exe`
      })
    )
    const nested = [
      entry({
        installLocation: `${skyrim}\\SKSE`,
        uninstallString: `"${skyrim}\\SKSE\\unins000.exe"`
      })
    ]
    const d2 = deps(
      {},
      { uninstallEntries: async () => nested, stat: async () => ({ size: 1, dir: false }) }
    )
    expect(await createLocalDeleteService(d2).plan('manual:skse')).toMatchObject({
      kind: 'remove-only',
      reason: /steamapps/
    })

    // Outside a store library, a mod's own uninstaller in its own subfolder only removes that subfolder: it may run.
    const game1 = 'D:\\Games\\Game1'
    games.clear()
    games.set(
      'manual:game1',
      game({
        id: 'manual:game1',
        source: 'manual',
        installDir: game1,
        exePath: `${game1}\\game1.exe`
      })
    )
    games.set(
      'manual:mod',
      game({
        id: 'manual:mod',
        source: 'manual',
        installDir: `${game1}\\Mod`,
        exePath: `${game1}\\Mod\\mod_loader.exe`
      })
    )
    const own = [
      entry({ installLocation: `${game1}\\Mod`, uninstallString: `"${game1}\\Mod\\unins000.exe"` })
    ]
    const d3 = deps(
      {},
      { uninstallEntries: async () => own, stat: async () => ({ size: 1, dir: false }) }
    )
    expect((await createLocalDeleteService(d3).plan('manual:mod')).kind).toBe('uninstaller')
  })

  it('keeps an uninstalled manual game while its program or folder exists, whatever the registry says', async () => {
    games.set(
      'manual:a',
      game({
        id: 'manual:a',
        source: 'manual',
        installDir: 'D:\\Games\\A',
        exePath: 'D:\\Games\\A\\a.exe'
      })
    )
    let entries: UninstallEntry[] | null = [
      entry({ installLocation: 'D:\\Games\\A', uninstallString: '"D:\\Games\\A\\unins000.exe"' })
    ]
    // What exists on disk: the drive, the folder, the program, the uninstaller.
    const present = new Set([
      'D:\\',
      'D:\\Games\\A',
      'D:\\Games\\A\\a.exe',
      'D:\\Games\\A\\unins000.exe'
    ])
    const d = deps(
      {},
      {
        uninstallEntries: async () => {
          if (!entries) throw new Error('registry unreadable')
          return entries
        },
        stat: async (p: string) => (present.has(p) ? { size: 1, dir: !p.endsWith('.exe') } : null)
      }
    )
    await createLocalDeleteService(d).run('manual:a')
    // The entry is gone (or the list is partial / unreadable) but the game is still on disk: the record stays.
    entries = [entry({ installLocation: 'D:\\Other', uninstallString: '"D:\\Other\\u.exe"' })]
    timers[0].fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.library.removeGame).not.toHaveBeenCalled()
    // Still kept at the next check while the program is there (a cancelled uninstall leaves it in place).
    entries = null
    timers[1].fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.library.removeGame).not.toHaveBeenCalled()
    // The program is gone while the drive is there: uninstalled, even though the uninstaller left the folder (saves,
    // settings): the record leaves (registry unreadable or not).
    present.delete('D:\\Games\\A\\a.exe')
    timers[2].fn()
    await vi.waitFor(() => expect(d.library.removeGame).toHaveBeenCalledWith('manual:a'))
  })

  it('keeps an uninstalled manual game whose drive is missing (unplugged, not uninstalled)', async () => {
    games.set(
      'manual:a',
      game({
        id: 'manual:a',
        source: 'manual',
        installDir: 'D:\\Games\\A',
        exePath: 'D:\\Games\\A\\a.exe'
      })
    )
    const entries = [
      entry({ installLocation: 'D:\\Games\\A', uninstallString: '"D:\\Games\\A\\unins000.exe"' })
    ]
    let unplugged = false
    const d = deps(
      {},
      {
        uninstallEntries: async () => (unplugged ? [] : entries),
        stat: async () => (unplugged ? null : { size: 1, dir: false })
      }
    )
    await createLocalDeleteService(d).run('manual:a')
    unplugged = true
    for (const t of timers) t.fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(d.library.removeGame).not.toHaveBeenCalled()
  })

  it('keeps a manual game whose uninstaller ran when one registry hive could not be read', async () => {
    games.set(
      'manual:a',
      game({
        id: 'manual:a',
        source: 'manual',
        installDir: 'D:\\Games\\A',
        exePath: 'D:\\Games\\A\\a.exe'
      })
    )
    const mine = entry({
      installLocation: 'D:\\Games\\A',
      uninstallString: '"D:\\Games\\A\\unins000.exe"'
    })
    const other = entry({ installLocation: 'D:\\Other', uninstallString: '"D:\\Other\\u.exe"' })
    let partial = false
    const uninstallEntries = vi.fn(async (options?: { complete?: boolean }) => {
      // The WOW6432Node hive holding the game's entry timed out: the merged list is non-empty but lacks it.
      if (!partial) return [mine, other]
      if (options?.complete) throw new Error('uninstall entries HKLM/x86 could not be read')
      return [other]
    })
    const d = deps({}, { uninstallEntries, stat: async () => ({ size: 1, dir: false }) })
    await createLocalDeleteService(d).run('manual:a')
    partial = true
    for (const t of timers) t.fn()
    await new Promise((r) => setTimeout(r, 10))
    // The registry is never what decides the game is gone.
    expect(uninstallEntries).not.toHaveBeenCalledWith({ complete: true })
    expect(d.library.removeGame).not.toHaveBeenCalled()
  })

  it('checks for another library game in the folder before looking for an uninstaller', async () => {
    games.set(
      'manual:pack',
      game({
        id: 'manual:pack',
        source: 'manual',
        installDir: 'D:\\Games\\Pack',
        exePath: 'D:\\Games\\Pack\\pack.exe'
      })
    )
    games.set(
      'manual:inner',
      game({ id: 'manual:inner', source: 'manual', exePath: 'D:\\Games\\Pack\\Inner\\inner.exe' })
    )
    const uninstallEntries = vi.fn(async () => [
      entry({
        installLocation: 'D:\\Games\\Pack',
        uninstallString: '"D:\\Games\\Pack\\unins000.exe"'
      })
    ])
    const d = deps({}, { uninstallEntries, stat: async () => ({ size: 1, dir: false }) })
    const service = createLocalDeleteService(d)
    expect(await service.plan('manual:pack')).toEqual({
      gameId: 'manual:pack',
      kind: 'remove-only',
      reason: 'D:\\Games\\Pack also holds manual:inner',
      paths: []
    })
    expect(uninstallEntries).not.toHaveBeenCalled()
    expect((await service.run('manual:pack')).ok).toBe(false)
    expect(d.io?.spawn).not.toHaveBeenCalled()
  })

  it("never runs a store's uninstall entry for a manual game", async () => {
    const cases: { dir: string; entry: UninstallEntry; reason: RegExp }[] = [
      {
        // A store game also added by hand: its entry runs the store client.
        dir: 'D:\\Games\\Portal',
        entry: entry({
          installLocation: 'D:\\Games\\Portal',
          uninstallString: '"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/400'
        }),
        reason: /store's program \(steam\.exe\)/
      },
      {
        dir: 'E:\\SteamLibrary\\steamapps\\common\\Portal',
        entry: entry({
          installLocation: 'E:\\SteamLibrary\\steamapps\\common\\Portal',
          uninstallString: '"E:\\SteamLibrary\\steamapps\\common\\Portal\\unins000.exe"'
        }),
        reason: /store's library or folder \(steamlibrary\)/i
      },
      {
        dir: 'D:\\Games\\AC',
        entry: entry({
          installLocation: 'D:\\Games\\AC',
          uninstallString:
            '"C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe" uplay://uninstall/1'
        }),
        reason: /store's program \(upc\.exe\)/
      }
    ]
    for (const c of cases) {
      games.clear()
      games.set(
        'manual:g',
        game({ id: 'manual:g', source: 'manual', installDir: c.dir, exePath: `${c.dir}\\g.exe` })
      )
      const d = deps(
        {},
        { uninstallEntries: async () => [c.entry], stat: async () => ({ size: 1, dir: false }) }
      )
      const service = createLocalDeleteService(d)
      expect(await service.plan('manual:g')).toMatchObject({
        kind: 'remove-only',
        reason: c.reason
      })
      expect((await service.run('manual:g')).ok).toBe(false)
      expect(d.io?.spawn).not.toHaveBeenCalled()
    }
  })

  it("runs a GOG offline install's own uninstaller from GOG Games for a manual game", async () => {
    const dir = 'C:\\GOG Games\\The Witcher 3'
    games.clear()
    games.set(
      'manual:w3',
      game({ id: 'manual:w3', source: 'manual', installDir: dir, exePath: `${dir}\\w3.exe` })
    )
    const d = deps(
      {},
      {
        uninstallEntries: async () => [
          entry({ installLocation: dir, uninstallString: `"${dir}\\unins000.exe"` })
        ],
        stat: async () => ({ size: 1, dir: false })
      }
    )
    expect(await createLocalDeleteService(d).plan('manual:w3')).toEqual({
      gameId: 'manual:w3',
      kind: 'uninstaller',
      paths: [`${dir}\\unins000.exe`]
    })
  })

  it('says only Windows Settings opens for an Xbox game', async () => {
    games.set('xbox:halo', game({ id: 'xbox:halo', source: 'xbox' }))
    const d = deps()
    const service = createLocalDeleteService(d)
    expect(await service.plan('xbox:halo')).toMatchObject({ kind: 'store', opens: 'settings' })
    expect(await service.run('xbox:halo')).toMatchObject({
      ok: true,
      removed: false,
      message: 'Windows Settings is open: uninstall xbox:halo from Apps there'
    })
    expect(d.io?.openExternal).toHaveBeenCalledWith('ms-settings:appsfeatures')
    games.set('steam:1', game({ id: 'steam:1', source: 'steam', extra: { steamAppId: 1 } }))
    expect((await service.plan('steam:1')).opens).toBeUndefined()
  })

  describe("a manual game's folder that may hold more than one game", () => {
    let lib: string
    async function mk(rel: string, text = 'x'): Promise<string> {
      const path = join(lib, rel)
      await fs.mkdir(join(path, '..'), { recursive: true })
      await fs.writeFile(path, text)
      return path
    }
    const manual = (dir: string, exe: string): Game =>
      game({
        id: 'manual:m',
        source: 'manual',
        installDir: join(lib, dir),
        exePath: join(lib, exe)
      })
    beforeEach(() => {
      lib = join(root, '..', 'Library')
    })

    it('bins a game folder with its own helpers', async () => {
      await mk('Hades/Hades.exe')
      await mk('Hades/x64/Hades-Win64.exe')
      await mk('Hades/_CommonRedist/vcredist_x64.exe')
      await mk('Hades/unins000.exe')
      games.set('manual:m', manual('Hades', 'Hades/Hades.exe'))
      const plan = await createLocalDeleteService(deps()).plan('manual:m')
      expect(plan).toMatchObject({ kind: 'files', paths: [join(lib, 'Hades')], folder: true })
    })

    it('refuses a folder another library game is in', async () => {
      await mk('Hades/Hades.exe')
      games.set('manual:m', manual('', 'Hades/Hades.exe'))
      games.set(
        'steam:9',
        game({ id: 'steam:9', source: 'steam', title: 'Celeste', installDir: join(lib, 'Celeste') })
      )
      const plan = await createLocalDeleteService(deps()).plan('manual:m')
      expect(plan).toMatchObject({ kind: 'remove-only', reason: /also holds Celeste/ })
    })

    it("refuses a folder holding a store's library or a launcher", async () => {
      await mk('Hades/Hades.exe')
      await mk('steamapps/libraryfolder.vdf')
      games.set('manual:m', manual('', 'Hades/Hades.exe'))
      expect(await createLocalDeleteService(deps()).plan('manual:m')).toMatchObject({
        kind: 'remove-only',
        reason: /holds steamapps/
      })
      await fs.rm(join(lib, 'steamapps'), { recursive: true })
      await mk('Hades/steam.exe')
      expect(await createLocalDeleteService(deps()).plan('manual:m')).toMatchObject({
        kind: 'remove-only',
        reason: /steam\.exe/
      })
    })

    it('refuses a folder with programs of different games, side by side or in subfolders', async () => {
      await mk('Hades.exe')
      await mk('Celeste.exe')
      games.set('manual:m', manual('', 'Hades.exe'))
      expect(await createLocalDeleteService(deps()).plan('manual:m')).toMatchObject({
        kind: 'remove-only',
        reason: /different games \(Hades\.exe, Celeste\.exe\)/
      })
      await fs.rm(lib, { recursive: true })
      await mk('Hades/Hades.exe')
      await mk('Celeste/Celeste.exe')
      games.set('manual:m', manual('', 'Hades/Hades.exe'))
      expect(await createLocalDeleteService(deps()).plan('manual:m')).toMatchObject({
        kind: 'remove-only',
        reason: /Celeste\.exe, which looks like another game/
      })
    })
  })

  it("bins a manual game's folder only when the guards pass", async () => {
    const dir = join(root, '..', 'Games', 'B')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'b.exe'), 'abc')
    games.set('manual:b', game({ id: 'manual:b', source: 'manual', exePath: join(dir, 'b.exe') }))
    const plan = await createLocalDeleteService(deps()).plan('manual:b')
    expect(plan).toMatchObject({ kind: 'files', paths: [dir], totalBytes: 3 })
    // The folder holds PlayOut's data: only Remove from library.
    const guarded = await createLocalDeleteService(
      deps({ appFolders: () => [join(dir, 'PlayOutData')] })
    ).plan('manual:b')
    expect(guarded.kind).toBe('remove-only')
    // Too large.
    const huge = await createLocalDeleteService(
      deps({}, { folderSize: async () => 300 * 1024 ** 3 })
    ).plan('manual:b')
    expect(huge).toMatchObject({ kind: 'remove-only', reason: /200 GB/ })
  })

  describe("a PS3 game's updates and DLC", () => {
    const emu = (): string => join(root, '..', 'Emulation')
    const gameDir = (): string => join(emu(), 'Updates and DLC', 'PS3', 'dev_hdd0', 'game')

    async function ps3(): Promise<string> {
      const file = await write('ps3/Game.ps3', 'BLUS30443\n')
      games.set(
        'rom:ps3',
        game({
          id: 'rom:ps3',
          source: 'rom',
          platformId: 'ps3',
          externalId: 'ps3/Game.ps3',
          romPath: file,
          launch: { kind: 'emulator', systemId: 'ps3', romPath: file }
        })
      )
      for (const f of ['BLUS30443', 'BLUS30443DATA', 'BLUS30444']) {
        await fs.mkdir(join(gameDir(), f), { recursive: true })
        await fs.writeFile(join(gameDir(), f, 'PARAM.SFO'), '1234')
      }
      return file
    }

    it('lists them in the plan when the Emulation folder is known', async () => {
      const file = await ps3()
      const plan = await createLocalDeleteService(deps({ emulationDir: emu })).plan('rom:ps3')
      expect(plan).toMatchObject({ kind: 'files', paths: [file] })
      expect(plan.updatesDlc).toEqual({
        paths: [join(gameDir(), 'BLUS30443'), join(gameDir(), 'BLUS30443DATA')],
        totalBytes: 8
      })
      const without = await createLocalDeleteService(deps()).plan('rom:ps3')
      expect(without.kind).toBe('files')
      expect(without.updatesDlc).toBeUndefined()
    })

    it('bins them after the game when asked, and only then', async () => {
      const file = await ps3()
      const d = deps({ emulationDir: emu })
      const result = await createLocalDeleteService(d).run('rom:ps3', { updatesDlc: true })
      expect(result).toMatchObject({ ok: true, removed: true })
      expect(result.message).toMatch(/and its updates and DLC/)
      expect(trash.mock.calls.map((c) => c[0])).toEqual([
        file,
        join(gameDir(), 'BLUS30443'),
        join(gameDir(), 'BLUS30443DATA')
      ])
      expect(d.library.removeGame).toHaveBeenCalledWith('rom:ps3')

      trash.mockClear()
      await ps3()
      const plain = await createLocalDeleteService(deps({ emulationDir: emu })).run('rom:ps3')
      expect(plain).toMatchObject({ ok: true, removed: true })
      expect(plain.message).not.toMatch(/updates and DLC/)
      expect(trash.mock.calls.map((c) => c[0])).toEqual([file])
    })

    it('removes the game even when an update cannot be binned, and says so', async () => {
      await ps3()
      trash.mockImplementation(async (path: string) => {
        if (path.endsWith('BLUS30443DATA')) throw new Error('in use')
      })
      const d = deps({ emulationDir: emu })
      const result = await createLocalDeleteService(d).run('rom:ps3', { updatesDlc: true })
      expect(result).toMatchObject({ ok: true, removed: true })
      expect(result.message).toMatch(
        /1 of its updates and DLC could not be moved \(BLUS30443DATA\)/
      )
      expect(d.library.removeGame).toHaveBeenCalledWith('rom:ps3')
      expect(games.has('rom:ps3')).toBe(false)
    })
  })
})
