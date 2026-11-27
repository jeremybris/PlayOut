import type { EmulatorCommand, Game, SystemDefinition } from './types'

/**
 * The system's command named by `name`: its id or label, or an id or label it replaced (`aliases`, e.g. the three
 * RPCS3 commands PlayOut merged into one). Exact matches only; undefined when nothing matches.
 */
export function findEmulatorCommand(
  system: Pick<SystemDefinition, 'emulators'>,
  name: string | undefined
): EmulatorCommand | undefined {
  if (!name) return undefined
  return (
    system.emulators.find((e) => e.id === name) ??
    system.emulators.find((e) => e.label === name) ??
    system.emulators.find((e) => e.aliases?.includes(name))
  )
}

/** Where effectiveEmulatorCommand found its command (for logs). */
export type EmulatorChoiceOrigin = 'request' | 'game' | 'scan' | 'preferred'

/**
 * The command a launch of `game` runs: the explicitly requested emulator, then the game's own choice
 * (game.user.emulatorId), then the scan's choice for the ROM (launch.emulatorId), then the preferred emulator for the
 * system (settings.emulators.preferred), then the system's default (first) command; for the last two an archived ROM
 * the command's emulator cannot open runs RetroArch instead (forArchive). Each name goes through
 * findEmulatorCommand; one that names no command is skipped (reported through `onUnknown`). Shared by the launch
 * (selectCommand) and the game menus, so what the menus show is what runs.
 */
export function effectiveEmulatorCommand(
  system: Pick<SystemDefinition, 'id' | 'emulators'>,
  game: Pick<Game, 'user' | 'launch'>,
  preferred: Record<string, string> | undefined,
  options: {
    requested?: string
    onUnknown?: (name: string, origin: EmulatorChoiceOrigin) => void
  } = {}
): EmulatorCommand | undefined {
  const { requested, onUnknown } = options
  const choices: Array<[string | null | undefined, EmulatorChoiceOrigin]> = [
    [requested, 'request'],
    [game.user.emulatorId, 'game'],
    [game.launch.kind === 'emulator' ? game.launch.emulatorId : undefined, 'scan'],
    [preferred?.[system.id], 'preferred']
  ]
  for (const [name, origin] of choices) {
    if (!name) continue
    const found = findEmulatorCommand(system, name)
    if (found) return origin === 'preferred' ? forArchive(system, game, found) : found
    onUnknown?.(name, origin)
  }
  const fallback = system.emulators[0]
  return fallback && forArchive(system, game, fallback)
}

/**
 * A system-wide command (the default, or the system's choice in Settings) whose emulator cannot open a .zip / .7z
 * (DuckStation, Dolphin, Azahar, PPSSPP: `noArchives`) gives an archived ROM to the system's first RetroArch command,
 * which unpacks it. A choice made for the game itself or for this launch is never replaced.
 */
function forArchive(
  system: Pick<SystemDefinition, 'emulators'>,
  game: Pick<Game, 'launch'>,
  command: EmulatorCommand
): EmulatorCommand {
  if (!command.noArchives || game.launch.kind !== 'emulator') return command
  if (!isArchiveRom(game.launch.romPath)) return command
  return system.emulators.find((e) => e.command.includes('%EMULATOR_RETROARCH%')) ?? command
}

/** A ROM file inside a .zip or .7z archive (what RetroArch unpacks and most standalone emulators cannot open). */
export function isArchiveRom(romPath: string): boolean {
  return /\.(?:zip|7z)$/i.test(romPath)
}
