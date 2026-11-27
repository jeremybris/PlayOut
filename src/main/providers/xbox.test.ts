import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import {
  buildScannedGame,
  cleanTitle,
  isGamePackage,
  mapPackages,
  titleFor,
  xboxProvider,
  type AppxPackageRecord
} from './xbox'

const verbose = { debug: () => {}, info: console.info, warn: console.warn, error: console.error }

/** As produced by the enumeration script on the development machine (Xbox 360 backward-compatibility title). */
const CONKER: AppxPackageRecord = {
  name: 'Xbox360BackwardCompatibil.PrimaryConkerLiveReloade',
  packageFamilyName: 'Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_ksqcvrsvwz2jp',
  packageFullName:
    'Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_2608.3123.1.0_x64__ksqcvrsvwz2jp',
  publisher: 'CN=92ADE8CC-2A9A-4DF3-9BAF-18AF498CAA12',
  publisherId: 'ksqcvrsvwz2jp',
  version: '2608.3123.1.0',
  installLocation:
    'C:\\Program Files\\WindowsApps\\Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_2608.3123.1.0_x64__ksqcvrsvwz2jp',
  signatureKind: 'Store',
  hasGameConfig: true,
  gameConfigDisplayName: 'Conker: Live and Reloaded',
  gameConfigExecutable: 'EmuMenu\\EmuMenu.exe',
  titleId: '27028FBB',
  storeId: 'BVFB8CBS75R6',
  displayName: 'Conker: Live and Reloaded',
  publisherDisplayName: 'Gaming Platform Team',
  appId: 'App',
  appDisplayName: null,
  protocols: ['ms-xbl-27028fbb'],
  logos: [
    'C:\\Program Files\\WindowsApps\\Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_2608.3123.1.0_x64__ksqcvrsvwz2jp\\Logo.png',
    'C:\\Program Files\\WindowsApps\\Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_2608.3123.1.0_x64__ksqcvrsvwz2jp\\SmallLogo.png'
  ],
  error: null
}

const UWP_GAME: AppxPackageRecord = {
  name: 'Microsoft.MinecraftUWP',
  packageFamilyName: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe',
  packageFullName: 'Microsoft.MinecraftUWP_1.21.0.0_x64__8wekyb3d8bbwe',
  publisher: 'CN=Microsoft Corporation',
  installLocation:
    'C:\\Program Files\\WindowsApps\\Microsoft.MinecraftUWP_1.21.0.0_x64__8wekyb3d8bbwe',
  signatureKind: 'Store',
  hasGameConfig: false,
  displayName: 'Minecraft for Windows 10',
  appId: 'Game',
  protocols: 'ms-xbl-38f61c1f',
  logos:
    'C:\\Program Files\\WindowsApps\\Microsoft.MinecraftUWP_1.21.0.0_x64__8wekyb3d8bbwe\\Assets\\Logo.scale-200.png'
}

const PLAIN_APP: AppxPackageRecord = {
  name: 'Microsoft.WindowsCalculator',
  packageFamilyName: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe',
  packageFullName: 'Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe',
  publisher: 'CN=Microsoft Corporation',
  installLocation:
    'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.0_x64__8wekyb3d8bbwe',
  signatureKind: 'Store',
  hasGameConfig: false,
  displayName: 'Calculator',
  appId: 'App',
  protocols: ['calculator'],
  logos: []
}

describe('game classification', () => {
  it('accepts MicrosoftGame.config packages and Xbox Live protocol handlers, rejects platform apps', () => {
    expect(isGamePackage(CONKER)).toBe(true)
    expect(isGamePackage(UWP_GAME)).toBe(true)
    expect(isGamePackage(PLAIN_APP)).toBe(false)
    expect(
      isGamePackage({
        ...UWP_GAME,
        name: 'Microsoft.GamingApp',
        packageFamilyName: 'Microsoft.GamingApp_8wekyb3d8bbwe'
      })
    ).toBe(false)
    expect(isGamePackage({ ...CONKER, hasGameConfig: false, protocols: null })).toBe(false)
  })
})

