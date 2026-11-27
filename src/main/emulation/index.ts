import { app } from 'electron'
import { dirname, join } from 'path'
import type { EmulatorStatus, SystemInfo } from '../../shared/types'
import { specOf } from '../emulator-setup/catalog'
import { knownFolders } from '../util/paths'
import { importFromEsde } from './esde-import'
import { createEmulatorResolver, loadFindRules, type FindRulesPaths } from './find-rules'
import { bareCommandAvailable, resolveLaunchCommand } from './launch-command'
import { loadMameAssets, scanRomRoot } from './rom-scanner'
import { emulatorIdsInCommand, loadSystemCatalog } from './systems'
import type { EmulationDeps, EmulationService } from './types'
import { tMain } from '../i18n'

/** Where PlayOut itself lives: the real exe folder for the portable build, the install folder otherwise. */
export function resolvePaths(): FindRulesPaths {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath)
  let userDataDir: string
  try {
    userDataDir = app.getPath('userData')
  } catch {
    // Outside Electron (tests, scripts): Electron's default userData location.
    userDataDir = join(knownFolders().appData, 'PlayOut')
  }
  return { exeDir, userDataDir }
}

export interface EmulationServiceDeps extends EmulationDeps {
  /** The executable PlayOut installed for an emulator id (emulator setup), tried before the find rules. */
  managed?: (id: string) => string | null
}

/** The emulation service plus the emulator resolver's cache reset (after PlayOut installed emulators). */
export interface EmulationServiceWithCache extends EmulationService {
  invalidateEmulators(): void
}

/** Marks the emulators PlayOut can download and set up itself. */
function withInstallable(status: EmulatorStatus): EmulatorStatus {
  return specOf(status.id) ? { ...status, installable: true } : status
}

/**
 * The emulation subsystem: system definitions, emulator discovery, ROM scanning, launch command expansion and the
 * ES-DE importer. Throws at creation when the bundled data files are missing or malformed.
 */
export function createEmulationService(deps: EmulationServiceDeps): EmulationServiceWithCache {
  const { log } = deps
  const catalog = loadSystemCatalog(join(deps.resourcesDir, 'systems.json'))
  const rules = loadFindRules(join(deps.resourcesDir, 'find-rules.json'))
  const arcadeAssets = loadMameAssets(join(deps.resourcesDir, 'mame-assets.json'))
  const paths = resolvePaths()
  const getSettings = (): ReturnType<typeof deps.settings.get> => deps.settings.get()
  const resolver = createEmulatorResolver({ rules, paths, getSettings, log, managed: deps.managed })
  deps.settings.onChange(() => resolver.invalidate())
  log.info(
    `${catalog.systems.length} systems, ${rules.emulators.length} emulator rules, ${arcadeAssets.size} MAME BIOS/device sets; emulator folders: ${join(paths.exeDir, 'Emulators')}, ${join(paths.userDataDir, 'Emulators')}`
  )

  return {
    systems: () => catalog.systems,
    findSystem: (id) => catalog.findSystem(id),
    findSystemForFolder: (folderName) => catalog.findSystemForFolder(folderName),
    platformsForSystems: (systemIds) => catalog.platformsForSystems(systemIds),

    async systemInfos(gameCounts) {
      const statuses = await resolver.resolveAll()
      const available = new Set(statuses.filter((s) => s.path).map((s) => s.id))
      // A command is available when every emulator it references was found (its RetroArch core is checked at
      // launch time, where a missing core yields a precise error). One that references none runs its first word, a
      // program on PATH: available when resolveLaunchCommand would find it (looked up once per command text).
      const bare = new Map<string, boolean>()
      for (const system of catalog.systems)
        for (const { command } of system.emulators)
          if (!bare.has(command) && emulatorIdsInCommand(command).length === 0)
            bare.set(command, await bareCommandAvailable(command, paths.exeDir))
      return catalog.systems.map((system): SystemInfo => ({
        ...system,
        gameCount: gameCounts[system.id] ?? 0,
        availableEmulators: system.emulators
          .filter((command) => {
            const ids = emulatorIdsInCommand(command.command)
            return ids.length > 0
              ? ids.every((id) => available.has(id))
              : bare.get(command.command) === true
          })
          .map((command) => command.id)
      }))
    },

    emulators: async () => (await resolver.resolveAll()).map(withInstallable),

    invalidateEmulators: () => resolver.invalidate(),

    async scanRoms(ctx) {
      const romsRoot = ctx.settings.library.romsRoot
      if (!romsRoot) return { games: [], unknownFolders: [] }
      const result = await scanRomRoot({
        romsRoot,
        findSystemForFolder: (name) => catalog.findSystemForFolder(name),
        log: ctx.log,
        progress: ctx.progress,
        arcadeAssets
      })
      return { games: result.games, unknownFolders: result.unknownFolders }
    },

    async resolveLaunch(game, emulatorId) {
      const systemId = game.launch.kind === 'emulator' ? game.launch.systemId : game.platformId
      const system = catalog.findSystem(systemId)
      if (!system)
        return {
          ok: false,
          error: {
            kind: 'failed',
            message: tMain('mainEmulation.launch.unknownSystem', {
              system: systemId,
              title: game.title
            })
          }
        }
      return resolveLaunchCommand(game, system, emulatorId, {
        resolver,
        getSettings,
        exeDir: paths.exeDir,
        log
      })
    },

    importEsde(games) {
      const settings = getSettings()
      return importFromEsde({
        games,
        systems: catalog.systems,
        esdeHome: settings.library.esdeHome,
        romsRoot: settings.library.romsRoot,
        log
      })
    }
  }
}

export { loadFindRules, parseFindRules, createEmulatorResolver } from './find-rules'
export type { EmulatorResolver, FindRulesData, FindRulesPaths } from './find-rules'
export { resolveLaunchCommand, selectCommand, tokenize } from './launch-command'
export { loadMameAssets, parseMameAssets, scanRomRoot } from './rom-scanner'
export { loadSystemCatalog, parseSystemCatalog, createSystemCatalog } from './systems'
export type { SystemCatalog } from './systems'
export { importFromEsde, parseGamelist } from './esde-import'
export type {
  EmulationDeps,
  EmulationService,
  EsdeImportUpdate,
  LaunchResolution,
  ResolvedLaunch
} from './types'
