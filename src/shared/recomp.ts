// Recompilations: native PC ports (static recompilations, decompilations) of console and old PC games, listed by
// decomp-buddy (tanookistudios.com) and RecompLauncher (recomplauncher.com), downloaded from their GitHub (or GitLab)
// releases into <exeDir>/Recompilations and launched from a game's page (the UP button left of Play). Shared between
// main (src/main/recomp/) and the renderer (the Recompilation page, Settings › Recompilations).

/** A tag shown on a recompilation (RecompLauncher's curated tags, plus PlayOut's own computed ones). */
export interface RecompTag {
  label: string
  /** 'feature' = from the catalog (Widescreen, Mods, ...); the others are computed by PlayOut. */
  kind: 'feature' | 'status' | 'setup' | 'warning'
}

/** How a recompilation gets the user's own game files (ROM, disc image, game folder). */
export type GameFileHow =
  /** The recomp asks for them itself (its own menu / first-start picker); PlayOut only explains what to pick. */
  | 'self'
  /** PlayOut copies the file into a folder of the install (`folder`, relative to the install). */
  | 'folder'
  /** PlayOut passes the file on the command line (`flag`, e.g. "--rom"; empty flag = as a bare argument). */
  | 'flag'
  /** PlayOut sets an environment variable (`env`) to the file. */
  | 'env'
  /** Nothing needed. */
  | 'none'

/** One thing a recompilation asks for before it can run. */
export interface GameFileNeed {
  /** Stable id within the recomp ('game', 'bios', 'update', ...; or the catalog input's id). */
  id: string
  label: string
  /** What to pick, in words ("Your Majora's Mask ROM: the North American N64 version"). */
  description: string
  kind: 'game' | 'bios' | 'dlc' | 'update' | 'other'
  how: GameFileHow
  /** 'file', 'folder' or both. */
  accepts: 'file' | 'folder' | 'either'
  /** Extensions accepted (lowercase, with dot), empty = any. */
  formats: string[]
  /** how 'folder': the folder (relative to the install) the file is copied into. */
  folder?: string
  /** how 'folder': the file name it must have there (else the picked file's own name). */
  fileName?: string
  /**
   * how 'folder' with a folder picked: its files go straight into `folder` ("game/default.xex"), not into a subfolder
   * named after the picked folder.
   */
  intoFolder?: boolean
  /** how 'flag': the command-line flag (may be '' for a bare argument). */
  flag?: string
  /** how 'env': the environment variable. */
  env?: string
  optional: boolean
  /** Known good dumps: lowercase hex, by algorithm. */
  hashes: { algo: 'sha1' | 'md5' | 'crc32' | 'sha256'; value: string }[]
  /** Expected region ("USA", "Europe", ...), when the catalog says. */
  region?: string
  /** Expected serial (PS1/PS2 "SLUS-01013"), when the catalog says. */
  serial?: string
}

/** A need with what PlayOut found / the user picked for it. */
export interface GameFileState extends GameFileNeed {
  /** The file or folder in use (picked by the user, or found in the library). */
  path: string | null
  /** Where `path` came from. */
  source: 'picked' | 'library' | null
  /** 'match' = a known hash matched; 'mismatch' = hashes are known and none matched; 'unverified' = nothing to check. */
  verified: 'match' | 'mismatch' | 'unverified' | null
  /** Whether this need is satisfied enough to start (optional needs, and 'self' needs, are always ready). */
  ready: boolean
}

