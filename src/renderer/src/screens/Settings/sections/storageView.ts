// Settings › Storage's numbers: the games on this PC with their sizes, and the drive bar's totals.
import { recompInPlaceOf } from '@shared/recomp-play'
import type { Game, StorageDrive } from '@shared/types'
import { displayTitle } from '../../../lib/library'
import { measuredSize } from '../../../lib/installSize'

export interface StorageGame {
  game: Game
  /** What it takes on disk; null when not known yet. */
  bytes: number | null
  /** The store's figure stands in (the folder could not be measured): shown as "About …". */
  estimate: boolean
  /** Where its files are (the measured folder or file, else its install folder or ROM), when known. */
  path: string | null
}

/** A game's files: the path its size was measured at, else its install folder, ROM or deleted ROM. */
function pathOf(game: Game): string | null {
  return (
    game.installSize?.path ??
    game.installDir ??
    game.romPath ??
    game.romRemoved?.installSize?.path ??
    null
  )
}

/** A game whose files are on this PC: installed here (not a paired host's), or played from its recompilation. */
function onThisPc(game: Game): boolean {
  if (game.remote || game.id.startsWith('remote:')) return false
  return game.installed || recompInPlaceOf(game) !== null
}

/**
 * The games on this PC, largest first (unknown sizes last, then by title): the size the user entered, else the one
 * measured here, else the store's figure as an estimate.
 */
export function storageGames(games: readonly Game[]): StorageGame[] {
  const list = games.filter(onThisPc).map((game): StorageGame => {
    const path = pathOf(game)
    if (game.user.installSize) return { game, bytes: game.user.installSize, estimate: false, path }
    const measured = measuredSize(game)
    if (measured && measured.bytes > 0)
      return { game, bytes: measured.bytes, estimate: false, path }
    const store = game.metadata.storage?.bytes
    return store
      ? { game, bytes: store, estimate: true, path }
      : { game, bytes: null, estimate: false, path }
  })
  return list.sort(
    (a, b) =>
      (b.bytes ?? -1) - (a.bytes ?? -1) || displayTitle(a.game).localeCompare(displayTitle(b.game))
  )
}

export interface StorageTotals {
  /** The drives' size, free space, the games' sizes and everything else ("Other"), in bytes. */
  total: number
  free: number
  games: number
  other: number
  /** The bar's parts, 0..1 of `total`. */
  gamesShare: number
  otherShare: number
}

/**
 * The bar of all fixed drives together: "Other" is what is used but not by the games listed (size − free − games),
 * never scanned. Only games on those drives count (one on a USB or network drive is listed but outside the bar), a
 * game inside another one's folder (an extra entry for its launcher, say) counts once, and the games never count for
 * more than the used space (estimates can overshoot).
 */
export function storageTotals(
  drives: readonly StorageDrive[],
  games: readonly StorageGame[]
): StorageTotals {
  const total = drives.reduce((sum, d) => sum + d.totalBytes, 0)
  const free = Math.min(
    total,
    drives.reduce((sum, d) => sum + d.freeBytes, 0)
  )
  const used = total - free
  const gameBytes = Math.min(
    used,
    countedGames(drives, games).reduce((sum, g) => sum + (g.bytes ?? 0), 0)
  )
  const other = Math.max(0, used - gameBytes)
  return {
    total,
    free,
    games: gameBytes,
    other,
    gamesShare: total > 0 ? gameBytes / total : 0,
    otherShare: total > 0 ? other / total : 0
  }
}

/** Lower-case, back-slashed, without a trailing slash: comparable paths. */
const norm = (path: string): string => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * The games the bar adds up: on one of the drives (a game whose place is unknown counts), and not inside a folder of
 * another counted game (outer folders first, so a launcher entry inside its game's folder is the one left out).
 */
export function countedGames(
  drives: readonly StorageDrive[],
  games: readonly StorageGame[]
): StorageGame[] {
  const roots = new Set(drives.map((d) => d.root.slice(0, 2).toLowerCase()))
  const onDrives = games.filter((g) => !g.path || roots.has(norm(g.path).slice(0, 2)))
  const byPathLength = [...onDrives].sort(
    (a, b) => (a.path ? norm(a.path).length : Infinity) - (b.path ? norm(b.path).length : Infinity)
  )
  const kept: StorageGame[] = []
  const folders: string[] = []
  for (const g of byPathLength) {
    const path = g.path ? norm(g.path) : null
    if (path && folders.some((f) => path === f || path.startsWith(`${f}\\`))) continue
    kept.push(g)
    if (path) folders.push(path)
  }
  return kept
}
