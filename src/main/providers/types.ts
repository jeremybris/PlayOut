import type { ClientInfo, Platform, ScannedGame, Settings, SourceId } from '../../shared/types'
import type { Logger } from '../logger'

export interface ScanContext {
  settings: Settings
  log: Logger
  /** Directory holding the bundled data files (resources/systems). */
  resourcesDir: string
  /** Report progress while scanning (count so far, optional message). */
  progress(found: number, message?: string): void
}

/**
 * A source of installed games. Providers are stateless with respect to the library: they only return what is
 * installed right now; `LibraryService.mergeScan` reconciles that with the stored games.
 */
export interface GameProvider {
  id: SourceId
  name: string
  /** Platform rows this provider populates (store providers: one; rom: the systems seen in the last scan; manual: PC). */
  platforms(): Platform[]
  /** Whether the store client is installed (and where). Manual/rom providers always report installed: true. */
  detectClient(): Promise<ClientInfo>
  /**
   * True when games can exist without the client (GOG offline installers): the scan runs even when
   * detectClient() reports installed: false.
   */
  scansWithoutClient?: boolean
  scanInstalled(ctx: ScanContext): Promise<ScannedGame[]>
  /**
   * Folders the last `scanInstalled` should have looked into and could not reach (a Steam library on an unplugged
   * drive). The scan says nothing about the games installed under them: the scan service keeps those as they are
   * instead of marking them not installed.
   */
  unreachableRoots?(): string[]
}

export interface ManualGameInput {
  exePath: string
  title?: string
  args?: string
  cwd?: string
}

export interface ManualProvider extends GameProvider {
  /** Build the ScannedGame for a user-chosen executable (does not touch the library). */
  addGame(input: ManualGameInput): Promise<ScannedGame>
  /** Find executables that look like games under a folder (Playnite-style heuristics). */
  scanFolder(folder: string): Promise<ScannedGame[]>
}

export interface RomProvider extends GameProvider {
  /** ROM-root subfolders that matched no known system in the last scan. */
  lastUnknownFolders(): string[]
}

export interface ProviderRegistry {
  all(): GameProvider[]
  get(id: SourceId): GameProvider | undefined
  manual: ManualProvider
  rom: RomProvider
}