/** One recompilation project (one repo, or one game inside a multi-game repo). */
export interface RecompEntry {
  /** Stable id: "<host>:<owner>/<repo>" lowercased (host github|gitlab|codeberg), + "#<slug>" for a game in a multi-game repo. */
  id: string
  /** Display name of the project ("Zelda 64: Recompiled"). */
  name: string
  /** The original game's name ("The Legend of Zelda: Majora's Mask"). */
  game: string
  /** PlayOut system id (ES-DE folder name: 'n64', 'psx', 'xbox360', ...) of the original, or 'pc' for a PC original. */
  systemId: string
  /** Original console as display text ("Nintendo 64"). */
  console: string
  /**
   * Other names the original game has on its console, when a catalog gives one: another region's title ("Harry
   * Potter and the Sorcerer's Stone" for "... Philosopher's Stone"), a longer or shorter official one. Library games
   * are matched under these as well (main/recomp/match.ts); never for PC originals.
   */
  otherNames?: string[]
  host: 'github' | 'gitlab' | 'codeberg'
  /** "owner/repo" (GitLab: may contain more slashes). */
  repo: string
  /** The project page (https://github.com/owner/repo). */
  repoUrl: string
  author: string
  /** One line ("Majora's Mask as a native PC game: widescreen, high frame rates, mods and modern controls."). */
  blurb: string
  /** Longer text from the developer / catalog (Markdown), may be ''. */
  description: string
  features: string[]
  tags: RecompTag[]
  /** Newest known release tag (from the catalogs; the live check may find a newer one). */
  latestTag: string | null
  /** When that release came out (ISO date), if known. */
  released: string | null
  /** When it first appeared on either catalog (ISO time), if known. */
  addedAt?: string | null
  /** When its project last put out a release, as far as the catalogs know (ISO time). */
  updatedAt?: string | null
  /** Download size in bytes, if known. */
  downloadBytes: number | null
  /** GitHub stars (RecompLauncher's count; decomp-buddy has none). */
  stars: number | null
  downloads: number | null
  license: string | null
  /** Playable / partial / work in progress, from decomp-buddy's facts. */
  completeness: 'playable' | 'mostly' | 'partial' | 'wip' | null
  /** RecompLauncher marks one version of a game as recommended. */
  recommended: boolean
  /** Windows release asset: exact name, or a pattern with * wildcards. */
  assetPattern: string | null
  /** Program to start, relative to the install (may be a bare file name to search for). */
  exe: string | null
  /** The download is an installer to run (setup.exe / .msi), not a portable archive. */
  installer: boolean
  /** Checksum of the catalog's virus-scanned download (decomp-buddy), for `latestTag`'s asset. */
  scannedSha256: string | null
  /**
   * The exact file name `scannedSha256` is the checksum of (assetPattern may be a wildcard pattern). Absent in older
   * catalogs: then only an exact (non-wildcard) assetPattern names it.
   */
  scannedAsset?: string | null
  needs: GameFileNeed[]
  /** Plain-language notes on setup ("Pick your USA ROM once; the first start builds the game from it."). */
  setupNotes: string[]
  /** Documented save folders (Windows), as templates: %APPDATA%, %LOCALAPPDATA%, {install}, ... */
  savePaths: string[]
  /** Icon / cover / hero art (RecompLauncher), when known. */
  iconUrl: string | null
  coverUrl: string | null
  heroUrl: string | null
  archived: boolean
  /**
   * Which catalogs list it: decomp-buddy and RecompLauncher; 'playout' = added by someone in PlayOut's browser and
   * approved (the metadata cloud's all.json); 'user' = added on this PC (RecompBrowser's Add, not approved yet).
   */
  sources: ('decomp-buddy' | 'recomplauncher' | 'playout' | 'user')[]
  /**
   * The public catalog's facts (the `sources` entry 'recomplauncher') about the game's Xbox 360 user data (a
   * single-game app only): `titleId` the
   * game's title id (8 hex digits, upper case), `achievementsFolder` the folder template its unlock file is under
   * ({game} = the install folder). `id` is the app's id in that catalog. Absent when the catalog gives neither.
   */
  rl?: { id: string; titleId?: string; achievementsFolder?: string }
}

/**
 * Whether PlayOut can read the achievements of a recompilation (recomp/achievements): an Xbox 360 one built on
 * ReXGlue, which keeps its own unlock file, known by the title id or user data folder the catalog gives.
 */
export function recompAchievementsSupported(
  entry: Pick<RecompEntry, 'systemId' | 'rl'> | null | undefined
): boolean {
  return (
    !!entry && entry.systemId === 'xbox360' && !!(entry.rl?.titleId || entry.rl?.achievementsFolder)
  )
}

/**
 * Whether a recompilation is listed only because someone added it (this PC's Add, or PlayOut's list): no catalog
 * virus-scanned its download, so its install is never called verified beyond GitHub's own checksum.
 */
export function isUnscannedRecomp(sources: readonly RecompEntry['sources'][number][]): boolean {
  return sources.length > 0 && sources.every((s) => s === 'user' || s === 'playout')
}

/** Several recompilations of the same game, shown as one entry. */
export interface RecompTitle {
  /** "<systemId>:<normalized game name>". */
  key: string
  game: string
  systemId: string
  console: string
  /** Its members' other names for the game (RecompEntry.otherNames) that differ from `game`. */
  aliases?: string[]
  /** Member entry ids, recommended first. */
  entries: string[]
}

