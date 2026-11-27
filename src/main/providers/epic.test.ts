import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => {
  const log = {
    debug: () => undefined,
    info: (...args: unknown[]) => console.info('[epic]', ...args),
    warn: (...args: unknown[]) => console.warn('[epic]', ...args),
    error: (...args: unknown[]) => console.error('[epic]', ...args)
  }
  return { createLogger: () => log }
})

import type { Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { isDirectory, isFile } from '../util/fs'
import {
  createEpicProvider,
  epicLaunchUri,
  epicProvider,
  epicSkipReason,
  parseEpicManifest,
  scanLegacyManifests,
  scanV2Installations,
  type EpicManifest,
  type EpicPaths
} from './epic'
import type { ScanContext } from './types'

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

let root: string
let paths: EpicPaths

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-epic-'))
  paths = {
    manifestsDir: join(root, 'Manifests'),
    launcherInstalledPath: join(root, 'LauncherInstalled.dat'),
    v2Exe: join(root, 'v2', 'EpicGamesLauncher.exe'),
    v2InstallationsPath: join(root, 'v2', 'installations.jsonl'),
    v2CatalogCachePath: join(root, 'v2', 'catalog-cache.json')
  }
  await fs.mkdir(paths.manifestsDir, { recursive: true })
  await fs.mkdir(join(root, 'v2'), { recursive: true })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function makeInstallDir(name: string, exe?: string): Promise<string> {
  const dir = join(root, 'Games', name)
  await fs.mkdir(dir, { recursive: true })
  if (exe) {
    await fs.mkdir(dirname(join(dir, exe)), { recursive: true })
    await fs.writeFile(join(dir, exe), 'MZ')
  }
  return dir
}

function manifest(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    FormatVersion: 0,
    bIsIncompleteInstall: false,
    AppCategories: ['public', 'games', 'applications'],
    ...fields
  }
}

async function writeItem(name: string, data: unknown): Promise<void> {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  await fs.writeFile(join(paths.manifestsDir, name), body, 'utf8')
}

async function writeInstallList(
  entries: { AppName: string; InstallLocation: string }[]
): Promise<void> {
  await fs.writeFile(
    paths.launcherInstalledPath,
    JSON.stringify({ InstallationList: entries }),
    'utf8'
  )
}

describe('epicSkipReason', () => {
  const base: EpicManifest = {
    AppName: 'Min',
    AppCategories: ['public', 'games', 'applications'],
    CompatibleApps: [],
    bIsIncompleteInstall: false
  }

  it('keeps games and launchable add-ons', () => {
    expect(epicSkipReason(base)).toBeNull()
    expect(
      epicSkipReason({ ...base, AppCategories: ['addons', 'addons/launchable', 'games'] })
    ).toBeNull()
    expect(epicSkipReason({ ...base, AppCategories: [] })).toBeNull()
    expect(epicSkipReason({ ...base, MainGameAppName: 'Min' })).toBeNull()
  })

  it('skips DLC, Unreal Engine plugins and builds, and incomplete installs', () => {
    expect(epicSkipReason({ ...base, AppCategories: ['addons', 'public'] })).toBe('add-on / DLC')
    expect(epicSkipReason({ ...base, AppCategories: ['Addons'] })).toBe('add-on / DLC')
    expect(epicSkipReason({ ...base, AppCategories: ['plugins', 'plugins/engine'] })).toBe(
      'Unreal Engine plugin'
    )
    expect(epicSkipReason({ ...base, AppCategories: ['plugins/engine'] })).toBe(
      'Unreal Engine plugin'
    )
    expect(epicSkipReason({ ...base, CompatibleApps: ['UE_5.3'] })).toBe('Unreal Engine plugin')
    expect(epicSkipReason({ ...base, TechnicalType: 'plugins/engine' })).toBe(
      'Unreal Engine plugin'
    )
    expect(epicSkipReason({ ...base, AppCategories: ['engines', 'public'] })).toBe(
      'Unreal Engine build'
    )
    expect(epicSkipReason({ ...base, bIsIncompleteInstall: true })).toBe('incomplete install')
  })
})

describe('epicLaunchUri', () => {
  it('joins namespace, catalog item and app name with literal %3A', () => {
    expect(epicLaunchUri('Min', 'min', 'abc123')).toBe(
      'com.epicgames.launcher://apps/min%3Aabc123%3AMin?action=launch&silent=true'
    )
  })

  it('falls back to the app name alone and encodes unsafe characters', () => {
    expect(epicLaunchUri('My App')).toBe(
      'com.epicgames.launcher://apps/My%20App?action=launch&silent=true'
    )
    expect(epicLaunchUri('App', 'ns', undefined)).toBe(
      'com.epicgames.launcher://apps/App?action=launch&silent=true'
    )
    expect(epicLaunchUri('A&B', 'n s', 'i/d')).toBe(
      'com.epicgames.launcher://apps/n%20s%3Ai%2Fd%3AA%26B?action=launch&silent=true'
    )
  })
})

