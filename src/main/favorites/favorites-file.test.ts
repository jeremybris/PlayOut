import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import { isExcluded } from '../streaming/emulation-sync/rules'
import {
  buildOwnEntries,
  createFavoritesBackup,
  FAVORITES_DIR,
  favoritesDir,
  isFavoritesFilePath,
  mergeEntries,
  parseFavoritesFile,
  pcFileName,
  planRestore,
  TOMBSTONE_KEEP_MS,
  withoutFutureEntries,
  type FavoriteFileEntry
} from './favorites-file'

const T = Date.UTC(2026, 5, 1)
const iso = (ms: number): string => new Date(ms).toISOString()

function game(id: string, extra: Partial<Game> = {}): Game {
  const [source, ...rest] = id.split(':')
  return {
    id,
    source: source as Game['source'],
    externalId: rest.join(':'),
    platformId: 'pc',
    title: id,
    favorite: false,
    user: {},
    ...extra
  } as unknown as Game
}

function entry(
  id: string,
  favorite: boolean,
  at: number,
  extra: Partial<FavoriteFileEntry> = {}
): FavoriteFileEntry {
  const [source, ...rest] = id.split(':')
  return {
    id,
    favorite,
    at,
    source: source!,
    platformId: 'pc',
    title: id,
    externalId: rest.join(':'),
    ...extra
  }
}

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

describe('favourites file: merge', () => {
  it('keeps the newest change per game, a removal included', () => {
    const merged = mergeEntries([
      [entry('steam:1', true, T), entry('steam:2', true, T)],
      [entry('steam:1', false, T + 1000), entry('steam:2', true, T - 5000)]
    ])
    expect(merged.get('steam:1')).toMatchObject({ favorite: false, at: T + 1000 })
    expect(merged.get('steam:2')).toMatchObject({ favorite: true, at: T })
  })

  it('between equal times, the favourite wins', () => {
    const merged = mergeEntries([[entry('steam:1', false, 0)], [entry('steam:1', true, 0)]])
    expect(merged.get('steam:1')?.favorite).toBe(true)
  })

  it('keeps removals (tombstones) for a year, then drops them', () => {
    const now = T + TOMBSTONE_KEEP_MS + 10
    const list = buildOwnEntries(
      [],
      [
        entry('steam:old', false, T),
        entry('steam:recent', false, now - 1000),
        entry('steam:fav', true, T)
      ],
      now
    )
    expect(list.map((e) => e.id)).toEqual(['steam:fav', 'steam:recent'])
  })

  it("keeps entries of games the library does not have now; the library's state wins for the others", () => {
    const list = buildOwnEntries(
      [game('steam:1', { favorite: false, favoriteAt: iso(T + 5) })],
      [entry('steam:1', true, T), entry('rom:snes:abc', true, T)],
      T + 10
    )
    expect(list).toEqual([
      expect.objectContaining({ id: 'rom:snes:abc', favorite: true }),
      expect.objectContaining({ id: 'steam:1', favorite: false, at: T + 5 })
    ])
  })
})

describe('favourites file: restore', () => {
  it('restores by game id when the change is newer than the library', () => {
    const games = [game('steam:1'), game('steam:2', { favorite: true, favoriteAt: iso(T + 50) })]
    const changes = planRestore(
      games,
      mergeEntries([[entry('steam:1', true, T), entry('steam:2', false, T)]])
    )
    expect(changes).toEqual([{ id: 'steam:1', favorite: true, at: T }])
  })

  it('restores a favourite from before the times were kept (at 0) onto a game never changed', () => {
    const changes = planRestore([game('steam:1')], mergeEntries([[entry('steam:1', true, 0)]]))
    expect(changes).toEqual([{ id: 'steam:1', favorite: true, at: 0 }])
  })

  it('matches by store, platform and title when the id changed (a manual game whose exe moved)', () => {
    const games = [game('manual:d:/new/game.exe', { title: 'Hollow Knight' })]
    const changes = planRestore(
      games,
      mergeEntries([[entry('manual:c:/old/game.exe', true, T, { title: 'Hollow Knight' })]])
    )
    expect(changes).toEqual([{ id: 'manual:d:/new/game.exe', favorite: true, at: T }])
  })

  it('matches a ROM by its file name when its folder changed', () => {
    const games = [
      game('rom:snes:new', { platformId: 'snes', externalId: 'snes\\RPG\\Chrono.sfc' })
    ]
    const changes = planRestore(
      games,
      mergeEntries([
        [entry('rom:snes:old', true, T, { platformId: 'snes', externalId: 'snes\\Chrono.sfc' })]
      ])
    )
    expect(changes.map((c) => c.id)).toEqual(['rom:snes:new'])
  })

  it('never guesses between two games with the same title', () => {
    const games = [game('manual:a', { title: 'Doom' }), game('manual:b', { title: 'Doom' })]
    expect(
      planRestore(games, mergeEntries([[entry('manual:c', true, T, { title: 'Doom' })]]))
    ).toEqual([])
  })
})