/** An installed recompilation. */
export interface InstalledRecomp {
  id: string
  /** Install folder. */
  dir: string
  tag: string
  /** When the installed release was published (tells a rolling tag published again from the installed build). */
  publishedAt?: string | null
  asset: string
  /** Bytes of the downloaded file. */
  downloadBytes: number
  /** Bytes on disk (install folder), measured after install/update and on demand. */
  diskBytes: number | null
  /** sha256 of the download, and whether it matched a published checksum. */
  sha256: string
  verified: 'scanned' | 'github' | 'unverified'
  /**
   * The program started: relative to `dir`, or (only when the user chose it, `exeChosen`) a full path outside it (a
   * setup-program port whose game lands elsewhere).
   */
  exe: string | null
  /**
   * 'user': the user chose `exe` on the Recompilation page. 'confirmed': PlayOut's own pick, and the player accepted
   * it (pressed Automatic, or it has started the game), so UP never asks which program to start. Absent: PlayOut's
   * own pick, not confirmed yet.
   */
  exeChosen?: 'user' | 'confirmed'
  /** With `exeChosen`: PlayOut's own pick (relative to `dir`), which "Automatic" goes back to. */
  autoExe?: string | null
  /**
   * The program that starts the game as it was identified, for the "Delete the original disc image?" question
   * (main/recomp/image-offer.ts): `exe` its full path (normalized), `by` 'player' when the player picked or confirmed
   * it (asked at once), 'auto' when PlayOut identified it on its own (asked after AUTO_STARTS_BEFORE_ASK successful
   * starts of that same program; `starts` counts them and starts again at 1 when the program changes). Absent: not
   * identified yet (records from older PlayOut versions).
   */
  exeIdentified?: { exe: string; by: 'player' | 'auto'; starts: number }
  /**
   * Successful starts still to come before the "Delete the original disc image?" question may be asked: set when the
   * game's original arrives in the library after the recompilation was installed without it (a download from a paired
   * PC), so the question waits for two starts with the original's files. Absent or 0: the usual rule.
   */
  imageAskAfter?: number
  installedAt: string
  updatedAt: string
  /** Files the release shipped (relative, lowercase '/' keys), to tell them from the user's files on update. */
  releaseFiles: string[]
  autoUpdate: boolean
  /** Game-file choices, by need id. */
  gameFiles: Record<string, { path: string; source: 'picked' | 'library' }>
  /** Save folders in use (templates); empty = detect. */
  savePaths: string[]
  /** Where `savePaths` came from. */
  saveSource: 'user' | 'catalog' | 'developer' | 'detected' | 'install' | null
  /**
   * Save folders "Find automatically" found but did not use (several candidates, or folders besides the ones in use),
   * as templates, for the user to add. Absent in records from older PlayOut versions.
   */
  saveSuggestions?: string[]
  /**
   * The name of this recompilation's copy folder in <Emulation>/Recompilations Saves, chosen once and kept (so a
   * renamed project, or a catalog not loaded, never moves the copy). Absent until the first copy.
   */
  saveCopyFolder?: string
  /** The copy an older PlayOut kept in the chosen cloud folder was looked for (adopted or not): never again. */
  oldCopyAdopted?: boolean
  /** Copying the saves to and from the Emulation folder (the field name is kept from the cloud-folder era). */
  cloud: RecompCloudState
  /** The previous tag, for going back. */
  prevTag: string | null
  /**
   * The release the user chose to keep (one older than the newest, picked under Change version). While set,
   * automatic updates, Update all and the update notice skip it; choosing the newest release, Back to latest or
   * uninstalling clears it. Null (absent in records from older PlayOut versions) = follows the newest release.
   */
  pinnedTag?: string | null
  /**
   * Installed by another launcher (Quiver Launcher, RecompLauncher, Decomp Buddy) and moved here by Settings ›
   * Recompilations › Import. Absent: installed by PlayOut. Cleared by PlayOut's first update of it.
   */
  imported?: RecompImportedFrom
}

/**
 * The save copy of one recompilation in <Emulation folder>/Recompilations Saves/<name>/ (it reaches other PCs through
 * PlayOut's Emulation folder sync, or a cloud app when the Emulation folder is in a synced place). "cloud" in the names
 * means that copy's side; the names are kept from when the copy lived in a cloud folder.
 */
