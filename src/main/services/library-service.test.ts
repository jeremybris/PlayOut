import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { Game, ScannedGame } from '../../shared/types'
import { EventBus } from '../events'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { LibraryService, missingArtUrls } from './library-service'

let dir: string
let service: LibraryService
let events: EventBus
let emitted: string[]
let libStore: LibraryStore

function scanned(overrides: Partial<ScannedGame> = {}): ScannedGame {
  return {
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    installDir: 'C:\\Steam\\steamapps\\common\\Portal 2',
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'installDir', installDir: 'C:\\Steam\\steamapps\\common\\Portal 2' },
    ...overrides
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-lib-'))
  emitted = []
  events = new EventBus((_c, m) => emitted.push(m.event))
  const lib = new LibraryStore(join(dir, 'library.json'))
  libStore = lib
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  await lib.load()
  await sessions.load()
  service = new LibraryService(lib, sessions, events)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('LibraryService.mergeScan', () => {
  it('adds new games with stable ids and marks missing ones uninstalled', () => {
    const first = service.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'Team Fortress 2' })
    ])
    expect(first).toMatchObject({ added: 2, updated: 0, removed: 0 })
    expect(service.getGame('steam:620')?.title).toBe('Portal 2')
    expect(service.getGame('steam:620')?.sortTitle).toBe('portal 2')

    const second = service.mergeScan('steam', [scanned({ title: 'Portal 2 (renamed)' })])
    expect(second).toMatchObject({ added: 0, updated: 1, removed: 1 })
    expect(service.getGame('steam:440')?.installed).toBe(false)
    expect(service.getGame('steam:620')?.title).toBe('Portal 2 (renamed)')
    expect(emitted.filter((e) => e === 'library:changed')).toHaveLength(2)
    // A scan that finds exactly what the library has (the tracker's confirming scan): nothing counted, no event.
    const third = service.mergeScan('steam', [scanned({ title: 'Portal 2 (renamed)' })])
    expect(third).toMatchObject({ added: 0, updated: 0, removed: 0 })
    expect(emitted.filter((e) => e === 'library:changed')).toHaveLength(2)
  })

  it('preserves user data, play time and metadata across rescans', () => {
    service.mergeScan('steam', [scanned()])
    service.updateGame('steam:620', { favorite: true, user: { titleOverride: 'My Portal' } })
    service.applyMetadata('steam:620', {
      metadata: { description: 'd', genres: ['Puzzle'] },
      media: { cover: 'media://cache/x/cover.jpg' },
      status: 'done'
    })
    const session = service.beginSession('steam:620')
    service.endSession(session)
    service.mergeScan('steam', [scanned({ storePlaytimeMinutes: 600 })])
    const g = service.getGame('steam:620')!
    expect(g.favorite).toBe(true)
    expect(g.user.titleOverride).toBe('My Portal')
    expect(g.metadata.description).toBe('d')
    expect(g.media.cover).toBe('media://cache/x/cover.jpg')
    expect(g.metadataStatus).toBe('done')
    expect(g.playCount).toBe(1)
    expect(g.storePlaytimeMinutes).toBe(600)
    expect(g.lastPlayed).toBeTruthy()
  })

  it('sets and clears the completed mark and the preferred copy', () => {
    service.mergeScan('steam', [scanned()])
    service.updateGame('steam:620', { completed: true, user: { preferredCopy: true } })
    let g = service.getGame('steam:620')!
    expect(g.completed).toBe(true)
    expect(g.user.preferredCopy).toBe(true)
    // `false` removes the flags rather than storing them; `null` clears the user field too.
    service.updateGame('steam:620', { completed: false, user: { preferredCopy: false } })
    g = service.getGame('steam:620')!
    expect('completed' in g).toBe(false)
    expect('preferredCopy' in g.user).toBe(false)
    service.updateGame('steam:620', { user: { preferredCopy: true } })
    service.updateGame('steam:620', { user: { preferredCopy: null } })
    expect('preferredCopy' in service.getGame('steam:620')!.user).toBe(false)
  })

  it('hashes ROM ids from the relative path and does not touch other sources', () => {
    service.mergeScan('steam', [scanned()])
    const rom = scanned({
      source: 'rom',
      externalId: 'snes/Super Mario World (USA).sfc',
      platformId: 'snes',
      title: 'Super Mario World',
      launch: {
        kind: 'emulator',
        systemId: 'snes',
        romPath: 'D:\\ROMs\\snes\\Super Mario World (USA).sfc'
      },
      tracking: { mode: 'spawned' }
    })
    const r = service.mergeScan('rom', [rom])
    expect(r.added).toBe(1)
    const id = r.newGameIds[0]
    expect(id).toMatch(/^rom:snes:[A-Za-z0-9_-]{16}$/)
    expect(service.getGame('steam:620')?.installed).toBe(true)
    expect(service.mergeScan('rom', [rom]).newGameIds).toEqual([])
  })

  it('removes a deleted ROM nothing is kept for, and greys out one with history or user state', () => {
    const rom = (name: string): ScannedGame =>
      scanned({
        source: 'rom',
        externalId: `snes/${name}.sfc`,
        platformId: 'snes',
        title: name,
        launch: { kind: 'emulator', systemId: 'snes', romPath: `D:\\ROMs\\snes\\${name}.sfc` },
        tracking: { mode: 'spawned' }
      })
    const first = service.mergeScan('rom', [rom('Fresh'), rom('Played'), rom('Faved'), rom('Kept')])
    const [fresh, played, faved, kept] = first.newGameIds
    service.endSession(service.beginSession(played))
    service.updateGame(faved, { favorite: true })
    service.applyMetadata(kept, { metadata: { description: 'd' }, status: 'done' })

    const second = service.mergeScan('rom', [rom('Kept'), rom('New')])
    expect(second).toMatchObject({ added: 1, removed: 3 })
    expect(service.getGame(fresh)).toBeUndefined()
    expect(service.getGame(played)?.installed).toBe(false)
    expect(service.getGame(faved)?.installed).toBe(false)
    // The ROM still on disk keeps its scraped metadata and is not queued again.
    expect(service.getGame(kept)).toMatchObject({ installed: true, metadataStatus: 'done' })
    expect(second.newGameIds).toHaveLength(1)
  })

  it('keeps a never-played ROM card, not installed, when its file is gone but a recompilation of it is installed', () => {
    const rom = scanned({
      source: 'rom',
      externalId: 'ps4/Gravity Rush 2/eboot.bin',
      platformId: 'ps4',
      title: 'Gravity Rush 2',
      launch: {
        kind: 'emulator',
        systemId: 'ps4',
        romPath: 'D:\\ROMs\\ps4\\Gravity Rush 2\\eboot.bin'
      },
      tracking: { mode: 'spawned' }
    })
    const [id] = service.mergeScan('rom', [rom]).newGameIds
    service.applyMetadata(id!, {
      metadata: {
        recomp: {
          titleKey: 'ps4:gravityrush2',
          count: 1,
          installed: ['github:a/gr2port'],
          preferred: 'github:a/gr2port',
          updatedAt: ''
        }
      }
    })
    // Its files were moved into the recompilation's folder: the card stays (Play starts the recompilation).
    service.mergeScan('rom', [])
    expect(service.getGame(id!)).toMatchObject({ installed: false })
  })

  it('keeps a card whose disc image went to the Recycle Bin for its recompilation, until its file is back', () => {
    const iso = (name: string): ScannedGame =>
      scanned({
        source: 'rom',
        externalId: `ps2/${name}.iso`,
        platformId: 'ps2',
        title: name,
        romPath: `D:\\ROMs\\ps2\\${name}.iso`,
        launch: { kind: 'emulator', systemId: 'ps2', romPath: `D:\\ROMs\\ps2\\${name}.iso` },
        tracking: { mode: 'spawned' }
      })
    const [id] = service.mergeScan('rom', [iso('Okami')]).newGameIds
    service.updateGame(id!, { favorite: true })
    expect(service.markRomRemoved('steam:nothing', 'github:a/b')).toBeUndefined()
    const kept = service.markRomRemoved(id!, 'github:okami/recomp', '2026-11-18T00:00:00.000Z')
    expect(kept).toMatchObject({
      installed: true,
      favorite: true,
      romRemoved: {
        at: '2026-11-18T00:00:00.000Z',
        recompId: 'github:okami/recomp',
        romPath: 'D:\\ROMs\\ps2\\Okami.iso'
      }
    })
    expect(kept?.romPath).toBeUndefined()
    // Its launch names no file either (the PCSX2 list and the ROM launcher read it).
    expect(kept?.launch).toEqual({ kind: 'emulator', systemId: 'ps2', romPath: '' })
    // Rescans without the file neither remove nor grey it out.
    expect(service.mergeScan('rom', []).removed).toBe(0)
    expect(service.getGame(id!)).toMatchObject({ installed: true, romRemoved: expect.anything() })
    // The file restored from the Recycle Bin: an ordinary ROM card again.
    service.mergeScan('rom', [iso('Okami')])
    expect(service.getGame(id!)?.romRemoved).toBeUndefined()
    expect(service.getGame(id!)?.launch).toMatchObject({ romPath: 'D:\\ROMs\\ps2\\Okami.iso' })
    expect(service.getGame(id!)?.romPath).toBe('D:\\ROMs\\ps2\\Okami.iso')
    // A kept card the user removes stays removed (nothing brings it back without its file).
    service.markRomRemoved(id!, 'github:okami/recomp')
    service.removeGame(id!)
    service.mergeScan('rom', [])
    expect(service.getGame(id!)).toBeUndefined()
  })

  it("restoreRomRemoved puts a kept card back exactly as it was (the recompilation's test run failed)", () => {
    const iso = (title: string): ScannedGame =>
      scanned({
        source: 'rom',
        externalId: `ps2/${title}.iso`,
        title,
        platformId: 'ps2',
        romPath: `D:\\ROMs\\ps2\\${title}.iso`,
        launch: { kind: 'emulator', systemId: 'ps2', romPath: `D:\\ROMs\\ps2\\${title}.iso` }
      })
    const [id] = service.mergeScan('rom', [iso('Okami')]).newGameIds
    const before = service.getGame(id!)!
    expect(service.restoreRomRemoved(id!)).toBeUndefined()
    service.markRomRemoved(id!, 'github:okami/recomp')
    const changed = vi.fn()
    events.on('library:changed', changed)
    const back = service.restoreRomRemoved(id!)
    expect(back?.romRemoved).toBeUndefined()
    expect(back?.romPath).toBe(before.romPath)
    expect(back?.launch).toEqual(before.launch)
    expect(back?.installSize).toEqual(before.installSize)
    expect(changed).toHaveBeenCalledWith({ reason: 'update', gameIds: [id] })
  })

  it('does not overwrite existing metadata unless asked', () => {
    service.mergeScan('steam', [scanned()])
    service.applyMetadata('steam:620', { metadata: { description: 'first' } })
    service.applyMetadata('steam:620', {
      metadata: { description: 'second', developers: ['Valve'] }
    })
    expect(service.getGame('steam:620')?.metadata).toMatchObject({
      description: 'first',
      developers: ['Valve']
    })
    service.applyMetadata('steam:620', { metadata: { description: 'third' } }, { overwrite: true })
    expect(service.getGame('steam:620')?.metadata.description).toBe('third')
  })

  it("takes the store's date added for a new owned game and for one already in the library", () => {
    // Installed and found by a scan first: dated the day PlayOut saw it.
    service.mergeScan('steam', [scanned()])
    const seen = service.getGame('steam:620')!.addedAt
    service.mergeOwned('steam', [
      { externalId: '620', title: 'Portal 2', acquiredAt: '2011-04-27T00:00:00.000Z' },
      { externalId: '9', title: 'Bought last week', acquiredAt: '2026-11-15T12:00:00.000Z' },
      { externalId: '10', title: 'No date from the store' }
    ])
    expect(service.getGame('steam:620')?.addedAt).toBe('2011-04-27T00:00:00.000Z')
    expect(service.getGame('steam:620')?.addedAt).not.toBe(seen)
    expect(service.getGame('steam:9')?.addedAt).toBe('2026-11-15T12:00:00.000Z')
    const undated = service.getGame('steam:10')!.addedAt
    expect(Date.parse(undated)).toBeGreaterThan(Date.parse('2026-11-15T12:00:00.000Z'))
    // A later import without the date (Steam did not answer) keeps what is known; the same date changes nothing.
    const again = service.mergeOwned('steam', [
      { externalId: '620', title: 'Portal 2' },
      { externalId: '9', title: 'Bought last week', acquiredAt: '2026-11-15T12:00:00.000Z' },
      { externalId: '10', title: 'No date from the store' }
    ])
    expect(again.updated).toBe(0)
    expect(service.getGame('steam:620')?.addedAt).toBe('2011-04-27T00:00:00.000Z')
    expect(service.getGame('steam:10')?.addedAt).toBe(undated)
  })

  it('never sets or clears owned', () => {
    service.mergeOwned('steam', [{ externalId: '620', title: 'Portal 2' }])
    service.mergeScan('steam', [scanned()])
    expect(service.getGame('steam:620')).toMatchObject({ installed: true, owned: true })
    service.mergeScan('steam', [])
    expect(service.getGame('steam:620')).toMatchObject({ installed: false, owned: true })
  })

  it('reports provider art only for kinds the game still lacks', () => {
    const cover = 'C:\\Steam\\appcache\\librarycache\\620\\library_600x900.jpg'
    const hero = 'C:\\Steam\\appcache\\librarycache\\620\\library_hero.jpg'
    const first = service.mergeScan('steam', [scanned({ localMedia: { cover, hero } })])
    expect(first.localMedia).toEqual([
      { gameId: 'steam:620', kind: 'cover', path: cover },
      { gameId: 'steam:620', kind: 'hero', path: hero }
    ])
    service.setMedia('steam:620', 'cover', 'media://cache/steam_620/cover.jpg?v=1')
    service.updateGame('steam:620', { user: { customMedia: { hero: 'C:\\art\\hero.png' } } })
    // The tracker's confirming scan reports the same files: neither is a seed any more.
    const again = service.mergeScan('steam', [scanned({ localMedia: { cover, hero } })])
    expect(again.localMedia).toEqual([])
  })

  it('clears one custom kind so automated art can land there again', () => {
    service.mergeScan('steam', [scanned()])
    service.updateGame('steam:620', {
      user: { customMedia: { cover: 'C:\\art\\cover.png', hero: 'C:\\art\\hero.png' } }
    })
    service.clearCustomMedia('steam:620', 'cover')
    expect(service.getGame('steam:620')?.user.customMedia).toEqual({ hero: 'C:\\art\\hero.png' })
    service.applyMetadata('steam:620', { media: { cover: 'media://cache/steam_620/cover.jpg' } })
    expect(service.getGame('steam:620')?.media.cover).toBe('media://cache/steam_620/cover.jpg')
    service.clearCustomMedia('steam:620', 'hero')
    expect(service.getGame('steam:620')?.user.customMedia).toBeUndefined()
    expect(() => service.clearCustomMedia('steam:missing', 'cover')).toThrow(/Unknown game/)
  })

  describe('syncStoreHidden', () => {
    const hiddenOf = (id: string): boolean | undefined => service.getGame(id)?.hidden
    beforeEach(() => {
      service.mergeScan('steam', [scanned()])
    })

    it('follows the store when it hides and shows a game', () => {
      expect(service.syncStoreHidden('steam', new Set(['620']))).toBe(1)
      expect(hiddenOf('steam:620')).toBe(true)
      expect(service.getGame('steam:620')?.hiddenByStore).toBe(true)
      expect(service.syncStoreHidden('steam', new Set())).toBe(1)
      expect(hiddenOf('steam:620')).toBe(false)
      expect(service.getGame('steam:620')?.hiddenByStore).toBeUndefined()
    })

    it('keeps a game the user showed again until the store changes its mind', () => {
      service.syncStoreHidden('steam', new Set(['620']))
      service.updateGame('steam:620', { hidden: false })
      expect(service.syncStoreHidden('steam', new Set(['620']))).toBe(0)
      expect(hiddenOf('steam:620')).toBe(false)
    })

    it('does not count a store-hidden game as user state when the owned list drops it', () => {
      service.mergeOwned('steam', [{ externalId: '9', title: 'Owned only' }])
      service.syncStoreHidden('steam', new Set(['9']))
      expect(service.mergeOwned('steam', []).removed).toBe(1)
      expect(service.getGame('steam:9')).toBeUndefined()
    })

    it('keeps a store-hidden game the user showed again when the owned list drops it', () => {
      service.mergeOwned('steam', [{ externalId: '9', title: 'Owned only' }])
      service.syncStoreHidden('steam', new Set(['9']))
      service.updateGame('steam:9', { hidden: false })
      expect(service.mergeOwned('steam', []).removed).toBe(0)
    })

    it('leaves a game the user hid here alone', () => {
      service.updateGame('steam:620', { hidden: true })
      expect(service.syncStoreHidden('steam', new Set())).toBe(0)
      expect(hiddenOf('steam:620')).toBe(true)
    })

    it('does not touch other sources, survives a rescan and only announces real changes', () => {
      const emit = vi.spyOn(events, 'emit')
      expect(service.syncStoreHidden('epic', new Set(['620']))).toBe(0)
      expect(hiddenOf('steam:620')).toBe(false)
      expect(emit).not.toHaveBeenCalled()
      service.syncStoreHidden('steam', new Set(['620']))
      expect(emit).toHaveBeenCalledWith('library:changed', { reason: 'update' })
      service.mergeScan('steam', [scanned()])
      expect(hiddenOf('steam:620')).toBe(true)
    })
  })

  it('keeps custom media over scraped media', () => {
    service.mergeScan('steam', [scanned()])
    service.updateGame('steam:620', { user: { customMedia: { cover: 'C:\\art\\cover.png' } } })
    service.setMedia('steam:620', 'cover', 'media://cache/steam_620/cover.png')
    service.applyMetadata(
      'steam:620',
      {
        media: {
          cover: 'media://cache/steam_620/cover.jpg',
          hero: 'media://cache/steam_620/hero.jpg'
        }
      },
      { overwrite: true }
    )
    expect(service.getGame('steam:620')?.media).toEqual({
      cover: 'media://cache/steam_620/cover.png',
      hero: 'media://cache/steam_620/hero.jpg'
    })
  })
})