describe('favourites file on disk', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-fav-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function makeLibrary(games: Game[]): {
    games(): Game[]
    setSyncedFavorite(id: string, favorite: boolean, atMs: number): boolean
    add(g: Game): void
  } {
    const byId = new Map(games.map((g) => [g.id, g]))
    return {
      games: () => [...byId.values()],
      setSyncedFavorite(id: string, favorite: boolean, atMs: number) {
        const g = byId.get(id)
        if (!g) return false
        g.favorite = favorite
        if (atMs > 0) g.favoriteAt = iso(atMs)
        else delete g.favoriteAt
        return true
      },
      add(g: Game) {
        byId.set(g.id, g)
      }
    }
  }

  it('is written in the Emulation folder, survives a "reinstall" (empty library), and comes back on a scan', async () => {
    const before = makeLibrary([
      game('steam:1', { favorite: true, favoriteAt: iso(T) }),
      game('rom:snes:abc', { favorite: true, platformId: 'snes', externalId: 'snes\\a.sfc' }),
      game('steam:2', { favorite: false, favoriteAt: iso(T + 1) })
    ])
    const a = createFavoritesBackup({
      library: before,
      emulationDir: () => dir,
      pc: 'GAMING-PC',
      readOthers: () => true,
      log: silent,
      now: () => T + 100
    })
    await a.start()
    const file = join(dir, FAVORITES_DIR, 'GAMING-PC.json')
    const written = parseFavoritesFile(await fs.readFile(file, 'utf8'))
    expect(written.map((e) => [e.id, e.favorite])).toEqual([
      ['rom:snes:abc', true],
      ['steam:1', true],
      ['steam:2', false]
    ])
    // One fixed temporary name, renamed away: nothing left beside the file.
    expect(await fs.readdir(join(dir, FAVORITES_DIR))).toEqual(['GAMING-PC.json'])

    // Reinstalled: library.json is gone. Starting with no games must not empty the file.
    const after = makeLibrary([])
    const b = createFavoritesBackup({
      library: after,
      emulationDir: () => dir,
      pc: 'GAMING-PC',
      readOthers: () => true,
      log: silent,
      now: () => T + 200
    })
    await b.start()
    expect(parseFavoritesFile(await fs.readFile(file, 'utf8'))).toHaveLength(3)
    // The scan brings the games back: their favourites are restored.
    after.add(game('steam:1'))
    after.add(game('steam:2'))
    after.add(game('rom:snes:abc', { platformId: 'snes', externalId: 'snes\\a.sfc' }))
    expect(await b.restoreNow()).toBe(2)
    const back = after.games()
    expect(back.find((g) => g.id === 'steam:1')?.favorite).toBe(true)
    expect(back.find((g) => g.id === 'rom:snes:abc')?.favorite).toBe(true)
    expect(back.find((g) => g.id === 'steam:2')?.favorite).toBe(false)
  })

  it("takes another PC's file only while Sync favourites is on, and never writes it", async () => {
    await fs.mkdir(favoritesDir(dir), { recursive: true })
    const other = join(favoritesDir(dir), pcFileName('HOST'))
    const text = JSON.stringify({ version: 1, pc: 'HOST', entries: [entry('steam:9', true, T)] })
    await fs.writeFile(other, text)
    const lib = makeLibrary([game('steam:9')])
    let on = false
    const backup = createFavoritesBackup({
      library: lib,
      emulationDir: () => dir,
      pc: 'CLIENT',
      readOthers: () => on,
      log: silent
    })
    expect(await backup.restoreNow()).toBe(0)
    on = true
    expect(await backup.restoreNow()).toBe(1)
    expect(lib.games()[0]?.favorite).toBe(true)
    expect(await fs.readFile(other, 'utf8')).toBe(text)
  })

  it("a removal on one PC is not undone by the other PC's older favourite", async () => {
    await fs.mkdir(favoritesDir(dir), { recursive: true })
    await fs.writeFile(
      join(favoritesDir(dir), 'HOST.json'),
      JSON.stringify({ version: 1, pc: 'HOST', entries: [entry('steam:9', true, T)] })
    )
    const lib = makeLibrary([game('steam:9', { favorite: false, favoriteAt: iso(T + 60_000) })])
    const backup = createFavoritesBackup({
      library: lib,
      emulationDir: () => dir,
      pc: 'CLIENT',
      readOthers: () => true,
      log: silent,
      now: () => T + 70_000
    })
    await backup.start()
    expect(lib.games()[0]?.favorite).toBe(false)
    const mine = parseFavoritesFile(
      await fs.readFile(join(favoritesDir(dir), 'CLIENT.json'), 'utf8')
    )
    expect(mine).toEqual([
      expect.objectContaining({ id: 'steam:9', favorite: false, at: T + 60_000 })
    ])
  })

  it('is carried by the Emulation folder sync; its temporary file is not', () => {
    const scope = { extraExcluded: [] }
    expect(isExcluded('PlayOut/Favorites/GAMING-PC.json', scope)).toBe(false)
    expect(isExcluded('PlayOut/Favorites/GAMING-PC.json.playout-new', scope)).toBe(true)
  })

  it('names files after the PC, safely', () => {
    expect(pcFileName('GAMING-PC')).toBe('GAMING-PC.json')
    expect(pcFileName('..\\evil/name')).toBe('_evil_name.json')
    expect(pcFileName('')).toBe('PC.json')
  })
})

