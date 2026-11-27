import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above every declaration, so the factory must not close over module-level values.
vi.mock('../logger', () => {
  const silent = (): void => undefined
  return { createLogger: () => ({ debug: silent, info: silent, warn: silent, error: silent }) }
})

const noop = (): void => undefined

import type { Game } from '../../shared/types'
import type { LibraryService } from '../services/library-service'
import {
  cleanFolderTitle,
  cleanVersionInfoTitle,
  collectExecutables,
  createManualProvider,
  iconPathFor,
  isDeprioritizedExecutable,
  isExcludedExecutable,
  nameMatchScore,
  normalizeExeStem,
  pickExecutable,
  rankCandidates,
  resolveTitle,
  tokenizeArgs,
  type ExeCandidate
} from './manual'

const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe'
const log = { debug: noop, info: noop, warn: noop, error: noop }

let root: string
let iconDir: string

/** Fake executables: empty-content files of the given sizes (KB) under the temp library root. */
const FIXTURE: Record<string, number> = {
  'Hades\\Hades.exe': 200,
  'Hades\\x64\\Hades.exe': 200,
  'Hades\\x86\\Hades.exe': 200,
  'Hades\\UnityCrashHandler64.exe': 100,
  'Hades\\unins000.exe': 50,
  'Destroy All Humans!\\DH.exe': 300,
  'Destroy All Humans!\\DH\\Binaries\\Win64\\DH-Win64-Shipping.exe': 900,
  'Destroy All Humans!\\Engine\\Binaries\\Win64\\CrashReportClient.exe': 500,
  'Mafia Definitive Edition\\launcher.exe': 800,
  'Mafia Definitive Edition\\mafiadefinitiveedition.exe': 600,
  'Mafia Definitive Edition\\_CustomRedists\\vc_redist.x64.exe': 400,
  'Some Indie Thing\\a.exe': 10,
  'Some Indie Thing\\b.exe': 300,
  'Some Indie Thing\\tool.exe': 900,
  'Minecraft Launcher\\MinecraftLauncher.exe': 100,
  'Call of Duty\\CoDSP.exe': 596,
  'Call of Duty\\CoDUOMP.exe': 678,
  'Call of Duty\\TestApp2620m.exe': 652,
  'Factorio\\bin\\x64\\factorio.exe': 500,
  'Steamworks Shared\\_CommonRedist\\vcredist\\2019\\VC_redist.x64.exe': 500,
  'Deep\\l1\\l2\\l3\\l4\\game.exe': 100,
  '.hidden\\secret.exe': 100,
  'Empty Game\\readme.txt': 1
}

function candidate(relativePath: string, size: number): ExeCandidate {
  const parts = relativePath.split('\\')
  return {
    path: `C:\\Games\\X\\${relativePath}`,
    relativePath,
    name: parts[parts.length - 1],
    size,
    depth: parts.length - 1
  }
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-manual-'))
  iconDir = join(root, 'icons')
  for (const [relative, kb] of Object.entries(FIXTURE)) {
    const file = join(root, relative)
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(file, Buffer.alloc(kb * 1024))
  }
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('tokenizeArgs', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenizeArgs('')).toEqual([])
    expect(tokenizeArgs(undefined)).toEqual([])
    expect(tokenizeArgs('  -windowed   -w 1920 ')).toEqual(['-windowed', '-w', '1920'])
    expect(tokenizeArgs('-config "C:\\My Games\\cfg.ini" --name=\'Jane Doe\'')).toEqual([
      '-config',
      'C:\\My Games\\cfg.ini',
      '--name=Jane Doe'
    ])
    expect(tokenizeArgs('say \\"hi\\" "a \\"quoted\\" word"')).toEqual([
      'say',
      '"hi"',
      'a "quoted" word'
    ])
    expect(tokenizeArgs('"" x')).toEqual(['', 'x'])
  })
})