export interface RecompCloudState {
  /** Copy the saves before and after play (on by default; the user can turn it off per recompilation). */
  enabled: boolean
  /** Hash of the saves when last synced (both sides equal then). */
  syncedHash: string | null
  /** Hash of the local saves when last read. */
  localHash: string | null
  syncedAt: string | null
  /** A sync waiting to be retried (a copy failed, the Emulation folder could not be reached). */
  pending: boolean
  /** Last problem, shown in the tab. */
  error: string | null
  /**
   * Set when both sides changed: the user picks; nothing is overwritten meanwhile. `gone`: this PC synced the saves
   * before and they are gone from it: Restore from the Emulation folder ('cloud') or Start fresh ('local').
   */
  conflict: { localAt: string; cloudAt: string; cloudDevice: string; gone?: boolean } | null
  /**
   * The user chose Start fresh for saves gone from this PC: no saves here is not copied back over, and this PC's next
   * saves replace the copy (cleared once both sides are the same again).
   */
  freshStart?: boolean
}

/** A release of a recompilation, for the Updates list. */
export interface RecompRelease {
  tag: string
  name: string
  publishedAt: string | null
  prerelease: boolean
  /** Markdown notes. */
  notes: string
  url: string
  /** The Windows file PlayOut would download, if any. */
  asset: { name: string; size: number; sha256: string | null } | null
  /**
   * Set by getRecompReleases (main decides, as its update check and pins do): the project's newest release with a
   * Windows download (by version, test builds left out), and whether choosing this one under Change version pins it.
   */
  newest?: boolean
  pins?: boolean
}

/** What PlayOut knows about one game's recompilations (the Recompilation page). */
export interface GameRecomps {
  gameId: string
  title: RecompTitle
  entries: RecompEntry[]
  installed: Record<string, InstalledRecomp>
  /** The user's chosen version (else the recommended / first one). */
  preferred: string
  /** Update available per installed entry id (the newer tag). */
  updates: Record<string, string>
  /** Game-file state for the preferred (or asked) entry. */
  gameFiles: Record<string, GameFileState[]>
  /** Game files PlayOut found in the library for this game (ROM path), offered for the needs. */
  libraryFiles: string[]
  /**
   * This game's own disc image, when an installed recompilation of it no longer needs it (the Recompilation page's
   * "Delete the original disc image…"): `recompId` the recompilation, `fileName` the image, `kept` the player
   * answered Keep it before. Absent / null: nothing to offer (no disc image, a recompilation still reads it at every
   * start, or it is already in the Recycle Bin). `fileName` null: the image is gone (or must stay) but the game
   * folder PlayOut unpacked for the recompilation's setup program (`folder`) may go.
   */
  originalImage?: RecompOriginalImage | null
}

/**
 * What an installed recompilation lets the player delete of its game (the Recompilation page's and Settings ›
 * Recompilations' "Delete…"): `fileName` the game's disc image it no longer reads (null: it must stay or is gone),
 * `kept` the player answered Keep it before, `folder` the game folder PlayOut unpacked for its setup program that it no
 * longer uses.
 */
export interface RecompOriginalImage {
  recompId: string
  fileName: string | null
  kept: boolean
  folder?: RecompUnpackedFolder | null
}

/**
 * A game folder PlayOut unpacked from the player's disc image for a setup program that takes the game unpacked
 * (main/recomp/game-folder.ts), which the recompilation no longer uses: it may go to the Recycle Bin.
 */
export interface RecompUnpackedFolder {
  /** Its full path ("C:\Users\me\Games\Burnout Revenge\game"). */
  path: string
  /** Its size; null when it could not be read. */
  totalBytes: number | null
  /** The player answered Keep it (or deleted only the disc image) before. */
  kept: boolean
}

/** What a delete question's answer moves to the Recycle Bin: the disc image, the unpacked game folder, or both. */
export type RecompDeleteChoice = 'delete' | 'delete-folder' | 'delete-both'

/**
 * A "Delete the original disc image?" question (main/recomp/image-offer.ts): the recompilation `recompId` of the
 * library game `gameId` is ready and no longer reads its disc image, so the player may move the image to the Recycle
 * Bin (the card stays and starts the recompilation). It may also (or only) offer the game folder PlayOut unpacked for
 * the recompilation's setup program (`folder`), chosen from the Delete dropdown.
 */
