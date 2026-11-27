// Streaming in the mock (docs/ARCHITECTURE.md §4.13): this PC as a host (Sunshine download, port forwarding, PIN,
// one paired laptop) and as a client paired with "Living Room PC", whose games include a host-only Steam game, a
// host-only SNES ROM and Hades (which this PC has too). Pairing accepts the PIN 1234; a stream walks through
// preparing -> connecting -> streaming -> ended; a ROM download ticks to done and adds the game to the library.
import { recompOnlyKey } from '@shared/recomp-play'
import type { PlayOutApi } from '@shared/api'
import {
  METADATA_EDIT_FIELDS,
  effectiveGame,
  metadataLayers,
  withMetadataEdit,
  type MetadataEdit,
  type MetadataEditField,
  type MetadataLayers
} from '@shared/metadata-edit'
import type {
  GameRecompInfo,
  DiscoveredHost,
  Game,
  GameMetadata,
  GameMedia,
  PairedComputer,
  PairedHost,
  PlaySession,
  RemoteGameInfo,
  RemoteLibrary,
  RomDownloadProgress,
  Settings,
  StreamSession,
  StreamingHostStatus,
  StreamingStatus,
  StreamingToolStatus
} from '@shared/types'
import { steamArt } from './art'
import { ROMS_ROOT, daysAgo, sortTitle } from './data'
import type { MockEmitter } from './emitter'

export type StreamingApi = Pick<
  PlayOutApi,
  | 'getStreamingStatus'
  | 'startStreamingPairing'
  | 'cancelStreamingPairing'
  | 'removeStreamingClient'
  | 'findStreamingHosts'
  | 'firstStartHosts'
  | 'pairStreamingHost'
  | 'removeStreamingHost'
  | 'setStreamingHostAddress'
  | 'getRemoteLibrary'
  | 'refreshRemoteLibrary'
  | 'streamGame'
  | 'stopStream'
  | 'setRemoteFavorite'
  | 'downloadRemoteRom'
  | 'cancelRemoteRomDownload'
>

export interface StreamingMock {
  api: StreamingApi
  /** The mock's updateSettings calls this, as the real service follows `settings.streaming.hostEnabled`. */
  settingsChanged: (next: Settings) => void
  /**
   * ROM downloads for the mock's install queue (index.ts), as main's queue drives the streaming service: `check`
   * throws what downloadRemoteRom refuses with and names the game and its host; `start` begins one (false when its
   * host is gone; one paused earlier continues where it stopped); `cancel` stops one. Every end (done, failed,
   * cancelled) calls deps.downloadEnded. `pause` stops one keeping what it has (a 'paused' event, no
   * downloadEnded: the queue holds it); `discard` drops what a paused one kept (a 'cancelled' event), as main deletes
   * its .part files when the game leaves the queue.
   */
  /**
   * The Edit sheet for host-only games (`remote:` ids), as main's remote edits (main/metadata-edits/remote-edits.ts):
   * the host's metadata is the scraped layer, the user's edit is kept here by the host's game id and goes with a
   * downloaded ROM. Each returns null for an id that is not a host-only game.
   */
  metadata: {
    layers: (gameId: string) => MetadataLayers | null
    set: (gameId: string, edit: MetadataEdit, clear?: MetadataEditField[]) => Game | null
    clear: (gameId: string, fields?: MetadataEditField[]) => Game | null
  }
  rom: {
    check: (gameId: string) => { title: string; hostName: string }
    start: (gameId: string) => boolean
    cancel: (gameId: string) => void
    pause: (gameId: string) => void
    discard: (gameId: string) => void
  }
}

export interface StreamingMockDeps {
  emitter: MockEmitter
  /** ?firststart=1: firstStartHosts offers the network's hosts. */
  firstStart?: boolean
  /** A host-only game's recompilations, matched with this PC's catalog (mock recomp); null/undefined = none. */
  recompFor?: (game: Game) => GameRecompInfo | null | undefined
  settings: () => Settings
  /** This PC's games (the ROM download adds to it; Hades decides the "on both PCs" example). */
  games: Map<string, Game>
  /** Put a downloaded ROM game into the library (registers its platform, emits library:changed). */
  addGame: (game: Game) => void
  /** A ROM download stopped (done, failed or cancelled): the install queue starts the next game. */
  downloadEnded?: (gameId: string) => void
  /** A host was unpaired: its ROM downloads waiting in the install queue leave it (as main drops them). */
  hostRemoved?: (hostId: string) => void
  /**
   * The play time sync (main/streaming/playtime-sync.ts): a host's play sessions of games both PCs have, for this PC
   * to keep and count (each once, by id).
   */
  takeSessions?: (hostId: string, sessions: PlaySession[]) => void
  /** `screen=empty`: nothing paired. */
  empty: boolean
  /** `screen=settings-streaming`: the host is on and shows a PIN, so the capture has every part of the tab. */
  showcase: boolean
}