describe('titles', () => {
  it('cleans Playnite-style suffixes and trademarks', () => {
    expect(cleanTitle('Forza Horizon 5 (PC)')).toBe('Forza Horizon 5')
    expect(cleanTitle('Minecraft for Windows 10')).toBe('Minecraft')
    expect(cleanTitle('Gears of War 4 - Windows 10')).toBe('Gears of War 4')
    expect(cleanTitle('Fuzion Frenzy®')).toBe('Fuzion Frenzy')
    expect(cleanTitle('Halo Infinite (Windows)')).toBe('Halo Infinite')
  })

  it('falls through unresolved ms-resource names', () => {
    expect(titleFor(CONKER)).toBe('Conker: Live and Reloaded')
    expect(titleFor({ ...CONKER, displayName: 'ms-resource:AppName' })).toBe(
      'Conker: Live and Reloaded'
    )
    expect(
      titleFor({
        ...CONKER,
        displayName: null,
        gameConfigDisplayName: null,
        appDisplayName: 'From App'
      })
    ).toBe('From App')
    expect(
      titleFor({
        ...CONKER,
        displayName: null,
        gameConfigDisplayName: '',
        appDisplayName: 'ms-resource:DisplayName'
      })
    ).toBe('PrimaryConkerLiveReloade')
  })
})

describe('scanned games', () => {
  it('maps a package record to a UWP launch with the package logo as icon', () => {
    const game = buildScannedGame(
      { ...CONKER, realInstallLocation: 'C:\\XboxGames\\Conker- Live and Reloaded\\Content' },
      'C:\\XboxGames\\Conker- Live and Reloaded\\Content\\EmuMenu\\EmuMenu.exe'
    )
    expect(game).toEqual({
      source: 'xbox',
      externalId: 'Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_ksqcvrsvwz2jp',
      platformId: 'xbox-pc',
      title: 'Conker: Live and Reloaded',
      installDir: 'C:\\XboxGames\\Conker- Live and Reloaded\\Content',
      exePath: 'C:\\XboxGames\\Conker- Live and Reloaded\\Content\\EmuMenu\\EmuMenu.exe',
      launch: {
        kind: 'uwp',
        aumid: 'Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_ksqcvrsvwz2jp!App'
      },
      tracking: {
        mode: 'uwp',
        packageFamilyName: 'Xbox360BackwardCompatibil.PrimaryConkerLiveReloade_ksqcvrsvwz2jp'
      },
      extra: {
        packageFullName: CONKER.packageFullName,
        appId: 'App',
        titleId: '27028FBB',
        storeId: 'BVFB8CBS75R6',
        publisherDisplayName: 'Gaming Platform Team'
      },
      localMedia: { icon: CONKER.logos![0] }
    })
  })

  it('handles PowerShell single-value unrolling and filters non-games', () => {
    const games = mapPackages([CONKER, UWP_GAME, PLAIN_APP, CONKER])
    expect(games.map((g) => g.title)).toEqual(['Conker: Live and Reloaded', 'Minecraft'])
    expect(games[1].launch).toEqual({
      kind: 'uwp',
      aumid: 'Microsoft.MinecraftUWP_8wekyb3d8bbwe!Game'
    })
    expect(games[1].localMedia).toEqual({
      icon: 'C:\\Program Files\\WindowsApps\\Microsoft.MinecraftUWP_1.21.0.0_x64__8wekyb3d8bbwe\\Assets\\Logo.scale-200.png'
    })
    expect(games[1].installDir).toBe(UWP_GAME.installLocation)
  })
})

describe('xbox integration (this machine)', () => {
  it('detects the Xbox app and enumerates packaged games without throwing', async () => {
    const client = await xboxProvider.detectClient()
    console.info(`[xbox] client: ${JSON.stringify(client)}`)
    if (!client.installed) {
      console.info('[xbox] neither the Xbox app nor the Microsoft Store is installed; scan skipped')
      return
    }
    const started = Date.now()
    const games = await xboxProvider.scanInstalled({
      settings: defaultSettings(),
      log: verbose,
      resourcesDir: resolve('resources/systems'),
      progress: () => {}
    })
    console.info(
      `[xbox] ${games.length} game(s) in ${Date.now() - started} ms: ${games.map((g) => `${g.title} [${g.externalId}] ${g.installDir} icon=${g.localMedia?.icon ?? '-'}`).join('; ')}`
    )
    for (const g of games) {
      expect(g.source).toBe('xbox')
      expect(g.launch.kind).toBe('uwp')
      expect(g.tracking).toEqual({ mode: 'uwp', packageFamilyName: g.externalId })
      expect(g.title).not.toMatch(/^ms-resource/i)
    }
  }, 180_000)
})
