import { describe, expect, it, vi } from 'vitest'
import type { Game } from '../../shared/types'
import {
  RemoteMetadataEdits,
  emptyRemoteEdits,
  hostLayer,
  normalizeRemoteEdits,
  remoteEditKey,
  type RemoteEditsFile,
  type RemoteEditsStore
} from './remote-edits'

/** An in-memory stand-in for the JSON store. */
function memoryStore(initial: RemoteEditsFile = emptyRemoteEdits()): RemoteEditsStore & {
  writes: number
} {
  let data = initial
  const store = {
    writes: 0,
    get: () => data,
    set(mutator: (draft: RemoteEditsFile) => RemoteEditsFile | void) {
      const result = mutator(data)
      if (result !== undefined) data = result
      store.writes++
      return data
    }
  }
  return store
}

function hostGame(overrides: Partial<Game> = {}, hostId = 'host-1'): Game {
  const hostGameId = overrides.id ?? 'rom:snes:abc'
  return {
    source: 'rom',
    externalId: 'snes/Mega Man X (USA).sfc',
    platformId: 'snes',
    title: 'Mega Man X',
    sortTitle: 'mega man x',
    installed: false,
    owned: false,
    launch: { kind: 'uri', uri: '' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    user: {},
    ...overrides,
    id: `remote:${hostId}:${hostGameId}`,
    remote: {
      hostId,
      hostName: 'Living Room',
      hostGameId,
      streamable: true,
      downloadable: true
    }
  } as Game
}

describe('remoteEditKey', () => {
  it("is the game's cloud key, the same whichever host offers it", () => {
    expect(remoteEditKey(hostGame())).toBe('snes-mega-man-x')
    expect(remoteEditKey(hostGame({}, 'host-2'))).toBe('snes-mega-man-x')
    expect(remoteEditKey(hostGame({ id: 'steam:620', source: 'steam', externalId: '620' }))).toBe(
      'steam-620'
    )
  })

  it("falls back to the host's id of the game (without the host id)", () => {
    const game = hostGame({ id: 'rom::x', platformId: '', externalId: '' })
    expect(remoteEditKey(game)).toBe('host-game:rom::x')
  })
})

describe('hostLayer', () => {
  it("makes the host owner's title the title and drops user data", () => {
    const game = hostGame({ user: { titleOverride: 'MMX' } })
    const layer = hostLayer(game)
    expect(layer.title).toBe('MMX')
    expect(layer.user).toEqual({})
    expect(game.user).toEqual({ titleOverride: 'MMX' })
  })
})

describe('RemoteMetadataEdits', () => {
  it('saves, merges and clears an edit and tells its listeners', () => {
    const store = memoryStore()
    const edits = new RemoteMetadataEdits(store, () => Date.parse('2026-11-17T00:00:00Z'))
    const listener = vi.fn()
    edits.onChange(listener)
    const game = hostGame()
    expect(edits.set(game, { title: 'Rockman X', genres: ['Action'] })).toEqual({
      title: 'Rockman X',
      genres: ['Action']
    })
    expect(edits.set(game, { localPlayers: 1 }, ['genres'])).toEqual({
      title: 'Rockman X',
      localPlayers: 1
    })
    expect(store.get().games['snes-mega-man-x']).toMatchObject({
      hostGameIds: ['rom:snes:abc'],
      updatedAt: '2026-11-17T00:00:00.000Z'
    })
    // An empty title removes the title edit.
    expect(edits.set(game, { title: '  ' })).toEqual({ localPlayers: 1 })
    expect(edits.clear(game, ['localPlayers'])).toEqual({})
    expect(store.get().games).toEqual({})
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('tidies the fields the cloud now carries with the same value', () => {
    const store = memoryStore()
    const edits = new RemoteMetadataEdits(store)
    const listener = vi.fn()
    edits.set(hostGame(), { description: 'D1', genres: ['Action'] })
    edits.onChange(listener)
    // Another key, or a different value: nothing changes.
    expect(edits.tidy('snes-other', { description: 'D1' })).toEqual([])
    expect(edits.tidy('snes-mega-man-x', { description: 'D2' })).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    expect(edits.tidy('snes-mega-man-x', { description: 'D1', hltb: { main: 3 } })).toEqual([
      'description'
    ])
    expect(edits.get(hostGame())).toEqual({ genres: ['Action'] })
    expect(listener).toHaveBeenCalledTimes(1)
    // The last field gone: the entry goes.
    expect(edits.tidy('snes-mega-man-x', { genres: ['Action'] })).toEqual(['genres'])
    expect(store.get().games).toEqual({})
  })

  it("moves an entry stored under host-game:<id> to the game's cloud key once it has one", () => {
    const store = memoryStore()
    const edits = new RemoteMetadataEdits(store)
    const unknown = hostGame({ id: 'rom::x', platformId: '', externalId: '' })
    edits.set(unknown, { genres: ['Action'] })
    expect(Object.keys(store.get().games)).toEqual(['host-game:rom::x'])
    // The host identified the game: the same host id, now with a cloud key.
    const known = hostGame({ id: 'rom::x' })
    expect(edits.set(known, { description: 'D1' })).toEqual({
      genres: ['Action'],
      description: 'D1'
    })
    expect(Object.keys(store.get().games)).toEqual(['snes-mega-man-x'])
    expect(store.get().games['snes-mega-man-x'].hostGameIds).toEqual(['rom::x'])
    // The cloud's confirmation under that key finds it.
    expect(edits.tidy('snes-mega-man-x', { description: 'D1' })).toEqual(['description'])
    expect(edits.get(known)).toEqual({ genres: ['Action'] })
  })

  it('finds the edit from another host and by the host game id when the key changed', () => {
    const store = memoryStore()
    const edits = new RemoteMetadataEdits(store)
    edits.set(hostGame(), { description: 'Mine' })
    expect(edits.get(hostGame({}, 'host-2'))).toEqual({ description: 'Mine' })
    // The host learned a serial (another key): the host's id of it still finds the edit.
    const renamed = hostGame({ externalId: 'snes/MMX.sfc' })
    expect(edits.get(renamed)).toEqual({ description: 'Mine' })
    expect(edits.get(hostGame({ id: 'rom:snes:other', externalId: 'snes/Other.sfc' }))).toEqual({})
  })

  it("gives a downloaded game the edit by its key, else by the host's id of it", () => {
    const edits = new RemoteMetadataEdits(memoryStore())
    edits.set(hostGame(), { genres: ['Platformer'] })
    const local = {
      ...hostGame(),
      id: 'rom:snes:local',
      remote: undefined,
      romPath: 'D:/roms/snes/Mega Man X (USA).sfc'
    } as Game
    expect(edits.forLocal(local)).toEqual({ genres: ['Platformer'] })
    const elsewhere = {
      ...local,
      romPath: 'D:/roms/snes/Renamed.sfc',
      externalId: 'snes/Renamed.sfc'
    }
    expect(edits.forLocal(elsewhere)).toBeNull()
    expect(edits.forLocal(elsewhere, 'rom:snes:abc')).toEqual({ genres: ['Platformer'] })
  })

  it('reads only valid entries from the file', () => {
    const file = normalizeRemoteEdits({
      games: {
        'steam-620': {
          edit: { genres: ['Puzzle'] },
          hostGameIds: ['steam:620', 3],
          updatedAt: 'x'
        },
        bad: { edit: { localPlayers: 'many' } },
        empty: { edit: {} },
        nothing: null
      }
    })
    expect(file).toEqual({
      version: 1,
      games: {
        'steam-620': { edit: { genres: ['Puzzle'] }, hostGameIds: ['steam:620'], updatedAt: 'x' }
      }
    })
    expect(normalizeRemoteEdits(null)).toEqual(emptyRemoteEdits())
  })
})