export interface RecompImageOffer {
  /**
   * "<recompId>|<image path, normalized>": one question per recompilation and image; a question about the unpacked
   * folder only: "<recompId>|folder|<folder path, normalized>".
   */
  key: string
  recompId: string
  /** The recompilation's name ("Xerenge"). */
  recompName: string
  gameId: string
  /** The game's title as shown. */
  gameTitle: string
  /** The image's own file name ("Burnout Revenge (USA).iso"); null in a question about the unpacked folder only. */
  fileName: string | null
  /** Every file that would go (a .cue's tracks, an .m3u's discs), by name, the image first ([] without an image). */
  files: string[]
  /** Their size together; null when it could not be read. */
  totalBytes: number | null
  /** The unpacked game folder that may go too (or instead); null when there is none to offer. */
  folder: RecompUnpackedFolder | null
  /** When it was asked first (ISO). */
  at: string
}

/**
 * A disc image (and/or unpacked game folder) a Delete answer moved aside — into a hidden ".playout-held" folder beside
 * it — while PlayOut starts the recompilation to check it runs without it (main/recomp/service.ts, held-files.ts):
 * - 'testing': the recompilation is starting or being watched now;
 * - 'crashed': it did not start, or closed right after it started: it may need the image (Restore is suggested);
 * - 'not-tested': it was not started for a reason unrelated to the image (already running, a save conflict, which
 *   program to start…): the files stay aside until the player picks Restore, Test again or Delete anyway;
 * - 'passed': it ran, but the files could not go to the Recycle Bin (`reason` says why);
 * - 'interrupted': PlayOut closed (or stopped) during the test: asked again at every start until answered.
 * Nothing waits forever unanswered and nothing is moved to the Recycle Bin without a passed test or Delete anyway.
 */
export interface RecompHeldImage {
  holdId: string
  recompId: string
  /** The recompilation's name ("Xerenge"). */
  recompName: string
  gameId: string
  gameTitle: string
  /** The image's own file name; null when only the unpacked game folder was moved aside. */
  fileName: string | null
  /** Every item moved aside, by name, the image first. */
  files: string[]
  /** The unpacked game folder moved aside too (its full path), if any. */
  folder: string | null
  state: 'testing' | 'crashed' | 'not-tested' | 'passed' | 'interrupted'
  /** What happened, in words ("it closed 3 s after it started (exit code 3221225477)"); null while testing. */
  reason: string | null
  /** When it was moved aside (ISO). */
  at: string
  /** When the test's verdict came (ISO): a new verdict asks again even after Not now. */
  decidedAt: string | null
}

/** The answer to a held image's question: put it back, move it to the Recycle Bin, or start the test again. */
export type RecompHeldAnswer = 'restore' | 'delete' | 'retry'

/** Recompilation starts of a program PlayOut identified on its own before it asks about the disc image. */
export const AUTO_STARTS_BEFORE_ASK = 2

/** One row of Settings › Recompilations. */
export interface RecompRow {
  entry: RecompEntry
  installed: InstalledRecomp
  /** Library games it is matched to (for the name/art). */
  gameIds: string[]
  update: string | null
  /**
   * What the last release check knew of the version in use (null = not checked yet): whether it is a pre-release,
   * and the newest release with a Windows download (null = none found).
   */
  release: { prerelease: boolean; latest: string | null } | null
  /** Other recompilations of the same game (for swapping). */
  alternatives: { id: string; name: string; installed: boolean }[]
  /** Save folders resolved to real paths. */
  resolvedSavePaths: string[]
  /** Where the copies of its saves live: <Emulation folder>/Recompilations Saves/<name>. */
  savesDir: string
  /** Folders "Find automatically" suggests adding (real paths). */
  saveSuggestions: string[]
  /**
   * What of its game may go to the Recycle Bin (the same "Delete…" as on the Recompilation page of the matched game
   * `gameId`): absent / null when nothing may.
   */
  originalImage?: (RecompOriginalImage & { gameId: string }) | null
}

/** One recompilation's saves (the Saves section of the Recompilation page). */
export interface RecompSaves {
  /** The save folders in use, as templates ({local}/Zelda64Recompiled/saves). */
  templates: string[]
  /** The same folders on this PC (index-aligned with `templates`). */
  resolved: string[]
  source: InstalledRecomp['saveSource']
  /** Folders "Find automatically" suggests adding (real paths). */
  suggestions: string[]
  /** Where the copies of its saves live: <Emulation folder>/Recompilations Saves/<name>. */
  savesDir: string
  cloud: RecompCloudState
}

