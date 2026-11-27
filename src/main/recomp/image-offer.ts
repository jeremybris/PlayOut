// "Delete the original disc image?" (Recompilations, ARCHITECTURE.md §4.14): once a recompilation is ready and no
// longer needs the player's disc image, PlayOut offers to move the image to the Recycle Bin. The library card stays
// (Game.romRemoved) and starts the recompilation. When to ask:
// - the player identified the program that starts the game (picked it under Program, in UP's "Which program starts…"
//   prompt, or confirmed PlayOut's pick with Automatic): at once;
// - PlayOut identified it on its own (one program fits, the developer names it, a setup program put it in place):
//   after AUTO_STARTS_BEFORE_ASK successful starts of that same program (the count starts again when it changes).
// Never for a recompilation that still reads the image at every start (a game file passed on the command line, in an
// environment variable or copied into its folder from the image: gamefiles.ts prepareLaunch), and once per
// recompilation and image (Keep it is remembered). The decisions are pure here; service.ts does the file work.
import { dirname, extname } from 'path'
import {
  AUTO_STARTS_BEFORE_ASK,
  type GameFileState,
  type InstalledRecomp
} from '../../shared/recomp'
import type { Game } from '../../shared/types'
import { isInside, normalizePath } from '../util/paths'
import { tMain } from '../i18n'

/** Disc image files (and the sheets that list them): what the question is about. Cartridge ROMs are not asked about. */
export const DISC_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.iso',
  '.xiso',
  '.chd',
  '.cso',
  '.zso',
  '.ciso',
  '.rvz',
  '.gcz',
  '.wbfs',
  '.wia',
  '.nkit',
  '.cue',
  '.gdi',
  '.cdi',
  '.m3u',
  '.img',
  '.mdf',
  '.nrg',
  '.pbp',
  '.ecm',
  '.god'
])

