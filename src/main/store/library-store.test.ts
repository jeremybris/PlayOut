import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { Game, Platform } from '../../shared/types'
import {
  dropStaleGameFolderSizes,
  LibraryStore,
  migratePs4EbootTitles,
  migrateXisoTitles,
  migrateXboxStorePlatform
} from './library-store'

const systemXbox: Platform = {
  id: 'xbox',
  name: 'Microsoft Xbox',
  kind: 'system',
  icon: 'xbox',
  sortOrder: 190
}
const oldStoreXbox: Platform = {
  id: 'xbox',
  name: 'Xbox',
  kind: 'store',
  icon: 'xbox',
  sortOrder: 70
}

function game(id: string, source: Game['source'], platformId: string): Game {
  return { id, source, platformId, title: id } as Game
}

describe('migrateXboxStorePlatform', () => {
  it("moves the Xbox app's games and row off the emulated Xbox's id", () => {
    const games = {
      a: game('xbox:a', 'xbox', 'xbox'),
      r: game('rom:xbox:1', 'rom', 'xbox')
    }
    const platforms: Record<string, Platform> = { xbox: oldStoreXbox }
    migrateXboxStorePlatform(games, platforms)
    expect(STORE_PLATFORMS.xbox.id).not.toBe('xbox')
    expect(games.a.platformId).toBe(STORE_PLATFORMS.xbox.id)
    expect(games.r.platformId).toBe('xbox')
    expect(platforms.xbox).toBeUndefined()
    expect(platforms[STORE_PLATFORMS.xbox.id]).toEqual(STORE_PLATFORMS.xbox)
  })

  it("keeps the emulated Xbox's row and adds no store row without store games", () => {
    const games = { r: game('rom:xbox:1', 'rom', 'xbox') }
    const platforms: Record<string, Platform> = { xbox: systemXbox }
    migrateXboxStorePlatform(games, platforms)
    expect(platforms).toEqual({ xbox: systemXbox })
    expect(games.r.platformId).toBe('xbox')
  })
})

describe('LibraryStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'playout-library-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('migrates a saved library as it loads', async () => {
    const file = join(dir, 'library.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        games: { 'xbox:a': game('xbox:a', 'xbox', 'xbox') },
        platforms: { xbox: oldStoreXbox },
        sources: {}
      })
    )
    const store = new LibraryStore(file)
    await store.load()
    expect(store.getGame('xbox:a')?.platformId).toBe(STORE_PLATFORMS.xbox.id)
    expect(store.platforms().map((p) => p.id)).toEqual([STORE_PLATFORMS.xbox.id])
  })
})

describe('migratePs4EbootTitles', () => {
  const eboot = join('C:/ROMs', 'ps4', 'DRIVECLUB - [EU] [EN] [1.28]', 'eboot.bin')
  const ps4 = (overrides: Partial<Game>): Game =>
    ({
      id: 'rom:ps4:1',
      source: 'rom',
      platformId: 'ps4',
      title: 'eboot',
      sortTitle: 'eboot',
      romPath: eboot,
      favorite: true,
      playtimeMinutes: 90,
      metadata: { description: 'Not this game' },
      media: { cover: 'wrong.jpg' },
      metadataStatus: 'done',
      user: {},
      ...overrides
    }) as Game

  it("titles an old 'eboot' record from its folder and fetches its metadata again", () => {
    const games = { a: ps4({}), b: ps4({ id: 'rom:ps4:2', metadataStatus: 'none', metadata: {} }) }
    migratePs4EbootTitles(games)
    expect(games.a).toMatchObject({
      title: 'DRIVECLUB',
      sortTitle: 'driveclub',
      favorite: true,
      playtimeMinutes: 90,
      metadata: {},
      media: {},
      metadataStatus: 'pending'
    })
    expect(games.b).toMatchObject({ title: 'DRIVECLUB', metadataStatus: 'none' })
  })

  it('leaves renamed, other and non-PS4 records alone', () => {
    const renamed = ps4({ title: 'My Driveclub' })
    const other = ps4({
      romPath: join('C:/ROMs', 'ps4', 'Game', 'sce_module', 'libc.bin'),
      title: 'libc'
    })
    const psx = ps4({ platformId: 'psx' })
    const games = { renamed, other, psx }
    const before = JSON.stringify(games)
    migratePs4EbootTitles(games)
    expect(JSON.stringify(games)).toBe(before)
  })
})

