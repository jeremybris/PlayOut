import { playableHere, staleStandIns } from '@shared/recomp-play'
import type { Game, HomeRowMode, RemoteGameInfo, StreamingStatus } from '@shared/types'
import { t } from '../i18n'
import { mergeCopies, type CopyGroup, type CopyOptions } from './copies'
import { compareByTitle, recentGames } from './library'
import { storeNameOf } from './platforms'
import { collapseWithRemote, remotePrimaryAction, streamHosts } from './streaming'

/**
 * Home's Recent Games row (and the hero and start game that follow it): the games played most recently on this PC or
 * on any paired PC, whether or not they are installed here, as long as this PC can play or get them. Pure selectors,
 * like lib/library.ts. When each game was last played on the other PCs comes from main: the play time sync brings the
 * sessions of the games both PCs have, and a host's offer dates the games only it has (ARCHITECTURE.md §4.13).
 */

/** What obtainableHere needs to know of the paired hosts. */
export interface HostAccess {
  /** RemoteLibrary.alsoOnHost: the hosts that have each of this PC's games. */
  alsoOnHost?: Record<string, RemoteGameInfo[]> | null
  /** Settings > Streaming > show the hosts' games: off, a host's copy is no way to get a game. */
  showHostGames: boolean
}

/**
 * The game can be played on this PC, or got onto it: it is installed here (or its recompilation stands in for it:
 * playableHere); a paired host has it (streamed, or its ROM downloaded: a host-only game, or a game of this PC a host
 * also has), while the hosts' games are shown; or one of this PC's store accounts owns it (installed from its store).
 * Not so for what is left: a record kept only for its history (uninstalled and no longer owned, a ROM or .exe that is
 * gone) that no host offers. A game only another client of the host has is such a record at most, never a card.
 */
export function obtainableHere(
  game: Pick<Game, 'id' | 'source' | 'installed' | 'owned' | 'romRemoved' | 'metadata' | 'remote'>,
  hosts: HostAccess
): boolean {
  if (playableHere(game)) return true
  if (game.remote) return hosts.showHostGames && remotePrimaryAction(game) !== null
  if (game.owned === true && storeNameOf(game.source) !== undefined) return true
  return hosts.showHostGames && streamHosts(game, hosts.alsoOnHost).length > 0
}

/** The game was played, on this PC or a paired one. Its date says so: a store's or a host's game has no play count. */
function wasPlayed(game: Pick<Game, 'lastPlayed'>): boolean {
  const at = game.lastPlayed ? Date.parse(game.lastPlayed) : Number.NaN
  return Number.isFinite(at) && at > 0
}

/**
 * The card of a group in the row: a copy this PC can play now when it has one (the row never greys a game that is
 * installed here), with the facts of every copy; else the group's own card.
 */
function cardOf(group: CopyGroup): Game {
  if (playableHere(group.game) || !group.copies.some((copy) => playableHere(copy)))
    return group.game
  return mergeCopies([
    ...group.copies.filter((copy) => playableHere(copy)),
    ...group.copies.filter((copy) => !playableHere(copy))
  ])
}

/**
 * This PC is a client: it is paired with at least one host. Only a client's Recent row takes games that are not
 * installed here; a PC with no host (on its own, or only a host itself) keeps its installed games only.
 */
export function isStreamingClient(
  status: Pick<StreamingStatus, 'client'> | null | undefined
): boolean {
  return (status?.client.hosts.length ?? 0) > 0
}

export interface RecentOptions extends HostAccess, CopyOptions {
  /** This PC is paired with at least one host (isStreamingClient): the row takes games not installed here. */
  client: boolean
  /** The most cards (Settings > Appearance); negative for all. */
  count: number
}

/**
 * The Recent Games row, most recently played first. `visible`: the games the Library shows (visibleGames with the
 * hosts' games: hidden games and the switches that hide uninstalled or host games already applied). Of those:
 *  - a game installed here is always in, played or not (never-played ones come last, newest added first);
 *  - on a client of a host (`options.client`), a game not installed here is in only when it was played (here once,
 *    or on a paired PC) and obtainableHere: a host's game, a game a store account owns. Never-played ones never pad
 *    the row, and a played record this PC can neither install nor stream is left out. A PC with no host shows none
 *    of them: its row is its installed games, as before the hosts' games came to it;
 *  - an old record its recompilation stands in for beside another copy on this PC (staleStandIns) is never in:
 *    visibleGames and localOnHost both leave it out, and it is filtered here too for a caller passing another pool;
 *  - one game is one card (the Library's groups: lib/copies.ts, collapseWithRemote), dated by the most recent play of
 *    any of these copies.
 */
