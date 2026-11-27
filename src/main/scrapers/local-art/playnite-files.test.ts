import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeGame, jpegBytes, pngBytes, testLog, testSettings, writeTree } from '../test-helpers'
import { createPlayniteFilesSource, PLAYNITE_PLUGINS, playniteKeysOf } from './playnite-files'

const GAME_A = '0f1e2d3c-0000-4000-8000-000000000001'
const GAME_B = '0f1e2d3c-0000-4000-8000-000000000002'
const GAME_C = '0f1e2d3c-0000-4000-8000-000000000003'
const GAME_D = '0f1e2d3c-0000-4000-8000-000000000004'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-playnite-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<void> {
  await writeTree(dir, {
    [`library/games/${GAME_A}.json`]: JSON.stringify({
      Id: GAME_A,
      GameId: '620',
      PluginId: 'CB91DFC9-B977-43BF-8E70-55F46E410FAB',
      Name: 'Portal 2',
      CoverImage: `${GAME_A}\\cover.jpg`,
      BackgroundImage: `${GAME_A}\\bg.jpg`,
      Icon: `${GAME_A}\\icon.png`
    }),
    [`library/games/${GAME_B}.json`]: JSON.stringify({
      Id: GAME_B,
      GameId: 'OFB-EAST1000011',
      PluginId: '85DD7072-2F20-4E76-A007-41035E390724',
      Name: 'EA game'
    }),
    'library/games/broken.json': '{not json',
    [`library/files/${GAME_A}/cover.jpg`]: jpegBytes(600, 900),
    [`library/files/${GAME_A}/bg.jpg`]: jpegBytes(1920, 620),
    [`library/files/${GAME_A}/icon.png`]: pngBytes(64, 64),
    [`library/files/${GAME_B}/some-cover.png`]: pngBytes(600, 900, false),
    [`library/files/${GAME_B}/wide.jpg`]: jpegBytes(1920, 1080)
  })
}

describe('playniteKeysOf', () => {
  it('lists every store id under its Playnite plugin GUID, lower-cased', () => {
    expect(
      playniteKeysOf({ steamAppId: 620, eaOfferId: 'OFB-EAST1000011', epicAppName: 'Jasper' })
    ).toEqual([
      `${PLAYNITE_PLUGINS.steam}|620`,
      `${PLAYNITE_PLUGINS.epic}|jasper`,
      `${PLAYNITE_PLUGINS.ea}|ofb-east1000011`
    ])
  })
})

describe('playnite-files source', () => {
  it('is unavailable without a Playnite library folder', async () => {
    const s = createPlayniteFilesSource({ playniteDir: join(dir, 'none'), log: testLog })
    expect(await s.isAvailable(testSettings())).toBe(false)
  })

  it('finds the record paths by store id', async () => {
    await fixture()
    const s = createPlayniteFilesSource({ playniteDir: dir, log: testLog })
    expect(await s.isAvailable(testSettings())).toBe(true)
    const found = await s.lookup(fakeGame('steam', '620'), { steamAppId: 620 }, [
      'cover',
      'hero',
      'icon',
      'logo'
    ])
    expect(found.cover?.[0]).toMatchObject({
      source: 'playnite-files',
      path: join(dir, 'library', 'files', GAME_A, 'cover.jpg'),
      width: 600
    })
    expect(found.hero?.[0]).toMatchObject({ width: 1920, height: 620 })
    expect(found.icon?.[0]).toMatchObject({ width: 64 })
    expect(found.logo).toBeUndefined()
  })

  it('scans the game folder when the record names no file', async () => {
    await fixture()
    const s = createPlayniteFilesSource({ playniteDir: dir, log: testLog })
    const found = await s.lookup(fakeGame('ea', 'x'), { eaOfferId: 'ofb-east1000011' }, [
      'cover',
      'hero'
    ])
    expect(found.cover?.[0]).toMatchObject({
      path: join(dir, 'library', 'files', GAME_B, 'some-cover.png')
    })
    expect(found.hero?.[0]).toMatchObject({
      path: join(dir, 'library', 'files', GAME_B, 'wide.jpg')
    })
  })

  it('answers nothing for unknown ids', async () => {
    await fixture()
    const s = createPlayniteFilesSource({ playniteDir: dir, log: testLog })
    expect(await s.lookup(fakeGame('gog', '1'), { gogProductId: '1' }, ['cover'])).toEqual({})
  })

  it("never answers another plugin's record for the same numeric id", async () => {
    // An itch.io game whose GameId is 2823, and no Steam record for appid 2823: the Steam game gets nothing.
    await writeTree(dir, {
      [`library/games/${GAME_C}.json`]: JSON.stringify({
        Id: GAME_C,
        GameId: '2823',
        PluginId: '00000001-EBB2-2EEC-ABCB-7C9F2E29DE4E',
        Name: 'An itch.io game'
      }),
      [`library/files/${GAME_C}/cover.png`]: pngBytes(600, 900, false),
      'library/games/no-plugin.json': JSON.stringify({ Id: GAME_D, GameId: '2823' })
    })
    const s = createPlayniteFilesSource({ playniteDir: dir, log: testLog })
    expect(await s.lookup(fakeGame('steam', '2823'), { steamAppId: 2823 }, ['cover'])).toEqual({})
  })
})