/** The PIN the mock's hosts accept. */
export const MOCK_STREAMING_PIN = '1234'
export const MOCK_HOST_ID = 'host-living-room'
/** A ROM download takes this long in the mock. */
export const ROM_DOWNLOAD_MS = 4_000
const TICK_MS = 250
const PIN_TTL_MS = 5 * 60_000
/** A mock stream ends by itself after this long (the "game" was closed on the host). */
export const STREAM_MS = 20_000
const SUNSHINE_VERSION = 'v2026.914.233613'
const MOONLIGHT_VERSION = 'v6.2.0'
const EXTERNAL_IP = '203.0.113.42'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const clone = <T>(value: T): T => structuredClone(value)
const now = (): string => new Date().toISOString()

interface MockHost {
  host: PairedHost
  games: Game[]
}

function hostGame(
  base: Omit<
    Game,
    | 'sortTitle'
    | 'hidden'
    | 'favorite'
    | 'playtimeMinutes'
    | 'playCount'
    | 'metadataStatus'
    | 'user'
  >,
  sizeBytes?: number
): { game: Game; sizeBytes?: number } {
  return {
    game: {
      ...base,
      sortTitle: sortTitle(base.title),
      hidden: false,
      favorite: false,
      playtimeMinutes: 0,
      playCount: 0,
      metadataStatus: 'done',
      user: {}
    },
    sizeBytes
  }
}

function meta(m: GameMetadata): GameMetadata {
  return { ...m, updatedAt: daysAgo(3) }
}

const MEGA_MAN_X_PATH = 'snes/Mega Man X (USA).sfc'
const MEGA_MAN_X_ID = 'rom:snes:TuI_4tTC6WjTPMtp'
const MEGA_MAN_X_BYTES = 1_572_864

/** What Living Room PC offers (as its own games; the client side turns them into `remote:` games). */
function livingRoomGames(): { game: Game; sizeBytes?: number }[] {
  return [
    hostGame({
      id: 'steam:1145350',
      source: 'steam',
      externalId: '1145350',
      platformId: 'steam',
      title: 'Hades II',
      installed: true,
      launch: { kind: 'uri', uri: '' },
      tracking: { mode: 'none' },
      addedAt: daysAgo(20),
      metadata: meta({
        description:
          'Battle beyond the Underworld as Melinoë, the immortal Princess of the Underworld, using dark sorcery to take on the Titan of Time.',
        shortDescription: 'The sequel to the god-like rogue-like dungeon crawler.',
        releaseDate: '2025-09-25',
        developers: ['Supergiant Games'],
        publishers: ['Supergiant Games'],
        genres: ['Action', 'Roguelike', 'RPG'],
        rating: 95,
        players: '1',
        // The host's own counts (its Steam account): the client shows them and asks the host for the list.
        achievements: { unlocked: 23, total: 49, updatedAt: daysAgo(1) }
      }),
      media: steamArt(1145350)
    }),
    hostGame({
      id: 'steam:1145360',
      source: 'steam',
      externalId: '1145360',
      platformId: 'steam',
      title: 'Hades',
      installed: true,
      launch: { kind: 'uri', uri: '' },
      tracking: { mode: 'none' },
      addedAt: daysAgo(200),
      metadata: meta({ releaseDate: '2020-09-17', genres: ['Action', 'Roguelike', 'RPG'] }),
      media: steamArt(1145360)
    }),
    hostGame(
      {
        id: MEGA_MAN_X_ID,
        source: 'rom',
        externalId: MEGA_MAN_X_PATH,
        platformId: 'snes',
        title: 'Mega Man X',
        installed: true,
        launch: { kind: 'uri', uri: '' },
        tracking: { mode: 'none' },
        addedAt: daysAgo(60),
        metadata: meta({
          description:
            'X, a new kind of robot built by Dr. Light, takes on Sigma and his Mavericks in 2114. Wall-jumps, dashes and armour upgrades hidden across eight stages.',
          shortDescription: "Capcom's 16-bit reinvention of Mega Man.",
          releaseDate: '1993-12-17',
          developers: ['Capcom'],
          publishers: ['Capcom'],
          genres: ['Action', 'Platformer'],
          rating: 90,
          players: '1',
          achievements: { unlocked: 12, total: 40, updatedAt: daysAgo(2) }
        }),
        // Art of the Steam collection that contains it: the mock has no ScreenScraper media.
        media: steamArt(743890)
      },
      MEGA_MAN_X_BYTES
    ),
    // A host-only ROM with recompilations (Filters > Recompilations lists it, ready to download).
    hostGame(
      {
        id: 'rom:genesis:Sn1cH0stOnly00001',
        source: 'rom',
        externalId: 'genesis/Sonic the Hedgehog (USA, Europe).md',
        platformId: 'genesis',
        title: 'Sonic the Hedgehog',
        installed: true,
        launch: { kind: 'uri', uri: '' },
        tracking: { mode: 'none' },
        addedAt: daysAgo(90),
        metadata: meta({ releaseDate: '1991-06-23', genres: ['Platformer'], players: '1' }),
        media: steamArt(71113)
      },
      524_288
    )
  ]
}

