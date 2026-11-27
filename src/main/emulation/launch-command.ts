import { promises as fs } from 'fs'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'path'
import type {
  EmulatorCommand,
  Game,
  LaunchError,
  Settings,
  SystemDefinition
} from '../../shared/types'
import type { Logger } from '../logger'
import { effectiveEmulatorCommand, type EmulatorChoiceOrigin } from '../../shared/emulators'
import { ensureDir, isFile, statSafe } from '../util/fs'
import { knownFolders } from '../util/paths'
import { searchPath, type EmulatorResolver } from './find-rules'
import { romGameFolder } from './rom-scanner'
import { emulatorIdsInCommand } from './systems'
import type { LaunchResolution, ResolvedLaunch } from './types'
import { tMain } from '../i18n'

export interface LaunchCommandDeps {
  resolver: Pick<EmulatorResolver, 'resolveEmulator' | 'resolveCore'>
  getSettings: () => Settings
  /** Directory of the PlayOut executable (%ESPATH%). */
  exeDir: string
  log: Logger
  env?: NodeJS.ProcessEnv
  /**
   * Read a Windows shortcut (.lnk) for %RPCS3_AUTO%; throws when the file is not a readable shortcut. Defaults to
   * Electron's shell.readShortcutLink on Windows (loaded on first use, so this module runs without Electron).
   */
  readShortcut?: ReadShortcut
}

/** What a Windows shortcut points at (Electron's shell.readShortcutLink). */
export interface ShortcutLink {
  target: string
  /** The shortcut's raw argument string, as shown in its properties dialog. */
  args?: string
  cwd?: string
}

export type ReadShortcut = (file: string) => Promise<ShortcutLink>

/** Electron's shell.readShortcutLink; Windows only. */
export const readShortcutWithElectron: ReadShortcut = async (file) => {
  if (process.platform !== 'win32')
    throw new Error(tMain('mainEmulation.launch.shortcutsWindowsOnly'))
  const { shell } = await import('electron')
  const link = shell.readShortcutLink(file)
  return { target: link.target, args: link.args, cwd: link.cwd }
}

const FLAG_RUN_IN_BACKGROUND = '%RUNINBACKGROUND%'
const FLAG_HIDE_WINDOW = '%HIDEWINDOW%'
const FLAG_ESCAPE_SPECIALS = '%ESCAPESPECIALS%'
const FLAG_ENABLE_SHORTCUTS = '%ENABLESHORTCUTS%'
const MAX_INJECT_BYTES = 4096
const RPCS3_AUTO = '%RPCS3_AUTO%'
/** ES-DE's "open the file with Windows" command (`%EMULATOR_OS-SHELL% /C %ROM%`, the Shortcut ones). */
const OPENS_WITH_WINDOWS = /%EMULATOR_OS-SHELL%\s+\/C\s+%ROM%/i
/** Files Windows itself starts: what such a command can launch when the system has no emulator. */
const SHELL_FILES = new Set(['.lnk', '.url', '.bat', '.cmd', '.exe'])
/** A PS3 title id: four letters and five digits (BLUS30443, NPUB30024). */
const PS3_SERIAL = /^[A-Z]{4}\d{5}$/i

/**
 * Split an ES-DE command template into words with the Win32 argv rules that CreateProcessW applies to ES-DE's
 * expanded command line: whitespace separates words, double quotes group them (and are removed), and backslashes
 * are literal unless they precede a quote (2n backslashes + quote = n backslashes and a quote toggle, 2n+1
 * backslashes + quote = n backslashes and a literal quote). A backslash before a space is NOT an escape, because
 * Windows paths end in backslashes (`-mmc=.\ %ROM%`, `%GAMEDIR%\;`).
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let hasToken = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\\') {
      let count = 0
      while (command[i + count] === '\\') count++
      if (command[i + count] === '"') {
        current += '\\'.repeat(Math.floor(count / 2))
        hasToken = true
        if (count % 2 === 1) current += '"'
        else inQuotes = !inQuotes
        i += count
        continue
      }
      current += '\\'.repeat(count)
      hasToken = true
      i += count - 1
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      hasToken = true
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) tokens.push(current)
  return tokens
}

/**
 * Pick the command to run: the explicitly requested emulator, then the game's own choice, then the scan's choice
 * for the ROM (launch.emulatorId), then the preferred emulator for the system, then the system's default (first)
 * command. Ids and ES-DE labels are both accepted, also those of commands a merged command replaced (aliases).
 */
