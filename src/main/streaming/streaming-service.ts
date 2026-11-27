import type { ChildProcess } from 'child_process'
import { playsOnlyRecomp, recompOnlyKey } from '../../shared/recomp-play'
import { loginsToFill, loginsToShare, SERVICE_NAMES } from './host-logins'
import {
  combinedFavorite,
  combinedStates,
  copiesToChange,
  favoriteAtMs,
  favoriteGroups,
  MAX_FAVORITE_ENTRIES,
  parseFavoriteEntries,
  pickFavorite,
  proposals,
  type FavoriteEntry,
  type FavoriteGroup
} from './favorites-sync'
import { createLibraryTabsSync } from './library-tabs-sync'
import { sanitizeAchievementsInfo } from './host-achievements'
import {
  compareCursors,
  copyForStore,
  createPlaytimeSyncState,
  cursorOf,
  MAX_PLAYTIME_GAMES,
  MAX_PLAYTIME_ROUNDS,
  MAX_SESSIONS_PER_REQUEST,
  parseCursor,
  parseGameIds,
  parseWireSessions,
  sessionsAfter,
  toWire,
  type SessionCursor,
  type WireSession
} from './playtime-sync'
import {
  createRecencyRelay,
  isStoreGameId,
  isLaterPlay,
  latestRecency,
  MAX_RECENCY_WANTED,
  ownRecency,
  parseRecency,
  parseWanted,
  playedAt,
  type RecencyEntry
} from './recency-relay'
import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { hostname as osHostname } from 'os'
import { basename, dirname, join } from 'path'
import type {
  AchievementsInfo,
  DiscoveredHost,
  EmulationSyncStatus,
  Game,
  GameRecompInfo,
  GameMetadata,
  InstallQueueEntry,
  LibraryTabDef,
  PairedComputer,
  PlaySession,
  PairedHost,
  RemoteGameInfo,
  RemoteLibrary,
  RomDownloadProgress,
  Settings,
  SourceId,
  StreamingHostStatus,
  StreamingStatus,
  StreamingToolStatus,
  StreamSession
} from '../../shared/types'
import type { EventBus } from '../events'
import type { InstallQueue } from '../installs/queue'
import type { LauncherService } from '../launcher/types'
import type { Logger } from '../logger'
import { readJson, renameRetry } from '../util/fs'
import { effectiveGame, type MetadataEdit } from '../../shared/metadata-edit'
import { displayTitle } from '../util/game-title'
import {
  createDiscoveryResponder,
  discoverHosts,
  type DiscoveryResponder,
  type DiscoveryResponderDeps,
  type DiscoverOptions,
  type FoundHost
} from './discovery'
import {
  CertificateMismatchError,
  createHostClient,
  HostRequestError,
  type HostClient,
  type HostConnection,
  type PairResponse
} from './host-client'
import {
  createHostServer,
  type ClientRecord,
  type HostHandlers,
  type HostServer,
  type HostServerDeps,
  type MediaKindParam,
  type RequestContext
} from './host-server'
import { createEmulationSync, scopeFor, SyncRefused } from './emulation-sync'
import { ScanError } from './emulation-sync/scan'
import { createMoonlight, type Moonlight, type MoonlightDeps } from './moonlight'
import {
  createPinPairing,
  hashToken,
  isMoonlightPin,
  newPin,
  newToken,
  tokenMatches
} from './pairing'
import {
  buildRemoteLibrary,
  hostGameAsGame,
  offeredId,
  HOST_ID,
  isMediaRevision,
  MEDIA_REV,
  hostOffer,
  parseRemoteGameId,
  localMatches,
  sanitizeHostGame,
  surelySameGame,
  type HostGame,
  type HostOfferInput
} from './remote-library'
import {
  downloadRomSet,
  openRomFile,
  romFileSet,
  romGamePath,
  type RomArea,
  type RomDownloadStep,
  type RomFetchRequest,
  type RomFileSet
} from './rom-transfer'
import {
  isPs3HddTransferPath,
  PS3_HDD_AREA,
  activePs3HddDir,
  ps3HddFiles,
  ps3TitleIds
} from '../emulation/ps3-hdd'
import { createGameIdReader, idsFromName, type ChdReader } from '../emulation/disc-id'
import {
  gameIdKindOf,
  isTexturePackTransferPath,
  TEXTURE_AREA,
  texturePackFiles,
  texturePacksDir
} from './texture-packs'
import { createSecretsStore, type SecretsStore, type StoredHost } from './secrets'
import {
  createStreamLaunchServer,
  ensureStreamLaunchToken,
  sessionEndWaiter,
  type StreamLaunchServer,
  type StreamLaunchServerDeps
} from './stream-launch'
import {
  createSunshine,
  SUNSHINE_APP_NAME,
  SUNSHINE_DEFAULT_PORT,
  sunshinePorts,
  type Sunshine,
  type SunshineDeps
} from './sunshine'
import { ensureHostCertificate, sameFingerprint, type HostCertificate } from './tls'
import { readInstalledTool } from './tools'
import { firewallProblem, type FirewallResult, type HostFirewall } from './firewall'
import { createNatPmpClient, withNatPmpFallback } from './natpmp'
import {
  createUpnpClient,
  localIPv4Addresses,
  pickInternalClient,
  type PortMappingRequest,
  type PortProtocol,
  type UpnpClient,
  type UpnpGateway
} from './upnp'
import { tMain } from '../i18n'

/**
 * Streaming (ARCHITECTURE.md §4.13): the one service that ties the streaming modules together. As a host it runs
 * PlayOut's HTTPS host service, the LAN discovery answer, the named pipe Sunshine's app talks to, the router's port
 * forwarding and Sunshine itself, all switched by Settings > Streaming. As a client it keeps the paired hosts, their
 * games (folded into this PC's library by remote-library.ts), Moonlight streams and ROM downloads. Status and the
 * remote library reach the renderer through the four `streaming:*` events.
 */

/** Everything the service touches outside itself, replaceable in tests. */
export interface StreamingIo {
  secrets: SecretsStore
  certificate: (dir: string) => Promise<HostCertificate>
  createHostServer: (deps: HostServerDeps) => HostServer
  createDiscoveryResponder: (deps: DiscoveryResponderDeps) => DiscoveryResponder
  discoverHosts: (options: DiscoverOptions) => Promise<FoundHost[]>
  createStreamLaunchServer: (deps: StreamLaunchServerDeps) => StreamLaunchServer
  ensureLaunchToken: (file: string) => Promise<string>
  upnp: UpnpClient
  createSunshine: (deps: SunshineDeps) => Sunshine
  createMoonlight: (deps: MoonlightDeps) => Moonlight
  hostClient: HostClient
  localAddresses: () => string[]
  internalClient: (gatewayHost: string) => string | null
  now: () => number
  /** This PC's internet address as the internet sees it (a lookup service), or null. */
  publicIp: () => Promise<string | null>
  /** How long Moonlight must run before the session counts as streaming. */
  streamingAfterMs: number
  newPin: () => string
  sleep: (ms: number) => Promise<void>
}

/** A play session taken from a paired PC, for one of this PC's games (its times on this PC's clock). */
export interface SyncedSession {
  id: string
  gameId: string
  startedAt: string
  endedAt: string
  minutes: number
  /** The store whose account total already counts it (playtime-sync WireSession.store). */
  store?: string
}

/** An image of a host's game, in this PC's host cache, to copy into one of this PC's games. */
export interface HostArt {
  kind: 'cover' | 'hero' | 'logo' | 'icon' | 'screenshot'
  file: string
  /** Screenshots: their place. */
  index?: number
}

export interface StreamingServiceDeps {
  settings: { get(): Settings; onChange(listener: (settings: Settings) => void): () => void }
  /**
   * As a client: take a paired host's logins for the metadata and RetroAchievements services this PC has none for
   * (host-logins.ts loginsToFill's patch, written to Settings). Absent: logins are not taken.
   */
  fillLogins?(patch: Partial<Settings['scrapers']>): void
  /**
   * The Library tabs sync with the paired PCs (library-tabs-sync.ts): its document's file (userData/
   * library-tabs-sync.json), and how a winning copy from another PC replaces this PC's tabs (settings
   * ui.libraryTabs). Absent: tabs are not synced.
   */
  libraryTabs?: {
    file: string
    apply(tabs: LibraryTabDef[]): void
    /** How long after a change here the hosts get it (default TABS_AFTER_CHANGE_MS; tests). */
    afterChangeMs?: number
  }
  /** This is PlayOut's first start on this PC (its settings file did not exist): firstStartHosts looks for hosts. */
  firstStart?: boolean
  library: {
    games(): Game[]
    getGame(id: string): Game | undefined
    /**
     * The metadata cloud's fields for a game (LibraryService.cloudFields): the offer lays them over the scraped
     * metadata. This PC's own (private, unapproved) metadata edits are never offered: a client stores the offer's
     * metadata as its scraped layer (importFromHost) and lays its own cloud and edits over it.
     */
    cloudFields?(game: Game): MetadataEdit | undefined
    /**
     * A host-only game as this PC shows it (LibraryService.viewRemote): the cloud's fields and the user's own edit of
     * it laid over the host's metadata. Absent: shown as the host offers it.
     */
    viewRemote?(game: Game): Game
    /** Called when viewRemote's answers may have changed (an edit saved, the cloud): the remote library is built again. */
    onRemoteViewChange?(listener: () => void): () => void
    /** A downloaded host ROM (this PC's record now) takes the user's edit of the host's copy (LibraryService). */
    adoptRemoteMetadataEdit?(localId: string, hostGameId?: string): boolean
    /**
     * Write a game's title (LibraryService.applyMetadata): a recompilation-only game's original downloaded from a host
     * takes the host's title when its file name does not say it, so this PC's recompilation match finds it.
     */
    applyMetadata?(
      id: string,
      update: { title?: string },
      options?: { overwrite?: boolean }
    ): unknown
    /**
     * The favourites sync (favorites-sync.ts): set a game's favourite taken from a paired PC, with that change's time
     * (LibraryService.setSyncedFavorite; never counts as the user's change here). Absent: favourites are not synced.
     */
    setSyncedFavorite?(id: string, favorite: boolean, atMs: number): boolean
    /** Called when the user turns a favourite on or off here (LibraryService.onUserFavorite). */
    onUserFavorite?(listener: (id: string) => void): () => void
    /** The play time sync (playtime-sync.ts): every play session kept here (LibraryService.allSessions). */
    allSessions?(): readonly PlaySession[]
    /**
     * Sessions played on a paired PC (`from`), counted in their games' play time; one already kept is skipped
     * (LibraryService.addSyncedSessions). Returns how many were added.
     */
    addSyncedSessions?(sessions: SyncedSession[], from: string): number
    /**
     * When games of this PC were last played on a paired PC (recency-relay.ts: the store games no session can cross
     * for): each game's last played is raised to `atMs` (this PC's clock) when that is later, nothing else of it
     * changes (LibraryService.setSyncedLastPlayed). Returns how many changed. Absent: those dates are neither sent
     * nor taken (as a client; a host passes them on without it).
     */
    setSyncedLastPlayed?(entries: { id: string; atMs: number }[]): number
  }
  /**
   * The play time sync with the paired PCs (playtime-sync.ts): the file of this PC's cursors with each host
   * (userData/playtime-sync.json). Absent (or the library without allSessions/addSyncedSessions): not synced.
   */
  playtime?: {
    file: string
    /** How long after a game ends here the hosts get its session (default PLAYTIME_AFTER_GAME_MS; tests). */
    afterGameMs?: number
  }
  /** How long after a favourite change here the hosts get it (default FAVORITES_AFTER_CHANGE_MS; tests). */
  favoritesAfterChangeMs?: number
  /**
   * This PC's achievements (AchievementsService.get): a paired client showing one of this PC's games as a host-only
   * game asks for its list (host-achievements.ts). Absent: none are given.
   */
  achievements?: { get(gameId: string): Promise<AchievementsInfo | null> }
  /**
   * A host-only game's recompilations, matched with this PC's catalogs (main/recomp recompForGame): its
   * metadata.recomp here, for Filters > Recompilations (a host's own match is not taken from its offer). Null = none;
   * undefined = not known yet.
   */
  recompFor?(game: Game): GameRecompInfo | null | undefined
  /**
   * Start the recompilation of a ROM card whose disc image went to the Recycle Bin for it (Game.romRemoved), as Play does
   * on this PC (main/recomp launchRecomp): a client's stream of that card. Without it such a stream cannot start.
   */
  launchKept?(game: Game): Promise<{ ok: true } | { ok: false; message: string }>
  launcher: Pick<LauncherService, 'launch' | 'running' | 'stop'>
  scan: { run(ids?: SourceId[]): Promise<unknown> }
  events: Pick<EventBus, 'emit' | 'on'>
  log: Logger
  /** userData/streaming. */
  dataDir: string
  appVersion: string
  /** What Sunshine runs for its PlayOut app: `"<PlayOut exe>" --stream-launch`. */
  appCommand: string
  pipeName: string
  /** userData/streaming/stream-launch.token: shared with the `--stream-launch` process. */
  launchTokenFile: string
  window: { minimize(): void; restore(): void; isVisible?(): boolean }
  /** This PC's primary screen in physical pixels, for Moonlight's 'auto' resolution. */
  screenSize: () => { width: number; height: number } | undefined
  /** The image-cache file behind a `media://cache/...` URL of this PC (what the host serves), or null. */
  mediaFile: (url: string) => string | null
  /** The name other PCs see (default: the computer name). */
  hostName?: string
  /**
   * Fill a game of this PC from its copy on a host: metadata fields it lacks, and the art files (already in this PC's
   * host cache) for kinds it lacks. Nothing it has is replaced.
   */
  importFromHost?: (
    gameId: string,
    update: { metadata: Partial<GameMetadata>; art: HostArt[] }
  ) => Promise<void>
  /**
   * This PC's Emulation folder (Settings › Library's, or the default), kept the same as the paired PCs' by the
   * Emulation folder sync. Absent: no sync (tests).
   */
  emulationDir?: () => string
  /**
   * Files of the Emulation folder the sync changed on this PC (paths inside it): downloaded from a host, deleted as the
   * host deleted them, or (as the host) uploaded or deleted by a client. The favourites lists in it are read again.
   */
  onEmulationFilesChanged?: (paths: string[]) => void
  /**
   * Reads a slice of a CHD's image (the Xbox helper's `read`), so a CHD game's serial is found for its texture packs.
   * Absent: a CHD game's texture packs are found by its file name only.
   */
  readChd?: ChdReader
  /** How long a game's serial / id lookup for its texture packs may take (default GAME_ID_TIMEOUT_MS; tests). */
  gameIdTimeoutMs?: number
  /** The ROM systems of the hosts' games, so this PC's Filters › Platform and tabs know them (none of its own ROMs). */
  registerSystemPlatforms?: (systemIds: string[]) => void
  /**
   * Windows Firewall rules for the host's ports (firewall.ts): without them other PCs see this one offline and keep
   * its last saved game list. Absent: not checked (tests, other platforms).
   */
  firewall?: HostFirewall
  /** The install queue shared with store installs: a ROM download waits while another game downloads. */
  installQueue: InstallQueue
  /** How long a new download of a game waits at most for the stopped older one to end (tests shorten it). */
  olderDownloadWaitMs?: number
  io?: Partial<StreamingIo>
}

export interface StreamingService {
  /** The deferred start-up: hosting per the settings, the remote library, the 5-minute refresh. */
  start(): Promise<void>
  status(): Promise<StreamingStatus>
  startPairing(): Promise<StreamingStatus>
  cancelPairing(): Promise<StreamingStatus>
  removeClient(clientId: string): Promise<StreamingStatus>
  findHosts(): Promise<DiscoveredHost[]>
  /**
   * PlayOut's first start on this PC (no settings file yet) with no host paired: the PlayOut hosts found on the
   * network, for the "connect a host" prompt; [] otherwise. Looked for once per run.
   */
  firstStartHosts(): Promise<DiscoveredHost[]>
  pairHost(address: string, pin: string): Promise<PairedHost>
  removeHost(hostId: string): Promise<StreamingStatus>
  /**
   * The paired host's internet address or name, as the user typed it ("203.0.113.5", "home.example.net:47900"); null
   * forgets it. Its games are fetched again from there.
   */
  setHostAddress(hostId: string, address: string | null): Promise<StreamingStatus>
  remoteLibrary(): Promise<RemoteLibrary>
  /**
   * A host-only game (`remote:` id) as its host offers it, before this PC's cloud and edits are laid over it (the
   * Edit sheet's "scraped" layer); undefined when the remote library has no such game.
   */
  remoteGameBase(gameId: string): Promise<Game | undefined>
  refreshRemoteLibrary(): Promise<RemoteLibrary>
  /** A client's Scan: every paired host rescans its library, then its games are fetched again (none: nothing to do). */
  scanHosts(): Promise<void>
  streamGame(gameId: string, hostId?: string): Promise<void>
  stopStream(): Promise<void>
  /**
   * Make a host-only game (`remote:` id) a favourite or not on its host(s) (the favourites sync), then show it. Rejects
   * while the sync is off here, or when none of its hosts takes it (unreachable, or an older PlayOut).
   */
  setRemoteFavorite(gameId: string, favorite: boolean): Promise<void>
  /**
   * A host-only game's (`remote:` id) achievements list, from the first of its hosts that has one (its Steam /
   * RetroAchievements account). Null when none has (or the game is not shown here); rejects when no host that has it
   * could be reached.
   */
  achievementsFor(gameId: string): Promise<AchievementsInfo | null>
  /** Queue a host's ROM game for download (it starts at once when nothing else downloads). */
  downloadRemoteRom(gameId: string): Promise<void>
  /** Out of the install queue: a waiting download leaves it, the running one is cancelled. */
  cancelRemoteRomDownload(gameId: string): Promise<void>
  /**
   * `media://remote/<hostId>/<hostGameId>/<kind>[?v=<rev>]`: the cached file (fetched from the host first), or null.
   * With the host's revision of the image, a cached file of another revision is replaced by the host's current one.
   */
  remoteMedia(
    hostId: string,
    hostGameId: string,
    kind: string,
    rev?: string
  ): Promise<string | null>
  /** The PC goes to sleep: hosting stops (listeners, port mapping, Sunshine) and the refresh pauses. */
  suspend(): void
  resume(): void
  /** PlayOut quits: stop everything and delete the router mapping (the caller caps the wait). */
  dispose(): Promise<void>
  /** Files a paired client is downloading from this PC right now (absolute paths). */
  filesBeingSent?(): string[]
  /**
   * The Emulation folder is being moved (Settings › Library): no sync pass starts (one under way stops) and the host
   * refuses its clients' sync requests (busy) until the returned function is called.
   */
  holdEmulationSync?(): () => void
  /** Settles when the host side finished applying the last setting change (tests). */
  idle(): Promise<void>
}

const REFRESH_MS = 5 * 60_000
/**
 * A host that could not be reached is tried again sooner than the regular refresh, for as long as it stays unreachable:
 * 30 s, doubling up to RETRY_MAX_MS. Both PCs often restart together (an update), and the host's server is up a few
 * seconds or minutes (a sign-in, Windows finishing updates) after the client's first try; the client must not show it
 * offline for another five minutes. A host that newly stops answering starts again at 30 s.
 */
export const RETRY_FIRST_MS = 30_000
export const RETRY_MAX_MS = 2 * 60_000
const LEASE_SECONDS = 3600
const RENEW_MS = 30 * 60_000
const ARM_MS = 2 * 60_000
/** Moonlight finishes its side of the pairing a moment after the host reports it done. */
const PAIR_SETTLE_MS = 2_000
const ROM_SET_CACHE_MS = 5 * 60_000
/** A set whose game id lookup was cut short (the deadline, the CHD helper not answering) is built again sooner. */
const ROM_SET_INCOMPLETE_CACHE_MS = 60_000
/** A download resumed after a restart waits this long at most for the hosts' first answer before it looks the game up. */
const RESUME_WAIT_MS = 60_000
/** Any download waits this long at most for the hosts' saved game lists (read at start) before it looks the game up. */
const OFFERS_WAIT_MS = 30_000
/** A new download of a game waits this long at most for the stopped older download of it to end. */
const OLDER_JOB_WAIT_MS = 15_000
/** A ROM download whose connection broke off while the host answered is tried this many times in all. */
export const HOST_TRANSFER_ATTEMPTS = 3
/** The pause before such a download is tried again. */
const HOST_TRANSFER_RETRY_MS = 3_000
/** After a game ends, the Emulation folder sync waits this long (the emulator has written its saves by then). */
const EMULATION_AFTER_GAME_MS = 30_000
/** After a Library tabs change on this PC, the hosts get it this long later (a burst of edits sends once). */
export const TABS_AFTER_CHANGE_MS = 2_000
/** After a favourite change on this PC, the hosts get it this long later (a burst of changes sends once). */
export const FAVORITES_AFTER_CHANGE_MS = 2_000
/** After a game ends on this PC, the hosts get its session this long later. */
export const PLAYTIME_AFTER_GAME_MS = 10_000
const STATUS_THROTTLE_MS = 250
const UNPAIR_WAIT_MS = 8_000
const MAPPING_DELETE_WAIT_MS = 5_000
/** How long the host keeps a client's launch failure for its /v1/stream/status. */
const LAUNCH_ERROR_KEEP_MS = 2 * 60_000
/** How long a client waits for the host's /v1/stream/status after Moonlight closed. */
const STREAM_STATUS_WAIT_MS = 3_000
const MEDIA_KIND = /^(cover|hero|logo|icon|screenshot[0-9])$/
// Functions, not constants: the text is read in PlayOut's language when it is shown.
const moonlightRetryText = (): string => tMain('mainStreaming.status.moonlightRetry')
/** Port forwarding worked on this router, but another router or the provider's shared address sits in front of it. */
const doubleNatText = (): string => tMain('mainStreaming.status.doubleNat')
/** The host port is forwarded, some of Sunshine's stream ports are not. */
const streamPortsText = (): string => tMain('mainStreaming.status.streamPorts')

/** Image types the media proxy keeps; anything else from a host is refused (it ends up in an <img> only). */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/bmp': 'bmp'
}

class Cancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'Cancelled'
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** reach() found no address of the host answering: it is offline, or the network between is down. */
class HostUnreachableError extends Error {
  constructor(text: string) {
    super(text)
    this.name = 'HostUnreachableError'
  }
}

