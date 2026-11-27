import type { Game } from './types'

/**
 * The recompilation that takes a ROM game's place, when Play must start it instead of an emulator: its disc image was
 * deleted once the recompilation was confirmed to work (`romRemoved`), or its game file is no longer where the library
 * had it (`installed` false: moved into the recompilation's folder by hand, say) while a recompilation of it is
 * installed. Then the game page shows Play alone (no UP button) and Play starts this recompilation. Null for a game
 * that still has its file, has no installed recompilation, or is a paired host's game.
 */
export function recompInPlaceOf(
  game: Pick<Game, 'source' | 'installed' | 'romRemoved' | 'metadata'> & { remote?: unknown }
): string | null {
  if (game.remote) return null
  if (game.romRemoved) return game.romRemoved.recompId
  if (game.source !== 'rom' || game.installed) return null
  const info = game.metadata.recomp
  if (!info?.installed.length) return null
  return info.installed.includes(info.preferred) ? info.preferred : info.installed[0]!
}

/**
 * The game can be played on this PC now: installed here, or its recompilation stands in for it (recompInPlaceOf).
 * The Library's cards, filters and playable-first order go by it, so such a game is not greyed as "Not installed".
 */
export function playableHere(
  game: Pick<Game, 'source' | 'installed' | 'romRemoved' | 'metadata'> & { remote?: unknown }
): boolean {
  return game.installed || recompInPlaceOf(game) !== null
}

/**
 * The recompilation Play starts for a game: the one standing in for it (recompInPlaceOf), else, while one of its
 * recompilations is installed, that one (the chosen version if installed, else the first installed). Its page then
 * shows Play alone (no UP button) and the Recomp badge in place of the platform's; the Play menu can still start the
 * emulator. Null for a game with no installed recompilation, or a paired host's game.
 */
export function recompToPlay(
  game: Pick<Game, 'source' | 'installed' | 'romRemoved' | 'metadata'> & { remote?: unknown }
): string | null {
  if (game.remote) return null
  const inPlace = recompInPlaceOf(game)
  if (inPlace) return inPlace
  const info = game.metadata.recomp
  if (!info?.installed.length) return null
  return info.installed.includes(info.preferred) ? info.preferred : info.installed[0]!
}

/** The library games each `staleStandIns` answer was worked out from (the same array is asked again and again). */
const staleCache = new WeakMap<readonly unknown[], ReadonlySet<string>>()

/**
 * Library records that only stand in for a game through its recompilation (their game file gone, not deleted for the
 * recompilation: recompInPlaceOf with the file missing) while another copy of that game is on this PC: the same
 * system's game with the same recompilations (an old record left by a moved or converted file, beside the scan's new
 * one). Their cards are left out, so the game shows once; Play on the other starts the same recompilation.
 */
export function staleStandIns(
  games: readonly (Pick<
    Game,
    'id' | 'source' | 'installed' | 'romRemoved' | 'metadata' | 'platformId'
  > & {
    remote?: unknown
  })[]
): ReadonlySet<string> {
  const cached = staleCache.get(games)
  if (cached) return cached
  const keyOf = (g: (typeof games)[number]): string | null =>
    g.source === 'rom' && g.metadata.recomp?.titleKey
      ? `${g.platformId}\n${g.metadata.recomp.titleKey}`
      : null
  // The games of each system and recompilation title that are on this PC (their file there, or deleted for it).
  const present = new Set<string>()
  for (const g of games) {
    const key = keyOf(g)
    if (key && !g.remote && (g.installed || g.romRemoved)) present.add(key)
  }
  const stale = new Set<string>()
  for (const g of games) {
    const key = keyOf(g)
    if (key && !g.installed && !g.romRemoved && recompInPlaceOf(g) && present.has(key))
      stale.add(g.id)
  }
  staleCache.set(games, stale)
  return stale
}

/**
 * The recompilation a library card is for when the user added it from the recompilations browser (Add to library):
 * a card of that one recompilation, installed or not, kept until the user removes it (whether or not the original
 * game is in the library). Null for any other game.
 */
export function recompAddedId(game: Pick<Game, 'extra'> & { remote?: unknown }): string | null {
  if (game.remote) return null
  const id = game.extra?.recompAdded
  return typeof id === 'string' && id ? id : null
}

/**
 * A card with no game file that plays a recompilation (streamed to paired PCs as such): a recompilation-only card, or
 * an added one whose recompilation is installed.
 */
export function playsOnlyRecomp(
  game: Pick<Game, 'extra' | 'metadata'> & { remote?: unknown }
): boolean {
  return (
    !!recompOnlyKey(game) || (!!recompAddedId(game) && !!game.metadata.recomp?.installed.length)
  )
}

/**
 * A library card that is a recompilation alone: added when a recompilation was installed and its original game was not
 * in the library (`extra.recompOnly` holds the recompilation title's key). It has no game file (a ROM card, not
 * installed, so recompInPlaceOf makes Play start the recompilation); it leaves the library once no recompilation of the
 * game is installed, and merges into the original game when that is added. Null for any other game.
 */
export function recompOnlyKey(game: Pick<Game, 'extra'> & { remote?: unknown }): string | null {
  if (game.remote) return null
  const key = game.extra?.recompOnly
  return typeof key === 'string' && key ? key : null
}
