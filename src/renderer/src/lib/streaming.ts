import type {
  Game,
  InstallProgress,
  RemoteGameInfo,
  RemoteLibrary,
  RomDownloadProgress,
  StreamSession,
  StreamingToolStatus
} from '@shared/types'
import { recompToPlay, staleStandIns } from '@shared/recomp-play'
import { t } from '../i18n'
import { collapseCopies, copyKey, releaseYear, type CopyGroup, type CopyOptions } from './copies'
import { formatBytes } from './format'

/**
 * Pure helpers for the games of paired hosts (Streaming, ARCHITECTURE.md §4.13) in the Library, Home, Search and
 * the game page. The host-only games come already deduplicated from main (RemoteLibrary): a game this PC has too
 * is never among them, so they only need appending to the local pools, never grouping with local copies.
 */

/** The host-only games to show: none while Settings > Streaming hides them, and never a hidden one. */
export function remoteGamesShown(
  remote: RemoteLibrary | null | undefined,
  showHostGames: boolean
): Game[] {
  if (!showHostGames || !remote) return []
  return remote.games.filter((g) => !!g.remote && !g.hidden)
}

/**
 * This PC's games that are not installed here but a paired host can stream. Main folds a host
 * game into this PC's copy (no host card of its own), so with showUninstalled off these must still be shown, or a
 * game ready on the host would vanish. Hidden games stay hidden. Pass the result with the host-only games to
 * withRemoteGames: an id visibleGames already kept is not added twice.
 */
export function localOnHost(
  games: readonly Game[],
  remote: RemoteLibrary | null | undefined,
  showHostGames: boolean
): Game[] {
  if (!showHostGames || !remote) return []
  // Never an old record its recompilation stands in for beside another copy on this PC (staleStandIns): visibleGames
  // left it out so the game shows once, and a host having the game too must not bring it back as a second card.
  const stale = staleStandIns(games)
  return games.filter(
    (g) =>
      !g.installed &&
      !g.hidden &&
      !stale.has(g.id) &&
      (remote.alsoOnHost[g.id] ?? []).some((i) => i.streamable)
  )
}

/** What withRemoteGames appends to visibleGames: localOnHost, then the host-only games. */
export function hostGamesShown(
  games: readonly Game[],
  remote: RemoteLibrary | null | undefined,
  showHostGames: boolean
): Game[] {
  const local = localOnHost(games, remote, showHostGames)
  const hostOnly = remoteGamesShown(remote, showHostGames)
  return local.length ? [...local, ...hostOnly] : hostOnly
}

/**
 * The local pool (already filtered by visibleGames) followed by the host-only games. Host games are not installed
 * here, but they are shown even when showUninstalled is off: hiding them is Streaming's own switch. An id this PC
 * already has wins (a stale remote list right after a ROM download lands).
 */
export function withRemoteGames(local: readonly Game[], remote: readonly Game[]): Game[] {
  if (remote.length === 0) return local as Game[]
  const ids = new Set(local.map((g) => g.id))
  return [...local, ...remote.filter((g) => !ids.has(g.id))]
}

/**
 * collapseCopies for a pool that may hold host-only games: the local games group as usual, each host game stays
 * its own card (main already folded the ones this PC has), after the local groups. Except a host's copy of a game this
 * PC plays from its recompilation (SSX 2012: the host's PS3 disc, this PC's Xbox 360 one with its recompilations): it
 * joins that card as one more copy, so the game shows once, as the recompilation's copy. Same title and a release year
 * within one of each other (both known: SSX 2000 is another game). The card then counts the host copy's play: its last
 * played is the later of the two.
 */
