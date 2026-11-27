import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => {
  const log = {
    debug: () => undefined,
    info: (...args: unknown[]) => console.info('[gog]', ...args),
    warn: (...args: unknown[]) => console.warn('[gog]', ...args),
    error: (...args: unknown[]) => console.error('[gog]', ...args)
  }
  return { createLogger: () => log }
})

import type { Settings } from '../../shared/types'
import type { Logger } from '../logger'
import type { RegistryKey, RegistryValue } from '../system/registry'
import { isDirectory, isFile } from '../util/fs'
import {
  createGogProvider,
  detectGalaxy,
  gogGamesFromRegistry,
  gogProvider,
  regString,
  tokenizeArgs,
  type RegistryReader
} from './gog'
import type { ScanContext } from './types'

const GALAXY_PATH = 'SOFTWARE\\GOG.com\\GalaxyClient'
const GAMES_PATH = 'SOFTWARE\\GOG.com\\Games'
const HKLM32 = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node'

function testLog(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  }
}

function scanContext(log: Logger): ScanContext & { found: number[] } {
  const found: number[] = []
  return {
    settings: {} as Settings,
    log,
    resourcesDir: '',
    progress: (count) => found.push(count),
    found
  }
}

function key(
  name: string,
  values: Record<string, RegistryValue>,
  subkeys: RegistryKey[] = []
): RegistryKey {
  return { name, leaf: name.split('\\').pop() ?? name, values, subkeys }
}

function gameKey(id: string, values: Record<string, RegistryValue>): RegistryKey {
  return key(`${HKLM32}\\GOG.com\\Games\\${id}`, { gameID: id, productID: id, ...values })
}

function galaxyKey(dir: string, version = '2.1.10.56'): RegistryKey {
  return key(
    `${HKLM32}\\GOG.com\\GalaxyClient`,
    { clientExecutable: 'GalaxyClient.exe', version },
    [key(`${HKLM32}\\GOG.com\\GalaxyClient\\paths`, { client: dir })]
  )
}

/** A registry reader serving fixed keys per `HKLM\<path>@<view>`; `calls` records every read. */
function fakeRegistry(
  tree: Record<string, RegistryKey | null>
): RegistryReader & { calls: string[] } {
  const calls: string[] = []
  const reader: RegistryReader = async (hive, path, options) => {
    const depth = options?.depth ?? 1
    const id = `${hive}\\${path}@${options?.view ?? 'default'}`
    calls.push(`${id}#${depth}`)
    const found = tree[id] ?? null
    if (!found) return null
    if (depth === 0) {
      return { ...found, subkeys: found.subkeys.map((s) => ({ ...s, values: {}, subkeys: [] })) }
    }
    return found
  }
  return Object.assign(reader, { calls })
}

let root: string
let galaxyDir: string
let galaxyExe: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-gog-'))
  galaxyDir = join(root, 'GOG Galaxy')
  galaxyExe = join(galaxyDir, 'GalaxyClient.exe')
  await fs.mkdir(galaxyDir, { recursive: true })
  await fs.writeFile(galaxyExe, 'MZ')
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function gameDir(name: string, files: string[] = []): Promise<string> {
  const dir = join(root, 'Games', name)
  await fs.mkdir(dir, { recursive: true })
  for (const file of files) {
    await fs.mkdir(dirname(join(dir, file)), { recursive: true })
    await fs.writeFile(join(dir, file), 'x')
  }
  return dir
}

