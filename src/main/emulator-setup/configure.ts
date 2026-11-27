import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { link, mergeFolderInto } from './junction'
import { setIniValues, setMameIni, setRetroArchCfg, setTomlValues, setYamlTopLevel } from './ini'
import type { ConfigureContext, Logger } from './types'
import {
  ensurePs3Hdd,
  markPs3HddInUse,
  movePs3HddToUpdates,
  oldPs3HddDir,
  ps3Dev0Dir,
  type Ps3HddMove
} from '../emulation/ps3-hdd'
import { tMain } from '../i18n'

/**
 * Points each emulator PlayOut installs at the data Emulation folder D (docs/emulator-setup.md, "Configure"). Only
 * folder settings are written; every other setting stays at the emulator's default. Where a partial config would lose
 * defaults, the emulator's own folders are made junctions into D instead.
 *
 * Every configurator is idempotent: running it again (also after D changed) re-points the junctions and rewrites the
 * path keys, and touches nothing else. Folder names follow the EmuDeck layout of emulation-folders.ts
 * (saves/melonds, storage/melonDS, ...).
 */

type Configurator = (ctx: ConfigureContext) => Promise<void>

/**
 * Per emulator, raised when its configurator changes what it writes: an emulator configured by an older PlayOut is
 * configured again at the next startup (SetupManifest.configured), and only that one, so the folder settings users
 * changed in the other emulators stay as they are. Missing: 1.
 * - RPCS3 2: dev_hdd0 moved to roms\PS3 HDD (0.1.109).
 * - RPCS3 3: the PS3 HDD moved to Updates and DLC\PS3 (0.1.120).
 */
export const CONFIGURE_VERSIONS: Readonly<Record<string, number>> = { RPCS3: 3 }

/** The current configure version of the emulator `id` (CONFIGURE_VERSIONS). */
export function configureVersionOf(id: string): number {
  return CONFIGURE_VERSIONS[id] ?? 1
}

/** Forward-slash form of a path (RPCS3, PPSSPP and melonDS want it). */
const fwd = (p: string): string => p.replace(/\\/g, '/')

async function mkdirs(...dirs: string[]): Promise<void> {
  for (const d of dirs) await fs.mkdir(d, { recursive: true })
}

