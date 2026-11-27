// PC Saves: the saves of PC games the user added (Add game), copied to <Emulation folder>/PC Saves so they follow the
// user to the other PCs PlayOut's Emulation folder sync (or a cloud app) shares that folder with. The user picks each
// game's save folder; the copying is the recompilations' (src/main/recomp/cloud.ts). Main: src/main/pc-saves/.

/** PlayOut's folder for these copies in the Emulation folder. */
export const PC_SAVES_FOLDER = 'PC Saves'

/** Above this the folder picked asks to be confirmed (bytes). */
export const PC_SAVES_CONFIRM_BYTES = 100 * 1024 * 1024

/** Where one game's save copy stands, for its Edit sheet and the launch prompt. */
export interface PcSaveView {
  gameId: string
  /** Settings › Library › "Copy saves of games you added". */
  featureOn: boolean
  /** The game's save folder on this PC; null = not set (nothing is copied). */
  folder: string | null
  /** The game's copy in the Emulation folder, once known. */
  copyDir: string | null
  /** When the two sides were last made the same (ISO). */
  syncedAt: string | null
  /** The PC whose saves the copy in the Emulation folder holds. */
  copyMachine: string | null
  /** A copy waiting to be tried again (the Emulation folder could not be reached, a file was locked, too large). */
  pending: boolean
  error: string | null
  /** Both sides changed since the last copy: the user keeps one (the other is backed up first). */
  conflict: { localAt: string; cloudAt: string; cloudDevice: string } | null
  /**
   * A copy of what looks like this game, made by another PC under another name ("Use the copy from <PC>?"): asked
   * once, before it is used.
   */
  confirm: { machine: string; title: string } | null
  /** The game runs now: copies wait until it closes. */
  running: boolean
}

/** A folder checked before it is chosen: its size, shown to the user. */
export interface PcSaveFolderCheck {
  path: string
  bytes: number
  files: number
  /** Over PC_SAVES_CONFIRM_BYTES: the user confirms first. */
  large: boolean
}