describe('titles', () => {
  it('cleans version-info strings and rejects junk', () => {
    expect(cleanVersionInfoTitle('Command & Conquer(TM) Remastered Collection Client')).toBe(
      'Command & Conquer Remastered Collection'
    )
    expect(cleanVersionInfoTitle('NINJA GAIDEN 2 Black Application')).toBe('NINJA GAIDEN 2 Black')
    expect(cleanVersionInfoTitle('Call of Duty®: Modern Warfare® III')).toBe(
      'Call of Duty: Modern Warfare III'
    )
    expect(cleanVersionInfoTitle('skate.™')).toBe('skate')
    expect(cleanVersionInfoTitle('  Kingdom Come:   Deliverance II ')).toBe(
      'Kingdom Come: Deliverance II'
    )
    expect(cleanVersionInfoTitle('')).toBeNull()
    expect(cleanVersionInfoTitle(undefined)).toBeNull()
    expect(cleanVersionInfoTitle('TODO: <File description>')).toBeNull()
    expect(cleanVersionInfoTitle('X-Ray Monolith Engine')).toBeNull()
    expect(cleanVersionInfoTitle('NTE Launcher')).toBeNull()
    expect(cleanVersionInfoTitle('Unity Player')).toBeNull()
    expect(cleanVersionInfoTitle('Microsoft® Windows® Operating System')).toBeNull()
    expect(cleanVersionInfoTitle('sputm90r')).toBeNull()
    expect(cleanVersionInfoTitle('game.exe')).toBeNull()
  })

  it('resolves titles from version info, folder name and file name in that order', () => {
    expect(resolveTitle({ description: 'Factorio', product: 'Factorio' }, 'factorio')).toBe(
      'Factorio'
    )
    expect(
      resolveTitle(
        { description: '', product: 'The Witcher 3: Wild Hunt' },
        'witcher3',
        'The Witcher 3 Wild Hunt'
      )
    ).toBe('The Witcher 3: Wild Hunt')
    expect(resolveTitle({}, 'Spel2', 'Spelunky 2')).toBe('Spelunky 2')
    expect(resolveTitle({}, 'Spel2')).toBe('Spel2')
    // a description that only repeats the file name loses to the folder name
    expect(resolveTitle({ description: 'FalloutNV' }, 'FalloutNV', 'Fallout New Vegas')).toBe(
      'Fallout New Vegas'
    )
    expect(resolveTitle({ description: 'skate.™' }, 'Skate', 'Skate')).toBe('Skate')
    expect(
      resolveTitle(
        { description: 'X-Ray Monolith Engine', product: 'X-Ray Monolith Engine' },
        'AnomalyDX11',
        'S.T.A.L.K.E.R. GAMMA'
      )
    ).toBe('S.T.A.L.K.E.R. GAMMA')
    expect(cleanFolderTitle('Super_Game [GOG] v1.2.3')).toBe('Super Game')
    expect(cleanFolderTitle("Sid Meier's Civilization IV Beyond the Sword")).toBe(
      "Sid Meier's Civilization IV Beyond the Sword"
    )
  })
})

