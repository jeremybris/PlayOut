import type {
  EmulatorStatus,
  Game,
  GameMetadata,
  LaunchError,
  MediaKind,
  Platform,
  ScannedGame,
  SystemDefinition,
  SystemInfo
} from '../../shared/types'
import type { Logger } from '../logger'
import type { ScanContext } from '../providers/types'
import type { SettingsStore } from '../store/settings-store'

export interface ResolvedLaunch {
  ok: true
  file: string
  /**
   * Argv for the launcher (Node quotes each entry). For %ESCAPESPECIALS% commands (`cmd.exe /C %ROM%`) the ROM
   * argument is already caret-escaped for cmd.exe, as ES-DE does; it still needs no other quoting.
   */
  args: string[]
  cwd?: string
  /** %RUNINBACKGROUND%: do not minimize PlayOut / do not wait for a window. */
  runInBackground: boolean
  /** %HIDEWINDOW%: spawn with windowsHide. */
  hideWindow: boolean
  /** The find-rules id of the emulator started (%EMULATOR_X%), when the command names one. */
  emulatorId?: string
}

export type LaunchResolution = ResolvedLaunch | { ok: false; error: LaunchError }

export interface EsdeImportUpdate {
  gameId: string
  title?: string
  metadata: Partial<GameMetadata>
  /** Absolute paths of ES-DE media files to copy into the cache. */
  localMedia: Partial<Record<Exclude<MediaKind, 'screenshot'>, string>>
  /** Play state from the gamelist entry (only set when the entry carries it). */
  favorite?: boolean
  hidden?: boolean
  playCount?: number
  playtimeMinutes?: number
  /** ISO 8601 timestamp. */
  lastPlayed?: string
  /** EmulatorCommand id matching the entry's <altemulator> label, when the system has such a command. */
  emulatorId?: string
}

export interface EmulationService {
  /** All system definitions from resources/systems/systems.json. */
  systems(): SystemDefinition[]
  findSystem(id: string): SystemDefinition | undefined
  /** Match a ROM-root subfolder name to a system (id or alias, case-insensitive). */
  findSystemForFolder(folderName: string): SystemDefinition | undefined
  /** Systems with game counts and resolved emulators, for the Settings UI. */
  systemInfos(gameCounts: Record<string, number>): Promise<SystemInfo[]>
  /** Platform rows for the given system ids (kind 'system', manufacturer icon). */
  platformsForSystems(systemIds: string[]): Platform[]
  /** Resolve every emulator referenced by the systems through find-rules and user overrides. */
  emulators(): Promise<EmulatorStatus[]>
  /** Walk the ROM root and return one ScannedGame per ROM plus the subfolders that matched no system. */
  scanRoms(ctx: ScanContext): Promise<{ games: ScannedGame[]; unknownFolders: string[] }>
  /** Expand the system's command template for this game into a spawnable command. */
  resolveLaunch(game: Game, emulatorId?: string): Promise<LaunchResolution>
  /**
   * Read an existing ES-DE installation's gamelists and downloaded media for the given ROM games.
   * `preferredEmulators` maps system id -> EmulatorCommand id for each gamelist's system-wide <alternativeEmulator>
   * label; the caller applies it to settings.emulators.preferred where the user has not chosen a command.
   */
  importEsde(games: Game[]): Promise<{
    updates: EsdeImportUpdate[]
    esdeHome: string | null
    preferredEmulators: Record<string, string>
  }>
}

export interface EmulationDeps {
  settings: SettingsStore
  resourcesDir: string
  log: Logger
}
