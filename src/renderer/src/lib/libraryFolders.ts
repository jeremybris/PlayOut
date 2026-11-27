// The Library header's folder button: the folders on this PC that hold the games a tab's Platform filter (systems and stores)
// pick (Filters > Platform: each system's folder in the ROMs folder; Filters > Platform below the line: the folders a store keeps its games
// in, like Steam's steamapps\common). Other filters do not count.
import type { Game } from '@shared/types'
import { t } from '../i18n'

/** The most folders one press opens (a manual-games filter can name many). */
export const MAX_FOLDERS = 10

/** Windows-style folder of a path (works on both slash kinds); '' for a bare name. */
function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut > 0 ? trimmed.slice(0, cut) : ''
}

/** Comparable form of a path (case and slashes). */
const keyOf = (path: string): string => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * The folder a game's files live in, at the level the user browses: a ROM's system folder (the ROMs folder's
 * `xbox360` for `xbox360\Halo\default.xex`), a store game's library folder (Steam's `common`, an Xbox game's
 * `XboxGames`). null for a game not on this PC, or in a protected Windows folder.
 */
export function gameFolderOf(game: Game): string | null {
  if (game.remote || game.id.startsWith('remote:')) return null
  if (game.source === 'rom') {
    const rom = game.romPath ?? game.romRemoved?.romPath
    if (!rom || typeof game.externalId !== 'string') return null
    // externalId is the path below the ROMs folder ("xbox360/Halo/default.xex"): its first part is the system's folder.
    const depth = game.externalId.split(/[\\/]/).filter(Boolean).length
    let folder = rom
    for (let i = 1; i < depth; i++) folder = parentOf(folder)
    return folder || null
  }
  if (!game.installed || !game.installDir) return null
  // An Xbox app game's folder is "<Game>\Content": its library is two levels up.
  const dir = /[\\/]content[\\/]*$/i.test(game.installDir)
    ? parentOf(game.installDir)
    : game.installDir
  const library = parentOf(dir)
  if (!library || /[\\/]windowsapps([\\/]|$)/i.test(library)) return null
  return library
}

/**
 * The folders to open for a tab's Platform / PC filters: those of the games `games` (the tab's games for just those
 * filters), the most games first, plus each picked system's folder in the ROMs folder (`romsRoot`) when it has no
 * game yet. At most MAX_FOLDERS; `more` counts the ones left out.
 */
export function filterFolders(
  games: readonly Game[],
  systemFilters: readonly string[],
  romsRoot: string | null
): { folders: string[]; more: number } {
  const counts = new Map<string, { path: string; games: number }>()
  for (const game of games) {
    const folder = gameFolderOf(game)
    if (!folder) continue
    const key = keyOf(folder)
    const entry = counts.get(key) ?? { path: folder, games: 0 }
    entry.games++
    counts.set(key, entry)
  }
  if (romsRoot)
    for (const system of systemFilters) {
      const folder = `${romsRoot.replace(/[\\/]+$/, '')}\\${system}`
      const key = keyOf(folder)
      if (!counts.has(key)) counts.set(key, { path: folder, games: 0 })
    }
  const ordered = [...counts.values()]
    .sort((a, b) => b.games - a.games || a.path.localeCompare(b.path))
    .map((e) => e.path)
  return { folders: ordered.slice(0, MAX_FOLDERS), more: Math.max(0, ordered.length - MAX_FOLDERS) }
}

/** Whether `path` is `root` or a folder inside it (case and slashes ignored). */
function isInside(root: string, path: string): boolean {
  const r = keyOf(root)
  const p = keyOf(path)
  return p === r || p.startsWith(`${r}\\`)
}

/**
 * The folder button's error when none of the folders it tried is there (`missing`, from main): which ones, then
 * advice that fits them. ROM folders (inside the ROMs folder `romsRoot`, or a ROM game's folder in `games`) move with
 * the Emulation folder; a store game's folder belongs to its store, which the Emulation folder has nothing to do with.
 */
export function missingFoldersMessage(
  missing: readonly string[],
  games: readonly Game[],
  romsRoot: string | null
): string {
  const romFolders = new Set<string>()
  for (const game of games)
    if (game.source === 'rom') {
      const folder = gameFolderOf(game)
      if (folder) romFolders.add(keyOf(folder))
    }
  const isRom = (path: string): boolean =>
    (romsRoot !== null && isInside(romsRoot, path)) || romFolders.has(keyOf(path))
  const which =
    missing.length > 1
      ? t('lib.folders.notFoundMore', { path: missing[0] ?? '', count: missing.length - 1 })
      : t('lib.folders.notFound', { path: missing[0] ?? '' })
  const advice: string[] = []
  if (missing.some(isRom)) advice.push(t('lib.folders.movedRoms'))
  if (missing.some((path) => !isRom(path))) advice.push(t('lib.folders.movedGames'))
  return [which, ...advice].join(' ')
}