/** Socket and DNS failures: the host or the network between went away (not the game, not this PC's disk). */
const NETWORK_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE'
]

/**
 * A download failed on the network (offline, network error, no answer in time), so it is worth trying again; any
 * other failure (the host refused, the game is not offered, the disk is full, the ROM folder is gone) is the game's
 * own and ends the download. Only reach() failing (HostUnreachableError) holds the host's downloads until it is back;
 * a network error after the host answered retries that download a few times (HOST_TRANSFER_ATTEMPTS).
 */
export function isHostUnreachable(err: unknown): boolean {
  if (err instanceof HostUnreachableError) return true
  if (err instanceof HostRequestError || err instanceof CertificateMismatchError) return false
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return NETWORK_CODES.includes(code)
  const text = message(err)
  return (
    NETWORK_CODES.some((c) => text.includes(c)) ||
    /did not answer in time|closed the connection|socket hang up/i.test(text)
  )
}

/**
 * Shown (once) for a queued download kept waiting because its host cannot be reached. The event also carries
 * `hostOffline: true`, which is what the renderer goes by (lib/streaming.ts hostOfflineWait), so the words can be
 * translated.
 */
export function hostOfflineMessage(hostName: string): string {
  return tMain('mainStreaming.hostOffline', { host: hostName })
}

/**
 * A connection failure in words a user can act on: Node's socket errors ('connect ECONNREFUSED 192.168.1.20:47900',
 * 'getaddrinfo ENOTFOUND') are for the log only. Other messages (ours, already worded) pass through.
 */
export function friendlyNetError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  const text = message(err)
  const has = (c: string): boolean => code === c || text.includes(c)
  if (has('ECONNREFUSED')) return tMain('mainStreaming.net.refused')
  if (has('ENOTFOUND') || has('EAI_AGAIN')) return tMain('mainStreaming.net.notFound')
  if (
    has('ETIMEDOUT') ||
    has('EHOSTUNREACH') ||
    has('ENETUNREACH') ||
    has('EHOSTDOWN') ||
    /did not answer in time/i.test(text)
  )
    return tMain('mainStreaming.net.noAnswer')
  if (has('ECONNRESET') || has('EPIPE') || /closed the connection/i.test(text))
    return tMain('mainStreaming.net.cut')
  if (/^[a-z]+ E[A-Z_]+\b/.test(text) || /^E[A-Z_]{3,}\b/.test(text))
    return tMain('mainStreaming.net.failed')
  return text
}

/** A plain IPv4 address (not a computer or internet name). */
function isIpv4(address: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address.trim())
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * A game's serial / id lookup for its texture packs (a few CHD reads of 15 s at most each, chdRead): past this its
 * image reads stop and the ids in its file and folder names decide its texture packs.
 */
const GAME_ID_TIMEOUT_MS = 20_000
/** The outer limit on a game id lookup past its own deadline (the reads it stops are no longer waited for). */
const GAME_ID_BACKSTOP_MS = 10_000

/** A file the host refused with 429 (its streams for this client all busy) is asked for this many times in all... */
const BUSY_RETRIES = 5
/** ...waiting this long times the attempt number in between. */
const BUSY_RETRY_MS = 250

/** Resolves after `ms`; rejects with the signal's reason as soon as it aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Cancelled())
    const stop = (): void => {
      clearTimeout(timer)
      reject(signal.reason ?? new Cancelled())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

function withTimeout<T>(task: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took too long`)), ms)
  })
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Whether an address is on the local network: private and link-local IPv4 ranges, loopback, and plain computer names
 * (no dots, or .local / .lan / .home), which only resolve on the LAN. IPv6 never counts: the host service, Sunshine and
 * the Moonlight command line are IPv4 only, so parseHostAddress refuses IPv6.
 */
export function isLanAddress(address: string): boolean {
  const a = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])]
    return (
      x === 10 ||
      x === 127 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254) ||
      (x === 100 && y >= 64 && y <= 127)
    )
  }
  if (a.includes(':')) return false
  return a === 'localhost' || !a.includes('.') || /\.(local|lan|home|internal)$/.test(a)
}

/**
 * `host` or `host:port` as typed by the user. Only characters an address or computer name can hold: the result goes
 * into URLs and onto Moonlight's command line. IPv6 (bare or `[v6]:port`) is refused with a clear message: the host
 * service listens on IPv4 only, Sunshine runs IPv4 only and Moonlight's command line would need brackets.
 */
export function parseHostAddress(
  input: string,
  defaultPort: number
): { address: string; port: number } {
  const text = input.trim()
  let address = text
  let port = defaultPort
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(text)
  if (bracketed) {
    address = bracketed[1]
    if (bracketed[2]) port = Number(bracketed[2])
  } else if ((text.match(/:/g) ?? []).length === 1) {
    const [h, p] = text.split(':')
    address = h
    if (!/^\d+$/.test(p)) throw new Error(tMain('mainStreaming.address.portNumber'))
    port = Number(p)
  }
  if (bracketed || address.includes(':')) throw new Error(tMain('mainStreaming.address.ipv4'))
  if (!address || !/^[A-Za-z0-9._-]+$/.test(address) || address.startsWith('-'))
    throw new Error(tMain('mainStreaming.address.enter'))
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(tMain('mainStreaming.address.badPort'))
  return { address, port }
}

/** The last line of Moonlight's log that says what went wrong, for the error toast. */
function moonlightFailure(tail: string, code: number | null): string {
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const line = [...lines].reverse().find((l) => /error|fail|could not|unable/i.test(l))
  if (line) return tMain('mainStreaming.stream.moonlightClosed', { line: line.slice(0, 300) })
  return code !== null
    ? tMain('mainStreaming.stream.moonlightClosedEarlyCode', { code })
    : tMain('mainStreaming.stream.moonlightClosedEarly')
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

interface HostRuntime {
  online: boolean
  /** The host's offer as received at the last refresh; null while offline (its games then disappear). */
  offer: unknown[] | null
  error?: string
  /** Moonlight could not pair with this host yet (retried when streaming). */
  streamError?: string
  /** The address that answered last. */
  preferred?: string
  /** The last "cannot be reached" warning logged: the same one again (a retry every 2 min) goes to debug. */
  lastWarn?: string
  /**
   * The host's clock minus this PC's (ms), measured when its offer was last fetched (kept with the saved offer).
   * Undefined: the host sent no clock (an older PlayOut), and its games show no last played.
   */
  skewMs?: number
}

interface ActiveStream {
  session: StreamSession
  /** The game's id on the host, to match the host's launch failure. */
  hostGameId: string
  cancelled: boolean
  conn?: HostConnection
  child?: ChildProcess
  /** Moonlight's pair window while the stream is in its pairing step: Stop closes it. */
  pairChild?: ChildProcess
  minimized: boolean
  timer?: ReturnType<typeof setTimeout>
  /** The host's warning that its stream ports are not forwarded: added to Moonlight's failure. */
  warning?: string
}

interface DownloadJob {
  gameId: string
  hostId: string
  hostGameId: string
  /** The game's path relative to the host's ROM root: the downloaded game has the same one here. */
  externalId: string
  title: string
  ac: AbortController
  /** Stopped because the user paused it (the queue's stop('pause')): its .part files stay, it ends as 'paused'. */
  paused?: boolean
  /** The last progress it reported, so a paused job keeps showing how far it got. */
  lastStep?: Pick<RomDownloadStep, 'bytesDone' | 'bytesTotal' | 'percent'>
  /** Settles when runDownload of this job ended: 'retry' when the host could not be reached (the queue keeps it). */
  settled?: Promise<void | 'retry' | 'finished'>
}

/** Settles when `p` does, or after `ms` at most (a real timer that does not keep PlayOut running). */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    p.then(done, done)
  })
}

interface Armed {
  gameId: string
  clientId: string
  clientName: string
  expiresAt: number
}

/** This PC's public IPv4 address, from a plain lookup service (nothing is sent but the request itself). */
async function lookupPublicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const ip = (await res.text()).trim()
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null
  } catch {
    return null
  }
}

/**
 * A game as offered to clients: its scraped metadata with the metadata cloud's fields laid over it, without this
 * PC's own metadata edits (user.metadataEdits; the title override stays the display name it always was).
 */
export function offeredMetadata(game: Game, cloud: MetadataEdit | undefined): Game {
  const edits = game.user?.metadataEdits
  let raw = game
  if (edits && Object.keys(edits).length) {
    const user = { ...game.user }
    delete user.metadataEdits
    raw = { ...game, user }
  }
  return effectiveGame(raw, cloud)
}

/** Host images fetched at once while copying from the hosts (each is one small request). */
const HOST_SYNC_PARALLEL = 6
/** A host image that did not come is asked for again after this long (not on every 5-minute refresh). */
const ART_RETRY_MS = 60 * 60_000
/** A client's Scan rescans the host at most this often (another client's Scan just now covers it). */
const HOST_SCAN_GAP_MS = 30_000
/** How long a client waits for a host's library scan before taking what the host has. */
const HOST_SCAN_WAIT_MS = 10 * 60_000

