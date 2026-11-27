import { describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import {
  combinedFavorite,
  combinedStates,
  copiesToChange,
  favoriteAtMs,
  favoriteGroups,
  MAX_FAVORITE_ENTRIES,
  parseFavoriteEntries,
  pickFavorite,
  proposals
} from './favorites-sync'
import {
  buildRemoteLibrary,
  hostOffer,
  localMatches,
  sanitizeHostGame,
  type HostGame
} from './remote-library'

function game(partial: Partial<Game> & Pick<Game, 'id' | 'source' | 'title'>): Game {
  return {
    externalId: partial.id.split(':').slice(1).join(':'),
    platformId: partial.source === 'rom' ? 'snes' : partial.source,
    sortTitle: partial.title.toLowerCase(),
    installed: true,
    launch: { kind: 'uri', uri: '' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...partial
  }
}

/** What crosses the wire, checked as the client checks it. */
function offerOf(games: Game[]): HostGame[] {
  return (JSON.parse(JSON.stringify(hostOffer(games))) as unknown[])
    .map((g) => sanitizeHostGame(g))
    .filter((g): g is HostGame => g !== null)
}

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const T1 = Date.parse('2026-11-10T10:00:00.000Z')
const T2 = Date.parse('2026-11-12T10:00:00.000Z')

describe('favoriteAtMs', () => {
  it('reads the time, and treats none, a broken one or an ancient one as never changed', () => {
    expect(favoriteAtMs({ favoriteAt: new Date(T1).toISOString() })).toBe(T1)
    expect(favoriteAtMs({})).toBe(0)
    expect(favoriteAtMs({ favoriteAt: 'yesterday' })).toBe(0)
    expect(favoriteAtMs({ favoriteAt: '1970-01-01T00:00:00.000Z' })).toBe(0)
  })
})

describe('parseFavoriteEntries', () => {
  it('keeps the valid entries, the first of each id, on this PC clock', () => {
    const skew = 60_000 // their clock is a minute ahead
    expect(
      parseFavoriteEntries(
        [
          { id: 'steam:1', favorite: true, at: T1 + skew },
          { id: 'steam:1', favorite: false, at: T2 },
          { id: 'steam:2', favorite: false, at: 0 },
          { id: '', favorite: true, at: T1 },
          { id: 'steam:3', favorite: 'yes', at: T1 },
          { id: 'steam:4', favorite: true, at: -5 },
          { id: 'bad\u0000id', favorite: true, at: T1 },
          { id: 'x'.repeat(513), favorite: true, at: T1 },
          'nope'
        ],
        NOW,
        skew
      )
    ).toEqual([
      { id: 'steam:1', favorite: true, at: T1 },
      { id: 'steam:2', favorite: false, at: 0 }
    ])
  })

  it('ignores a clock difference under a second (the request timing)', () => {
    expect(parseFavoriteEntries([{ id: 'a', favorite: true, at: T1 }], NOW, 400)).toEqual([
      { id: 'a', favorite: true, at: T1 }
    ])
  })

  it('drops an entry dated more than a day ahead, and refuses what is not a list or too long', () => {
    expect(
      parseFavoriteEntries([{ id: 'a', favorite: true, at: NOW + 2 * 86_400_000 }], NOW)
    ).toEqual([])
    expect(parseFavoriteEntries({ id: 'a' }, NOW)).toBeNull()
    expect(parseFavoriteEntries(null, NOW)).toBeNull()
    const many = Array.from({ length: MAX_FAVORITE_ENTRIES + 1 }, (_, i) => ({
      id: `g${i}`,
      favorite: true,
      at: T1
    }))
    expect(parseFavoriteEntries(many, NOW)).toBeNull()
  })
})

describe('pickFavorite', () => {
  it('the newer change wins, and agreeing copies need nothing', () => {
    expect(pickFavorite({ favorite: false, at: T1 }, { favorite: true, at: T2 }, false)).toBe(
      'theirs'
    )
    expect(pickFavorite({ favorite: false, at: T2 }, { favorite: true, at: T1 }, true)).toBe('mine')
    expect(pickFavorite({ favorite: true, at: T1 }, { favorite: true, at: T2 }, true)).toBe('same')
  })

  it('a change beats a favourite never changed, even an unfavourite', () => {
    expect(pickFavorite({ favorite: true, at: 0 }, { favorite: false, at: T1 }, false)).toBe(
      'theirs'
    )
    expect(pickFavorite({ favorite: false, at: T1 }, { favorite: true, at: 0 }, true)).toBe('mine')
  })

  it('between two never changed the favourite wins; an exact tie goes to the host', () => {
    expect(pickFavorite({ favorite: false, at: 0 }, { favorite: true, at: 0 }, false)).toBe(
      'theirs'
    )
    expect(pickFavorite({ favorite: true, at: 0 }, { favorite: false, at: 0 }, true)).toBe('mine')
    expect(pickFavorite({ favorite: false, at: T1 }, { favorite: true, at: T1 }, true)).toBe(
      'theirs'
    )
    expect(pickFavorite({ favorite: false, at: T1 }, { favorite: true, at: T1 }, false)).toBe(
      'mine'
    )
  })
})

describe('combinedFavorite', () => {
  it('any copy is a favourite; dated by the newest favourite copy, else the newest copy', () => {
    // A copy turned off later does not date the favourite another copy still is.
    expect(
      combinedFavorite([
        { favorite: false, favoriteAt: new Date(T2).toISOString() },
        { favorite: true, favoriteAt: new Date(T1).toISOString() }
      ])
    ).toEqual({ favorite: true, at: T1 })
    expect(
      combinedStates([
        { favorite: true, at: T1 },
        { favorite: true, at: T2 },
        { favorite: false, at: T2 + 1 }
      ])
    ).toEqual({ favorite: true, at: T2 })
    expect(combinedFavorite([])).toEqual({ favorite: false, at: 0 })
    expect(
      combinedStates([
        { favorite: false, at: 0 },
        { favorite: false, at: T1 }
      ])
    ).toEqual({ favorite: false, at: T1 })
  })

  it('an unfavourite of a second copy does not bring back a favourite the other PC removed later', () => {
    // Client: Steam copy S a favourite from before the sync (no time); GOG copy G favourited at T1, unfavourited at T2.
    const local = [
      game({ id: 'steam:9', source: 'steam', title: 'Game', favorite: true }),
      game({
        id: 'gog:9',
        source: 'gog',
        title: 'Game',
        favorite: false,
        favoriteAt: new Date(T2).toISOString()
      })
    ]
    // The host unfavourited its copy at T1.5, before the client's T2.
    const hostAt = (T1 + T2) / 2
    const mine = combinedFavorite(local)
    expect(mine).toEqual({ favorite: true, at: 0 })
    expect(pickFavorite(mine, { favorite: false, at: hostAt }, true)).toBe('theirs')
    expect(copiesToChange(local, false)).toEqual([{ id: 'steam:9', favorite: false }])
  })
})

describe('favoriteGroups (identity across PCs)', () => {
  it('groups the copies both PCs have by the same identity the remote library uses', () => {
    const hostGames = offerOf([
      game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
      // The same game in two stores on the host, and once on this PC (years agree).
      game({
        id: 'steam:1',
        source: 'steam',
        title: 'Hollow Knight',
        metadata: { releaseDate: '2017-02-24' }
      }),
      game({
        id: 'gog:1',
        source: 'gog',
        title: 'Hollow Knight',
        metadata: { releaseDate: '2017-02-24' }
      }),
      // A ROM: same system and file.
      game({ id: 'rom:snes:abc', source: 'rom', title: 'Mega Man X', externalId: 'snes/MMX.sfc' }),
      // Only the title agrees, years 1993 and 2016: different games, never linked.
      game({ id: 'steam:2', source: 'steam', title: 'Doom', metadata: { releaseDate: '2016' } }),
      // A cross-store pair with one year missing: the Library shows it as this PC's card (alsoOnHost), so linked.
      game({ id: 'gog:5', source: 'gog', title: 'Celeste 64', metadata: { releaseDate: '2024' } }),
      // Only on the host.
      game({ id: 'steam:3', source: 'steam', title: 'Celeste' })
    ])
    const local = [
      game({ id: 'steam:620', source: 'steam', title: 'Portal 2' }),
      game({
        id: 'epic:hk',
        source: 'epic',
        title: 'Hollow Knight',
        metadata: { releaseDate: '2017-01-01' }
      }),
      game({ id: 'rom:snes:zzz', source: 'rom', title: 'MMX', externalId: 'snes/MMX.chd' }),
      game({ id: 'gog:doom', source: 'gog', title: 'DOOM', metadata: { releaseDate: '1993' } }),
      game({ id: 'steam:c64', source: 'steam', title: 'Celeste 64' })
    ]
    const groups = favoriteGroups(hostGames, localMatches(local, hostGames))
    // The same matches the Library folds: every linked host game has no card of its own there, and no other.
    const lib = buildRemoteLibrary(local, [{ hostId: 'h', hostName: 'H', games: hostGames }])
    const cards = new Set(lib.games.map((g) => g.id))
    const folded = hostGames.filter((h) => !cards.has(`remote:h:${h.id}`)).map((h) => h.id)
    expect(folded.sort()).toEqual(groups.flatMap((g) => g.host.map((h) => h.id)).sort())
    const shape = groups
      .map((g) => ({
        host: g.host.map((h) => h.id).sort(),
        local: g.local.map((l) => l.id).sort()
      }))
      .sort((a, b) => a.host[0].localeCompare(b.host[0]))
    expect(shape).toEqual([
      { host: ['gog:1', 'steam:1'], local: ['epic:hk'] },
      { host: ['gog:5'], local: ['steam:c64'] },
      { host: ['rom:snes:abc'], local: ['rom:snes:zzz'] },
      { host: ['steam:620'], local: ['steam:620'] }
    ])
  })
})

describe('proposals', () => {
  const hk = (id: string, favorite: boolean): HostGame =>
    ({ id, favorite, metadata: {} }) as unknown as HostGame
  const mine = (favorite: boolean, at = T2): Game =>
    game({
      id: 'epic:hk',
      source: 'epic',
      title: 'HK',
      favorite,
      favoriteAt: new Date(at).toISOString()
    })

  it('turning on goes to one host copy; turning off to every host copy that is a favourite', () => {
    expect(
      proposals({ local: [mine(true)], host: [hk('steam:1', false), hk('gog:1', false)] })
    ).toEqual([{ id: 'steam:1', favorite: true, at: T2 }])
    expect(
      proposals({ local: [mine(false)], host: [hk('steam:1', true), hk('gog:1', true)] })
    ).toEqual([
      { id: 'steam:1', favorite: false, at: T2 },
      { id: 'gog:1', favorite: false, at: T2 }
    ])
  })

  it('nothing for a copy that is not a favourite and never changed (it cannot win)', () => {
    const never = game({ id: 'epic:hk', source: 'epic', title: 'HK' })
    expect(proposals({ local: [never], host: [hk('steam:1', true)] })).toEqual([])
  })

  it('nothing when both agree', () => {
    expect(
      proposals({ local: [mine(true)], host: [hk('steam:1', false), hk('gog:1', true)] })
    ).toEqual([])
  })
})

describe('copiesToChange', () => {
  const a = game({ id: 'steam:1', source: 'steam', title: 'A', installed: false })
  const b = game({ id: 'gog:1', source: 'gog', title: 'A' })
  const c = game({ id: 'epic:1', source: 'epic', title: 'A', user: { preferredCopy: true } })

  it('a favourite goes on one copy: the preferred one, else an installed one, else the first', () => {
    expect(copiesToChange([a, b, c], true)).toEqual([{ id: 'epic:1', favorite: true }])
    expect(copiesToChange([a, b], true)).toEqual([{ id: 'gog:1', favorite: true }])
    expect(copiesToChange([a], true)).toEqual([{ id: 'steam:1', favorite: true }])
    expect(copiesToChange([a, { ...b, favorite: true }], true)).toEqual([])
  })

  it('an unfavourite clears every copy that is one', () => {
    expect(copiesToChange([{ ...a, favorite: true }, b, { ...c, favorite: true }], false)).toEqual([
      { id: 'steam:1', favorite: false },
      { id: 'epic:1', favorite: false }
    ])
  })
})