describe('parseEpicManifest', () => {
  it('requires an object with an AppName and normalises the fields', () => {
    expect(parseEpicManifest(null)).toBeNull()
    expect(parseEpicManifest([])).toBeNull()
    expect(parseEpicManifest('text')).toBeNull()
    expect(parseEpicManifest({ DisplayName: 'x' })).toBeNull()
    expect(parseEpicManifest({ AppName: '  ' })).toBeNull()
    expect(
      parseEpicManifest({
        AppName: ' Min ',
        DisplayName: '',
        AppCategories: ['games', 5],
        CompatibleApps: 'nope',
        bIsIncompleteInstall: 'true'
      })
    ).toEqual({
      AppName: 'Min',
      AppCategories: ['games'],
      CompatibleApps: [],
      bIsIncompleteInstall: false
    })
  })
})

describe('scanLegacyManifests', () => {
  it('maps installed games and skips DLC, plugins, incomplete and missing installs', async () => {
    const hadesDir = await makeInstallDir('Hades', join('x64', 'Hades.exe'))
    const addonDir = await makeInstallDir('StandaloneExpansion')
    const listedDir = await makeInstallDir('ListedOnly')
    await writeItem(
      'hades.item',
      manifest({
        AppName: 'Min',
        DisplayName: 'Hades',
        InstallLocation: hadesDir + '\\',
        LaunchExecutable: 'x64/Hades.exe',
        CatalogNamespace: 'min',
        CatalogItemId: 'abc123',
        MainGameAppName: 'Min',
        bIsApplication: true,
        InstallSize: 12345
      })
    )
    await writeItem(
      'dlc.item',
      manifest({
        AppName: 'MinDlc',
        DisplayName: 'Hades DLC',
        InstallLocation: hadesDir,
        AppCategories: ['addons', 'public'],
        MainGameAppName: 'Min'
      })
    )
    await writeItem(
      'addon.item',
      manifest({
        AppName: 'Expansion',
        DisplayName: 'Standalone Expansion',
        InstallLocation: addonDir,
        AppCategories: ['addons', 'addons/launchable', 'public'],
        CatalogNamespace: 'exp',
        CatalogItemId: 'exp1'
      })
    )
    await writeItem(
      'plugin.item',
      manifest({
        AppName: 'FancyPlugin',
        DisplayName: 'Fancy Plugin',
        InstallLocation: hadesDir,
        AppCategories: ['plugins', 'plugins/engine']
      })
    )
    await writeItem(
      'plugin2.item',
      manifest({ AppName: 'CompatPlugin', InstallLocation: hadesDir, CompatibleApps: ['UE_5.3'] })
    )
    await writeItem(
      'incomplete.item',
      manifest({
        AppName: 'HalfDone',
        DisplayName: 'Half Done',
        InstallLocation: hadesDir,
        bIsIncompleteInstall: true
      })
    )
    await writeItem(
      'gone.item',
      manifest({
        AppName: 'Gone',
        DisplayName: 'Uninstalled Game',
        InstallLocation: join(root, 'Games', 'Nope'),
        CatalogNamespace: 'g',
        CatalogItemId: 'g1'
      })
    )
    await writeItem(
      'listed.item',
      manifest({
        AppName: 'Listed',
        DisplayName: 'Listed Only',
        CatalogNamespace: 'l',
        CatalogItemId: 'l1'
      })
    )
    await writeItem('broken.item', '{ not json')
    await writeItem('empty.item', '')
    await writeItem('noapp.item', manifest({ DisplayName: 'No AppName' }))
    await fs.writeFile(join(paths.manifestsDir, 'notes.txt'), 'ignored', 'utf8')
    await writeInstallList([
      { AppName: 'listed', InstallLocation: listedDir },
      { AppName: 'Gone', InstallLocation: join(root, 'Games', 'AlsoNope') }
    ])

    const log = testLog()
    const games = await scanLegacyManifests(paths, log)
    expect(games.map((g) => g.externalId).sort()).toEqual(['Expansion', 'Listed', 'Min'])
    expect(games.find((g) => g.externalId === 'Min')).toEqual({
      source: 'epic',
      externalId: 'Min',
      platformId: 'epic',
      title: 'Hades',
      installDir: hadesDir,
      exePath: join(hadesDir, 'x64', 'Hades.exe'),
      launch: {
        kind: 'uri',
        uri: 'com.epicgames.launcher://apps/min%3Aabc123%3AMin?action=launch&silent=true'
      },
      tracking: { mode: 'installDir', installDir: hadesDir },
      extra: {
        epicAppName: 'Min',
        epicNamespace: 'min',
        epicCatalogItemId: 'abc123',
        epicInstallSize: 12345
      }
    })
    const listed = games.find((g) => g.externalId === 'Listed')
    expect(listed?.installDir).toBe(listedDir)
    expect(listed?.exePath).toBeUndefined()
    expect(listed?.tracking).toEqual({ mode: 'installDir', installDir: listedDir })
    for (const file of ['broken.item', 'empty.item', 'noapp.item']) {
      expect(log.warnings.some((w) => w.includes(file))).toBe(true)
    }
    expect(log.warnings.some((w) => w.includes('Gone') && w.includes('missing'))).toBe(true)
  })

  it('prefers the manifest at the location LauncherInstalled.dat records for duplicate app names', async () => {
    const oldDir = await makeInstallDir('Old')
    const newDir = await makeInstallDir('New')
    const fields = { CatalogNamespace: 'd', CatalogItemId: 'd1' }
    await writeItem(
      'a.item',
      manifest({ AppName: 'Dup', DisplayName: 'Old copy', InstallLocation: oldDir, ...fields })
    )
    await writeItem(
      'b.item',
      manifest({ AppName: 'dup', DisplayName: 'New copy', InstallLocation: newDir, ...fields })
    )
    await writeInstallList([{ AppName: 'Dup', InstallLocation: newDir }])
    const games = await scanLegacyManifests(paths, testLog())
    expect(games).toHaveLength(1)
    expect(games[0].title).toBe('New copy')
    expect(games[0].installDir).toBe(newDir)
    expect(games[0].externalId).toBe('dup')
  })

  it('keeps the first manifest when no duplicate matches the install list', async () => {
    const oldDir = await makeInstallDir('Old')
    const newDir = await makeInstallDir('New')
    await writeItem(
      'a.item',
      manifest({ AppName: 'Dup', DisplayName: 'First', InstallLocation: oldDir })
    )
    await writeItem(
      'b.item',
      manifest({ AppName: 'Dup', DisplayName: 'Second', InstallLocation: newDir })
    )
    const games = await scanLegacyManifests(paths, testLog())
    expect(games.map((g) => g.title)).toEqual(['First'])
  })

  it('falls back to the folder name and app-name URI without DisplayName and catalog ids', async () => {
    const dir = await makeInstallDir('Mystery Game')
    await writeItem('m.item', manifest({ AppName: 'Mystery', InstallLocation: dir }))
    const log = testLog()
    const games = await scanLegacyManifests(paths, log)
    expect(games).toHaveLength(1)
    expect(games[0].title).toBe('Mystery Game')
    expect(games[0].launch).toEqual({
      kind: 'uri',
      uri: 'com.epicgames.launcher://apps/Mystery?action=launch&silent=true'
    })
    // No InstallSize in the manifest: 0 (unknown) is written so a stale size from an older scan is replaced.
    expect(games[0].extra).toEqual({ epicAppName: 'Mystery', epicInstallSize: 0 })
    expect(log.warnings.some((w) => w.includes('CatalogNamespace'))).toBe(true)
  })

  it('returns nothing when the manifests folder is missing', async () => {
    const games = await scanLegacyManifests(
      { ...paths, manifestsDir: join(root, 'missing') },
      testLog()
    )
    expect(games).toEqual([])
  })
})