describe('favourites file: review fixes', () => {
  it('never moves a store game favourite onto another game of the same name (ids are stable)', () => {
    // DOOM (2016) was a favourite and is gone; Doom (1993) is installed now.
    const games = [game('steam:2280', { title: 'Doom' })]
    const changes = planRestore(
      games,
      mergeEntries([[entry('steam:379720', true, T, { title: 'DOOM' })]])
    )
    expect(changes).toEqual([])
  })

  it('takes the newest of two entries that fall back to one game, whatever their order', () => {
    const games = [game('manual:c:/now/game.exe', { title: 'Celeste' })]
    const olderFavourite = entry('manual:a', true, T, { title: 'Celeste' })
    const newerRemoval = entry('manual:b', false, T + 60_000, { title: 'Celeste' })
    for (const order of [
      [newerRemoval, olderFavourite],
      [olderFavourite, newerRemoval]
    ])
      expect(planRestore(games, mergeEntries([order]))).toEqual([])
    // The library had it as a favourite: the newer removal is applied.
    const fav = [game('manual:c:/now/game.exe', { title: 'Celeste', favorite: true })]
    expect(planRestore(fav, mergeEntries([[newerRemoval, olderFavourite]]))).toEqual([
      { id: 'manual:c:/now/game.exe', favorite: false, at: T + 60_000 }
    ])
  })

  it('ignores entries dated more than a day ahead (a PC whose clock ran ahead)', () => {
    const list = [entry('steam:1', true, T + 2 * 86_400_000), entry('steam:2', true, T + 1000)]
    expect(withoutFutureEntries(list, T).map((e) => e.id)).toEqual(['steam:2'])
  })

  it('knows the favourites files among the synced paths', () => {
    expect(isFavoritesFilePath('PlayOut/Favorites/GAMING-PC.json')).toBe(true)
    expect(isFavoritesFilePath(String.raw`playout\favorites\Other.json`)).toBe(true)
    expect(isFavoritesFilePath('PlayOut/Favorites/x.json.playout-new')).toBe(false)
    expect(isFavoritesFilePath('PlayOut/Favorites/sub/x.json')).toBe(false)
    expect(isFavoritesFilePath('saves/x.json')).toBe(false)
  })

  it('writes nothing while the Emulation folder is moving, and catches up after', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'playout-fav-pause-'))
    try {
      let moving = true
      const games = [game('steam:1', { favorite: true, favoriteAt: iso(T) })]
      const backup = createFavoritesBackup({
        library: { games: () => games, setSyncedFavorite: () => true },
        emulationDir: () => dir,
        pc: 'PC',
        readOthers: () => false,
        log: silent,
        now: () => T,
        debounceMs: 5,
        paused: () => moving
      })
      await backup.start()
      const file = join(favoritesDir(dir), 'PC.json')
      await expect(fs.stat(file)).rejects.toThrow()
      moving = false
      await new Promise((r) => setTimeout(r, 50))
      await backup.flush()
      expect(parseFavoritesFile(await fs.readFile(file, 'utf8')).map((e) => e.id)).toEqual([
        'steam:1'
      ])
      backup.dispose()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
