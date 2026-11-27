import type { Game, RemoteGameInfo, RemoteLibrary, Settings } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { describe, expect, it } from 'vitest'
import { visibleGames } from './library'
import {
  homeRowGames,
  homeRowTitle,
  isStreamingClient,
  obtainableHere,
  recentlyPlayed
} from './recent'
import { hostGamesShown, withRemoteGames } from './streaming'

function game(id: string, patch: Partial<Game> = {}): Game {
  const title = patch.title ?? id
  const source = patch.source ?? 'steam'
  return {
    id,
    source,
    externalId: id,
    platformId: source,
    title,
    sortTitle: title.toLowerCase(),
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
    metadataStatus: 'none',
    user: {},
    ...patch
  }
}

function info(patch: Partial<RemoteGameInfo> = {}): RemoteGameInfo {
  return {
    hostId: 'h1',
    hostName: 'Living Room PC',
    hostGameId: 'steam:1',
    streamable: true,
    downloadable: false,
    ...patch
  }
}

/** A game only the host has, as main's buildRemoteLibrary makes its card. */
function hostGame(
  hostGameId: string,
  patch: Partial<Game> = {},
  i: Partial<RemoteGameInfo> = {}
): Game {
  return game(`remote:h1:${hostGameId}`, {
    installed: false,
    owned: false,
    remote: info({ hostGameId, ...i }),
    ...patch
  })
}

const day = (d: number): string => `2026-11-${String(d).padStart(2, '0')}T20:00:00.000Z`

/** An owned store game that is not installed (the store account's game). */
const owned = (id: string, patch: Partial<Game> = {}): Game =>
  game(id, { installed: false, owned: true, ...patch })
/** A record kept for its history: uninstalled and no longer owned, or a ROM / .exe whose file is gone. */
const leftover = (id: string, patch: Partial<Game> = {}): Game =>
  game(id, { installed: false, owned: false, playCount: 3, ...patch })

function settingsOf(patch: (s: Settings) => void = () => {}): Settings {
  const s = defaultSettings()
  patch(s)
  return s
}

/** The row as Home builds it from the library, the remote library and the settings (on a client of a host). */
function row(
  games: Game[],
  remote: RemoteLibrary | null = null,
  settings: Settings = settingsOf(),
  count = 12,
  client = true
): string[] {
  const showHostGames = settings.streaming.showHostGames
  const visible = withRemoteGames(
    visibleGames(games, settings),
    hostGamesShown(games, remote, showHostGames)
  )
  return recentlyPlayed(visible, {
    client,
    alsoOnHost: remote?.alsoOnHost,
    showHostGames,
    showDuplicates: settings.library.showDuplicates,
    count
  }).map((g) => g.id)
}

const remoteOf = (games: Game[], alsoOnHost: RemoteLibrary['alsoOnHost'] = {}): RemoteLibrary => ({
  games,
  alsoOnHost,
  updatedAt: day(1)
})