describe('executable heuristics', () => {
  it('excludes installers, redistributables, crash handlers and helpers', () => {
    for (const name of [
      'unins000.exe',
      'setup.exe',
      'UbisoftConnectInstaller.exe',
      'vc_redist.x64.exe',
      'vcredist_x86.exe',
      'DXSETUP.exe',
      'UnityCrashHandler64.exe',
      'CrashReportClient.exe',
      'crash_reporter.exe',
      'BsSndRpt64.exe',
      'BugSplatHD64.exe',
      'crashpad_handler.exe',
      'createdump.exe',
      'EpicWebHelper.exe',
      'NTEGlobalUpdate.exe',
      'notification_helper.exe',
      'python.exe',
      'QtWebEngineProcess.exe',
      'EAAntiCheat.GameServiceLauncher.exe',
      'codinstallcleaner.exe',
      'cleanup.exe',
      'NTEGlobalErrRep.exe',
      'GameConfigurator.exe',
      'notification_helper.exe',
      'zsyncmake.exe'
    ]) {
      expect(isExcludedExecutable(name), name).toBe(true)
    }
    for (const name of [
      'Hades.exe',
      'factorio.exe',
      'Crash Bandicoot.exe',
      'Driver.exe',
      'Installation01.exe'.replace('Installation', 'Station')
    ]) {
      expect(isExcludedExecutable(name), name).toBe(false)
    }
  })

  it('deprioritizes launchers, servers, editors and tools', () => {
    for (const name of [
      'launcher.exe',
      'FalloutNVLauncher.exe',
      'bootstrapper.exe',
      'f4se_loader.exe',
      'WorldEditor.exe',
      'ReSkateServer.exe',
      'Civ4BeyondSword_PitBoss.exe',
      'TestApp2620m.exe',
      'twmm.exe'.replace('twmm', 'ModTool')
    ]) {
      expect(isDeprioritizedExecutable(name), name).toBe(true)
    }
    expect(isDeprioritizedExecutable('Warhammer3.exe')).toBe(false)
    expect(isDeprioritizedExecutable('StarTrek.exe')).toBe(false)
  })

  it('matches executable names against the folder name', () => {
    expect(normalizeExeStem('Palworld-Win64-Shipping')).toBe('palworld')
    expect(normalizeExeStem('DOOMEternalx64vk')).toBe('doometernal')
    expect(nameMatchScore('Hogwarts Legacy', 'HogwartsLegacy.exe')).toBe(3)
    expect(nameMatchScore('Mafia Definitive Edition', 'mafiadefinitiveedition.exe')).toBe(3)
    expect(nameMatchScore('RESIDENT EVIL 4  BIOHAZARD RE4', 're4.exe')).toBe(2)
    expect(nameMatchScore('KingdomComeDeliverance2', 'KingdomCome.exe')).toBe(2)
    expect(nameMatchScore('EARTH DEFENSE FORCE 6', 'EDF6.exe')).toBe(2)
    expect(nameMatchScore('Call of Duty', 'CoDSP.exe')).toBe(2)
    expect(nameMatchScore('Call of Duty', 'CoDUOMP.exe')).toBe(1)
    expect(nameMatchScore('Destroy All Humans!', 'DH.exe')).toBe(1)
    expect(nameMatchScore('Goat Simulator Remastered', 'Goatsim_UE4.exe')).toBe(1)
  })

  it('ranks the main executable first', () => {
    // Unreal layout: the small bootstrapper at the root beats the big shipping exe
    expect(
      pickExecutable('Destroy All Humans!', [
        candidate('DH.exe', 300),
        candidate('DH\\Binaries\\Win64\\DH-Win64-Shipping.exe', 900)
      ])?.relativePath
    ).toBe('DH.exe')
    // the folder-name match beats a bigger launcher
    expect(
      pickExecutable('Mafia Definitive Edition', [
        candidate('launcher.exe', 800),
        candidate('mafiadefinitiveedition.exe', 600)
      ])?.relativePath
    ).toBe('mafiadefinitiveedition.exe')
    // same name everywhere: root, then x64 over x86
    expect(
      rankCandidates('Hades', [
        candidate('x86\\Hades.exe', 200),
        candidate('x64\\Hades.exe', 200),
        candidate('Hades.exe', 200)
      ]).map((c) => c.relativePath)
    ).toEqual(['Hades.exe', 'x64\\Hades.exe', 'x86\\Hades.exe'])
    // nothing matches: bin folders first, then the largest file, tools last
    expect(
      pickExecutable('Some Indie Thing', [
        candidate('a.exe', 10),
        candidate('b.exe', 300),
        candidate('tool.exe', 900)
      ])?.relativePath
    ).toBe('b.exe')
    expect(
      pickExecutable('Total War WARHAMMER III', [
        candidate('Warhammer3.exe', 227082),
        candidate('launcher\\launcher.exe', 48462),
        candidate('twmm\\twmm.exe', 1921)
      ])?.relativePath
    ).toBe('Warhammer3.exe')
    // a launcher is still picked when it is all there is
    expect(
      pickExecutable('Minecraft Launcher', [candidate('MinecraftLauncher.exe', 100)])?.relativePath
    ).toBe('MinecraftLauncher.exe')
    // excluded and empty files never win
    expect(
      pickExecutable('Steamworks Shared', [
        candidate('_CommonRedist\\vcredist\\2019\\VC_redist.x64.exe', 500)
      ])
    ).toBeNull()
    expect(pickExecutable('Zero', [candidate('Zero.exe', 0)])).toBeNull()
  })

  it('collects executables three levels deep and skips hidden and support folders', async () => {
    const found = (await collectExecutables(join(root, 'Destroy All Humans!')))
      .map((c) => c.relativePath)
      .sort()
    expect(found).toEqual(['DH.exe', 'DH\\Binaries\\Win64\\DH-Win64-Shipping.exe'])
    expect(await collectExecutables(join(root, 'Deep'))).toEqual([])
    expect(await collectExecutables(join(root, 'Mafia Definitive Edition'))).toHaveLength(2)
    expect(await collectExecutables(join(root, 'missing'))).toEqual([])
    const all = await collectExecutables(root, 4)
    expect(all.some((c) => c.relativePath.startsWith('.hidden'))).toBe(false)
    const factorio = all.find((c) => c.name === 'factorio.exe')
    expect(factorio).toMatchObject({
      relativePath: 'Factorio\\bin\\x64\\factorio.exe',
      depth: 3,
      size: 500 * 1024
    })
  })
})