describe('migrateXisoTitles', () => {
  const xbox = (overrides: Partial<Game>): Game =>
    ({
      id: 'rom:xbox:1',
      source: 'rom',
      platformId: 'xbox',
      externalId: 'xbox/007 - From Russia with Love (USA).xiso.iso',
      romPath: join('C:/ROMs', 'xbox', '007 - From Russia with Love (USA).xiso.iso'),
      title: '007 - From Russia with Love.xiso',
      sortTitle: '007 from russia with love xiso',
      favorite: true,
      playtimeMinutes: 30,
      metadata: { description: 'Bond.' },
      media: { cover: 'media://rom:xbox:1/cover.jpg' },
      metadataStatus: 'done',
      user: {},
      ...overrides
    }) as Game

  it('drops .xiso from ROM titles, keeping found metadata and art', () => {
    const games = { a: xbox({}) }
    migrateXisoTitles(games)
    expect(games.a).toMatchObject({
      title: '007 - From Russia with Love',
      sortTitle: '007 from russia with love',
      favorite: true,
      playtimeMinutes: 30,
      metadata: { description: 'Bond.' },
      media: { cover: 'media://rom:xbox:1/cover.jpg' },
      metadataStatus: 'done'
    })
  })

  it('drops .xiso from an Xbox 360 game too (any ROM system)', () => {
    const games = {
      a: xbox({
        id: 'rom:xbox360:1',
        platformId: 'xbox360',
        externalId: 'xbox360/Halo 3 (USA).xiso.iso',
        romPath: join('C:/ROMs', 'xbox360', 'Halo 3 (USA).xiso.iso'),
        title: 'Halo 3.xiso',
        sortTitle: 'halo 3 xiso'
      })
    }
    migrateXisoTitles(games)
    expect(games.a).toMatchObject({ title: 'Halo 3', sortTitle: 'halo 3' })
  })

  it('looks a game up again when nothing was found under the .xiso title', () => {
    const games = {
      failed: xbox({ id: 'f', metadataStatus: 'failed', metadata: {}, media: {} }),
      empty: xbox({ id: 'e', title: 'Halo.XISO', metadata: {}, media: {} }),
      none: xbox({ id: 'n', metadataStatus: 'none', metadata: {}, media: {} })
    }
    migrateXisoTitles(games)
    expect(games.failed).toMatchObject({
      title: '007 - From Russia with Love',
      metadataStatus: 'pending'
    })
    expect(games.empty).toMatchObject({
      title: 'Halo',
      sortTitle: 'halo',
      metadataStatus: 'pending'
    })
    expect(games.none).toMatchObject({ metadataStatus: 'none' })
  })

  it("leaves clean titles, the user's title and other sources alone", () => {
    const games = {
      clean: xbox({ title: '007 - From Russia with Love', sortTitle: 'x' }),
      renamed: xbox({ user: { titleOverride: 'Bond.xiso' }, title: 'Bond' }),
      manual: { ...xbox({}), source: 'manual' } as Game
    }
    const before = JSON.stringify(games)
    migrateXisoTitles(games)
    expect(JSON.stringify(games)).toBe(before)
  })

  it('runs when the library loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playout-xiso-'))
    try {
      const file = join(dir, 'library.json')
      await writeFile(
        file,
        JSON.stringify({ version: 1, games: { a: xbox({}) }, platforms: {}, sources: {} })
      )
      const store = new LibraryStore(file)
      await store.load()
      expect(store.getGame('a')?.title).toBe('007 - From Russia with Love')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('dropStaleGameFolderSizes', () => {
  const folder = join('C:/ROMs', 'ps4', 'GRAVITY RUSH 2 - [EU]')
  const record = (installSize: Game['installSize'], overrides: Partial<Game> = {}): Game =>
    ({
      id: 'rom:ps4:gr2',
      source: 'rom',
      platformId: 'ps4',
      externalId: 'ps4/GRAVITY RUSH 2 - [EU]/eboot.bin',
      title: 'Gravity Rush 2',
      romPath: join(folder, 'eboot.bin'),
      installed: true,
      user: {},
      extra: { fileSize: 27_777_640, gameFolder: folder },
      installSize,
      ...overrides
    }) as Game
  const at = '2026-11-01T00:00:00.000Z'

  it("drops a PS4 game's size measured from its eboot.bin, keeping one of its folder", () => {
    const games = {
      stale: record({
        bytes: 27_777_640,
        how: 'file',
        path: join(folder, 'eboot.bin'),
        measuredAt: at
      }),
      whole: record({ bytes: 12e9, how: 'folder', path: folder, measuredAt: at }),
      psx: record(
        {
          bytes: 500,
          how: 'file',
          path: join('C:/ROMs', 'psx', 'Game', 'eboot.bin'),
          measuredAt: at
        },
        {
          platformId: 'psx',
          externalId: 'psx/Game/eboot.bin',
          romPath: join('C:/ROMs', 'psx', 'Game', 'eboot.bin'),
          extra: {}
        }
      )
    }
    dropStaleGameFolderSizes(games)
    expect(games.stale.installSize).toBeUndefined()
    expect(games.whole.installSize?.bytes).toBe(12e9)
    expect(games.psx.installSize?.bytes).toBe(500)
  })

  it('happens as a saved library loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playout-library-store-'))
    try {
      const file = join(dir, 'library.json')
      const stale = record({
        bytes: 27_777_640,
        how: 'file',
        path: join(folder, 'eboot.bin'),
        measuredAt: at
      })
      await writeFile(
        file,
        JSON.stringify({ version: 1, games: { [stale.id]: stale }, platforms: {}, sources: {} })
      )
      const store = new LibraryStore(file)
      await store.load()
      expect(store.getGame(stale.id)?.installSize).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
