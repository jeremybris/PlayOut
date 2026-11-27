import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  binaryVdfBytes,
  fakeGame,
  jpegBytes,
  pngBytes,
  testLog,
  testSettings,
  writeTree
} from '../test-helpers'
import {
  createSteamCacheSource,
  parseAssetCache,
  parseBinaryVdf,
  type SteamCacheSource
} from './steam-cache'

const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)
const ICON = `${'c'.repeat(40)}.jpg`

let root: string
let cache: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-steam-'))
  cache = join(root, 'appcache', 'librarycache')
  await writeTree(root, { 'steam.exe': 'x' })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * Old flat layout (620), new hashed layout (1091500), header-only app (999), Steam's drawn stand-in cover (444: PNG data
 * under the JPEG name, for a game with no portrait art on Steam's servers), unindexed (7777).
 */
async function fixture(withIndex = true): Promise<void> {
  await writeTree(cache, {
    '620/library_600x900.jpg': jpegBytes(300, 450),
    '620/library_hero.jpg': jpegBytes(1920, 620),
    '620/library_hero_blur.jpg': jpegBytes(192, 62),
    '620/logo.png': pngBytes(640, 360, true),
    '620/header.jpg': jpegBytes(460, 215),
    [`620/${ICON}`]: jpegBytes(32, 32),
    [`1091500/${HASH_A}/library_600x900.jpg`]: jpegBytes(600, 900),
    [`1091500/${HASH_A}/library_hero.jpg`]: jpegBytes(1920, 1080),
    [`1091500/${HASH_B}/library_header.jpg`]: jpegBytes(460, 215),
    [`1091500/${'d'.repeat(40)}.jpg`]: jpegBytes(1000, 1000),
    '999/header.jpg': jpegBytes(460, 215),
    '444/library_600x900.jpg': pngBytes(600, 900),
    '7777/library_capsule.jpg': jpegBytes(300, 450),
    '7777/logo.png': pngBytes(640, 360, false)
  })
  if (!withIndex) return
  await fs.writeFile(
    join(cache, 'assetcache.vdf'),
    binaryVdfBytes({
      '': {
        cache_version: 2,
        '0': {
          '620': {
            '0f': 'library_600x900.jpg',
            '1f': 'library_hero.jpg',
            '2f': 'logo.png',
            '3f': 'header.jpg',
            '4f': ICON,
            '5f': 'library_hero_blur.jpg',
            ma: 8
          },
          '1091500': {
            '0f': `${HASH_A}/library_600x900.jpg`,
            '1f': `${HASH_A}/library_hero.jpg`,
            '3f': `${HASH_B}/library_header.jpg`,
            '7f': `${'d'.repeat(40)}.jpg`
          },
          '999': { '3f': 'header.jpg' },
          '444': { '0f': 'gone/library_600x900.jpg' },
          '555': { '0f': 'library_600x900.jpg' }
        }
      }
    })
  )
}

function source(): SteamCacheSource {
  return createSteamCacheSource({ steamRoot: async () => root, log: testLog })
}

describe('parseBinaryVdf', () => {
  it('round-trips nested objects, strings and int32 values', () => {
    const bytes = binaryVdfBytes({ '': { a: 'x', n: 7, o: { k: 'v' } } })
    expect(parseBinaryVdf(bytes)).toEqual({ '': { a: 'x', n: 7, o: { k: 'v' } } })
  })

  it('maps the asset cache indices to kinds and skips svg / unknown indices', () => {
    const bytes = binaryVdfBytes({
      '': {
        '0': {
          '10': { '0f': 'library_600x900.jpg', '6f': 'x/markers.svg', '7f': 'sq.jpg' },
          '20': { '3f': 'header.jpg' },
          meta: 'ignored'
        }
      }
    })
    const index = parseAssetCache(bytes)
    expect(index.get(10)).toEqual({ cover: 'library_600x900.jpg' })
    expect(index.has(20)).toBe(false)
  })
})