describe('scanFolder', () => {
  it('returns one game per game folder of a library root', async () => {
    const provider = createManualProvider({ library: { games: () => [] }, log, iconDir })
    const games = await provider.scanFolder(root)
    const byTitle = Object.fromEntries(games.map((g) => [g.title, g]))
    expect(Object.keys(byTitle).sort()).toEqual([
      'Call of Duty',
      'Destroy All Humans!',
      'Factorio',
      'Hades',
      'Mafia Definitive Edition',
      'Minecraft Launcher',
      'Some Indie Thing'
    ])
    expect(byTitle['Hades'].exePath).toBe(join(root, 'Hades', 'Hades.exe'))
    expect(byTitle['Destroy All Humans!'].exePath).toBe(join(root, 'Destroy All Humans!', 'DH.exe'))
    expect(byTitle['Mafia Definitive Edition'].exePath).toBe(
      join(root, 'Mafia Definitive Edition', 'mafiadefinitiveedition.exe')
    )
    expect(byTitle['Some Indie Thing'].exePath).toBe(join(root, 'Some Indie Thing', 'b.exe'))
    expect(byTitle['Call of Duty'].exePath).toBe(join(root, 'Call of Duty', 'CoDSP.exe'))
    expect(byTitle['Factorio'].exePath).toBe(join(root, 'Factorio', 'bin', 'x64', 'factorio.exe'))

    const hades = byTitle['Hades']
    expect(hades.source).toBe('manual')
    expect(hades.platformId).toBe('pc')
    expect(hades.externalId).toBe(join(root, 'Hades', 'Hades.exe').toLowerCase())
    expect(hades.installDir).toBe(join(root, 'Hades'))
    expect(hades.launch).toEqual({
      kind: 'exec',
      file: join(root, 'Hades', 'Hades.exe'),
      args: [],
      cwd: join(root, 'Hades')
    })
    expect(hades.tracking).toEqual({ mode: 'spawned' })
  })

  it('treats a folder with the executable at its root or under bin as a single game', async () => {
    const provider = createManualProvider({ library: { games: () => [] }, log, iconDir })
    const hades = await provider.scanFolder(join(root, 'Hades'))
    expect(hades.map((g) => g.exePath)).toEqual([join(root, 'Hades', 'Hades.exe')])
    const factorio = await provider.scanFolder(join(root, 'Factorio'))
    expect(factorio.map((g) => [g.title, g.exePath])).toEqual([
      ['Factorio', join(root, 'Factorio', 'bin', 'x64', 'factorio.exe')]
    ])
    expect(await provider.scanFolder(join(root, 'Steamworks Shared'))).toEqual([])
    expect(await provider.scanFolder(join(root, 'Empty Game'))).toEqual([])
    expect(await provider.scanFolder(join(root, 'does-not-exist'))).toEqual([])
  })
})