export function selectCommand(
  system: SystemDefinition,
  game: Game,
  requested: string | undefined,
  settings: Settings,
  log?: Logger
): EmulatorCommand {
  // The scan's pick for this kind of ROM comes before the preferred emulator: a PS4 game folder runs through
  // shadPS4's eboot.bin command, which the system's default shortcut command and a serial-based preference cannot take.
  const origins: Record<EmulatorChoiceOrigin, string> = {
    request: 'launch option',
    game: `game ${game.id}`,
    scan: `scan of ${game.id}`,
    preferred: 'settings.emulators.preferred'
  }
  const command = effectiveEmulatorCommand(system, game, settings.emulators.preferred, {
    requested,
    onUnknown: (name, origin) =>
      log?.warn(
        `${origins[origin]} names unknown emulator '${name}' for ${system.id}; falling back`
      )
  })
  if (!command) throw new Error(`${system.id} has no launch command`)
  return command
}

/**
 * Whether a launch of this game (no emulator requested) runs `emulatorId` (a %EMULATOR_X% name such as 'PCSX2'):
 * the command selectCommand picks names that emulator.
 */
export function launchesWith(
  system: SystemDefinition,
  game: Game,
  settings: Settings,
  emulatorId: string
): boolean {
  return emulatorIdsInCommand(selectCommand(system, game, undefined, settings).command).includes(
    emulatorId
  )
}

function fail(error: LaunchError): LaunchResolution {
  return { ok: false, error }
}

