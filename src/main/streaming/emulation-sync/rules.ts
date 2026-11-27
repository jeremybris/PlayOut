import { join, sep } from 'path'
import { safeEntryPath } from '../../util/zip'

/**
 * What the Emulation folder sync covers. Paths travel between PCs relative to the Emulation folder, with forward
 * slashes and their own letter case; they are compared by `syncKey` (lower case), since Windows does not tell
 * "Saves" from "saves".
 *
 * Left out:
 * - `roms` and `texturepacks` (the user's choice), with everything in them, at the top of the folder;
 * - `Updates and DLC` (the user's choice): games' updates and DLC, per console; a PS3 game's go with its download
 *   instead (ps3HddFiles). It is named in the manifest's exclusions too (UPDATES_DLC_KEY), so an older PlayOut on the
 *   other PC leaves it alone as well;
 * - the ROM folder, when it is another folder inside the Emulation folder;
 * - the leftovers of PlayOut's own work: a sync's files in progress (`.playout-sync`) and the emulator setup's
 *   junction probes and moved folders (`.playout-new`, `.playout-old`, `.playout-old-2`…).
 * Kept in: "Recompilations Saves", the copies of recompilation saves (src/main/recomp/cloud.ts): this sync is how they
 * reach the other PC. Their work in progress uses the `.playout-new` / `.playout-old` names above, and their backups
 * stay outside the Emulation folder.
 * Junctions and other links are never followed or copied (the walker skips them): each PC's emulator setup makes
 * its own, pointing at that PC's folders.
 */

export const EXCLUDED_TOP = ['roms', 'texturepacks'] as const

/** PlayOut's own in-progress names, anywhere in the tree. */
const OWN_LEFTOVER = /\.playout-(sync|new|old(-\d+)?)$/i

/**
 * The file that names an Emulation folder for the sync (a random id, made the first time the folder is synced). A
 * folder without it, or with another one, is not the folder last synced (new, moved, emptied, another drive): the
 * comparison starts over and merges, so it never reads as "every file was deleted".
 */
export const FOLDER_ID_FILE = '.playout-sync-id'

/** The comparison key of a relative path: forward slashes, lower case. */
export function syncKey(relative: string): string {
  return relative.replace(/\\/g, '/').toLowerCase()
}

export interface SyncScope {
  /** Extra excluded folders, relative keys (the ROM folder when it is inside the Emulation folder). */
  extraExcluded: string[]
}

/** Whether a relative path (file or folder) is left out of the sync. */
export function isExcluded(relative: string, scope: SyncScope): boolean {
  const key = syncKey(relative)
  const top = key.split('/')[0]!
  if ((EXCLUDED_TOP as readonly string[]).includes(top)) return true
  if (scope.extraExcluded.some((x) => key === x || key.startsWith(`${x}/`))) return true
  if (key === FOLDER_ID_FILE) return true
  return key.split('/').some((part) => OWN_LEFTOVER.test(part))
}

/**
 * A relative path received from the other PC, checked: inside the folder (no drive letters, '..', or characters
 * Windows refuses) and not excluded. Returns it with forward slashes, or null.
 */
export function cleanSyncPath(relative: unknown, scope: SyncScope): string | null {
  if (typeof relative !== 'string' || relative.length > 1024) return null
  const safe = safeEntryPath(relative)
  if (!safe) return null
  const clean = safe.split(sep).join('/')
  return isExcluded(clean, scope) ? null : clean
}

/** The absolute path of a checked relative path under `root`. */
export function absolutePath(root: string, relative: string): string {
  return join(root, ...relative.split('/'))
}

/**
 * RPCS3's dev_hdd0 where PlayOut kept it before 0.1.109. It now lives in Updates and DLC/PS3 (never synced; a game's
 * updates and DLC go with its download), and each PC moves its own copy there. Left out so that move never reads as a deletion
 * on another PC that has not moved its copy yet (this PC's manifest names it as excluded, so an older client keeps it).
 */
export const OLD_PS3_HDD = 'storage/rpcs3/dev_hdd0'

/** Emulation\Updates and DLC, as a sync key: never synced (see the top of this file). */
export const UPDATES_DLC_KEY = 'updates and dlc'

/**
 * Extra exclusions: the old PS3 HDD place (OLD_PS3_HDD), Updates and DLC (UPDATES_DLC_KEY), and the ROM folder when
 * it lies inside the Emulation folder (but is not its `roms`).
 */
export function scopeFor(root: string, romsRoot: string | null | undefined): SyncScope {
  const extraExcluded: string[] = [OLD_PS3_HDD, UPDATES_DLC_KEY]
  if (romsRoot) {
    const a =
      root
        .replace(/[\\/]+$/, '')
        .toLowerCase()
        .replace(/\//g, '\\') + '\\'
    const b = romsRoot
      .replace(/[\\/]+$/, '')
      .toLowerCase()
      .replace(/\//g, '\\')
    if (`${b}\\`.startsWith(a) && b.length + 1 > a.length)
      extraExcluded.push(syncKey(b.slice(a.length)))
  }
  return { extraExcluded }
}