export function createStreamingService(deps: StreamingServiceDeps): StreamingService {
  const { log, events, settings, library, launcher } = deps
  const io: StreamingIo = {
    secrets: deps.io?.secrets ?? createSecretsStore(join(deps.dataDir, 'secrets.json'), log),
    certificate: ensureHostCertificate,
    createHostServer,
    createDiscoveryResponder,
    discoverHosts,
    createStreamLaunchServer,
    ensureLaunchToken: ensureStreamLaunchToken,
    upnp:
      deps.io?.upnp ??
      withNatPmpFallback(createUpnpClient({ log }), createNatPmpClient({ log }), log),
    publicIp: deps.io?.publicIp ?? lookupPublicIp,
    createSunshine,
    createMoonlight,
    hostClient: deps.io?.hostClient ?? createHostClient(),
    localAddresses: () => localIPv4Addresses(),
    internalClient: (gw) => pickInternalClient(gw),
    now: Date.now,
    streamingAfterMs: 4_000,
    newPin,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...deps.io
  }
  const store = io.secrets
  const now = io.now
  const hostName = (deps.hostName ?? osHostname()).slice(0, 64) || 'PlayOut PC'

  // --- state ------------------------------------------------------------------------------------------------------
  let identity = ''
  let started = false
  let disposed = false
  let suspended = false

  let sunshineStatus: StreamingToolStatus = { state: 'missing' }
  let moonlightStatus: StreamingToolStatus = { state: 'missing' }

  const host: {
    state: StreamingHostStatus['state']
    error?: string
    portForwarding: StreamingHostStatus['portForwarding']
    controllerDriver: boolean
    streaming: StreamingHostStatus['streaming']
  } = { state: 'off', portForwarding: { state: 'off' }, controllerDriver: false, streaming: null }

  let certificate: HostCertificate | null = null
  let server: HostServer | null = null
  let responder: DiscoveryResponder | null = null
  let pipe: StreamLaunchServer | null = null
  let gateway: UpnpGateway | null = null
  /** The router mappings hosting made: the host port, then Sunshine's stream ports. */
  let mappings: { protocol: PortProtocol; externalPort: number; permanent: boolean }[] = []
  let renewTimer: ReturnType<typeof setInterval> | null = null
  let applied = { enabled: false, port: 0 }
  let hostGen = 0
  let hostTask: Promise<void> = Promise.resolve()
  let armed: Armed | null = null
  /** The paired client whose stream the host runs (set by onRun): only it may stop that stream. */
  let streamingClientId: string | null = null
  /** Per client: the armed game the host could not start, for its next /v1/stream/status. */
  const launchErrors = new Map<string, { gameId: string; message: string; at: number }>()
  let pinTimer: ReturnType<typeof setTimeout> | null = null
  /** Built sets by game, with the PS3 HDD folder they were read from (a set read before the move is not reused after). */
  const romSets = new Map<
    string,
    { set: RomFileSet; at: number; hdd: string | null; ttl: number }
  >()
  /** Sets being built, by game and PS3 HDD folder: callers meanwhile share the one build. */
  const romSetBuilds = new Map<string, Promise<RomFileSet>>()
  /** ROM games' serials / ids for their texture packs, cached per file (disc-id.ts). */
  const gameIds = createGameIdReader(deps.readChd, now)
  const lastSeenWritten = new Map<string, number>()

  const runtimes = new Map<string, HostRuntime>()
  let remote: RemoteLibrary = { games: [], alsoOnHost: {}, updatedAt: iso(now()) }
  /** The host-only games of `remote` by id as their hosts offer them (before library.viewRemote). */
  let remoteBase = new Map<string, Game>()
  let refreshing: Promise<void> | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  /** The sooner retry while a host is unreachable (RETRY_FIRST_MS, doubling to RETRY_MAX_MS), and its next delay. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryMs = RETRY_FIRST_MS
  /** The hosts unreachable at the last refresh: one newly among them starts the retries over at RETRY_FIRST_MS. */
  let offlineHosts = new Set<string>()
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  let stream: ActiveStream | null = null
  const moonlightPairs = new Map<string, Promise<void>>()
  /** The current download job of each game (a stopped older one may still be ending: see `jobs`). */
  const downloads = new Map<string, DownloadJob>()
  /** Every download job not ended yet, current or stopped (dispose aborts them all). */
  const jobs = new Set<DownloadJob>()
  /**
   * Hosts a download could not reach: their queued downloads keep their place but wait (the queue's `ready`) until
   * the host answers again (any successful reach: a refresh, discovery, pairing), which pokes the queue.
   */
  const unreachableHosts = new Set<string>()
  /** Settles once the hosts' saved game lists were read and the remote library built (start), or a refresh ran. */
  let offersLoadedOnce: () => void = () => {}
  const offersLoaded = new Promise<void>((resolve) => (offersLoadedOnce = resolve))
  /** Settles after the first refresh of the hosts' games this run (a download resumed after a restart waits for it). */
  let refreshedOnce: () => void = () => {}
  const firstRefresh = new Promise<void>((resolve) => (refreshedOnce = resolve))
  const mediaJobs = new Map<string, Promise<string | null>>()
  const offs: (() => void)[] = []

  const pairing = createPinPairing({ now })

  const sunshine = io.createSunshine({
    root: join(deps.dataDir, 'sunshine'),
    log,
    secret: {
      get: async () => store.get().sunshinePassword ?? null,
      set: (value) =>
        store.update((d) => {
          d.sunshinePassword = value
        })
    },
    onStatus: (s) => {
      sunshineStatus = s
      emitStatus()
    },
    onExit: () => {
      // The stream ended with the Sunshine that carried it. Its launcher usually dies with it and the pipe closes; one
      // that outlives it would keep this PC "streaming" (busy for every other client, no Emulation sync) for good. So
      // the launcher is dropped like a viewer that left (the game closes) and the stream is forgotten now.
      if (streamingClientId !== null) log.warn('Sunshine closed during a stream: ending the stream')
      pipe?.dropClient()
      clearStreaming()
    }
  })
  const moonlight = io.createMoonlight({
    root: join(deps.dataDir, 'moonlight'),
    log,
    onStatus: (s) => {
      moonlightStatus = s
      emitStatus()
    }
  })

  // Secrets and this PC's id first: every call waits for them. A failure here leaves an empty, in-memory state
  // rather than a service that rejects everything.
  const ready = (async () => {
    try {
      await store.load()
    } catch (err) {
      log.error('streaming secrets could not be read', err)
    }
    identity = await loadIdentity().catch((err) => {
      log.error('streaming identity could not be saved', err)
      return randomUUID()
    })
  })()

  async function loadIdentity(): Promise<string> {
    const file = join(deps.dataDir, 'identity.json')
    const saved = await readJson<{ id?: unknown }>(file)
    if (saved && typeof saved.id === 'string' && HOST_ID.test(saved.id)) return saved.id
    const id = randomUUID()
    await fs.mkdir(deps.dataDir, { recursive: true })
    await fs.writeFile(file, JSON.stringify({ id }, null, 2))
    return id
  }

  // --- status -----------------------------------------------------------------------------------------------------
  let statusTimer: ReturnType<typeof setTimeout> | null = null
  let lastStatusAt = 0
  /** The Emulation folder sync (Settings › Streaming), both its host and client side. */
  const emulationSync = deps.emulationDir
    ? createEmulationSync({ stateDir: join(deps.dataDir, 'emulation-sync'), log })
    : null
  /** Moves of the Emulation folder under way (holdEmulationSync). */
  let emuHolds = 0
  /** Its state with each host (client side), for Settings. */
  const emuStatus = new Map<string, EmulationSyncStatus>()
  /** The Library tabs sync (Settings › Streaming), loaded by start(). */
  const tabsSync = deps.libraryTabs
    ? createLibraryTabsSync({
        file: deps.libraryTabs.file,
        settings,
        apply: deps.libraryTabs.apply,
        deviceId: () => identity,
        log,
        now: () => now()
      })
    : null
  let tabsLoaded = false
  /** The play time sync's cursors with each host (Settings › Streaming), loaded by start(). */
  const playtimeState =
    deps.playtime && deps.library.allSessions && deps.library.addSyncedSessions
      ? createPlaytimeSyncState({ file: deps.playtime.file, log })
      : null
  let playtimeLoaded = false
  /**
   * As a host: when its clients last played the store games it does not offer, passed on to its other clients
   * (recency-relay.ts), beside the play time sync's file.
   */
  const recencyRelay = createRecencyRelay({
    file: deps.playtime ? join(dirname(deps.playtime.file), 'recency-relay.json') : undefined,
    log
  })

  function buildStatus(): StreamingStatus {
    const s = settings.get().streaming
    const secrets = store.get()
    const pin = pairing.current()
    const locked = pairing.lockedUntil()
    const clients: PairedComputer[] = secrets.clients.map((c) => ({
      id: c.id,
      name: c.name,
      pairedAt: c.pairedAt,
      lastSeen: c.lastSeen,
      address: c.address
    }))
    return {
      host: {
        enabled: s.hostEnabled,
        state: host.state,
        listening: server !== null,
        error: host.error,
        sunshine: { ...sunshineStatus },
        portForwarding: { ...host.portForwarding },
        lanAddresses: io.localAddresses(),
        port: server?.port ?? s.hostPort,
        pairing: pin ? { pin: pin.pin, expiresAt: iso(pin.expiresAt) } : null,
        lockedUntil: locked ? iso(locked) : undefined,
        clients,
        controllerDriver: host.controllerDriver,
        streaming: host.streaming
      },
      client: {
        moonlight: { ...moonlightStatus },
        hosts: secrets.hosts.map(pairedHost)
      }
    }
  }

  function pairedHost(h: StoredHost): PairedHost {
    const rt = runtimes.get(h.id)
    return {
      id: h.id,
      name: h.name,
      pairedAt: h.pairedAt,
      lastSeen: h.lastSeen,
      address: rt?.preferred,
      online: rt?.online ?? false,
      lanAddress: h.lanAddress,
      wanAddress: h.wanAddress,
      port: h.port,
      games: rt?.offer ? rt.offer.length : undefined,
      error: rt?.error ?? rt?.streamError,
      ...(emuStatus.has(h.id) ? { emulationSync: { ...emuStatus.get(h.id)! } } : {})
    }
  }

  /** Status changes come in bursts (download progress, each start-up step): at most four events a second. */
  function emitStatus(): void {
    if (disposed) return
    const wait = lastStatusAt + STATUS_THROTTLE_MS - Date.now()
    if (wait <= 0) {
      lastStatusAt = Date.now()
      events.emit('streaming:status', buildStatus())
      return
    }
    statusTimer ??= setTimeout(() => {
      statusTimer = null
      if (disposed) return
      lastStatusAt = Date.now()
      events.emit('streaming:status', buildStatus())
    }, wait)
  }

  function runtime(id: string): HostRuntime {
    let rt = runtimes.get(id)
    if (!rt) {
      rt = { online: false, offer: null }
      runtimes.set(id, rt)
    }
    return rt
  }

  function storedHost(id: string): StoredHost | undefined {
    return store.get().hosts.find((h) => h.id === id)
  }

  // =================================================================================================================
  // Host side
  // =================================================================================================================

  /** A stream's start of a card kept for its recompilation (StreamingServiceDeps.launchKept), as launcher.launch answers. */
  async function keptLaunch(game: Game): Promise<{ ok: boolean; error?: { message: string } }> {
    if (!deps.launchKept)
      return { ok: false, error: { message: tMain('mainStreaming.stream.imageInRecycleBin') } }
    const started = await deps
      .launchKept(game)
      .catch((err: unknown) => ({ ok: false as const, message: message(err) }))
    return started.ok ? { ok: true } : { ok: false, error: { message: started.message } }
  }

  /**
   * As a host, a client's last played of the store games this PC does not offer (`raw`, unchecked, on its clock
   * `theirNow`): kept for the other clients in the relay table, never written to this PC's library (a game this PC
   * does not offer is not the caller's to change). The answer, for the games the caller named only (`want`, unchecked,
   * and those it sent a date of): what the other PCs know of them, this PC's own records among them (never a hidden
   * game's, nor one it offers: that one's play crosses as sessions). A game the caller did not name is never told: what
   * another PC owns and plays is not every paired PC's to know. Null when `raw` is no valid list.
   */
  function relayRecency(
    ctx: RequestContext,
    raw: unknown,
    want: unknown,
    t: number,
    theirNow: number
  ): RecencyEntry[] | null {
    const theirs = parseRecency(raw, t, theirNow - t)
    if (!theirs) return null
    recencyRelay.take(theirs, ctx.client.id)
    const wanted = parseWanted(want)
    for (const e of theirs) wanted.add(e.game)
    const mine = ownRecency(library.games(), (g) => wanted.has(g.id) && !offeredGame(g.id))
    return latestRecency([...recencyRelay.entriesFor(ctx.client.id, wanted), ...mine])
  }

  /** The game when this PC offers it (installed store game or ROM, not hidden), else null. */
  function offeredGame(gameId: string): Game | null {
    // A game added by its .exe is offered under a stand-in id (offeredId: no path leaves this PC).
    const game =
      library.getGame(gameId) ??
      (gameId.startsWith('manual:')
        ? library.games().find((g) => g.source === 'manual' && offeredId(g) === gameId)
        : undefined)
    return game && hostOffer([game]).length > 0 ? game : null
  }

  /**
   * Every game this PC offers that is a favourite or whose favourite changed, by its offered id (the favourites sync's
   * answer; at most MAX_FAVORITE_ENTRIES).
   */
  function offeredFavorites(): FavoriteEntry[] {
    const out: FavoriteEntry[] = []
    for (const g of hostOffer(library.games())) {
      const at = favoriteAtMs(g)
      if (!g.favorite && !at) continue
      out.push({ id: g.id, favorite: g.favorite, at })
      if (out.length === MAX_FAVORITE_ENTRIES) break
    }
    return out
  }

  /** The caller is a computer this PC is itself a client of: it does not get this PC's library. */
  function isMyHost(ctx: RequestContext): boolean {
    return store.get().hosts.some((h) => h.id === ctx.client.id)
  }

  /** A paired client's Scan rescans this host (one at a time, not again within HOST_SCAN_GAP_MS of the last). */
  let hostScan: Promise<void> | null = null
  let hostScanEndedAt = -Infinity

  function auth(token: string): ClientRecord | null {
    const client = store.get().clients.find((c) => tokenMatches(token, c.tokenHash))
    return client ? { id: client.id, name: client.name } : null
  }

  /** Remember when and from where a client was last seen (written at most once a minute per client). */
  function touchClient(ctx: RequestContext): void {
    const t = now()
    if (t - (lastSeenWritten.get(ctx.client.id) ?? 0) < 60_000) return
    lastSeenWritten.set(ctx.client.id, t)
    void store
      .update((d) => {
        const c = d.clients.find((x) => x.id === ctx.client.id)
        if (c) {
          c.lastSeen = iso(t)
          c.address = ctx.address
        }
      })
      .then(emitStatus)
  }

  function mediaUrl(game: Game, kind: MediaKindParam): string | undefined {
    const shot = /^screenshot(\d)$/.exec(kind)
    if (shot) return game.media.screenshots?.[Number(shot[1])]
    const k = kind as 'cover' | 'hero' | 'logo' | 'icon'
    return game.user?.customMedia?.[k] || game.media[k]
  }

  async function romSet(game: Game, romsRoot: string): Promise<RomFileSet> {
    const hdd = deps.emulationDir ? await activePs3HddDir(deps.emulationDir()) : null
    const cached = romSets.get(game.id)
    if (cached && now() - cached.at < cached.ttl && cached.hdd === hdd) return cached.set
    const key = `${game.id}|${hdd ?? ''}`
    const running = romSetBuilds.get(key)
    if (running) return running
    const build = (async (): Promise<RomFileSet> => {
      const built = await withTexturePacks(
        game,
        romsRoot,
        await withPs3Hdd(game, romsRoot, await romFileSet(game, romsRoot))
      )
      let set = built.set
      // A set that lost its texture packs only because the id could not be read this time keeps the last set's.
      if (!built.idsComplete && cached && !set.files.some(isTextureEntry)) {
        const seen = new Set(set.files.map((f) => f.path.toLowerCase()))
        const kept = cached.set.files.filter(
          (f) => isTextureEntry(f) && !seen.has(f.path.toLowerCase())
        )
        if (kept.length) {
          const files = [...set.files, ...kept]
          set = { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }
        }
      }
      romSets.set(game.id, {
        set,
        at: now(),
        hdd,
        ttl: built.idsComplete ? ROM_SET_CACHE_MS : ROM_SET_INCOMPLETE_CACHE_MS
      })
      return set
    })()
    romSetBuilds.set(key, build)
    try {
      return await build
    } finally {
      if (romSetBuilds.get(key) === build) romSetBuilds.delete(key)
    }
  }

  function isTextureEntry(f: { path: string }): boolean {
    return f.path.toLowerCase().startsWith(`${TEXTURE_AREA.toLowerCase()}/`)
  }

  /**
   * The PS3 HDD (Emulation\Updates and DLC\PS3), as a set's files outside the ROM folder are named on the wire
   * ('PS3 HDD/dev_hdd0/...', PS3_HDD_AREA): a client puts them in its own Updates and DLC\PS3\dev_hdd0 (or in its
   * old roms\PS3 HDD while RPCS3 still uses that one: activePs3HddDir).
   */
  async function romAreas(): Promise<RomArea[]> {
    return deps.emulationDir
      ? [
          {
            name: PS3_HDD_AREA,
            dir: await activePs3HddDir(deps.emulationDir()),
            allows: isPs3HddTransferPath
          },
          {
            name: TEXTURE_AREA,
            dir: texturePacksDir(deps.emulationDir()),
            allows: isTexturePackTransferPath,
            // A texture file already on this PC (its own pack, or one edited here) is never replaced.
            keepExisting: true
          }
        ]
      : []
  }

  /**
   * A ROM game's set also holds its texture packs: the folders of Emulation\texturepacks\<emulator> named after its
   * serial or id ('Texture Packs/pcsx2/SLUS-20777/...', texture-packs.ts), which a client puts in its own texturepacks.
   * A game whose id cannot be found goes without them.
   */
  async function withTexturePacks(
    game: Game,
    romsRoot: string,
    set: RomFileSet
  ): Promise<{ set: RomFileSet; idsComplete: boolean }> {
    if (game.launch.kind !== 'emulator' || !deps.emulationDir) return { set, idsComplete: true }
    const systemId = game.launch.systemId
    const kind = gameIdKindOf(systemId)
    if (!kind) return { set, idsComplete: true }
    const texDir = texturePacksDir(deps.emulationDir())
    const romPath = romGamePath(game, romsRoot)
    const add = async (ids: string[]): Promise<RomFileSet> => {
      if (!ids.length) return set
      const extra = await texturePackFiles(texDir, systemId, ids)
      if (!extra.length) return set
      const seen = new Set(set.files.map((f) => f.path.toLowerCase()))
      const files = [...set.files]
      for (const file of extra) {
        const path = `${TEXTURE_AREA}/${file.path}`
        if (seen.has(path.toLowerCase())) continue
        seen.add(path.toLowerCase())
        files.push({ path, size: file.size })
      }
      log.info(
        `texture packs: ${files.length - set.files.length} file(s) of ${ids.join(', ')} go with ${game.title}`
      )
      return { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }
    }
    // Bounded: past the deadline the image reads stop, and the game goes with what its file and folder names give
    // rather than hold the list. The outer limit is only a backstop above it (a stuck disk).
    const deadlineMs = deps.gameIdTimeoutMs ?? GAME_ID_TIMEOUT_MS
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), deadlineMs)
    try {
      const read = await withTimeout(
        gameIds.idsChecked(romPath, kind, deadline.signal),
        deadlineMs + GAME_ID_BACKSTOP_MS,
        'reading the game id'
      )
      return { set: await add(read.ids), idsComplete: read.complete }
    } catch (err) {
      log.warn(`texture packs of ${game.title}: ${message(err)}`)
      try {
        const names = [basename(romPath), basename(dirname(romPath))]
        return { set: await add(names.flatMap((n) => idsFromName(n, kind))), idsComplete: false }
      } catch {
        return { set, idsComplete: false }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A PS3 game's set also holds what RPCS3 installed for it in the PS3 HDD (its updates, DLC and their licenses), so
   * the client gets them with the game. A game whose serial cannot be read goes without them.
   */
  async function withPs3Hdd(game: Game, romsRoot: string, set: RomFileSet): Promise<RomFileSet> {
    if (game.launch.kind !== 'emulator' || game.launch.systemId !== 'ps3' || !deps.emulationDir)
      return set
    try {
      const ids = await ps3TitleIds(romGamePath(game, romsRoot))
      if (!ids.length) {
        log.info(`PS3 HDD: no serial found for ${game.title}; its updates and DLC are not offered`)
        return set
      }
      const extra = await ps3HddFiles(await activePs3HddDir(deps.emulationDir()), ids)
      const seen = new Set(set.files.map((f) => f.path.toLowerCase()))
      const files = [...set.files]
      for (const file of extra) {
        const path = `${PS3_HDD_AREA}/${file.path}`
        if (seen.has(path.toLowerCase())) continue
        seen.add(path.toLowerCase())
        files.push({ path, size: file.size, mtimeMs: file.mtimeMs })
      }
      if (files.length > set.files.length)
        log.info(
          `PS3 HDD: ${files.length - set.files.length} file(s) of ${ids.join(', ')} go with ${game.title}`
        )
      return { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }
    } catch (err) {
      log.warn(`PS3 HDD files of ${game.title}: ${message(err)}`)
      return set
    }
  }

  async function ensureSunshineRunning(): Promise<void> {
    if (sunshine.running()) return
    if (!settings.get().streaming.hostEnabled)
      throw new Error(tMain('mainStreaming.host.turnedOff'))
    await sunshine.start()
    await revokeSunshinePairings()
  }

  /**
   * A removed client must not keep its Moonlight pairing with Sunshine: it could point Moonlight at Sunshine directly.
   * Sunshine forgets every Moonlight client; the PCs still paired with PlayOut pair Moonlight again on their own when
   * they next stream. Without a running Sunshine the revocation is saved and done right after its next start.
   */
  async function revokeSunshinePairings(): Promise<void> {
    if (!store.get().sunshineUnpairPending) return
    if (!sunshine.running()) return
    try {
      await sunshine.unpairAll()
      log.info('Sunshine: Moonlight pairings revoked')
      await store.update((d) => {
        d.sunshineUnpairPending = false
      })
    } catch (err) {
      log.warn(
        `Sunshine: could not revoke Moonlight pairings (retried at its next start): ${message(err)}`
      )
    }
  }

  /** Drop a paired client (Settings' Remove, or its own /v1/unpair) and revoke its Moonlight pairing with Sunshine. */
  async function forgetClient(clientId: string): Promise<void> {
    await store.update((d) => {
      d.clients = d.clients.filter((c) => c.id !== clientId)
      d.sunshineUnpairPending = true
    })
    lastSeenWritten.delete(clientId)
    launchErrors.delete(clientId)
    // The last played dates it sent for the other clients (recency-relay.ts) go with it.
    recencyRelay.forget(clientId)
    if (armed?.clientId === clientId) armed = null
    if (emulationSync && deps.emulationDir)
      await emulationSync.host.forgetClient(clientId, deps.emulationDir()).catch(() => {})
    await revokeSunshinePairings()
  }

  // --- the Emulation folder sync, host side ---------------------------------------------------------------------

  /** The Emulation folder and what is left out of it, as this PC has them now. */
  function emulationFolder(): { root: string; scope: ReturnType<typeof scopeFor> } {
    const root = deps.emulationDir!()
    return { root, scope: scopeFor(root, settings.get().library.romsRoot) }
  }

  /** Refuses (SyncRefused) when this host does not sync with `ctx` right now. */
  function emulationGuard(ctx: RequestContext): void {
    touchClient(ctx)
    if (!emulationSync || isMyHost(ctx)) throw new SyncRefused(404, 'not-found')
    if (!settings.get().streaming.syncEmulation) throw new SyncRefused(403, 'sync-off')
    // Not while a game runs here (played here or streamed to a client): its saves are being written.
    if (deps.launcher.running() || host.streaming) throw new SyncRefused(409, 'busy')
    // The Emulation folder is being moved.
    if (emuHolds > 0) throw new SyncRefused(409, 'busy')
  }

  const handlers: HostHandlers = {
    info: () => ({
      id: identity,
      name: hostName,
      version: deps.appVersion,
      fingerprint: certificate?.fingerprint ?? '',
      // Not whether a PIN is showing: that would tell anyone on the port when to send wrong PINs.
      externalIp: host.portForwarding.externalIp
    }),

    async pair({ clientId, clientName, proof, address }) {
      // Client ids end up in remote ids and file names on the other side; ours are UUIDs.
      if (!HOST_ID.test(clientId) || !certificate) return { ok: false, error: 'not-pairing' }
      const result = pairing.verify(proof, certificate.fingerprint, clientId, address)
      if (result !== 'ok') {
        emitStatus()
        const error = result === 'wrong' ? 'wrong-pin' : result === 'none' ? 'not-pairing' : result
        return { ok: false, error }
      }
      // This PC is that computer's client already: it may not become its host too (it would see this PC's games).
      // Asked only after the PIN checked out, so nobody learns which computers this PC is a client of.
      if (store.get().hosts.some((h) => h.id === clientId)) return { ok: false, error: 'is-host' }
      if (pinTimer) clearTimeout(pinTimer)
      const token = newToken()
      const at = iso(now())
      await store.update((d) => {
        d.clients = d.clients.filter((c) => c.id !== clientId)
        d.clients.push({
          id: clientId,
          name: clientName.slice(0, 128),
          tokenHash: hashToken(token),
          pairedAt: at,
          lastSeen: at,
          address
        })
      })
      emitStatus()
      return {
        ok: true,
        hostId: identity,
        hostName,
        token,
        externalIp: host.portForwarding.externalIp
      }
    },

    async library(ctx) {
      touchClient(ctx)
      // A computer this PC is a client of never sees this PC's games (the library goes host to client only).
      if (isMyHost(ctx)) return []
      const offer = hostOffer(
        library.games().map((g) => offeredMetadata(g, library.cloudFields?.(g)))
      )
      // This PC's favourites only while it syncs them (a client shows them on host-only games), and when its games
      // were last played only while it syncs play time (a client's Recent row and Recently played go by it).
      const { syncFavorites, syncPlaytime } = settings.get().streaming
      if (syncFavorites && syncPlaytime) return offer
      return offer.map((g) => {
        const copy = { ...g }
        if (!syncFavorites) {
          copy.favorite = false
          delete copy.favoriteAt
        }
        if (!syncPlaytime) delete copy.lastPlayed
        return copy
      })
    },

    async scan(ctx) {
      touchClient(ctx)
      if (isMyHost(ctx) || hostScan || now() - hostScanEndedAt < HOST_SCAN_GAP_MS) return
      log.info(`${ctx.client.name} asked for a library scan`)
      hostScan = deps.scan
        .run()
        .then(() => undefined)
        .catch((err) => log.warn(`library scan for ${ctx.client.name} failed: ${message(err)}`))
        .finally(() => {
          hostScan = null
          hostScanEndedAt = now()
        })
    },

    async scanStatus() {
      return { running: hostScan !== null }
    },

    async media(ctx, gameId, kind) {
      if (isMyHost(ctx)) return null
      const game = offeredGame(gameId)
      const url = game ? mediaUrl(game, kind) : undefined
      const file = url?.startsWith('media://cache/') ? deps.mediaFile(url) : null
      return file ? { file } : null
    },

    async romFiles(ctx, gameId, options = {}) {
      if (isMyHost(ctx)) return null
      const game = offeredGame(gameId)
      const romsRoot = settings.get().library.romsRoot
      // A card kept for its recompilation (Game.romRemoved), or a recompilation's own card, has no file to send.
      if (!game || game.source !== 'rom' || game.romRemoved || playsOnlyRecomp(game) || !romsRoot)
        return null
      try {
        const set = await romSet(game, romsRoot)
        // An older client: without the areas it does not know (see HostHandlers.romFiles); it would put their files
        // inside its ROM folder.
        const unknown = [
          ...(options.ps3Hdd ? [] : [PS3_HDD_AREA]),
          ...(options.textures ? [] : [TEXTURE_AREA])
        ].map((area) => `${area.toLowerCase()}/`)
        if (!unknown.length) return set
        const files = set.files.filter((f) => {
          const path = f.path.toLowerCase()
          return !unknown.some((prefix) => path.startsWith(prefix))
        })
        return files.length === set.files.length
          ? set
          : { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }
      } catch (err) {
        log.warn(`ROM files of ${gameId}: ${message(err)}`)
        return null
      }
    },

    async romFile(ctx, gameId, path) {
      if (isMyHost(ctx)) return null
      const game = offeredGame(gameId)
      const romsRoot = settings.get().library.romsRoot
      // A card kept for its recompilation (Game.romRemoved), or a recompilation's own card, has no file to send.
      if (!game || game.source !== 'rom' || game.romRemoved || playsOnlyRecomp(game) || !romsRoot)
        return null
      try {
        return (
          await openRomFile(game, romsRoot, path, await romSet(game, romsRoot), await romAreas())
        ).path
      } catch {
        return null
      }
    },

    async prepareStream(ctx, gameId) {
      touchClient(ctx)
      const game = offeredGame(gameId)
      if (!game)
        return {
          ok: false,
          error: 'not-installed',
          message: tMain('mainStreaming.host.gameNotInstalledOn', { name: hostName })
        }
      const running = launcher.running()
      const active = pipe?.active() ?? null
      if ((running && running.gameId !== gameId) || (active && active !== gameId))
        return {
          ok: false,
          error: 'busy',
          message: tMain('mainStreaming.host.busyOtherGame', { name: hostName })
        }
      // Another PC's stream, or its start in progress, is neither taken over nor ended from here.
      const otherClient =
        (streamingClientId !== null && streamingClientId !== ctx.client.id) ||
        (armed !== null && armed.clientId !== ctx.client.id && armed.expiresAt >= now())
      if (otherClient)
        return {
          ok: false,
          error: 'busy',
          message: tMain('mainStreaming.host.busyOtherClient', { name: hostName })
        }
      // A new start: an older failure no longer describes it.
      launchErrors.delete(ctx.client.id)
      armed = {
        gameId,
        clientId: ctx.client.id,
        clientName: ctx.client.name,
        expiresAt: now() + ARM_MS
      }
      try {
        await ensureSunshineRunning()
      } catch (err) {
        return {
          ok: false,
          error: 'sunshine',
          message: tMain('mainStreaming.host.notReady', { name: hostName, error: message(err) })
        }
      }
      log.info(`stream of ${gameId} prepared for ${ctx.client.name}`)
      // Not refused: the ports may be forwarded by hand. The client adds this to its error if Moonlight fails.
      const pf = host.portForwarding
      const warning =
        pf.state === 'mapped' && pf.error && !isLanAddress(ctx.address)
          ? tMain('mainStreaming.host.portsWarning', { name: hostName })
          : undefined
      return warning
        ? { ok: true, sunshinePort: SUNSHINE_DEFAULT_PORT, warning }
        : { ok: true, sunshinePort: SUNSHINE_DEFAULT_PORT }
    },

    async stopStream(ctx) {
      // Only the caller's own start or stream: another paired PC's Stop never ends it.
      if (armed?.clientId === ctx.client.id) armed = null
      if (streamingClientId !== ctx.client.id) return
      await sunshine.closeApp().catch((err) => log.debug(`Sunshine close app: ${message(err)}`))
      const active = pipe?.active()
      if (active) await launcher.stop(active)
    },

    logins(ctx) {
      // Never to a PC that is this PC's own host, and only while sharing them is on.
      if (isMyHost(ctx)) return null
      const s = settings.get()
      return s.streaming.shareLogins ? loginsToShare(s.scrapers) : null
    },

    libraryTabs(ctx, body) {
      touchClient(ctx)
      // Not with a PC that is this PC's own host (a pairing both ways), and only while the sync is on here.
      if (!tabsSync || !tabsLoaded || isMyHost(ctx)) return null
      if (!settings.get().streaming.syncLibraryTabs) return null
      const t = now()
      const theirNow = typeof body.now === 'number' && Number.isFinite(body.now) ? body.now : t
      tabsSync.offer(body.doc, { name: ctx.client.name, isHost: false, skewMs: theirNow - t })
      const doc = tabsSync.doc()
      return doc ? { doc, now: now() } : null
    },

    favorites(ctx, body) {
      touchClient(ctx)
      // Not with a PC that is this PC's own host (a pairing both ways), and only while the sync is on here.
      if (!library.setSyncedFavorite || isMyHost(ctx)) return null
      if (!settings.get().streaming.syncFavorites) return null
      const t = now()
      const theirNow = typeof body.now === 'number' && Number.isFinite(body.now) ? body.now : t
      const entries = parseFavoriteEntries(body.entries, t, theirNow - t) ?? []
      let taken = 0
      for (const e of entries) {
        // Only a game this PC offers (a hidden or uninstalled one is not the caller's to change).
        const game = offeredGame(e.id)
        if (!game) continue
        const mine = { favorite: game.favorite, at: favoriteAtMs(game) }
        if (pickFavorite(mine, e, false) !== 'theirs') continue
        if (library.setSyncedFavorite(game.id, e.favorite, e.at)) taken++
      }
      if (taken)
        log.info(`Favourites taken from ${ctx.client.name}: ${taken} game${taken === 1 ? '' : 's'}`)
      return { entries: offeredFavorites(), now: now() }
    },

    async achievements(ctx, gameId) {
      touchClient(ctx)
      // Not to a PC that is this PC's own host (it gets none of this PC's games), and only of a game this PC offers.
      if (!deps.achievements || isMyHost(ctx)) return null
      const game = offeredGame(gameId)
      if (!game) return null
      return deps.achievements.get(game.id)
    },

    playtime(ctx, body) {
      touchClient(ctx)
      // Not with a PC that is this PC's own host (a pairing both ways), and only while the sync is on here.
      if (!library.allSessions || !library.addSyncedSessions || isMyHost(ctx)) return null
      if (!settings.get().streaming.syncPlaytime) return null
      const t = now()
      const theirNow = typeof body.now === 'number' && Number.isFinite(body.now) ? body.now : t
      // The caller's sessions: of games this PC offers (a hidden or uninstalled one is not the caller's to change).
      let took = 0
      if (body.sessions !== undefined) {
        const add: SyncedSession[] = []
        for (const s of parseWireSessions(body.sessions, t, theirNow - t) ?? []) {
          const game = offeredGame(s.game)
          if (game) add.push({ ...s, gameId: game.id })
        }
        took = add.length ? library.addSyncedSessions(add, ctx.client.id) : 0
        if (took)
          log.info(
            `Play time taken from ${ctx.client.name}: ${took} session${took === 1 ? '' : 's'}`
          )
      }
      // This PC's sessions of the games the caller asks for (never those taken from the caller), a page at a time.
      const offeredAs = new Map<string, string>()
      for (const id of parseGameIds(body.games) ?? []) {
        const game = offeredGame(id)
        if (game && !offeredAs.has(game.id)) offeredAs.set(game.id, id)
      }
      // The caller's last played of the store games this PC does not offer (no session can cross for those), and the
      // other PCs' for it: recency-relay.ts.
      const recent =
        body.recent !== undefined ? relayRecency(ctx, body.recent, body.want, t, theirNow) : null
      const after = parseCursor(body.after)
      const { page, next, more } = offeredAs.size
        ? sessionsAfter(
            library.allSessions(),
            (s) => s.from !== ctx.client.id && offeredAs.has(s.gameId),
            after
          )
        : { page: [], next: after, more: false }
      return {
        took,
        sessions: page.map((s) => toWire(s, offeredAs.get(s.gameId)!, library.getGame(s.gameId))),
        next,
        more,
        now: now(),
        ...(recent ? { recent } : {})
      }
    },

    async streamStatus(ctx) {
      const e = launchErrors.get(ctx.client.id)
      launchErrors.delete(ctx.client.id)
      if (!e || now() - e.at > LAUNCH_ERROR_KEEP_MS) return {}
      return { lastError: { gameId: e.gameId, message: e.message } }
    },

    async moonlightPair(ctx, pin) {
      // Only the PIN the authenticated client sent: it made a fresh one for this pairing.
      if (!pin || !isMoonlightPin(pin))
        return { ok: false, error: tMain('mainStreaming.host.pinNeeded') }
      try {
        await ensureSunshineRunning()
      } catch (err) {
        return {
          ok: false,
          error: tMain('mainStreaming.host.notReadyLower', { name: hostName, error: message(err) })
        }
      }
      const ok = await sunshine.approvePairing({
        clientAddress: ctx.address,
        pin,
        name: ctx.client.name,
        timeoutMs: 90_000
      })
      return ok ? { ok: true } : { ok: false, error: tMain('mainStreaming.host.pairingTimeout') }
    },

    async unpair(ctx) {
      await forgetClient(ctx.client.id)
      emitStatus()
    },

    async emulationManifest(ctx) {
      emulationGuard(ctx)
      const { root, scope } = emulationFolder()
      try {
        return await emulationSync!.host.manifest(root, scope)
      } catch (err) {
        if (err instanceof ScanError) throw new SyncRefused(503, 'folder', err.message)
        throw err
      }
    },
    async emulationFile(ctx, path) {
      emulationGuard(ctx)
      const { root, scope } = emulationFolder()
      return emulationSync!.host.file(root, scope, path)
    },
    async emulationUpload(ctx, upload) {
      emulationGuard(ctx)
      const { root } = emulationFolder()
      await emulationSync!.host.uploadChunk(
        ctx.client.id,
        root,
        upload.id,
        upload.offset,
        upload.total,
        upload.data
      )
    },
    async emulationCommit(ctx, commit) {
      emulationGuard(ctx)
      const { root, scope } = emulationFolder()
      await emulationSync!.host.commit(ctx.client.id, root, scope, commit)
      deps.onEmulationFilesChanged?.([commit.path])
    },
    async emulationDelete(ctx, request) {
      emulationGuard(ctx)
      const { root, scope } = emulationFolder()
      await emulationSync!.host.remove(ctx.client.id, root, scope, request)
      deps.onEmulationFilesChanged?.([request.path])
    }
  }

  function clearStreaming(): void {
    streamingClientId = null
    if (!host.streaming) return
    host.streaming = null
    emitStatus()
  }

  const waiter = sessionEndWaiter({ events, running: () => launcher.running() })

  async function onRun(): Promise<{ gameId: string } | { error: string }> {
    const a = armed
    armed = null
    if (!a || a.expiresAt < now()) return { error: tMain('mainStreaming.host.nothingToStart') }
    // Kept for the client: all it sees of a failure here is Moonlight closing.
    const fail = (text: string): { error: string } => {
      // The first line is the reason; the rest (e.g. every folder searched for an emulator) is for the host's log.
      const reason = text.split(/\r?\n/)[0]?.trim() || text
      launchErrors.set(a.clientId, { gameId: a.gameId, message: reason, at: now() })
      log.warn(`stream of ${a.gameId} for ${a.clientName} could not start: ${text}`)
      return { error: text }
    }
    const game = offeredGame(a.gameId)
    if (!game) return fail(tMain('mainStreaming.host.gameGone'))
    const running = launcher.running()
    if (running && running.gameId !== game.id)
      return fail(tMain('mainStreaming.host.otherGameRunning'))
    if (!running) {
      // A card kept for its recompilation, or a recompilation's own card, starts the recompilation (there is no ROM for
      // an emulator).
      const result =
        game.romRemoved || playsOnlyRecomp(game)
          ? await keptLaunch(game)
          : await launcher.launch(game, { streamed: true }).catch((err: unknown) => ({
              ok: false as const,
              error: { message: message(err) }
            }))
      if (!result.ok)
        return fail(result.error?.message ?? tMain('mainStreaming.host.gameCouldNotStart'))
    }
    streamingClientId = a.clientId
    host.streaming = { clientName: a.clientName, gameId: game.id, title: displayTitle(game) }
    emitStatus()
    return { gameId: game.id }
  }

  /** Apply Settings > Streaming's host switch and port; settles when that change is done. */
  function applyHostSetting(): Promise<void> {
    if (!started || disposed) return hostTask
    const s = settings.get().streaming
    const want = { enabled: s.hostEnabled && !suspended, port: s.hostPort }
    if (want.enabled === applied.enabled && (!want.enabled || want.port === applied.port))
      return hostTask
    applied = want
    const gen = ++hostGen
    // Off (or asleep): close the listeners and the port forwarding now, not after a start still in progress (its UPnP
    // discovery or first Sunshine download can take minutes). That start sees `gen` changed and stops at its next step.
    if (!want.enabled) void stopHost()
    // Steps of a start that was overtaken check `gen` and stop; the queue then closes whatever they opened.
    hostTask = hostTask
      .then(async () => {
        await stopHost()
        if (want.enabled && gen === hostGen && !disposed) await startHost(want.port, gen)
      })
      .catch((err) => log.error('streaming host change failed', err))
    return hostTask
  }

  async function startHost(port: number, gen: number): Promise<void> {
    const stale = (): boolean => gen !== hostGen || disposed
    host.state = 'starting'
    host.error = undefined
    emitStatus()
    log.info(`host: starting on port ${port}`)

    try {
      certificate = await io.certificate(join(deps.dataDir, 'host'))
    } catch (err) {
      if (stale()) return
      return failHost(tMain('mainStreaming.host.certificate', { error: message(err) }))
    }
    if (stale()) return
    const srv = io.createHostServer({
      tls: certificate,
      port,
      host: '0.0.0.0',
      log,
      auth,
      handlers
    })
    try {
      await srv.listen()
    } catch (err) {
      if (stale()) return
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      return failHost(
        busy
          ? tMain('mainStreaming.host.portInUse', { port })
          : tMain('mainStreaming.host.couldNotStart', { error: message(err) })
      )
    }
    if (stale()) return void (await srv.close())
    server = srv

    const problems: string[] = []
    // In parallel with the rest: the admin prompt (when the rules are missing) must not hold up Sunshine or the start.
    const firewall: Promise<FirewallResult> = deps.firewall
      ? deps.firewall.ensure(port, port + 1).catch(() => 'unknown' as const)
      : Promise.resolve('ok')
    const resp = io.createDiscoveryResponder({
      port: port + 1,
      log,
      info: () => ({
        id: identity,
        name: hostName,
        port: server?.port ?? port,
        fingerprint: certificate?.fingerprint ?? ''
      })
    })
    try {
      await resp.start()
      if (stale()) return void (await resp.stop())
      responder = resp
    } catch (err) {
      problems.push(tMain('mainStreaming.host.discovery', { port: port + 1, error: message(err) }))
    }

    try {
      const token = await io.ensureLaunchToken(deps.launchTokenFile)
      const p = io.createStreamLaunchServer({
        pipeName: deps.pipeName,
        token,
        log,
        onRun,
        waitEnded: async (gameId, signal) => {
          try {
            await waiter(gameId, signal)
          } finally {
            clearStreaming()
          }
        },
        onClientGone: async (gameId) => {
          try {
            await launcher.stop(gameId)
          } finally {
            clearStreaming()
          }
        }
      })
      await p.listen()
      if (stale()) return void (await p.close())
      pipe = p
    } catch (err) {
      problems.push(tMain('mainStreaming.host.launchPipe', { error: message(err) }))
    }

    host.portForwarding = { state: 'checking' }
    emitStatus()
    const mapped = await mapPort(port, stale)
    if (stale()) return
    // No router mapping: this PC's internet address is still looked up, so clients paired at home learn where to find
    // it from outside (it works once the user forwards the port on the router by hand). Not behind a second router or
    // the provider's shared address: nothing would get in.
    if (
      !mapped &&
      host.portForwarding.state === 'unavailable' &&
      host.portForwarding.error !== doubleNatText()
    ) {
      const ip = await io.publicIp().catch(() => null)
      if (stale()) return
      if (ip && !isLanAddress(ip)) host.portForwarding = { ...host.portForwarding, externalIp: ip }
    }
    emitStatus()

    // Sunshine last: its download can take a while, and pairing and ROM downloads already work without it.
    try {
      await sunshine.ensureInstalled()
      if (stale()) return
      // Sunshine's own UPnP stays off (a force-ended Sunshine never deletes its mappings): mapPort forwarded its ports.
      await sunshine.configure({ name: `PlayOut ${hostName}`, appCommand: deps.appCommand })
      await sunshine.ensureCredentials()
      if (stale()) return
      await sunshine.start()
      if (stale()) return void (await sunshine.stop())
      await revokeSunshinePairings()
    } catch (err) {
      problems.push(`Sunshine: ${message(err)}.`)
    }
    host.controllerDriver = await sunshine.controllerDriverInstalled().catch(() => false)
    if (stale()) return
    const finish = (result: FirewallResult | null): void => {
      const blocked = result && firewallProblem(result, port)
      const all = blocked ? [...problems, blocked] : problems
      host.state = all.length ? 'error' : 'ready'
      host.error = all.length ? all.join(' ') : undefined
      log.info(`host: ${host.state}${host.error ? ` (${host.error})` : ''}`)
      emitStatus()
    }
    // The admin prompt (up to 30 min unanswered) never holds this start or the next one: its result is added later.
    const settled = await Promise.race([firewall, Promise.resolve(null)])
    finish(settled)
    if (settled === null)
      void firewall.then((result) => {
        if (!stale() && firewallProblem(result, port)) finish(result)
      })
  }

  function failHost(text: string): void {
    log.warn(`host: ${text}`)
    host.state = 'error'
    host.error = text
    emitStatus()
  }

  /** UPnP: forward the host port, so clients can come in over the internet. True when it is mapped. */
  async function mapPort(port: number, stale: () => boolean): Promise<boolean> {
    let gw: UpnpGateway | null = null
    try {
      gw = await io.upnp.discover()
    } catch (err) {
      log.warn(`UPnP discovery failed: ${message(err)}`)
    }
    if (stale()) return false
    if (!gw) {
      host.portForwarding = { state: 'unavailable' }
      return false
    }
    // Mappings an earlier run could only make permanent: gone first, so none piles up on the router.
    const leftovers = store.get().permanentMappings
    if (leftovers.length) {
      for (const m of leftovers) await gw.deletePortMapping(m).catch(() => undefined)
      await store.update((d) => {
        d.permanentMappings = []
      })
    }
    const internalClient = io.internalClient(gw.host)
    if (!internalClient) {
      host.portForwarding = {
        state: 'unavailable',
        error: tMain('mainStreaming.router.noAddress')
      }
      return false
    }
    const request = (
      protocol: PortProtocol,
      p: number,
      description: string
    ): PortMappingRequest => ({
      protocol,
      externalPort: p,
      internalPort: p,
      internalClient,
      description,
      leaseSeconds: LEASE_SECONDS
    })
    const g: UpnpGateway = gw
    /** Map one port (throws when the router refuses); 'stale' when hosting went off meanwhile: the mapping is gone again. */
    const add = async (req: PortMappingRequest): Promise<'mapped' | 'stale'> => {
      const { leaseSeconds } = await g.addPortMapping(req)
      if (leaseSeconds > 0) shortestLease = Math.min(shortestLease, leaseSeconds)
      if (stale()) {
        // Turned off or quitting while the router answered: nothing may stay forwarded, nor be recorded as ours.
        await g
          .deletePortMapping({ protocol: req.protocol, externalPort: req.externalPort })
          .catch(() => undefined)
        return 'stale'
      }
      gateway = g
      mappings.push({
        protocol: req.protocol,
        externalPort: req.externalPort,
        permanent: leaseSeconds === 0
      })
      if (leaseSeconds === 0)
        await store.update((d) => {
          d.permanentMappings.push({ protocol: req.protocol, externalPort: req.externalPort })
        })
      else leased.push(req)
      return 'mapped'
    }
    const leased: PortMappingRequest[] = []
    /** The shortest lease the router granted (NAT-PMP routers may grant less than asked): renewed at half of it. */
    let shortestLease = Infinity
    try {
      if ((await add(request('TCP', port, 'PlayOut host'))) === 'stale') return false
    } catch (err) {
      log.warn(`UPnP port mapping failed: ${message(err)}`)
      host.portForwarding = {
        state: 'unavailable',
        error: tMain('mainStreaming.router.refused')
      }
      return false
    }
    // Sunshine's GameStream ports, which its own UPnP would map but never delete when it is ended by force.
    let streamPortsMissing = 0
    for (const [protocol, p] of sunshinePorts(SUNSHINE_DEFAULT_PORT)) {
      try {
        if ((await add(request(protocol, p, 'PlayOut streaming'))) === 'stale') return false
      } catch (err) {
        streamPortsMissing++
        log.warn(`UPnP: ${protocol} ${p} for Sunshine not forwarded: ${message(err)}`)
      }
    }
    // A stop that came in meanwhile released what was mapped: a renew timer now would map it again.
    if (stale()) return false
    if (leased.length) {
      renewTimer = setInterval(
        () => {
          for (const req of leased)
            g.addPortMapping(req).catch((err) => log.warn(`UPnP renew: ${message(err)}`))
        },
        Math.min(RENEW_MS, Math.max(60, shortestLease) * 500)
      )
      renewTimer.unref?.()
    }
    let externalIp: string | undefined
    try {
      externalIp = await g.externalIp()
    } catch (err) {
      log.warn(`UPnP external address: ${message(err)}`)
    }
    if (stale()) return false
    // The router's own "internet" address is private or shared (CGNAT, 100.64/10): another router or the provider
    // sits in front of it, and nothing from the internet gets in however much this router forwards.
    if (externalIp && isLanAddress(externalIp)) {
      log.warn(
        `UPnP: the router's internet address ${externalIp} is not public (double NAT or CGNAT)`
      )
      await releaseMapping()
      host.portForwarding = { state: 'unavailable', error: doubleNatText() }
      return false
    }
    host.portForwarding = streamPortsMissing
      ? { state: 'mapped', externalIp, error: streamPortsText() }
      : { state: 'mapped', externalIp }
    log.info(`UPnP: port ${port} forwarded${externalIp ? ` (internet address ${externalIp})` : ''}`)
    return true
  }

  async function releaseMapping(): Promise<void> {
    if (renewTimer) clearInterval(renewTimer)
    renewTimer = null
    const gw = gateway
    const list = mappings
    gateway = null
    mappings = []
    if (!gw || !list.length) return
    const results = await Promise.allSettled(
      list.map(async (m) => {
        await withTimeout(
          gw.deletePortMapping({ protocol: m.protocol, externalPort: m.externalPort }),
          MAPPING_DELETE_WAIT_MS,
          'removing the port forwarding'
        )
        return m
      })
    )
    for (const r of results) if (r.status === 'rejected') log.warn(`UPnP: ${message(r.reason)}`)
    const removed = results
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((m): m is (typeof list)[number] => m !== null && m.permanent)
    if (removed.length)
      await store
        .update((d) => {
          d.permanentMappings = d.permanentMappings.filter(
            (x) =>
              !removed.some((m) => m.protocol === x.protocol && m.externalPort === x.externalPort)
          )
        })
        .catch((err) => log.warn(`UPnP: ${message(err)}`))
  }

  async function stopHost(): Promise<void> {
    pairing.cancel()
    if (pinTimer) clearTimeout(pinTimer)
    pinTimer = null
    armed = null
    const s = server
    const r = responder
    const p = pipe
    server = null
    responder = null
    pipe = null
    await Promise.allSettled([s?.close(), r?.stop(), p?.close(), sunshine.stop(), releaseMapping()])
    if (s) log.info('host: stopped')
    host.state = 'off'
    host.error = undefined
    host.portForwarding = { state: 'off' }
    host.streaming = null
    streamingClientId = null
    emitStatus()
  }

  // =================================================================================================================
  // Client side
  // =================================================================================================================

  /** The first of the host's addresses that answers (the one that worked last first). */
  async function reach(h: StoredHost): Promise<{ conn: HostConnection; address: string }> {
    const rt = runtime(h.id)
    const known = [h.lanAddress, h.wanAddress].filter((a): a is string => !!a)
    const candidates = [
      ...new Set([rt.preferred, ...known].filter((a): a is string => !!a))
    ].filter((a) => known.includes(a))
    if (!candidates.length)
      throw new Error(tMain('mainStreaming.hosts.noAddress', { name: h.name }))
    let last: unknown = null
    const errors: string[] = []
    for (const address of candidates) {
      const conn = io.hostClient.connect({
        address,
        port: h.port,
        fingerprint: h.fingerprint,
        token: h.token
      })
      try {
        const info = await conn.info()
        if (info.id !== h.id)
          throw new Error(tMain('mainStreaming.hosts.otherComputer', { address }))
        rt.preferred = address
        rt.lastWarn = undefined
        hostSeen(h)
        // Reached outside a refresh (a stream, a download, Scan's media) while shown offline: its games and the
        // "cannot be reached" note are brought up to date now, not at the next refresh.
        if (!rt.online && !refreshing && started && !disposed) void refreshRemote()
        await learnWanAddress(h, info.externalIp)
        return { conn, address }
      } catch (err) {
        last = err
        errors.push(
          `${address === h.lanAddress ? 'home network' : 'internet'} ${address}: ${message(err)}`
        )
      }
    }
    if (last instanceof CertificateMismatchError) throw last
    // Every address's error: the last one alone (the internet address, refused from inside the same home) hid why the
    // home-network address did not answer.
    const warning = `${h.name} cannot be reached (${errors.join('; ')})`
    if (rt.lastWarn === warning) log.debug(warning)
    else log.warn(warning)
    rt.lastWarn = warning
    throw new HostUnreachableError(
      tMain('mainStreaming.hosts.offline', { name: h.name, error: friendlyNetError(last) })
    )
  }

  /**
   * The host's current internet address, from its pinned info answer: home IPs change, and a host paired on the LAN
   * before its port forwarding worked had none. A typed internet name (DNS) is kept: only an IP is replaced.
   */
  async function learnWanAddress(h: StoredHost, externalIp: string | undefined): Promise<void> {
    if (!externalIp || !isIpv4(externalIp) || isLanAddress(externalIp)) return
    if (h.wanAddress === externalIp || (h.wanAddress && !isIpv4(h.wanAddress))) return
    await store
      .update((d) => {
        const x = d.hosts.find((y) => y.id === h.id)
        if (x && (!x.wanAddress || isIpv4(x.wanAddress))) x.wanAddress = externalIp
      })
      .then(() => log.info(`${h.name}'s internet address is now known`))
      .catch((err) => log.warn(`saving ${h.name}'s internet address: ${message(err)}`))
  }

  /** That computer is also this PC's client (an old two-way pairing): its games are not taken, nor shown. */
  function isMyClient(hostId: string): boolean {
    return store.get().clients.some((c) => c.id === hostId)
  }

  const offersDir = join(deps.dataDir, 'offers')

  /**
   * The host's last offer on disk: its games still show after a restart away from it (until it answers again). With
   * the host's clock difference when it sent its clock (`{ games, skewMs }`), so its games keep their last played
   * while it is away; the bare list is the offer of a host that sent none.
   */
  async function saveOffer(hostId: string, games: unknown[], skewMs?: number): Promise<void> {
    // Not once disposed (a refresh that was still running): nothing is written to the data folder after dispose().
    if (disposed) return
    await fs.mkdir(offersDir, { recursive: true })
    const file = join(offersDir, `${hostId}.json`)
    await fs.writeFile(
      `${file}.tmp`,
      JSON.stringify(skewMs === undefined ? games : { games, skewMs })
    )
    await fs.rename(`${file}.tmp`, file)
  }

  /** The offers being written: dispose() waits for them, so none lands in the data folder after it. */
  const offerSaves = new Set<Promise<void>>()

  function saveOfferSoon(h: StoredHost, games: unknown[], skewMs?: number): void {
    const save = saveOffer(h.id, games, skewMs)
      .catch((err) => log.debug(`saving ${h.name}'s games: ${message(err)}`))
      .finally(() => offerSaves.delete(save))
    offerSaves.add(save)
  }

  async function dropSavedOffer(hostId: string): Promise<void> {
    await fs.rm(join(offersDir, `${hostId}.json`), { force: true }).catch(() => undefined)
  }

  /** The saved offers of the hosts not heard from yet this run. */
  async function loadSavedOffers(): Promise<void> {
    for (const h of store.get().hosts) {
      const rt = runtime(h.id)
      if (rt.offer || !HOST_ID.test(h.id)) continue
      try {
        const saved = JSON.parse(
          await fs.readFile(join(offersDir, `${h.id}.json`), 'utf8')
        ) as unknown
        if (rt.offer) continue
        if (Array.isArray(saved)) rt.offer = saved
        else if (saved && typeof saved === 'object') {
          const { games, skewMs } = saved as { games?: unknown; skewMs?: unknown }
          if (!Array.isArray(games)) continue
          rt.offer = games
          if (typeof skewMs === 'number' && Number.isFinite(skewMs)) rt.skewMs = skewMs
        }
      } catch {
        // None saved yet.
      }
    }
  }

  /**
   * A paired host's metadata and RetroAchievements logins, for the services this PC has none of its own for
   * (host-logins.ts). Asked whenever the host is reached; nothing changes once this PC has them. Never logged.
   */
  async function takeLogins(h: StoredHost, conn: HostConnection): Promise<void> {
    if (!deps.fillLogins) return
    // Not from a host that is also this PC's client (a pairing both ways).
    if (isMyClient(h.id)) return
    const theirs = await conn.logins()
    // This PC's logins are read after the answer, so two answers at once (pairing and a refresh) fill only once.
    const { patch, filled } = loginsToFill(settings.get().scrapers, theirs)
    if (!filled.length) return
    deps.fillLogins(patch)
    const names = filled.map((s) => SERVICE_NAMES[s]).join(', ')
    log.info(`using ${h.name}'s logins for ${names}`)
    events.emit('streaming:logins', {
      hostName: h.name,
      services: filled.map((s) => SERVICE_NAMES[s])
    })
  }

  /**
   * The Library tabs with a paired host (library-tabs-sync.ts): this PC's copy is sent, the host's comes back, and the
   * newer one wins on both PCs (a tie: the host's). Asked whenever the host is reached and shortly after the tabs
   * change here.
   */
  async function exchangeTabs(h: StoredHost, conn: HostConnection): Promise<void> {
    if (!tabsSync || !tabsLoaded || !conn.libraryTabs) return
    if (!settings.get().streaming.syncLibraryTabs || isMyClient(h.id)) return
    const doc = tabsSync.doc()
    if (!doc) return
    const sent = now()
    const answer = await conn.libraryTabs(doc, sent)
    if (!answer || disposed || !settings.get().streaming.syncLibraryTabs) return
    // The host's clock against this PC's (taken half way through the request).
    const mid = (sent + now()) / 2
    const skewMs =
      typeof answer.now === 'number' && Number.isFinite(answer.now) ? answer.now - mid : 0
    tabsSync.offer(answer.doc, { name: h.name, isHost: true, skewMs })
  }

  /**
   * The favourites with a paired host (favorites-sync.ts): the games both PCs have, matched here (the host never sees
   * this PC's games). The groups whose favourite differs from the host's offer are proposed to the host, which takes
   * the newer ones and answers with its favourites; then each group takes the host's when it is newer. Asked after
   * each refresh that reached the host, and shortly after a favourite changes here.
   */
  async function exchangeFavorites(h: StoredHost, conn: HostConnection): Promise<void> {
    if (!library.setSyncedFavorite || !conn.favorites) return
    if (!settings.get().streaming.syncFavorites || isMyClient(h.id)) return
    const offer = (runtime(h.id).offer ?? [])
      .map((raw) => sanitizeHostGame(raw))
      .filter((g): g is HostGame => g !== null)
    const groups = favoriteGroups(offer, localMatches(library.games(), offer))
    const sent = now()
    const answer = await conn.favorites(
      groups.flatMap((g) => proposals(g)).slice(0, MAX_FAVORITE_ENTRIES),
      sent
    )
    if (!answer || disposed || !settings.get().streaming.syncFavorites) return
    // The host's clock against this PC's (taken half way through the request).
    const mid = (sent + now()) / 2
    const skewMs =
      typeof answer.now === 'number' && Number.isFinite(answer.now) ? answer.now - mid : 0
    const theirs = parseFavoriteEntries(answer.entries, now(), skewMs)
    if (!theirs) {
      log.debug(`ignored ${h.name}'s favourites: not a valid list`)
      return
    }
    const byId = new Map(theirs.map((e) => [e.id, e]))
    let taken = 0
    for (const group of groups) {
      // This PC's copies as they are now (the user may have changed one meanwhile).
      const local = group.local
        .map((g) => library.getGame(g.id))
        .filter((g): g is Game => g !== undefined)
      const host = combinedStates(
        group.host.map((g) => byId.get(g.id) ?? { favorite: false, at: 0 })
      )
      if (pickFavorite(combinedFavorite(local), host, true) !== 'theirs') continue
      let changed = false
      for (const c of copiesToChange(local, host.favorite))
        changed = library.setSyncedFavorite(c.id, c.favorite, host.at) || changed
      if (changed) taken++
    }
    // The host-only games' cards show the host's favourites as they are now.
    if (patchOfferFavorites(h.id, byId)) rebuild()
    if (taken) log.info(`Favourites taken from ${h.name}: ${taken} game${taken === 1 ? '' : 's'}`)
  }

  /** The host's offer (in hand) with the favourites its answer gave; whether any changed. */
  function patchOfferFavorites(hostId: string, byId: Map<string, FavoriteEntry>): boolean {
    const offer = runtimes.get(hostId)?.offer
    if (!offer) return false
    let changed = false
    for (const raw of offer) {
      if (!raw || typeof raw !== 'object') continue
      const g = raw as { id?: unknown; favorite?: unknown }
      if (typeof g.id !== 'string') continue
      const favorite = byId.get(g.id)?.favorite ?? false
      if ((g.favorite === true) !== favorite) {
        g.favorite = favorite
        changed = true
      }
    }
    return changed
  }

  let favoritesPass: Promise<void> | null = null
  let favoritesAgain = false
  let favoritesTimer: ReturnType<typeof setTimeout> | null = null

  /** The favourites with every reachable host, one at a time (one pass at a time). */
  function exchangeFavoritesNow(): void {
    if (!library.setSyncedFavorite || disposed || suspended) return
    if (favoritesPass) {
      favoritesAgain = true
      return
    }
    favoritesPass = (async () => {
      if (!settings.get().streaming.syncFavorites) return
      const hosts = store.get().hosts.filter((h) => !isMyClient(h.id) && runtime(h.id).online)
      for (const h of hosts) {
        if (disposed || !storedHost(h.id)) continue
        try {
          const { conn } = await reach(h)
          await exchangeFavorites(h, conn)
        } catch (err) {
          log.debug(`${h.name}'s favourites: ${message(err)}`)
        }
      }
    })().finally(() => {
      favoritesPass = null
      if (favoritesAgain && !disposed) {
        favoritesAgain = false
        exchangeFavoritesNow()
      }
    })
  }

  /** A pass after `ms` (debounced: a burst of favourite changes sends once). */
  function exchangeFavoritesSoon(ms: number): void {
    if (!library.setSyncedFavorite || disposed) return
    if (favoritesTimer) clearTimeout(favoritesTimer)
    favoritesTimer = setTimeout(() => {
      favoritesTimer = null
      exchangeFavoritesNow()
    }, ms)
    favoritesTimer.unref?.()
  }

  /** setRemoteFavorite: on every host that offers the host-only game. */
  async function setRemoteFavorite(gameId: string, favorite: boolean): Promise<void> {
    await ready
    if (!settings.get().streaming.syncFavorites)
      throw new Error(tMain('mainStreaming.favourites.needSync'))
    const parsed = parseRemoteGameId(gameId)
    if (!parsed) throw new Error(tMain('mainStreaming.favourites.notHostGame'))
    const targets: { hostId: string; hostGameId: string }[] = [...(remote.alsoOnHost[gameId] ?? [])]
    if (!targets.some((t) => t.hostId === parsed.hostId)) targets.unshift(parsed)
    let done = 0
    let failure: string | null = null
    for (const t of targets) {
      const h = storedHost(t.hostId)
      if (!h || isMyClient(h.id)) continue
      try {
        const { conn } = await reach(h)
        if (!conn.favorites) continue
        const sent = now()
        const answer = await conn.favorites([{ id: t.hostGameId, favorite, at: sent }], sent)
        if (!answer) {
          failure = tMain('mainStreaming.favourites.hostOff', { name: h.name })
          continue
        }
        const entries = parseFavoriteEntries(answer.entries, now()) ?? []
        patchOfferFavorites(h.id, new Map(entries.map((e) => [e.id, e])))
        done++
      } catch (err) {
        failure = tMain('mainStreaming.hosts.unreachable', { name: h.name, error: message(err) })
      }
    }
    if (!done) throw new Error(failure ?? tMain('mainStreaming.hosts.noneOffers'))
    rebuild()
  }

  /**
   * achievementsFor: a host-only game's achievements, asked of each host that has it in turn (host-achievements.ts).
   * Only of a game shown here: none while host games are hidden, or after the host was unpaired.
   */
  async function achievementsFor(gameId: string): Promise<AchievementsInfo | null> {
    await ready
    const parsed = parseRemoteGameId(gameId)
    if (!parsed || !remote.games.some((g) => g.id === gameId)) return null
    const targets: { hostId: string; hostGameId: string }[] = [...(remote.alsoOnHost[gameId] ?? [])]
    if (!targets.some((t) => t.hostId === parsed.hostId && t.hostGameId === parsed.hostGameId))
      targets.unshift(parsed)
    let failure: string | null = null
    let asked = false
    for (const t of targets) {
      if (disposed) break
      const h = storedHost(t.hostId)
      if (!h || isMyClient(h.id)) continue
      try {
        const { conn } = await reach(h)
        if (!conn.achievements) continue
        const raw = await conn.achievements(t.hostGameId)
        asked = true
        const info = sanitizeAchievementsInfo(raw)
        if (info) return info
        if (raw) log.warn(`${h.name} sent an unreadable achievements list`)
      } catch (err) {
        failure = tMain('mainStreaming.hosts.unreachable', { name: h.name, error: message(err) })
      }
    }
    if (failure && !asked) throw new Error(failure)
    return null
  }

  /**
   * The play time with a paired host (playtime-sync.ts): the games both PCs have, matched here as the favourites are
   * (the host never sees this PC's games). This PC's ended sessions of them recorded since the last exchange (a game
   * newly matched: all of them) go to the host's copy, those taken from this host excepted; then the host's sessions of
   * them recorded since the last exchange (a game newly matched: all of them) are taken, on one copy of the game here.
   * Both PCs skip the sessions they already have (by id), so nothing counts twice and a repeat changes nothing.
   */
  async function exchangePlaytime(h: StoredHost, conn: HostConnection): Promise<void> {
    if (!playtimeState || !playtimeLoaded || !conn.playtime) return
    if (!library.allSessions || !library.addSyncedSessions) return
    if (!settings.get().streaming.syncPlaytime || isMyClient(h.id)) return
    const offer = (runtime(h.id).offer ?? [])
      .map((raw) => sanitizeHostGame(raw))
      .filter((g): g is HostGame => g !== null)
    // This PC's game -> the host copy its sessions go to; the host's game -> the copy here that takes its sessions
    // (the preferred copy, else an installed one, else the first): each session lands once. A session of a store that
    // reports an account total goes to the other side's copy of that store when there is one (copyForStore): that
    // copy's store total counts it already, so it adds no minutes there.
    const toHost = new Map<string, { group: FavoriteGroup; copy: Game }>()
    const toLocal = new Map<string, FavoriteGroup & { pick: Game }>()
    for (const g of favoriteGroups(offer, localMatches(library.games(), offer))) {
      if (!g.local.length || !g.host.length) continue
      for (const l of g.local) toHost.set(l.id, { group: g, copy: l })
      const pick =
        g.local.find((l) => l.user?.preferredCopy) ?? g.local.find((l) => l.installed) ?? g.local[0]
      for (const hg of g.host) toLocal.set(hg.id, { ...g, pick })
    }
    const wireToHost = (s: PlaySession): WireSession => {
      const { group, copy } = toHost.get(s.gameId)!
      const wire = toWire(s, group.host[0].id, copy)
      return { ...wire, game: copyForStore(group.host, wire.store, group.host[0]).id }
    }
    const state = playtimeState.get(h.id)
    const stillOn = (): boolean => !disposed && settings.get().streaming.syncPlaytime

    // The store games the host's offer does not match: no session crosses for them, their last played does
    // (recency-relay.ts). Asked first: an older host answers none, and the sessions below go on as before.
    if (!(await exchangeRecency(h, conn, (id) => !toHost.has(id))) || !stillOn()) return

    // This PC's sessions to the host: after the cursor, and every one of a game newly matched.
    const sentGames = new Set(state.sentGames)
    const mine = sessionsAfter(
      library.allSessions(),
      (s) =>
        s.from !== h.id &&
        toHost.has(s.gameId) &&
        (!sentGames.has(s.gameId) || compareCursors(cursorOf(s), state.sent) > 0),
      null,
      Number.MAX_SAFE_INTEGER
    ).page
    let sentAll = true
    for (let i = 0, round = 0; i < mine.length; i += MAX_SESSIONS_PER_REQUEST, round++) {
      if (round === MAX_PLAYTIME_ROUNDS) {
        sentAll = false
        break
      }
      const batch = mine.slice(i, i + MAX_SESSIONS_PER_REQUEST)
      const answer = await conn.playtime({
        sessions: batch.map(wireToHost),
        now: now()
      })
      // Off there, or an older PlayOut: nothing more to say to it.
      if (!answer || !stillOn()) return
      const last = cursorOf(batch[batch.length - 1])
      if (compareCursors(last, state.sent) > 0) state.sent = last
      playtimeState.set(h.id, state)
    }
    if (sentAll) {
      state.sentGames = [...toHost.keys()]
      playtimeState.set(h.id, state)
    }

    // The host's sessions to this PC.
    const games = [...toLocal.keys()].slice(0, MAX_PLAYTIME_GAMES)
    if (!games.length) return
    let taken = 0
    const pull = async (
      ids: string[],
      from: SessionCursor | null
    ): Promise<{ cursor: SessionCursor | null; done: boolean } | null> => {
      let after = from
      for (let round = 0; round < MAX_PLAYTIME_ROUNDS; round++) {
        const sent = now()
        const answer = await conn.playtime!({ games: ids, after, now: sent })
        if (!answer || !stillOn()) return null
        // The host's clock against this PC's (taken half way through the request).
        const mid = (sent + now()) / 2
        const skewMs =
          typeof answer.now === 'number' && Number.isFinite(answer.now) ? answer.now - mid : 0
        const theirs = parseWireSessions(answer.sessions, now(), skewMs)
        if (!theirs) {
          log.debug(`ignored ${h.name}'s play sessions: not a valid list`)
          return null
        }
        taken += takeSessions(h, theirs, toLocal)
        const next = parseCursor(answer.next)
        if (next && compareCursors(next, after) > 0) after = next
        else if (answer.more === true) return { cursor: after, done: false } // No progress: stop here.
        if (answer.more !== true) return { cursor: after, done: true }
      }
      return { cursor: after, done: false }
    }
    try {
      // A game newly matched: its whole history first (its own pass: the cursor is not moved by it).
      const known = new Set(state.receivedGames)
      const fresh = games.filter((id) => !known.has(id))
      if (fresh.length) {
        const all = await pull(fresh, null)
        if (!all) return
        if (all.done) for (const id of fresh) known.add(id)
      }
      const since = await pull(games, state.received)
      if (!since) return
      state.received = since.cursor
      // Games no longer matched leave the list: matched again later, their whole history is asked again.
      state.receivedGames = games.filter((id) => known.has(id))
      playtimeState.set(h.id, state)
    } finally {
      if (taken)
        log.info(`Play time taken from ${h.name}: ${taken} session${taken === 1 ? '' : 's'}`)
    }
  }

  /**
   * The last played of this PC's store games the host does not offer (`relayed`: by id), sent to the host, and what
   * its other PCs know of those games taken (it is asked about these games only: `want`): each of this PC's records
   * gets a date that is a later play than its own (isLaterPlay: one within the tolerance is this PC's own date come
   * back). Nothing is asked when this PC has no such game. False when the host does not sync play time (off there):
   * nothing more to say to it.
   */
  async function exchangeRecency(
    h: StoredHost,
    conn: HostConnection,
    relayed: (id: string) => boolean
  ): Promise<boolean> {
    if (!conn.playtime || !library.setSyncedLastPlayed) return true
    const mine = library.games().filter((g) => isStoreGameId(g.id) && relayed(g.id))
    if (!mine.length) return true
    const sent = now()
    const answer = await conn.playtime({
      recent: ownRecency(mine, () => true),
      want: mine.slice(0, MAX_RECENCY_WANTED).map((g) => g.id),
      now: sent
    })
    if (!answer) return false
    if (answer.recent === undefined || answer.recent === null) return true
    // The host's clock against this PC's (taken half way through the request).
    const mid = (sent + now()) / 2
    const skewMs =
      typeof answer.now === 'number' && Number.isFinite(answer.now) ? answer.now - mid : 0
    const theirs = parseRecency(answer.recent, now(), skewMs)
    if (!theirs) {
      log.debug(`ignored ${h.name}'s last played dates: not a valid list`)
      return true
    }
    const had = new Map(mine.map((g) => [g.id, playedAt(g)]))
    const taken = library.setSyncedLastPlayed(
      theirs
        .filter((e) => had.has(e.game) && isLaterPlay(e.at, had.get(e.game)!))
        .map((e) => ({ id: e.game, atMs: e.at }))
    )
    if (taken) log.info(`Last played taken from ${h.name}: ${taken} game${taken === 1 ? '' : 's'}`)
    return true
  }

  /** A host's sessions taken here, on the copy of each game that takes them; how many were new. */
  function takeSessions(
    h: StoredHost,
    theirs: WireSession[],
    toLocal: Map<string, { local: Game[]; pick: Game }>
  ): number {
    const add: SyncedSession[] = []
    for (const s of theirs) {
      const to = toLocal.get(s.game)
      if (to) add.push({ ...s, gameId: copyForStore(to.local, s.store, to.pick).id })
    }
    return add.length && library.addSyncedSessions ? library.addSyncedSessions(add, h.id) : 0
  }

  let playtimePass: Promise<void> | null = null
  let playtimeAgain = false
  let playtimeTimer: ReturnType<typeof setTimeout> | null = null
  let streamEndTimer: ReturnType<typeof setTimeout> | null = null

  /** The play time with every reachable host, one at a time (one pass at a time). */
  function exchangePlaytimeNow(): void {
    if (!playtimeState || !playtimeLoaded || disposed || suspended) return
    if (playtimePass) {
      playtimeAgain = true
      return
    }
    playtimePass = (async () => {
      if (!settings.get().streaming.syncPlaytime) return
      const hosts = store.get().hosts.filter((h) => !isMyClient(h.id) && runtime(h.id).online)
      for (const h of hosts) {
        if (disposed || !storedHost(h.id)) continue
        try {
          const { conn } = await reach(h)
          await exchangePlaytime(h, conn)
        } catch (err) {
          log.debug(`${h.name}'s play time: ${message(err)}`)
        }
      }
    })().finally(() => {
      playtimePass = null
      if (playtimeAgain && !disposed) {
        playtimeAgain = false
        exchangePlaytimeNow()
      }
    })
  }

  /** A pass after `ms` (debounced: several games ending close together send once). */
  function exchangePlaytimeSoon(ms: number): void {
    if (!playtimeState || disposed) return
    if (playtimeTimer) clearTimeout(playtimeTimer)
    playtimeTimer = setTimeout(() => {
      playtimeTimer = null
      exchangePlaytimeNow()
    }, ms)
    playtimeTimer.unref?.()
  }

  let tabsPass: Promise<void> | null = null
  let tabsAgain = false
  let tabsTimer: ReturnType<typeof setTimeout> | null = null

  /** The tabs with every reachable host, one at a time (one pass at a time). */
  function exchangeTabsNow(): void {
    if (!tabsSync || disposed || suspended) return
    if (tabsPass) {
      tabsAgain = true
      return
    }
    tabsPass = (async () => {
      if (!settings.get().streaming.syncLibraryTabs) return
      const hosts = store.get().hosts.filter((h) => !isMyClient(h.id) && runtime(h.id).online)
      for (const h of hosts) {
        if (disposed || !storedHost(h.id)) continue
        try {
          const { conn } = await reach(h)
          await exchangeTabs(h, conn)
        } catch (err) {
          log.debug(`${h.name}'s Library tabs: ${message(err)}`)
        }
      }
    })().finally(() => {
      tabsPass = null
      if (tabsAgain && !disposed) {
        tabsAgain = false
        exchangeTabsNow()
      }
    })
  }

  /** A pass after `ms` (debounced: a burst of tab edits sends once). */
  function exchangeTabsSoon(ms: number): void {
    if (!tabsSync || disposed) return
    if (tabsTimer) clearTimeout(tabsTimer)
    tabsTimer = setTimeout(() => {
      tabsTimer = null
      exchangeTabsNow()
    }, ms)
    tabsTimer.unref?.()
  }

  /**
   * The host's games, fetched. When it cannot be reached its last offer stays (shown, marked offline): one failed
   * request over a slow internet link must not empty the library. A host that no longer knows this PC loses it.
   */
  async function fetchOffer(h: StoredHost): Promise<boolean> {
    const rt = runtime(h.id)
    if (isMyClient(h.id)) {
      rt.online = false
      rt.offer = null
      rt.error = tMain('mainStreaming.hosts.alsoClient', { name: h.name })
      return false
    }
    try {
      const { conn } = await reach(h)
      const sent = now()
      const answer = conn.libraryAt ? await conn.libraryAt() : { games: await conn.library() }
      rt.offer = answer.games
      // The host's clock against this PC's (taken half way through the request): its games' last played are on it.
      // None from an older host: its dates are not shown (it cannot leave them out while its own sync is off).
      rt.skewMs =
        typeof answer.now === 'number' && Number.isFinite(answer.now)
          ? answer.now - (sent + now()) / 2
          : undefined
      rt.online = true
      rt.error = undefined
      saveOfferSoon(h, rt.offer, rt.skewMs)
      void takeLogins(h, conn).catch((err) => log.debug(`${h.name}'s logins: ${message(err)}`))
      void exchangeTabs(h, conn).catch((err) =>
        log.debug(`${h.name}'s Library tabs: ${message(err)}`)
      )
      return true
    } catch (err) {
      rt.online = false
      const forgotten = err instanceof HostRequestError && err.status === 401
      if (forgotten) {
        rt.offer = null
        void dropSavedOffer(h.id)
      }
      rt.error = forgotten
        ? tMain('mainStreaming.hosts.forgotThisPc', { name: h.name })
        : message(err)
      return false
    }
  }

  /**
   * A paired host's new LAN address (DHCP), learnt from discovery. Discovery answers are unauthenticated UDP (anyone on
   * the LAN can repeat a host's public id and fingerprint), so an address is only taken after a TLS connection to it,
   * pinned to the host's stored certificate, answers with the host's id.
   */
  /**
   * The paired hosts that answered discovery from the LAN address already stored for them: they are up now (the first
   * try came while their server was still starting, or a packet was lost), so they are asked again at once.
   */
  function answeredAtKnownAddress(found: FoundHost[]): string[] {
    const hosts = store.get().hosts
    return found
      .filter((f) => {
        const h = hosts.find((x) => x.id === f.id)
        return !!h && sameFingerprint(h.fingerprint, f.fingerprint) && h.lanAddress === f.address
      })
      .map((f) => f.id)
  }

  async function learnAddresses(found: FoundHost[]): Promise<string[]> {
    const learnt = new Map<string, string>()
    const hosts = store.get().hosts
    await Promise.all(
      found.map(async (f) => {
        const h = hosts.find((x) => x.id === f.id)
        if (!h || !sameFingerprint(h.fingerprint, f.fingerprint) || h.lanAddress === f.address)
          return
        if (!isLanAddress(f.address)) return
        const info = await io.hostClient
          .connect({ address: f.address, port: h.port, fingerprint: h.fingerprint, token: h.token })
          .info()
          .catch(() => null)
        if (info?.id === h.id && !learnt.has(h.id)) learnt.set(h.id, f.address)
      })
    )
    if (learnt.size)
      await store.update((d) => {
        for (const h of d.hosts) {
          const address = learnt.get(h.id)
          if (address) h.lanAddress = address
        }
      })
    return [...learnt.keys()]
  }

  /**
   * After a refresh: while a paired host is unreachable it is tried again sooner (RETRY_FIRST_MS, doubling up to
   * RETRY_MAX_MS, without end); a host that newly stopped answering starts the delay over, so another PC that stays
   * switched off does not slow down the retries of this one.
   */
  function scheduleRetry(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    const offline = new Set(
      store
        .get()
        .hosts.filter((h) => !runtime(h.id).online && !isMyClient(h.id))
        .map((h) => h.id)
    )
    if ([...offline].some((id) => !offlineHosts.has(id))) retryMs = RETRY_FIRST_MS
    offlineHosts = offline
    if (!offline.size) {
      retryMs = RETRY_FIRST_MS
      return
    }
    if (!started || disposed || suspended) return
    const delay = retryMs
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!disposed && !suspended) void refreshRemote({ retry: true })
    }, delay)
    retryTimer.unref?.()
  }

  /** One refresh at a time: a call while one runs gets that one (a full refresh covers a retry's hosts too). */
  function refreshRemote(options: { retry?: boolean } = {}): Promise<void> {
    refreshing ??= doRefresh(options).finally(() => {
      refreshing = null
    })
    return refreshing
  }

  /**
   * `retry`: the sooner retry while a host is unreachable (scheduleRetry). Only the hosts that were unreachable are
   * asked again, and nothing else of a refresh runs (lastSeen, the library rebuild, the art and Emulation syncs) unless
   * one of them answered: a paired PC that stays switched off must not make the online ones sync every 2 minutes.
   */
  async function doRefresh(options: { retry?: boolean } = {}): Promise<void> {
    const offlineBefore = options.retry ? new Set(offlineHosts) : null
    const hosts = store.get().hosts.filter((h) => !offlineBefore || offlineBefore.has(h.id))
    const failed: string[] = []
    await Promise.all(
      hosts.map(async (h) => {
        if (!(await fetchOffer(h))) failed.push(h.id)
      })
    )
    // A host that moved to another address on the LAN (a new DHCP lease) answers discovery from there.
    if (failed.length && started && !disposed) {
      const found = await io
        .discoverHosts({ port: settings.get().streaming.hostPort + 1, timeoutMs: 2000, log })
        .catch(() => [] as FoundHost[])
      const answered = answeredAtKnownAddress(found)
      const moved = (await learnAddresses(found)).filter((id) => failed.includes(id))
      const again = [...new Set([...moved, ...answered.filter((id) => failed.includes(id))])]
      await Promise.all(
        again.map((id) => {
          const h = storedHost(id)
          return h ? fetchOffer(h) : Promise.resolve(false)
        })
      )
    }
    scheduleRetry()
    if (offlineBefore && ![...offlineBefore].some((id) => runtime(id).online)) {
      // Still unreachable: nothing the user sees changed (fetchOffer kept their last games and error).
      emitStatus()
      return
    }
    const seen = iso(now())
    const online = store.get().hosts.filter((h) => runtime(h.id).online)
    if (online.length)
      await store.update((d) => {
        for (const h of d.hosts) if (runtime(h.id).online) h.lastSeen = seen
      })
    rebuild()
    emitStatus()
    offersLoadedOnce()
    refreshedOnce()
    if (online.length) {
      syncFromHosts()
      syncEmulation()
      // After rebuild(): the favourites and the play time need the hosts' fresh offers.
      exchangeFavoritesNow()
      exchangePlaytimeNow()
    }
  }

  // --- the Emulation folder sync, client side -------------------------------------------------------------------

  let emuPass: Promise<void> | null = null
  let emuAgain = false
  let emuAbort: AbortController | null = null
  /** The host the running pass is with, and when its part of the pass is over. */
  let emuHostId: string | null = null
  let emuHostDone: Promise<void> = Promise.resolve()
  let emuTimer: ReturnType<typeof setTimeout> | null = null

  function setEmuStatus(hostId: string, next: EmulationSyncStatus): void {
    const before = emuStatus.get(hostId)
    const lastSync = next.lastSync ?? before?.lastSync
    const last = next.last ?? before?.last
    emuStatus.set(hostId, { ...next, ...(lastSync ? { lastSync } : {}), ...(last ? { last } : {}) })
    emitStatus()
  }

  /**
   * One pass with every reachable host, one host at a time; runs after each refresh that reached a host (every 5
   * minutes), when the setting is turned on, and shortly after a game ends. Never while a game runs on this PC.
   */
  function syncEmulation(): void {
    if (!emulationSync || disposed || suspended || emuHolds > 0) return
    if (emuPass) {
      emuAgain = true
      return
    }
    emuPass = runEmulationSync()
      .catch((err) => log.warn(`Emulation sync failed: ${message(err)}`))
      .finally(() => {
        emuPass = null
        if (emuAgain && !disposed) {
          emuAgain = false
          syncEmulation()
        }
      })
  }

  /** A pass shortly after `ms` (a game just ended: its saves are written by then). */
  function syncEmulationSoon(ms: number): void {
    if (!emulationSync || disposed) return
    if (emuTimer) clearTimeout(emuTimer)
    emuTimer = setTimeout(() => {
      emuTimer = null
      syncEmulation()
    }, ms)
    emuTimer.unref?.()
  }

  async function runEmulationSync(): Promise<void> {
    if (!settings.get().streaming.syncEmulation) return
    const hosts = store.get().hosts.filter((h) => !isMyClient(h.id) && runtime(h.id).online)
    for (const h of hosts) {
      if (disposed || suspended || !settings.get().streaming.syncEmulation) return
      // Removed since the pass started: not synced (and nothing of it is written again).
      if (!storedHost(h.id)) continue
      if (deps.launcher.running()) {
        setEmuStatus(h.id, {
          state: 'waiting',
          message: tMain('mainStreaming.emuSync.gameRunningHere')
        })
        continue
      }
      const ac = new AbortController()
      emuAbort = ac
      emuHostId = h.id
      let finished!: () => void
      emuHostDone = new Promise<void>((resolve) => (finished = resolve))
      try {
        setEmuStatus(h.id, { state: 'syncing', done: 0, total: 0 })
        const { conn } = await reach(h)
        const { root, scope } = emulationFolder()
        const result = await emulationSync!.syncWithHost({
          hostId: h.id,
          transport: conn.emulation,
          root,
          scope,
          signal: ac.signal,
          onProgress: (p) => setEmuStatus(h.id, { state: 'syncing', done: p.done, total: p.total })
        })
        if (result.changedHere.length) deps.onEmulationFilesChanged?.(result.changedHere)
        const moved = result.downloaded + result.uploaded + result.deleted
        if (moved || result.failed)
          log.info(
            `Emulation sync with ${h.name}: ${result.downloaded} copied here, ${result.uploaded} sent, ${result.deleted} deleted, ${result.conflicts} conflicts, ${result.failed} failed`
          )
        setEmuStatus(h.id, {
          state: 'synced',
          lastSync: iso(now()),
          last: {
            downloaded: result.downloaded,
            uploaded: result.uploaded,
            deleted: result.deleted,
            conflicts: result.conflicts,
            failed: result.failed
          }
        })
      } catch (err) {
        if (ac.signal.aborted) {
          // Why it stopped decides what Settings shows: a game starting here waits; the setting turned off, the host
          // removed, sleep or quitting show nothing of this pass.
          if (
            disposed ||
            suspended ||
            !settings.get().streaming.syncEmulation ||
            !storedHost(h.id)
          ) {
            emuStatus.delete(h.id)
            emitStatus()
            if (disposed || suspended || !settings.get().streaming.syncEmulation) return
            continue
          }
          setEmuStatus(h.id, {
            state: 'waiting',
            message: tMain('mainStreaming.emuSync.stoppedGameStarted')
          })
          continue
        }
        const code = err instanceof HostRequestError ? err.code : ''
        if (code === 'sync-off')
          setEmuStatus(h.id, {
            state: 'waiting',
            message: tMain('mainStreaming.emuSync.syncOff', { name: h.name })
          })
        else if (code === 'busy')
          setEmuStatus(h.id, {
            state: 'waiting',
            message: tMain('mainStreaming.emuSync.gameRunningThere', { name: h.name })
          })
        else {
          setEmuStatus(h.id, { state: 'error', message: message(err) })
          log.warn(`Emulation sync with ${h.name} failed: ${message(err)}`)
        }
      } finally {
        if (emuAbort === ac) {
          emuAbort = null
          emuHostId = null
        }
        finished()
      }
    }
  }

  // --- copying from the hosts ----------------------------------------------------------------------------------------

  /** Pairs of (this PC's game, host game) already filled in this run. */
  const copied = new Set<string>()
  /** Host images (host|game|kind) that did not come, and when: asked again only after ART_RETRY_MS. */
  const failedArt = new Map<string, number>()

  let syncing: Promise<void> | null = null
  let syncAgain = false

  /** The host game as its host offered it (checked), or null. */
  function hostGameOf(hostId: string, hostGameId: string): HostGame | null {
    for (const raw of runtimes.get(hostId)?.offer ?? []) {
      const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
      if (id === hostGameId) return sanitizeHostGame(raw)
    }
    return null
  }

  /** The host's metadata this PC's copy lacks (empty fields only: nothing of this PC's is replaced). */
  function metadataGaps(mine: GameMetadata, theirs: GameMetadata): Partial<GameMetadata> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(theirs)) {
      // Achievement counts are each PC's own (its accounts): never taken as this PC's.
      if (key === 'sources' || key === 'updatedAt' || key === 'achievements') continue
      const have = (mine as Record<string, unknown>)[key]
      const empty =
        have === undefined || have === null || have === '' || (Array.isArray(have) && !have.length)
      if (empty) out[key] = value
    }
    // The host's match ids (IGDB, SteamGridDB…) help this PC's own lookups; its art bookkeeping does not.
    const ids = Object.entries(theirs.sources ?? {}).filter(
      // RetroAchievements' id or "none" is of the host's own ROM file (its hash), not this PC's.
      ([key]) =>
        !key.includes(':') &&
        key !== 'user-match' &&
        key !== 'retroachievements' &&
        !mine.sources?.[key]
    )
    if (ids.length) out.sources = Object.fromEntries(ids)
    return out as Partial<GameMetadata>
  }

  /** The art kinds a game of this PC lacks (none of the user's own art is replaced). */
  function lacks(game: Game, kind: string): boolean {
    if (kind.startsWith('screenshot')) return !game.media.screenshots?.length
    const k = kind as 'cover' | 'hero' | 'logo' | 'icon'
    return !game.media[k] && !game.user.customMedia?.[k]
  }

  /**
   * Everything the hosts already have, brought over in the background as fast as the connection goes: first what this
   * PC's own games lack that their copy on a host has (metadata and art, so they need no lookup on the internet), then
   * every host-only game's art (covers first, so the cards fill in, then the rest). The metadata pipeline still looks
   * up what no host has. Runs after each refresh that reached a host; one pass at a time.
   */
  function syncFromHosts(): void {
    if (disposed) return
    if (syncing) {
      syncAgain = true
      return
    }
    syncing = runSync()
      .catch((err) => log.warn(`copying from the hosts failed: ${message(err)}`))
      .finally(() => {
        syncing = null
        if (!disposed) events.emit('host-sync:progress', { done: 0, total: 0 })
        if (syncAgain && !disposed) {
          syncAgain = false
          syncFromHosts()
        }
      })
  }

  /** An image that failed lately is not asked for on every refresh (the host lists it but cannot serve it). */
  const failedLately = (key: string): boolean =>
    now() - (failedArt.get(key) ?? -Infinity) < ART_RETRY_MS
  /**
   * Fetch one host image into the cache (or take it from there); null (and remembered for a while) when it does not
   * come, also when only an earlier revision's file is there (the host lists a new image it did not serve).
   */
  async function fetchArt(
    hostId: string,
    hostGameId: string,
    kind: string
  ): Promise<string | null> {
    const key = `${hostId}|${hostGameId}|${kind}`
    const rev = hostGameOf(hostId, hostGameId)?.mediaRevs?.[kind]
    const found = await remoteMediaFile(hostId, hostGameId, kind, rev)
    const file = found && isMediaRevision(found, rev) ? found : null
    if (file) failedArt.delete(key)
    else failedArt.set(key, now())
    return file
  }

  /**
   * What a game of this PC lacks, filled from its copy on a host: metadata gaps and art kinds (from this PC's host
   * cache, fetched when not there yet). Null when there is nothing to copy (the pair is then done), else the copy;
   * it resolves true when every image came.
   */
  function hostCopyTask(
    mine: Game,
    hostId: string,
    hostGameId: string
  ): (() => Promise<boolean>) | null {
    const importFromHost = deps.importFromHost
    if (!importFromHost) return null
    const theirs = hostGameOf(hostId, hostGameId)
    if (!theirs || !surelySameGame(mine, theirs)) return null
    const metadata = metadataGaps(mine.metadata ?? {}, theirs.metadata)
    const kinds = theirs.mediaKinds.filter(
      (k) => lacks(mine, k) && !failedLately(`${hostId}|${hostGameId}|${k}`)
    )
    if (!Object.keys(metadata).length && !kinds.length) return null
    return async () => {
      let missed = false
      const fetchAll = async (list: string[]): Promise<HostArt[]> => {
        const art: HostArt[] = []
        for (const kind of list) {
          const file = await fetchArt(hostId, hostGameId, kind)
          if (!file) {
            missed = true
            continue
          }
          art.push(
            kind.startsWith('screenshot')
              ? { kind: 'screenshot', file, index: Number(kind.slice('screenshot'.length)) }
              : { kind: kind as HostArt['kind'], file }
          )
        }
        return art
      }
      // The cover (and the details) land on their own first: the card shows its cover at once, not after every
      // other image has come from the host.
      const first = kinds.filter((k) => k === 'cover')
      const rest = kinds.filter((k) => k !== 'cover')
      await importFromHost(mine.id, { metadata, art: await fetchAll(first) })
      if (rest.length) await importFromHost(mine.id, { metadata: {}, art: await fetchAll(rest) })
      return !missed
    }
  }

  async function runSync(): Promise<void> {
    const tasks: { label: string; run: () => Promise<void> }[] = []
    const online = (hostId: string): boolean => runtimes.get(hostId)?.online === true

    // Each host's image cache, listed once for the pass (not once per image).
    const cachedStems = new Map<string, Set<string>>()
    const cachedIn = async (hostId: string): Promise<Set<string>> => {
      let stems = cachedStems.get(hostId)
      if (!stems) {
        const names = await fs
          .readdir(join(deps.dataDir, 'media-cache', hostId))
          .catch(() => [] as string[])
        stems = new Set(
          names.filter((n) => !n.endsWith('.tmp')).map((n) => n.replace(/\.[^.]+$/, ''))
        )
        cachedStems.set(hostId, stems)
      }
      return stems
    }
    if (deps.importFromHost) {
      for (const [gameId, infos] of Object.entries(remote.alsoOnHost)) {
        if (gameId.startsWith('remote:')) continue
        const info = infos.find((i) => online(i.hostId))
        const mine = library.getGame(gameId)
        if (!info || !mine) continue
        const key = `${gameId}|${info.hostId}|${info.hostGameId}`
        if (copied.has(key)) continue
        const theirs = hostGameOf(info.hostId, info.hostGameId)
        if (!theirs || !surelySameGame(mine, theirs)) continue
        const copy = hostCopyTask(mine, info.hostId, info.hostGameId)
        if (!copy) {
          copied.add(key)
          continue
        }
        tasks.push({
          label: displayTitle(mine),
          run: async () => {
            // An image that did not come is asked for again on a later pass (after ART_RETRY_MS).
            if (await copy()) copied.add(key)
          }
        })
      }
    }

    // Host-only games' art, every game's cover before any other kind.
    const order = ['cover', 'logo', 'hero', 'icon']
    const remoteArt: { label: string; run: () => Promise<void> }[][] = [[], [], [], [], []]
    for (const card of remote.games) {
      const info = card.remote
      if (!info || !online(info.hostId)) continue
      const theirs = hostGameOf(info.hostId, info.hostGameId)
      if (!theirs) continue
      const stems = await cachedIn(info.hostId)
      for (const kind of theirs.mediaKinds) {
        const rev = theirs.mediaRevs?.[kind]
        if (stems.has(`${sha1(info.hostGameId)}-${kind}${rev ? `.v${rev}` : ''}`)) continue
        if (failedLately(`${info.hostId}|${info.hostGameId}|${kind}`)) continue
        const slot = order.indexOf(kind)
        remoteArt[slot >= 0 ? slot : 4]!.push({
          label: card.title,
          run: async () => {
            await fetchArt(info.hostId, info.hostGameId, kind)
          }
        })
      }
    }
    for (const list of remoteArt) tasks.push(...list)
    if (!tasks.length) return

    log.info(`copying from the hosts: ${tasks.length} item(s)`)
    let done = 0
    let lastReport = 0
    const report = (current?: string, force = false): void => {
      const at = Date.now()
      if (!force && at - lastReport < 400) return
      lastReport = at
      if (!disposed)
        events.emit('host-sync:progress', {
          done,
          total: tasks.length,
          ...(current ? { current } : {})
        })
    }
    report(undefined, true)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(HOST_SYNC_PARALLEL, tasks.length) }, async () => {
        while (next < tasks.length && !disposed) {
          const task = tasks[next++]!
          report(task.label)
          await task.run().catch((err) => log.debug(`copying ${task.label}: ${message(err)}`))
          done++
        }
      })
    )
    report(undefined, true)
    log.info(`copying from the hosts: ${done} of ${tasks.length} done`)
  }

  /**
   * A host game's image in this PC's cache (fetched from the host the first time), or null. `rev`: the host's
   * revision of the image (its offer's `mediaRevs`); the cached file is named by it (`<stem>.v<rev>.<ext>`), so an
   * image the host replaced since (a game matched again: another cover) is fetched again and the old file goes. While
   * the host cannot be reached the old file is still shown. Without a revision (an older host) the file first
   * fetched is kept, as before.
   */
  async function remoteMediaFile(
    hostId: string,
    hostGameId: string,
    kind: string,
    rev?: string
  ): Promise<string | null> {
    if (!HOST_ID.test(hostId) || !MEDIA_KIND.test(kind)) return null
    // eslint-disable-next-line no-control-regex
    if (!hostGameId || hostGameId.length > 512 || /[\u0000-\u001f\u007f]/.test(hostGameId))
      return null
    const dir = join(deps.dataDir, 'media-cache', hostId)
    const base = `${sha1(hostGameId)}-${kind}`
    const stem = rev && MEDIA_REV.test(rev) ? `${base}.v${rev}` : base
    const cached = await cachedMedia(dir, stem)
    if (cached) return cached
    const h = storedHost(hostId)
    if (!h) return null
    const key = `${hostId}/${stem}`
    let job = mediaJobs.get(key)
    if (!job) {
      job = fetchMedia(h, hostGameId, kind as MediaKindParam, dir, stem)
        .then(async (file) => {
          // The host's current image is here: the files of its earlier revisions go.
          if (file && stem !== base) await dropOtherMedia(dir, base, file)
          return file
        })
        .catch((err) => {
          log.debug(`media cache: ${message(err)}`)
          return null
        })
        .finally(() => mediaJobs.delete(key))
      mediaJobs.set(key, job)
    }
    const file = await job
    return file ?? (stem === base ? null : cachedMedia(dir, base))
  }

  /** The remote library from the offers in hand (no request): an unreachable host shows its last offer. */
  function rebuild(): void {
    const offers: HostOfferInput[] = []
    for (const h of store.get().hosts) {
      if (isMyClient(h.id)) continue
      const rt = runtimes.get(h.id)
      const offer = rt?.offer
      if (offer)
        offers.push({
          hostId: h.id,
          hostName: h.name,
          games: offer,
          ...(rt?.online ? {} : { offline: true }),
          ...(rt?.skewMs !== undefined ? { skewMs: rt.skewMs } : {})
        })
    }
    remote = buildRemoteLibrary(library.games(), offers, new Date(now()))
    // When the hosts' games were last played shows on their host-only games only while this PC syncs play time.
    if (!settings.get().streaming.syncPlaytime)
      remote = {
        ...remote,
        games: remote.games.map((g) => {
          if (!g.lastPlayed) return g
          const copy = { ...g }
          delete copy.lastPlayed
          return copy
        })
      }
    // The hosts' favourites show on their host-only games only while this PC syncs favourites.
    if (!settings.get().streaming.syncFavorites)
      remote = {
        ...remote,
        games: remote.games.map((g) => (g.favorite ? { ...g, favorite: false } : g))
      }
    // Which host-only games have a recompilation is this PC's to say (its catalogs, its installed recompilations).
    if (deps.recompFor)
      remote = {
        ...remote,
        games: remote.games.map((g) => {
          const mine = deps.recompFor!(g)
          if (mine === undefined) return g
          // This PC's match replaces the host's (its installed versions are the host's, not ours).
          const metadata = { ...g.metadata }
          if (mine) metadata.recomp = mine
          else delete metadata.recomp
          return { ...g, metadata }
        })
      }
    // A recompilation-only card (its recompilation installed, the game not on this PC): the hosts' downloadable copies
    // of the same recompilation title, matched by this PC's catalogs (not by name or year), whether or not they were
    // folded into the card.
    const cards = new Map<string, string>()
    for (const g of library.games()) {
      const key = recompOnlyKey(g)
      if (!key) continue
      // Its key when it was made, and the catalog's key for it now (a catalog change can move the title).
      cards.set(key, g.id)
      const current = g.metadata.recomp?.titleKey
      if (current) cards.set(current, g.id)
    }
    if (cards.size && deps.recompFor) {
      const sources: Record<string, RemoteGameInfo[]> = {}
      const stamp = new Date(now()).toISOString()
      for (const offer of offers) {
        for (const raw of offer.games) {
          const hostGame = sanitizeHostGame(raw)
          if (!hostGame || hostGame.source !== 'rom' || hostGame.noRomFile) continue
          const game = hostGameAsGame(offer, hostGame, stamp)
          if (!game.remote?.downloadable) continue
          const key = deps.recompFor(game)?.titleKey
          const cardId = key ? cards.get(key) : undefined
          if (!cardId) continue
          ;(sources[cardId] ??= []).push(game.remote)
        }
      }
      if (Object.keys(sources).length) remote = { ...remote, recompSources: sources }
    }
    remoteBase = new Map(remote.games.map((g) => [g.id, g]))
    // This PC's cloud and the user's own edits of host-only games (LibraryService.viewRemote).
    if (library.viewRemote)
      remote = { ...remote, games: remote.games.map((g) => library.viewRemote!(g)) }
    const systems = [
      ...new Set(remote.games.filter((g) => g.source === 'rom').map((g) => g.platformId))
    ]
    if (systems.length) deps.registerSystemPlatforms?.(systems)
    if (!disposed) events.emit('streaming:library', remote)
  }

  async function ensureMoonlight(): Promise<void> {
    await moonlight.ensureInstalled()
  }

  /**
   * Pair Moonlight with the host's Sunshine. Never the user's PIN: a fresh one, which Moonlight's pair window uses and
   * the host approves on Sunshine (the request carrying it is authenticated with this PC's token).
   */
  async function pairMoonlight(
    conn: HostConnection,
    address: string,
    onChild?: (child: ChildProcess) => void
  ): Promise<void> {
    const pin = io.newPin()
    const { child, done } = await moonlight.pair(address, pin)
    onChild?.(child)
    try {
      const exited = done.then(() => ({
        ok: false,
        error: tMain('mainStreaming.pair.moonlightClosed')
      }))
      const result = await Promise.race([conn.moonlightPair(pin), exited])
      if (!result.ok) throw new Error(result.error || tMain('mainStreaming.pair.notAccepted'))
    } finally {
      // The pair window waits for a click once it is done; the host's answer is the result. Close it the way its
      // close button does, after a moment: Moonlight only writes the pairing to its settings on a clean exit.
      if (child.exitCode === null) {
        await io.sleep(PAIR_SETTLE_MS)
        await moonlight.closeWindow(child)
      }
    }
    if (!(await moonlight.isPaired(address)))
      throw new Error(tMain('mainStreaming.pair.stillNotPaired'))
  }

  function pairMoonlightLater(h: StoredHost): void {
    const job = (async () => {
      const rt = runtime(h.id)
      try {
        await ensureMoonlight()
        const { conn, address } = await reach(h)
        if (!(await moonlight.isPaired(address))) await pairMoonlight(conn, address)
        rt.streamError = undefined
        log.info(`Moonlight paired with ${h.name}`)
      } catch (err) {
        log.warn(`Moonlight pairing with ${h.name} failed: ${message(err)}`)
        rt.streamError = moonlightRetryText()
      }
      emitStatus()
    })().finally(() => moonlightPairs.delete(h.id))
    moonlightPairs.set(h.id, job)
  }

  function pairErrorText(err: unknown, address: string): string {
    if (err instanceof HostRequestError) {
      switch (err.code) {
        case 'wrong-pin':
          return tMain('mainStreaming.pair.wrongPin')
        case 'expired':
          return tMain('mainStreaming.pair.expired')
        case 'locked':
          return tMain('mainStreaming.pair.locked')
        case 'not-pairing':
          return tMain('mainStreaming.pair.notShowing')
        case 'is-host':
          return tMain('mainStreaming.pair.isHost')
      }
      return err.message
    }
    if (err instanceof CertificateMismatchError) return err.message
    log.warn(`pairing with ${address} failed: ${message(err)}`)
    return tMain('mainStreaming.pair.unreachable', { address, error: friendlyNetError(err) })
  }

  // --- streams ------------------------------------------------------------------------------------------------------

  function setSession(s: ActiveStream, state: StreamSession['state'], text?: string): void {
    s.session = { ...s.session, state }
    if (text) s.session.message = text
    else delete s.session.message
    if (!disposed) events.emit('streaming:session', s.session)
  }

  function streamTarget(gameId: string, hostId?: string): { host: StoredHost; hostGameId: string } {
    const parsed = parseRemoteGameId(gameId)
    const list = remote.alsoOnHost[gameId] ?? []
    let pick: { hostId: string; hostGameId: string } | undefined = hostId
      ? list.find((i) => i.hostId === hostId)
      : list[0]
    if (!pick && parsed && (!hostId || hostId === parsed.hostId)) pick = parsed
    if (!pick) throw new Error(tMain('mainStreaming.hosts.noneOffers'))
    const h = storedHost(pick.hostId)
    if (!h) throw new Error(tMain('mainStreaming.stream.notPaired'))
    return { host: h, hostGameId: pick.hostGameId }
  }

  function prepareErrorText(err: unknown, name: string): string {
    if (err instanceof HostRequestError) {
      if (err.code === 'busy') return err.message || tMain('mainStreaming.stream.busy', { name })
      if (err.code === 'not-installed')
        return err.message || tMain('mainStreaming.stream.notInstalled', { name })
      if (err.code === 'unauthorized') return tMain('mainStreaming.stream.unauthorized', { name })
      return err.message
    }
    log.warn(`preparing the stream on ${name} failed: ${message(err)}`)
    return tMain('mainStreaming.stream.noAnswer', { name, error: friendlyNetError(err) })
  }

  async function streamGame(gameId: string, hostId?: string): Promise<void> {
    await ready
    if (stream) throw new Error(tMain('mainStreaming.stream.alreadyRunning'))
    const target = streamTarget(gameId, hostId)
    const h = target.host
    const s: ActiveStream = {
      session: { gameId, hostId: h.id, hostName: h.name, state: 'preparing' },
      hostGameId: target.hostGameId,
      cancelled: false,
      minimized: false
    }
    stream = s
    if (!disposed) events.emit('streaming:session', s.session)
    const check = (): void => {
      if (s.cancelled || disposed) throw new Cancelled()
    }
    try {
      const { conn, address } = await reach(h)
      s.conn = conn
      check()
      await ensureMoonlight()
      check()
      await moonlightPairs.get(h.id)
      check()
      if (!(await moonlight.isPaired(address))) {
        setSession(s, 'pairing')
        try {
          await pairMoonlight(conn, address, (c) => {
            s.pairChild = c
            // Stopped while the pair window was opening: close it at once.
            if (s.cancelled && c.exitCode === null) c.kill()
          })
          runtime(h.id).streamError = undefined
        } catch (err) {
          if (s.cancelled || disposed) throw new Cancelled()
          runtime(h.id).streamError = moonlightRetryText()
          emitStatus()
          throw new Error(
            tMain('mainStreaming.pair.moonlightFailed', { name: h.name, error: message(err) }),
            {
              cause: err
            }
          )
        }
        emitStatus()
      }
      check()
      try {
        s.warning = (await conn.prepareStream(target.hostGameId)).warning
      } catch (err) {
        throw new Error(prepareErrorText(err, h.name), { cause: err })
      }
      check()
      setSession(s, 'connecting')
      const opts = settings.get().streaming
      const child = await moonlight.stream(address, SUNSHINE_APP_NAME, {
        resolution: opts.resolution,
        screen: opts.resolution === 'auto' ? deps.screenSize() : undefined,
        fps: opts.fps,
        bitrateKbps: opts.bitrateKbps,
        displayMode: 'fullscreen'
      })
      s.child = child
      watchStream(s, child)
      if (s.cancelled) child.kill()
    } catch (err) {
      if (stream === s) stream = null
      if (err instanceof Cancelled || s.cancelled) {
        setSession(s, 'ended')
        return
      }
      const text = message(err)
      log.warn(`stream of ${gameId} from ${h.name} failed: ${text}`)
      setSession(s, 'error', text)
      throw new Error(text, { cause: err })
    }
  }

  function watchStream(s: ActiveStream, child: ChildProcess): void {
    let tail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000)
    })
    // Like a local game: PlayOut steps out of the way while the stream window plays.
    if (settings.get().ui.minimizeWhilePlaying) {
      deps.window.minimize()
      s.minimized = true
    }
    s.timer = setTimeout(() => {
      if (stream === s && child.exitCode === null && !s.cancelled) setSession(s, 'streaming')
    }, io.streamingAfterMs)
    child.once('close', (code: number | null) => {
      if (s.timer) clearTimeout(s.timer)
      // PlayOut takes the foreground back after a stream it did not end itself, also when it stayed open: the
      // controller only drives PlayOut while it is the active window. A window closed to the tray stays there.
      if (s.minimized || (!s.cancelled && deps.window.isVisible?.() !== false))
        deps.window.restore()
      if (stream === s) stream = null
      refreshAfterStream()
      if (s.cancelled) return setSession(s, 'ended')
      // The host may not have started the game: Moonlight only shows that as the stream closing.
      void hostLaunchError(s).then((hostError) => {
        // A newer stream started meanwhile: its session replaced this one.
        if (stream && stream !== s) return
        if (hostError)
          setSession(
            s,
            'error',
            tMain('mainStreaming.stream.hostCouldNotStart', { error: hostError })
          )
        else if (s.session.state === 'streaming') setSession(s, 'ended')
        else
          setSession(
            s,
            'error',
            `${moonlightFailure(tail, code)}${s.warning ? `. ${s.warning}` : ''}`
          )
      })
    })
  }

  /**
   * A stream of a host's game closed: the host played and timed it, so its offer is asked again soon after (as a game
   * ending here sends its session), and the game's card moves to the front of Recent without waiting for the next
   * refresh. Only while this PC syncs play time: nothing else of the offer changed.
   */
  function refreshAfterStream(): void {
    if (disposed || !settings.get().streaming.syncPlaytime) return
    if (streamEndTimer) clearTimeout(streamEndTimer)
    streamEndTimer = setTimeout(() => {
      streamEndTimer = null
      if (!disposed && !suspended) void refreshRemote()
    }, deps.playtime?.afterGameMs ?? PLAYTIME_AFTER_GAME_MS)
    streamEndTimer.unref?.()
  }

  /** The host's recent launch failure for this stream's game, or null (also when the host does not answer). */
  async function hostLaunchError(s: ActiveStream): Promise<string | null> {
    if (!s.conn) return null
    try {
      const status = await withTimeout(
        s.conn.streamStatus(),
        STREAM_STATUS_WAIT_MS,
        'stream status'
      )
      const e = status.lastError
      return e && e.gameId === s.hostGameId ? e.message : null
    } catch (err) {
      log.debug(`stream status: ${message(err)}`)
      return null
    }
  }

  async function stopStream(): Promise<void> {
    const s = stream
    if (!s) return
    s.cancelled = true
    // Moonlight's pair window first: closing it ends the pairing step at once (it would otherwise wait for the host).
    if (s.pairChild && s.pairChild.exitCode === null) s.pairChild.kill()
    if (s.conn)
      await withTimeout(s.conn.stopStream(), 5_000, 'stopping the stream').catch((err) =>
        log.debug(`stop stream: ${message(err)}`)
      )
    if (s.child && s.child.exitCode === null) s.child.kill()
  }

  // --- ROM downloads ------------------------------------------------------------------------------------------------

  function emitDownload(
    job: DownloadJob,
    state: RomDownloadProgress['state'],
    step?: Pick<RomDownloadStep, 'bytesDone' | 'bytesTotal' | 'percent'>,
    extra: Pick<RomDownloadProgress, 'message' | 'installedGameId' | 'hostOffline'> = {}
  ): void {
    if (disposed) return
    events.emit('streaming:download', {
      gameId: job.gameId,
      hostId: job.hostId,
      state,
      bytesDone: step?.bytesDone ?? 0,
      bytesTotal: step?.bytesTotal ?? 0,
      percent: step?.percent ?? (state === 'done' ? 100 : 0),
      ...extra
    })
  }

  /**
   * rom-transfer's fetcher over the host connection, with its contract enforced here: stop and reject once the host
   * sends past the listed size, refuse a whole-file answer to a resumed request, report bytes as they arrive.
   */
  function fetcher(download: HostConnection['downloadFile'], hostGameId: string) {
    return async (req: RomFetchRequest): Promise<void> => {
      if (req.signal?.aborted) throw req.signal.reason ?? new Cancelled()
      const inner = new AbortController()
      const follow = (): void => inner.abort(req.signal?.reason)
      req.signal?.addEventListener('abort', follow, { once: true })
      let written = 0
      let overflow = false
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            // A retry resumes from what the .part holds by now.
            await download(hostGameId, req.path, req.dest, {
              from: req.from + written,
              strictRange: true,
              signal: inner.signal,
              onBytes: (n) => {
                written += n
                req.onBytes(n)
                if (!overflow && req.from + written > req.size) {
                  overflow = true
                  inner.abort(new Error(tMain('mainStreaming.download.tooMuchData')))
                }
              }
            })
            break
          } catch (err) {
            // 429: the host's per-client streams are all in use (Emulation sync shares them). Wait a moment, try again.
            const busy = err instanceof HostRequestError && err.status === 429
            if (!busy || overflow || inner.signal.aborted || attempt >= BUSY_RETRIES) throw err
            await abortableDelay(BUSY_RETRY_MS * attempt, inner.signal)
          }
        }
      } catch (err) {
        if (overflow) throw new Error(tMain('mainStreaming.download.tooMuchData'), { cause: err })
        throw err
      } finally {
        req.signal?.removeEventListener('abort', follow)
      }
      if (overflow) throw new Error(tMain('mainStreaming.download.tooMuchData'))
    }
  }

  /** The host answered: downloads from it held back while it was unreachable may go again. */
  function hostSeen(h: StoredHost): void {
    if (!unreachableHosts.delete(h.id) || disposed) return
    log.info(`${h.name} answers again; its queued downloads may continue`)
    deps.installQueue.poke()
  }

  /**
   * One download at a time: the install queue starts it in its turn (queueRunner below). Resolves 'retry' when the
   * host could not be reached: the queue keeps the entry waiting at its place, and the host's downloads wait for it.
   */
  async function runDownload(
    job: DownloadJob,
    h: StoredHost,
    romsRoot: string
  ): Promise<void | 'retry' | 'finished'> {
    // Only the game's current job speaks for it: a stopped older one ending late must not cancel or clear a new one.
    const live = (): boolean => downloads.get(job.gameId) === job
    const report: typeof emitDownload = (...args) => {
      if (live()) emitDownload(...args)
    }
    try {
      let firstPath = ''
      // reach() failing means the host does not answer (held below). A network error after it answered (a dropped
      // connection mid-transfer) is retried up to HOST_TRANSFER_ATTEMPTS in all, then fails like any other error:
      // the host is up, so its other downloads are not held for it.
      for (let attempt = 1; ; attempt++) {
        const { conn } = await reach(h)
        // The files go over a few kept-alive connections (each pin-checked when it opens) rather than one handshake
        // per file: a texture pack can be thousands of small files.
        const session = conn.downloadSession?.()
        try {
          const list = await conn.romFiles(job.hostGameId)
          if (!list.files.length)
            throw new Error(tMain('mainStreaming.download.noFiles', { name: h.name }))
          firstPath = list.files[0].path
          const fetchHost = fetcher(
            session ? session.downloadFile : (...args) => conn.downloadFile(...args),
            job.hostGameId
          )
          const texturePrefix = `${TEXTURE_AREA.toLowerCase()}/`
          const textures = list.files.filter((f) => f.path.toLowerCase().startsWith(texturePrefix))
          if (textures.length && attempt === 1) {
            const mb = textures.reduce((sum, f) => sum + f.size, 0) / 1024 ** 2
            log.info(
              `${job.title}: ${textures.length} texture pack file(s) (${mb.toFixed(1)} MB) come along to texturepacks`
            )
          }
          // downloadRomSet writes the game's sheets (.cue, .m3u, ...) last, so no scan meanwhile imports half a game.
          await downloadRomSet({
            files: list.files,
            destRoot: romsRoot,
            // A PS3 game's updates and DLC go to this PC's PS3 HDD, its texture packs to this PC's texturepacks.
            areas: await romAreas(),
            signal: job.ac.signal,
            // The progress events are spaced out; counting the bytes as they arrive too keeps `lastStep` exact for
            // the 'paused' event (the next progress event replaces it with the same count).
            fetchFile: (req) =>
              fetchHost({
                ...req,
                onBytes: (n) => {
                  const last = job.lastStep
                  if (last && n > 0) {
                    const done = Math.min(last.bytesDone + n, last.bytesTotal)
                    const percent =
                      last.bytesTotal > 0 ? Math.floor((done / last.bytesTotal) * 100) : 100
                    job.lastStep = { bytesDone: done, bytesTotal: last.bytesTotal, percent }
                  }
                  req.onBytes(n)
                }
              }),
            onProgress: (step) => {
              job.lastStep = {
                bytesDone: step.bytesDone,
                bytesTotal: step.bytesTotal,
                percent: step.percent
              }
              report(job, 'downloading', step)
            }
          })
          break
        } catch (err) {
          if (
            job.ac.signal.aborted ||
            disposed ||
            attempt >= HOST_TRANSFER_ATTEMPTS ||
            !isHostUnreachable(err)
          )
            throw err
          log.warn(
            `download of ${job.title} from ${h.name} broke off (${message(err)}); trying again (${attempt + 1}/${HOST_TRANSFER_ATTEMPTS})`
          )
          await io.sleep(HOST_TRANSFER_RETRY_MS)
          if (job.ac.signal.aborted) throw err
        } finally {
          session?.close()
        }
      }
      log.info(`downloaded ${job.title} from ${h.name}; scanning ROMs`)
      const keys = [job.externalId, firstPath].filter(Boolean).map((k) => k!.toLowerCase())
      const find = (): Game | undefined =>
        library.games().find((g) => g.source === 'rom' && keys.includes(g.externalId.toLowerCase()))
      await deps.scan.run(['rom'])
      let local = find()
      if (!local) {
        // run() joins a ROM scan already in flight, which may have walked the folder before these files were there;
        // that one is finished now, so this is a fresh scan.
        await deps.scan.run(['rom'])
        local = find()
      }
      if (local) {
        // The user's edit of the host's copy goes with it (fields this PC's record has no edit of).
        try {
          library.adoptRemoteMetadataEdit?.(local.id, job.hostGameId)
        } catch (err) {
          log.warn(`metadata edit of ${job.title}: ${message(err)}`)
        }
        // The downloaded game keeps the art and details it had as the host's game (already in this PC's host cache):
        // copied now, not on the next pass after a refresh, so its card never goes blank meanwhile.
        const copy = hostCopyTask(local, job.hostId, job.hostGameId)
        if (copy)
          await copy()
            .then((all) => {
              if (all) copied.add(`${local!.id}|${job.hostId}|${job.hostGameId}`)
            })
            .catch((err) => log.warn(`art of ${job.title} from ${h.name}: ${message(err)}`))
        // The original of a recompilation-only game: when its file name does not say what it is, it takes the host's
        // title, so this PC's recompilation match finds it (and the recompilation's card merges into it).
        try {
          const source = hostOfferGame(job.hostId, job.hostGameId)
          const key = source ? deps.recompFor?.(source)?.titleKey : undefined
          const forCard =
            !!key &&
            library
              .games()
              .some(
                (g) =>
                  !!recompOnlyKey(g) &&
                  (recompOnlyKey(g) === key || g.metadata.recomp?.titleKey === key)
              )
          if (forCard && source && local.title !== source.title && !deps.recompFor?.(local))
            library.applyMetadata?.(local.id, { title: source.title }, { overwrite: true })
        } catch (err) {
          log.warn(`title of ${job.title} from ${h.name}: ${message(err)}`)
        }
        report(job, 'done', undefined, { installedGameId: local.id })
      } else
        report(job, 'failed', undefined, {
          message: tMain('mainStreaming.download.notScanned', { title: job.title })
        })
      // Past the transfer: a pause pressed meanwhile came too late, the download is over either way.
      return 'finished'
    } catch (err) {
      if (job.ac.signal.aborted && job.paused) {
        // Paused: what it has stays in the .part files, and the next start continues from there.
        report(job, 'paused', job.lastStep)
        log.info(`download of ${job.title} paused`)
      } else if (job.ac.signal.aborted) {
        report(job, 'cancelled')
        log.info(`download of ${job.title} cancelled`)
      } else if (err instanceof HostUnreachableError && !disposed) {
        log.warn(`download of ${job.title} waits: ${h.name} cannot be reached (${message(err)})`)
        // Said once per outage: the host's other downloads are not started until it answers again.
        if (!unreachableHosts.has(h.id)) {
          unreachableHosts.add(h.id)
          report(job, 'failed', undefined, {
            message: hostOfflineMessage(h.name),
            hostOffline: true
          })
        }
        return 'retry'
      } else {
        log.warn(`download of ${job.title} from ${h.name} failed: ${message(err)}`)
        report(job, 'failed', undefined, {
          message: tMain('mainStreaming.download.failed', { error: message(err) })
        })
      }
    } finally {
      jobs.delete(job)
      if (live()) downloads.delete(job.gameId)
    }
  }

  /**
   * A host game that can be downloaded now into the ROM folder, or why not. The checks run when the user asks (the
   * error is thrown to them) and again at the entry's turn in the queue (the host may have gone meanwhile).
   */
  /** A host's game as its last offer has it (any game of that host, folded into a local card or not). */
  function hostOfferGame(hostId: string, hostGameId: string): Game | undefined {
    const h = storedHost(hostId)
    const rt = runtimes.get(hostId)
    const offer = rt?.offer
    if (!h || !offer) return undefined
    for (const raw of offer) {
      const hostGame = sanitizeHostGame(raw)
      if (hostGame?.id !== hostGameId) continue
      return hostGameAsGame(
        {
          hostId,
          hostName: h.name,
          games: offer as HostGame[],
          ...(rt.online ? {} : { offline: true })
        },
        hostGame,
        new Date(now()).toISOString()
      )
    }
    return undefined
  }

  function downloadTarget(
    gameId: string
  ): { error: string } | { h: StoredHost; game: Game; hostGameId: string; romsRoot: string } {
    const parsed = parseRemoteGameId(gameId)
    if (!parsed) return { error: tMain('mainStreaming.download.onlyHostGames') }
    const romsRoot = settings.get().library.romsRoot
    if (!romsRoot) return { error: tMain('mainStreaming.download.chooseEmulationFolder') }
    const h = storedHost(parsed.hostId)
    if (!h) return { error: tMain('mainStreaming.stream.notPaired') }
    // A host-only game, else the host's game as its own list has it (a recompilation-only card's original that was
    // folded into the card; also before this PC's recompilation catalog is loaded, as after a restart).
    const game =
      remote.games.find((g) => g.id === gameId) ?? hostOfferGame(parsed.hostId, parsed.hostGameId)
    if (!game) return { error: tMain('mainStreaming.download.notOffered', { name: h.name }) }
    if (!game.remote?.downloadable)
      return { error: tMain('mainStreaming.download.notDownloadable') }
    return { h, game, hostGameId: game.remote.hostGameId, romsRoot }
  }

  deps.installQueue.register('host-rom', {
    async start(entry, { resumed, signal }) {
      await ready
      // The hosts' games are known once their saved lists were read (start); a game queued before that (its turn
      // came at once at start-up) would otherwise be "not offered".
      await within(offersLoaded, OFFERS_WAIT_MS)
      // After a restart the hosts' games are only known once they answered (or their saved lists were read).
      if (resumed) await Promise.race([firstRefresh, io.sleep(RESUME_WAIT_MS)])
      if (disposed) return { error: tMain('mainStreaming.download.closing') }
      if (signal.aborted) return {}
      const target = downloadTarget(entry.gameId)
      if ('error' in target) return { error: target.error }
      // A stopped older download of this game ends first, so two never write the same files.
      const older = downloads.get(entry.gameId)
      if (older) {
        older.ac.abort()
        await within(
          older.settled ?? Promise.resolve(),
          deps.olderDownloadWaitMs ?? OLDER_JOB_WAIT_MS
        )
        if (disposed) return { error: tMain('mainStreaming.download.closing') }
        if (signal.aborted) return {}
      }
      const job: DownloadJob = {
        gameId: entry.gameId,
        hostId: target.h.id,
        hostGameId: target.hostGameId,
        externalId: target.game.externalId,
        title: displayTitle(target.game),
        ac: new AbortController()
      }
      downloads.set(job.gameId, job)
      jobs.add(job)
      emitDownload(job, 'downloading')
      job.settled = runDownload(job, target.h, target.romsRoot)
      // Stops this job only, never a newer download of the same game. Paused or cancelled alike, the .part files stay
      // (downloadRomSet keeps them), so a resumed or re-added download continues from them.
      return {
        done: job.settled,
        stop: (reason) => {
          if (job.ac.signal.aborted) return
          if (reason === 'pause') job.paused = true
          job.ac.abort()
        }
      }
    },
    ready(entry) {
      const hostId = parseRemoteGameId(entry.gameId)?.hostId
      return !hostId || !unreachableHosts.has(hostId)
    },
    waitingFor(entry) {
      const hostId = parseRemoteGameId(entry.gameId)?.hostId
      if (!hostId || !unreachableHosts.has(hostId)) return undefined
      return hostOfflineMessage(storedHost(hostId)?.name ?? entry.from)
    },
    reportError(entry, text) {
      if (disposed) return
      events.emit('streaming:download', {
        gameId: entry.gameId,
        hostId: parseRemoteGameId(entry.gameId)?.hostId ?? '',
        state: 'failed',
        bytesDone: 0,
        bytesTotal: 0,
        percent: 0,
        message: text
      })
    }
  })

  /** The first start's look for hosts (firstStartHosts), made once. */
  let firstStartLookup: Promise<DiscoveredHost[]> | null = null

  /** The queued downloads from this host (its games are gone once it is removed). */
  function queuedFrom(hostId: string): InstallQueueEntry[] {
    return deps.installQueue
      .list()
      .filter((e) => e.kind === 'host-rom' && parseRemoteGameId(e.gameId)?.hostId === hostId)
  }

  // --- media proxy --------------------------------------------------------------------------------------------------

  async function cachedMedia(dir: string, stem: string): Promise<string | null> {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const hit = names.find((n) => n.startsWith(`${stem}.`) && !n.endsWith('.tmp'))
    return hit ? join(dir, hit) : null
  }

  /** Removes the cached files of one image (`base`: every revision of it) other than `keep`. */
  async function dropOtherMedia(dir: string, base: string, keep: string): Promise<void> {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      if (!name.startsWith(`${base}.`) || name.endsWith('.tmp') || join(dir, name) === keep)
        continue
      await fs.rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }

  async function fetchMedia(
    h: StoredHost,
    hostGameId: string,
    kind: string,
    dir: string,
    stem: string
  ): Promise<string | null> {
    const rt = runtime(h.id)
    // Offline (or not refreshed yet): no request per image, the cards simply have no art.
    if (!rt.online || !rt.preferred) return null
    const conn = io.hostClient.connect({
      address: rt.preferred,
      port: h.port,
      fingerprint: h.fingerprint,
      token: h.token
    })
    const media = await conn.media(hostGameId, kind as MediaKindParam).catch((err) => {
      log.debug(`media ${kind} of ${hostGameId} from ${h.name}: ${message(err)}`)
      return null
    })
    if (!media) return null
    const ext = IMAGE_EXT[media.type.split(';')[0].trim().toLowerCase()]
    if (!ext) return null
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, `${stem}.${ext}`)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, media.data)
    await renameRetry(tmp, file)
    return file
  }

  // =================================================================================================================
  // API
  // =================================================================================================================

  return {
    filesBeingSent: () => server?.filesBeingSent?.() ?? [],
    holdEmulationSync() {
      emuHolds++
      emuAbort?.abort()
      let released = false
      return () => {
        if (released) return
        released = true
        emuHolds = Math.max(0, emuHolds - 1)
        if (!emuHolds) syncEmulationSoon(5000)
      }
    },
    async start() {
      await ready
      if (started || disposed) return
      started = true
      // The tools' versions for Settings, without starting either.
      for (const [name, set] of [
        ['sunshine', (s: StreamingToolStatus) => (sunshineStatus = s)],
        ['moonlight', (s: StreamingToolStatus) => (moonlightStatus = s)]
      ] as const) {
        const installed = await readInstalledTool(join(deps.dataDir, name, 'app')).catch(() => null)
        const current = name === 'sunshine' ? sunshineStatus : moonlightStatus
        if (installed && current.state === 'missing')
          set({ state: 'installed', version: installed.tag })
      }
      let hostWasOn = settings.get().streaming.hostEnabled
      offs.push(
        settings.onChange((next) => {
          // Hosting switched on by the user: a declined firewall prompt is asked again.
          const on = next.streaming.hostEnabled
          const turnedOn = on && !hostWasOn
          hostWasOn = on
          if (turnedOn && deps.firewall)
            void deps.firewall
              .forgetDeclined()
              .catch(() => undefined)
              .then(() => applyHostSetting())
          else void applyHostSetting()
        })
      )
      // The Library tabs sync: this PC's copy is read before the first refresh; a change here goes to the hosts 2 s
      // later; the switch turned on sends it at once.
      if (tabsSync) {
        await tabsSync.load().catch((err) => log.warn(`synced Library tabs: ${message(err)}`))
        if (disposed) return
        tabsLoaded = true
        offs.push(
          tabsSync.onLocalChange(() =>
            exchangeTabsSoon(deps.libraryTabs?.afterChangeMs ?? TABS_AFTER_CHANGE_MS)
          )
        )
        let tabsWasOn = settings.get().streaming.syncLibraryTabs
        offs.push(
          settings.onChange((next) => {
            const on = next.streaming.syncLibraryTabs
            if (on === tabsWasOn) return
            tabsWasOn = on
            if (on) exchangeTabsSoon(0)
          })
        )
        offs.push(() => tabsSync.dispose())
      }
      // The favourites sync: a change here goes to the hosts 2 s later; the switch turned on sends at once (and the
      // host-only games show or drop their hosts' favourites).
      if (library.onUserFavorite)
        offs.push(
          library.onUserFavorite(() =>
            exchangeFavoritesSoon(deps.favoritesAfterChangeMs ?? FAVORITES_AFTER_CHANGE_MS)
          )
        )
      let favoritesWasOn = settings.get().streaming.syncFavorites
      offs.push(
        settings.onChange((next) => {
          const on = next.streaming.syncFavorites
          if (on === favoritesWasOn) return
          favoritesWasOn = on
          rebuild()
          if (on) exchangeFavoritesSoon(0)
        })
      )
      // The play time sync: its cursors are read before the first refresh; a game ending here sends its session soon
      // after.
      await recencyRelay.load().catch((err) => log.warn(`last played relay: ${message(err)}`))
      if (disposed) return
      if (playtimeState) {
        await playtimeState.load().catch((err) => log.warn(`play time sync state: ${message(err)}`))
        if (disposed) return
        playtimeLoaded = true
        offs.push(
          events.on('session:ended', () =>
            exchangePlaytimeSoon(deps.playtime?.afterGameMs ?? PLAYTIME_AFTER_GAME_MS)
          )
        )
      }
      // The switch: turned on exchanges at once; either way the host-only games show or drop when their hosts last
      // played them.
      let playtimeWasOn = settings.get().streaming.syncPlaytime
      offs.push(
        settings.onChange((next) => {
          const on = next.streaming.syncPlaytime
          if (on === playtimeWasOn) return
          playtimeWasOn = on
          rebuild()
          if (on) exchangePlaytimeSoon(0)
        })
      )
      let syncWasOn = settings.get().streaming.syncEmulation
      offs.push(
        settings.onChange((next) => {
          const on = next.streaming.syncEmulation
          if (on === syncWasOn) return
          syncWasOn = on
          if (on) syncEmulation()
          else {
            emuAbort?.abort()
            emuStatus.clear()
            emitStatus()
          }
        })
      )
      // A game starting on this PC stops a pass (its saves are about to change); one ending brings a pass soon after.
      offs.push(events.on('session:started', () => emuAbort?.abort()))
      offs.push(events.on('session:ended', () => syncEmulationSoon(EMULATION_AFTER_GAME_MS)))
      // A library change can turn a host-only game into this PC's own (a ROM just downloaded): no request needed.
      // So can the recompilation catalogs loading or changing (host-only games' recompilations are matched here).
      const rebuildSoon = (): void => {
        if (rebuildTimer) clearTimeout(rebuildTimer)
        rebuildTimer = setTimeout(() => {
          rebuildTimer = null
          if (!disposed) rebuild()
        }, 500)
      }
      offs.push(events.on('library:changed', rebuildSoon))
      offs.push(events.on('recomp:changed', rebuildSoon))
      // A saved edit of a host-only game (or the cloud) shows at once.
      const offView = library.onRemoteViewChange?.(() => {
        if (!disposed) rebuild()
      })
      if (offView) offs.push(offView)
      refreshTimer = setInterval(() => void refreshRemote(), REFRESH_MS)
      refreshTimer.unref?.()
      void applyHostSetting()
      // The hosts' last games at once (from disk), then what they offer now.
      await loadSavedOffers()
      rebuild()
      offersLoadedOnce()
      void refreshRemote()
      emitStatus()
    },

    async scanHosts() {
      await ready
      const hosts = store.get().hosts.filter((h) => !isMyClient(h.id))
      if (!hosts.length) return
      // Each host rescans its own library (a host from before this feature just has nothing to rescan), then its games
      // are fetched again.
      await Promise.all(
        hosts.map(async (h) => {
          try {
            const { conn } = await reach(h)
            await conn.scan()
            const until = now() + HOST_SCAN_WAIT_MS
            while (now() < until && !disposed) {
              await io.sleep(2000)
              if (!(await conn.scanRunning().catch(() => false))) break
            }
          } catch (err) {
            log.info(`library scan on ${h.name}: ${message(err)}`)
          }
        })
      )
      // A refresh that started before the scans ended would bring the old lists: one more, after it.
      await refreshing?.catch(() => undefined)
      await refreshRemote()
    },

    async status() {
      await ready
      return buildStatus()
    },

    async startPairing() {
      await ready
      if (!settings.get().streaming.hostEnabled)
        throw new Error(tMain('mainStreaming.pin.hostingOff'))
      if (!server) throw new Error(tMain('mainStreaming.pin.hostNotRunning'))
      try {
        const { expiresAt } = pairing.start()
        if (pinTimer) clearTimeout(pinTimer)
        // The PIN disappears from Settings when it expires.
        pinTimer = setTimeout(
          () => {
            pinTimer = null
            emitStatus()
          },
          Math.max(0, expiresAt - now()) + 50
        )
      } catch (err) {
        emitStatus()
        throw new Error(message(err), { cause: err })
      }
      log.info('pairing PIN shown')
      emitStatus()
      return buildStatus()
    },

    async cancelPairing() {
      await ready
      pairing.cancel()
      if (pinTimer) clearTimeout(pinTimer)
      pinTimer = null
      emitStatus()
      return buildStatus()
    },

    async removeClient(clientId) {
      await ready
      await forgetClient(clientId)
      log.info('a paired client was removed')
      emitStatus()
      return buildStatus()
    },

    async findHosts() {
      await ready
      const found = await io.discoverHosts({ port: settings.get().streaming.hostPort + 1, log })
      if ((await learnAddresses(found)).length) emitStatus()
      const paired = new Set(store.get().hosts.map((h) => h.id))
      return found
        .filter((f) => f.id !== identity)
        .map((f) => ({
          id: f.id,
          name: f.name,
          address: f.address,
          port: f.port,
          paired: paired.has(f.id)
        }))
    },

    firstStartHosts() {
      firstStartLookup ??= (async () => {
        if (!deps.firstStart) return []
        await ready
        if (store.get().hosts.length) return []
        const found: DiscoveredHost[] = await this.findHosts().catch((err: unknown) => {
          log.warn(`looking for hosts at first start: ${message(err)}`)
          return []
        })
        const hosts = found.filter((h) => !h.paired)
        if (hosts.length) log.info(`first start: ${hosts.length} PlayOut host(s) on the network`)
        return hosts
      })()
      // The lookup runs once; what is still worth offering is checked at every call (a host paired since is not).
      return firstStartLookup.then((hosts) => (store.get().hosts.length ? [] : hosts))
    },

    async pairHost(addressInput, pin) {
      await ready
      const target = parseHostAddress(addressInput, settings.get().streaming.hostPort)
      let res: PairResponse
      try {
        res = await io.hostClient.pair(target.address, target.port, pin, identity, hostName)
      } catch (err) {
        throw new Error(pairErrorText(err, target.address), { cause: err })
      }
      if (!HOST_ID.test(res.hostId)) throw new Error(tMain('mainStreaming.add.unusableId'))
      if (res.hostId === identity) throw new Error(tMain('mainStreaming.add.thisPc'))
      // That computer is this PC's client: it may not become this PC's host too (the library goes one way only).
      if (store.get().clients.some((c) => c.id === res.hostId)) {
        await io.hostClient
          .connect({
            address: target.address,
            port: target.port,
            fingerprint: res.fingerprint,
            token: res.token
          })
          .unpair()
          .catch(() => undefined)
        throw new Error(
          tMain('mainStreaming.add.isClient', { name: res.hostName || target.address })
        )
      }
      const lan = isLanAddress(target.address)
      const existing = storedHost(res.hostId)
      const at = iso(now())
      const record: StoredHost = {
        id: res.hostId,
        name: (res.hostName || target.address).slice(0, 128),
        fingerprint: res.fingerprint.toLowerCase(),
        token: res.token,
        // The address that worked goes where it belongs; a typed internet name beats the router's current IP.
        lanAddress: lan ? target.address : existing?.lanAddress,
        wanAddress: lan ? (res.externalIp ?? existing?.wanAddress) : target.address,
        port: target.port,
        pairedAt: at,
        lastSeen: at
      }
      await store.update((d) => {
        d.hosts = d.hosts.filter((h) => h.id !== record.id)
        d.hosts.push(record)
      })
      const rt = runtime(record.id)
      rt.preferred = target.address
      rt.online = true
      hostSeen(record)
      rt.error = undefined
      rt.streamError = undefined
      log.info(`paired with ${record.name} (${lan ? 'local network' : 'internet'})`)
      pairMoonlightLater(record)
      // This host's games directly: a refresh already running read the host list before this host was in it.
      void fetchOffer(record).then((ok) => {
        if (disposed) return
        rebuild()
        emitStatus()
        if (!ok) return
        syncFromHosts()
        // The Emulation folder at once (BIOS, saves, ...: everything but roms, Updates and DLC and texturepacks), not
        // at the next refresh: on a new PC its first pass downloads the host's folder.
        syncEmulation()
      })
      emitStatus()
      return pairedHost(record)
    },

    async setHostAddress(hostId, input) {
      await ready
      const h = storedHost(hostId)
      if (!h) throw new Error(tMain('mainStreaming.wan.notPaired'))
      const parsed = input?.trim() ? parseHostAddress(input, h.port) : null
      if (parsed && isLanAddress(parsed.address))
        throw new Error(tMain('mainStreaming.wan.lanAddress'))
      // One port for both addresses: the router must forward the host's own port (the same number outside).
      if (parsed && parsed.port !== h.port)
        throw new Error(tMain('mainStreaming.wan.portMismatch', { name: h.name, port: h.port }))
      await store.update((d) => {
        const x = d.hosts.find((y) => y.id === hostId)
        if (x) x.wanAddress = parsed?.address
      })
      log.info(`${h.name}'s internet address ${parsed ? 'set' : 'cleared'}`)
      // This host now, from the new address (a refresh already running would still use the old one).
      const updated = storedHost(hostId)
      if (updated) await fetchOffer(updated)
      rebuild()
      emitStatus()
      return buildStatus()
    },

    async removeHost(hostId) {
      await ready
      const h = storedHost(hostId)
      if (!h) return buildStatus()
      // The host forgets this PC too when it can be reached; removing here never waits on it for long.
      await withTimeout(
        reach(h).then(({ conn }) => conn.unpair()),
        UNPAIR_WAIT_MS,
        'unpairing'
      ).catch((err) => log.debug(`unpair on ${h.name}: ${message(err)}`))
      for (const entry of queuedFrom(hostId)) deps.installQueue.remove(entry.gameId)
      unreachableHosts.delete(hostId)
      runtimes.delete(hostId)
      // A pass with this host stops first, so it does not write its state back after it is forgotten.
      if (emuHostId === hostId) {
        emuAbort?.abort()
        await emuHostDone
      }
      emuStatus.delete(hostId)
      await emulationSync?.forgetHost(hostId)
      await store.update((d) => {
        d.hosts = d.hosts.filter((x) => x.id !== hostId)
      })
      await dropSavedOffer(hostId)
      await fs
        .rm(join(deps.dataDir, 'media-cache', hostId), { recursive: true, force: true })
        .catch(() => undefined)
      log.info(`removed host ${h.name}`)
      rebuild()
      emitStatus()
      return buildStatus()
    },

    async remoteLibrary() {
      await ready
      return remote
    },

    async remoteGameBase(gameId) {
      await ready
      return remoteBase.get(gameId)
    },

    async refreshRemoteLibrary() {
      await ready
      await refreshRemote()
      return remote
    },

    streamGame,
    stopStream,
    setRemoteFavorite,
    achievementsFor,

    async downloadRemoteRom(gameId) {
      await ready
      const target = downloadTarget(gameId)
      if ('error' in target) throw new Error(target.error)
      // Queued (another game downloads): nothing on 'streaming:download' yet, 'installs:queue' shows it.
      const added = await deps.installQueue.add({
        gameId,
        title: displayTitle(target.game),
        kind: 'host-rom',
        source: 'host',
        from: target.h.name
      })
      if (added.error) throw new Error(added.error)
    },

    async cancelRemoteRomDownload(gameId) {
      deps.installQueue.remove(gameId)
    },

    async remoteMedia(hostId, hostGameId, kind, rev) {
      await ready
      return remoteMediaFile(hostId, hostGameId, kind, rev)
    },

    suspend() {
      if (!started || disposed) return
      suspended = true
      if (refreshTimer) clearInterval(refreshTimer)
      refreshTimer = null
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      emuAbort?.abort()
      void applyHostSetting()
    },

    resume() {
      if (!started || disposed) return
      suspended = false
      // Waking: the network comes back over a few seconds, so a failed first refresh retries soon again.
      retryMs = RETRY_FIRST_MS
      void applyHostSetting()
      refreshTimer ??= setInterval(() => void refreshRemote(), REFRESH_MS)
      refreshTimer.unref?.()
      void refreshRemote()
    },

    async dispose() {
      if (disposed) return
      disposed = true
      hostGen++
      for (const off of offs.splice(0)) off()
      for (const t of [
        statusTimer,
        rebuildTimer,
        pinTimer,
        emuTimer,
        retryTimer,
        tabsTimer,
        favoritesTimer,
        playtimeTimer,
        streamEndTimer
      ])
        if (t) clearTimeout(t)
      emuAbort?.abort()
      if (refreshTimer) clearInterval(refreshTimer)
      for (const job of jobs) job.ac.abort()
      offersLoadedOnce()
      const s = stream
      if (s) {
        s.cancelled = true
        if (s.pairChild && s.pairChild.exitCode === null) s.pairChild.kill()
        if (s.child && s.child.exitCode === null) s.child.kill()
        if (s.minimized) deps.window.restore()
      }
      sunshine.dispose()
      const srv = server
      const r = responder
      const p = pipe
      server = null
      responder = null
      pipe = null
      await Promise.allSettled([srv?.close(), r?.stop(), p?.close()])
      // What is still being written to this PC's disk, before the waits on the router below (which can use up the time
      // the app gives a quit): the play time cursors of an exchange that just ended are not lost, and no offer lands
      // in the data folder after dispose().
      await playtimeState?.flush()
      await Promise.all(offerSaves)
      await tabsSync?.flush()
      await recencyRelay.flush()
      // A start in progress may be waiting on the router: give it a moment, so a mapping it gets now is released below
      // (one that comes even later is deleted by mapPort itself, which sees the service disposed).
      await withTimeout(hostTask, MAPPING_DELETE_WAIT_MS, 'host start').catch(() => undefined)
      await releaseMapping()
      await store.flush().catch((err) => log.warn(`streaming secrets: ${message(err)}`))
    },

    idle: () => hostTask
  }
}