describe('obtainableHere', () => {
  const none = { showHostGames: true }

  it('is true for a game installed here, and for one its recompilation stands in for', () => {
    expect(obtainableHere(game('steam:1'), none)).toBe(true)
    expect(obtainableHere(game('exe:1', { source: 'manual' }), none)).toBe(true)
    const recomp = {
      titleKey: 'n64:mm',
      count: 1,
      installed: ['r1'],
      preferred: 'r1',
      updatedAt: ''
    }
    const romGone = game('rom:n64:mm', { source: 'rom', installed: false, metadata: { recomp } })
    expect(obtainableHere(romGone, none)).toBe(true)
  })

  it("is true for a host's game it can stream or download, while the hosts' games are shown", () => {
    const stream = hostGame('steam:9')
    const rom = hostGame('rom:snes/z', { source: 'rom' }, { downloadable: true })
    const neither = hostGame('steam:8', {}, { streamable: false })
    const offline = hostGame('steam:7', {}, { offline: true })
    expect(obtainableHere(stream, none)).toBe(true)
    expect(obtainableHere(rom, none)).toBe(true)
    // An unreachable host's game is still its game: streamed once the host is back (the Library keeps its card too).
    expect(obtainableHere(offline, none)).toBe(true)
    expect(obtainableHere(neither, none)).toBe(false)
    expect(obtainableHere(stream, { showHostGames: false })).toBe(false)
    expect(obtainableHere(rom, { showHostGames: false })).toBe(false)
  })

  it('is true for a game a store account owns (installed from its store), whatever the hosts have', () => {
    expect(obtainableHere(owned('steam:2'), none)).toBe(true)
    expect(obtainableHere(owned('gog:2', { source: 'gog' }), { showHostGames: false })).toBe(true)
  })

  it('is false for a record that is neither installed, owned nor on a host', () => {
    // Uninstalled and no longer owned (signed out, refunded): only its history is left.
    expect(obtainableHere(leftover('steam:3'), none)).toBe(false)
    expect(obtainableHere(leftover('steam:3b', { owned: undefined }), none)).toBe(false)
    // A ROM or an added .exe whose file is gone; "owned" means nothing for them.
    expect(obtainableHere(leftover('rom:snes/gone', { source: 'rom' }), none)).toBe(false)
    expect(obtainableHere(leftover('exe:gone', { source: 'manual' }), none)).toBe(false)
    expect(obtainableHere(leftover('exe:odd', { source: 'manual', owned: true }), none)).toBe(false)
  })

  it('is true for such a record once a paired host has the game, while the hosts are shown', () => {
    const rom = leftover('rom:snes/gone', { source: 'rom' })
    const alsoOnHost = { [rom.id]: [info({ hostGameId: 'rom:snes/gone' })] }
    expect(obtainableHere(rom, { alsoOnHost, showHostGames: true })).toBe(true)
    expect(obtainableHere(rom, { alsoOnHost, showHostGames: false })).toBe(false)
    const cannot = { [rom.id]: [info({ streamable: false })] }
    expect(obtainableHere(rom, { alsoOnHost: cannot, showHostGames: true })).toBe(false)
    expect(obtainableHere(rom, { alsoOnHost: null, showHostGames: true })).toBe(false)
  })
})