describe('LibraryService.setMediaBatch', () => {
  it('writes landed art with its attribution, skips custom kinds and records misses', () => {
    service.mergeScan('steam', [scanned(), scanned({ externalId: '440', title: 'TF2' })])
    service.updateGame('steam:440', { user: { customMedia: { cover: 'C:\\art\\own.png' } } })
    service.setMedia('steam:440', 'cover', 'media://cache/steam_440/custom-cover.png?v=1')
    const before = emitted.filter((e) => e === 'library:changed').length
    service.setMediaBatch([
      { gameId: 'steam:620', kind: 'cover', missing: 'https://cdn/620/library_600x900_2x.jpg' },
      { gameId: 'steam:620', kind: 'cover', missing: 'https://cdn/620/library_600x900.jpg' },
      { gameId: 'steam:620', kind: 'cover', missing: 'https://cdn/620/library_600x900.jpg' },
      {
        gameId: 'steam:620',
        kind: 'hero',
        url: 'media://cache/steam_620/hero.jpg?v=1',
        source: 'steam-cdn'
      },
      // A download that was in flight when the user chose a file: ignored.
      {
        gameId: 'steam:440',
        kind: 'cover',
        url: 'media://cache/steam_440/cover.jpg?v=1',
        source: 'steam-cdn'
      },
      { gameId: 'steam:999', kind: 'cover', url: 'media://cache/x' }
    ])
    expect(emitted.filter((e) => e === 'library:changed').length).toBe(before + 1)
    const portal = service.getGame('steam:620')!
    expect(portal.media).toEqual({ hero: 'media://cache/steam_620/hero.jpg?v=1' })
    expect(portal.metadata.sources).toEqual({
      'art:cover:missing':
        'https://cdn/620/library_600x900_2x.jpg https://cdn/620/library_600x900.jpg',
      'art:hero': 'steam-cdn'
    })
    expect(missingArtUrls(portal, 'cover')).toEqual([
      'https://cdn/620/library_600x900_2x.jpg',
      'https://cdn/620/library_600x900.jpg'
    ])
    expect(service.getGame('steam:440')?.media.cover).toBe(
      'media://cache/steam_440/custom-cover.png?v=1'
    )
    expect(service.getGame('steam:440')?.metadata.sources).toBeUndefined()
    // A landed cover clears the memo of the misses before it.
    service.setMediaBatch([
      {
        gameId: 'steam:620',
        kind: 'cover',
        url: 'media://cache/steam_620/cover.png?v=2',
        source: 'steamgriddb'
      }
    ])
    expect(service.getGame('steam:620')?.metadata.sources).toEqual({
      'art:cover': 'steamgriddb',
      'art:hero': 'steam-cdn'
    })
  })

  it('applyMetadata can write quietly for callers that coalesce their own events', () => {
    service.mergeScan('steam', [scanned()])
    const before = emitted.filter((e) => e === 'library:changed').length
    service.applyMetadata('steam:620', { metadata: { description: 'd' } }, { quiet: true })
    expect(emitted.filter((e) => e === 'library:changed').length).toBe(before)
    expect(service.getGame('steam:620')?.metadata.description).toBe('d')
  })
})

