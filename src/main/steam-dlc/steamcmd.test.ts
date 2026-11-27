import { describe, expect, it } from 'vitest'
import { itemNamesUrl, parseItemNames, parseSteamcmdDlc } from './steamcmd'

const manifest = (size: number): { public: { size: string } } => ({
  public: { size: String(size) }
})

describe('parseSteamcmdDlc', () => {
  it('lists the DLC with their Windows / English content sizes', () => {
    const answer = {
      status: 'success',
      data: {
        '251470': {
          extended: { listofdlc: '337840,337850,337860' },
          depots: {
            '251471': { manifests: manifest(5000) },
            '337841': { dlcappid: '337840', manifests: manifest(100) },
            '337842': {
              dlcappid: '337840',
              config: { oslist: 'windows' },
              manifests: manifest(50)
            },
            '337843': { dlcappid: '337840', config: { oslist: 'macos' }, manifests: manifest(999) },
            '337844': {
              dlcappid: '337840',
              config: { language: 'german' },
              manifests: manifest(999)
            },
            '337845': {
              dlcappid: '337840',
              config: { lowviolence: '1' },
              manifests: manifest(999)
            },
            '337851': { dlcappid: '337850', config: { osarch: '32' }, manifests: manifest(70) },
            '337852': { dlcappid: '337850', config: { osarch: '64' }, manifests: manifest(80) },
            // A DLC Steam's list leaves out but which has content.
            '337871': { dlcappid: '337870', manifests: manifest(10) },
            '337872': { dlcappid: '337870', config: { optionaldlc: '337870' } },
            branches: { public: { buildid: '1' } }
          }
        }
      }
    }
    expect(parseSteamcmdDlc(answer, 251470)).toEqual([
      { appId: 337840, sizeBytes: 150, steamOnly: false },
      { appId: 337850, sizeBytes: 80, steamOnly: false },
      { appId: 337860, sizeBytes: null, steamOnly: false },
      { appId: 337870, sizeBytes: 10, steamOnly: true }
    ])
  })

  it('marks every DLC Steam-only when the game manages its DLC', () => {
    const answer = {
      data: { '10': { extended: { listofdlc: '11,12' }, depots: { appmanagesdlc: '1' } } }
    }
    expect(parseSteamcmdDlc(answer, 10).map((d) => d.steamOnly)).toEqual([true, true])
  })

  it('is empty for an app without DLC or unknown to steamcmd', () => {
    expect(parseSteamcmdDlc({ data: { '10': {} } }, 10)).toEqual([])
    expect(parseSteamcmdDlc({}, 10)).toEqual([])
  })
})

describe('GetItems names', () => {
  it('reads names of the items Steam knows', () => {
    expect(
      parseItemNames({
        response: {
          store_items: [
            { appid: 1, name: ' Dark World ', success: 1 },
            { appid: 2, success: 2 },
            { id: 3, name: 'Hidden', success: 2 },
            { appid: 4, name: 'Four' }
          ]
        }
      })
    ).toEqual(
      new Map([
        [1, 'Dark World'],
        [4, 'Four']
      ])
    )
    expect(parseItemNames({})).toEqual(new Map())
  })

  it('builds the request with every id', () => {
    const url = new URL(itemNamesUrl([1, 2]))
    expect(url.origin + url.pathname).toBe(
      'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/'
    )
    expect(JSON.parse(url.searchParams.get('input_json') ?? '')).toMatchObject({
      ids: [{ appid: 1 }, { appid: 2 }]
    })
  })
})