function officeGames(): { game: Game; sizeBytes?: number }[] {
  return [
    hostGame({
      id: 'steam:1794680',
      source: 'steam',
      externalId: '1794680',
      platformId: 'steam',
      title: 'Vampire Survivors',
      installed: true,
      launch: { kind: 'uri', uri: '' },
      tracking: { mode: 'none' },
      addedAt: daysAgo(10),
      metadata: meta({
        releaseDate: '2022-10-20',
        genres: ['Action', 'Roguelike'],
        players: '1-4'
      }),
      media: steamArt(1794680)
    })
  ]
}

/** Hosts "Find computers on this network" finds. */
const NETWORK: {
  id: string
  name: string
  address: string
  games: () => { game: Game; sizeBytes?: number }[]
}[] = [
  { id: MOCK_HOST_ID, name: 'Living Room PC', address: '192.168.1.20', games: livingRoomGames },
  { id: 'host-office', name: 'Office PC', address: '192.168.1.40', games: officeGames }
]

export function createStreamingMock(deps: StreamingMockDeps): StreamingMock {
  const { emitter } = deps
  const hostEnabled = (): boolean => deps.settings().streaming.hostEnabled

  // --- this PC as host -----------------------------------------------------------
  let sunshine: StreamingToolStatus = hostEnabled()
    ? { state: 'running', version: SUNSHINE_VERSION }
    : { state: 'missing' }
  let hostState: StreamingHostStatus['state'] = hostEnabled() ? 'ready' : 'off'
  let portForwarding: StreamingHostStatus['portForwarding'] = hostEnabled()
    ? { state: 'mapped', externalIp: EXTERNAL_IP }
    : { state: 'off' }
  let pairing: StreamingHostStatus['pairing'] = null
  let pairingTimer: ReturnType<typeof setTimeout> | null = null
  const clients: PairedComputer[] = deps.empty
    ? []
    : [
        {
          id: 'client-laptop',
          name: 'Bedroom Laptop',
          pairedAt: daysAgo(12),
          lastSeen: daysAgo(1),
          address: '192.168.1.31'
        }
      ]
  let hostRun = 0

  // --- this PC as client -----------------------------------------------------------
  const hosts = new Map<string, MockHost>()
  const sizes = new Map<string, number>()
  const addHost = (entry: (typeof NETWORK)[number], pairedAt: string): MockHost => {
    const offered = entry.games()
    for (const o of offered)
      if (o.sizeBytes !== undefined) sizes.set(`${entry.id}:${o.game.id}`, o.sizeBytes)
    const mock: MockHost = {
      host: {
        id: entry.id,
        name: entry.name,
        pairedAt,
        lastSeen: now(),
        address: entry.address,
        online: true,
        lanAddress: entry.address,
        wanAddress: entry.id === MOCK_HOST_ID ? '198.51.100.7' : undefined,
        port: deps.settings().streaming.hostPort,
        games: offered.length,
        emulationSync: {
          state: 'synced',
          lastSync: new Date(Date.now() - 4 * 60_000).toISOString(),
          last: { downloaded: 3, uploaded: 1, deleted: 0, conflicts: 1, failed: 0 }
        }
      },
      games: offered.map((o) => o.game)
    }
    hosts.set(entry.id, mock)
    return mock
  }
  if (!deps.empty) addHost(NETWORK[0], daysAgo(30))
  let remoteUpdatedAt = now()

  let session: StreamSession | null = null
  let sessionTimer: ReturnType<typeof setTimeout> | null = null
  // Bumped by every start and stop: a streamGame still waiting on a sleep sees it changed and goes no further, so a
  // stream stopped while preparing or connecting stays stopped.
  let streamRun = 0
  const downloads = new Map<
    string,
    { progress: RomDownloadProgress; timer: ReturnType<typeof setTimeout> | null }
  >()
  /** Paused ROM downloads (what they reached, like main's .part files), by game id. */
  const pausedDownloads = new Map<string, RomDownloadProgress>()

  const hostStatus = (): StreamingHostStatus => ({
    enabled: hostEnabled(),
    state: hostState,
    listening: hostState !== 'off',
    sunshine: clone(sunshine),
    portForwarding: clone(portForwarding),
    lanAddresses: ['192.168.1.24'],
    port: deps.settings().streaming.hostPort,
    pairing: clone(pairing),
    clients: clone(clients),
    controllerDriver: false,
    streaming: null
  })
  const status = (): StreamingStatus => ({
    host: hostStatus(),
    client: {
      moonlight: { state: 'installed', version: MOONLIGHT_VERSION },
      hosts: [...hosts.values()].map((h) => clone(h.host))
    }
  })
  const emitStatus = (): void => emitter.emit('streaming:status', status())

  const info = (h: MockHost, game: Game): RemoteGameInfo => {
    const rom = game.source === 'rom'
    const sizeBytes = sizes.get(`${h.host.id}:${game.id}`)
    return {
      hostId: h.host.id,
      hostName: h.host.name,
      hostGameId: game.id,
      streamable: true,
      downloadable: rom,
      ...(sizeBytes !== undefined ? { sizeBytes } : {})
    }
  }

  /** The user's edits of host-only games, by the host's game id (main keys them by the cloud key). */
  const remoteEdits = new Map<string, MetadataEdit>()
  /** A host game with the user's edit as its user data (the host's title override is its title here). */
  const withRemoteEdit = (game: Game, hostGameId: string): Game => {
    const title = game.user?.titleOverride?.trim()
    const base: Game = { ...game, ...(title ? { title } : {}), user: {} }
    const edit = remoteEdits.get(hostGameId)
    return edit ? { ...base, user: withMetadataEdit({}, edit) } : base
  }

  /** Same shape main's buildRemoteLibrary returns; matching is by id only here (the real one also matches titles). */
  const remoteLibrary = (): RemoteLibrary => {
    const games: Game[] = []
    const alsoOnHost: Record<string, RemoteGameInfo[]> = {}
    const byHostGame = new Map<string, Game>()
    const ordered = [...hosts.values()]
      .filter((h) => h.host.online)
      .sort((a, b) => a.host.name.localeCompare(b.host.name))
    for (const h of ordered) {
      for (const game of h.games) {
        const remote = info(h, game)
        if (deps.games.has(game.id)) {
          ;(alsoOnHost[game.id] ??= []).push(remote)
          continue
        }
        if (byHostGame.has(game.id)) continue
        const media: GameMedia = clone(game.media)
        const recomp = deps.recompFor?.(game)
        const copy: Game = {
          ...clone(game),
          // This PC's match, like the real app (main/streaming rebuild()).
          metadata: recomp ? { ...clone(game.metadata), recomp } : clone(game.metadata),
          id: `remote:${h.host.id}:${game.id}`,
          // The host's favourite, shown while the favourites sync is on (main's rebuild()).
          favorite: deps.settings().streaming.syncFavorites && game.favorite,
          // When the host last played it, shown while the play time sync is on (main's rebuild()).
          lastPlayed: deps.settings().streaming.syncPlaytime ? game.lastPlayed : undefined,
          installed: false,
          owned: false,
          remote,
          // The real ids point at media://remote/...; the browser mock keeps the CDN art so cards have pictures.
          media
        }
        // The user's own edit over the host's metadata, as main's LibraryService.viewRemote.
        const shown = effectiveGame(withRemoteEdit(copy, game.id))
        byHostGame.set(game.id, shown)
        games.push(shown)
      }
    }
    // A recompilation-only card's original on a host, matched by recompilation title (main's rebuild()).
    const recompSources: Record<string, RemoteGameInfo[]> = {}
    const cards = [...deps.games.values()].filter((g) => recompOnlyKey(g))
    if (cards.length && deps.recompFor)
      for (const h of ordered)
        for (const game of h.games) {
          if (game.source !== 'rom') continue
          const key = deps.recompFor(game)?.titleKey
          const card = key ? cards.find((c) => recompOnlyKey(c) === key) : undefined
          if (card) (recompSources[card.id] ??= []).push(info(h, game))
        }
    return {
      games,
      alsoOnHost,
      ...(Object.keys(recompSources).length ? { recompSources } : {}),
      updatedAt: remoteUpdatedAt
    }
  }
  const emitLibrary = (): void => emitter.emit('streaming:library', remoteLibrary())
  // A recompilation-only card made or merged: its original on the hosts is matched again (main rebuilds on every
  // library change).
  emitter.on('library:changed', (change) => {
    if (change.reason === 'scan' || change.reason === 'remove') emitLibrary()
  })

  const findRemote = (gameId: string, hostId?: string): { host: MockHost; game: Game } | null => {
    const match = /^remote:([^:]+):(.+)$/.exec(gameId)
    const wantedHost = match ? match[1] : hostId
    const hostGameId = match ? match[2] : gameId
    for (const h of hosts.values()) {
      if (wantedHost && h.host.id !== wantedHost) continue
      const game = h.games.find((g) => g.id === hostGameId)
      if (game) return { host: h, game }
    }
    return null
  }

  // --- host on/off ---------------------------------------------------------------
  async function startHost(): Promise<void> {
    const run = ++hostRun
    hostState = 'starting'
    if (sunshine.state === 'missing' || sunshine.state === 'error') {
      for (let percent = 0; percent < 100; percent += 20) {
        sunshine = { state: 'downloading', percent }
        emitStatus()
        await sleep(300)
        if (run !== hostRun) return
      }
    }
    sunshine = { state: 'running', version: SUNSHINE_VERSION }
    hostState = 'ready'
    portForwarding = { state: 'checking' }
    emitStatus()
    await sleep(900)
    if (run !== hostRun) return
    portForwarding = { state: 'mapped', externalIp: EXTERNAL_IP }
    emitStatus()
  }

  function stopHost(): void {
    hostRun++
    hostState = 'off'
    if (sunshine.state === 'running' || sunshine.state === 'downloading')
      sunshine =
        sunshine.state === 'running'
          ? { state: 'installed', version: SUNSHINE_VERSION }
          : { state: 'missing' }
    portForwarding = { state: 'off' }
    clearPairing()
    emitStatus()
  }

  function clearPairing(): void {
    if (pairingTimer) clearTimeout(pairingTimer)
    pairingTimer = null
    pairing = null
  }

  function openPairing(): void {
    clearPairing()
    const pin = String(Math.floor(Math.random() * 10_000)).padStart(4, '0')
    pairing = { pin, expiresAt: new Date(Date.now() + PIN_TTL_MS).toISOString() }
    pairingTimer = setTimeout(() => {
      pairingTimer = null
      pairing = null
      emitStatus()
    }, PIN_TTL_MS)
  }

  let lastHostEnabled = hostEnabled()
  if (deps.showcase && lastHostEnabled) openPairing()

  // --- streams and downloads ----------------------------------------------------------
  const emitSession = (next: StreamSession): void => {
    session = next
    emitter.emit('streaming:session', clone(next))
  }

  function endStream(message?: string): void {
    streamRun++
    if (sessionTimer) clearTimeout(sessionTimer)
    sessionTimer = null
    if (!session || session.state === 'ended' || session.state === 'error') return
    emitSession({ ...session, state: 'ended', message })
  }

  const emitDownload = (progress: RomDownloadProgress): void =>
    emitter.emit('streaming:download', clone(progress))

  function tickDownload(gameId: string): void {
    const tracked = downloads.get(gameId)
    if (!tracked) return
    tracked.timer = null
    const { progress } = tracked
    const step = (progress.bytesTotal * TICK_MS) / ROM_DOWNLOAD_MS
    const bytesDone = Math.min(progress.bytesTotal, progress.bytesDone + step)
    if (bytesDone < progress.bytesTotal) {
      tracked.progress = {
        ...progress,
        bytesDone: Math.round(bytesDone),
        percent: Math.floor((bytesDone / progress.bytesTotal) * 100)
      }
      emitDownload(tracked.progress)
      tracked.timer = setTimeout(() => tickDownload(gameId), TICK_MS)
      return
    }
    finishDownload(gameId)
  }

  function finishDownload(gameId: string): void {
    const tracked = downloads.get(gameId)
    const found = findRemote(gameId)
    downloads.delete(gameId)
    if (!tracked) return
    if (!found) {
      emitDownload({
        ...tracked.progress,
        state: 'failed',
        message: 'The host is no longer paired'
      })
      deps.downloadEnded?.(gameId)
      return
    }
    const romPath = `${ROMS_ROOT}\\${found.game.externalId.replace(/\//g, '\\')}`
    const carried = remoteEdits.get(found.game.id)
    // The host's achievement counts are its account's: this PC reads its own (main never copies them).
    const ownMetadata = clone(found.game.metadata)
    delete ownMetadata.achievements
    const local: Game = {
      ...clone(found.game),
      metadata: ownMetadata,
      // The user's edit of the host's copy goes with it, as main's adoptRemoteMetadataEdit.
      ...(carried ? { user: withMetadataEdit(clone(found.game.user ?? {}), carried) } : {}),
      installed: true,
      romPath,
      launch: { kind: 'emulator', systemId: found.game.platformId, romPath },
      tracking: { mode: 'spawned' },
      addedAt: now()
    }
    // The real client rescans the ROM folder, which finds the game under the same id the host gave it.
    deps.addGame(local)
    emitDownload({
      ...tracked.progress,
      state: 'done',
      bytesDone: tracked.progress.bytesTotal,
      percent: 100,
      message: `${local.title} is in your library`,
      installedGameId: local.id
    })
    emitLibrary()
    deps.downloadEnded?.(gameId)
  }

  /** As main checks a ROM download before queueing it: a ROM game of a paired host, with a ROM folder set. */
  function checkDownload(gameId: string): { title: string; hostName: string } {
    const found = findRemote(gameId)
    if (!found || found.game.source !== 'rom') throw new Error('Only ROM games can be downloaded.')
    // As main: a ROM download needs the ROM folder (the renderer opens Settings > Library before asking).
    if (!deps.settings().library.romsRoot)
      throw new Error('Choose your Emulation folder in Settings > Library first')
    return {
      title: found.game.user.titleOverride || found.game.title,
      hostName: found.host.host.name
    }
  }

  /** Start a checked ROM download now; false when it cannot (its host went away meanwhile). */
  function startDownload(gameId: string): boolean {
    const found = findRemote(gameId)
    if (!found || found.game.source !== 'rom') return false
    if (downloads.has(gameId)) return true
    const bytesTotal = sizes.get(`${found.host.host.id}:${found.game.id}`) ?? 4 * 1024 * 1024
    // A paused download continues from what it had (main resumes from the .part with a Range request).
    const kept = pausedDownloads.get(gameId)
    pausedDownloads.delete(gameId)
    const bytesDone = kept && kept.bytesTotal === bytesTotal ? kept.bytesDone : 0
    const progress: RomDownloadProgress = {
      gameId,
      hostId: found.host.host.id,
      state: 'downloading',
      bytesDone,
      bytesTotal,
      percent: Math.floor((bytesDone / bytesTotal) * 100)
    }
    downloads.set(gameId, { progress, timer: setTimeout(() => tickDownload(gameId), TICK_MS) })
    emitDownload(progress)
    return true
  }

  function cancelDownload(gameId: string): void {
    const tracked = downloads.get(gameId)
    if (!tracked) return
    if (tracked.timer) clearTimeout(tracked.timer)
    downloads.delete(gameId)
    emitDownload({ ...tracked.progress, state: 'cancelled' })
    deps.downloadEnded?.(gameId)
  }

  function pauseDownload(gameId: string): void {
    const tracked = downloads.get(gameId)
    if (!tracked) return
    if (tracked.timer) clearTimeout(tracked.timer)
    downloads.delete(gameId)
    const paused: RomDownloadProgress = { ...tracked.progress, state: 'paused' }
    pausedDownloads.set(gameId, paused)
    emitDownload(paused)
  }

  function discardDownload(gameId: string): void {
    const kept = pausedDownloads.get(gameId)
    if (!kept) return
    pausedDownloads.delete(gameId)
    emitDownload({ ...kept, state: 'cancelled' })
  }

  const api: StreamingApi = {
    async getStreamingStatus() {
      return status()
    },
    async startStreamingPairing() {
      if (!hostEnabled()) throw new Error('Turn on "Let other PlayOut computers connect" first.')
      openPairing()
      emitStatus()
      return status()
    },
    async cancelStreamingPairing() {
      clearPairing()
      emitStatus()
      return status()
    },
    async removeStreamingClient(clientId) {
      const at = clients.findIndex((c) => c.id === clientId)
      if (at >= 0) clients.splice(at, 1)
      emitStatus()
      return status()
    },
    async firstStartHosts(): Promise<DiscoveredHost[]> {
      // ?firststart=1: a first start with the network's hosts unpaired.
      if (!deps.firstStart) return []
      return (await api.findStreamingHosts()).filter((h) => !h.paired)
    },
    async findStreamingHosts(): Promise<DiscoveredHost[]> {
      await sleep(1_500)
      const port = deps.settings().streaming.hostPort
      return NETWORK.map((h) => ({
        id: h.id,
        name: h.name,
        address: h.address,
        port,
        paired: hosts.has(h.id)
      }))
    },
    async pairStreamingHost(address, pin) {
      const trimmed = address.trim()
      if (!trimmed) throw new Error('Enter the address of the host.')
      if (!/^\d{4}$/.test(pin)) throw new Error('The PIN is the 4 digits the host shows.')
      await sleep(700)
      const ip = trimmed.replace(/:\d+$/, '')
      const entry = NETWORK.find(
        (h) => h.address === ip || h.name.toLowerCase() === ip.toLowerCase()
      )
      if (!entry)
        throw new Error(
          `No PlayOut host answered at ${trimmed}. Check that it is on and on this network.`
        )
      if (pin !== MOCK_STREAMING_PIN)
        throw new Error('Wrong PIN. Check the PIN on the host and try again (mock: 1234).')
      const mock = addHost(entry, now())
      remoteUpdatedAt = now()
      emitStatus()
      emitLibrary()
      return clone(mock.host)
    },
    async removeStreamingHost(hostId) {
      hosts.delete(hostId)
      // Its downloads can never finish: cancelled, as the real service aborts them (no error toast).
      for (const [gameId, tracked] of [...downloads]) {
        if (tracked.progress.hostId !== hostId) continue
        if (tracked.timer) clearTimeout(tracked.timer)
        downloads.delete(gameId)
        emitDownload({ ...tracked.progress, state: 'cancelled' })
        deps.downloadEnded?.(gameId)
      }
      for (const [gameId, kept] of [...pausedDownloads])
        if (kept.hostId === hostId) discardDownload(gameId)
      deps.hostRemoved?.(hostId)
      remoteUpdatedAt = now()
      emitStatus()
      emitLibrary()
      return status()
    },
    async setStreamingHostAddress(hostId, address) {
      const mock = hosts.get(hostId)
      if (!mock) throw new Error('That computer is not paired any more')
      mock.host = { ...mock.host, wanAddress: address?.trim() || undefined }
      emitStatus()
      return status()
    },
    async getRemoteLibrary() {
      return remoteLibrary()
    },
    async refreshRemoteLibrary() {
      await sleep(400)
      remoteUpdatedAt = now()
      for (const h of hosts.values()) h.host.lastSeen = remoteUpdatedAt
      const library = remoteLibrary()
      emitter.emit('streaming:library', library)
      emitStatus()
      // The play time sync: each host's (one, fixed) session of every game both PCs have, counted once here.
      if (deps.settings().streaming.syncPlaytime && deps.takeSessions)
        for (const h of hosts.values()) {
          if (!h.host.online) continue
          const shared = h.games.filter((g) => deps.games.has(g.id))
          if (!shared.length) continue
          const startedAt = daysAgo(2)
          deps.takeSessions(
            h.host.id,
            shared.map((g) => ({
              id: `s_${h.host.id}-${g.id.replace(/[^w-]/g, '-')}`,
              gameId: g.id,
              startedAt,
              endedAt: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(),
              minutes: 45,
              // Played on the host's copy of a store that reports an account total (main's playtime-sync store).
              ...(['steam', 'epic', 'xbox'].includes(g.source) ? { store: g.source } : {})
            }))
          )
        }
      return library
    },
    async streamGame(gameId, hostId) {
      if (session && session.state !== 'ended' && session.state !== 'error')
        throw new Error(`${session.hostName} is already streaming. Stop that stream first.`)
      const found = findRemote(gameId, hostId)
      if (!found) throw new Error('No paired computer has this game.')
      const { host } = found
      if (!host.host.online) throw new Error(`${host.host.name} is offline.`)
      const base = { gameId, hostId: host.host.id, hostName: host.host.name }
      const run = ++streamRun
      emitSession({
        ...base,
        state: 'preparing',
        message: `Starting the game on ${host.host.name}…`
      })
      await sleep(700)
      if (run !== streamRun) return
      emitSession({ ...base, state: 'connecting', message: 'Opening Moonlight…' })
      await sleep(900)
      if (run !== streamRun) return
      emitSession({ ...base, state: 'streaming' })
      sessionTimer = setTimeout(() => endStream(), STREAM_MS)
    },
    async stopStream() {
      endStream('Stream stopped')
    },
    // On every host that has the game, as main's setRemoteFavorite (the favourites sync).
    async setRemoteFavorite(gameId, favorite) {
      if (!deps.settings().streaming.syncFavorites)
        throw new Error('Favourites of host games need "Sync favourites" (Settings › Streaming)')
      const found = findRemote(gameId)
      if (!found) throw new Error('No paired computer offers this game')
      await sleep(200)
      const at = now()
      for (const h of hosts.values()) {
        if (!h.host.online) continue
        for (const g of h.games) {
          if (g.id !== found.game.id) continue
          g.favorite = favorite
          g.favoriteAt = at
        }
      }
      emitLibrary()
    },
    // At once, without the install queue: the full mock (index.ts) replaces these two with queued ones.
    async downloadRemoteRom(gameId) {
      checkDownload(gameId)
      startDownload(gameId)
    },
    async cancelRemoteRomDownload(gameId) {
      cancelDownload(gameId)
    }
  }

  const remoteShown = (gameId: string): Game | null =>
    remoteLibrary().games.find((g) => g.id === gameId) ?? null
  const metadata: StreamingMock['metadata'] = {
    layers(gameId) {
      const found = gameId.startsWith('remote:') ? findRemote(gameId) : null
      return found ? metadataLayers(withRemoteEdit(clone(found.game), found.game.id)) : null
    },
    set(gameId, edit, clear) {
      const found = gameId.startsWith('remote:') ? findRemote(gameId) : null
      if (!found) return null
      const next: MetadataEdit = { ...(remoteEdits.get(found.game.id) ?? {}) }
      for (const f of clear ?? []) delete next[f]
      for (const f of METADATA_EDIT_FIELDS)
        if (edit[f] !== undefined) (next as Record<string, unknown>)[f] = edit[f]
      if (next.title !== undefined && !next.title.trim()) delete next.title
      if (Object.keys(next).length) remoteEdits.set(found.game.id, next)
      else remoteEdits.delete(found.game.id)
      emitLibrary()
      return remoteShown(gameId)
    },
    clear(gameId, fields) {
      const found = gameId.startsWith('remote:') ? findRemote(gameId) : null
      if (!found) return null
      const next: MetadataEdit = { ...(remoteEdits.get(found.game.id) ?? {}) }
      for (const f of fields ?? METADATA_EDIT_FIELDS) delete next[f]
      if (Object.keys(next).length) remoteEdits.set(found.game.id, next)
      else remoteEdits.delete(found.game.id)
      emitLibrary()
      return remoteShown(gameId)
    }
  }

  return {
    api,
    metadata,
    rom: {
      check: checkDownload,
      start: startDownload,
      cancel: cancelDownload,
      pause: pauseDownload,
      discard: discardDownload
    },
    settingsChanged(next) {
      const enabled = next.streaming.hostEnabled
      if (enabled === lastHostEnabled) return
      lastHostEnabled = enabled
      if (enabled) void startHost()
      else stopHost()
    }
  }
}
