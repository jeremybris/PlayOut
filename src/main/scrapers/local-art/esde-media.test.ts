import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeGame, jpegBytes, pngBytes, testLog, testSettings, writeTree } from '../test-helpers'
import { createEsdeMediaSource, parseGamelistMedia, romKey } from './esde-media'

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'playout-esde-'))
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const GAMELIST = `<?xml version="1.0"?>
<gameList>
  <game>
    <path>./Chrono Trigger (USA).sfc</path>
    <name>Chrono Trigger</name>
    <image>./media/chrono-image.png</image>
    <thumbnail>./media/chrono-thumb.jpg</thumbnail>
    <marquee>./media/chrono-marquee.png</marquee>
  </game>
  <game><path>./NoMedia.sfc</path><name>No media</name></game>
</gameList>`

async function fixture(): Promise<void> {
  await writeTree(home, {
    'downloaded_media/snes/covers/Chrono Trigger (USA).png': pngBytes(600, 900, false),
    'downloaded_media/snes/marquees/Chrono Trigger (USA).png': pngBytes(640, 360, true),
    'downloaded_media/snes/screenshots/Chrono Trigger (USA).png': pngBytes(1280, 720, false),
    'downloaded_media/snes/fanart/Chrono Trigger (USA).jpg': jpegBytes(1920, 620),
    'downloaded_media/snes/3dboxes/Mario.png': pngBytes(600, 900, false),
    'downloaded_media/snes/covers/notes.txt': 'skip',
    'gamelists/snes/gamelist.xml': GAMELIST,
    'gamelists/snes/media/chrono-image.png': pngBytes(1920, 1080, false),
    'gamelists/snes/media/chrono-thumb.jpg': jpegBytes(300, 450),
    'gamelists/snes/media/chrono-marquee.png': pngBytes(640, 360, true)
  })
}

describe('romKey / parseGamelistMedia', () => {
  it('keys by the lower-cased base name without extension', () => {
    expect(romKey('C:\\ROMs\\snes\\Chrono Trigger (USA).sfc')).toBe('chrono trigger (usa)')
    expect(romKey('./Game.v1.2.zip')).toBe('game.v1.2')
    expect(romKey('.hidden')).toBe('.hidden')
  })

  it('resolves gamelist media paths relative to the gamelist folder', () => {
    const media = parseGamelistMedia(GAMELIST, 'C:\\ES-DE\\gamelists\\snes')
    expect(media.get('chrono trigger (usa)')).toEqual({
      image: 'C:\\ES-DE\\gamelists\\snes\\media\\chrono-image.png',
      thumbnail: 'C:\\ES-DE\\gamelists\\snes\\media\\chrono-thumb.jpg',
      marquee: 'C:\\ES-DE\\gamelists\\snes\\media\\chrono-marquee.png'
    })
    expect(media.has('nomedia')).toBe(false)
    expect(parseGamelistMedia('<not xml', 'x').size).toBe(0)
  })
})