export function recentlyPlayed(visible: readonly Game[], options: RecentOptions): Game[] {
  const stale = staleStandIns(visible)
  const pool = visible.filter(
    (game) =>
      !stale.has(game.id) &&
      (playableHere(game) || (options.client && wasPlayed(game) && obtainableHere(game, options)))
  )
  const groups = collapseWithRemote(pool, { showDuplicates: options.showDuplicates })
  return recentGames(groups.map(cardOf), options.count)
}

const timeOf = (iso: string | undefined): number => {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at) ? at : 0
}

export interface HomeRowOptions extends RecentOptions {
  /** Settings > Library > Front page (settings.ui.homeRow). */
  mode: HomeRowMode
}

/**
 * Home's row of games, as Settings > Library > Front page chooses (the hero and start game follow its first card):
 *  - 'recent': Recently Played (recentlyPlayed, the default);
 *  - 'added': Recently Added: the games this PC can play now (installed, or a recompilation that stands in), newest
 *    added to the library first (a game with several copies is dated by its newest copy);
 *  - 'favorites': Favorites: the favourite games this PC can play or get (obtainableHere: greyed when not installed,
 *    as in the Library), most recently played first, then newest added, then by title;
 *  - 'played': Most Played: the games of Recently Played (the same games), most play time first (a game's copies
 *    added up, its store's play time counted as the Library's Most played sort does); games never played follow, as
 *    in Recently Played.
 * One game is one card, as in recentlyPlayed; `options.count` cards at most.
 */
export function homeRowGames(visible: readonly Game[], options: HomeRowOptions): Game[] {
  if (options.mode === 'recent') return recentlyPlayed(visible, options)
  const stale = staleStandIns(visible)
  const pool = visible.filter((game) => {
    if (stale.has(game.id)) return false
    if (options.mode === 'added') return playableHere(game)
    if (options.mode === 'played')
      return (
        playableHere(game) || (options.client && wasPlayed(game) && obtainableHere(game, options))
      )
    return game.favorite && obtainableHere(game, options)
  })
  const groups = collapseWithRemote(pool, { showDuplicates: options.showDuplicates })
  if (options.mode === 'favorites') return recentGames(groups.map(cardOf), options.count)
  if (options.mode === 'played') {
    const minutes = (group: CopyGroup): number =>
      group.copies.reduce(
        (sum, copy) => sum + copy.playtimeMinutes + (copy.storePlaytimeMinutes ?? 0),
        0
      )
    const cards = new Map(groups.map((group) => [group, cardOf(group)]))
    // Then as Recently Played: last played, newest added, title.
    const tie = recentGames([...cards.values()], -1)
    const rank = new Map(tie.map((game, i) => [game, i]))
    const sorted = [...groups]
      .sort(
        (a, b) => minutes(b) - minutes(a) || rank.get(cards.get(a)!)! - rank.get(cards.get(b)!)!
      )
      .map((group) => cards.get(group)!)
    return options.count >= 0 ? sorted.slice(0, options.count) : sorted
  }
  const added = (group: CopyGroup): number =>
    Math.max(timeOf(group.game.addedAt), ...group.copies.map((copy) => timeOf(copy.addedAt)))
  const sorted = [...groups]
    .sort((a, b) => added(b) - added(a) || compareByTitle(a.game, b.game))
    .map(cardOf)
  return options.count >= 0 ? sorted.slice(0, options.count) : sorted
}

/** The row's title on Home. */
export function homeRowTitle(mode: HomeRowMode): string {
  if (mode === 'added') return t('lib.recent.added')
  if (mode === 'favorites') return t('lib.recent.favorites')
  if (mode === 'played') return t('lib.recent.played')
  return t('lib.recent.recent')
}
