/**
 * Pure helpers of the overlay's local music player: track URLs, titles, the queue's next / previous track and
 * the per-game playlist (docs/home-overlay.md "Local music"). The player itself is musicPlayer.ts.
 */
import type { Settings } from '@shared/types'
import type { MusicTrack } from '@shared/overlay'

/** The URL the main process serves a track at (`playout-music://track/<relative path>`). */
export function trackUrl(path: string): string {
  return `playout-music://track/${encodeURIComponent(path)}`
}

/** A title for a path that is not (or not yet) in the library: the file name without its extension. */
export function titleFromPath(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[^.]+$/, '') || name
}

/** The track for a playlist path: the library's when it has it, else one made from the path. */
export function trackFor(path: string, byPath: ReadonlyMap<string, MusicTrack>): MusicTrack {
  const known = byPath.get(path)
  if (known) return known
  const parts = path.split('/')
  return {
    path,
    title: titleFromPath(path),
    folder: parts.length > 1 ? parts[parts.length - 2]! : ''
  }
}

/**
 * The queue index after `index`: the next one (wrapping round), or with shuffle a random other one. `random`
 * returns 0 <= n < 1 (Math.random in the app, fixed in tests). -1 when the queue is empty.
 */
export function nextIndex(
  length: number,
  index: number,
  shuffle: boolean,
  random: () => number = Math.random
): number {
  if (length <= 0) return -1
  if (length === 1) return 0
  if (shuffle) {
    // Never the same track twice in a row: pick among the others.
    const pick = Math.floor(random() * (length - 1))
    return pick >= index ? pick + 1 : pick
  }
  return (index + 1) % length
}

/** The queue index before `index`, wrapping round; -1 when the queue is empty. */
export function previousIndex(length: number, index: number): number {
  if (length <= 0) return -1
  return (index - 1 + length) % length
}

/** The playlist with `path` added at the end (unchanged when it is already there). */
export function addToPlaylist(list: readonly string[] | undefined, path: string): string[] {
  const current = list ?? []
  return current.includes(path) ? [...current] : [...current, path]
}

export function removeFromPlaylist(list: readonly string[] | undefined, path: string): string[] {
  return (list ?? []).filter((p) => p !== path)
}

/** What the player does when a game starts: nothing, or play / load (paused) the game's playlist. */
export function gameStartAction(
  gameStart: Settings['music']['gameStart'],
  playlist: readonly string[] | undefined
): 'none' | 'play' | 'load' {
  if (gameStart === 'keep' || !playlist || playlist.length === 0) return 'none'
  return gameStart
}

/** Volume for <audio>: 0-1, clamped (a bad saved value must not throw on assignment). */
export function audioVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0.6
  return Math.min(1, Math.max(0, volume))
}
