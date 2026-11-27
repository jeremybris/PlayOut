// "Delete from this PC" (docs/ARCHITECTURE.md §4.8): removes an installed game from this PC only. A ROM's whole file set
// goes to the Recycle Bin (never deleted for good) and the record leaves the library; a store game is handed to its
// store client's own uninstall (which asks itself) and keeps its record until a rescan shows it not installed; a manual
// game runs its Add/Remove Programs uninstaller (its record leaves once the game is gone), or its folder goes to the
// Recycle Bin behind strict guards (never a folder that looks like more than one game). Every path
// is derived here from the library record: the renderer only ever sends a game id.
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import type {
  ClientInfo,
  Game,
  LocalDeletePlan,
  LocalDeleteOptions,
  LocalDeleteResult,
  SourceId,
  StoreSourceId
} from '../../shared/types'
import { upgradeRunningMessage } from '../../shared/upgrades'
import { sourceFiles } from '../convert/sources'
import { runElevated } from '../emulator-setup/run'
import {
  gogUninstallArgs,
  isAllowedUninstallUri,
  LIBRARY_PAGE,
  uninstallUriFor
} from '../installs/install-uri'
import { tokenizeArgs } from '../launcher/launcher'
import type { Logger } from '../logger'
import { romFileSet, romGamePath } from '../streaming/rom-transfer'
import { hasUpdatesDlc, updatesDlcOf, type UpdatesDlcGame } from '../emulation/updates-dlc'
import { readUninstallEntries, type UninstallEntry } from '../system/uninstall'
import { displayTitle } from '../util/game-title'
import { isInside, knownFolders, normalizePath } from '../util/paths'
import { folderSize } from './install-size'
import {
  defaultHeldIo,
  heldPathFor,
  HELD_DIR,
  moveAside,
  putBack,
  trashHeld,
  type HeldEntry
} from './held-files'
import { tMain } from '../i18n'

/** A manual game's folder larger than this is never moved to the Recycle Bin (it would not fit, or is not a game). */
export const MAX_FOLDER_BYTES = 200 * 1024 ** 3
/**
 * Confirming rescans of a store after its uninstall started (the store asks first, then takes a while); a manual
 * game's uninstaller is checked at the same times, and its record leaves only once the game is gone.
 */
export const STORE_RESCAN_DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000]
/** A manual game's folder with more direct subfolders than this is not walked for the checks below: it stays. */
export const MAX_CHECKED_SUBFOLDERS = 300

/** Folder names of a store's game library or a store client's own folder: such a folder holds many games. */
const STORE_LIBRARY_DIR =
  /^(steamapps|steamlibrary|steam|epic games|epicgames|ea games|ea app|ea desktop|origin games|origin|gog games|gog galaxy|ubisoft|ubisoft game launcher|battle\.net|xboxgames|windowsapps|modifiablewindowsapps)$/i
/**
 * STORE_LIBRARY_DIR without the folders retail and DRM-free installers also use (GOG's offline installers' `GOG Games`,
 * old retail `EA Games`, Ubisoft's publisher folder `Ubisoft`): a game's own uninstaller in one of those is its own.
 */
const STORE_CLIENT_LIBRARY_DIR =
  /^(steamapps|steamlibrary|steam|epic games|epicgames|ea app|ea desktop|origin games|origin|gog galaxy|ubisoft game launcher|battle\.net|xboxgames|windowsapps|modifiablewindowsapps)$/i
/** Store clients' own programs: a folder holding one is a store's folder, not a game's. */
const LAUNCHER_EXE =
  /^(steam|epicgameslauncher|galaxyclient|eadesktop|origin|upc|ubisoftconnect|battle\.net|battle\.net launcher)\.exe$/i
/** A game folder inside one of these is a store's game: the store uninstalls it, not a folder delete. */
const STORE_GAME_PARENT = /^(steamapps|xboxgames|windowsapps|modifiablewindowsapps)$/i
/** Programs a game ships next to its own (uninstallers, set-ups, crash reporters, launchers, redistributables). */
const HELPER_EXE =
  /^(unins\d*|uninstall.*|setup.*|.*setup|.*install.*|.*crash.*|.*redist.*|.*prereq.*|dx.*setup|.*launcher.*|.*updater?|.*update|.*config.*|.*settings.*|easyanticheat.*|be(service|launcher).*|.*helper.*|.*report.*|.*server.*|.*editor.*|.*tool.*|.*benchmark.*)\.exe$/i
/** Subfolders a game ships its helpers in. */
const HELPER_DIR =
  /^(_?commonredist|redist|redistributables?|directx|dotnet|vcredist|support|tools?|easyanticheat|battleye|installers?|_installer|prereq.*|__installer)$/i

