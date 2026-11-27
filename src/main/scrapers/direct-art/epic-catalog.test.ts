import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeGame, testLog, testSettings } from '../test-helpers'
import {
  createEpicCatalogSource,
  epicCandidates,
  indexCatalog,
  parseCatcache
} from './epic-catalog'

const ITEMS = [
  {
    id: 'A1B2C3',
    namespace: 'ns1',
    title: 'Watch Dogs',
    keyImages: [
      {
        type: 'DieselGameBoxTall',
        url: 'https://cdn1.epicgames.com/tall.jpg',
        width: 1200,
        height: 1600
      },
      {
        type: 'DieselGameBox',
        url: 'https://cdn1.epicgames.com/wide.jpg',
        width: 1920,
        height: 1080
      },
      {
        type: 'DieselGameBoxLogo',
        url: 'https://cdn1.epicgames.com/logo.png',
        width: 800,
        height: 400
      }
    ],
    categories: [{ path: 'games' }],
    releaseInfo: [{ appId: 'Jasper', platform: ['Windows'] }]
  },
  {
    id: 'D4E5F6',
    title: 'Offer only',
    keyImages: [{ type: 'OfferImageTall', url: 'https://cdn1.epicgames.com/offer.jpg' }],
    releaseInfo: [{ appId: 'Albacore' }]
  },
  { id: 'NOIMG', title: 'No images', keyImages: [] }
]

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-epic-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('parseCatcache / indexCatalog / epicCandidates', () => {
  it('decodes the base64 JSON array and a plain JSON file alike', () => {
    const b64 = Buffer.from(Buffer.from(JSON.stringify(ITEMS)).toString('base64'))
    expect(parseCatcache(b64)).toHaveLength(3)
    expect(parseCatcache(Buffer.from('\uFEFF' + JSON.stringify(ITEMS)))).toHaveLength(3)
  })

  it('indexes by catalog item id and appName, skipping items without images', () => {
    const index = indexCatalog(ITEMS)
    expect(index.get('a1b2c3')?.title).toBe('Watch Dogs')
    expect(index.get('jasper')?.title).toBe('Watch Dogs')
    expect(index.has('noimg')).toBe(false)
  })

  it('builds the resized cover, hero and logo URLs', () => {
    const art = epicCandidates(ITEMS[0], ['cover', 'hero', 'logo', 'icon'])
    expect(art.cover?.[0]).toMatchObject({
      url: 'https://cdn1.epicgames.com/tall.jpg?w=600&h=900&resize=1',
      width: 675,
      height: 900,
      source: 'epic-catalog'
    })
    expect(art.hero?.[0]).toMatchObject({
      url: 'https://cdn1.epicgames.com/wide.jpg',
      width: 1920,
      height: 1080
    })
    expect(art.logo?.[0]).toMatchObject({ url: 'https://cdn1.epicgames.com/logo.png', width: 800 })
    expect(art.icon).toBeUndefined()
    expect(epicCandidates(ITEMS[1], ['cover']).cover?.[0].url).toBe(
      'https://cdn1.epicgames.com/offer.jpg?w=600&h=900&resize=1'
    )
  })
})

describe('epic-catalog source', () => {
  it('answers from catcache.bin by catalogItemId or appName, nothing without the file', async () => {
    const file = join(dir, 'catcache.bin')
    await fs.writeFile(file, Buffer.from(JSON.stringify(ITEMS)).toString('base64'))
    const s = createEpicCatalogSource({ catcacheFile: file, log: testLog })
    expect(s.batchSize).toBe(1)
    const found = await s.candidates(
      [
        { game: fakeGame('epic', 'Jasper'), ids: { epicAppName: 'Jasper' } },
        { game: fakeGame('epic', 'x'), ids: { epicCatalogItemId: 'd4e5f6' } },
        { game: fakeGame('epic', 'unknown'), ids: { epicAppName: 'unknown' } },
        { game: fakeGame('steam', '1'), ids: { steamAppId: 1 } }
      ],
      ['cover'],
      testSettings()
    )
    expect([...found.keys()]).toEqual(['epic:Jasper', 'epic:x'])
    expect(found.get('epic:Jasper')?.cover?.[0].url).toContain('tall.jpg')

    const missing = createEpicCatalogSource({ catcacheFile: join(dir, 'none.bin'), log: testLog })
    expect(
      await missing.candidates(
        [{ game: fakeGame('epic', 'Jasper'), ids: { epicAppName: 'Jasper' } }],
        ['cover'],
        testSettings()
      )
    ).toEqual(new Map())
  })
})
