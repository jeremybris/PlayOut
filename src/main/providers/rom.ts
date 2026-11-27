import type { Platform } from '../../shared/types'
import type { EmulationService } from '../emulation/types'
import type { Logger } from '../logger'
import { isDirectory } from '../util/fs'
import type { RomProvider } from './types'
import { tMain } from '../i18n'

/** Thin provider over the emulation service's ROM scanner. */
export function createRomProvider(deps: { emulation: EmulationService; log: Logger }): RomProvider {
  let unknownFolders: string[] = []
  let platforms: Platform[] = []
  return {
    id: 'rom',
    name: 'ROMs',
    platforms: () => platforms,
    async detectClient() {
      return { installed: true }
    },
    async scanInstalled(ctx) {
      if (!ctx.settings.library.romsRoot) {
        unknownFolders = []
        platforms = []
        return []
      }
      // A ROM folder that is not there (a drive not yet connected, a network share offline) fails the scan rather
      // than reporting no games: an empty result would take every ROM out of the library.
      const romsRoot = ctx.settings.library.romsRoot
      if (!(await isDirectory(romsRoot)))
        throw new Error(tMain('mainApp.scan.romFolderMissing', { folder: romsRoot }))
      const result = await deps.emulation.scanRoms(ctx)
      unknownFolders = result.unknownFolders
      const systemIds = [...new Set(result.games.map((g) => g.platformId))]
      platforms = deps.emulation.platformsForSystems(systemIds)
      return result.games
    },
    lastUnknownFolders: () => unknownFolders
  }
}