export function collapseWithRemote(games: readonly Game[], options: CopyOptions = {}): CopyGroup[] {
  const local: Game[] = []
  const remote: Game[] = []
  for (const game of games) (game.remote ? remote : local).push(game)
  const groups = collapseCopies(local, options)
  const recompCards = new Map<string, CopyGroup[]>()
  for (const group of groups) {
    const key = recompToPlay(group.game) ? copyKey(group.game, options) : null
    if (key) recompCards.set(key, [...(recompCards.get(key) ?? []), group])
  }
  for (const game of remote) {
    const key = copyKey(game, options)
    const year = releaseYear(game)
    const home =
      key && year !== null
        ? recompCards.get(key)?.find((group) => {
            const known = releaseYear(group.game)
            return known !== null && Math.abs(known - year) <= 1
          })
        : undefined
    if (home) {
      home.copies.push(game)
      // The card's last played is the latest of every copy (as mergeCopies), the host's among them.
      if (playedAt(game) > playedAt(home.game))
        home.game = { ...home.game, lastPlayed: game.lastPlayed }
    } else groups.push({ game, copies: [game] })
  }
  return groups
}

/** When a game was last played (ms), 0 for never or no date. */
function playedAt(game: Pick<Game, 'lastPlayed'>): number {
  const t = game.lastPlayed ? Date.parse(game.lastPlayed) : 0
  return Number.isNaN(t) ? 0 : t
}

/** collapsedGames (lib/copies.ts) over a pool that may hold host-only games. */
export function collapsedWithRemote(
  games: readonly Game[],
  options: CopyOptions = {}
): {
  games: Game[]
  copies: Map<string, number>
} {
  const copies = new Map<string, number>()
  const shown: Game[] = []
  for (const group of collapseWithRemote(games, options)) {
    shown.push(group.game)
    if (group.copies.length > 1) copies.set(group.game.id, group.copies.length)
  }
  return { games: shown, copies }
}

/** A game by id among this PC's games, else among the host-only ones (the game page opens either). */
export function findGame(
  gameId: string,
  byId: ReadonlyMap<string, Game>,
  remote: RemoteLibrary | null | undefined
): Game | undefined {
  return byId.get(gameId) ?? remote?.games.find((g) => g.id === gameId)
}

/** True for a game only a paired host has (id `remote:<hostId>:<hostGameId>`). */
export function isRemoteGame(game: Pick<Game, 'remote'>): boolean {
  return !!game.remote
}

/**
 * This PC's game that a host-only game (`remote:<hostId>:<hostGameId>`) became: the local game the host also has that
 * very game for (RemoteLibrary.alsoOnHost), and that is in the library (`inLibrary`, when given). A game downloaded
 * from a host stops being a host-only game, so a page opened on its `remote:` id turns into this one. Undefined for any
 * other id, or none.
 */
export function localCopyOfHostGame(
  remoteId: string,
  alsoOnHost:
    Readonly<Record<string, readonly { hostId: string; hostGameId: string }[]>> | undefined,
  inLibrary: (id: string) => boolean = () => true
): string | undefined {
  const m = /^remote:([^:]+):(.+)$/.exec(remoteId)
  if (!m || !alsoOnHost) return undefined
  const [, hostId, hostGameId] = m
  for (const [localId, infos] of Object.entries(alsoOnHost))
    if (inLibrary(localId) && infos.some((i) => i.hostId === hostId && i.hostGameId === hostGameId))
      return localId
  return undefined
}

/**
 * What the Play slot does for a host-only game: a ROM the host lets this PC copy is downloaded (Stream moves to the
 * menu); everything else streams. null for this PC's own games and for a host game it can do neither with.
 */
export function remotePrimaryAction(
  game: Pick<Game, 'remote' | 'source'>
): 'stream' | 'download' | null {
  const info = game.remote
  if (!info) return null
  if (game.source === 'rom' && info.downloadable) return 'download'
  return info.streamable ? 'stream' : null
}

/**
 * The hosts a game can be streamed from: every host that has it. A host-only game found on several hosts is one card
 * (from the first host) with all of them under its id in alsoOnHost; one host's game has just its own.
 */
export function streamHosts(
  game: Pick<Game, 'id' | 'remote'>,
  alsoOnHost: Record<string, RemoteGameInfo[]> | null | undefined
): RemoteGameInfo[] {
  const also = alsoOnHost?.[game.id]
  const hosts = also?.length ? also : game.remote ? [game.remote] : []
  return hosts.filter((info) => info.streamable)
}