describe('LibraryService.mergeOwned', () => {
  it('does not report a store URL that answered 404 in an earlier run', () => {
    service.mergeOwned('steam', [
      { externalId: '620', title: 'Portal 2', coverUrl: 'https://cdn/620/cover.jpg' }
    ])
    service.setMediaBatch([
      { gameId: 'steam:620', kind: 'cover', missing: 'https://cdn/620/cover.jpg' }
    ])
    const again = service.mergeOwned('steam', [
      {
        externalId: '620',
        title: 'Portal 2',
        coverUrl: 'https://cdn/620/cover.jpg',
        heroUrl: 'https://cdn/620/hero.jpg'
      }
    ])
    expect(again.remoteMedia).toEqual([
      { gameId: 'steam:620', kind: 'hero', url: 'https://cdn/620/hero.jpg' }
    ])
  })

  it('creates greyed records with the install URI and reports remote art', () => {
    const result = service.mergeOwned('steam', [
      {
        externalId: '620',
        title: 'Portal 2',
        coverUrl: 'https://cdn/620/cover.jpg',
        heroUrl: 'https://cdn/620/hero.jpg',
        storePlaytimeMinutes: 90,
        releaseDate: '2011-04-18',
        developer: 'Valve',
        extra: { steamAppId: 620 }
      },
      { externalId: '620', title: 'duplicate' },
      { externalId: ' ', title: 'blank id' }
    ])
    expect(result).toMatchObject({ added: 1, updated: 0, removed: 0, newGameIds: ['steam:620'] })
    expect(result.remoteMedia).toEqual([
      { gameId: 'steam:620', kind: 'cover', url: 'https://cdn/620/cover.jpg' },
      { gameId: 'steam:620', kind: 'hero', url: 'https://cdn/620/hero.jpg' }
    ])
    const game = service.getGame('steam:620')!
    expect(game).toMatchObject({
      installed: false,
      owned: true,
      platformId: 'steam',
      launch: { kind: 'uri', uri: 'steam://install/620' },
      tracking: { mode: 'none' },
      storePlaytimeMinutes: 90,
      metadata: { releaseDate: '2011-04-18', developers: ['Valve'] },
      extra: { steamAppId: 620 }
    })
    expect(game.installDir).toBeUndefined()
    expect(emitted.filter((e) => e === 'library:changed')).toHaveLength(1)
    // Nothing changed: not counted, no event (the confirming scans would otherwise refetch every 10 s).
    const same = service.mergeOwned('steam', [
      { externalId: '620', title: 'Portal 2', extra: { steamAppId: 620 } }
    ])
    expect(same).toMatchObject({ added: 0, updated: 0, removed: 0 })
    expect(emitted.filter((e) => e === 'library:changed')).toHaveLength(1)
  })

  it('never deletes a record the user touched or a tracked install; only `owned` clears', () => {
    service.mergeOwned('steam', [
      { externalId: '1', title: 'Favourite' },
      { externalId: '2', title: 'Hidden' },
      { externalId: '3', title: 'Renamed' },
      { externalId: '4', title: 'Custom art' },
      { externalId: '5', title: 'Installing' },
      { externalId: '6', title: 'Plain' },
      { externalId: '7', title: 'Completed' },
      { externalId: '8', title: 'Preferred copy' }
    ])
    service.updateGame('steam:1', { favorite: true })
    service.updateGame('steam:2', { hidden: true })
    service.updateGame('steam:3', { user: { titleOverride: 'Mine' } })
    service.updateGame('steam:4', { user: { customMedia: { cover: 'media://x' } } })
    service.updateGame('steam:7', { completed: true })
    service.updateGame('steam:8', { user: { preferredCopy: true } })
    // A store hiccup answers with nothing: every record loses `owned`, only the plain one disappears.
    const result = service.mergeOwned('steam', [], { keepIds: new Set(['steam:5']) })
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 1 })
    expect(service.getGame('steam:6')).toBeUndefined()
    for (const id of ['steam:1', 'steam:2', 'steam:3', 'steam:4', 'steam:5', 'steam:7', 'steam:8'])
      expect(service.getGame(id), id).toMatchObject({ owned: false, installed: false })
    expect(service.getGame('steam:1')?.favorite).toBe(true)
    // The next successful import restores `owned` on the same records (the flags survive).
    service.mergeOwned('steam', [{ externalId: '1', title: 'Favourite' }])
    expect(service.getGame('steam:1')).toMatchObject({ owned: true, favorite: true })
  })

  it('folds an EA owned game onto the installed record keyed by another content id or the offer id', () => {
    service.mergeScan('ea', [
      scanned({
        source: 'ea',
        externalId: '1013894',
        platformId: 'ea',
        title: 'Battlefield 4',
        installDir: 'C:\\Games\\Battlefield 4',
        launch: { kind: 'uri', uri: 'origin2://game/launch?offerIds=1013894' },
        extra: { contentIds: '1013894;1018201', eaOfferId: 'Origin.OFR.50.0001139' }
      }),
      scanned({
        source: 'ea',
        externalId: 'path:abc123',
        platformId: 'ea',
        title: 'Need for Speed',
        installDir: 'C:\\Games\\NFS',
        launch: { kind: 'uri', uri: 'origin2://library/open' },
        extra: { eaOfferId: 'Origin.OFR.50.0002222' }
      })
    ])
    const result = service.mergeOwned('ea', [
      { externalId: '1018201', title: 'Battlefield 4 (edition)', extra: { eaOfferId: 'x' } },
      { externalId: '77', title: 'Need for Speed', extra: { eaOfferId: 'Origin.OFR.50.0002222' } }
    ])
    expect(result.added).toBe(0)
    expect(service.games().filter((g) => g.source === 'ea')).toHaveLength(2)
    expect(service.getGame('ea:1013894')).toMatchObject({ installed: true, owned: true })
    expect(service.getGame('ea:path:abc123')).toMatchObject({ installed: true, owned: true })
  })

  it('flags an installed game as owned without touching the manifest facts', () => {
    service.mergeScan('steam', [
      scanned({ storePlaytimeMinutes: 100, lastPlayed: '2026-01-01T00:00:00.000Z' })
    ])
    const result = service.mergeOwned('steam', [
      {
        externalId: '620',
        title: 'Portal 2 (store title)',
        storePlaytimeMinutes: 50,
        lastPlayedAt: '2026-06-01T00:00:00.000Z',
        extra: { fromStore: true }
      }
    ])
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 })
    const game = service.getGame('steam:620')!
    expect(game).toMatchObject({
      installed: true,
      owned: true,
      title: 'Portal 2',
      installDir: 'C:\\Steam\\steamapps\\common\\Portal 2',
      launch: { kind: 'uri', uri: 'steam://rungameid/620' },
      storePlaytimeMinutes: 100,
      lastPlayed: '2026-06-01T00:00:00.000Z',
      extra: { fromStore: true }
    })
    service.mergeOwned('steam', [{ externalId: '620', title: 'x', storePlaytimeMinutes: 200 }])
    expect(service.getGame('steam:620')?.storePlaytimeMinutes).toBe(200)
  })

  it('clears owned for unlisted games and removes the ones that existed only because of the account', () => {
    service.mergeScan('steam', [scanned({ externalId: '440', title: 'TF2' })])
    service.mergeOwned('steam', [
      { externalId: '440', title: 'TF2' },
      { externalId: '620', title: 'Portal 2' },
      { externalId: '70', title: 'Half-Life' },
      { externalId: '220', title: 'Half-Life 2' }
    ])
    // 70 was played through PlayOut (a session), 220 was installed once: both stay.
    const session = service.beginSession('steam:70')
    service.endSession(session)
    service.mergeScan('steam', [scanned({ externalId: '220', title: 'Half-Life 2' })], {
      markMissing: false
    })
    service.mergeScan('steam', [scanned({ externalId: '440', title: 'TF2' })])
    expect(service.getGame('steam:220')).toMatchObject({ installed: false, owned: true })

    // 440 is unchanged (owned already, installed title kept): not counted as updated.
    const result = service.mergeOwned('steam', [{ externalId: '440', title: 'TF2' }])
    expect(result).toMatchObject({ added: 0, updated: 0, removed: 1 })
    expect(service.getGame('steam:620')).toBeUndefined()
    expect(service.getGame('steam:70')).toMatchObject({
      owned: false,
      installed: false,
      playCount: 1
    })
    expect(service.getGame('steam:220')).toMatchObject({ owned: false, installed: false })
    expect(service.getGame('steam:440')).toMatchObject({ owned: true, installed: true })
    // Other sources are never touched.
    service.mergeOwned('epic', [{ externalId: 'Fortnite', title: 'Fortnite' }])
    service.mergeOwned('steam', [])
    expect(service.getGame('epic:Fortnite')?.owned).toBe(true)
    expect(service.getGame('steam:440')?.owned).toBe(false)
  })

  it('refreshes the title of an owned-only record and uses the id when the store gives no title', () => {
    service.mergeOwned('gog', [{ externalId: '1', title: 'Old' }])
    service.mergeOwned('gog', [{ externalId: '1', title: 'New Title' }])
    expect(service.getGame('gog:1')).toMatchObject({ title: 'New Title', sortTitle: 'new title' })
    service.mergeOwned('xbox', [{ externalId: 'Some.Pfn_abc', title: '' }])
    expect(service.getGame('xbox:Some.Pfn_abc')?.title).toBe('Some.Pfn_abc')
  })
})