/** Whether `path` names a disc image (by its extension). */
export function isDiscImage(path: string): boolean {
  return DISC_IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

/** One question per recompilation and image. */
export function imageOfferKey(recompId: string, image: string): string {
  return `${recompId}|${normalizePath(image)}`
}

/**
 * A library game whose disc image may be asked about: a ROM of this PC (not a host's), installed, with a disc image
 * file, not already moved to the Recycle Bin.
 */
export function hasDiscImage(game: Game): boolean {
  return (
    !game.remote &&
    !game.id.startsWith('remote:') &&
    game.source === 'rom' &&
    game.installed &&
    !game.romRemoved &&
    !!game.romPath &&
    isDiscImage(game.romPath)
  )
}

/** How a game file reaches the recompilation at every start (so the file must stay). */
const READ_AT_START: ReadonlySet<GameFileState['how']> = new Set(['flag', 'env', 'folder'])

/**
 * Whether the recompilation reads the image (any of its `files`) at every start: a need it is chosen or picked for
 * from the library is passed as an argument, an environment variable, or copied in from it before each start. A need
 * given a folder that holds the image (one that takes a folder) reads it too.
 */
export function readsImageAtStart(
  states: readonly GameFileState[],
  files: readonly string[]
): boolean {
  return states.some(
    (s) => !!s.path && READ_AT_START.has(s.how) && files.some((f) => isInside(s.path!, f))
  )
}

/**
 * Why the image (its `files`) must stay for a recompilation with these game-file states, or null when it may go:
 * it 'reads' it at every start (readsImageAtStart), or it is 'not-ready' (a game file it needs is not chosen yet, so
 * it cannot be played, and the player may still need the image to pick or make that file from).
 */
export function imageStays(
  states: readonly GameFileState[],
  files: readonly string[]
): 'reads' | 'not-ready' | null {
  if (readsImageAtStart(states, files)) return 'reads'
  if (states.some((s) => !s.ready)) return 'not-ready'
  return null
}

/** The player picked or confirmed the program `exeFull` (mutates `rec`): ask at once. */
export function notePlayerExe(rec: InstalledRecomp, exeFull: string): void {
  rec.exeIdentified = { exe: normalizePath(exeFull), by: 'player', starts: 0 }
}

/**
 * A start of `exeFull` succeeded (mutates `rec`). `byPlayer`: the player chose that program (Program, UP's prompt).
 * Returns whether to ask now: always for a program the player identified (an older pick asks at its next start), and
 * for PlayOut's own pick once it has started AUTO_STARTS_BEFORE_ASK times in a row as that same program.
 */
export function countStart(rec: InstalledRecomp, exeFull: string, byPlayer: boolean): boolean {
  const exe = normalizePath(exeFull)
  const cur = rec.exeIdentified
  if (byPlayer || (cur?.by === 'player' && cur.exe === exe)) {
    rec.exeIdentified = {
      exe,
      by: 'player',
      starts: (cur?.exe === exe ? cur.starts : 0) + 1
    }
    return true
  }
  const starts = cur?.by === 'auto' && cur.exe === exe ? cur.starts + 1 : 1
  rec.exeIdentified = { exe, by: 'auto', starts }
  return starts >= AUTO_STARTS_BEFORE_ASK
}

// --- "Delete the unpacked game folder" ------------------------------------------------------------------------------
// A setup program that takes the game unpacked (game-folder.ts, Xerenge) installs from the folder PlayOut unpacked the
// player's disc image into. Such a folder is often the installed game's own data: Xerenge's installer treats
// <install>\game as the game (it is "installed" when <install>\game\default.xex and <install>\xerenge.conf exist), puts
// its title updates and mods folder in it, and installs only the program and its libraries in <install>\bin, which
// reads the game from <install>\game. So it is offered (the Delete dropdown, in the same question) only once the game
// the player plays is installed somewhere else, leaving PlayOut's unpacked copy unused (unpackedFolderUse).

/** A question about the unpacked game folder alone (no disc image left to ask about). */
export function folderOfferKey(recompId: string, folder: string): string {
  return `${recompId}|folder|${normalizePath(folder)}`
}

/** What the recompilation uses on disk, for unpackedFolderUse. */
export interface RecompDiskUse {
  /** The program that starts the game (full path); null when it is not known. */
  program: string | null
  /** The folder it is started in. */
  cwd: string | null
  /** Every installed recompilation's install folder (and the Recompilations folder itself). */
  installDirs: readonly string[]
  /** The game files chosen for it (full paths). */
  gameFiles: readonly string[]
}

const related = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a)

/**
 * Why the unpacked game folder `folder` is (or may be) used by the recompilation, or null when it may go. The rule,
 * kept wide on purpose because what a setup's game reads at run time is not known:
 * - the program that starts the game is not identified;
 * - its program is anywhere inside the folder's parent (the setup's install folder: Xerenge's
 *   <install>\bin\burnout.exe reads <install>\game), or the folder is anywhere below the program's own folder;
 * - the folder it is started in holds the folder or is inside it;
 * - an install folder of a recompilation (or the Recompilations folder) holds it or is inside it;
 * - a game file chosen for it is inside the folder, or holds it.
 */
export function unpackedFolderUse(folder: string, use: RecompDiskUse): string | null {
  if (!use.program) return tMain('mainRecomp.folderUse.programUnknown')
  if (isInside(folder, use.program)) return tMain('mainRecomp.folderUse.programInside')
  if (isInside(dirname(folder), use.program)) return tMain('mainRecomp.folderUse.installedAround')
  if (isInside(dirname(use.program), folder)) return tMain('mainRecomp.folderUse.programAbove')
  if (use.cwd && related(use.cwd, folder)) return tMain('mainRecomp.folderUse.cwdAbove')
  if (use.installDirs.some((d) => d && related(d, folder)))
    return tMain('mainRecomp.folderUse.recompAround')
  if (use.gameFiles.some((f) => f && related(f, folder)))
    return tMain('mainRecomp.folderUse.holdsGameFile')
  return null
}