describe('esde-media source', () => {
  it('is unavailable when no ES-DE home exists', async () => {
    const s = createEsdeMediaSource({ esdeHome: join(home, 'nope'), log: testLog })
    expect(await s.isAvailable(testSettings())).toBe(false)
  })

  it('finds covers, marquees, fanart and screenshots by system and ROM name', async () => {
    await fixture()
    const s = createEsdeMediaSource({ esdeHome: home, log: testLog })
    const settings = testSettings()
    expect(await s.isAvailable(settings)).toBe(true)
    const ids = { romSystemId: 'snes', romName: 'Chrono Trigger (USA)' }
    const found = await s.lookup(fakeGame('rom', 'snes/Chrono Trigger (USA).sfc'), ids, [
      'cover',
      'logo',
      'hero',
      'screenshot',
      'icon'
    ])
    expect(found.cover?.[0]).toMatchObject({
      source: 'esde-media',
      path: join(home, 'downloaded_media', 'snes', 'covers', 'Chrono Trigger (USA).png'),
      width: 600
    })
    expect(found.logo?.[0]).toMatchObject({
      path: join(home, 'downloaded_media', 'snes', 'marquees', 'Chrono Trigger (USA).png')
    })
    expect(found.hero?.[0]).toMatchObject({ width: 1920, height: 620 })
    expect(found.screenshot?.[0]).toMatchObject({ width: 1280, height: 720 })
    expect(found.icon).toBeUndefined()
  })

  it('finds the media of a ROM in a sub-folder in the mirrored sub-folder, else at the top level', async () => {
    await writeTree(home, {
      'downloaded_media/ps2/covers/Favorites 1/Okami (USA).png': pngBytes(600, 900, false),
      'downloaded_media/ps2/screenshots/Okami (USA).png': pngBytes(1280, 720, false)
    })
    const s = createEsdeMediaSource({ esdeHome: home, log: testLog })
    await s.index(testSettings())
    const found = await s.lookup(
      fakeGame('rom', 'ps2/Favorites 1/Okami (USA).iso'),
      { romSystemId: 'ps2', romName: 'Okami (USA)', romRelDir: 'Favorites 1' },
      ['cover', 'screenshot']
    )
    expect(found.cover?.[0]).toMatchObject({
      path: join(home, 'downloaded_media', 'ps2', 'covers', 'Favorites 1', 'Okami (USA).png')
    })
    expect(found.screenshot?.[0]).toMatchObject({
      path: join(home, 'downloaded_media', 'ps2', 'screenshots', 'Okami (USA).png')
    })
  })

  it('falls back to the gamelist thumbnail / marquee and to 3dboxes', async () => {
    await fixture()
    await fs.rm(join(home, 'downloaded_media', 'snes', 'covers'), { recursive: true })
    await fs.rm(join(home, 'downloaded_media', 'snes', 'marquees'), { recursive: true })
    const s = createEsdeMediaSource({ esdeHome: home, log: testLog })
    await s.index(testSettings())
    const chrono = await s.lookup(
      fakeGame('rom', 'x'),
      { romSystemId: 'snes', romName: 'Chrono Trigger (USA)' },
      ['cover', 'logo']
    )
    expect(chrono.cover?.[0]).toMatchObject({
      path: join(home, 'gamelists', 'snes', 'media', 'chrono-thumb.jpg'),
      width: 300
    })
    expect(chrono.logo?.[0]).toMatchObject({
      path: join(home, 'gamelists', 'snes', 'media', 'chrono-marquee.png')
    })
    const mario = await s.lookup(fakeGame('rom', 'y'), { romSystemId: 'snes', romName: 'Mario' }, [
      'cover'
    ])
    expect(mario.cover?.[0]).toMatchObject({
      path: join(home, 'downloaded_media', 'snes', '3dboxes', 'Mario.png')
    })
  })

  it('honours the MediaDirectory of es_settings.xml and settings.library.esdeHome', async () => {
    await writeTree(home, {
      'ES-DE/gamelists/.keep': '',
      'ES-DE/settings/es_settings.xml':
        '<?xml version="1.0"?><string name="MediaDirectory" value="~/custom-media" />',
      'custom-media/snes/covers/Mario.png': pngBytes(600, 900, false)
    })
    const settings = testSettings()
    settings.library.esdeHome = join(home, 'ES-DE')
    const s = createEsdeMediaSource({ log: testLog })
    expect(await s.isAvailable(settings)).toBe(true)
    const found = await s.lookup(fakeGame('rom', 'z'), { romSystemId: 'snes', romName: 'Mario' }, [
      'cover'
    ])
    expect(found.cover?.[0]).toMatchObject({
      path: join(home, 'custom-media', 'snes', 'covers', 'Mario.png')
    })
  })

  it('matches ROM names that contain a dot (the extension was already stripped by art-ids)', async () => {
    await writeTree(home, {
      'downloaded_media/nes/covers/Super Mario Bros. (World).png': pngBytes(600, 900, false),
      'downloaded_media/nes/marquees/Dr. Mario (Japan, USA).png': pngBytes(640, 360, true)
    })
    const s = createEsdeMediaSource({ esdeHome: home, log: testLog })
    await s.index(testSettings())
    // What `artIdsOf` produces for `D:\ROMs\nes\Super Mario Bros. (World).nes`.
    const mario = await s.lookup(
      fakeGame('rom', 'nes/Super Mario Bros. (World).nes'),
      { romSystemId: 'nes', romName: 'Super Mario Bros. (World)' },
      ['cover']
    )
    expect(mario.cover?.[0]).toMatchObject({
      path: join(home, 'downloaded_media', 'nes', 'covers', 'Super Mario Bros. (World).png')
    })
    const dr = await s.lookup(
      fakeGame('rom', 'nes/Dr. Mario (Japan, USA).nes'),
      { romSystemId: 'nes', romName: 'Dr. Mario (Japan, USA)' },
      ['logo']
    )
    expect(dr.logo?.[0]).toMatchObject({
      path: join(home, 'downloaded_media', 'nes', 'marquees', 'Dr. Mario (Japan, USA).png')
    })
  })

  it('ignores games without a ROM identity', async () => {
    await fixture()
    const s = createEsdeMediaSource({ esdeHome: home, log: testLog })
    await s.index(testSettings())
    expect(await s.lookup(fakeGame('steam', '1'), { steamAppId: 1 }, ['cover'])).toEqual({})
  })
})