/** Creates an empty marker file (portable.txt, portable.ini) when it is missing. */
async function touch(file: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  try {
    await fs.writeFile(file, '', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Makes each `E\<link>` (or absolute link) a junction to its target. */
async function links(ctx: ConfigureContext, pairs: [string, string][]): Promise<void> {
  for (const [linkPath, target] of pairs) await link(linkPath, target, ctx.log)
}

const CONFIGURATORS: Record<string, Configurator> = {
  DUCKSTATION: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    await links(ctx, [
      [join(E, 'bios'), join(D, 'bios')],
      [join(E, 'memcards'), join(D, 'saves', 'duckstation', 'saves')],
      [join(E, 'savestates'), join(D, 'saves', 'duckstation', 'states')],
      [join(E, 'textures'), join(D, 'texturepacks', 'duckstation')]
    ])
    await touch(join(E, 'portable.txt'))
  },

  PCSX2: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    await links(ctx, [
      [join(E, 'bios'), join(D, 'bios')],
      [join(E, 'memcards'), join(D, 'saves', 'pcsx2', 'saves')],
      [join(E, 'sstates'), join(D, 'saves', 'pcsx2', 'states')],
      [join(E, 'textures'), join(D, 'texturepacks', 'pcsx2')]
    ])
    await touch(join(E, 'portable.txt'))
  },

  RPCS3: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const games = join(D, 'roms', 'ps3')
    // The PS3 HDD where PlayOut kept it before 0.1.120 (roms\PS3 HDD) moves to Updates and DLC\PS3 first. This is the
    // only place it moves: here RPCS3 is not running (configure waits for that) and vfs.yml is repointed right after.
    // What could not be moved yet stays in the old folder and this configure fails at the end (after pointing RPCS3
    // at the new place), so it runs again at the next start and moves the rest. When the new place's drive has no
    // room for it, nothing moves and RPCS3 keeps the old folder until there is.
    const move = await movePs3HddToUpdates(D, ctx.log).catch((err): Ps3HddMove => ({
      outcome: 'failed',
      message: (err as Error).message
    }))
    // Nothing moved (no room, or the move failed before it began, with the old dev_hdd0 still there): RPCS3 keeps it.
    const inOld =
      move.outcome === 'no-space' ||
      (move.outcome === 'failed' && (await exists(join(oldPs3HddDir(D), 'dev_hdd0'))))
    const hdd0 = inOld ? join(oldPs3HddDir(D), 'dev_hdd0') : ps3Dev0Dir(D)
    const user = join(hdd0, 'home', '00000001')
    try {
      await ensurePs3Hdd(D)
      await mkdirs(games, user)
      // A dev_hdd0 at RPCS3's default place (a preconfigured folder from Google Drive may bring one), or at PlayOut's
      // earlier one (storage\rpcs3\dev_hdd0), moves into the PS3 HDD before vfs.yml stops pointing at it, so none of
      // its data is lost.
      await mergeFolderInto(join(D, 'storage', 'rpcs3', 'dev_hdd0'), hdd0, ctx.log, 'RPCS3')
      await mergeFolderInto(join(E, 'dev_hdd0'), hdd0, ctx.log, 'RPCS3')
    } finally {
      // Whatever failed above, RPCS3 is pointed at the PS3 HDD that now holds its files.
      await setYamlTopLevel(join(E, 'config', 'vfs.yml'), {
        '/dev_hdd0/': `${fwd(hdd0)}/`,
        '/games/': `${fwd(games)}/`
      })
      if (!inOld) await markPs3HddInUse(D)
    }
    await links(ctx, [
      [join(user, 'savedata'), join(D, 'saves', 'rpcs3', 'saves')],
      [join(user, 'trophy'), join(D, 'saves', 'rpcs3', 'trophy')],
      [join(E, 'savestates'), join(D, 'saves', 'rpcs3', 'states')]
    ])
    // Not finished: configure is not recorded as done, so it runs again at the next start (when RPCS3 is closed).
    if (move.outcome === 'partial' || move.outcome === 'no-space' || move.outcome === 'failed')
      throw new Error(tMain('mainEmulatorSetup.hdd.notMoved', { error: move.message ?? '' }))
  },

  DOLPHIN: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const gc = join(D, 'roms', 'gc')
    const wii = join(D, 'roms', 'wii')
    await mkdirs(gc, wii)
    await links(ctx, [
      [join(E, 'User', 'GC'), join(D, 'saves', 'dolphin', 'GC')],
      [join(E, 'User', 'Wii'), join(D, 'saves', 'dolphin', 'Wii')],
      [join(E, 'User', 'StateSaves'), join(D, 'saves', 'dolphin', 'states')],
      [join(E, 'User', 'Load', 'Textures'), join(D, 'texturepacks', 'dolphin')]
    ])
    await touch(join(E, 'portable.txt'))
    await setIniValues(
      join(E, 'User', 'Config', 'Dolphin.ini'),
      'General',
      { ISOPaths: '2', ISOPath0: gc, ISOPath1: wii, RecursiveISOPaths: 'True' },
      { style: 'spaced' }
    )
  },

  PPSSPP: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const psp = join(D, 'roms', 'psp')
    const pspDir = join(E, 'memstick', 'PSP')
    await mkdirs(psp)
    await setIniValues(
      join(pspDir, 'SYSTEM', 'ppsspp.ini'),
      'General',
      { CurrentDirectory: fwd(psp) },
      { style: 'spaced' }
    )
    await links(ctx, [
      [join(pspDir, 'SAVEDATA'), join(D, 'saves', 'ppsspp', 'saves')],
      [join(pspDir, 'PPSSPP_STATE'), join(D, 'saves', 'ppsspp', 'states')],
      [join(pspDir, 'TEXTURES'), join(D, 'texturepacks', 'ppsspp')]
    ])
  },

  FLYCAST: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const bios = join(D, 'bios')
    const saves = join(D, 'saves', 'flycast', 'saves')
    const states = join(D, 'saves', 'flycast', 'states')
    const textures = join(D, 'texturepacks', 'flycast')
    await mkdirs(bios, join(bios, 'dc'), saves, states, textures)
    await setIniValues(
      join(E, 'emu.cfg'),
      'config',
      {
        'Dreamcast.BiosPath': `${bios};${join(bios, 'dc')}`,
        'Dreamcast.VMUPath': saves,
        'Dreamcast.SavePath': saves,
        'Dreamcast.SavestatePath': states,
        'Dreamcast.TexturePath': textures
      },
      { style: 'spaced' }
    )
  },

  AZAHAR: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const user = join(E, 'user')
    await mkdirs(user)
    await links(ctx, [
      [join(user, 'sysdata'), join(D, 'bios', 'azahar', 'keys')],
      [join(user, 'sdmc'), join(D, 'saves', 'azahar', 'saves')],
      [join(user, 'states'), join(D, 'saves', 'azahar', 'states')],
      [join(user, 'load'), join(D, 'texturepacks', 'azahar')]
    ])
  },

  MELONDS: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const saves = join(D, 'saves', 'melonds', 'saves')
    const states = join(D, 'saves', 'melonds', 'states')
    const cheats = join(D, 'storage', 'melonDS', 'cheats')
    const bios = join(D, 'bios')
    await mkdirs(saves, states, cheats, bios)
    const toml = join(E, 'melonDS.toml')
    const b = (name: string): string => fwd(join(bios, name))
    await setTomlValues(toml, 'Instance0', {
      SaveFilePath: fwd(saves),
      SavestatePath: fwd(states),
      CheatFilePath: fwd(cheats)
    })
    await setTomlValues(toml, 'DS', {
      BIOS9Path: b('bios9.bin'),
      BIOS7Path: b('bios7.bin'),
      FirmwarePath: b('firmware.bin')
    })
    await setTomlValues(toml, 'DSi', {
      BIOS9Path: b('dsi_bios9.bin'),
      BIOS7Path: b('dsi_bios7.bin'),
      FirmwarePath: b('dsi_firmware.bin'),
      NANDPath: b('dsi_nand.bin')
    })
  },

  MGBA: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const values = {
      savegamePath: join(D, 'saves', 'mgba', 'saves'),
      savestatePath: join(D, 'saves', 'mgba', 'states'),
      cheatsPath: join(D, 'storage', 'mgba', 'cheats'),
      patchPath: join(D, 'storage', 'mgba', 'patches')
    }
    await mkdirs(...Object.values(values))
    await touch(join(E, 'portable.ini'))
    await setIniValues(join(E, 'config.ini'), 'ports.qt', values, { style: 'tight' })
  },

  RYUJINX: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const portable = join(E, 'portable')
    // A real folder: the BIOS sync copies prod.keys / title.keys into it.
    await mkdirs(join(portable, 'system'))
    await links(ctx, [
      [join(portable, 'bis', 'user', 'save'), join(D, 'saves', 'ryujinx', 'saves')],
      [join(portable, 'bis', 'system', 'save'), join(D, 'saves', 'ryujinx', 'system_saves')],
      [join(portable, 'bis', 'user', 'saveMeta'), join(D, 'saves', 'ryujinx', 'saveMeta')],
      [join(portable, 'mods'), join(D, 'texturepacks', 'ryujinx')]
    ])
  },

  M2EMULATOR: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const roms = join(D, 'roms', 'model2')
    // The emulator always scans its relative roms folder, so the junction finds the games whatever the path's
    // characters; Dir1 is only a second route.
    await links(ctx, [
      [join(E, 'roms'), roms],
      [join(E, 'NVDATA'), join(D, 'saves', 'model2', 'saves')],
      [join(E, 'STATES'), join(D, 'saves', 'model2', 'states')]
    ])
    // EMULATOR.EXE (2014, 32-bit ANSI) reads EMULATOR.INI in the ANSI code page: a UTF-8 non-ASCII path ('José')
    // would be garbled, so Dir1 is only written for a pure ASCII path. Every other line of the shipped file (a
    // commented ';Dir1=' example included) is kept, byte for byte ('latin1': the file is ANSI, not UTF-8).
    if (/^[\x20-\x7e]*$/.test(roms)) {
      await setIniValues(
        join(E, 'EMULATOR.INI'),
        'RomDirs',
        { Dir1: roms },
        { style: 'tight', encoding: 'latin1' }
      )
    } else {
      ctx.log.info(
        `Model 2: ${roms} is not pure ASCII; leaving [RomDirs] Dir1 as it is (the roms junction finds the games)`
      )
    }
  },

  SCUMMVM: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const saves = join(D, 'saves', 'scummvm', 'saves')
    const bios = join(D, 'bios')
    await mkdirs(saves, bios)
    await setIniValues(
      join(E, 'scummvm.ini'),
      'scummvm',
      { savepath: saves, extrapath: bios },
      { style: 'tight' }
    )
  },

  MAME: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const ini = join(E, 'mame.ini')
    if (!(await exists(ini))) {
      try {
        const r = await ctx.run(join(E, 'mame.exe'), ['-createconfig'], {
          cwd: E,
          timeoutMs: 60_000
        })
        if (r.code !== 0)
          ctx.log.warn(`mame -createconfig exited with ${r.code}; writing a new mame.ini`)
      } catch (err) {
        ctx.log.warn('mame -createconfig failed; writing a new mame.ini', err)
      }
    }
    const p = (...parts: string[]): string => join(D, ...parts)
    await mkdirs(
      p('roms', 'arcade'),
      p('roms', 'mame'),
      p('bios', 'mame'),
      p('storage', 'mame', 'samples'),
      p('storage', 'mame', 'artwork'),
      p('storage', 'mame', 'ctrlr'),
      p('storage', 'mame', 'cheat'),
      p('storage', 'mame', 'ini'),
      p('saves', 'mame', 'saves'),
      p('saves', 'mame', 'states')
    )
    await setMameIni(ini, {
      rompath: [p('roms', 'arcade'), p('roms', 'mame'), p('bios'), p('bios', 'mame'), 'roms'].join(
        ';'
      ),
      samplepath: `${p('storage', 'mame', 'samples')};samples`,
      artpath: `${p('storage', 'mame', 'artwork')};artwork`,
      ctrlrpath: `${p('storage', 'mame', 'ctrlr')};ctrlr`,
      cheatpath: `${p('storage', 'mame', 'cheat')};cheat`,
      inipath: `.;${p('storage', 'mame', 'ini')};ini;ini\\presets`,
      nvram_directory: p('saves', 'mame', 'saves'),
      state_directory: p('saves', 'mame', 'states')
    })
    // 125 MB of debug symbols nobody needs.
    await fs.rm(join(E, 'mame.sym'), { force: true })
  },

  RETROARCH: async (ctx) => {
    const { emuDir: E, dataDir: D } = ctx
    const values = {
      system_directory: join(D, 'bios'),
      savefile_directory: join(D, 'saves', 'retroarch', 'saves'),
      savestate_directory: join(D, 'saves', 'retroarch', 'states'),
      rgui_browser_directory: join(D, 'roms')
    }
    await mkdirs(...Object.values(values))
    await setRetroArchCfg(join(E, 'retroarch.cfg'), values)
  }
}