/** Mirrors the GOG.com\Games tree found on the development PC, plus malformed entries. */
async function fixtureGames(): Promise<{
  games: RegistryKey
  gammaDir: string
  londonDir: string
}> {
  const gammaDir = await gameDir('S.T.A.L.K.E.R. GAMMA', [
    'GAMMA/ModOrganizer.exe',
    'goggame-1595922314.ico',
    'goggame-1595922314.info'
  ])
  const londonDir = await gameDir('Fallout London', ['f4se_loader.exe'])
  const staleDir = join(root, 'Games', 'Fallout New Vegas')
  const gammaExe = join(gammaDir, 'GAMMA', 'ModOrganizer.exe')
  const games = key(`${HKLM32}\\GOG.com\\Games`, {}, [
    gameKey('1454587428', {
      gameName: 'Fallout: New Vegas',
      path: staleDir,
      exe: join(staleDir, 'FalloutNVLauncher.exe'),
      dependsOn: '',
      DLC: ''
    }),
    gameKey('1595922314', {
      gameName: 'S.T.A.L.K.E.R. GAMMA',
      path: gammaDir + '\\',
      workingDir: join(gammaDir, 'GAMMA'),
      exe: gammaExe,
      exeFile: 'ModOrganizer.exe',
      launchParam: '"moshortcut://:Anomaly (DX11)"',
      launchCommand: `${gammaExe} "moshortcut://:Anomaly (DX11)"`,
      dependsOn: '',
      BUILDID: '59740636414290839'
    }),
    gameKey('1897848199', {
      gameName: 'Fallout: London',
      path: londonDir,
      exe: join(londonDir, 'f4se_loader.exe'),
      launchParam: '',
      dependsOn: ''
    }),
    gameKey('1234567890', {
      gameName: 'Fallout: London - Bonus',
      path: londonDir,
      dependsOn: '1897848199'
    }),
    gameKey('5555555555', { gameName: 'No Path' }),
    key(`${HKLM32}\\GOG.com\\Games\\Junk`, { gameName: 'junk' })
  ])
  return { games, gammaDir, londonDir }
}

describe('tokenizeArgs', () => {
  it('splits on whitespace and honours double quotes', () => {
    expect(tokenizeArgs('')).toEqual([])
    expect(tokenizeArgs('   ')).toEqual([])
    expect(tokenizeArgs('-windowed -w 1920')).toEqual(['-windowed', '-w', '1920'])
    expect(tokenizeArgs('"moshortcut://:Anomaly (DX11)"')).toEqual(['moshortcut://:Anomaly (DX11)'])
    expect(tokenizeArgs('--config="C:\\My Games\\x.ini" -y')).toEqual([
      '--config=C:\\My Games\\x.ini',
      '-y'
    ])
    expect(tokenizeArgs('"" a')).toEqual(['', 'a'])
  })

  it('treats backslashes before quotes the CommandLineToArgvW way', () => {
    expect(tokenizeArgs('C:\\Games\\x\\ foo')).toEqual(['C:\\Games\\x\\', 'foo'])
    expect(tokenizeArgs('a\\"b')).toEqual(['a"b'])
    expect(tokenizeArgs('"a\\\\" b')).toEqual(['a\\', 'b'])
  })
})

describe('regString', () => {
  it('looks values up case-insensitively and normalises types', () => {
    const values: Record<string, RegistryValue> = {
      gameName: ' X ',
      BUILDID: 123,
      multi: ['a', 'b'],
      empty: '',
      nul: null
    }
    expect(regString(values, 'GAMENAME')).toBe('X')
    expect(regString(values, 'buildid')).toBe('123')
    expect(regString(values, 'multi')).toBe('a\nb')
    expect(regString(values, 'empty')).toBeUndefined()
    expect(regString(values, 'nul')).toBeUndefined()
    expect(regString(values, 'missing')).toBeUndefined()
    expect(regString(undefined, 'x')).toBeUndefined()
  })
})

describe('detectGalaxy', () => {
  it('reads the 32-bit view, then the 64-bit view, then the default folder', async () => {
    const log = testLog()
    const x64 = fakeRegistry({ [`HKLM\\${GALAXY_PATH}@x64`]: galaxyKey(galaxyDir, '2.0.0') })
    expect(await detectGalaxy(x64, join(root, 'nope'), log)).toEqual({
      dir: galaxyDir,
      exe: galaxyExe,
      version: '2.0.0'
    })
    expect(x64.calls).toEqual([`HKLM\\${GALAXY_PATH}@x86#1`, `HKLM\\${GALAXY_PATH}@x64#1`])
    expect(await detectGalaxy(fakeRegistry({}), galaxyDir, log)).toEqual({
      dir: galaxyDir,
      exe: galaxyExe
    })
    expect(await detectGalaxy(fakeRegistry({}), join(root, 'nope'), log)).toBeNull()
  })

  it('ignores a registry path whose executable is gone', async () => {
    const log = testLog()
    const stale = fakeRegistry({ [`HKLM\\${GALAXY_PATH}@x86`]: galaxyKey(join(root, 'moved')) })
    expect(await detectGalaxy(stale, galaxyDir, log)).toEqual({ dir: galaxyDir, exe: galaxyExe })
    expect(log.warnings.some((w) => w.includes('moved'))).toBe(true)
  })
})

