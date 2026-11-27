import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeGame, testLog, testSettings, webpBytes, writeTree } from '../test-helpers'
import { createGalaxyCacheSource, galaxyKeysOf } from './galaxy-cache'

const SHA = 'f'.repeat(64)
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-galaxy-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<void> {
  await writeTree(dir, {
    [`123456/steam/440/${SHA}_glx_vertical_cover.webp`]: webpBytes(342, 482),
    [`123456/steam/440/${SHA}_glx_bg_top_padding_7.webp`]: webpBytes(1600, 650),
    [`123456/steam/440/${SHA}_glx_square_icon_v2.webp`]: webpBytes(112, 112),
    [`123456/epic/Jasper/${SHA}_glx_vertical_cover.webp`]: webpBytes(342, 482, true),
    [`123456/origin/OFB-EAST1000011/${SHA}_glx_vertical_cover.webp`]: webpBytes(342, 482),
    [`123456/xboxone/1015340672/${SHA}_glx_vertical_cover.webp`]: webpBytes(342, 482),
    [`123456/battlenet/wow/${SHA}_glx_vertical_cover.webp`]: webpBytes(342, 482),
    [`123456/gog/1207659039/${SHA}_glx_vertical_cover.webp`]: webpBytes(460, 215),
    'common/Cache/data_0': 'chromium',
    '1-overlay/Cache/data_0': 'chromium'
  })
}

describe('galaxyKeysOf', () => {
  it('maps every id space to its platform folder and keeps only numeric Xbox ids', () => {
    expect(
      galaxyKeysOf({
        steamAppId: 440,
        epicAppName: 'Jasper',
        gogProductId: '1207659039',
        eaOfferId: 'OFB-EAST1000011',
        xboxStoreId: '9NBLGGH4R315',
        xboxTitleId: '1015340672',
        battlenetCode: 'wow'
      })
    ).toEqual([
      { platform: 'steam', id: '440' },
      { platform: 'epic', id: 'Jasper' },
      { platform: 'gog', id: '1207659039' },
      { platform: 'origin', id: 'OFB-EAST1000011' },
      { platform: 'xboxone', id: '1015340672' },
      { platform: 'battlenet', id: 'wow' }
    ])
  })
})

describe('galaxy-cache source', () => {
  it('is unavailable without a user folder', async () => {
    await writeTree(dir, { 'common/x': '' })
    const s = createGalaxyCacheSource({ webcacheDir: dir, log: testLog })
    expect(await s.isAvailable(testSettings())).toBe(false)
    expect(await s.isAvailable(testSettings())).toBe(false)
  })

  it('finds covers, heroes and icons by suffix for a Steam appid', async () => {
    await fixture()
    const s = createGalaxyCacheSource({ webcacheDir: dir, log: testLog })
    expect(await s.isAvailable(testSettings())).toBe(true)
    const found = await s.lookup(fakeGame('steam', '440'), { steamAppId: 440 }, [
      'cover',
      'hero',
      'icon',
      'logo'
    ])
    expect(found.cover?.[0]).toMatchObject({
      source: 'galaxy-cache',
      path: join(dir, '123456', 'steam', '440', `${SHA}_glx_vertical_cover.webp`),
      width: 342,
      height: 482
    })
    expect(found.hero?.[0]).toMatchObject({ width: 1600, height: 650 })
    expect(found.icon?.[0]).toMatchObject({ width: 112 })
    expect(found.logo).toBeUndefined()
  })

  it('keys the other stores by their own ids, case-insensitively', async () => {
    await fixture()
    const s = createGalaxyCacheSource({ webcacheDir: dir, log: testLog })
    for (const ids of [
      { epicAppName: 'jasper' },
      { eaOfferId: 'OFB-EAST1000011' },
      { xboxTitleId: '1015340672' },
      { battlenetCode: 'wow' }
    ]) {
      const found = await s.lookup(fakeGame('manual', 'x'), ids, ['cover'])
      expect(found.cover, JSON.stringify(ids)).toHaveLength(1)
    }
    expect(
      await s.lookup(fakeGame('xbox', 'x'), { xboxStoreId: '9NBLGGH4R315' }, ['cover'])
    ).toEqual({})
  })

  it('rejects a file whose real size fails the kind (a landscape "vertical cover")', async () => {
    await fixture()
    const s = createGalaxyCacheSource({ webcacheDir: dir, log: testLog })
    expect(
      await s.lookup(fakeGame('gog', '1207659039'), { gogProductId: '1207659039' }, ['cover'])
    ).toEqual({})
  })

  it('lists the ids of a platform for the probe', async () => {
    await fixture()
    const s = createGalaxyCacheSource({ webcacheDir: dir, log: testLog })
    expect(await s.cachedIds('steam')).toEqual(['440'])
    expect(await s.cachedIds('epic')).toEqual(['jasper'])
  })
})