describe('scanV2Installations', () => {
  async function v2Install(
    name: string,
    installationId: string,
    withManifest = true
  ): Promise<string> {
    const dir = await makeInstallDir(name)
    if (withManifest) {
      await fs.mkdir(join(dir, '.egstore'), { recursive: true })
      await fs.writeFile(join(dir, '.egstore', `${installationId}.manifest`), 'manifest')
    }
    return dir
  }

  function jsonl(lines: unknown[]): string {
    const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    return [JSON.stringify({ version: 1 }), ...body].join('\n') + '\n'
  }

  it('takes the first complete installation per artifact that still exists, named from the catalog', async () => {
    const fnDir = await v2Install('Fortnite', 'inst-2')
    const goneDir = join(root, 'Games', 'Gone')
    const noManifestDir = await v2Install('NoManifest', 'inst-4', false)
    const unknownDir = await v2Install('Unknown Title', 'inst-5')
    await fs.writeFile(
      paths.v2InstallationsPath,
      jsonl([
        {
          installationId: 'inst-1',
          complete: true,
          dir: goneDir,
          itemId: 'item-fn',
          artifactId: 'Fortnite'
        },
        {
          installationId: 'inst-2',
          complete: true,
          dir: fnDir + '\\',
          itemId: 'item-fn',
          artifactId: 'Fortnite'
        },
        {
          installationId: 'inst-3',
          complete: true,
          dir: fnDir,
          itemId: 'item-fn',
          artifactId: 'Fortnite'
        },
        {
          installationId: 'inst-4',
          complete: true,
          dir: noManifestDir,
          itemId: 'item-x',
          artifactId: 'NoManifest'
        },
        {
          installationId: 'inst-5',
          complete: true,
          dir: unknownDir,
          itemId: 'item-unknown',
          artifactId: 'Mystery'
        },
        {
          installationId: 'inst-6',
          complete: false,
          dir: fnDir,
          itemId: 'item-y',
          artifactId: 'Incomplete'
        },
        { complete: true, dir: fnDir },
        'not json'
      ]),
      'utf8'
    )
    await fs.writeFile(
      paths.v2CatalogCachePath,
      JSON.stringify({
        items: {
          k1: {
            item: {
              id: 'item-fn',
              title: 'Fortnite',
              namespace: 'fn',
              releaseInfo: [{ appId: 'Fortnite' }]
            }
          },
          k2: { item: { id: 'item-y', title: 'Other' } },
          k3: { nothing: true }
        }
      }),
      'utf8'
    )
    const log = testLog()
    const games = await scanV2Installations(paths, log)
    expect(games.map((g) => g.externalId).sort()).toEqual(['Fortnite', 'Mystery'])
    expect(games.find((g) => g.externalId === 'Fortnite')).toEqual({
      source: 'epic',
      externalId: 'Fortnite',
      platformId: 'epic',
      title: 'Fortnite',
      installDir: fnDir,
      launch: {
        kind: 'uri',
        uri: 'com.epicgames.launcher://apps/fn%3Aitem-fn%3AFortnite?action=launch&silent=true'
      },
      tracking: { mode: 'installDir', installDir: fnDir },
      // The V2 install list records no size: always 0 (install-size.ts walks the folder instead).
      extra: {
        epicAppName: 'Fortnite',
        epicNamespace: 'fn',
        epicCatalogItemId: 'item-fn',
        epicInstallSize: 0
      }
    })
    const mystery = games.find((g) => g.externalId === 'Mystery')
    expect(mystery?.title).toBe('Unknown Title')
    expect(mystery?.launch).toEqual({
      kind: 'uri',
      uri: 'com.epicgames.launcher://apps/Mystery?action=launch&silent=true'
    })
    expect(mystery?.extra).toEqual({ epicAppName: 'Mystery', epicInstallSize: 0 })
    expect(log.warnings.some((w) => w.includes('line 9'))).toBe(true)
  })

  it('matches a catalog item through releaseInfo when the itemId is missing', async () => {
    const dir = await v2Install('Rocket', 'i1')
    await fs.writeFile(
      paths.v2InstallationsPath,
      jsonl([{ installationId: 'i1', complete: true, dir, artifactId: 'Sugar' }]),
      'utf8'
    )
    await fs.writeFile(
      paths.v2CatalogCachePath,
      JSON.stringify({
        items: {
          a: {
            item: {
              id: 'rl-item',
              title: 'Rocket League',
              namespace: 'rl',
              releaseInfo: [{ appId: 'sugar' }]
            }
          }
        }
      }),
      'utf8'
    )
    const games = await scanV2Installations(paths, testLog())
    expect(games).toHaveLength(1)
    expect(games[0].title).toBe('Rocket League')
    expect(games[0].extra).toEqual({
      epicAppName: 'Sugar',
      epicNamespace: 'rl',
      epicCatalogItemId: 'rl-item',
      epicInstallSize: 0
    })
  })

  it('returns nothing without an installation list and survives a broken catalog cache', async () => {
    expect(await scanV2Installations(paths, testLog())).toEqual([])
    const dir = await v2Install('Solo', 'i1')
    await fs.writeFile(
      paths.v2InstallationsPath,
      jsonl([{ installationId: 'i1', complete: true, dir, artifactId: 'Solo' }])
    )
    await fs.writeFile(paths.v2CatalogCachePath, '{ broken')
    const log = testLog()
    const games = await scanV2Installations(paths, log)
    expect(games.map((g) => g.title)).toEqual(['Solo'])
    expect(log.warnings.some((w) => w.includes('catalog-cache.json'))).toBe(true)
  })
})