/** Connecting to the host (the Play slot says "Connecting…" and cannot be pressed again). */
export function streamBusy(session: Pick<StreamSession, 'state'> | null | undefined): boolean {
  const state = session?.state
  return state === 'preparing' || state === 'pairing' || state === 'connecting'
}

/** The game is on screen through Moonlight right now. */
export function streamActive(session: Pick<StreamSession, 'state'> | null | undefined): boolean {
  return session?.state === 'streaming'
}

/**
 * The busy label of the Play slot while a stream starts. `moonlight`: this PC's Moonlight, downloaded during the
 * first stream's 'preparing' step (the slot then says so, with its progress).
 */
export function streamBusyLabel(
  session: Pick<StreamSession, 'state' | 'hostName'>,
  moonlight?: Pick<StreamingToolStatus, 'state' | 'percent'> | null
): string {
  if (session.state === 'preparing' && moonlight?.state === 'downloading')
    return moonlight.percent !== undefined
      ? t('lib.streaming.moonlightPercent', { percent: Math.round(moonlight.percent) })
      : t('lib.streaming.moonlight')
  if (session.state === 'pairing') return t('lib.streaming.pairing')
  if (session.state === 'preparing') return t('lib.streaming.starting', { host: session.hostName })
  return t('lib.streaming.connecting')
}

/** A ROM download in progress (not yet done, failed or cancelled). */
export function downloadRunning(progress: RomDownloadProgress | null | undefined): boolean {
  return progress?.state === 'downloading'
}

/**
 * The message of a ROM download whose host went offline mid-download ("Waiting for <host> to come back online", main's
 * hostOfflineMessage, flagged `hostOffline`): main sends it once as a 'failed' event, but the game keeps its place in
 * the install queue and restarts when the host answers again. Undefined for any other progress (a real failure among
 * them). Goes by the flag, never by the words, which are translated.
 */
export function hostOfflineWait(
  progress: Pick<RomDownloadProgress, 'state' | 'message' | 'hostOffline'> | null | undefined
): string | undefined {
  return progress?.state === 'failed' && progress.hostOffline === true && progress.message
    ? progress.message
    : undefined
}

/** The parts of an InstallProgress the Play slot's progress block reads. */
export type ProgressView = Pick<
  InstallProgress,
  'state' | 'percent' | 'bytesDone' | 'bytesTotal' | 'message' | 'stalled'
>

/**
 * A ROM download shaped like a tracked install, for the same progress block (percent and "X of Y"). A paused one
 * (pauseInstall) reads as 'queued' with "Paused": it waits its turn again once resumed.
 */
export function romDownloadProgressView(progress: RomDownloadProgress): ProgressView {
  const known = progress.bytesTotal > 0
  return {
    state:
      progress.state === 'downloading'
        ? 'downloading'
        : progress.state === 'paused'
          ? 'queued'
          : progress.state === 'done'
            ? 'done'
            : 'failed',
    percent: known ? progress.percent : undefined,
    bytesDone: known ? progress.bytesDone : undefined,
    bytesTotal: known ? progress.bytesTotal : undefined,
    message:
      progress.message ??
      (progress.state === 'paused' ? t('lib.streaming.paused') : t('lib.streaming.downloading'))
  }
}

/** "On Living Room PC" (the game page's chip for a host-only game). */
export function hostChipLabel(info: Pick<RemoteGameInfo, 'hostName'>): string {
  return t('lib.streaming.onHost', { host: info.hostName })
}

/**
 * The size stat beside the Play slot for a host game: a downloadable ROM's whole file set ("Download size"); null
 * otherwise (installSizeText's store estimate then applies, as for any game that is not installed).
 */
export function remoteSizeText(
  game: Pick<Game, 'remote' | 'source'>
): { label: string; value: string; estimate: boolean } | null {
  const info = game.remote
  if (!info || !info.downloadable || !info.sizeBytes) return null
  return {
    label: t('lib.streaming.downloadSize'),
    value: formatBytes(info.sizeBytes),
    estimate: false
  }
}
