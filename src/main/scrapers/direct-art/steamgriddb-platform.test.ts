import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeGame, stubFetch, testLog, testSettings } from '../test-helpers'
import { RateLimiter } from '../http'
import type { DirectArtSource } from '../types'
import { createSteamGridDbPlatformSource, sgdbKeysOf, splitResponse } from './steamgriddb-platform'

const BASE = 'https://sgdb.test/api/v2'

afterEach(() => {
  vi.unstubAllGlobals()
})

const grid = (
  id: number,
  score: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  score,
  url: `https://cdn2.steamgriddb.com/grid/${id}.png`,
  width: 600,
  height: 900,
  nsfw: false,
  humor: false,
  ...extra
})

function source(): DirectArtSource {
  return createSteamGridDbPlatformSource({
    baseUrl: BASE,
    limiter: new RateLimiter(1000, 1000),
    log: testLog
  })
}

describe('sgdbKeysOf / splitResponse', () => {
  it('maps ids to SteamGridDB platforms', () => {
    expect(
      sgdbKeysOf({
        steamAppId: 620,
        epicAppName: 'Jasper',
        eaOfferId: 'OFB',
        battlenetCode: 'wow',
        ubisoftId: '7'
      })
    ).toEqual([
      { platform: 'steam', id: '620' },
      { platform: 'egs', id: 'Jasper' },
      { platform: 'origin', id: 'OFB' },
      { platform: 'bnet', id: 'wow' },
      { platform: 'uplay', id: '7' }
    ])
  })

  it('handles the single-id and the multi-id response shapes', () => {
    expect(splitResponse({ success: true, data: [grid(1, 5)] }, 1)).toEqual([[grid(1, 5)]])
    expect(
      splitResponse(
        { success: true, data: [{ success: true, data: [grid(1, 5)] }, { success: false }] },
        2
      )
    ).toEqual([[grid(1, 5)], []])
  })
})

describe('steamgriddb-platform source', () => {
  it('needs an API key', async () => {
    const calls = stubFetch({})
    const s = source()
    expect(s.isConfigured(testSettings())).toBe(false)
    expect(
      await s.candidates(
        [{ game: fakeGame('steam', '620'), ids: { steamAppId: 620 } }],
        ['cover'],
        testSettings()
      )
    ).toEqual(new Map())
    expect(calls).toHaveLength(0)
  })

  it('asks one grids request per platform batch and keeps the top voted static grid', async () => {
    const calls = stubFetch({
      [`${BASE}/grids/steam/620,440`]: {
        success: true,
        data: [
          { success: true, data: [grid(1, 3), grid(2, 9, { humor: true }), grid(3, 7)] },
          { success: false, errors: ['Game not found'] }
        ]
      },
      [`${BASE}/grids/egs/Jasper`]: { success: true, data: [grid(4, 1)] }
    })
    const settings = testSettings({ steamgriddb: { apiKey: 'k' } })
    const s = source()
    expect(s.isConfigured(settings)).toBe(true)
    expect(s.batchSize).toBe(50)
    const found = await s.candidates(
      [
        { game: fakeGame('steam', '620'), ids: { steamAppId: 620 } },
        { game: fakeGame('steam', '440'), ids: { steamAppId: 440 } },
        { game: fakeGame('epic', 'Jasper'), ids: { epicAppName: 'Jasper' } },
        { game: fakeGame('gog', '1'), ids: { gogProductId: '1' } }
      ],
      ['cover'],
      settings
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain(
      '/grids/steam/620,440?dimensions=600x900&types=static&nsfw=false&humor=false&epilepsy=false'
    )
    expect([...found.keys()].sort()).toEqual(['epic:Jasper', 'steam:620'])
    expect(found.get('steam:620')?.cover?.[0]).toMatchObject({
      url: 'https://cdn2.steamgriddb.com/grid/3.png',
      width: 600,
      height: 900,
      source: 'steamgriddb-platform'
    })
  })

  it('uses the heroes / logos / icons endpoints for the other kinds', async () => {
    const calls = stubFetch({
      [`${BASE}/heroes/steam/620`]: {
        success: true,
        data: [grid(5, 1, { width: 1920, height: 620 })]
      },
      [`${BASE}/logos/steam/620`]: { success: true, data: [] },
      [`${BASE}/icons/steam/620`]: { success: true, data: [grid(6, 1, { width: 64, height: 64 })] }
    })
    const settings = testSettings({ steamgriddb: { apiKey: 'k' } })
    const found = await source().candidates(
      [{ game: fakeGame('steam', '620'), ids: { steamAppId: 620 } }],
      ['hero', 'logo', 'icon'],
      settings
    )
    expect(calls.map((c) => new URL(c).pathname)).toEqual([
      '/api/v2/heroes/steam/620',
      '/api/v2/logos/steam/620',
      '/api/v2/icons/steam/620'
    ])
    expect(calls[0]).toContain('dimensions=1920x620%2C3840x1240')
    const art = found.get('steam:620')!
    expect(art.hero?.[0].width).toBe(1920)
    expect(art.logo).toBeUndefined()
    expect(art.icon?.[0].width).toBe(64)
  })
})