describe('LibraryService.setInstallSizes', () => {
  const DAY = 24 * 60 * 60 * 1000
  const at = (ageMs: number): string => new Date(Date.now() - ageMs).toISOString()
  const changes = (): number => emitted.filter((e) => e === 'library:changed').length

  it('writes and announces a new size, then neither writes nor announces the same one again', () => {
    service.mergeScan('steam', [scanned()])
    const before = changes()
    const size = { bytes: 5, how: 'store' as const, path: 'C:\\x', measuredAt: at(DAY) }
    expect(service.setInstallSizes([{ id: 'steam:620', size }])).toEqual(['steam:620'])
    expect(changes()).toBe(before + 1)
    expect(service.getGame('steam:620')?.installSize).toEqual(size)

    const patch = vi.spyOn(libStore, 'patch')
    // The client's same record seen again later: nothing to write at all, measuredAt kept.
    expect(
      service.setInstallSizes([{ id: 'steam:620', size: { ...size, measuredAt: at(0) } }])
    ).toEqual([])
    expect(service.setInstallSizes([{ id: 'steam:620', size: { ...size } }])).toEqual([])
    expect(patch).not.toHaveBeenCalled()
    expect(changes()).toBe(before + 1)
    expect(service.getGame('steam:620')?.installSize?.measuredAt).toBe(size.measuredAt)
  })

  it('refreshes measuredAt of a re-walk with the same result quietly', () => {
    service.mergeScan('steam', [scanned()])
    const old = { bytes: 7, how: 'folder' as const, path: 'C:\\g', measuredAt: at(8 * DAY) }
    service.setInstallSizes([{ id: 'steam:620', size: old }])
    const before = changes()
    const patch = vi.spyOn(libStore, 'patch')
    const fresh = { ...old, measuredAt: at(0) }
    expect(service.setInstallSizes([{ id: 'steam:620', size: fresh }])).toEqual([])
    expect(patch).toHaveBeenCalledTimes(1)
    expect(changes()).toBe(before)
    expect(service.getGame('steam:620')?.installSize).toEqual(fresh)
    // The identical entry again: no write at all.
    expect(service.setInstallSizes([{ id: 'steam:620', size: { ...fresh } }])).toEqual([])
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('also refreshes an unmeasurable entry quietly', () => {
    service.mergeScan('steam', [scanned()])
    const old = {
      bytes: 0,
      how: 'folder' as const,
      path: 'C:\\g',
      measuredAt: at(8 * DAY),
      unmeasurable: true as const
    }
    service.setInstallSizes([{ id: 'steam:620', size: old }])
    const before = changes()
    const fresh = { ...old, measuredAt: at(0) }
    expect(service.setInstallSizes([{ id: 'steam:620', size: fresh }])).toEqual([])
    expect(changes()).toBe(before)
    expect(service.getGame('steam:620')?.installSize).toEqual(fresh)
  })

  it('announces a change of bytes, path, kind or measurability, and only the changed ids', () => {
    service.mergeScan('steam', [scanned(), scanned({ externalId: '440', title: 'TF2' })])
    const base = { bytes: 7, how: 'folder' as const, path: 'C:\\g', measuredAt: at(0) }
    service.setInstallSizes([
      { id: 'steam:620', size: base },
      { id: 'steam:440', size: base }
    ])
    const variants: NonNullable<Game['installSize']>[] = [
      { ...base, bytes: 8 },
      { ...base, bytes: 8, path: 'D:\\g' },
      { ...base, bytes: 8, path: 'D:\\g', how: 'store' },
      { bytes: 8, how: 'store', path: 'D:\\g', measuredAt: at(0), unmeasurable: true }
    ]
    for (const size of variants) {
      const before = changes()
      expect(
        service.setInstallSizes([
          { id: 'steam:620', size },
          { id: 'steam:440', size: base }
        ])
      ).toEqual(['steam:620'])
      expect(changes()).toBe(before + 1)
      expect(service.getGame('steam:620')?.installSize).toEqual(size)
    }
  })

  it('does not write a stored size that cannot change through the caller', () => {
    service.mergeScan('steam', [scanned()])
    const size = { bytes: 7, how: 'folder' as const, path: 'C:\\g', measuredAt: at(0) }
    service.setInstallSizes([{ id: 'steam:620', size }])
    size.bytes = 99
    expect(service.getGame('steam:620')?.installSize?.bytes).toBe(7)
  })

  // An id removed while its folder was walked: nothing written, nothing announced.
  it('ignores ids that are not in the library', () => {
    const before = changes()
    expect(
      service.setInstallSizes([{ id: 'nope', size: { bytes: 1, how: 'file', measuredAt: at(0) } }])
    ).toEqual([])
    expect(changes()).toBe(before)
    expect(service.getGame('nope')).toBeUndefined()
  })

  it('writes the games in the library and skips the ones that are not, in one announcement', () => {
    service.mergeScan('steam', [scanned()])
    const before = changes()
    const patch = vi.spyOn(libStore, 'patch')
    const size = { bytes: 3, how: 'file' as const, measuredAt: at(0) }
    expect(
      service.setInstallSizes([
        { id: 'gone', size },
        { id: 'steam:620', size },
        { id: 'also-gone', size }
      ])
    ).toEqual(['steam:620'])
    expect(patch).toHaveBeenCalledTimes(1)
    expect(changes()).toBe(before + 1)
    expect(service.getGame('steam:620')?.installSize).toEqual(size)
  })
})

describe('LibraryService.rekeyRom', () => {
  const rom = (externalId: string): ScannedGame =>
    scanned({
      source: 'rom',
      externalId,
      platformId: 'ps2',
      title: 'Game',
      romPath: `D:/roms/${externalId}`,
      launch: { kind: 'exec', command: 'pcsx2', args: [] } as never,
      tracking: { mode: 'process' } as never
    })

  it("moves a converted ROM's record, sessions and media to its new file's id", () => {
    const changes: unknown[] = []
    events.on('library:changed', (payload) => changes.push(payload))
    service.mergeScan('rom', [rom('ps2/Game.iso')])
    const oldId = service.games()[0]!.id
    service.updateGame(oldId, { favorite: true })
    service.endSession(service.beginSession(oldId))
    service.setMedia(oldId, 'cover', `media://cache/${oldId.replace(/[^\w-]/g, '_')}/cover.jpg`)
    const newId = service.rekeyRom(oldId, 'ps2/Game.chd', 'D:/roms/ps2/Game.chd', (url) =>
      url.replace('/rom_', '/moved_rom_')
    )
    expect(newId).toBeTruthy()
    expect(service.getGame(oldId)).toBeUndefined()
    // The renderer is told where it went (an open game page follows it).
    expect(changes).toContainEqual(
      expect.objectContaining({ reason: 'remove', gameIds: [oldId], movedTo: { [oldId]: newId } })
    )
    const moved = service.getGame(newId!)!
    expect(moved).toMatchObject({
      favorite: true,
      externalId: 'ps2/Game.chd',
      romPath: 'D:/roms/ps2/Game.chd'
    })
    expect(moved.media.cover).toContain('/moved_rom_')
    expect(service.getSessions(newId!)).toHaveLength(1)
    expect(service.getSessions(oldId)).toHaveLength(0)
    // The scan of the new file finds the moved record, not a new game.
    expect(service.mergeScan('rom', [rom('ps2/Game.chd')])).toMatchObject({ added: 0 })
  })

  it('drops the old file’s folder flags when it moves to the converted file', () => {
    service.mergeScan('rom', [
      { ...rom('ps3/Game.ps3'), extra: { directory: true, ps3Kind: 'disc' } }
    ])
    const oldId = service.games()[0]!.id
    expect(service.getGame(oldId)!.extra).toMatchObject({ directory: true, ps3Kind: 'disc' })
    const newId = service.rekeyRom(oldId, 'ps3/Game.iso', 'D:/roms/ps3/Game.iso')
    const extra = service.getGame(newId!)!.extra as Record<string, unknown> | undefined
    expect(extra?.directory).toBeUndefined()
    expect(extra?.ps3Kind).toBeUndefined()
  })

  it('moves nothing when the new file is already a game, or the game is not a ROM', () => {
    service.mergeScan('rom', [rom('ps2/Game.iso'), rom('ps2/Game.chd')])
    const iso = service.games().find((g) => g.externalId === 'ps2/Game.iso')!
    expect(service.rekeyRom(iso.id, 'ps2/Game.chd', 'D:/roms/ps2/Game.chd')).toBeNull()
    service.mergeScan('steam', [scanned()])
    expect(service.rekeyRom('steam:620', 'x', 'y')).toBeNull()
  })
})

describe('LibraryService metadata edits and the metadata cloud', () => {
  it('shows edits and the cloud over the scraped metadata; scrapers cannot replace them', async () => {
    const { MetadataCloudOverlay } = await import('../metadata-edits/cloud-overlay')
    service.mergeScan('steam', [scanned()])
    service.applyMetadata('steam:620', {
      metadata: { description: 'Scraped', developers: ['Valve'], genres: ['Puzzle'] }
    })
    const cloud = new MetadataCloudOverlay()
    service.setCloudOverlay(cloud)
    const changed: (string[] | undefined)[] = []
    events.on('library:changed', (p) => changed.push(p.gameIds))
    cloud.replaceAll({ 'steam-620': { description: 'Cloud', genres: ['Cloud genre'] } })
    expect(changed).toEqual([['steam:620']])

    const hook = vi.fn()
    service.setMetadataEditedHook(hook)
    const shown = service.setMetadataEdit('steam:620', { title: 'My Portal', genres: ['Mine'] })
    expect(shown.metadata.genres).toEqual(['Mine'])
    expect(shown.metadata.description).toBe('Cloud')
    expect(shown.user.titleOverride).toBe('My Portal')
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'steam:620' }),
      'steam-620',
      { title: 'My Portal', genres: ['Mine'] },
      { set: { title: 'My Portal', genres: ['Mine'] } }
    )

    // A scraper overwriting everything changes only the scraped layer.
    service.applyMetadata(
      'steam:620',
      { metadata: { description: 'Rescraped', genres: ['Rescraped'], developers: ['New dev'] } },
      { overwrite: true }
    )
    const view = service.getGameView('steam:620')!
    expect(view.metadata.genres).toEqual(['Mine'])
    expect(view.metadata.description).toBe('Cloud')
    expect(view.metadata.developers).toEqual(['New dev'])
    expect(service.snapshot().games[0].metadata.genres).toEqual(['Mine'])
    // The stored record keeps the scraped values.
    expect(service.getGame('steam:620')?.metadata.genres).toEqual(['Rescraped'])

    // Removing the edit falls back to the cloud, then (without a cloud entry) to the scraped value.
    service.clearMetadataEdit('steam:620', ['genres'])
    expect(service.getGameView('steam:620')?.metadata.genres).toEqual(['Cloud genre'])
    expect(hook).toHaveBeenLastCalledWith(
      expect.anything(),
      'steam-620',
      { title: 'My Portal' },
      { cleared: ['genres'] }
    )
    cloud.set('steam-620', null)
    expect(service.getGameView('steam:620')?.metadata.genres).toEqual(['Rescraped'])
    expect(service.metadataLayers('steam:620')).toMatchObject({
      key: 'steam-620',
      cloud: null,
      local: { title: 'My Portal' },
      scraped: { genres: ['Rescraped'], description: 'Rescraped' }
    })
    service.clearMetadataEdit('steam:620')
    expect(service.getGame('steam:620')?.user).toEqual({})
  })

  it('saves and clears in one go, and a failing hook does not fail the save', () => {
    service.mergeScan('steam', [scanned()])
    service.setMetadataEdit('steam:620', { tags: ['A'], localPlayers: 2 })
    service.setMetadataEditedHook(() => {
      throw new Error('offline')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const shown = service.setMetadataEdit('steam:620', { localPlayers: 4 }, ['tags'])
    expect(shown.user.metadataEdits).toEqual({ localPlayers: 4 })
    expect(shown.metadata.localPlayers?.max).toBe(4)
    expect(() => service.setMetadataEdit('nope', {})).toThrow(/Unknown game/)
  })
})

describe('LibraryService edits of host-only games', () => {
  const memory = (): import('../metadata-edits/remote-edits').RemoteEditsStore => {
    let data: import('../metadata-edits/remote-edits').RemoteEditsFile = { version: 1, games: {} }
    return {
      get: () => data,
      set(mutator) {
        const result = mutator(data)
        if (result !== undefined) data = result
        return data
      }
    }
  }
  const hostGame = (hostId = 'host-1'): Game =>
    ({
      id: `remote:${hostId}:steam:620`,
      source: 'steam',
      externalId: '620',
      platformId: 'steam',
      title: 'Portal 2',
      sortTitle: 'portal 2',
      installed: false,
      owned: false,
      launch: { kind: 'uri', uri: '' },
      tracking: { mode: 'none' },
      hidden: false,
      favorite: false,
      playtimeMinutes: 0,
      playCount: 0,
      addedAt: '2026-01-01T00:00:00.000Z',
      metadata: { description: 'Host', genres: ['Host genre'], developers: ['Valve'] },
      media: {},
      user: { titleOverride: 'Portal Two' },
      remote: {
        hostId,
        hostName: 'Living Room',
        hostGameId: 'steam:620',
        streamable: true,
        downloadable: false
      }
    }) as Game

  it('lays the cloud, then the edit, over the host metadata and calls the cloud hook', async () => {
    const { MetadataCloudOverlay } = await import('../metadata-edits/cloud-overlay')
    const { RemoteMetadataEdits } = await import('../metadata-edits/remote-edits')
    const cloud = new MetadataCloudOverlay()
    service.setCloudOverlay(cloud)
    service.setRemoteMetadataEdits(new RemoteMetadataEdits(memory()))
    const views = vi.fn()
    service.onRemoteViewChange(views)
    cloud.replaceAll({ 'steam-620': { description: 'Cloud', developers: ['Valve Corporation'] } })
    expect(views).toHaveBeenCalledTimes(1)

    const game = hostGame()
    expect(service.viewRemote(game).metadata).toMatchObject({
      description: 'Cloud',
      genres: ['Host genre'],
      developers: ['Valve Corporation']
    })
    // The host owner's title is the host layer's title.
    expect(service.remoteMetadataLayers(game)).toMatchObject({
      key: 'steam-620',
      scraped: { title: 'Portal Two', description: 'Host' },
      cloud: { description: 'Cloud' },
      local: {}
    })

    const hook = vi.fn()
    service.setMetadataEditedHook(hook)
    const shown = service.setRemoteMetadataEdit(game, {
      title: 'Portal 2 (mine)',
      description: 'Mine'
    })
    expect(shown.id).toBe(game.id)
    expect(shown.metadata.description).toBe('Mine')
    expect(shown.metadata.developers).toEqual(['Valve Corporation'])
    expect(shown.user.titleOverride).toBe('Portal 2 (mine)')
    expect(views).toHaveBeenCalledTimes(2)
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ id: game.id }),
      'steam-620',
      { title: 'Portal 2 (mine)', description: 'Mine' },
      { set: { title: 'Portal 2 (mine)', description: 'Mine' } }
    )
    // The same game from another host (another host id) shows the same edit; nothing goes in library.json.
    expect(service.viewRemote(hostGame('host-2')).metadata.description).toBe('Mine')
    expect(service.games()).toEqual([])

    // Reset falls back to the cloud, then to the host.
    service.clearRemoteMetadataEdit(game, ['description'])
    expect(service.viewRemote(game).metadata.description).toBe('Cloud')
    expect(hook).toHaveBeenLastCalledWith(
      expect.anything(),
      'steam-620',
      { title: 'Portal 2 (mine)' },
      { cleared: ['description'] }
    )
    cloud.set('steam-620', null)
    expect(service.viewRemote(game).metadata.description).toBe('Host')
    service.clearRemoteMetadataEdit(game)
    expect(service.remoteMetadataLayers(game).local).toEqual({})
  })

  it('does not call the cloud hook for a game without a cloud key, and refuses without a store', async () => {
    const { RemoteMetadataEdits } = await import('../metadata-edits/remote-edits')
    const game = { ...hostGame(), source: 'manual', externalId: '' } as Game
    expect(() => service.setRemoteMetadataEdit(game, { description: 'x' })).toThrow(
      /cannot be edited/
    )
    service.setRemoteMetadataEdits(new RemoteMetadataEdits(memory()))
    const hook = vi.fn()
    service.setMetadataEditedHook(hook)
    expect(service.remoteEditKey(game)).toBe('host-game:steam:620')
    expect(service.setRemoteMetadataEdit(game, { description: 'x' }).metadata.description).toBe('x')
    expect(hook).not.toHaveBeenCalled()
  })

  it("never sends a host's .exe-added game to the cloud under its stand-in key", async () => {
    const { MetadataCloudOverlay } = await import('../metadata-edits/cloud-overlay')
    const { RemoteMetadataEdits } = await import('../metadata-edits/remote-edits')
    const cloud = new MetadataCloudOverlay()
    service.setCloudOverlay(cloud)
    service.setRemoteMetadataEdits(new RemoteMetadataEdits(memory()))
    // The offer's stand-in: id manual:<hash>, externalId the hash, no exePath.
    const game = {
      ...hostGame(),
      id: 'remote:host-1:manual:0123456789abcdef',
      source: 'manual',
      externalId: '0123456789abcdef',
      platformId: 'pc',
      remote: { ...hostGame().remote!, hostGameId: 'manual:0123456789abcdef' }
    } as Game
    cloud.replaceAll({ 'manual-0123456789abcdef': { description: 'Junk' } })
    const hook = vi.fn()
    service.setMetadataEditedHook(hook)
    expect(service.viewRemote(game).metadata.description).toBe('Host')
    expect(service.remoteMetadataLayers(game)).toMatchObject({ key: null, cloud: null })
    expect(service.setRemoteMetadataEdit(game, { description: 'Mine' }).metadata.description).toBe(
      'Mine'
    )
    service.clearRemoteMetadataEdit(game)
    expect(hook).not.toHaveBeenCalled()
  })

  it("keeps the host owner's title above the cloud's title, with the cloud's other fields", async () => {
    const { MetadataCloudOverlay } = await import('../metadata-edits/cloud-overlay')
    const { RemoteMetadataEdits } = await import('../metadata-edits/remote-edits')
    const cloud = new MetadataCloudOverlay()
    service.setCloudOverlay(cloud)
    service.setRemoteMetadataEdits(new RemoteMetadataEdits(memory()))
    cloud.replaceAll({ 'steam-620': { title: 'Portal 2 (cloud)', description: 'Cloud' } })
    const game = hostGame()
    const shown = service.viewRemote(game)
    expect(shown.title).toBe('Portal Two')
    expect(shown.metadata.description).toBe('Cloud')
    // In the Edit sheet the title stays the host's (scraped) layer, not the cloud's.
    expect(service.remoteMetadataLayers(game)).toMatchObject({
      scraped: { title: 'Portal Two' },
      cloud: { description: 'Cloud' }
    })
    expect(service.remoteMetadataLayers(game).cloud).not.toHaveProperty('title')
    // Without a host owner's title the cloud's title shows.
    const plain = { ...game, user: {} } as Game
    expect(service.viewRemote(plain).title).toBe('Portal 2 (cloud)')
    // This PC's own title edit still wins.
    service.setRemoteMetadataEdit(game, { title: 'Mine' })
    expect(service.viewRemote(game).user.titleOverride).toBe('Mine')
  })

  it("tidies the owner's edit of a host game once the cloud carries it", async () => {
    const { RemoteMetadataEdits } = await import('../metadata-edits/remote-edits')
    service.setRemoteMetadataEdits(new RemoteMetadataEdits(memory()))
    const game = hostGame()
    service.setRemoteMetadataEdit(game, { description: 'D1', genres: ['Mine'] })
    const views = vi.fn()
    service.onRemoteViewChange(views)
    service.tidyRemoteMetadataEdit('steam-620', { description: 'D2' })
    expect(views).not.toHaveBeenCalled()
    service.tidyRemoteMetadataEdit('steam-620', { description: 'D1' })
    expect(views).toHaveBeenCalledTimes(1)
    expect(service.remoteMetadataLayers(game).local).toEqual({ genres: ['Mine'] })
  })

  it("keeps the owner's title edit of a host game the host owner renamed after the cloud confirms it", async () => {
    const { MetadataCloudOverlay } = await import('../metadata-edits/cloud-overlay')
    const { RemoteMetadataEdits } = await import('../metadata-edits/remote-edits')
    const cloud = new MetadataCloudOverlay()
    service.setCloudOverlay(cloud)
    service.setRemoteMetadataEdits(new RemoteMetadataEdits(memory()))
    const game = hostGame() // the host owner's title: 'Portal Two'
    service.setRemoteMetadataEdit(game, { title: 'Portal 2 (owner)', description: 'D1' })
    // The owner's publish shows up in all.json.
    cloud.replaceAll({ 'steam-620': { title: 'Portal 2 (owner)', description: 'D1' } })
    service.tidyRemoteMetadataEdit('steam-620', { title: 'Portal 2 (owner)', description: 'D1' })
    expect(service.remoteMetadataLayers(game).local).toEqual({ title: 'Portal 2 (owner)' })
    const shown = service.viewRemote(game)
    expect(shown.user.titleOverride ?? shown.title).toBe('Portal 2 (owner)')
    expect(shown.metadata.description).toBe('D1')
  })

  it("carries the edit over to a downloaded game, keeping that game's own edits", async () => {
    const { RemoteMetadataEdits } = await import('../metadata-edits/remote-edits')
    service.setRemoteMetadataEdits(new RemoteMetadataEdits(memory()))
    service.setRemoteMetadataEdit(hostGame(), { description: 'From host card', genres: ['Mine'] })
    service.mergeScan('steam', [scanned()])
    service.setMetadataEdit('steam:620', { genres: ['Local'] })
    const changed: (string[] | undefined)[] = []
    events.on('library:changed', (p) => changed.push(p.gameIds))
    expect(service.adoptRemoteMetadataEdit('steam:620', 'steam:620')).toBe(true)
    expect(changed).toEqual([['steam:620']])
    const view = service.getGameView('steam:620')!
    expect(view.metadata.description).toBe('From host card')
    expect(view.metadata.genres).toEqual(['Local'])
    // Nothing left to take: no second change.
    expect(service.adoptRemoteMetadataEdit('steam:620')).toBe(false)
    expect(service.adoptRemoteMetadataEdit('nope')).toBe(false)
  })
})