function describeSearch(searched: string[], limit = 12): string {
  if (!searched.length) return ''
  const shown = searched.slice(0, limit)
  const more =
    searched.length > shown.length
      ? `\n${tMain('mainEmulation.launch.searchedMore', { count: searched.length - shown.length })}`
      : ''
  return `\n${tMain('mainEmulation.launch.lookedIn')}\n${shown.join('\n')}${more}`
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/** Strip a trailing path separator (but keep "C:\"). */
function trimSeparator(p: string): string {
  return p.length > 3 ? p.replace(/[\\/]+$/, '') : p
}

/**
 * ES-DE's %ESCAPESPECIALS% rule (docs/research/esde-systems.md §4.2): prefix each of `^ & ( ) = ; ,` (in that
 * order) with `^`, and when any was found also turn every space into `^ `. The result is meant for cmd.exe, which
 * re-parses `/C <command>` as a command line: without the carets `ROMs\steam\Ratchet & Clank.url` runs `Ratchet`
 * and `Clank.url` as two commands. Node's argv quoting only adds the outer `"…"` for paths with spaces, which cmd
 * strips again before honouring the carets, so the resulting command line is exactly the one ES-DE builds.
 */
export function escapeCmdSpecials(path: string): string {
  let out = path
  for (const c of ['^', '&', '(', ')', '=', ';', ',']) out = out.split(c).join('^' + c)
  return out === path ? path : out.split(' ').join('^ ')
}

/**
 * Expand the system's command template for one game into a spawnable { file, args } (never a shell string).
 * Placeholder semantics follow docs/research/esde-systems.md §4; values are substituted raw because the launcher
 * passes an argv array and Node quotes it. The one exception is %ESCAPESPECIALS% (the `%EMULATOR_OS-SHELL% /C %ROM%`
 * systems: steam, epic, windows, desktop, kodi, ports, ...): cmd.exe parses %ROM% as a command line, so the ROM path
 * is caret-escaped the way ES-DE does it (see escapeCmdSpecials).
 */
export async function resolveLaunchCommand(
  game: Game,
  system: SystemDefinition,
  requestedEmulator: string | undefined,
  deps: LaunchCommandDeps
): Promise<LaunchResolution> {
  const { log } = deps
  const env = deps.env ?? process.env
  const settings = deps.getSettings()
  const folders = knownFolders()

  const romPath =
    game.romPath ?? (game.launch.kind === 'emulator' ? game.launch.romPath : undefined)
  if (!romPath)
    return fail({
      kind: 'failed',
      message: tMain('mainEmulation.launch.noRomPath', { title: game.title })
    })
  const romStat = await statSafe(romPath)
  if (!romStat)
    return fail({
      kind: 'file-missing',
      message: tMain('mainEmulation.launch.romNotFound', { path: romPath })
    })

  const command = selectCommand(system, game, requestedEmulator, settings, log)
  if (/PLACEHOLDER/i.test(command.command)) {
    return fail({
      kind: 'failed',
      message: tMain('mainEmulation.launch.placeholderSystem', { system: system.name })
    })
  }
  if (
    !romStat.isDirectory() &&
    system.emulators.every((e) => OPENS_WITH_WINDOWS.test(e.command)) &&
    !SHELL_FILES.has(extname(romPath).toLowerCase())
  ) {
    // A system with no emulator (Nintendo Switch 2, PlayStation 5): only shortcuts and scripts start; a game file
    // would only bring up Windows' "How do you want to open this file?". A dumped game folder (a PS5 game's
    // eboot.bin) is named by its folder, and a shortcut goes beside that folder (inside it, it is not listed).
    const folderGame = romGameFolder(romPath, game)
    const what = folderGame ? basename(folderGame) : basename(romPath)
    return fail({
      kind: 'failed',
      message: tMain(
        folderGame
          ? 'mainEmulation.launch.noEmulatorFolder'
          : 'mainEmulation.launch.noEmulatorFile',
        { system: system.name, game: what }
      )
    })
  }

  // Paths. A directory-as-file whose name is repeated inside (Game.m3u\Game.m3u) launches that inner file; ES-DE
  // then cuts %BASENAME% at the first dot.
  const isDirectory = romStat.isDirectory()
  let launchPath = normalize(romPath)
  let baseName = isDirectory ? basename(romPath) : stemOf(basename(romPath))
  if (isDirectory) {
    const inner = join(romPath, basename(romPath))
    if (await isFile(inner)) {
      launchPath = inner
      baseName = basename(romPath).split('.')[0]
    }
  }
  const fileName = baseName + extname(launchPath)
  const gameDir = dirname(launchPath)
  const entryDir = isDirectory ? normalize(romPath) : dirname(romPath)
  const romsRoot = trimSeparator(
    settings.library.romsRoot ?? romsRootFromExternalId(game, romPath) ?? dirname(gameDir)
  )

  let tokens = tokenize(command.command)

  // 1. Flags.
  const runInBackground = tokens.includes(FLAG_RUN_IN_BACKGROUND)
  const hideWindow = tokens.includes(FLAG_HIDE_WINDOW)
  const escapeSpecials = tokens.includes(FLAG_ESCAPE_SPECIALS)
  // %ESCAPESPECIALS% applies to %ROM% only (ES-DE §4.3 step 10); %ROMRAW% and %GAMEDIR% stay raw.
  const escapedRom = escapeSpecials ? escapeCmdSpecials(launchPath) : launchPath
  if (escapedRom !== launchPath)
    log.debug(`${FLAG_ESCAPE_SPECIALS}: %ROM% passed to the command shell as ${escapedRom}`)
  tokens = tokens.filter(
    (t) => t !== FLAG_RUN_IN_BACKGROUND && t !== FLAG_HIDE_WINDOW && t !== FLAG_ESCAPE_SPECIALS
  )
  if (tokens.includes(FLAG_ENABLE_SHORTCUTS)) {
    log.warn(
      `${FLAG_ENABLE_SHORTCUTS} is a Unix/macOS placeholder and was dropped from the ${system.id} command`
    )
    tokens = tokens.filter((t) => t !== FLAG_ENABLE_SHORTCUTS)
  }
  const dropped = tokens.filter(
    (t) => /^%PRECOMMAND_[^%]+%$/i.test(t) || /^%POSTCOMMAND(_[^%]+)?%$/i.test(t)
  )
  if (dropped.length) {
    log.warn(
      `unsupported placeholder(s) dropped from the ${system.id} command: ${dropped.join(' ')}`
    )
    tokens = tokens.filter((t) => !dropped.includes(t))
  }
  tokens = tokens.filter((t) => !/^%FILEINJECT%$/i.test(t))

  // 2. Emulator binary (%EMULATOR_X% through the find rules, else the first word searched on PATH).
  const emulatorPaths = new Map<string, string>()
  let file: string | null = null
  let emulatorId: string | undefined
  let emulatorIndex = tokens.findIndex((t) => /^%EMULATOR_[^%]+%$/.test(t))
  if (emulatorIndex === -1) {
    const first = tokens[0]
    if (!first)
      return fail({
        kind: 'failed',
        message: tMain('mainEmulation.launch.commandEmpty', { system: system.name })
      })
    const searched: string[] = []
    const found = await findBareExecutable(first, deps.exeDir, env, searched)
    if (!found) {
      return fail({
        kind: 'emulator-missing',
        emulatorId: first,
        message: tMain('mainEmulation.launch.emulatorNotFound', {
          emulator: first,
          searched: describeSearch(searched)
        })
      })
    }
    file = found
    emulatorIndex = 0
  }
  for (const token of tokens) {
    const match = token.match(/%EMULATOR_([^%]+)%/)
    if (!match || emulatorPaths.has(match[1])) continue
    const status = await deps.resolver.resolveEmulator(match[1])
    if (!status.path) {
      return fail({
        kind: 'emulator-missing',
        emulatorId: match[1],
        message: tMain('mainEmulation.launch.emulatorMissing', {
          name: status.name,
          id: match[1],
          searched: describeSearch(status.searchedPaths)
        })
      })
    }
    emulatorPaths.set(match[1], status.path)
  }
  if (!file) {
    const id = tokens[emulatorIndex].match(/%EMULATOR_([^%]+)%/)?.[1] ?? ''
    file = emulatorPaths.get(id) ?? null
    if (file) emulatorId = id
  }
  if (!file)
    return fail({
      kind: 'failed',
      message: tMain('mainEmulation.launch.noExecutable', { system: system.name })
    })
  const emuDir = dirname(file)
  // The executable token leaves the argument list now, before %STARTDIR% / %INJECT% move the other tokens around.
  tokens.splice(emulatorIndex, 1)

  // 3. Cores (%CORE_X%\file).
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(/^(.*?)%CORE_([^%]+)%[\\/]?(.*)$/)
    if (!match) continue
    const [, prefix, coreId, coreFile] = match
    const core = await deps.resolver.resolveCore(coreId, coreFile)
    if (!core.path) {
      return fail({
        kind: 'core-missing',
        emulatorId: coreId,
        coreFile: core.coreFile,
        message: tMain('mainEmulation.launch.coreNotFound', {
          core: coreId,
          file: core.coreFile,
          searched: describeSearch(core.searchedPaths)
        })
      })
    }
    tokens[i] = prefix + core.path
  }

  // 4. %STARTDIR%=<dir>.
  let cwd: string | undefined
  const startIndex = tokens.findIndex((t) => /^%STARTDIR%=/i.test(t))
  if (startIndex !== -1) {
    const value = tokens[startIndex].slice('%STARTDIR%='.length)
    tokens.splice(startIndex, 1)
    const expanded = substitute(value)
    if (expanded) {
      cwd = normalize(expanded.replace(/\//g, '\\'))
      try {
        await ensureDir(cwd)
      } catch (err) {
        return fail({
          kind: 'failed',
          message: tMain('mainEmulation.launch.startDirFailed', {
            folder: cwd,
            error: (err as Error).message
          })
        })
      }
    }
  }

  // 5. %INJECT%=<file> (repeatable): the file's content replaces the placeholder where it stands, which may be in
  // the middle of a word (`-id=%INJECT%=%BASENAME%.3dsen`); the file name runs to the end of the word. PlayOut reads
  // the file itself, so a %ROM% in its name is the real path, never the caret-escaped one %ESCAPESPECIALS% gives cmd.
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(/^(.*?)%(?:FILE)?INJECT%=(.+)$/i)
    if (!match) continue
    const spec = substitute(match[2].replace(/%ROM%/g, '%ROMRAW%'))
    const injected = await readInjectFile(spec, gameDir, log)
    const replacement = tokenize(match[1] + injected)
    tokens.splice(i, 1, ...replacement)
    i += replacement.length - 1
  }

  // 5b. %RPCS3_AUTO%: what RPCS3 boots for this game (a folder, a serial, or a file), decided per ROM.
  let rpcs3Auto: string | undefined
  if (tokens.includes(RPCS3_AUTO)) {
    const target = await rpcs3Target(
      launchPath,
      isDirectory && launchPath === normalize(romPath),
      deps.readShortcut ?? readShortcutWithElectron
    )
    if (!target.ok) return fail({ kind: 'failed', message: target.message })
    log.info(`${RPCS3_AUTO} for ${game.id}: ${target.reason} -> ${target.value}`)
    rpcs3Auto = target.value
  }

  // 6. Everything else.
  tokens = tokens.map((t) =>
    t === RPCS3_AUTO && rpcs3Auto !== undefined ? rpcs3Auto : substitute(t)
  )
  for (const token of tokens) {
    if (token === rpcs3Auto) continue
    const leftover = token.match(/%[A-Z0-9_()-]+%/i)
    if (leftover)
      log.warn(`unknown placeholder ${leftover[0]} left as-is in the ${system.id} command`)
  }

  const args = tokens
  const result: ResolvedLaunch = { ok: true, file, args, runInBackground, hideWindow }
  if (cwd) result.cwd = cwd
  if (emulatorId) result.emulatorId = emulatorId
  log.info(
    `launch ${game.id} via ${command.label}: ${file} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
  )
  return result

  function substitute(token: string): string {
    let out = token.startsWith('~') ? folders.userProfile + token.slice(1) : token
    out = out.replace(/%EMULATOR_([^%]+)%/g, (m, id: string) => emulatorPaths.get(id) ?? m)
    const simple: Record<string, string> = {
      '%ROM%': escapedRom,
      '%ROMRAW%': launchPath,
      '%ROMPATH%': romsRoot,
      '%BASENAME%': baseName,
      '%FILENAME%': fileName,
      '%GAMEDIR%': gameDir,
      '%GAMEDIRRAW%': gameDir,
      '%GAMEENTRYDIR%': entryDir,
      '%EMUDIR%': emuDir,
      '%EMUPATH%': emuDir,
      '%ESPATH%': deps.exeDir
    }
    return out.replace(/%[A-Z]+%/g, (m) => simple[m] ?? m)
  }
}

function expandSimple(token: string, ctx: { espath: string; home: string }): string {
  let out = token.startsWith('~') ? ctx.home + token.slice(1) : token
  out = out.replace(/%ESPATH%/gi, ctx.espath)
  return out
}

/**
 * The executable of a command without %EMULATOR_X%, from its first word: an absolute path that is a file, else the
 * name searched in PlayOut's folder and on PATH. Null when it is not found; every place looked in goes to `searched`.
 */
async function findBareExecutable(
  first: string,
  exeDir: string,
  env: NodeJS.ProcessEnv,
  searched: string[] = []
): Promise<string | null> {
  const expanded = expandSimple(first, { espath: exeDir, home: knownFolders().userProfile })
  if (!isAbsolute(expanded)) return searchPath(expanded, env, [exeDir], searched)
  searched.push(expanded)
  return (await isFile(expanded)) ? expanded : null
}

/** The words resolveLaunchCommand takes out of a command before it looks for the executable. */
const NOT_AN_EXECUTABLE = [
  FLAG_RUN_IN_BACKGROUND,
  FLAG_HIDE_WINDOW,
  FLAG_ESCAPE_SPECIALS,
  FLAG_ENABLE_SHORTCUTS,
  '%FILEINJECT%'
]

/**
 * Whether a command that names no %EMULATOR_X% can start: resolveLaunchCommand runs its first word, a program in
 * PlayOut's folder or on PATH (or an absolute path), so the command is available when that program is found. Never
 * for ES-DE's PLACEHOLDER commands (systems without a Windows launch command), which resolveLaunchCommand refuses.
 */
export async function bareCommandAvailable(
  command: string,
  exeDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (/PLACEHOLDER/i.test(command)) return false
  const first = tokenize(command).find(
    (t) =>
      !NOT_AN_EXECUTABLE.includes(t.toUpperCase()) &&
      !/^%PRECOMMAND_[^%]+%$/i.test(t) &&
      !/^%POSTCOMMAND(_[^%]+)?%$/i.test(t)
  )
  return first !== undefined && (await findBareExecutable(first, exeDir, env)) !== null
}

/** ROM root derived from the game's externalId (`<system>/<relative path>`) when settings do not know it. */
function romsRootFromExternalId(game: Game, romPath: string): string | null {
  const rel = game.externalId.replace(/\//g, '\\')
  const full = normalize(romPath)
  if (full.toLowerCase().endsWith(`\\${rel.toLowerCase()}`))
    return full.slice(0, full.length - rel.length - 1)
  return null
}

type Rpcs3Target = { ok: true; value: string; reason: string } | { ok: false; message: string }

/**
 * %RPCS3_AUTO%: the argument RPCS3 boots for a PS3 ROM, so one command covers ES-DE's three RPCS3 commands.
 * - a folder (a disc game `Game.ps3\PS3_GAME\USRDIR\EBOOT.BIN`, a PSN game `USRDIR\EBOOT.BIN`): the folder;
 * - a `.ps3` file of at most 4 KB (ES-DE's Game Serial layout, also `Game.ps3\Game.ps3`) holding a serial
 *   such as NPUB30024: `%RPCS3_GAMEID%:NPUB30024`, which RPCS3 itself understands (a game installed inside it);
 *   any other content is an error, as RPCS3 cannot boot a small text file;
 * - a `.lnk` (ES-DE's old Shortcut layout: a shortcut made by RPCS3's "Create Shortcut"): the serial in its
 *   arguments (`%RPCS3_GAMEID%:NPUB30024`), else the game folder or boot file it points at (its target, or a path in
 *   its arguments when the target is rpcs3.exe itself), handled like that folder or file; anything else is an error;
 * - any other file (an .iso, an EBOOT.BIN, a .self or .elf, a large .ps3): the file.
 */
export async function rpcs3Target(
  launchPath: string,
  isDirectory: boolean,
  readShortcut: ReadShortcut = readShortcutWithElectron
): Promise<Rpcs3Target> {
  if (isDirectory) {
    const disc = await isFile(join(launchPath, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'))
    const psn = !disc && (await isFile(join(launchPath, 'USRDIR', 'EBOOT.BIN')))
    const reason = disc ? 'disc game folder' : psn ? 'PSN game folder' : 'game folder'
    return { ok: true, value: launchPath, reason }
  }
  if (extname(launchPath).toLowerCase() === '.lnk')
    return rpcs3ShortcutTarget(launchPath, readShortcut)
  const stat = await statSafe(launchPath)
  if (extname(launchPath).toLowerCase() === '.ps3' && stat && stat.size <= MAX_INJECT_BYTES) {
    let text = ''
    try {
      text = await fs.readFile(launchPath, 'utf8')
    } catch {
      // Unreadable: reported below like an empty file.
    }
    const serial = text.replace(/^\uFEFF/, '').trim()
    if (!PS3_SERIAL.test(serial)) {
      return {
        ok: false,
        message: tMain('mainEmulation.launch.noPs3Serial', { file: basename(launchPath) })
      }
    }
    return { ok: true, value: `%RPCS3_GAMEID%:${serial.toUpperCase()}`, reason: 'serial file' }
  }
  const ext = extname(launchPath).toLowerCase()
  return { ok: true, value: launchPath, reason: ext === '.iso' ? 'disc image' : 'game file' }
}

/** `%RPCS3_GAMEID%:<serial>` in a shortcut's arguments (RPCS3's "Create Shortcut" writes it). */
const RPCS3_GAMEID_ARG = /%RPCS3_GAMEID%:([A-Z]{4}\d{5})(?!\d)/i
/** Files RPCS3 boots directly. */
const RPCS3_BOOT_FILE = /(^eboot\.bin|\.iso|\.self|\.elf)$/i

/** %RPCS3_AUTO% for a .lnk ROM: see rpcs3Target. */
async function rpcs3ShortcutTarget(
  launchPath: string,
  readShortcut: ReadShortcut
): Promise<Rpcs3Target> {
  const notAGame: Rpcs3Target = {
    ok: false,
    message: tMain('mainEmulation.launch.notRpcs3Shortcut', { file: basename(launchPath) })
  }
  let link: ShortcutLink
  try {
    link = await readShortcut(launchPath)
  } catch {
    return notAGame
  }
  const args = link.args ?? ''
  const serial = args.match(RPCS3_GAMEID_ARG)
  if (serial) {
    return {
      ok: true,
      value: `%RPCS3_GAMEID%:${serial[1].toUpperCase()}`,
      reason: 'shortcut with a serial'
    }
  }
  // The shortcut's own target, or (when it starts rpcs3.exe) the paths in its arguments.
  const candidates = link.target ? [link.target] : []
  if (link.target && basename(link.target).toLowerCase() === 'rpcs3.exe')
    candidates.push(...tokenize(args).filter((word) => word && !word.startsWith('-')))
  const base = link.cwd || dirname(launchPath)
  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? normalize(candidate) : resolve(base, candidate)
    const stat = await statSafe(full)
    if (!stat) continue
    const folder = stat.isDirectory()
    if (!folder && !(stat.isFile() && RPCS3_BOOT_FILE.test(basename(full)))) continue
    const inner = await rpcs3Target(full, folder, readShortcut)
    if (inner.ok) return { ...inner, reason: `shortcut to a ${inner.reason}` }
  }
  return notAGame
}

/**
 * Read an ES-DE %INJECT% file (`spec` with its placeholders expanded; `%ROM%` gave the ROM itself): relative names
 * are relative to the ROM's folder, and the file is used only when it is 1..4096 bytes. Lines are joined without
 * separators, as ES-DE does.
 */
async function readInjectFile(spec: string, gameDir: string, log: Logger): Promise<string> {
  const file = isAbsolute(spec) ? spec : resolve(gameDir, spec)
  const stat = await statSafe(file)
  if (!stat?.isFile()) {
    log.debug(`inject file not present: ${file}`)
    return ''
  }
  if (stat.size === 0 || stat.size > MAX_INJECT_BYTES) {
    if (stat.size > MAX_INJECT_BYTES)
      log.warn(`inject file ignored (larger than ${MAX_INJECT_BYTES} bytes): ${file}`)
    return ''
  }
  const text = await fs.readFile(file, 'utf8')
  return text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .join('')
}