describe('recentlyPlayed', () => {
  it('B: lists the most recently played games whether or not they are installed here', () => {
    const games = [
      game('steam:here', { lastPlayed: day(3) }),
      owned('steam:owned', { lastPlayed: day(5) }),
      leftover('rom:snes/on-host', { source: 'rom', lastPlayed: day(2) })
    ]
    const remote = remoteOf(
      [
        hostGame('steam:stream', { lastPlayed: day(6) }),
        hostGame('rom:snes/dl', { source: 'rom', lastPlayed: day(4) }, { downloadable: true })
      ],
      { 'rom:snes/on-host': [info({ hostGameId: 'rom:snes/on-host' })] }
    )
    expect(row(games, remote)).toEqual([
      'remote:h1:steam:stream',
      'steam:owned',
      'remote:h1:rom:snes/dl',
      'steam:here',
      'rom:snes/on-host'
    ])
    // The cards are the Library's: a game not installed here is still not (drawn greyed, with its marker).
    const visible = withRemoteGames(games, remote.games)
    const cards = recentlyPlayed(visible, {
      client: true,
      showHostGames: true,
      alsoOnHost: remote.alsoOnHost,
      count: 2
    })
    expect(cards.map((g) => [g.id, g.installed, !!g.remote])).toEqual([
      ['remote:h1:steam:stream', false, true],
      ['steam:owned', false, false]
    ])
  })

  it('C: leaves out a played game this PC can neither install nor stream', () => {
    const games = [
      game('steam:here', { lastPlayed: day(1) }),
      // Its sessions came from another client through the host once; the host no longer has it, nor does this PC.
      leftover('steam:only-on-another-client', { lastPlayed: day(9) }),
      leftover('rom:snes/gone', { source: 'rom', lastPlayed: day(8) }),
      leftover('exe:gone', { source: 'manual', lastPlayed: day(7) }),
      leftover('rom:snes/host-cannot', { source: 'rom', lastPlayed: day(6) })
    ]
    const remote = remoteOf(
      [hostGame('steam:no-way', { lastPlayed: day(5) }, { streamable: false })],
      {
        'rom:snes/host-cannot': [info({ streamable: false })]
      }
    )
    expect(row(games, remote)).toEqual(['steam:here'])
    expect(row(games, null)).toEqual(['steam:here'])
  })

  it('D: never pads the row with a never-played game that is not installed here', () => {
    const games = [
      game('steam:played', { lastPlayed: day(2) }),
      game('steam:new', { addedAt: day(9) }),
      game('steam:old', { addedAt: day(1) }),
      owned('steam:owned-never', { addedAt: day(20) }),
      // A date that is no date is not a play.
      owned('steam:owned-junk', { addedAt: day(21), lastPlayed: 'never' })
    ]
    const remote = remoteOf([hostGame('steam:host-never', { addedAt: day(22) })])
    // Installed games still pad it, newest added first.
    expect(row(games, remote)).toEqual(['steam:played', 'steam:new', 'steam:old'])
    // Played once (a store's or a host's date: their play count stays 0), they are in.
    const played = games.map((g) =>
      g.id === 'steam:owned-never' ? { ...g, lastPlayed: day(1), playCount: 0 } : g
    )
    expect(row(played, remote)).toEqual([
      'steam:played',
      'steam:owned-never',
      'steam:new',
      'steam:old'
    ])
  })

  it('E: shows one game once, dated by the most recent play of any copy', () => {
    const games = [
      game('gog:hades', { source: 'gog', title: 'Hades', lastPlayed: day(2) }),
      owned('steam:hades', { title: 'Hades', lastPlayed: day(8) }),
      game('steam:other', { title: 'Other', lastPlayed: day(5) })
    ]
    const visible = visibleGames(games, settingsOf())
    const cards = recentlyPlayed(visible, { client: true, showHostGames: true, count: 12 })
    // The copy installed here is the card (never greyed), with the later play of the owned copy.
    expect(cards.map((g) => [g.id, g.lastPlayed])).toEqual([
      ['gog:hades', day(8)],
      ['steam:other', day(5)]
    ])
    expect(cards[0]!.installed).toBe(true)
    // No copy installed: the group's own card (the Library's), once.
    const none = [
      owned('gog:hades', { source: 'gog', title: 'Hades', lastPlayed: day(2) }),
      owned('steam:hades', { title: 'Hades', lastPlayed: day(8) })
    ]
    expect(recentlyPlayed(none, { client: true, showHostGames: true, count: 12 })).toMatchObject([
      { id: 'steam:hades', lastPlayed: day(8) }
    ])
  })

  it('E: a copy this PC cannot get does not date the game, and a never-played copy changes nothing', () => {
    const games = [
      game('gog:hades', { source: 'gog', title: 'Hades', lastPlayed: day(2) }),
      leftover('steam:hades', { title: 'Hades', lastPlayed: day(8) }),
      game('steam:other', { title: 'Other', lastPlayed: day(5) }),
      owned('epic:other', { source: 'epic', title: 'Other' })
    ]
    const cards = recentlyPlayed(visibleGames(games, settingsOf()), {
      client: true,
      showHostGames: true,
      count: 12
    })
    expect(cards.map((g) => [g.id, g.lastPlayed])).toEqual([
      ['steam:other', day(5)],
      ['gog:hades', day(2)]
    ])
  })

  it("E: a host's copy of a game this PC plays from its recompilation joins that card", () => {
    const recomp = {
      titleKey: 'xbox360:ssx',
      count: 1,
      installed: ['r1'],
      preferred: 'r1',
      updatedAt: ''
    }
    const mine = game('rom:xbox360:ssx', {
      source: 'rom',
      platformId: 'xbox360',
      title: 'SSX',
      lastPlayed: day(1),
      metadata: { releaseDate: '2012-02-28', recomp }
    })
    const theirs = hostGame('rom:ps3:ssx', {
      source: 'rom',
      platformId: 'ps3',
      title: 'SSX',
      lastPlayed: day(9),
      metadata: { releaseDate: '2012-02-28' }
    })
    const cards = recentlyPlayed([mine, theirs], { client: true, showHostGames: true, count: 12 })
    expect(cards.map((g) => [g.id, g.lastPlayed])).toEqual([['rom:xbox360:ssx', day(9)]])
  })

  it('keeps the settings that hide games meaningful', () => {
    const games = [
      game('steam:here', { lastPlayed: day(1) }),
      owned('steam:owned', { lastPlayed: day(5) }),
      owned('steam:hidden', { lastPlayed: day(6), hidden: true }),
      game('steam:hidden-here', { lastPlayed: day(7), hidden: true }),
      leftover('rom:snes/on-host', { source: 'rom', lastPlayed: day(2) })
    ]
    const remote = remoteOf([hostGame('steam:stream', { lastPlayed: day(8) })], {
      'rom:snes/on-host': [info({ hostGameId: 'rom:snes/on-host' })]
    })
    expect(row(games, remote)).toEqual([
      'remote:h1:steam:stream',
      'steam:owned',
      'rom:snes/on-host',
      'steam:here'
    ])
    // Streaming > show the hosts' games off: no host game, and a host is no way to get a game.
    const noHosts = settingsOf((s) => {
      s.streaming.showHostGames = false
    })
    expect(row(games, remote, noHosts)).toEqual(['steam:owned', 'steam:here'])
    // Library > show uninstalled games off: this PC's uninstalled games go, the hosts' games stay (as in the Library).
    const noUninstalled = settingsOf((s) => {
      s.library.showUninstalled = false
    })
    expect(row(games, remote, noUninstalled)).toEqual([
      'remote:h1:steam:stream',
      'rom:snes/on-host',
      'steam:here'
    ])
    // Show hidden games: they are back, like in the Library.
    const hiddenToo = settingsOf((s) => {
      s.library.showHidden = true
    })
    expect(row(games, remote, hiddenToo).slice(0, 3)).toEqual([
      'remote:h1:steam:stream',
      'steam:hidden-here',
      'steam:hidden'
    ])
  })

  it('limits to count, and the first card is the hero and start game', () => {
    const games = [
      game('steam:a', { lastPlayed: day(1) }),
      owned('steam:b', { lastPlayed: day(2) })
    ]
    expect(row(games, null, settingsOf(), 1)).toEqual(['steam:b'])
    expect(row(games, null, settingsOf(), 0)).toEqual([])
    expect(row([], null)).toEqual([])
  })

  it('on a PC with no host, keeps the row to the installed games, as before', () => {
    const games = [
      game('steam:old', { lastPlayed: day(1) }),
      // A linked store account dates every game it ever saw played, on any PC of that account.
      owned('steam:uninstalled-yesterday', { lastPlayed: day(21) }),
      owned('steam:backlog', { lastPlayed: '2019-03-01T00:00:00.000Z' }),
      game('steam:never', { addedAt: day(9) })
    ]
    expect(row(games, null, settingsOf(), 12, false)).toEqual(['steam:old', 'steam:never'])
    // A host itself (no host of its own) too, whatever a stale remote library says.
    const remote = remoteOf([hostGame('steam:stream', { lastPlayed: day(8) })])
    expect(row(games, remote, settingsOf(), 12, false)).toEqual(['steam:old', 'steam:never'])
    // Paired with a host, the same library lists them.
    expect(row(games, null)).toEqual([
      'steam:uninstalled-yesterday',
      'steam:old',
      'steam:backlog',
      'steam:never'
    ])
    // An installed copy is still dated by its own play only there: the owned copy's later play is not counted.
    const copies = [
      game('gog:hades', { source: 'gog', title: 'Hades', lastPlayed: day(2) }),
      owned('steam:hades', { title: 'Hades', lastPlayed: day(8) })
    ]
    const cards = recentlyPlayed(visibleGames(copies, settingsOf()), {
      client: false,
      showHostGames: true,
      count: 12
    })
    expect(cards.map((g) => [g.id, g.lastPlayed])).toEqual([['gog:hades', day(2)]])
  })

  it('isStreamingClient: paired with at least one host', () => {
    const status = (hosts: number): Parameters<typeof isStreamingClient>[0] => ({
      client: {
        moonlight: { state: 'missing' },
        hosts: Array.from({ length: hosts }, (_, i) => ({
          id: `h${i}`,
          name: 'Host',
          pairedAt: day(1),
          online: false,
          port: 1
        }))
      }
    })
    expect(isStreamingClient(null)).toBe(false)
    expect(isStreamingClient(undefined)).toBe(false)
    expect(isStreamingClient(status(0))).toBe(false)
    expect(isStreamingClient(status(1))).toBe(true)
  })

  it('shows a game once when a host also has the old record its recompilation stands in for', () => {
    const recomp = {
      titleKey: 'xbox360:ssx',
      count: 1,
      installed: ['r1'],
      preferred: 'r1',
      updatedAt: ''
    }
    const rom = (id: string, patch: Partial<Game>): Game =>
      game(id, {
        source: 'rom',
        platformId: 'xbox360',
        title: 'SSX',
        metadata: { recomp },
        ...patch
      })
    const games = [
      rom('rom:xbox360:new', { lastPlayed: day(3) }),
      // Left by a moved file: not installed, playable only through the recompilation the new record has too.
      rom('rom:xbox360:old', { installed: false, lastPlayed: day(5) })
    ]
    // The host has the old record's game: localOnHost puts it back among the visible games.
    const remote = remoteOf([], { 'rom:xbox360:old': [info({ hostGameId: 'rom:xbox360:old' })] })
    expect(row(games, remote)).toEqual(['rom:xbox360:new'])
    expect(row(games, remote, settingsOf(), 12, false)).toEqual(['rom:xbox360:new'])
    expect(row(games, null)).toEqual(['rom:xbox360:new'])
  })
})