describe('createEpicProvider', () => {
  it('merges legacy and V2 games (legacy wins) and reports progress', async () => {
    const dir = await makeInstallDir('Both', 'Both.exe')
    await writeItem(
      'both.item',
      manifest({
        AppName: 'Both',
        DisplayName: 'Both (legacy)',
        InstallLocation: dir,
        LaunchExecutable: 'Both.exe',
        CatalogNamespace: 'b',
        CatalogItemId: 'b1'
      })
    )
    const v2Dir = await makeInstallDir('OnlyV2')
    await fs.mkdir(join(v2Dir, '.egstore'))
    await fs.writeFile(join(v2Dir, '.egstore', 'i1.manifest'), 'm')
    await fs.writeFile(paths.v2Exe, 'MZ')
    await fs.writeFile(
      paths.v2InstallationsPath,
      [
        JSON.stringify({ version: 1 }),
        JSON.stringify({
          installationId: 'i0',
          complete: true,
          dir,
          itemId: 'x',
          artifactId: 'both'
        }),
        JSON.stringify({
          installationId: 'i1',
          complete: true,
          dir: v2Dir,
          itemId: 'y',
          artifactId: 'OnlyV2'
        })
      ].join('\n'),
      'utf8'
    )
    const provider = createEpicProvider({ paths, useRegistry: false, launcherRoots: [] })
    expect(provider.id).toBe('epic')
    expect(provider.platforms().map((p) => p.id)).toEqual(['epic'])
    expect(await provider.detectClient()).toEqual({ installed: true, path: paths.v2Exe })
    const ctx = scanContext(testLog())
    const games = await provider.scanInstalled(ctx)
    expect(games.map((g) => [g.externalId, g.title])).toEqual([
      ['Both', 'Both (legacy)'],
      ['OnlyV2', 'OnlyV2']
    ])
    expect(games[0].exePath).toBe(join(dir, 'Both.exe'))
    expect(ctx.found).toEqual([1, 2])
  })

  it('finds the legacy launcher under a root (Win32 preferred) and reports not installed otherwise', async () => {
    const epicRoot = join(root, 'Epic Games')
    const win32 = join(epicRoot, 'Launcher', 'Portal', 'Binaries', 'Win32', 'EpicGamesLauncher.exe')
    const win64 = join(epicRoot, 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe')
    await fs.mkdir(dirname(win64), { recursive: true })
    await fs.writeFile(win64, 'MZ')
    const provider = createEpicProvider({
      paths,
      useRegistry: false,
      launcherRoots: [join(root, 'nothing'), epicRoot + '\\']
    })
    expect(await provider.detectClient()).toEqual({ installed: true, path: win64 })
    await fs.mkdir(dirname(win32), { recursive: true })
    await fs.writeFile(win32, 'MZ')
    expect(await provider.detectClient()).toEqual({ installed: true, path: win32 })

    const none = createEpicProvider({
      paths,
      useRegistry: false,
      launcherRoots: [join(root, 'nothing')]
    })
    expect(await none.detectClient()).toEqual({ installed: false })
    expect(await none.scanInstalled(scanContext(testLog()))).toEqual([])
  })
})

describe('Epic Games Launcher on this machine (integration)', () => {
  it('detects the launcher through the registry and scans its installed games', async () => {
    const client = await epicProvider.detectClient()
    console.info(`[epic integration] client: ${JSON.stringify(client)}`)
    if (!client.installed) {
      console.info('[epic integration] Epic Games Launcher is not installed here; scan skipped')
      return
    }
    expect(client.path).toMatch(/EpicGamesLauncher\.exe$/i)
    expect(await isFile(client.path ?? '')).toBe(true)
    const ctx = scanContext(testLog())
    const games = await epicProvider.scanInstalled(ctx)
    const names = games.map((g) => `${g.title} [${g.externalId}]`).join(', ') || '(none)'
    console.info(`[epic integration] ${games.length} installed game(s): ${names}`)
    for (const game of games) {
      expect(game.launch.kind).toBe('uri')
      if (game.launch.kind === 'uri') {
        expect(game.launch.uri.startsWith('com.epicgames.launcher://apps/')).toBe(true)
      }
      expect(game.tracking).toEqual({ mode: 'installDir', installDir: game.installDir })
      expect(await isDirectory(game.installDir ?? '')).toBe(true)
      expect(game.extra?.epicAppName).toBe(game.externalId)
    }
    expect(ctx.found).toHaveLength(games.length)
  }, 120_000)
})