describe('addGame', () => {
  it('reads the title from the version info and extracts the largest icon as PNG', async () => {
    const provider = createManualProvider({ library: { games: () => [] }, log, iconDir })
    const game = await provider.addGame({ exePath: NOTEPAD })
    expect(game.title).toBe('Notepad')
    expect(game.externalId).toBe(NOTEPAD.toLowerCase())
    expect(game.installDir).toBe('C:\\Windows\\System32')
    expect(game.exePath).toBe(NOTEPAD)
    expect(game.launch).toEqual({
      kind: 'exec',
      file: NOTEPAD,
      args: [],
      cwd: 'C:\\Windows\\System32'
    })
    expect(game.tracking).toEqual({ mode: 'spawned' })
    expect(game.localMedia?.icon).toBe(iconPathFor(NOTEPAD, iconDir))
    expect(game.localMedia?.icon).toMatch(/[\\/][0-9a-f]{40}\.png$/)
    const png = await fs.readFile(game.localMedia!.icon!)
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    const size = pngSize(png)
    expect(size.width).toBeGreaterThanOrEqual(48)
    expect(size.height).toBe(size.width)
  })

  it('keeps an explicit title, tokenizes arguments and honours the working directory', async () => {
    const provider = createManualProvider({ library: { games: () => [] }, log, iconDir })
    const game = await provider.addGame({
      exePath: NOTEPAD.toLowerCase(),
      title: '  My Notepad ',
      args: '-a "b c"',
      cwd: 'C:\\Windows'
    })
    expect(game.title).toBe('My Notepad')
    expect(game.externalId).toBe(NOTEPAD.toLowerCase())
    expect(game.launch).toEqual({
      kind: 'exec',
      file: NOTEPAD.toLowerCase(),
      args: ['-a', 'b c'],
      cwd: 'C:\\Windows'
    })
  })

  it('rejects a missing executable', async () => {
    const provider = createManualProvider({ library: { games: () => [] }, log, iconDir })
    await expect(provider.addGame({ exePath: join(root, 'nope.exe') })).rejects.toThrow(
      /Executable not found/
    )
  })
})

describe('scanInstalled', () => {
  it('reports only the manual games whose executable still exists', async () => {
    const manual = (exePath: string, title: string): Game =>
      ({
        id: `manual:${exePath.toLowerCase()}`,
        source: 'manual',
        externalId: exePath.toLowerCase(),
        platformId: 'pc',
        title,
        sortTitle: title.toLowerCase(),
        installed: true,
        installDir: dirname(exePath),
        exePath,
        launch: { kind: 'exec', file: exePath, args: [], cwd: dirname(exePath) },
        tracking: { mode: 'spawned' },
        hidden: false,
        favorite: false,
        playtimeMinutes: 0,
        playCount: 0,
        addedAt: '2026-01-01T00:00:00.000Z',
        metadata: {},
        media: {},
        metadataStatus: 'none',
        user: {}
      }) as Game
    const games = [
      manual(NOTEPAD, 'Notepad'),
      manual(join(root, 'gone.exe'), 'Gone'),
      { ...manual(NOTEPAD, 'Steam thing'), source: 'steam' as const }
    ]
    const library = { games: () => games } as unknown as LibraryService
    const provider = createManualProvider({ library, log, iconDir })
    const progress: number[] = []
    const result = await provider.scanInstalled({
      settings: {} as never,
      log,
      resourcesDir: root,
      progress: (n) => progress.push(n)
    })
    expect(result.map((g) => g.title)).toEqual(['Notepad'])
    expect(result[0]).toMatchObject({
      source: 'manual',
      externalId: NOTEPAD.toLowerCase(),
      exePath: NOTEPAD,
      tracking: { mode: 'spawned' }
    })
    expect(progress).toEqual([1])
    expect(await provider.detectClient()).toEqual({ installed: true })
    expect(provider.platforms().map((p) => p.id)).toEqual(['pc'])
  })
})