describe('LibraryService favourite times (the favourites sync)', () => {
  it("stamps only the user's own favourite change, and tells the listeners", () => {
    service.mergeScan('steam', [scanned()])
    const changes: string[] = []
    service.onUserFavorite((id) => changes.push(id))
    // Main's own callers (custom art, performance profile) never stamp, even with a favourite in the patch.
    service.updateGame('steam:620', { favorite: true })
    expect(service.getGame('steam:620')?.favoriteAt).toBeUndefined()
    expect(changes).toEqual([])
    service.updateGame('steam:620', { favorite: false }, { byUser: true })
    const at = service.getGame('steam:620')?.favoriteAt
    expect(at).toBeTruthy()
    expect(changes).toEqual(['steam:620'])
    // No change (already not a favourite): no new stamp, nobody told.
    service.updateGame('steam:620', { favorite: false }, { byUser: true })
    service.updateGame('steam:620', { hidden: true }, { byUser: true })
    expect(service.getGame('steam:620')?.favoriteAt).toBe(at)
    expect(changes).toEqual(['steam:620'])
  })

  it('stamps strictly after a change taken from another PC dated ahead', () => {
    service.mergeScan('steam', [scanned()])
    const ahead = Date.now() + 60_000
    service.setSyncedFavorite('steam:620', true, ahead)
    service.updateGame('steam:620', { favorite: false }, { byUser: true })
    expect(Date.parse(service.getGame('steam:620')!.favoriteAt!)).toBe(ahead + 1)
  })

  it('an imported favourite and a synced one never count as the user change', () => {
    service.mergeScan('steam', [scanned()])
    const changes: string[] = []
    service.onUserFavorite((id) => changes.push(id))
    service.applyImportedState('steam:620', { favorite: true })
    expect(service.getGame('steam:620')).toMatchObject({ favorite: true })
    expect(service.getGame('steam:620')?.favoriteAt).toBeUndefined()
    const at = Date.parse('2026-11-10T10:00:00.000Z')
    emitted.length = 0
    expect(service.setSyncedFavorite('steam:620', false, at)).toBe(true)
    expect(service.getGame('steam:620')).toMatchObject({
      favorite: false,
      favoriteAt: new Date(at).toISOString()
    })
    expect(emitted).toEqual(['library:changed'])
    // Only the time (the favourite already agrees): no library event.
    emitted.length = 0
    service.setSyncedFavorite('steam:620', false, at + 5)
    expect(emitted).toEqual([])
    // Never changed: kept without a time.
    service.setSyncedFavorite('steam:620', true, 0)
    expect(service.getGame('steam:620')?.favoriteAt).toBeUndefined()
    expect(changes).toEqual([])
    expect(service.setSyncedFavorite('steam:nope', true, at)).toBe(false)
  })

  it("a converted ROM keeps its favourite's time", () => {
    service.mergeScan('rom', [
      scanned({
        source: 'rom',
        externalId: 'ps2/Game.iso',
        platformId: 'ps2',
        title: 'Game',
        romPath: 'D:/roms/ps2/Game.iso',
        launch: { kind: 'exec', command: 'pcsx2', args: [] } as never,
        tracking: { mode: 'process' } as never
      })
    ])
    const oldId = service.games()[0]!.id
    service.updateGame(oldId, { favorite: true }, { byUser: true })
    const at = service.getGame(oldId)!.favoriteAt
    const newId = service.rekeyRom(oldId, 'ps2/Game.chd', 'D:/roms/ps2/Game.chd')!
    expect(service.getGame(newId)).toMatchObject({ favorite: true, favoriteAt: at })
  })
})