describe('createGogProvider', () => {
  it('maps the registry tree to Galaxy-launched games, skipping DLC, stale and malformed entries', async () => {
    const { games, gammaDir } = await fixtureGames()
    const registry = fakeRegistry({
      [`HKLM\\${GALAXY_PATH}@x86`]: galaxyKey(galaxyDir + '\\'),
      [`HKLM\\${GAMES_PATH}@x86`]: games
    })
    const provider = createGogProvider({ readKey: registry, galaxyDefaultDir: join(root, 'nope') })
    expect(provider.id).toBe('gog')
    expect(provider.platforms().map((p) => p.id)).toEqual(['gog'])
    expect(await provider.detectClient()).toEqual({
      installed: true,
      path: galaxyExe,
      version: '2.1.10.56'
    })

    const log = testLog()
    const ctx = scanContext(log)
    const result = await provider.scanInstalled(ctx)
    expect(result.map((g) => g.externalId)).toEqual(['1595922314', '1897848199'])
    expect(result[0]).toEqual({
      source: 'gog',
      externalId: '1595922314',
      platformId: 'gog',
      title: 'S.T.A.L.K.E.R. GAMMA',
      installDir: gammaDir,
      exePath: join(gammaDir, 'GAMMA', 'ModOrganizer.exe'),
      launch: {
        kind: 'exec',
        file: galaxyExe,
        args: [
          '/launchViaAutostart',
          '/gameId=1595922314',
          '/command=runGame',
          `/path=${gammaDir}`
        ],
        cwd: galaxyDir
      },
      tracking: { mode: 'installDir', installDir: gammaDir },
      extra: { gogProductId: '1595922314' },
      localMedia: { icon: join(gammaDir, 'goggame-1595922314.ico') }
    })
    expect(result[1].localMedia).toBeUndefined()
    expect(result[1].launch).toMatchObject({ kind: 'exec', file: galaxyExe })
    expect(ctx.found).toEqual([1, 2])
    expect(registry.calls.filter((c) => c.includes(GAMES_PATH))).toEqual([
      `HKLM\\${GAMES_PATH}@x86#1`
    ])
    expect(log.warnings.some((w) => w.includes('1454587428') && w.includes('missing'))).toBe(true)
    expect(
      log.warnings.some((w) => w.includes('5555555555') && w.includes('no install path'))
    ).toBe(true)
  })

  it('runs the executable with tokenized launch parameters when Galaxy is not installed', async () => {
    const { games, gammaDir, londonDir } = await fixtureGames()
    const registry = fakeRegistry({ [`HKLM\\${GAMES_PATH}@x86`]: games })
    const provider = createGogProvider({ readKey: registry, galaxyDefaultDir: join(root, 'nope') })
    expect(await provider.detectClient()).toEqual({ installed: false })
    expect(provider.scansWithoutClient).toBe(true)
    const result = await provider.scanInstalled(scanContext(testLog()))
    expect(result.map((g) => g.externalId)).toEqual(['1595922314', '1897848199'])
    expect(result[0].launch).toEqual({
      kind: 'exec',
      file: join(gammaDir, 'GAMMA', 'ModOrganizer.exe'),
      args: ['moshortcut://:Anomaly (DX11)'],
      cwd: join(gammaDir, 'GAMMA')
    })
    expect(result[1].launch).toEqual({
      kind: 'exec',
      file: join(londonDir, 'f4se_loader.exe'),
      args: [],
      cwd: londonDir
    })
    expect(result[1].tracking).toEqual({ mode: 'installDir', installDir: londonDir })
  })

  it('falls back to the 64-bit Games key and reports not installed when nothing is registered', async () => {
    const dir = await gameDir('Solo', ['solo.exe'])
    const x64Games = key('HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games', {}, [
      gameKey('42', { gameName: 'Solo', path: dir, exeFile: 'solo.exe' })
    ])
    const registry = fakeRegistry({ [`HKLM\\${GAMES_PATH}@x64`]: x64Games })
    const provider = createGogProvider({ readKey: registry, galaxyDefaultDir: join(root, 'nope') })
    const result = await provider.scanInstalled(scanContext(testLog()))
    expect(result.map((g) => [g.externalId, g.exePath])).toEqual([['42', join(dir, 'solo.exe')]])

    const empty = createGogProvider({
      readKey: fakeRegistry({}),
      galaxyDefaultDir: join(root, 'nope')
    })
    expect(await empty.detectClient()).toEqual({ installed: false })
    expect(await empty.scanInstalled(scanContext(testLog()))).toEqual([])
  })

  it('never throws out of the mapping for broken entries', async () => {
    const dir = await gameDir('Odd', ['odd.exe'])
    const exploding: RegistryKey = {
      name: `${HKLM32}\\GOG.com\\Games\\8`,
      leaf: '8',
      values: {},
      subkeys: []
    }
    Object.defineProperty(exploding, 'values', {
      get() {
        throw new Error('boom')
      }
    })
    const games = key(`${HKLM32}\\GOG.com\\Games`, {}, [
      gameKey('7', { gameName: 'Odd', path: dir, exe: 'odd.exe' }),
      exploding,
      {
        name: `${HKLM32}\\GOG.com\\Games\\9`,
        leaf: '9',
        values: null as unknown as Record<string, RegistryValue>,
        subkeys: []
      }
    ])
    const log = testLog()
    const result = await gogGamesFromRegistry(games, null, { log })
    expect(result.map((g) => g.externalId)).toEqual(['7'])
    expect(result[0].exePath).toBe(join(dir, 'odd.exe'))
    expect(log.warnings).toContain('gog: 8: boom, skipped')
    expect(log.warnings.some((w) => w.includes('9 ""') && w.includes('no install path'))).toBe(true)
  })
})