/** RPCS3's vfs.yml folder keys that default to a folder next to rpcs3.exe (dev_hdd0 and games are set by configure). */
const RPCS3_LOCAL_VFS_KEYS = [
  '/dev_flash/',
  '/dev_flash2/',
  '/dev_flash3/',
  '/dev_bdvd/',
  '/dev_hdd1/'
]

/**
 * For an RPCS3 folder copied from another PC (the preconfigured Google Drive copy): a vfs.yml folder key holding an
 * absolute path that does not exist here (the other PC's) is set back to RPCS3's default, $(EmulatorDir)<name>/, so
 * the firmware in dev_flash is found. Paths that exist, relative values and every other line are kept. No vfs.yml:
 * nothing to do.
 */
export async function localizeRpcs3Vfs(emuDir: string, log: Logger): Promise<void> {
  const file = join(emuDir, 'config', 'vfs.yml')
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return
  const values: Record<string, string> = {}
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const key = RPCS3_LOCAL_VFS_KEYS.find((k) => line.startsWith(`${k}:`))
    if (!key) continue
    let value = line.slice(key.length + 1).trim()
    if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
    else if (/^".*"$/.test(value)) value = value.slice(1, -1)
    if (!/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value) || (await exists(value))) continue
    values[key] = `$(EmulatorDir)${key.slice(1)}`
    log.info(`RPCS3: ${key} pointed at ${value}, which is not on this PC; using the default`)
  }
  if (Object.keys(values).length) await setYamlTopLevel(file, values)
}

