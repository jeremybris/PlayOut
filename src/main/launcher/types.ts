import type { ChildProcess } from 'child_process'
import type { Game, LaunchResult } from '../../shared/types'
import type { EmulationService } from '../emulation/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import type { LibraryService } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import type { ProcessInfo } from './process-monitor'

/** The subset of the main window the launcher needs. */
export interface WindowController {
  minimize(): void
  restore(): void
  isMinimized(): boolean
  /** PlayOut is the foreground window (absent: unknown; an emulator launch then minimizes at once). */
  isFocused?(): boolean
  focus(): void
  /** Shown (also when minimized); false when closed to the tray. */
  isVisible(): boolean
}

export interface LauncherDeps {
  settings: SettingsStore
  emulation: EmulationService
  library: LibraryService
  events: EventBus
  window: WindowController
  log: Logger
  /** Before an emulator game is spawned (see GameLauncherDeps.beforeLaunch). */
  beforeLaunch?(
    emulatorId: string,
    exe: string,
    rom?: string,
    context?: { endedMsAgo?: number; pid?: number }
  ): Promise<void>
  /** Why the game must not start now, else null (see GameLauncherDeps.launchBlocked). */
  launchBlocked?(game: Game): string | null
}

export interface RunningGame {
  gameId: string
  startedAt: string
  /** The spawned process, for games PlayOut started itself ('spawned' tracking). */
  pid?: number
}

export interface LauncherService {
  /** Start the game, begin a session, and track it according to game.tracking. */
  launch(game: Game, options?: { emulatorId?: string }): Promise<LaunchResult>
  running(): RunningGame | null
  /**
   * Track a game started some other way (Co-Op: the helper process runs the instances and lives as long as the
   * session): the running session ends first, the new one ends when `child` exits. `handoffDir` also counts the
   * processes under that folder as the game (PeerParty: an Xbox app game is started by Windows, not by `child`).
   */
  track(game: Game, child: ChildProcess, options?: { handoffDir?: string; reason?: string }): void
  /**
   * Close the game of the running session (a streamed game whose viewer left): `taskkill /T /F` on every process
   * the session counts as the game, then end the session once none is left. Resolves true when no session of
   * `gameId` remains (also when none was running), false when processes survived (an elevated game a standard
   * user cannot close): that session keeps being tracked and ends when the game exits.
   */
  stop(gameId: string): Promise<boolean>
  /**
   * The live processes the running session counts as the game (the spawned tree, or the processes matched by image
   * name or install folder); empty without a session. Dynamic TDP measures their frame rate.
   */
  gameProcesses?(): Promise<{ pid: number; name: string }[]>
  /**
   * Every running process, from the process monitor's warm worker (a list younger than 2 s is reused). The memory
   * cleanup decides from it what it may trim.
   */
  processes?(): Promise<ProcessInfo[]>
  /** Stop polling and close any open session (used on app quit). */
  dispose(): void
}