describe('steam-cache source', () => {
  it('is unavailable without a Steam install', async () => {
    const s = createSteamCacheSource({ steamRoot: async () => null, log: testLog })
    expect(await s.isAvailable(testSettings())).toBe(false)
    expect(await s.lookup(fakeGame('steam', '620'), { steamAppId: 620 }, ['cover'])).toEqual({})
  })

  it('finds flat-layout art through the index and sniffs the real size', async () => {
    await fixture()
    const s = source()
    const found = await s.lookup(fakeGame('steam', '620'), { steamAppId: 620 }, [
      'cover',
      'hero',
      'logo',
      'icon'
    ])
    expect(found.cover?.[0]).toMatchObject({
      source: 'steam-cache',
      path: join(cache, '620', 'library_600x900.jpg'),
      width: 300,
      height: 450
    })
    expect(found.hero?.[0]).toMatchObject({ width: 1920, height: 620 })
    expect(found.logo?.[0]).toMatchObject({ path: join(cache, '620', 'logo.png') })
    expect(found.icon?.[0]).toMatchObject({ path: join(cache, '620', ICON), width: 32 })
  })

  it('finds hashed-layout art, accepts a 16:9 hero as fallback and never the 7f square', async () => {
    await fixture()
    const found = await source().lookup(fakeGame('steam', '1091500'), { steamAppId: 1091500 }, [
      'cover',
      'hero',
      'logo',
      'icon'
    ])
    expect(found.cover?.[0]).toMatchObject({
      path: join(cache, '1091500', HASH_A, 'library_600x900.jpg'),
      width: 600,
      height: 900
    })
    expect(found.hero?.[0]).toMatchObject({ width: 1920, height: 1080 })
    expect(found.logo).toBeUndefined()
    expect(found.icon).toBeUndefined()
  })

  it("never takes Steam's drawn stand-in (PNG under the JPEG name) as a cover", async () => {
    await writeTree(cache, {
      '21090/library_600x900.jpg': pngBytes(600, 900, false),
      '21090/library_hero.jpg': jpegBytes(1920, 620),
      '21090/header.jpg': jpegBytes(460, 215)
    })
    const found = await source().lookup(fakeGame('steam', '21090'), { steamAppId: 21090 }, [
      'cover',
      'hero'
    ])
    expect(found.cover).toBeUndefined()
    // The rest of its art is Steam's own and still used.
    expect(found.hero?.[0]).toMatchObject({ width: 1920, height: 620 })
  })

  it('answers nothing for a header-only app (no walk, no header as cover)', async () => {
    await fixture()
    expect(await source().lookup(fakeGame('steam', '999'), { steamAppId: 999 }, ['cover'])).toEqual(
      {}
    )
  })

  it('walks the folder when the indexed file is gone and when the app is not indexed', async () => {
    await fixture()
    const s = source()
    // 444's indexed file is gone and the walk finds only Steam's drawn stand-in: no cover (the lane goes on).
    expect(await s.lookup(fakeGame('steam', '444'), { steamAppId: 444 }, ['cover'])).toEqual({})
    const capsule = await s.lookup(fakeGame('steam', '7777'), { steamAppId: 7777 }, [
      'cover',
      'logo'
    ])
    expect(capsule.cover?.[0]).toMatchObject({ path: join(cache, '7777', 'library_capsule.jpg') })
    expect(capsule.logo?.[0]).toMatchObject({ path: join(cache, '7777', 'logo.png') })
    expect(await s.lookup(fakeGame('steam', '555'), { steamAppId: 555 }, ['cover'])).toEqual({})
  })

  it('works without assetcache.vdf by walking folders, newest hash folder first', async () => {
    await fixture(false)
    const s = source()
    expect(await s.isAvailable(testSettings())).toBe(true)
    const old = await s.lookup(fakeGame('steam', '620'), { steamAppId: 620 }, ['cover', 'icon'])
    expect(old.cover?.[0]).toMatchObject({ width: 300, height: 450 })
    expect(old.icon?.[0]).toMatchObject({ width: 32 })
    const hashed = await s.lookup(fakeGame('steam', '1091500'), { steamAppId: 1091500 }, ['cover'])
    expect(hashed.cover?.[0]).toMatchObject({
      path: join(cache, '1091500', HASH_A, 'library_600x900.jpg')
    })
  })

  it('takes the newest hash folder first when several hold a cover', async () => {
    const old = join(cache, '2000', HASH_A)
    const fresh = join(cache, '2000', HASH_B)
    await writeTree(cache, {
      [`2000/${HASH_A}/library_600x900.jpg`]: jpegBytes(300, 450),
      [`2000/${HASH_B}/library_600x900.jpg`]: jpegBytes(600, 900)
    })
    const t = Date.now() / 1000
    await fs.utimes(old, t - 86_400, t - 86_400)
    await fs.utimes(fresh, t, t)
    const s = source()
    const found = await s.lookup(fakeGame('steam', '2000'), { steamAppId: 2000 }, ['cover'])
    expect(found.cover?.[0]).toMatchObject({ path: join(fresh, 'library_600x900.jpg'), width: 600 })
    // Swap the dates: the other folder wins.
    await fs.utimes(old, t, t)
    await fs.utimes(fresh, t - 86_400, t - 86_400)
    s.reset()
    const swapped = await s.lookup(fakeGame('steam', '2000'), { steamAppId: 2000 }, ['cover'])
    expect(swapped.cover?.[0]).toMatchObject({ path: join(old, 'library_600x900.jpg'), width: 300 })
  })

  it('uses an indexed top-level capsule and never a newer hashed header as the cover', async () => {
    // The dominant real layout: assetcache.vdf names a top-level 300x450 file, the hash folders hold newer
    // header / hero assets that are not covers.
    await writeTree(cache, {
      '3000/library_capsule.jpg': jpegBytes(300, 450),
      [`3000/${HASH_A}/library_header.jpg`]: jpegBytes(460, 215),
      [`3000/${HASH_A}/library_hero.jpg`]: jpegBytes(1920, 620)
    })
    await fs.writeFile(
      join(cache, 'assetcache.vdf'),
      binaryVdfBytes({
        '': {
          '0': { '3000': { '0f': 'library_capsule.jpg', '3f': `${HASH_A}/library_header.jpg` } }
        }
      })
    )
    const found = await source().lookup(fakeGame('steam', '3000'), { steamAppId: 3000 }, [
      'cover',
      'hero'
    ])
    expect(found.cover?.[0]).toMatchObject({
      path: join(cache, '3000', 'library_capsule.jpg'),
      width: 300,
      height: 450
    })
    // No `1f` entry: the index is Steam's own view, so the hero in the hash folder is not walked for.
    expect(found.hero).toBeUndefined()
  })

  it('lists cached appids and forgets its index on reset', async () => {
    await fixture()
    const s = source()
    expect(await s.cachedAppIds(testSettings())).toEqual([444, 555, 620, 999, 7777, 1091500])
    await writeTree(cache, { '8888/library_600x900.jpg': jpegBytes(300, 450) })
    expect(await s.lookup(fakeGame('steam', '8888'), { steamAppId: 8888 }, ['cover'])).toEqual({})
    s.reset()
    expect(
      (await s.lookup(fakeGame('steam', '8888'), { steamAppId: 8888 }, ['cover'])).cover
    ).toHaveLength(1)
  })

  it('ignores games without a Steam appid', async () => {
    await fixture()
    expect(await source().lookup(fakeGame('gog', '1'), { gogProductId: '1' }, ['cover'])).toEqual(
      {}
    )
  })
})
