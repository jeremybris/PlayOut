import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { RegistryKey } from '../system/registry'
import {
  buildScannedGame,
  clientDirFromKey,
  installsFromKey,
  mergeInstalls,
  ubisoftProvider,
  uplayUninstallInfo
} from './ubisoft'

const verbose = { debug: () => {}, info: console.info, warn: console.warn, error: console.error }

function key(
  name: string,
  values: RegistryKey['values'],
  subkeys: RegistryKey[] = []
): RegistryKey {
  return { name, leaf: name.split('\\').pop() ?? name, values, subkeys }
}

const INSTALLS = key('HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs', {}, [
  key('...\\Installs\\635', {
    InstallDir:
      "C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Tom Clancy's Rainbow Six Siege/",
    Language: 'en-US'
  }),
  key('...\\Installs\\5595', { InstallDir: 'D:\\Games\\Assassins Creed Valhalla' }),
  key('...\\Installs\\broken', { Language: 'en-US' })
])

const UNINSTALL = key(
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  {},
  [
    key('...\\Uninstall\\Uplay Install 635', {
      DisplayName: "Tom Clancy's Rainbow Six® Siege",
      DisplayIcon: '"C:\\Games\\R6\\RainbowSix.ico",0',
      Publisher: 'Ubisoft'
    }),
    key('...\\Uninstall\\Uplay', { DisplayName: 'Ubisoft Connect' }),
    key('...\\Uninstall\\Steam App 620', { DisplayName: 'Portal 2' })
  ]
)

describe('registry mapping', () => {
  it('reads installs with normalized directories and skips rows without InstallDir', () => {
    expect(installsFromKey(INSTALLS)).toEqual([
      {
        id: '635',
        installDir:
          "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Tom Clancy's Rainbow Six Siege"
      },
      { id: '5595', installDir: 'D:\\Games\\Assassins Creed Valhalla' }
    ])
    expect(installsFromKey(null)).toEqual([])
  })

  it('indexes Uplay Install uninstall rows by id', () => {
    const info = uplayUninstallInfo(UNINSTALL)
    expect([...info.keys()]).toEqual(['635'])
    expect(info.get('635')).toEqual({
      displayName: "Tom Clancy's Rainbow Six® Siege",
      displayIcon: 'C:\\Games\\R6\\RainbowSix.ico'
    })
    expect(uplayUninstallInfo(null).size).toBe(0)
  })

  it('merges the 32-bit and 64-bit trees, first occurrence wins', () => {
    const merged = mergeInstalls([
      [{ id: '635', installDir: 'C:\\A' }],
      [
        { id: '635', installDir: 'C:\\B' },
        { id: '1', installDir: 'C:\\C' }
      ]
    ])
    expect(merged).toEqual([
      { id: '635', installDir: 'C:\\A' },
      { id: '1', installDir: 'C:\\C' }
    ])
  })

  it('reads the client directory', () => {
    expect(
      clientDirFromKey(
        key('Launcher', { InstallDir: 'C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/' })
      )
    ).toBe('C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher')
    expect(clientDirFromKey(key('Launcher', {}))).toBeNull()
    expect(clientDirFromKey(null)).toBeNull()
  })
})

describe('scanned games', () => {
  it('builds the uplay launch URI and uses the uninstall title', () => {
    const installs = installsFromKey(INSTALLS)
    const game = buildScannedGame(
      installs[0],
      uplayUninstallInfo(UNINSTALL).get('635'),
      'C:\\Games\\R6\\RainbowSix.ico'
    )
    expect(game).toEqual({
      source: 'ubisoft',
      externalId: '635',
      platformId: 'ubisoft',
      title: "Tom Clancy's Rainbow Six Siege",
      installDir:
        "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Tom Clancy's Rainbow Six Siege",
      launch: { kind: 'uri', uri: 'uplay://launch/635/0' },
      tracking: {
        mode: 'installDir',
        installDir:
          "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Tom Clancy's Rainbow Six Siege"
      },
      extra: { ubisoftId: '635' },
      localMedia: { icon: 'C:\\Games\\R6\\RainbowSix.ico' }
    })
  })

  it('falls back to the folder name', () => {
    const game = buildScannedGame(
      { id: '5595', installDir: 'D:\\Games\\Assassins Creed Valhalla' },
      undefined
    )
    expect(game.title).toBe('Assassins Creed Valhalla')
    expect(game.localMedia).toBeUndefined()
  })
})

describe('ubisoft integration (this machine)', () => {
  it('detects the client and scans without throwing', async () => {
    const client = await ubisoftProvider.detectClient()
    console.info(`[ubisoft] client: ${JSON.stringify(client)}`)
    if (!client.installed) {
      console.info('[ubisoft] Ubisoft Connect is not installed on this machine; scan skipped')
      return
    }
    const games = await ubisoftProvider.scanInstalled({
      settings: defaultSettings(),
      log: verbose,
      resourcesDir: resolve('resources/systems'),
      progress: () => {}
    })
    console.info(
      `[ubisoft] ${games.length} game(s): ${games.map((g) => `${g.title} [${g.externalId}] ${g.installDir}`).join('; ')}`
    )
    for (const g of games) {
      expect(g.source).toBe('ubisoft')
      expect(g.launch).toEqual({ kind: 'uri', uri: `uplay://launch/${g.externalId}/0` })
    }
  }, 60_000)
})
