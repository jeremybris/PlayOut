// Moving the Emulation folder (Settings › Library › Emulation Folder): what main measured before the move, the move's
// progress, and its result. The move itself runs in main (src/main/emulation/emulation-move.ts).

/** Where the user wants the Emulation folder. */
export interface EmulationMoveRequest {
  /**
   * 'choose': the folder the user picked (it becomes the Emulation folder when it looks like one or is named
   * Emulation, else an Emulation folder is made inside it); 'generate': an Emulation folder inside the picked folder;
   * 'default': PlayOut's default, Documents\Emulation (`picked` is ignored).
   */
  kind: 'choose' | 'generate' | 'default'
  picked?: string
}

/** What a move would do, shown on the confirmation sheet. */
export interface EmulationMovePlan {
  /** The Emulation folder in use now. */
  from: string
  /** Where it would be from now on. */
  to: string
  /** Why the move cannot happen (translated), or null. */
  blocked: string | null
  /** `to` is the folder in use already: nothing to do. */
  same: boolean
  /** The folder in use exists and holds something: there is something to move. */
  hasContent: boolean
  /** Bytes and files to move (links are not followed and not counted). */
  bytes: number
  files: number
  /** Both folders are on one drive: the move is a rename (instant). */
  sameDrive: boolean
  /** Free bytes on the new place's drive, null when unknown. */
  freeBytes: number | null
  /** Bytes the move needs free on the new place's drive (0 for a rename). */
  neededBytes: number
  /** The new place exists and is not empty: the user picks merge or use it as it is. */
  targetHasContent: boolean
  /** The new place is already laid out like an Emulation folder (roms, bios, saves… or a synced folder's id). */
  targetIsEmulation: boolean
}

/**
 * 'move': the new place is missing or empty; 'merge': move into a non-empty folder (a file there that is newer, or
 * as new, is kept; an older one is replaced and kept aside as *.playout-old); 'switch': use the new place as it is,
 * nothing moved.
 */
export type EmulationMoveMode = 'move' | 'merge' | 'switch'

export interface EmulationMoveProgress {
  phase: 'measuring' | 'moving' | 'copying' | 'verifying' | 'switching' | 'cleaning' | 'done'
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  /** The file being copied (relative to the Emulation folder). */
  current?: string
}

export interface EmulationMoveResult {
  /** The Emulation folder in use now. */
  dir: string
  /** Files were moved (false: switched to the new place without moving, or nothing to move). */
  moved: boolean
  /** Files that stayed in the old place (a newer copy was in the new place, or they could not be removed). */
  leftInOld: number
  /** Older files of the new place replaced during a merge, kept beside them as *.playout-old. */
  keptOlder: number
}

/** The Emulation folder is inside PlayOut's install folder (an older setup): offered once to move it to Documents. */
export interface EmulationFolderOffer {
  current: string
  suggested: string
}