/** The ids configureEmulator knows (every catalog emulator). */
export const CONFIGURABLE_IDS: readonly string[] = Object.keys(CONFIGURATORS)

/**
 * Points the emulator `id` (a catalog id) installed in `ctx.emuDir` at the data Emulation folder `ctx.dataDir`:
 * portable marker, folder keys and junctions as listed in docs/emulator-setup.md. Idempotent; throws for an unknown id
 * or when a junction cannot be made (e.g. a file is in the way).
 */
export async function configureEmulator(id: string, ctx: ConfigureContext): Promise<void> {
  const configure = CONFIGURATORS[id]
  if (!configure) throw new Error(`No configuration for emulator ${id}`)
  await fs.mkdir(ctx.dataDir, { recursive: true })
  await configure(ctx)
  ctx.log.info(`Configured ${id} for ${ctx.dataDir}`)
}

/**
 * Model 2 Emulator is given a romset name only (`EMULATOR.EXE daytona`) and looks for `<name>.zip` in its roms
 * folder and the [RomDirs] folders, never below them. A game in a sub-folder (`roms\model2\Favorites 1\daytona.zip`)
 * is found through Dir2, which PlayOut points at the game's folder before each launch (Dir1 stays the model2 root).
 * Same ANSI rule as the configure step: a non-ASCII folder cannot be written, so the game must sit at the top level.
 */
export async function addModel2RomDir(
  emuDir: string,
  gameDir: string,
  log: { info(message: string): void; warn(message: string): void }
): Promise<void> {
  if (!/^[\x20-\x7e]*$/.test(gameDir)) {
    log.warn(
      `Model 2: ${gameDir} is not pure ASCII; the emulator only finds games directly in roms\\model2`
    )
    return
  }
  // Merged into the shipped file only, never created: a stub would replace the emulator's whole configuration.
  const ini = join(emuDir, 'EMULATOR.INI')
  if (!(await exists(ini))) {
    log.info(`Model 2: ${ini} is missing; not adding the game's folder`)
    return
  }
  await setIniValues(ini, 'RomDirs', { Dir2: gameDir }, { style: 'tight', encoding: 'latin1' })
}