export interface RecompCatalogStatus {
  /** When the catalogs were last fetched (ISO), per source. */
  fetchedAt: { 'decomp-buddy': string | null; recomplauncher: string | null }
  /** Entries usable on Windows. */
  entries: number
  titles: number
  /** Library games with at least one recompilation. */
  matchedGames: number
  /** Recompilations a catalog check turned up in the last two weeks (the browser marks them new). */
  newEntries?: number
  /** A source could not be reached (cached copy in use). */
  offline: string[]
  refreshing: boolean
}

export interface RecompSettingsView {
  catalog: RecompCatalogStatus
  /** Where recompilations are installed. */
  root: string
  /** <Emulation folder>/Recompilations Saves: where the copies of every recompilation's saves live. */
  savesDir: string
  rows: RecompRow[]
  /** Installs/updates running or queued. */
  busy: RecompProgress[]
}

export interface RecompProgress {
  id: string
  phase:
    | 'queued'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'installing'
    | 'done'
    | 'failed'
  /** 0..1 while downloading. */
  progress: number | null
  bytes: number | null
  total: number | null
  message: string | null
  /** A download that could not be verified installs with this warning. */
  warning: string | null
}

/** One program (.exe) found in an install folder (the Recompilation page's Program picker). */
export interface RecompExecutable {
  /** As it would be stored: relative to the install folder (or the full path, for one outside it). */
  path: string
  /** Full path. */
  full: string
  /**
   * Why it is probably not the game ("Uninstaller", "Crash reporter", "Setup program", ...); null = could be the
   * game. Such programs are listed last, never left out.
   */
  note: string | null
  /** The program Play starts now. */
  current: boolean
  /** PlayOut's own pick (what "Automatic" goes back to). */
  auto: boolean
}

/** The program a recompilation starts, and the ones it could start instead (the Recompilation page). */
export interface RecompExecutables {
  id: string
  /** The install folder. */
  dir: string
  /** The program started (as stored: relative to `dir`, or a full path outside it); null = none was found. */
  current: string | null
  /** Its full path. */
  currentFull: string | null
  /**
   * Who chose it: 'user' (on the Recompilation page), 'developer' (the release's recomplauncher.json names it) or
   * 'auto' (PlayOut picked it from the files).
   */
  source: 'user' | 'developer' | 'auto'
  /** PlayOut's own pick ("Automatic"), relative to `dir`. */
  auto: string | null
  /** The current program is outside the install folder. */
  outside: boolean
  /** The chosen program is no longer there. */
  missing: boolean
  /** Programs in the install folder, the most likely game first (programs that are not the game last). */
  candidates: RecompExecutable[]
  /** More programs were found than are listed. */
  truncated: boolean
}

/** The result of pressing UP when the recomp is installed. */
export type RecompLaunchResult =
  /**
   * Started. `warning`: started, but something before it failed (a setup program's game could not be unpacked for
   * it), in words for the player.
   */
  | { ok: true; warning?: string }
  /** Game files are needed first: the page opens on them. */
  | { ok: false; reason: 'needs-files'; needs: GameFileState[] }
  /** The saves on this PC and their copy in the Emulation folder both changed: the user picks which to keep. */
  | { ok: false; reason: 'save-conflict'; conflict: NonNullable<RecompCloudState['conflict']> }
  /**
   * Which program starts the game is unclear (nobody chose it, the developer does not name it and several programs
   * in the folder could be the game): nothing was started; the player picks one of `executables` (saved as theirs
   * with setRecompExecutable) and UP starts again.
   */
  | { ok: false; reason: 'choose-exe'; recompId: string; executables: RecompExecutables }
  | { ok: false; reason: 'not-installed' | 'running' | 'failed'; message: string }

/** Folder (in the Emulation folder) PlayOut keeps the copies of recompilation saves in. */
export const RECOMP_SAVES_FOLDER = 'Recompilations Saves'

/**
 * Folder (in the cloud folder users chose before the copies moved to the Emulation folder) recompilation saves were
 * copied into; each recompilation's copy there is adopted once.
 */
export const OLD_RECOMP_CLOUD_FOLDER = 'PlayOut Recomp Saves'

/** How the recompilation browser sorts. */
export type RecompBrowseSort = 'added' | 'updated' | 'stars'