/** Lowercase letters and digits of a program's name, without .exe: what two programs of one product share. */
const productStem = (exe: string): string =>
  exe
    .replace(/\.exe$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** Two programs belong to one product when their names start alike or one contains the other. */
export function sameProduct(a: string, b: string): boolean {
  const x = productStem(a)
  const y = productStem(b)
  if (!x || !y) return true
  return x.slice(0, 4) === y.slice(0, 4) || x.includes(y) || y.includes(x)
}

/** The side effects, injectable for tests. */
export interface LocalDeleteIo {
  /** electron's shell.trashItem: rejects when the item cannot go to the Recycle Bin (never deletes for good). */
  trash(path: string): Promise<void>
  openExternal(uri: string): Promise<void>
  spawn(file: string, args: string[], options: SpawnOptions): ChildProcess
  /** Start a program through the UAC prompt (an uninstaller that needs administrator rights); not awaited. */
  runElevated(file: string, args: string[]): Promise<number | null>
  /**
   * Add/Remove Programs entries; with `complete` it rejects when any hive could not be read. Only used to find an
   * uninstaller, never to decide that a game is gone (an entry missing from the list proves nothing).
   */
  uninstallEntries(options?: { complete?: boolean }): Promise<UninstallEntry[]>
  /** Total bytes under a folder; null when it is unreadable or too large to walk. */
  folderSize(dir: string): Promise<number | null>
  stat(path: string): Promise<{ size: number; dir: boolean } | null>
  /** The entries directly in a folder; null when it is unreadable. */
  readdir(dir: string): Promise<{ name: string; dir: boolean }[] | null>
  setTimeout(fn: () => void, ms: number): void
  /** Renames, folder creation, empty-folder removal and presence, for the held files (held-files.ts). */
  rename(from: string, to: string): Promise<void>
  mkdir(dir: string): Promise<void>
  rmdir(dir: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface LocalDeleteDeps {
  library: {
    getGame(id: string): Game | undefined
    games(): Game[]
    removeGame(id: string): void
    /** Keep a ROM card whose disc image went to the Recycle Bin for its recompilation (LibraryService.markRomRemoved). */
    markRomRemoved?(id: string, recompId: string): unknown
    /** Its disc image is back where it was: an ordinary ROM card again (LibraryService.restoreRomRemoved). */
    restoreRomRemoved?(id: string): unknown
  }
  imageCache: { remove(gameId: string): Promise<void> }
  romsRoot(): string | null | undefined
  /**
   * Folders a deleted folder must never hold or sit in: PlayOut's own folder, its user data, the ROM folder and the
   * Emulation folder (saves, states and memory cards are synced with other PCs and never touched here).
   */
  appFolders(): string[]
  /** Folders no ROM path may be in or hold: the Emulation folder's saves, states, memory cards and BIOS. */
  keepFolders(): string[]
  /** The known folders a manual game's folder must never be or contain (defaults to the user's and Windows' own). */
  protectedFolders?: () => string[]
  running(): { gameId: string } | null
  /** Game ids in the install queue or watched by the install tracker (ROM downloads have `remote:<host>:<id>` ids). */
  busyIds(): string[]
  /** A ROM conversion is running (it may be working on this game's files). */
  convertRunning?(): Promise<boolean>
  /** An Upgrade menu action runs for the game now (it may be rewriting the game's files). */
  upgradeRunning?(gameId: string): boolean
  /** Files a paired client is downloading from this PC right now (absolute paths); none of them is moved. */
  filesBeingSent?(): string[]
  storeName(source: StoreSourceId): string
  client(source: StoreSourceId): Promise<ClientInfo>
  rescan(source: SourceId): Promise<unknown>
  /** Drop the hosting side's cached file set of this ROM (served sets are re-read from the library otherwise). */
  forgetRomSet?(gameId: string): void
  /** The Emulation folder in use (its Updates and DLC holds the games' updates and DLC); absent = none offered. */
  emulationDir?(): string
  /**
   * Before a game's files go: a background fetch of its missing updates and DLC from a host stops (and none starts
   * for it meanwhile), so none of them comes back once it is deleted (streaming-service.ts stopUpdatesFetch).
   */
  stopUpdatesFetch?(gameId: string): Promise<void>
  log: Logger
  io?: Partial<LocalDeleteIo>
}

export interface LocalDeleteService {
  plan(id: string): Promise<LocalDeletePlan>
  run(id: string, options?: LocalDeleteOptions): Promise<LocalDeleteResult>
  /**
   * A ROM game's disc image (its whole file set) for the recompilation's "Delete the original disc image?" question:
   * the files that would go to the Recycle Bin, or why they cannot now. `recompRunning`: the game running now is its
   * recompilation (which does not read the image), so a running game does not refuse.
   */
  imagePlan(
    id: string,
    options?: { recompRunning?: boolean }
  ): Promise<{ paths: string[]; totalBytes: number | null } | { refusal: string }>
  /**
   * Move that file set to the Recycle Bin (never deleted for good) and keep the card for recompilation `recompId`
   * (Game.romRemoved). Planned again here. `ok` false: nothing changed, or (some files went) says what to restore.
   */
  trashImage(
    id: string,
    recompId: string,
    options?: { recompRunning?: boolean }
  ): Promise<{ ok: boolean; message: string }>
  /**
   * A game folder PlayOut unpacked for a recompilation's setup program (the "Delete the unpacked game folder" choice;
   * main/recomp decides it is PlayOut's and unused): its size, or why it must not go to the Recycle Bin (the guards of
   * a manual game's folder, a folder right in a known folder such as %USERPROFILE%\Games, a link, a paired PC
   * downloading from it).
   */
  unpackedFolderPlan(dir: string): Promise<{ totalBytes: number | null } | { refusal: string }>
  /** Move that folder to the Recycle Bin (never deleted for good); planned again here. */
  trashUnpackedFolder(dir: string): Promise<{ ok: boolean; message: string }>
  /**
   * Instead of trashImage, for the recompilation's test run: planned again (imagePlan), then the whole file set is
   * moved aside into the hidden holding folder beside each file (held-files.ts: a rename in its own folder) and the
   * card is kept for `recompId` (Game.romRemoved). `beforeMove` records the entries first, so a crash part way never
   * loses a file. `ok` false: nothing is held, except `stuck` entries that could not be put back after a failure.
   */
  holdImage(
    id: string,
    recompId: string,
    holdId: string,
    options: { recompRunning?: boolean; beforeMove(entries: HeldEntry[]): Promise<unknown> }
  ): Promise<HoldResult>
  /** The same for an unpacked game folder (unpackedFolderPlan's guards). */
  holdUnpackedFolder(
    dir: string,
    holdId: string,
    options: { beforeMove(entries: HeldEntry[]): Promise<unknown> }
  ): Promise<HoldResult>
  /** Move held entries to the Recycle Bin (from where they wait); `left`: still held. */
  releaseHeld(entries: HeldEntry[], holdId: string): Promise<HeldOutcome>
  /**
   * Put held entries back at their exact paths (never over something there now). `card`: the game whose disc image
   * this is; once its own file (`image`) is back, it is an ordinary ROM card again.
   */
  restoreHeld(
    entries: HeldEntry[],
    holdId: string,
    card: { gameId: string; image: string } | null
  ): Promise<HeldOutcome>
  dispose(): void
}

/** What holding a disc image or folder did (held-files.ts). */
export type HoldResult =
  | { ok: true; message: string; entries: HeldEntry[] }
  | { ok: false; message: string; stuck: HeldEntry[] }

/** What releasing or restoring held entries did; `left`: entries still held. */
export interface HeldOutcome {
  ok: boolean
  message: string
  left: HeldEntry[]
}

const STORE_SOURCES: readonly string[] = [
  'steam',
  'epic',
  'gog',
  'ea',
  'battlenet',
  'ubisoft',
  'xbox'
]

const defaultIo: LocalDeleteIo = {
  async trash(path) {
    const { shell } = await import('electron')
    await shell.trashItem(path)
  },
  async openExternal(uri) {
    const { shell } = await import('electron')
    await shell.openExternal(uri)
  },
  spawn,
  runElevated: (file, args) => runElevated(file, args),
  uninstallEntries: (options) => readUninstallEntries(options),
  folderSize: (dir) => folderSize(dir),
  async stat(path) {
    try {
      const st = await fs.stat(path)
      return { size: st.size, dir: st.isDirectory() }
    } catch {
      return null
    }
  },
  async readdir(dir) {
    try {
      const list = await fs.readdir(dir, { withFileTypes: true })
      return list.map((d) => ({ name: d.name, dir: d.isDirectory() }))
    } catch {
      return null
    }
  },
  setTimeout(fn, ms) {
    setTimeout(fn, ms).unref?.()
  },
  ...defaultHeldIo
}

const key = (p: string): string => normalizePath(resolve(p))

/** The user's and Windows' own folders: never deleted, and never a folder that holds one of them. */
export function defaultProtectedFolders(): string[] {
  const k = knownFolders()
  const home = k.userProfile || homedir()
  const env = process.env
  return [
    home,
    dirname(home),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Downloads'),
    join(home, 'Music'),
    join(home, 'Pictures'),
    join(home, 'Videos'),
    join(home, 'Saved Games'),
    join(home, 'OneDrive'),
    join(home, 'AppData'),
    join(home, 'AppData', 'LocalLow'),
    k.appData,
    k.localAppData,
    join(k.localAppData, 'Programs'),
    k.programData,
    k.programFiles,
    k.programFilesX86,
    env['ProgramFiles'] ?? '',
    k.publicDir,
    env['SystemRoot'] ?? env['windir'] ?? join(k.systemDrive, 'Windows')
  ].filter(Boolean)
}

/**
 * Why a manual game's folder must not go to the Recycle Bin, or null when it may: a drive root, a known folder (or
 * one holding a known folder), anything inside Windows, a folder holding PlayOut, its data or the ROM folder, a folder
 * less than two levels below its drive's top (D:\Games may be a whole games library), a store's library folder (or a
 * game inside steamapps / XboxGames), or one the game's program is not in.
 */
export function folderDeleteRefusal(
  dir: string,
  exe: string | undefined,
  folders: { protectedFolders: string[]; appFolders: string[]; windowsDir?: string }
): string | null {
  const why = folderGuardRefusal(dir, folders)
  if (why) return why
  const full = resolve(dir)
  if (!exe || !isAbsolute(exe) || key(exe) === key(full) || !isInside(full, exe))
    return tMain('mainDelete.folder.programOutside')
  return null
}

/**
 * folderDeleteRefusal without its program check: the guards every folder PlayOut moves to the Recycle Bin passes
 * (no drive root or top-level folder, nothing in Windows, no known folder or one holding it, nothing holding or inside
 * PlayOut's own folders, no store library).
 */
export function folderGuardRefusal(
  dir: string,
  folders: { protectedFolders: string[]; appFolders: string[]; windowsDir?: string }
): string | null {
  if (!dir || !isAbsolute(dir)) return tMain('mainDelete.folder.none')
  const full = resolve(dir)
  const target = key(full)
  if (target === key(parse(full).root) || !relative(parse(full).root, full))
    return tMain('mainDelete.folder.driveTop')
  const windows = folders.windowsDir ?? process.env['SystemRoot'] ?? process.env['windir']
  if (windows && isInside(windows, full)) return tMain('mainDelete.folder.inWindows')
  for (const known of folders.protectedFolders) {
    if (!known) continue
    if (isInside(full, known)) return tMain('mainDelete.folder.systemFolder', { folder: full })
  }
  for (const app of folders.appFolders) {
    if (!app) continue
    if (isInside(full, app) || isInside(app, full))
      return tMain('mainDelete.folder.playoutFolder', { folder: full })
  }
  const segments = relative(parse(full).root, full)
    .split(/[\\/]+/)
    .filter(Boolean)
  if (segments.length < 2) return tMain('mainDelete.folder.belowDriveTop', { folder: full })
  if (STORE_LIBRARY_DIR.test(segments[segments.length - 1]))
    return tMain('mainDelete.folder.storeLibrary', { folder: full })
  const storeParent = segments.slice(0, -1).find((s) => STORE_GAME_PARENT.test(s))
  if (storeParent)
    return tMain('mainDelete.folder.inStoreLibrary', { folder: full, library: storeParent })
  return null
}

/**
 * Why an Add/Remove Programs entry belongs to a store rather than to a manual game, or null: its program is a store
 * client (Steam's `steam.exe steam://uninstall/<id>` entries, Ubisoft's upc.exe, ...), or its InstallLocation (or its
 * program's folder) is in a store's library or a store client's folder. Such an entry is never run for a manual game:
 * it would uninstall the store's game. `GOG Games`, `EA Games` and `Ubisoft` alone do not count: offline and retail
 * installers put standalone games there, whose own uninstaller is the right one.
 */
export function storeUninstallRefusal(
  entry: Pick<UninstallEntry, 'installLocation'>,
  program: string
): string | null {
  const name = basename(program)
  if (LAUNCHER_EXE.test(name)) return tMain('mainDelete.uninstaller.storeProgram', { name })
  const location = entry.installLocation.trim().replace(/^"|"$/g, '')
  for (const dir of [location, dirname(program)]) {
    if (!dir || !isAbsolute(dir)) continue
    const full = resolve(dir)
    const store = relative(parse(full).root, full)
      .split(/[\\/]+/)
      .find((s) => STORE_CLIENT_LIBRARY_DIR.test(s) || STORE_GAME_PARENT.test(s))
    if (store) return tMain('mainDelete.folder.inStoreFolder', { folder: full, store })
  }
  return null
}

/** Programs an uninstall string must never run (shells, script hosts): those could run anything. */
const BLOCKED_PROGRAMS =
  /^(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|bash|wsl|conhost|explorer)\.exe$/i

/**
 * An Add/Remove Programs UninstallString split into program and arguments, run without a shell: `"C:\x\unins000.exe"
 * /SILENT`, an unquoted `C:\Program Files\x\uninstall.exe --uid=x`, or `MsiExec.exe /I{GUID}` (run as `/X{GUID}`, the
 * uninstall). Null for anything else (a shell, a script, a relative program).
 */
export function parseUninstallCommand(
  command: string,
  systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
): { file: string; args: string[] } | null {
  const text = command.trim()
  if (!text) return null
  let file: string
  let rest: string
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1)
    if (end < 0) return null
    file = text.slice(1, end).trim()
    rest = text.slice(end + 1)
  } else {
    const match = /^(.*?\.exe)(?=\s|$)/i.exec(text)
    if (!match) return null
    file = match[1]
    rest = text.slice(match[1].length)
  }
  if (/^msiexec(\.exe)?$/i.test(file)) {
    const guid = /\/[IX]\s*(\{[0-9A-F-]{36}\})/i.exec(rest)
    return guid
      ? { file: join(systemRoot, 'System32', 'msiexec.exe'), args: [`/X${guid[1]}`] }
      : null
  }
  if (!isAbsolute(file) || !/\.exe$/i.test(file) || /[<>|&^%]/.test(file)) return null
  if (BLOCKED_PROGRAMS.test(basename(file))) return null
  return { file: resolve(file), args: tokenizeArgs(rest) }
}

/**
 * The Add/Remove Programs entry of an installed game: the one whose InstallLocation is the game's folder (or, for
 * Battle.net, whose uninstaller names the game's uid), with an uninstall string that can be run safely.
 */
export function matchUninstallEntry(
  entries: readonly UninstallEntry[],
  game: Pick<Game, 'installDir' | 'exePath' | 'extra'>
): UninstallEntry | null {
  const dirs = [game.installDir, game.exePath ? dirname(game.exePath) : undefined]
    .filter((d): d is string => !!d && isAbsolute(d))
    .map(key)
  const uid = typeof game.extra?.uid === 'string' ? game.extra.uid.toLowerCase() : null
  const usable = entries.filter((e) => parseUninstallCommand(e.uninstallString))
  const byDir = usable.find(
    (e) =>
      e.installLocation.trim() && dirs.includes(key(e.installLocation.trim().replace(/^"|"$/g, '')))
  )
  if (byDir) return byDir
  if (uid) {
    const byUid = usable.find((e) =>
      new RegExp(`--uid=${uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|"|$)`, 'i').test(
        e.uninstallString
      )
    )
    if (byUid) return byUid
  }
  return null
}

/** Sheets that list a disc image's other files (a scan shows only the sheet, not the files it lists). */
const IMAGE_SHEETS: ReadonlySet<string> = new Set(['.cue', '.gdi', '.m3u', '.ccd', '.mds'])

/**
 * The order a disc image's file set goes to the Recycle Bin in: the data files (tracks, discs) first, then the sheets
 * that list them, the card's own file (`main`) last. A move that fails part way then always leaves the sheets that
 * list what is left, so no leftover file shows up as a game of its own at the next scan.
 */
export function imageTrashOrder(paths: readonly string[], main: string): string[] {
  const rank = (p: string): number =>
    normalizePath(p) === normalizePath(main)
      ? 2
      : IMAGE_SHEETS.has(extname(p).toLowerCase())
        ? 1
        : 0
  return [...paths].sort((a, b) => rank(a) - rank(b))
}

export function createLocalDeleteService(deps: LocalDeleteDeps): LocalDeleteService {
  const io: LocalDeleteIo = { ...defaultIo, ...deps.io }
  const { log } = deps
  let disposed = false

  function refusal(game: Game | undefined, recompRunning = false): string | null {
    if (!game) return tMain('mainDelete.refused.notInLibrary')
    const title = displayTitle(game)
    if (game.remote || game.id.startsWith('remote:'))
      return tMain('mainDelete.refused.otherPc', { title })
    if (!game.installed) return tMain('mainDelete.refused.notInstalled', { title })
    if (!recompRunning && deps.running()?.gameId === game.id)
      return tMain('mainDelete.refused.running', { title })
    const busy = deps
      .busyIds()
      .some((id) => id === game.id || (id.startsWith('remote:') && id.endsWith(`:${game.id}`)))
    if (busy) return tMain('mainDelete.refused.queued', { title })
    if (deps.upgradeRunning?.(game.id)) return upgradeRunningMessage(tMain)
    return null
  }

  const refused = (gameId: string, reason: string): LocalDeletePlan => ({
    gameId,
    kind: 'refused',
    reason,
    paths: []
  })
  const removeOnly = (gameId: string, reason: string): LocalDeletePlan => ({
    gameId,
    kind: 'remove-only',
    reason,
    paths: []
  })

  async function sizeOf(path: string): Promise<number | null> {
    const st = await io.stat(path)
    if (!st) return null
    return st.dir ? io.folderSize(path) : st.size
  }

  /** Every file (or game folder) of a ROM on disk, absolute; folders stand for everything under them. */
  async function romPaths(game: Game, root: string): Promise<string[]> {
    const out = new Map<string, string>()
    const add = (p: string): void => {
      const full = resolve(p)
      if (!out.has(key(full))) out.set(key(full), full)
    }
    const main = romGamePath(game, root)
    const folder = typeof game.extra?.gameFolder === 'string' ? game.extra.gameFolder : null
    const mainStat = await io.stat(main)
    if (folder && isAbsolute(folder)) add(folder)
    else if (mainStat?.dir) add(main)
    else {
      const set = await romFileSet(game, root)
      for (const f of set.files) add(join(root, ...f.path.split('/')))
      for (const f of await sourceFiles(main).catch(() => [] as string[])) add(f)
    }
    return [...out.values()]
  }

  /** A path that may go to the Recycle Bin: in the ROM folder, never the folder or a system folder itself. */
  function romPathRefusal(path: string, root: string, isDir: boolean): string | null {
    if (!isInside(root, path) || key(path) === key(root))
      return tMain('mainDelete.rom.outsideFolder', { path })
    const depth = relative(resolve(root), resolve(path)).split(sep).filter(Boolean).length
    if (isDir && depth < 2) return tMain('mainDelete.rom.systemFolder', { path })
    for (const kept of deps.keepFolders())
      if (kept && (isInside(kept, path) || isInside(path, kept)))
        return tMain('mainDelete.rom.savesOrBios', { path })
    return null
  }

  async function romPlan(game: Game): Promise<LocalDeletePlan> {
    const root = deps.romsRoot()
    if (!root) return removeOnly(game.id, tMain('mainDelete.rom.noFolder'))
    if (await deps.convertRunning?.()) return refused(game.id, tMain('mainDelete.rom.converting'))
    let paths: string[]
    try {
      paths = await romPaths(game, root)
    } catch (err) {
      return removeOnly(game.id, (err as Error).message)
    }
    for (const p of paths) {
      const isDir = !!(await io.stat(p))?.dir
      const why = romPathRefusal(p, root, isDir)
      if (why) return removeOnly(game.id, why)
      // A recompilation's test run keeps a disc image aside in it (held-files.ts): it waits for the player's answer.
      if (isDir && (await io.exists(join(p, HELD_DIR))))
        return refused(game.id, tMain('mainDelete.rom.heldImage', { path: p }))
    }
    // Files another game of the library also uses (a disc an .m3u lists, a shared track) are kept.
    const others = deps.library
      .games()
      .filter((g) => g.source === 'rom' && g.id !== game.id && g.platformId === game.platformId)
    const shared = new Set<string>()
    const ownKeys = paths.map(key)
    for (const other of others) {
      let otherPaths: string[]
      try {
        otherPaths = await romPaths(other, root)
      } catch {
        continue
      }
      for (const p of otherPaths) {
        const k = key(p)
        if (ownKeys.includes(k)) shared.add(k)
        // Another game inside a folder this one would bin: the folder stays.
        else
          for (const mine of paths)
            if (isInside(mine, p) && (await io.stat(mine))?.dir)
              return removeOnly(
                game.id,
                tMain('mainDelete.rom.sharedWith', { path: mine, title: displayTitle(other) })
              )
      }
    }
    const kept = paths.filter((p) => shared.has(key(p)))
    const binned = paths.filter((p) => !shared.has(key(p)))
    if (!binned.length) return removeOnly(game.id, tMain('mainDelete.rom.allShared'))
    let total = 0
    let known = true
    for (const p of binned) {
      const size = await sizeOf(p)
      if (size === null) known = false
      else total += size
    }
    const updatesDlc = await updatesDlcPlan(game, root)
    return {
      gameId: game.id,
      kind: 'files',
      paths: binned,
      totalBytes: known ? total : undefined,
      kept: kept.length ? kept : undefined,
      ...(updatesDlc ? { updatesDlc } : {})
    }
  }

  /** A PS3 / Switch / Xbox 360 game's updates and DLC (updates-dlc.ts), or undefined when it has none. */
  async function updatesDlcPlan(
    game: Game,
    root: string
  ): Promise<LocalDeletePlan['updatesDlc'] | undefined> {
    const systemId = game.launch.kind === 'emulator' ? game.launch.systemId : null
    const emulationDir = deps.emulationDir?.()
    if (!systemId || !emulationDir || !hasUpdatesDlc(systemId)) return undefined
    const asRef = (g: Game): UpdatesDlcGame | null =>
      g.launch.kind === 'emulator' && g.source === 'rom' && !g.remote
        ? {
            id: g.id,
            systemId: g.launch.systemId,
            romPath: romGamePath(g, root),
            // Its names too, as a host's download matches them (an update named after the card's title).
            titles: [g.title, g.user?.titleOverride].filter((t): t is string => !!t)
          }
        : null
    const self = asRef(game)
    if (!self) return undefined
    const others = deps.library
      .games()
      .map(asRef)
      .filter((g): g is NonNullable<typeof g> => !!g && g.id !== game.id && g.systemId === systemId)
    const items = await updatesDlcOf(self, emulationDir, others)
    if (!items.length) return undefined
    const known = items.every((i) => i.bytes !== null)
    return {
      paths: items.map((i) => i.path),
      totalBytes: known ? items.reduce((n, i) => n + (i.bytes ?? 0), 0) : undefined
    }
  }

  /** `<dir> also holds <title>` when another (non-remote) library game has a path inside one of these folders. */
  function otherGameRefusal(game: Game, dirs: readonly string[]): string | null {
    for (const other of deps.library.games()) {
      if (other.id === game.id || other.remote || other.id.startsWith('remote:')) continue
      const theirs = [other.installDir, other.exePath, other.romPath].filter(
        (p): p is string => !!p && isAbsolute(p)
      )
      const clash = dirs.find((d) => theirs.some((p) => isInside(d, p)))
      if (clash)
        return tMain('mainDelete.rom.clash', { path: resolve(clash), title: displayTitle(other) })
    }
    return null
  }

  /**
   * The Add/Remove Programs uninstaller a manual game may run: null when there is none (or its program is missing), a
   * refusal when the entry is a store's (its folder is in a store library, or its program is a store client) or its
   * folder holds another library game. Plan and run both decide through here.
   */
  async function manualUninstaller(
    game: Game
  ): Promise<{ command: { file: string; args: string[] } } | { refusal: string } | null> {
    const entries = await io.uninstallEntries().catch(() => [] as UninstallEntry[])
    const entry = matchUninstallEntry(entries, game)
    const command = entry ? parseUninstallCommand(entry.uninstallString) : null
    if (!entry || !command) return null
    const store = storeUninstallRefusal(entry, command.file)
    if (store) return { refusal: store }
    // The uninstaller removes everything under its InstallLocation: when another library game lives there (SKSE
    // added by hand into Steam's Skyrim folder, a store game also added by hand), it would uninstall that game too.
    const shared = sharedUninstallRefusal(game, entry)
    if (shared) return { refusal: shared }
    if (!(await io.stat(command.file))) return null
    return { command }
  }

  async function manualPlan(game: Game): Promise<LocalDeletePlan> {
    const exe = game.exePath
    const dir = game.installDir ?? (exe ? dirname(exe) : undefined)
    // Another library game in this game's folder: neither an uninstaller nor a folder delete may run.
    if (dir && isAbsolute(dir)) {
      const other = otherGameRefusal(game, [dir])
      if (other) return removeOnly(game.id, other)
    }
    const uninstaller = await manualUninstaller(game)
    if (uninstaller && 'refusal' in uninstaller) return removeOnly(game.id, uninstaller.refusal)
    if (uninstaller)
      return { gameId: game.id, kind: 'uninstaller', paths: [uninstaller.command.file] }
    if (!dir) return removeOnly(game.id, tMain('mainDelete.folder.none'))
    const why = folderDeleteRefusal(dir, exe, {
      protectedFolders: (deps.protectedFolders ?? defaultProtectedFolders)(),
      appFolders: deps.appFolders()
    })
    if (why) return removeOnly(game.id, why)
    const st = await io.stat(dir)
    if (!st?.dir) return removeOnly(game.id, tMain('mainDelete.folder.notOnPc', { folder: dir }))
    const several = await collectionRefusal(game, resolve(dir), exe as string)
    if (several) return removeOnly(game.id, several)
    const bytes = await io.folderSize(dir)
    if (bytes === null)
      return removeOnly(game.id, tMain('mainDelete.folder.tooManyFiles', { folder: dir }))
    if (bytes > MAX_FOLDER_BYTES)
      return removeOnly(game.id, tMain('mainDelete.folder.tooLarge', { folder: dir }))
    return {
      gameId: game.id,
      kind: 'files',
      paths: [resolve(dir)],
      totalBytes: bytes,
      folder: true
    }
  }

  /**
   * Why a manual game's Add/Remove Programs uninstaller must not run, or null: another game of the library (any
   * source) is in the folder it uninstalls (its InstallLocation, or the game's own folder it was matched by).
   */
  function sharedUninstallRefusal(game: Game, entry: UninstallEntry): string | null {
    const location = entry.installLocation.trim().replace(/^"|"$/g, '')
    const dirs = [
      location,
      game.installDir,
      game.exePath ? dirname(game.exePath) : undefined
    ].filter((d): d is string => !!d && isAbsolute(d))
    const clash = otherGameRefusal(game, dirs)
    return clash ? tMain('mainDelete.uninstaller.removesOther', { reason: clash }) : null
  }

  /**
   * Why a manual game's folder looks like more than one game (so only Remove from library is offered), or null: another
   * game of the library (any source) is in it, it holds a store's library folder or a store client's program, or it
   * holds programs of different products (next to each other, or in its subfolders).
   */
  async function collectionRefusal(game: Game, dir: string, exe: string): Promise<string | null> {
    const other = otherGameRefusal(game, [dir])
    if (other) return other
    const top = await io.readdir(dir)
    if (!top) return tMain('mainDelete.folder.unreadable', { folder: dir })
    const exeName = basename(exe)
    const marker = (name: string, isDir: boolean): boolean =>
      isDir ? STORE_LIBRARY_DIR.test(name) : LAUNCHER_EXE.test(name)
    const programs = (list: { name: string; dir: boolean }[]): string[] =>
      list
        .filter((e) => !e.dir && /\.exe$/i.test(e.name) && !HELPER_EXE.test(e.name))
        .map((e) => e.name)
    const found = top.find((e) => marker(e.name, e.dir))
    if (found) return tMain('mainDelete.folder.holdsStore', { folder: dir, name: found.name })
    const own = programs(top)
    const otherProduct = own.find((p) => !sameProduct(p, exeName))
    if (otherProduct)
      return tMain('mainDelete.folder.mixedGames', {
        folder: dir,
        first: exeName,
        second: otherProduct
      })
    const subs = top.filter((e) => e.dir && !HELPER_DIR.test(e.name))
    if (subs.length > MAX_CHECKED_SUBFOLDERS)
      return tMain('mainDelete.folder.tooManyFolders', { folder: dir })
    // The folder that holds the game's program (when it is in a subfolder) is the game's own.
    const exeSub = relative(dir, resolve(exe)).split(/[\\/]+/)[0]
    for (const sub of subs) {
      const list = await io.readdir(join(dir, sub.name))
      if (!list) continue
      const inner = list.find((e) => marker(e.name, e.dir))
      if (inner)
        return tMain('mainDelete.folder.holdsStoreInner', {
          folder: dir,
          name: join(sub.name, inner.name)
        })
      if (sub.name.toLowerCase() === exeSub.toLowerCase()) continue
      const foreign = programs(list).find((p) => !sameProduct(p, exeName))
      if (foreign)
        return tMain('mainDelete.folder.holdsOtherGame', {
          folder: dir,
          name: join(sub.name, foreign)
        })
    }
    return null
  }

  async function plan(id: string): Promise<LocalDeletePlan> {
    const game = deps.library.getGame(id)
    const why = refusal(game)
    if (why || !game) return refused(id, why ?? tMain('mainDelete.refused.notInLibrary'))
    // Kept for its recompilation: its disc image is already in the Recycle Bin, only the card is left.
    if (game.romRemoved)
      return removeOnly(id, tMain('mainDelete.image.inRecycleBin', { title: displayTitle(game) }))
    if (game.source === 'rom') return romPlan(game)
    if (game.source === 'manual') return manualPlan(game)
    if (STORE_SOURCES.includes(game.source)) {
      const source = game.source as StoreSourceId
      return {
        gameId: id,
        kind: 'store',
        paths: [],
        storeName: deps.storeName(source),
        // Windows has no per-app uninstall link: only Settings › Apps opens, and the user uninstalls it there.
        ...(source === 'xbox' ? { opens: 'settings' as const } : {})
      }
    }
    return refused(id, tMain('mainDelete.refused.notHere'))
  }

  /** Start a program without a shell; an uninstaller that needs administrator rights goes through UAC. */
  async function startProgram(file: string, args: string[]): Promise<void> {
    try {
      await new Promise<void>((resolveStart, reject) => {
        try {
          const child = io.spawn(file, args, {
            cwd: dirname(file),
            detached: true,
            stdio: 'ignore',
            shell: false,
            windowsHide: false
          })
          child.once('spawn', () => resolveStart())
          child.once('error', (err) => reject(err))
          child.unref()
        } catch (err) {
          reject(err)
        }
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EACCES') throw err
      log.info(`${file} needs administrator rights; asking through UAC`)
      void io
        .runElevated(file, args)
        .catch((e) => log.warn(`elevated ${file} failed: ${(e as Error).message}`))
    }
  }

  function scheduleRescans(source: SourceId): void {
    for (const ms of STORE_RESCAN_DELAYS_MS)
      io.setTimeout(() => {
        if (disposed) return
        deps
          .rescan(source)
          .catch((err) =>
            log.warn(`rescan of ${source} after uninstall failed: ${(err as Error).message}`)
          )
      }, ms)
  }

  /**
   * Whether a manual game whose uninstaller ran is gone from this PC: its program and its folder are both gone while
   * their drive is there. The registry is never asked: a read that misses a hive would make a still-installed game's
   * entry look gone, so the record stays while the program or folder exists, whatever Add/Remove Programs says.
   */
  /**
   * Uninstalled: the game's program is gone while its drive is there. Uninstallers often leave the folder behind (saves,
   * settings, logs), so the folder decides only for a game without a program path; a cancelled uninstall leaves the
   * program in place. The registry is not asked (a partial read must not count as uninstalled).
   */
  async function uninstalled(game: Game): Promise<boolean> {
    const target = [game.exePath, game.installDir].find((p): p is string => !!p && isAbsolute(p))
    if (!target) return false
    const full = resolve(target)
    if (!(await io.stat(parse(full).root))) return false
    return !(await io.stat(full))
  }

  function scheduleUninstallChecks(gameId: string): void {
    for (const ms of STORE_RESCAN_DELAYS_MS)
      io.setTimeout(() => {
        if (disposed) return
        const game = deps.library.getGame(gameId)
        if (!game || game.source !== 'manual' || deps.running()?.gameId === gameId) return
        uninstalled(game)
          .then(async (gone) => {
            if (!gone || disposed || !deps.library.getGame(gameId)) return
            log.info(`${displayTitle(game)}: uninstalled; removing it from the library`)
            await forget(game)
          })
          .catch((err) =>
            log.warn(`checking ${gameId} after its uninstaller failed: ${(err as Error).message}`)
          )
      }, ms)
  }

  async function runStore(game: Game, source: StoreSourceId): Promise<LocalDeleteResult> {
    const store = deps.storeName(source)
    const title = displayTitle(game)
    let opened: 'uninstall' | 'library' = 'uninstall'
    const uri = uninstallUriFor(source, game)
    if (uri) {
      if (!isAllowedUninstallUri(uri))
        return { ok: false, message: tMain('mainDialogs.refusedLink') }
      log.info(`${title}: opening ${uri}`)
      await io.openExternal(uri)
    } else {
      let started = false
      if (source === 'gog') {
        const client = await deps.client('gog')
        const args = gogUninstallArgs(game)
        if (
          args &&
          client.installed &&
          client.path &&
          /^galaxyclient\.exe$/i.test(basename(client.path)) &&
          (await io.stat(client.path))
        ) {
          log.info(`${title}: running ${client.path} ${args.join(' ')}`)
          await startProgram(client.path, args)
          started = true
        }
      } else {
        const entries = await io.uninstallEntries().catch(() => [] as UninstallEntry[])
        const entry = matchUninstallEntry(entries, game)
        const command = entry ? parseUninstallCommand(entry.uninstallString) : null
        if (command && (await io.stat(command.file))) {
          log.info(`${title}: running ${command.file} ${command.args.join(' ')}`)
          await startProgram(command.file, command.args)
          started = true
        }
      }
      if (!started) {
        const page = LIBRARY_PAGE[source]
        if (!isAllowedUninstallUri(page))
          return { ok: false, message: tMain('mainDialogs.refusedLink') }
        log.info(`${title}: no uninstall command; opening ${page}`)
        await io.openExternal(page)
        opened = 'library'
      }
    }
    scheduleRescans(source)
    return {
      ok: true,
      kind: 'store',
      removed: false,
      message:
        source === 'xbox'
          ? tMain('mainDelete.uninstall.settingsOpen', { title })
          : opened === 'uninstall'
            ? tMain('mainDelete.uninstall.storeUninstalling', { store, title })
            : tMain('mainDelete.uninstall.storeOpen', { store, title })
    }
  }

  async function forget(game: Game): Promise<void> {
    deps.forgetRomSet?.(game.id)
    await deps.imageCache
      .remove(game.id)
      .catch((err) => log.warn(`${game.id}: cached art not removed: ${(err as Error).message}`))
    deps.library.removeGame(game.id)
  }

  async function run(id: string, options: LocalDeleteOptions = {}): Promise<LocalDeleteResult> {
    await deps.stopUpdatesFetch?.(id).catch(() => undefined)
    // Planned again here: the renderer's preview is never trusted, and the game may have started meanwhile.
    const p = await plan(id)
    const game = deps.library.getGame(id)
    if (!game || p.kind === 'refused' || p.kind === 'remove-only')
      return {
        ok: false,
        kind: p.kind,
        message: p.reason ?? tMain('mainDelete.refused.cannotDelete')
      }
    const title = displayTitle(game)
    try {
      if (p.kind === 'store') return await runStore(game, game.source as StoreSourceId)
      if (p.kind === 'uninstaller') {
        const found = await manualUninstaller(game)
        if (found && 'refusal' in found)
          return { ok: false, kind: 'remove-only', message: found.refusal }
        const command = found?.command
        if (!command)
          return { ok: false, message: tMain('mainDelete.uninstall.notFound', { title }) }
        log.info(`${title}: running ${command.file} ${command.args.join(' ')}`)
        await startProgram(command.file, command.args)
        // The uninstaller may still be cancelled: the record stays until the game is gone from this PC.
        scheduleUninstallChecks(game.id)
        return {
          ok: true,
          kind: 'uninstaller',
          removed: false,
          message: tMain('mainDelete.uninstall.open', { title })
        }
      }
      // files: one by one; the first failure stops, and the record stays (what went is in the Recycle Bin).
      let moved = 0
      for (const path of p.paths) {
        try {
          await io.trash(path)
          moved++
        } catch (err) {
          log.warn(`${title}: ${path} not moved to the Recycle Bin: ${(err as Error).message}`)
          return {
            ok: false,
            kind: 'files',
            removed: false,
            message:
              moved === 0
                ? tMain('mainDelete.files.noRecycleBin', { title })
                : tMain('mainDelete.files.partial', {
                    moved,
                    total: p.paths.length,
                    title,
                    file: basename(path)
                  })
          }
        }
      }
      // Its updates and DLC (asked for): after the game, so a failure there never leaves half a game behind.
      let extrasMoved = 0
      const extras = options.updatesDlc ? (p.updatesDlc?.paths ?? []) : []
      const extrasFailed: string[] = []
      for (const path of extras) {
        try {
          await io.trash(path)
          extrasMoved++
        } catch (err) {
          log.warn(`${title}: ${path} not moved to the Recycle Bin: ${(err as Error).message}`)
          extrasFailed.push(basename(path))
        }
      }
      await forget(game)
      log.info(
        `${title}: ${moved} item(s) moved to the Recycle Bin${extras.length ? `, and ${extrasMoved} of its updates and DLC` : ''}`
      )
      return {
        ok: true,
        kind: 'files',
        removed: true,
        message: extrasFailed.length
          ? tMain('mainDelete.files.movedExtrasFailed', {
              title,
              failed: extrasFailed.length,
              files: extrasFailed.slice(0, 3).join(', ')
            })
          : extrasMoved
            ? tMain('mainDelete.files.movedWithExtras', { title })
            : tMain('mainDelete.files.moved', { title })
      }
    } catch (err) {
      log.warn(`${title}: delete failed: ${(err as Error).message}`)
      return {
        ok: false,
        kind: p.kind,
        message: tMain('mainDelete.files.couldNotDelete', { title, error: (err as Error).message })
      }
    }
  }

  async function imagePlan(
    id: string,
    options: { recompRunning?: boolean } = {}
  ): Promise<{ paths: string[]; totalBytes: number | null } | { refusal: string }> {
    const game = deps.library.getGame(id)
    const why = refusal(game, options.recompRunning === true)
    if (why || !game) return { refusal: why ?? tMain('mainDelete.refused.notInLibrary') }
    if (game.source !== 'rom' || game.romRemoved || !game.romPath)
      return { refusal: tMain('mainDelete.image.none', { title: displayTitle(game) }) }
    const p = await romPlan(game)
    if (p.kind !== 'files') return { refusal: p.reason ?? tMain('mainDelete.image.cannotMove') }
    const sending = new Set((deps.filesBeingSent?.() ?? []).map(key))
    if (
      p.paths.some((path) => sending.has(key(path)) || [...sending].some((s) => isInside(path, s)))
    )
      return { refusal: tMain('mainDelete.image.downloading') }
    return { paths: p.paths, totalBytes: p.totalBytes ?? null }
  }

  async function trashImage(
    id: string,
    recompId: string,
    options: { recompRunning?: boolean } = {}
  ): Promise<{ ok: boolean; message: string }> {
    const p = await imagePlan(id, options)
    const game = deps.library.getGame(id)
    if ('refusal' in p || !game)
      return {
        ok: false,
        message: tMain('mainDelete.nothingDeleted', {
          why: 'refusal' in p ? p.refusal : tMain('mainDelete.image.gameGone')
        })
      }
    const title = displayTitle(game)
    const main = game.romPath!
    const order = imageTrashOrder(p.paths, main)
    let moved = 0
    for (const path of order) {
      try {
        await io.trash(path)
        moved++
      } catch (err) {
        log.warn(`${title}: ${path} not moved to the Recycle Bin: ${(err as Error).message}`)
        if (moved === 0)
          return {
            ok: false,
            message: tMain('mainDelete.image.noRecycleBin', { file: basename(path) })
          }
        // Part of the set went. The card's own file (the sheet that lists the rest) goes last, so it is still there and
        // the files left stay listed by it: the card stays an ordinary ROM card (no leftover file shows up as a game of
        // its own at the next scan) until the player restores the moved files or answers again.
        deps.forgetRomSet?.(game.id)
        return {
          ok: false,
          message: tMain('mainDelete.image.partial', {
            moved,
            total: order.length,
            file: basename(path)
          })
        }
      }
    }
    deps.forgetRomSet?.(game.id)
    deps.library.markRomRemoved?.(game.id, recompId)
    log.info(
      `${title}: disc image (${moved} item(s)) moved to the Recycle Bin; the card starts ${recompId}`
    )
    return { ok: true, message: tMain('mainDelete.image.moved', { file: basename(main) }) }
  }

  async function unpackedFolderPlan(
    dir: string
  ): Promise<{ totalBytes: number | null } | { refusal: string }> {
    const protectedFolders = (deps.protectedFolders ?? defaultProtectedFolders)()
    const why = folderGuardRefusal(dir, { protectedFolders, appFolders: deps.appFolders() })
    if (why) return { refusal: why }
    const full = resolve(dir)
    // Never a folder right in a known folder (%USERPROFILE%\Games, Documents\My Games…): it may hold every game.
    if (protectedFolders.some((known) => known && key(dirname(full)) === key(known)))
      return { refusal: tMain('mainDelete.unpacked.systemFolder', { folder: full }) }
    if (deps.keepFolders().some((k) => k && (isInside(full, k) || isInside(k, full))))
      return { refusal: tMain('mainDelete.unpacked.saves', { folder: full }) }
    const link = await fs.lstat(full).then(
      (st) => st.isSymbolicLink(),
      () => false
    )
    if (link) return { refusal: tMain('mainDelete.unpacked.link', { folder: full }) }
    const st = await io.stat(full)
    if (!st) return { refusal: tMain('mainDelete.unpacked.gone', { folder: full }) }
    if (!st.dir) return { refusal: tMain('mainDelete.unpacked.notFolder', { folder: full }) }
    const sending = (deps.filesBeingSent?.() ?? []).filter((s) => isInside(full, s))
    if (sending.length) return { refusal: tMain('mainDelete.unpacked.downloading') }
    return { totalBytes: await io.folderSize(full) }
  }

  async function trashUnpackedFolder(dir: string): Promise<{ ok: boolean; message: string }> {
    const p = await unpackedFolderPlan(dir)
    if ('refusal' in p)
      return { ok: false, message: tMain('mainDelete.nothingDeleted', { why: p.refusal }) }
    const full = resolve(dir)
    try {
      await io.trash(full)
    } catch (err) {
      log.warn(`${full}: not moved to the Recycle Bin: ${(err as Error).message}`)
      return {
        ok: false,
        message: tMain('mainDelete.unpacked.noRecycleBin', { folder: full })
      }
    }
    log.info(`unpacked game folder ${full} moved to the Recycle Bin`)
    return { ok: true, message: tMain('mainDelete.unpacked.moved', { folder: full }) }
  }

  /** Record, then move aside (held-files.ts); a failure puts back what moved. */
  async function hold(
    paths: string[],
    holdId: string,
    beforeMove: (entries: HeldEntry[]) => Promise<unknown>
  ): Promise<HoldResult> {
    const entries = paths.map((p) => ({ original: resolve(p), held: heldPathFor(p, holdId) }))
    try {
      await beforeMove(entries)
    } catch (err) {
      return {
        ok: false,
        message: tMain('mainDelete.held.noteFailed', { error: (err as Error).message }),
        stuck: []
      }
    }
    const moved = await moveAside(entries, holdId, io)
    if (!moved.ok) {
      log.warn(`could not move ${paths.join(', ')} aside: ${moved.message}`)
      return {
        ok: false,
        message: moved.stuck.length
          ? tMain('mainDelete.held.stuck', { error: moved.message, files: moved.stuck.length })
          : tMain('mainDelete.nothingDeletedError', { error: moved.message }),
        stuck: moved.stuck
      }
    }
    return { ok: true, message: tMain('mainDelete.held.movedAside'), entries }
  }

  async function holdImage(
    id: string,
    recompId: string,
    holdId: string,
    options: { recompRunning?: boolean; beforeMove(entries: HeldEntry[]): Promise<unknown> }
  ): Promise<HoldResult> {
    const p = await imagePlan(id, options)
    const game = deps.library.getGame(id)
    if ('refusal' in p || !game)
      return {
        ok: false,
        message: tMain('mainDelete.nothingDeleted', {
          why: 'refusal' in p ? p.refusal : tMain('mainDelete.image.gameGone')
        }),
        stuck: []
      }
    const main = game.romPath!
    // The order trashImage used: the data files first, the card's own file last (restored in reverse).
    const held = await hold(imageTrashOrder(p.paths, main), holdId, options.beforeMove)
    if (!held.ok) return held
    deps.forgetRomSet?.(game.id)
    deps.library.markRomRemoved?.(game.id, recompId)
    log.info(
      `${displayTitle(game)}: disc image (${held.entries.length} item(s)) moved aside while ${recompId} is tested without it`
    )
    return { ...held, message: tMain('mainDelete.held.movedFileAside', { file: basename(main) }) }
  }

  async function holdUnpackedFolder(
    dir: string,
    holdId: string,
    options: { beforeMove(entries: HeldEntry[]): Promise<unknown> }
  ): Promise<HoldResult> {
    const p = await unpackedFolderPlan(dir)
    if ('refusal' in p)
      return {
        ok: false,
        message: tMain('mainDelete.nothingDeleted', { why: p.refusal }),
        stuck: []
      }
    const held = await hold([resolve(dir)], holdId, options.beforeMove)
    if (held.ok) log.info(`unpacked game folder ${resolve(dir)} moved aside for a test run`)
    return held
  }

  async function releaseHeld(entries: HeldEntry[], holdId: string): Promise<HeldOutcome> {
    const r = await trashHeld(entries, holdId, io)
    if (r.ok)
      log.info(`held ${entries.map((e) => e.original).join(', ')}: moved to the Recycle Bin`)
    else log.warn(`held files not moved to the Recycle Bin: ${r.message}`)
    return r
  }

  async function restoreHeld(
    entries: HeldEntry[],
    holdId: string,
    card: { gameId: string; image: string } | null
  ): Promise<HeldOutcome> {
    const r = await putBack(entries, holdId, io)
    if (!r.restored.length && !r.ok) {
      log.warn(`held files not restored: ${r.message}`)
      return r
    }
    log.info(`restored ${r.restored.map((e) => e.original).join(', ')}`)
    if (card && r.restored.some((e) => key(e.original) === key(card.image))) {
      deps.forgetRomSet?.(card.gameId)
      deps.library.restoreRomRemoved?.(card.gameId)
    }
    return r
  }

  return {
    plan,
    run,
    imagePlan,
    trashImage,
    unpackedFolderPlan,
    trashUnpackedFolder,
    holdImage,
    holdUnpackedFolder,
    releaseHeld,
    restoreHeld,
    dispose() {
      disposed = true
    }
  }
}