describe('GOG on this machine (integration)', () => {
  it('detects GOG Galaxy and scans the registered games', async () => {
    const client = await gogProvider.detectClient()
    console.info(`[gog integration] client: ${JSON.stringify(client)}`)
    if (!client.installed) {
      console.info(
        '[gog integration] neither GOG Galaxy nor registered GOG games here; scan skipped'
      )
      return
    }
    const ctx = scanContext(testLog())
    const games = await gogProvider.scanInstalled(ctx)
    const names = games
      .map((g) => `${g.title} [${g.externalId}]${g.localMedia?.icon ? ' +icon' : ''}`)
      .join(', ')
    console.info(`[gog integration] ${games.length} installed game(s): ${names || '(none)'}`)
    for (const game of games) {
      expect(game.externalId).toMatch(/^\d+$/)
      expect(game.extra).toEqual({ gogProductId: game.externalId })
      expect(await isDirectory(game.installDir ?? '')).toBe(true)
      expect(game.tracking).toEqual({ mode: 'installDir', installDir: game.installDir })
      expect(game.launch.kind).toBe('exec')
      if (game.launch.kind === 'exec') {
        if (client.path) {
          expect(game.launch.file).toBe(client.path)
          expect(game.launch.args).toEqual([
            '/launchViaAutostart',
            `/gameId=${game.externalId}`,
            '/command=runGame',
            `/path=${game.installDir}`
          ])
        }
        expect(await isFile(game.launch.file)).toBe(true)
      }
      if (game.localMedia?.icon) expect(await isFile(game.localMedia.icon)).toBe(true)
    }
    expect(ctx.found).toHaveLength(games.length)
  }, 120_000)
})