describe('LibraryService play sessions taken from paired PCs (the play time sync)', () => {
  const session = (
    id: string,
    gameId = 'steam:620',
    minutes = 30
  ): { id: string; gameId: string; startedAt: string; endedAt: string; minutes: number } => ({
    id,
    gameId,
    startedAt: '2026-11-10T10:00:00.000Z',
    endedAt: '2026-11-10T10:30:00.000Z',
    minutes
  })

  it('counts each new session once in play time, play count and last played, without session events', () => {
    service.mergeScan('steam', [scanned()])
    emitted = []
    expect(
      service.addSyncedSessions([session('s_a'), session('s_b', 'steam:620', 15)], 'pc-b')
    ).toBe(2)
    expect(service.getGame('steam:620')).toMatchObject({
      playtimeMinutes: 45,
      playCount: 2,
      lastPlayed: '2026-11-10T10:00:00.000Z'
    })
    expect(emitted).toEqual(['library:changed'])
    expect(service.getSessions('steam:620')).toEqual([
      expect.objectContaining({ id: 's_a', from: 'pc-b', syncedAt: expect.any(String) }),
      expect.objectContaining({ id: 's_b', from: 'pc-b' })
    ])
    expect(service.hasSession('s_a')).toBe(true)
    // The same sessions again (a repeat, or through another PC): nothing changes.
    emitted = []
    expect(service.addSyncedSessions([session('s_a'), session('s_b')], 'pc-c')).toBe(0)
    expect(service.getGame('steam:620')).toMatchObject({ playtimeMinutes: 45, playCount: 2 })
    expect(emitted).toEqual([])
  })

  it('a last played taken from a paired PC raises the date only, and never lowers it', () => {
    service.mergeScan('steam', [scanned()])
    const at = Date.parse('2026-11-10T10:00:00.000Z')
    emitted = []
    expect(
      service.setSyncedLastPlayed([
        { id: 'steam:620', atMs: at },
        { id: 'steam:999', atMs: at },
        { id: 'steam:620', atMs: Number.NaN },
        { id: 'steam:620', atMs: 0 }
      ])
    ).toBe(1)
    expect(service.getGame('steam:620')).toMatchObject({
      lastPlayed: '2026-11-10T10:00:00.000Z',
      playtimeMinutes: 0,
      playCount: 0
    })
    expect(service.getSessions('steam:620')).toEqual([])
    expect(emitted).toEqual(['library:changed'])
    // The same date again, or an earlier one: nothing changes and nobody is told.
    emitted = []
    expect(
      service.setSyncedLastPlayed([
        { id: 'steam:620', atMs: at },
        { id: 'steam:620', atMs: at - 60_000 }
      ])
    ).toBe(0)
    expect(service.getGame('steam:620')?.lastPlayed).toBe('2026-11-10T10:00:00.000Z')
    expect(emitted).toEqual([])
    expect(service.setSyncedLastPlayed([{ id: 'steam:620', atMs: at + 60_000 }])).toBe(1)
    expect(service.getGame('steam:620')?.lastPlayed).toBe('2026-11-10T10:01:00.000Z')
  })

  it('never takes a session of an unknown game, and keeps a newer last played', () => {
    service.mergeScan('steam', [scanned()])
    service.endSession(service.beginSession('steam:620'), 5)
    const mine = service.getGame('steam:620')!.lastPlayed
    expect(service.addSyncedSessions([session('s_x', 'steam:999')], 'pc-b')).toBe(0)
    expect(service.addSyncedSessions([session('s_y')], 'pc-b')).toBe(1)
    expect(service.getGame('steam:620')).toMatchObject({
      playtimeMinutes: 35,
      playCount: 2,
      lastPlayed: mine
    })
    // This PC's own session is not taken again either (by id).
    const own = service.getSessions('steam:620').find((s) => !s.from)!
    expect(service.addSyncedSessions([{ ...session(own.id), minutes: 99 }], 'pc-b')).toBe(0)
    expect(service.allSessions()).toHaveLength(2)
  })

  it("adds no minutes for a session the copy's own store total already counts", () => {
    service.mergeScan('steam', [scanned()])
    // Played on the other PC's Steam copy: this PC's Steam total (storePlaytimeMinutes) already has it.
    expect(
      service.addSyncedSessions(
        [
          { ...session('s_steam'), store: 'steam' },
          // Played on a GOG copy there: Steam's total does not count it.
          { ...session('s_gog', 'steam:620', 20), startedAt: '2026-11-11T10:00:00.000Z' }
        ],
        'pc-b'
      )
    ).toBe(2)
    expect(service.getGame('steam:620')).toMatchObject({
      playtimeMinutes: 20,
      playCount: 2,
      lastPlayed: '2026-11-11T10:00:00.000Z'
    })
    expect(service.getSessions('steam:620')[0]).toMatchObject({ id: 's_steam', store: 'steam' })
  })
})

