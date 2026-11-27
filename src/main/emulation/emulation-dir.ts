import { stat } from 'fs/promises'
import { mkdir } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { RECOMP_SAVES_FOLDER } from '../../shared/recomp'
import { PC_SAVES_FOLDER } from '../../shared/pc-saves'
import type { Settings, SettingsPatch } from '../../shared/types'
import type { Logger } from '../logger'
import { ADDED_ROM_SYSTEMS } from './emulation-folders'
import { comparable } from './emulation-location'
import { generateFolders, generateFoldersAt, type GeneratedFolders } from './generated-folders'
import { ensurePs3Hdd } from './ps3-hdd'

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The Emulation folder of a settings file that names none: in PlayOut's data folder, where older PlayOut versions made
 * it. Kept for those installs (never moved silently); a new install names Documents\Emulation instead (index.ts), and
 * the Emulation folder may not be put in the data folder any more (emulation-location.ts).
 */
export function defaultEmulationDir(userData: string): string {
  return join(userData, 'Emulation')
}

/** The Emulation folder in use: the one the user chose, else PlayOut's own. */
export function emulationDirOf(settings: Pick<Settings, 'library'>, userData: string): string {
  return settings.library.emulationDir ?? defaultEmulationDir(userData)
}

/** The ROM folder: always the roms folder of the Emulation folder in use (there is no separate ROM folder setting). */
export function romsRootOf(settings: Pick<Settings, 'library'>, userData: string): string {
  return join(emulationDirOf(settings, userData), 'roms')
}

export interface RomsRootSyncDeps {
  settings: {
    get(): Settings
    update(patch: SettingsPatch): unknown
    onChange(listener: (settings: Settings) => void): () => void
  }
  userData: string
}

/**
 * A settings file from before the ROM folder followed the Emulation folder can name its own ROM folder. When no
 * Emulation folder is chosen and that folder is named roms (in any case, as an ES-DE or EmuDeck setup's is), the folder
 * holding it becomes the Emulation folder, so the ROMs stay where they are and keep their cards. Any other old ROM
 * folder is left to the scan: its ROMs that are still there keep their cards (romsKeptOutsideRoot in scan-service).
 * Run once, at startup, before the sync: later on a different ROM folder only means the Emulation folder just changed.
 * Returns the Emulation folder it chose, or null.
 */
export function adoptOldRomsFolder(deps: RomsRootSyncDeps): string | null {
  const settings = deps.settings.get()
  const old = settings.library.romsRoot
  if (!old || settings.library.emulationDir || old === romsRootOf(settings, deps.userData))
    return null
  if (basename(old).toLowerCase() !== 'roms') return null
  const emulationDir = dirname(old)
  deps.settings.update({ library: { emulationDir } })
  return emulationDir
}

/**
 * Keeps settings.library.romsRoot (which the scans, launches, streaming and the renderer read) equal to the Emulation
 * folder's roms folder: once now, and again whenever the settings change (a moved or chosen Emulation folder, or an old
 * settings file's own ROM folder). It only writes when the two differ, so its own update does not loop. Returns the
 * function that stops it.
 */
export function keepRomsRootInSync(deps: RomsRootSyncDeps): () => void {
  adoptOldRomsFolder(deps)
  const sync = (settings: Settings): void => {
    const want = romsRootOf(settings, deps.userData)
    if (settings.library.romsRoot !== want) deps.settings.update({ library: { romsRoot: want } })
  }
  sync(deps.settings.get())
  return deps.settings.onChange(sync)
}

export interface EnsureEmulationDirDeps {
  settings: { get(): Settings; update(patch: SettingsPatch): unknown }
  userData: string
  systemIds: readonly string[]
  log: Logger
  /**
   * The default Emulation folder (Documents\Emulation), made with every folder when it is the chosen one and missing
   * (a new install sets it: index.ts). Any other chosen folder that is missing is left alone (a drive not plugged in).
   */
  documentsDefault?: string
}

/**
 * Updates and DLC with its console folders (and the PS3 HDD's folders in it), made where missing. The PS3 HDD of an
 * older PlayOut (roms\PS3 HDD) is not moved here: RPCS3's configure moves it and repoints vfs.yml in one step, when
 * RPCS3 is not running (configure.ts); until then PlayOut keeps using the old one (activePs3HddDir).
 */
async function updatesAndDlc(dir: string, log: Logger): Promise<void> {
  await ensurePs3Hdd(dir).catch((err) =>
    log.warn(`Updates and DLC could not be made in ${dir}: ${(err as Error).message}`)
  )
}

/** The roms folders of systems PlayOut added later (roms\switch2, roms\ps5), made in an Emulation folder's roms folder. */
async function addedRomFolders(dir: string, log: Logger): Promise<void> {
  const roms = join(dir, 'roms')
  if (!(await isDirectory(roms))) return
  for (const id of ADDED_ROM_SYSTEMS)
    await mkdir(join(roms, id), { recursive: true }).catch((err) =>
      log.warn(`roms\\${id} could not be made in ${dir}: ${(err as Error).message}`)
    )
}

/**
 * At launch: PlayOut's own Emulation folder is made (or completed: only missing folders are created) while no other
 * is chosen (its roms folder is the ROM folder: keepRomsRootInSync). A chosen folder is left as it is, but for Updates and DLC, the Recompilations Saves folder and the roms folders of systems added later (switch2, ps5).
 */
export async function ensureDefaultEmulationDir(
  deps: EnsureEmulationDirDeps
): Promise<GeneratedFolders | null> {
  const chosen = deps.settings.get().library.emulationDir
  if (chosen && deps.documentsDefault && comparable(chosen) === comparable(deps.documentsDefault)) {
    if (!(await isDirectory(chosen)))
      try {
        const made = await generateFoldersAt('emulation', chosen, deps.systemIds)
        deps.log.info(`Emulation folder: ${made.created} folder(s) created in ${made.path}`)
      } catch (err) {
        deps.log.warn(`Emulation folder ${chosen} could not be made: ${(err as Error).message}`)
      }
  }
  if (chosen) {
    // A chosen folder keeps what it has; only Updates and DLC (with the PS3 HDD) and the Recompilations Saves and PC
    // Saves folders are added when they are missing.
    if (await isDirectory(chosen)) {
      await updatesAndDlc(chosen, deps.log)
      for (const folder of [RECOMP_SAVES_FOLDER, PC_SAVES_FOLDER])
        await mkdir(join(chosen, folder), { recursive: true }).catch((err) =>
          deps.log.warn(`${folder} could not be made in ${chosen}: ${(err as Error).message}`)
        )
      await addedRomFolders(chosen, deps.log)
    }
    return null
  }
  try {
    const made = await generateFolders('emulation', deps.userData, deps.systemIds)
    if (made.created)
      deps.log.info(`Emulation folder: ${made.created} folder(s) created in ${made.path}`)
    return made
  } catch (err) {
    deps.log.warn(`Emulation folder could not be made: ${(err as Error).message}`)
    return null
  }
}

/**
 * A new install (no settings file yet) names Documents\Emulation as its Emulation folder; ensureDefaultEmulationDir
 * makes it (or adopts the one a reinstall finds there, with its favourites file). An existing install keeps its folder:
 * it is never moved without the user. Returns whether the setting was made.
 */
export function setDocumentsOnFirstStart(deps: {
  firstStart: boolean
  settings: { get(): Settings; update(patch: SettingsPatch): unknown }
  documentsDefault: string
}): boolean {
  if (!deps.firstStart || deps.settings.get().library.emulationDir) return false
  deps.settings.update({ library: { emulationDir: deps.documentsDefault } })
  return true
}