/** One recompilation in the browser (Settings › Recompilations › Browse). */
export interface RecompBrowseEntry {
  id: string
  /** The project's name ("Ship of Harkinian"). */
  name: string
  /** Its repository, "owner/repo" as the project spells it ("HarbourMasters/Shipwright"). */
  repo: string
  /** The game it recompiles, as this project's catalog entry names it (a grouped title may use another name). */
  game: string
  author: string
  blurb: string
  tags: RecompTag[]
  stars: number | null
  addedAt: string | null
  updatedAt: string | null
  latestTag: string | null
  downloadBytes: number | null
  recommended: boolean
  archived: boolean
  repoUrl: string
  installed: boolean
  /** Showed up in a catalog check since PlayOut first read the catalogs on this PC, within the last two weeks. */
  isNew: boolean
  /** Favourited in the browser (RecompManifest.favorites). */
  favorite: boolean
  /** Its own library card (Add to library), or null when it has none. */
  libraryGameId: string | null
  /**
   * Added in the browser on this PC (RecompBrowser's Add), not in a catalog or PlayOut's list yet: how far it got
   * (AddedRecompState). Absent for every other recompilation.
   */
  added?: AddedRecompState
  /** Added here and waiting for the owner's approval (queued or suggested). */
  awaiting?: boolean
  /**
   * Added here and not sent for approval: 'off' while sending is off (Suggest my edits; it is sent once that is on),
   * 'refused' when the metadata cloud refused it (`refusedReason` says why). Absent otherwise.
   */
  notSent?: 'off' | 'refused'
  refusedReason?: string
  /**
   * Listed only because someone added it (this PC, or PlayOut's list after the owner approved it): no catalog
   * virus-scanned its download, only GitHub's checksum is checked. The browser warns before installing it.
   */
  unscanned?: boolean
}

/**
 * How far a recompilation added in the browser got: 'local' only on this PC (sending is off, or it was refused),
 * 'queued' waiting to be sent, 'suggested' a pull request waits for the owner, 'published' the owner put it in
 * PlayOut's list (it reaches every PlayOut once all.json carries it).
 */
export type AddedRecompState = 'local' | 'queued' | 'suggested' | 'published'

/** A recompilation the user added in the browser (userData/recomp-added.json). */
export interface AddedRecomp {
  /** "github:<owner>/<repo>" lower case, the repository's name as GitHub spells it now. */
  id: string
  /** "<owner>/<repo>" as GitHub spells it. */
  repo: string
  game: string
  /** PlayOut system id of the original console, or 'other'. */
  systemId: string
  /** The repository's description (one line, plain text). */
  blurb?: string
  stars?: number | null
  license?: string | null
  archived?: boolean
  fork?: boolean
  addedAt: string
  state: AddedRecompState
  /** The suggestion's pull request. */
  prUrl?: string
  /** Why the metadata cloud refused it (state 'local'); absent when it was not refused. */
  refused?: string
}

/**
 * How sending an add went (the metadata cloud's submitRecomp): its state, the pull request, why it was refused; or
 * state null when there is nothing to note (a flush sent it meanwhile and told its listeners, or it was withdrawn).
 */
export interface RecompSendResult {
  state: AddedRecompState | null
  prUrl?: string
  refused?: string
}

/** A recompilation in PlayOut's own list (the metadata cloud's all.json `recomps`): added by someone and approved. */
export interface CloudRecomp {
  id: string
  repo: string
  repoUrl: string
  game: string
  systemId: string
  blurb: string
  addedAt: string | null
}

/** What adding a recompilation sends (RecompBrowser's Add): the repository and what the user says of it. */
export interface RecompAddInput {
  /** The repository's id from checkRecompRepo ("github:<owner>/<repo>"). */
  id: string
  game: string
  systemId: string
}

/** Why a repository cannot be added (checkRecompRepo): mainRecomp.add.<reason>. */
export type RecompRepoRefusal =
  | 'notGithub'
  | 'badUrl'
  | 'notFound'
  | 'noReleases'
  | 'noWindows'
  | 'alreadyListed'
  | 'rateLimited'
  | 'failed'

/** The result of checking a repository before it is added. */
export type RecompRepoCheck =
  | {
      ok: true
      id: string
      /** "owner/repo" as GitHub spells it. */
      repo: string
      repoUrl: string
      description: string
      stars: number | null
      license: string | null
      archived: boolean
      fork: boolean
      /** The newest release with a Windows download, and that download. */
      tag: string
      asset: { name: string; size: number }
      /** The game, guessed from the repository's name and description (the user may change it). */
      game: string
      /** Consoles to choose from (PlayOut system ids, with their names), 'other' last. */
      consoles: { id: string; name: string }[]
    }
  | {
      ok: false
      reason: RecompRepoRefusal
      /** In words, for the dialog. */
      message: string
      /** alreadyListed: the recompilation in the browser (Show it). */
      existingId?: string
    }