describe('homeRowGames (Settings > Library > Front page)', () => {
  const base = {
    client: false,
    alsoOnHost: null,
    showHostGames: true,
    showDuplicates: false,
    count: 12
  }
  const old = game('old', {
    addedAt: '2026-01-01T00:00:00.000Z',
    lastPlayed: '2026-03-01T00:00:00.000Z'
  })
  const mid = game('mid', { addedAt: '2026-02-01T00:00:00.000Z', favorite: true })
  const fresh = game('fresh', { addedAt: '2026-04-01T00:00:00.000Z' })
  const gone = game('gone', {
    installed: false,
    addedAt: '2026-05-01T00:00:00.000Z',
    favorite: true,
    lastPlayed: '2026-04-15T00:00:00.000Z'
  })
  const favOld = game('favOld', {
    addedAt: '2025-12-01T00:00:00.000Z',
    favorite: true,
    lastPlayed: '2026-04-20T00:00:00.000Z'
  })
  const all = [old, mid, fresh, gone, favOld]
  const ids = (mode: 'recent' | 'added' | 'favorites', count = 12): string[] =>
    homeRowGames(all, { ...base, mode, count }).map((g) => g.id)

  it('Recently Played is the row as before', () => {
    expect(ids('recent')).toEqual(recentlyPlayed(all, base).map((g) => g.id))
  })

  it('Recently Added: the games this PC can play, newest added first', () => {
    expect(ids('added')).toEqual(['fresh', 'mid', 'old', 'favOld'])
    expect(ids('added', 2)).toEqual(['fresh', 'mid'])
  })

  it('Favorites: favourite games this PC can play or get, most recently played first', () => {
    expect(ids('favorites')).toEqual(['favOld', 'mid'])
    // An owned store game that is not installed can be got: it is in, greyed as in the Library.
    const owned = { ...gone, owned: true }
    expect(homeRowGames([owned, mid], { ...base, mode: 'favorites' }).map((g) => g.id)).toEqual([
      'gone',
      'mid'
    ])
  })

  it('names the row', () => {
    expect([homeRowTitle('recent'), homeRowTitle('added'), homeRowTitle('favorites')]).toEqual([
      'Recent Games',
      'Recently Added',
      'Favorites'
    ])
  })
})

describe('homeRowGames: Most Played', () => {
  const base = {
    client: false,
    alsoOnHost: null,
    showHostGames: true,
    showDuplicates: false,
    count: 12
  }
  it('most play time first (store time counted), then games never played as in Recently Played', () => {
    const a = game('a', { playtimeMinutes: 30, lastPlayed: '2026-04-01T00:00:00.000Z' })
    const b = game('b', { playtimeMinutes: 10, storePlaytimeMinutes: 600 })
    const c = game('c', { playtimeMinutes: 90, lastPlayed: '2026-01-01T00:00:00.000Z' })
    const d = game('d', { addedAt: '2026-05-01T00:00:00.000Z' })
    const e = game('e', { addedAt: '2026-02-01T00:00:00.000Z' })
    const gone = game('gone', { installed: false, playtimeMinutes: 9000 })
    expect(
      homeRowGames([a, b, c, d, e, gone], { ...base, mode: 'played' }).map((g) => g.id)
    ).toEqual(['b', 'c', 'a', 'd', 'e'])
    expect(homeRowTitle('played')).toBe('Most Played')
  })
})