describe("LibraryService: a recompilation's own card", () => {
  const info = {
    titleKey: 'n64:mm',
    count: 1,
    installed: ['github:a/b'],
    preferred: 'github:a/b',
    updatedAt: ''
  }

  it('is added once, as a ROM card with no file, and goes when removed', () => {
    const added = service.addRecompGame({
      titleKey: 'n64:mm',
      title: "Majora's Mask",
      platformId: 'n64',
      recomp: info
    })
    expect(added).toMatchObject({
      source: 'rom',
      platformId: 'n64',
      title: "Majora's Mask",
      installed: false,
      extra: { recompOnly: 'n64:mm' },
      metadata: { recomp: info }
    })
    expect(added!.romPath).toBeUndefined()
    expect(
      service.addRecompGame({ titleKey: 'n64:mm', title: 'x', platformId: 'n64', recomp: info })
    ).toBeNull()
    // A ROM scan never prunes it (it is not installed, so it is no scanned game gone missing).
    service.mergeScan('rom', [])
    expect(service.getGame(added!.id)).toBeTruthy()
    service.removeGame(added!.id)
    expect(service.getGame(added!.id)).toBeUndefined()
  })

  it("merges its play history into the original game's card", () => {
    const own = service.addRecompGame({
      titleKey: 'n64:mm',
      title: 'MM',
      platformId: 'n64',
      recomp: info
    })!
    service.mergeScan('steam', [scanned()])
    service.endSession(service.beginSession(own.id))
    service.updateGame(own.id, { favorite: true } as never)
    const before = service.getGame(own.id)!
    expect(service.absorbGame(own.id, 'steam:620')).toBe(true)
    expect(service.getGame(own.id)).toBeUndefined()
    const into = service.getGame('steam:620')!
    expect(into.playCount).toBe(before.playCount)
    expect(into.lastPlayed).toBe(before.lastPlayed)
    expect(service.absorbGame(own.id, 'steam:620')).toBe(false)
  })

  it("carries the player's settings the original lacks, never over the original's", () => {
    const own = service.addRecompGame({
      titleKey: 'n64:mm',
      title: 'MM',
      platformId: 'n64',
      recomp: info
    })!
    service.mergeScan('steam', [scanned()])
    libStore.patch(own.id, (g) => {
      g.user = { titleOverride: 'My MM', notes: 'card note', playlist: ['a.mp3'] }
      g.completed = true
    })
    libStore.patch('steam:620', (g) => {
      g.user = { notes: 'original note', playlist: ['b.mp3'] }
    })
    service.absorbGame(own.id, 'steam:620')
    const into = service.getGame('steam:620')!
    expect(into.completed).toBe(true)
    expect(into.user).toMatchObject({
      titleOverride: 'My MM',
      notes: 'original note\n\ncard note',
      playlist: ['b.mp3']
    })
  })
})

describe('LibraryService: a recompilation added from the browser', () => {
  it('is its own card, not installed, with the catalog text, once; a ROM scan leaves it', () => {
    const recomp = {
      titleKey: 'n64:mm',
      count: 1,
      installed: [],
      preferred: 'github:a/b',
      updatedAt: ''
    }
    const input = {
      recompId: 'github:a/b',
      title: 'Zelda 64: Recompiled',
      platformId: 'n64',
      recomp,
      favorite: true,
      description: 'A native port.',
      developer: 'Someone'
    }
    const card = service.addRecompEntryGame(input)
    expect(card).toMatchObject({
      source: 'rom',
      installed: false,
      favorite: true,
      metadataStatus: 'done',
      extra: { recompAdded: 'github:a/b' },
      metadata: { description: 'A native port.', developers: ['Someone'], recomp }
    })
    expect(service.addRecompEntryGame(input).id).toBe(card.id)
    service.mergeScan('rom', [])
    expect(service.getGame(card.id)).toBeTruthy()
  })
})