/** One game in the browser, with every recompilation of it. */
export interface RecompBrowseTitle {
  key: string
  game: string
  systemId: string
  console: string
  coverUrl: string | null
  /** Recommended first, then by stars. */
  entries: RecompBrowseEntry[]
  /** Library games of this title (opening one shows its Recompilation page). */
  gameIds: string[]
}

export interface RecompBrowseView {
  catalog: RecompCatalogStatus
  titles: RecompBrowseTitle[]
  /** Recompilations marked new. */
  newCount: number
}

// --- Import (Settings › Recompilations › Import: main/recomp/import.ts, import-run.ts) -------------------------------

/** The other launchers whose installed recompilations PlayOut can take over. */
export type RecompImportLauncher = 'quiver' | 'recomplauncher' | 'decompbuddy'

/** What PlayOut knows of an imported install (InstalledRecomp.imported). */
export interface RecompImportedFrom {
  from: RecompImportLauncher
  /** When it was imported (ISO). */
  at: string
  /** The folder it was moved from. */
  fromDir: string
  /**
   * The version the other launcher installed is a release PlayOut found. False: unknown, so the update check offers
   * the project's newest release (an update then installs it over the folder, the player's files kept).
   */
  versionKnown: boolean
}

/** A recompilation an import row may become. */
export interface RecompImportChoice {
  id: string
  name: string
  game: string
  console: string
  /** Installed in PlayOut already: the row cannot be imported as this one. */
  installed: boolean
  /** The folder it would be moved to (<Recompilations>\<name> (<id>)); `targetTaken` when something is there. */
  target: string
  targetTaken: boolean
}

/** One app folder found in the folders the user picked. */
export interface RecompImportItem {
  /** The folder (full path): the row's key. */
  folder: string
  /** Its name (the folder's own name, or the other launcher's name for it). */
  name: string
  launcher: RecompImportLauncher
  /** Bytes on disk (null when it could not be measured). */
  bytes: number | null
  /**
   * How `recompId` was found: 'repo' (the other launcher's record names the project), 'launcher-id' (RecompLauncher's
   * own id for it), 'title' (only by name: the user confirms it), 'none' (pick one or skip).
   */
  match: 'repo' | 'launcher-id' | 'title' | 'none'
  /** PlayOut's pick (null: none; with several choices the user picks). */
  recompId: string | null
  /** The recompilations it may be (the pick first); empty when nothing matched. */
  choices: RecompImportChoice[]
  /** The version the other launcher recorded (null: unknown). */
  version: string | null
  /** Why it cannot be imported at all (a running program, a folder in the way …); null: it can. */
  blocked: string | null
  /** Things to know (only the setup program is there, the game image is kept elsewhere …). */
  notes: string[]
}

export interface RecompImportScan {
  /** The folders the user picked. */
  picked: string[]
  items: RecompImportItem[]
  /** Folders looked at that no supported launcher made (or that hold nothing installed). */
  ignored: number
  /**
   * Every recompilation of the catalog, for a row nothing matched (sorted by name), with whether it is installed
   * already and whether something is in the way at its folder (as RecompImportChoice).
   */
  catalog: {
    id: string
    name: string
    game: string
    console: string
    installed: boolean
    target: string
    targetTaken: boolean
  }[]
}

/** One folder to import as one recompilation. */
export interface RecompImportRequest {
  folder: string
  recompId: string
}

export interface RecompImportProgress {
  /** 1-based number of the folder being moved, of `total`. */
  index: number
  total: number
  folder: string
  name: string
  phase: 'checking' | 'moving' | 'copying' | 'verifying' | 'switching' | 'cleaning' | 'done'
  bytesDone: number
  bytesTotal: number | null
}

export interface RecompImportResult {
  imported: {
    folder: string
    recompId: string
    name: string
    dir: string
    /** Moved by one rename (same drive) rather than copied. */
    renamed: boolean
    /** Files left in the old folder (changed during the copy, or could not be removed). */
    leftInOld: number
    /**
     * Links inside the folder that still point at the old folder: they could not be made again (a file link needs
     * Developer Mode or administrator rights).
     */
    linksNotFixed: number
    versionKnown: boolean
  }[]
  failed: { folder: string; recompId: string; message: string }[]
  /** Cancel was pressed: these were not started (nothing of them moved). */
  notStarted: string[]
}
