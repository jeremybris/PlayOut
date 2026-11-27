import { describe, expect, it } from 'vitest'
import { STORE_SOURCE_IDS } from '../store/settings-schema'
import {
  installLaunchSpec,
  installUriFor,
  isAllowedInstallUri,
  msStoreUriFor,
  storeDownloadsPage
} from './install-uri'

describe('install URIs', () => {
  it('builds each store form from the provider ids', () => {
    expect(installUriFor('steam', { externalId: '620', extra: { steamAppId: 620 } })).toBe(
      'steam://install/620'
    )
    expect(
      installUriFor('epic', { externalId: 'Alan Wake', extra: { epicAppName: 'Alan Wake' } })
    ).toBe('com.epicgames.launcher://apps/Alan%20Wake?action=install')
    expect(installUriFor('gog', { externalId: '1207658924' })).toBe(
      'goggalaxy://openGameView/1207658924'
    )
    expect(
      installUriFor('xbox', {
        externalId: 'Microsoft.Conker_8wekyb3d8bbwe',
        extra: { storeId: '9NBLGGH4R2R6' }
      })
    ).toBe('msxbox://game/?productId=9NBLGGH4R2R6')
    expect(installUriFor('ea', { externalId: '1028663', extra: { contentId: '1028663' } })).toBe(
      'origin2://game/launch/?offerIds=1028663'
    )
    expect(installUriFor('ubisoft', { externalId: '5595', extra: { ubisoftId: '5595' } })).toBe(
      'uplay://install/5595'
    )
    expect(installUriFor('battlenet', { externalId: 'WoW' })).toBeNull()
    expect(msStoreUriFor({ externalId: 'x', extra: { storeId: '9NBLGGH4R2R6' } })).toBe(
      'ms-windows-store://pdp/?ProductId=9NBLGGH4R2R6'
    )
  })

  it('refuses ids that are not what the scheme expects', () => {
    expect(installUriFor('steam', { externalId: 'not-a-number' })).toBeNull()
    expect(installUriFor('xbox', { externalId: 'pfn', extra: {} })).toBeNull()
    expect(installUriFor('xbox', { externalId: 'pfn', extra: { storeId: 'bad id/..' } })).toBeNull()
    expect(installUriFor('ea', { externalId: 'path:abc' })).toBeNull()
    expect(installUriFor('ubisoft', { externalId: 'abc' })).toBeNull()
  })

  it('allow-lists the store schemes only', () => {
    expect(isAllowedInstallUri('steam://install/620')).toBe(true)
    expect(isAllowedInstallUri('COM.EPICGAMES.LAUNCHER://apps/x?action=install')).toBe(true)
    expect(isAllowedInstallUri('ms-windows-store://pdp/?ProductId=1')).toBe(true)
    expect(isAllowedInstallUri('https://example.com')).toBe(false)
    expect(isAllowedInstallUri('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isAllowedInstallUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedInstallUri('steam.exe')).toBe(false)
  })

  it("opens each store's downloads (Steam) or library page to pause a download there, all allow-listed", () => {
    expect(storeDownloadsPage('steam')).toBe('steam://open/downloads')
    expect(storeDownloadsPage('gog')).toBe('goggalaxy://openGameView')
    for (const source of STORE_SOURCE_IDS)
      expect(isAllowedInstallUri(storeDownloadsPage(source))).toBe(true)
  })

  it('gives every owned record a launch: the install URI, a battlenet:// marker, or the library page', () => {
    expect(installLaunchSpec('steam', { externalId: '620' })).toEqual({
      kind: 'uri',
      uri: 'steam://install/620'
    })
    expect(installLaunchSpec('battlenet', { externalId: 'WoW' })).toEqual({
      kind: 'uri',
      uri: 'battlenet://WoW'
    })
    expect(installLaunchSpec('xbox', { externalId: 'pfn', extra: {} })).toEqual({
      kind: 'uri',
      uri: 'msxbox://'
    })
    expect(installLaunchSpec('ea', { externalId: 'path:abc' })).toEqual({
      kind: 'uri',
      uri: 'origin2://library/open'
    })
  })
})
