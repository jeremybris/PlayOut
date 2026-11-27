import type { Game, RemoteGameInfo, RemoteLibrary, RomDownloadProgress } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { visibleGames } from './library'
import {
  collapseWithRemote,
  collapsedWithRemote,
  downloadRunning,
  findGame,
  hostChipLabel,
  hostOfflineWait,
  hostGamesShown,
  localCopyOfHostGame,
  localOnHost,
  remoteGamesShown,
  remotePrimaryAction,
  remoteSizeText,
  romDownloadProgressView,
  streamActive,
  streamBusy,
  streamBusyLabel,
  streamHosts,
  withRemoteGames
} from './streaming'

function game(id: string, patch: Partial<Game> = {}): Game {
  const title = patch.title ?? id
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId: 'steam',
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

function remoteGame(
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

function library(games: Game[], alsoOnHost: RemoteLibrary['alsoOnHost'] = {}): RemoteLibrary {
  return { games, alsoOnHost, updatedAt: '2026-11-07T00:00:00.000Z' }
}

describe('remoteGamesShown', () => {
  it('is empty while the setting is off or nothing is loaded', () => {
    const lib = library([remoteGame('steam:1')])
    expect(remoteGamesShown(lib, false)).toEqual([])
    expect(remoteGamesShown(null, true)).toEqual([])
  })

  it('keeps host games that are not hidden', () => {
    const a = remoteGame('steam:1')
    const b = remoteGame('steam:2', { hidden: true })
    expect(remoteGamesShown(library([a, b]), true)).toEqual([a])
  })
})

describe('withRemoteGames', () => {
  it('appends host games after the local ones, local ids winning', () => {
    const local = [game('steam:1')]
    const dup = { ...remoteGame('x'), id: 'steam:1' }
    const other = remoteGame('steam:2')
    expect(withRemoteGames(local, [dup, other]).map((g) => g.id)).toEqual([
      'steam:1',
      'remote:h1:steam:2'
    ])
  })

  it('returns the local list itself when there are no host games (memo friendly)', () => {
    const local = [game('a')]
    expect(withRemoteGames(local, [])).toBe(local)
  })
})

describe('collapseWithRemote', () => {
  it('never groups a host game with a local copy of the same title', () => {
    const local = game('gog:1', { source: 'gog', platformId: 'gog', title: 'Hades' })
    const host = remoteGame('steam:1', { title: 'Hades' })
    const groups = collapseWithRemote([host, local])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.game.id).toBe('gog:1')
    expect(groups[1]!.copies).toEqual([host])
  })

  it("folds a host's copy into the card of a game this PC plays from its recompilation (same year only)", () => {
    const recomp = {
      titleKey: 'xbox360:ssx',
      count: 2,
      installed: ['r1'],
      preferred: 'r1',
      updatedAt: ''
    }
    const x360 = game('rom:xbox360:ssx', {
      source: 'rom',
      platformId: 'xbox360',
      title: 'SSX',
      metadata: { releaseDate: '2012-02-28', recomp }
    })
    const ps3 = remoteGame('rom:ps3:ssx', {
      source: 'rom',
      platformId: 'ps3',
      title: 'SSX',
      metadata: { releaseDate: '2012-02-28' }
    })
    const ps2 = remoteGame('rom:ps2:ssx', {
      source: 'rom',
      platformId: 'ps2',
      title: 'SSX',
      metadata: { releaseDate: '2000-10-26' }
    })
    const groups = collapseWithRemote([x360, ps3, ps2])
    // The 2012 game shows once, as this PC's recompilation copy; the 2000 SSX is another game.
    expect(groups.map((g) => [g.game.id, g.copies.length])).toEqual([
      ['rom:xbox360:ssx', 2],
      [ps2.id, 1]
    ])
    // Without an installed recompilation, host games keep their own cards (as before).
    const plain = { ...x360, metadata: { releaseDate: '2012-02-28' } }
    expect(collapseWithRemote([plain, ps3])).toHaveLength(2)
  })

  it("dates a card a host's copy joined by the most recent play of either copy", () => {
    const recomp = {
      titleKey: 'xbox360:ssx',
      count: 1,
      installed: ['r1'],
      preferred: 'r1',
      updatedAt: ''
    }
    const mine = (lastPlayed?: string): Game =>
      game('rom:xbox360:ssx', {
        source: 'rom',
        platformId: 'xbox360',
        title: 'SSX',
        lastPlayed,
        metadata: { releaseDate: '2012-02-28', recomp }
      })
    const theirs = (lastPlayed?: string): Game =>
      remoteGame('rom:ps3:ssx', {
        source: 'rom',
        platformId: 'ps3',
        title: 'SSX',
        lastPlayed,
        metadata: { releaseDate: '2012-02-28' }
      })
    const card = (a: Game, b: Game): Game => collapseWithRemote([a, b])[0]!.game
    // Played later on the host: the card says so, and this PC's record is not touched.
    const here = mine('2026-03-01T00:00:00.000Z')
    expect(card(here, theirs('2026-04-01T00:00:00.000Z'))).toMatchObject({
      id: 'rom:xbox360:ssx',
      lastPlayed: '2026-04-01T00:00:00.000Z'
    })
    expect(here.lastPlayed).toBe('2026-03-01T00:00:00.000Z')
    expect(card(mine(), theirs('2026-04-01T00:00:00.000Z')).lastPlayed).toBe(
      '2026-04-01T00:00:00.000Z'
    )
    // Played later here, or never on the host: this PC's own date (the same object: nothing to merge).
    expect(card(here, theirs('2026-02-01T00:00:00.000Z'))).toBe(here)
    expect(card(here, theirs())).toBe(here)
  })

  it('still groups local copies', () => {
    const steam = game('steam:1', { title: 'Hades' })
    const gog = game('gog:1', { source: 'gog', platformId: 'gog', title: 'Hades' })
    const { games, copies } = collapsedWithRemote([steam, gog, remoteGame('steam:9')])
    expect(games).toHaveLength(2)
    expect([...copies.values()]).toEqual([2])
  })
})

describe('findGame', () => {
  it('looks in the local games first, then the host-only ones', () => {
    const local = game('steam:1')
    const host = remoteGame('steam:2')
    const byId = new Map([[local.id, local]])
    expect(findGame('steam:1', byId, library([host]))).toBe(local)
    expect(findGame(host.id, byId, library([host]))).toBe(host)
    expect(findGame('nope', byId, null)).toBeUndefined()
  })
})

describe('remotePrimaryAction', () => {
  it('streams PC games and downloads ROMs', () => {
    expect(remotePrimaryAction(remoteGame('steam:1'))).toBe('stream')
    expect(
      remotePrimaryAction(
        remoteGame('rom:snes:x', { source: 'rom', platformId: 'snes' }, { downloadable: true })
      )
    ).toBe('download')
  })

  it('streams a ROM the host does not offer for download, null for local games', () => {
    expect(remotePrimaryAction(remoteGame('rom:snes:x', { source: 'rom' }))).toBe('stream')
    expect(
      remotePrimaryAction(remoteGame('steam:1', {}, { streamable: false, downloadable: false }))
    ).toBeNull()
    expect(remotePrimaryAction(game('steam:1'))).toBeNull()
  })
})

describe('streamHosts', () => {
  it("is a host game's own host", () => {
    const host = remoteGame('steam:1')
    expect(streamHosts(host, {})).toEqual([host.remote])
  })

  it('lists every host of a host game found on several hosts', () => {
    const host = remoteGame('steam:1')
    const a = info({ hostId: 'h1' })
    const b = info({ hostId: 'h2' })
    const c = info({ hostId: 'h3', streamable: false })
    expect(streamHosts(host, { [host.id]: [a, b, c] })).toEqual([a, b])
  })

  it('lists every streamable host for a local game', () => {
    const a = info({ hostId: 'a' })
    const b = info({ hostId: 'b', streamable: false })
    expect(streamHosts(game('steam:1'), { 'steam:1': [a, b] })).toEqual([a])
    expect(streamHosts(game('steam:2'), { 'steam:1': [a] })).toEqual([])
    expect(streamHosts(game('steam:2'), null)).toEqual([])
  })
})

describe('stream session states', () => {
  it('is busy while preparing, pairing or connecting', () => {
    expect(streamBusy({ state: 'preparing' })).toBe(true)
    expect(streamBusy({ state: 'pairing' })).toBe(true)
    expect(streamBusy({ state: 'connecting' })).toBe(true)
    expect(streamBusy({ state: 'streaming' })).toBe(false)
    expect(streamBusy(null)).toBe(false)
    expect(streamActive({ state: 'streaming' })).toBe(true)
    expect(streamActive({ state: 'ended' })).toBe(false)
  })

  it('labels the busy states', () => {
    expect(streamBusyLabel({ state: 'pairing', hostName: 'X' })).toBe('Pairing…')
    expect(streamBusyLabel({ state: 'preparing', hostName: 'Den' })).toBe('Starting on Den…')
    expect(streamBusyLabel({ state: 'connecting', hostName: 'Den' })).toBe('Connecting…')
    // The first stream downloads Moonlight while it prepares.
    expect(
      streamBusyLabel(
        { state: 'preparing', hostName: 'Den' },
        { state: 'downloading', percent: 41.6 }
      )
    ).toBe('Downloading Moonlight… 42%')
    expect(streamBusyLabel({ state: 'preparing', hostName: 'Den' }, { state: 'downloading' })).toBe(
      'Downloading Moonlight…'
    )
    expect(streamBusyLabel({ state: 'preparing', hostName: 'Den' }, { state: 'installed' })).toBe(
      'Starting on Den…'
    )
  })
})

describe('hostOfflineWait', () => {
  const base: Pick<RomDownloadProgress, 'state' | 'message' | 'hostOffline'> = {
    state: 'failed',
    message: 'Waiting for Living Room PC to come back online',
    hostOffline: true
  }
  it("reads main's host-offline message off a failed download only", () => {
    expect(hostOfflineWait(base)).toBe('Waiting for Living Room PC to come back online')
    // The flag decides, not the words (they are translated).
    expect(
      hostOfflineWait({
        ...base,
        message: 'Esperando a que Living Room PC vuelva a estar en línea'
      })
    ).toBe('Esperando a que Living Room PC vuelva a estar en línea')
    expect(hostOfflineWait({ ...base, hostOffline: undefined })).toBeUndefined()
    expect(hostOfflineWait({ ...base, state: 'downloading' })).toBeUndefined()
    expect(hostOfflineWait({ state: 'failed', message: 'The host lists no files' })).toBeUndefined()
    expect(hostOfflineWait({ state: 'failed' })).toBeUndefined()
    expect(hostOfflineWait(null)).toBeUndefined()
  })
})

describe('romDownloadProgressView', () => {
  const base: RomDownloadProgress = {
    gameId: 'remote:h1:rom:snes:x',
    hostId: 'h1',
    state: 'downloading',
    bytesDone: 50,
    bytesTotal: 200,
    percent: 25
  }

  it('maps a running download with known size', () => {
    expect(romDownloadProgressView(base)).toEqual({
      state: 'downloading',
      percent: 25,
      bytesDone: 50,
      bytesTotal: 200,
      message: 'Downloading…'
    })
    expect(downloadRunning(base)).toBe(true)
  })

  it('is indeterminate while the size is unknown, and maps the end states', () => {
    const view = romDownloadProgressView({ ...base, bytesTotal: 0, percent: 0 })
    expect(view.percent).toBeUndefined()
    expect(romDownloadProgressView({ ...base, state: 'done' }).state).toBe('done')
    expect(romDownloadProgressView({ ...base, state: 'cancelled' }).state).toBe('failed')
    expect(downloadRunning({ ...base, state: 'failed' })).toBe(false)
    expect(downloadRunning(undefined)).toBe(false)
  })

  it('reads a paused download as waiting ("Paused"), keeping what it reached, and not running', () => {
    expect(romDownloadProgressView({ ...base, state: 'paused' })).toEqual({
      state: 'queued',
      percent: 25,
      bytesDone: 50,
      bytesTotal: 200,
      message: 'Paused'
    })
    expect(downloadRunning({ ...base, state: 'paused' })).toBe(false)
  })
})

describe('hostChipLabel', () => {
  it('names the host', () => {
    expect(hostChipLabel(info())).toBe('On Living Room PC')
  })
})

describe('remoteSizeText', () => {
  it("is a downloadable ROM's set size", () => {
    const rom = remoteGame(
      'rom:snes:x',
      { source: 'rom' },
      { downloadable: true, sizeBytes: 4 * 1024 ** 2 }
    )
    expect(remoteSizeText(rom)).toEqual({ label: 'Download size', value: '4 MB', estimate: false })
  })

  it('is null for streamed and local games', () => {
    expect(remoteSizeText(remoteGame('steam:1', {}, { sizeBytes: 100 }))).toBeNull()
    expect(remoteSizeText(game('steam:1'))).toBeNull()
  })
})

describe('localOnHost / hostGamesShown', () => {
  it("keeps this PC's uninstalled copy of a game a host streams, so it never vanishes", () => {
    const owned = game('steam:1', { installed: false })
    const hidden = game('steam:2', { installed: false, hidden: true })
    const notStreamable = game('steam:3', { installed: false })
    const installed = game('steam:4')
    const onlyThere = remoteGame('steam:9')
    const lib = library([onlyThere], {
      'steam:1': [info()],
      'steam:2': [info({ hostGameId: 'steam:2' })],
      'steam:3': [info({ hostGameId: 'steam:3', streamable: false })],
      'steam:4': [info({ hostGameId: 'steam:4' })]
    })
    const games = [owned, hidden, notStreamable, installed]
    expect(localOnHost(games, lib, true)).toEqual([owned])
    expect(localOnHost(games, lib, false)).toEqual([])
    expect(hostGamesShown(games, lib, true).map((g) => g.id)).toEqual([
      'steam:1',
      'remote:h1:steam:9'
    ])
    // With showUninstalled off visibleGames keeps only steam:4; the streamable copy still shows, once.
    expect(withRemoteGames([installed], hostGamesShown(games, lib, true)).map((g) => g.id)).toEqual(
      ['steam:4', 'steam:1', 'remote:h1:steam:9']
    )
    expect(
      withRemoteGames([installed, owned], hostGamesShown(games, lib, true)).map((g) => g.id)
    ).toEqual(['steam:4', 'steam:1', 'remote:h1:steam:9'])
  })

  it('does not bring back an old record its recompilation stands in for, beside the copy on this PC', () => {
    // The user's library: SSX (2012) scanned twice on Xbox 360. The old record's game folder is gone and its
    // recompilation plays in its place; the disc image found later is the copy on this PC. The host has the game too.
    const recomp = {
      titleKey: 'xbox360:ssx',
      count: 3,
      installed: ['github:amarillonl/ssx-recomp'],
      preferred: 'github:amarillonl/ssx-recomp',
      updatedAt: '2026-11-19T22:07:50.443Z'
    }
    const rom = (id: string, patch: Partial<Game>): Game =>
      game(id, {
        source: 'rom',
        platformId: 'xbox360',
        title: 'SSX',
        metadata: { releaseDate: '2012-02-28', recomp },
        ...patch
      })
    const old = rom('rom:xbox360:old', { installed: false })
    const image = rom('rom:xbox360:image', { installed: true })
    const lib = library([], {
      'rom:xbox360:old': [info({ hostGameId: 'rom:xbox360:image' })],
      'rom:xbox360:image': [info({ hostGameId: 'rom:xbox360:image' })]
    })
    const games = [old, image]
    // visibleGames leaves the old record out; the host having the game must not add it again.
    expect(visibleGames(games, null).map((g) => g.id)).toEqual(['rom:xbox360:image'])
    expect(localOnHost(games, lib, true)).toEqual([])
    const pool = withRemoteGames(visibleGames(games, null), hostGamesShown(games, lib, true))
    expect(pool.map((g) => g.id)).toEqual(['rom:xbox360:image'])
    expect(collapseWithRemote(pool).map((g) => g.game.id)).toEqual(['rom:xbox360:image'])
    // Without the copy on this PC the old record is the game: it stays, playable through its recompilation.
    expect(localOnHost([old], lib, true)).toEqual([old])
  })
})

describe('localCopyOfHostGame', () => {
  const info = (hostId: string, hostGameId: string): { hostId: string; hostGameId: string } => ({
    hostId,
    hostGameId
  })

  it('finds the game this PC got from a host by the host game it came from', () => {
    const alsoOnHost = {
      'rom:ps2:abc': [info('h1', 'rom:ps2:ssx3')],
      'steam:620': [info('h1', 'steam:620'), info('h2', 'steam:620')]
    }
    expect(localCopyOfHostGame('remote:h1:rom:ps2:ssx3', alsoOnHost)).toBe('rom:ps2:abc')
    expect(localCopyOfHostGame('remote:h2:steam:620', alsoOnHost)).toBe('steam:620')
    // Another host's copy of that game, another game, or not a host game: none.
    expect(localCopyOfHostGame('remote:h2:rom:ps2:ssx3', alsoOnHost)).toBeUndefined()
    expect(localCopyOfHostGame('remote:h1:rom:ps2:other', alsoOnHost)).toBeUndefined()
    expect(localCopyOfHostGame('rom:ps2:abc', alsoOnHost)).toBeUndefined()
    expect(localCopyOfHostGame('remote:h1:rom:ps2:ssx3', undefined)).toBeUndefined()
  })

  it('takes only a game in the library when asked to', () => {
    const alsoOnHost = { 'rom:ps2:gone': [info('h1', 'g')], 'rom:ps2:here': [info('h1', 'g')] }
    expect(localCopyOfHostGame('remote:h1:g', alsoOnHost, (id) => id === 'rom:ps2:here')).toBe(
      'rom:ps2:here'
    )
  })
})
