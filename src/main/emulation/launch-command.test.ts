import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}))

import { defaultSettings } from '../../shared/defaults'
import type { EmulatorStatus, Game, Settings, SystemDefinition } from '../../shared/types'
import type { Logger } from '../logger'
import type { CoreResolution, EmulatorResolver } from './find-rules'
import type { LaunchResolution } from './types'
import {
  escapeCmdSpecials,
  launchesWith,
  resolveLaunchCommand,
  selectCommand,
  tokenize,
  type LaunchCommandDeps,
  type ShortcutLink
} from './launch-command'
import { loadSystemCatalog } from './systems'

const SYSTEMS_FILE = resolve(__dirname, '../../../resources/systems/systems.json')

const warnings: string[] = []
const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...a) => warnings.push(a.join(' ')),
  error: () => undefined
}

let dir: string
let exeDir: string
let romsRoot: string
let retroarch: string
let coresDir: string
let dolphin: string
let settings: Settings

async function touch(file: string, content = 'x'): Promise<string> {
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

beforeEach(async () => {
  warnings.length = 0
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-launch-'))
  exeDir = join(dir, 'Play Out')
  romsRoot = join(dir, 'My ROMs')
  retroarch = await touch(join(dir, 'My Emulators', 'Retro Arch', 'retroarch.exe'))
  coresDir = join(dir, 'My Emulators', 'Retro Arch', 'cores')
  await touch(join(coresDir, 'snes9x_libretro.dll'))
  dolphin = await touch(join(dir, 'My Emulators', 'Dolphin x64', 'Dolphin.exe'))
  await fs.mkdir(exeDir, { recursive: true })
  settings = defaultSettings()
  settings.library.romsRoot = romsRoot
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const snes: SystemDefinition = {
  id: 'snes',
  name: 'Nintendo SNES',
  extensions: ['.sfc', '.smc', '.zip'],
  platformKey: 'snes',
  emulators: [
    {
      id: 'snes9x-current',
      label: 'Snes9x - Current',
      command: '%EMULATOR_RETROARCH% -L %CORE_RETROARCH%\\snes9x_libretro.dll %ROM%'
    },
    {
      id: 'mesen-s',
      label: 'Mesen-S',
      command: '%EMULATOR_RETROARCH% -L %CORE_RETROARCH%\\mesen-s_libretro.dll %ROM%'
    },
    { id: 'snes9x-standalone', label: 'Snes9x (Standalone)', command: '%EMULATOR_SNES9X% %ROM%' }
  ]
}

const ps4: SystemDefinition = {
  id: 'ps4',
  name: 'Sony PlayStation 4',
  extensions: ['.bin', '.lnk', '.ps4'],
  platformKey: 'ps4',
  dirExtensions: ['.ps4'],
  emulators: [
    {
      id: 'shadps4-shortcut-standalone',
      label: 'shadPS4 Shortcut (Standalone)',
      command: '%HIDEWINDOW% %ESCAPESPECIALS% %EMULATOR_OS-SHELL% /C %ROM%'
    },
    {
      id: 'shadps4-game-serial-standalone',
      label: 'shadPS4 Game Serial (Standalone)',
      command: '%STARTDIR%=%EMUDIR% %EMULATOR_SHADPS4% -g %INJECT%=%BASENAME%.ps4'
    },
    {
      id: 'shadps4-eboot-bin-standalone',
      label: 'shadPS4 eboot.bin (Standalone)',
      command: '%STARTDIR%=%EMUDIR% %EMULATOR_SHADPS4% %ROM%'
    },
    {
      id: 'shadps4-gui-eboot-bin-standalone',
      label: 'shadPS4 [GUI] eboot.bin (Standalone)',
      command: '%STARTDIR%=%EMUDIR% %EMULATOR_SHADPS4-GUI% -d -g %ROM%'
    }
  ]
}

const gc: SystemDefinition = {
  id: 'gc',
  name: 'Nintendo GameCube',
  extensions: ['.iso', '.rvz', '.m3u'],
  platformKey: 'gc',
  dirExtensions: ['.m3u'],
  emulators: [
    {
      id: 'dolphin-standalone',
      label: 'Dolphin (Standalone)',
      command: '%HIDEWINDOW% %STARTDIR%=%EMUDIR% %EMULATOR_DOLPHIN% -b -e %ROM%'
    }
  ]
}

/** PS3 as scripts/build-systems.mjs writes it: ES-DE's three RPCS3 commands merged into one. */
const ps3Merged: SystemDefinition = {
  id: 'ps3',
  name: 'Sony PlayStation 3',
  extensions: ['.iso', '.lnk', '.ps3', '.ps3dir'],
  platformKey: 'ps3',
  dirExtensions: ['.ps3', '.ps3dir'],
  emulators: [
    {
      id: 'rpcs3-standalone',
      label: 'RPCS3 (Standalone)',
      command: '%EMULATOR_RPCS3% --no-gui %RPCS3_AUTO%',
      aliases: [
        'rpcs3-directory-standalone',
        'rpcs3-game-serial-standalone',
        'rpcs3-iso-standalone',
        'RPCS3 Directory (Standalone)',
        'RPCS3 Game Serial (Standalone)',
        'RPCS3 ISO (Standalone)'
      ]
    }
  ]
}

function game(system: SystemDefinition, romPath: string, overrides: Partial<Game> = {}): Game {
  const externalId = `${system.id}/${romPath.slice(join(romsRoot, system.id).length + 1).replace(/\\/g, '/')}`
  return {
    id: `rom:${system.id}:1`,
    source: 'rom',
    externalId,
    platformId: system.id,
    title: 'Game',
    sortTitle: 'game',
    installed: true,
    romPath,
    launch: { kind: 'emulator', systemId: system.id, romPath },
    tracking: { mode: 'spawned' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...overrides
  }
}

function fakeResolver(
  paths: Record<string, string | null>,
  cores: Record<string, string | null> = {}
): Pick<EmulatorResolver, 'resolveEmulator' | 'resolveCore'> {
  return {
    async resolveEmulator(id): Promise<EmulatorStatus> {
      const path = paths[id] ?? null
      return {
        id,
        name: id,
        path,
        foundBy: path ? 'rule' : null,
        searchedPaths: [`C:\\Looked\\Here\\${id}.exe`, `D:\\And\\There\\${id}.exe`]
      }
    },
    async resolveCore(_coreId, file): Promise<CoreResolution> {
      const coreFile = file.replace(/^[\\/]+/, '')
      const path = cores[coreFile] ?? null
      return { path, coreFile, searchedPaths: [join(coresDir, coreFile)] }
    }
  }
}

function deps(
  resolver = fakeResolver(
    { RETROARCH: retroarch, DOLPHIN: dolphin },
    { 'snes9x_libretro.dll': join(coresDir, 'snes9x_libretro.dll') }
  )
): LaunchCommandDeps {
  return { resolver, getSettings: () => settings, exeDir, log, env: { PATH: exeDir } }
}

describe('tokenize', () => {
  it('splits on whitespace and honours double quotes', () => {
    expect(tokenize('%EMULATOR_ARES% --fullscreen --system "Atari 2600" %ROM%')).toEqual([
      '%EMULATOR_ARES%',
      '--fullscreen',
      '--system',
      'Atari 2600',
      '%ROM%'
    ])
    expect(tokenize('  a   b\tc ')).toEqual(['a', 'b', 'c'])
    expect(tokenize('%ROMPATH%"\\Arcade Games"')).toEqual(['%ROMPATH%\\Arcade Games'])
    expect(tokenize('')).toEqual([])
  })

  it('applies Win32 backslash rules: literal unless before a quote', () => {
    expect(tokenize('-mmc=.\\ %ROM%')).toEqual(['-mmc=.\\', '%ROM%'])
    expect(tokenize('-rompath %GAMEDIR%\\;%ROMPATH%\\adam adam')).toEqual([
      '-rompath',
      '%GAMEDIR%\\;%ROMPATH%\\adam',
      'adam'
    ])
    expect(
      tokenize(
        '"apple2e -rompath \\"%GAMEDIRRAW%;%ROMPATH%\\apple2\\" -flop1 \\"%GAMEDIRRAW%\\%FILENAME%\\""'
      )
    ).toEqual([
      'apple2e -rompath "%GAMEDIRRAW%;%ROMPATH%\\apple2" -flop1 "%GAMEDIRRAW%\\%FILENAME%"'
    ])
    expect(tokenize('-autoboot_command "cloadm\\"\\"\\n" -cass %ROM%')).toEqual([
      '-autoboot_command',
      'cloadm""\\n',
      '-cass',
      '%ROM%'
    ])
    expect(tokenize('"C:\\Dir With Space\\"')).toEqual(['C:\\Dir With Space"'])
    expect(tokenize('"C:\\Dir With Space\\\\"')).toEqual(['C:\\Dir With Space\\'])
  })
})

describe('escapeCmdSpecials', () => {
  it('applies the ES-DE %ESCAPESPECIALS% rule (carets for ^ & ( ) = ; , and then spaces)', () => {
    expect(escapeCmdSpecials('C:\\ROMs\\ags\\Tom&Jerry.lnk')).toBe('C:\\ROMs\\ags\\Tom^&Jerry.lnk')
    expect(escapeCmdSpecials('C:\\ROMs\\windows\\Game^2.bat')).toBe(
      'C:\\ROMs\\windows\\Game^^2.bat'
    )
    expect(escapeCmdSpecials('C:\\ROMs\\sub dir\\A&B.bat')).toBe('C:\\ROMs\\sub^ dir\\A^&B.bat')
    expect(escapeCmdSpecials('C:\\ROMs\\plain\\a,b.bat')).toBe('C:\\ROMs\\plain\\a^,b.bat')
    expect(escapeCmdSpecials('C:\\ROMs\\odd\\a;b=c.bat')).toBe('C:\\ROMs\\odd\\a^;b^=c.bat')
    expect(escapeCmdSpecials('C:\\ROMs\\steam\\Tom & Jerry (v1,2).url')).toBe(
      'C:\\ROMs\\steam\\Tom^ ^&^ Jerry^ ^(v1^,2^).url'
    )
    // Spaces alone are not escaped (Node's quoting covers them, exactly like ES-DE's getEscapedPath).
    expect(escapeCmdSpecials('C:\\My ROMs\\steam\\Half-Life 2.url')).toBe(
      'C:\\My ROMs\\steam\\Half-Life 2.url'
    )
    expect(escapeCmdSpecials('C:\\ROMs\\steam\\Portal.url')).toBe('C:\\ROMs\\steam\\Portal.url')
  })
})

describe('selectCommand', () => {
  const g = (emulatorId?: string): Game =>
    game(snes, join(romsRoot, 'snes', 'x.sfc'), { user: emulatorId ? { emulatorId } : {} })

  it('prefers the request, then the game, then the preferred setting, then the default', () => {
    expect(selectCommand(snes, g(), undefined, settings).id).toBe('snes9x-current')
    settings.emulators.preferred.snes = 'snes9x-standalone'
    expect(selectCommand(snes, g(), undefined, settings).id).toBe('snes9x-standalone')
    expect(selectCommand(snes, g('mesen-s'), undefined, settings).id).toBe('mesen-s')
    expect(selectCommand(snes, g('mesen-s'), 'snes9x-current', settings).id).toBe('snes9x-current')
  })

  it("uses the scan's emulator for the ROM unless the request or the game names another", () => {
    const eboot = join(romsRoot, 'ps4', 'Game', 'eboot.bin')
    const scanned = (user: Game['user'] = {}): Game =>
      game(ps4, eboot, {
        user,
        launch: {
          kind: 'emulator',
          systemId: 'ps4',
          romPath: eboot,
          emulatorId: 'shadps4-eboot-bin-standalone'
        }
      })
    settings.emulators.preferred.ps4 = 'shadps4-game-serial-standalone'
    expect(selectCommand(ps4, scanned(), undefined, settings).id).toBe(
      'shadps4-eboot-bin-standalone'
    )
    expect(
      selectCommand(
        ps4,
        scanned({ emulatorId: 'shadps4-gui-eboot-bin-standalone' }),
        undefined,
        settings
      ).id
    ).toBe('shadps4-gui-eboot-bin-standalone')
    expect(selectCommand(ps4, game(ps4, eboot), undefined, settings).id).toBe(
      'shadps4-game-serial-standalone'
    )
  })

  it('runs the merged RPCS3 command for the ids and labels it replaced, without warnings', () => {
    const at = (emulatorId?: string, scan?: string): Game =>
      game(ps3Merged, join(romsRoot, 'ps3', 'x.iso'), {
        user: emulatorId ? { emulatorId } : {},
        ...(scan
          ? { launch: { kind: 'emulator', systemId: 'ps3', romPath: 'x', emulatorId: scan } }
          : {})
      })
    for (const old of [
      'rpcs3-directory-standalone',
      'rpcs3-game-serial-standalone',
      'rpcs3-iso-standalone',
      'RPCS3 Game Serial (Standalone)'
    ]) {
      expect(selectCommand(ps3Merged, at(), old, settings, log).id).toBe('rpcs3-standalone')
      expect(selectCommand(ps3Merged, at(old), undefined, settings, log).id).toBe(
        'rpcs3-standalone'
      )
      expect(selectCommand(ps3Merged, at(undefined, old), undefined, settings, log).id).toBe(
        'rpcs3-standalone'
      )
      settings.emulators.preferred.ps3 = old
      expect(selectCommand(ps3Merged, at(), undefined, settings, log).id).toBe('rpcs3-standalone')
    }
    expect(warnings).toEqual([])
  })

  it('accepts ES-DE labels and falls back past unknown ids with a warning', () => {
    expect(selectCommand(snes, g('Mesen-S'), undefined, settings).id).toBe('mesen-s')
    settings.emulators.preferred.snes = 'bogus'
    expect(selectCommand(snes, g('also-bogus'), undefined, settings, log).id).toBe('snes9x-current')
    expect(warnings.length).toBe(2)
  })
})

describe('launchesWith', () => {
  const ps2: SystemDefinition = {
    id: 'ps2',
    name: 'Sony PlayStation 2',
    extensions: ['.chd'],
    platformKey: 'ps2',
    emulators: [
      { id: 'pcee2', label: 'PCEE2', command: '%EMULATOR_RETROARCH% -L x.dll %ROM%' },
      {
        id: 'pcsx2-standalone',
        label: 'PCSX2 (Standalone)',
        command: '%EMULATOR_PCSX2% -batch %ROM%'
      },
      {
        id: 'pcsx2-legacy-standalone',
        label: 'PCSX2 Legacy (Standalone)',
        command: '%EMULATOR_PCSX2-LEGACY% --nogui %ROM%'
      }
    ]
  }
  const rom = (): string => join(romsRoot, 'ps2', 'x.chd')

  it('follows the command a launch picks: the game, then the preferred emulator, then the default', () => {
    // The default command (RetroArch) does not start PCSX2.
    expect(launchesWith(ps2, game(ps2, rom()), settings, 'PCSX2')).toBe(false)
    settings.emulators.preferred.ps2 = 'pcsx2-standalone'
    expect(launchesWith(ps2, game(ps2, rom()), settings, 'PCSX2')).toBe(true)
    // A game set to another emulator, PCSX2 Legacy included, is not PCSX2's.
    const legacy = game(ps2, rom(), { user: { emulatorId: 'pcsx2-legacy-standalone' } })
    expect(launchesWith(ps2, legacy, settings, 'PCSX2')).toBe(false)
    const retro = game(ps2, rom(), { user: { emulatorId: 'pcee2' } })
    expect(launchesWith(ps2, retro, settings, 'PCSX2')).toBe(false)
  })
})

describe('resolveLaunchCommand', () => {
  it('expands a RetroArch command with spaces in every path into { file, args }', async () => {
    const rom = await touch(join(romsRoot, 'snes', 'Super Mario World (USA).sfc'))
    const result = await resolveLaunchCommand(game(snes, rom), snes, undefined, deps())
    expect(result).toEqual({
      ok: true,
      file: retroarch,
      args: ['-L', join(coresDir, 'snes9x_libretro.dll'), rom],
      runInBackground: false,
      hideWindow: false,
      emulatorId: 'RETROARCH'
    })
  })

  it('expands a standalone command with %STARTDIR%, %HIDEWINDOW% and a directory-as-file ROM', async () => {
    const romDir = join(romsRoot, 'gc', 'Metal Gear Solid - The Twin Snakes (USA).m3u')
    const inner = await touch(
      join(romDir, 'Metal Gear Solid - The Twin Snakes (USA).m3u'),
      'Disc 1.rvz\nDisc 2.rvz\n'
    )
    const result = await resolveLaunchCommand(game(gc, romDir), gc, undefined, deps())
    expect(result).toEqual({
      ok: true,
      file: dolphin,
      args: ['-b', '-e', inner],
      cwd: dirname(dolphin),
      runInBackground: false,
      hideWindow: true,
      emulatorId: 'DOLPHIN'
    })
  })

  it('caret-escapes %ROM% for %ESCAPESPECIALS% commands (cmd.exe /C) and leaves other ROMs alone', async () => {
    const steam: SystemDefinition = {
      id: 'steam',
      name: 'Valve Steam',
      extensions: ['.url', '.lnk', '.bat'],
      platformKey: 'steam',
      emulators: [
        {
          id: 'os-shell',
          label: 'OS Shell',
          command: '%HIDEWINDOW% %ESCAPESPECIALS% %EMULATOR_OS-SHELL% /C %ROM%'
        }
      ]
    }
    const cmd = await touch(join(dir, 'Windows', 'System32', 'cmd.exe'))
    const run = (rom: string, system = steam): ReturnType<typeof resolveLaunchCommand> =>
      resolveLaunchCommand(
        game(system, rom),
        system,
        undefined,
        deps(fakeResolver({ 'OS-SHELL': cmd }))
      )

    // Spaces + '&': without the carets cmd.exe runs "Ratchet" and "Clank.url" as two commands.
    const ratchet = await touch(join(romsRoot, 'steam', 'Ratchet & Clank.url'))
    expect(await run(ratchet)).toEqual({
      ok: true,
      file: cmd,
      args: ['/C', escapeCmdSpecials(ratchet)],
      runInBackground: false,
      hideWindow: true,
      emulatorId: 'OS-SHELL'
    })
    expect(escapeCmdSpecials(ratchet)).toContain('Ratchet^ ^&^ Clank.url')
    // No spaces, so Node passes the argument bare: ',' and '&' must still be escaped.
    const comma = await touch(join(romsRoot, 'steam', 'a,b.bat'))
    expect(await run(comma)).toMatchObject({ args: ['/C', escapeCmdSpecials(comma)] })
    expect(escapeCmdSpecials(comma).endsWith('\\a^,b.bat')).toBe(true)
    const amp = await touch(join(romsRoot, 'steam', 'Dungeons&Dragons.lnk'))
    expect(await run(amp)).toMatchObject({ args: ['/C', escapeCmdSpecials(amp)] })
    expect(escapeCmdSpecials(amp).endsWith('\\Dungeons^&Dragons.lnk')).toBe(true)

    // Without %ESCAPESPECIALS% the ROM path is substituted raw even for the same characters.
    const rom = await touch(join(romsRoot, 'snes', 'Ratchet & Clank (v1,2).sfc'))
    expect(await resolveLaunchCommand(game(snes, rom), snes, undefined, deps())).toMatchObject({
      args: ['-L', join(coresDir, 'snes9x_libretro.dll'), rom]
    })
  })

  it('substitutes the remaining ES-DE placeholders raw (the launcher passes an argv array)', async () => {
    const rom = await touch(join(romsRoot, 'adam', 'Sub Dir', 'Buck Rogers (USA).ddp'))
    const adam: SystemDefinition = {
      id: 'adam',
      name: 'Coleco Adam',
      extensions: ['.ddp'],
      platformKey: 'adam',
      emulators: [
        {
          id: 'mame',
          label: 'MAME',
          command:
            '%HIDEWINDOW% %RUNINBACKGROUND% %STARTDIR%=%GAMEDIR% %EMULATOR_MAME% -rompath %GAMEDIR%\\;%ROMPATH%\\adam adam -cass1 %ROM% %ROMRAW% %BASENAME% %FILENAME% %GAMEDIRRAW% %EMUDIR% %EMUPATH% %ESPATH% ~\\x "two words" %ESCAPESPECIALS%'
        }
      ]
    }
    const mame = await touch(join(dir, 'MAME Dir', 'mame.exe'))
    const result = await resolveLaunchCommand(
      game(adam, rom),
      adam,
      undefined,
      deps(fakeResolver({ MAME: mame }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const gameDir = dirname(rom)
    expect(result.file).toBe(mame)
    expect(result.cwd).toBe(gameDir)
    expect(result.runInBackground).toBe(true)
    expect(result.hideWindow).toBe(true)
    // %ESCAPESPECIALS% is present, so %ROM% (and only %ROM%) is caret-escaped as ES-DE does; %ROMRAW% stays raw.
    expect(result.args).toEqual([
      '-rompath',
      `${gameDir}\\;${romsRoot}\\adam`,
      'adam',
      '-cass1',
      escapeCmdSpecials(rom),
      rom,
      'Buck Rogers (USA)',
      'Buck Rogers (USA).ddp',
      gameDir,
      dirname(mame),
      dirname(mame),
      exeDir,
      `${process.env.USERPROFILE}\\x`,
      'two words'
    ])
  })

  it('splices %INJECT% files in place, also mid-word, and drops %PRECOMMAND% / %POSTCOMMAND% with a warning', async () => {
    // ES-DE's "RPCS3 Game Serial" layout: Game.ps3 is a text file holding the serial, injected into the command.
    const sotc = await touch(join(romsRoot, 'ps3', 'Shadow of the Colossus.ps3'), 'NPUA80659\r\n')
    await touch(
      join(romsRoot, 'ps3', 'Shadow of the Colossus.commands'),
      '--fullscreen\r\n --no-gui\r\n'
    )
    const ps3: SystemDefinition = {
      id: 'ps3',
      name: 'Sony PlayStation 3',
      extensions: ['.ps3'],
      platformKey: 'ps3',
      dirExtensions: ['.ps3'],
      emulators: [
        {
          id: 'rpcs3',
          label: 'RPCS3',
          command:
            '%PRECOMMAND_WRAPPER% %EMULATOR_RPCS3% %INJECT%=%BASENAME%.commands --serial=%INJECT%=%BASENAME%.ps3 %INJECT%=missing.commands %ROM% %POSTCOMMAND%'
        }
      ]
    }
    const rpcs3 = await touch(join(dir, 'RPCS3 Dir', 'rpcs3.exe'))
    const result = await resolveLaunchCommand(
      game(ps3, sotc),
      ps3,
      undefined,
      deps(fakeResolver({ RPCS3: rpcs3 }))
    )
    expect(result).toMatchObject({
      ok: true,
      file: rpcs3,
      args: ['--fullscreen', '--no-gui', '--serial=NPUA80659', sotc]
    })
    expect(
      warnings.some((w) => w.includes('%PRECOMMAND_WRAPPER%') && w.includes('%POSTCOMMAND%'))
    ).toBe(true)
  })

  it('reads %INJECT%=%ROM% from the real ROM path under %ESCAPESPECIALS%, not the caret-escaped one', async () => {
    const scripts: SystemDefinition = {
      id: 'windows',
      name: 'Microsoft Windows',
      extensions: ['.args'],
      platformKey: 'windows',
      emulators: [
        {
          id: 'os-shell',
          label: 'OS Shell',
          command: '%ESCAPESPECIALS% %EMULATOR_OS-SHELL% /C %INJECT%=%ROM% --from=%ROM%'
        }
      ]
    }
    const cmd = await touch(join(dir, 'Windows', 'System32', 'cmd.exe'))
    const rom = await touch(
      join(romsRoot, 'windows', 'Tom & Jerry.args'),
      'start steam://run/1\r\n'
    )
    const result = await resolveLaunchCommand(
      game(scripts, rom),
      scripts,
      undefined,
      deps(fakeResolver({ 'OS-SHELL': cmd }))
    )
    // The file is read from where it is; the %ROM% handed to cmd.exe is still escaped.
    expect(escapeCmdSpecials(rom)).not.toBe(rom)
    expect(result).toMatchObject({
      ok: true,
      file: cmd,
      args: ['/C', 'start', 'steam://run/1', `--from=${escapeCmdSpecials(rom)}`]
    })
  })

  it('reports a missing emulator with its id and the searched paths', async () => {
    const rom = await touch(join(romsRoot, 'snes', 'Game.sfc'))
    const result = await resolveLaunchCommand(game(snes, rom), snes, 'snes9x-standalone', deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('emulator-missing')
    expect(result.error.emulatorId).toBe('SNES9X')
    expect(result.error.message).toContain('C:\\Looked\\Here\\SNES9X.exe')
    expect(result.error.message).toContain('D:\\And\\There\\SNES9X.exe')
  })

  it('reports a missing core with the core file and the searched paths', async () => {
    const rom = await touch(join(romsRoot, 'snes', 'Game.sfc'))
    const result = await resolveLaunchCommand(game(snes, rom), snes, 'mesen-s', deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatchObject({
      kind: 'core-missing',
      emulatorId: 'RETROARCH',
      coreFile: 'mesen-s_libretro.dll'
    })
    expect(result.error.message).toContain(join(coresDir, 'mesen-s_libretro.dll'))
  })

  it('reports a missing ROM and a placeholder-only system', async () => {
    const missing = await resolveLaunchCommand(
      game(snes, join(romsRoot, 'snes', 'gone.sfc')),
      snes,
      undefined,
      deps()
    )
    expect(missing).toMatchObject({ ok: false, error: { kind: 'file-missing' } })
    const rom = await touch(join(romsRoot, 'kodi', 'Kodi.lnk'))
    const kodi: SystemDefinition = {
      id: 'kodi',
      name: 'Kodi',
      extensions: ['.lnk'],
      platformKey: 'kodi',
      emulators: [{ id: 'default', label: 'Default', command: 'PLACEHOLDER %ROM%' }]
    }
    const result = await resolveLaunchCommand(game(kodi, rom), kodi, undefined, deps())
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } })
  })

  it('starts Switch 2 shortcuts only: a game file says there is no emulator yet', async () => {
    const switch2 = loadSystemCatalog(SYSTEMS_FILE).findSystem('switch2')!
    const cmd = await touch(join(dir, 'Windows', 'System32', 'cmd.exe'))
    const d = deps(fakeResolver({ 'OS-SHELL': cmd }))
    const nup = await touch(join(romsRoot, 'switch2', 'Mario Kart World.nup'))
    const result = await resolveLaunchCommand(game(switch2, nup), switch2, undefined, d)
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } })
    if (!result.ok)
      expect(result.error.message).toBe(
        'PlayOut has no Nintendo Switch 2 emulator yet, so Mario Kart World.nup cannot be started. A Windows ' +
          'shortcut (.lnk) to an emulator that runs it can go in the same folder and be played instead.'
      )
    const lnk = await touch(join(romsRoot, 'switch2', 'Mario Kart World.lnk'))
    expect(await resolveLaunchCommand(game(switch2, lnk), switch2, undefined, d)).toMatchObject({
      ok: true,
      file: cmd,
      args: ['/C', escapeCmdSpecials(lnk)],
      emulatorId: 'OS-SHELL'
    })
  })

  it('starts PS5 shortcuts only: a game folder or file says there is no emulator yet', async () => {
    const ps5 = loadSystemCatalog(SYSTEMS_FILE).findSystem('ps5')!
    const cmd = await touch(join(dir, 'Windows', 'System32', 'cmd.exe'))
    const d = deps(fakeResolver({ 'OS-SHELL': cmd }))
    const eboot = await touch(join(romsRoot, 'ps5', 'Astro Bot - [US]', 'eboot.bin'))
    const folderGame = game(ps5, eboot, { extra: { gameFolder: dirname(eboot) } })
    const result = await resolveLaunchCommand(folderGame, ps5, undefined, d)
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } })
    if (!result.ok)
      expect(result.error.message).toBe(
        'PlayOut has no Sony PlayStation 5 emulator yet, so Astro Bot - [US] cannot be started. A Windows ' +
          'shortcut (.lnk) to an emulator that runs it can go next to that folder and be played instead.'
      )
    const image = await touch(join(romsRoot, 'ps5', 'Returnal.ffpkg'))
    const imageResult = await resolveLaunchCommand(game(ps5, image), ps5, undefined, d)
    if (imageResult.ok) throw new Error('a PS5 image started')
    expect(imageResult.error.message).toContain('so Returnal.ffpkg cannot be started')
    const lnk = await touch(join(romsRoot, 'ps5', 'Astro Bot.lnk'))
    expect(await resolveLaunchCommand(game(ps5, lnk), ps5, undefined, d)).toMatchObject({
      ok: true,
      file: cmd,
      args: ['/C', escapeCmdSpecials(lnk)],
      emulatorId: 'OS-SHELL'
    })
  })

  it('treats the first word as the executable when no %EMULATOR_X% is present', async () => {
    const rom = await touch(join(romsRoot, 'pc', 'Game Dir', 'Game.bat'))
    const exe = await touch(join(exeDir, 'launch helper.exe'))
    const pc: SystemDefinition = {
      id: 'pc',
      name: 'PC',
      extensions: ['.bat'],
      platformKey: 'pc',
      emulators: [
        { id: 'helper', label: 'Helper', command: '"launch helper" --run %ROM%' },
        { id: 'absent', label: 'Absent', command: 'definitely-not-here.exe %ROM%' }
      ]
    }
    const result = await resolveLaunchCommand(game(pc, rom), pc, undefined, deps())
    expect(result).toMatchObject({ ok: true, file: exe, args: ['--run', rom] })
    // No %EMULATOR_X%: no find-rules id for the launcher's before-launch hook.
    expect(result.ok && result.emulatorId).toBeUndefined()
    const absent = await resolveLaunchCommand(game(pc, rom), pc, 'absent', deps())
    expect(absent).toMatchObject({
      ok: false,
      error: { kind: 'emulator-missing', emulatorId: 'definitely-not-here.exe' }
    })
    if (!absent.ok) expect(absent.error.message).toContain(join(exeDir, 'definitely-not-here.exe'))
  })
})

describe('%RPCS3_AUTO%', () => {
  let rpcs3: string
  const infos: string[] = []
  const run = async (
    romPath: string,
    readShortcut?: LaunchCommandDeps['readShortcut']
  ): Promise<LaunchResolution> => {
    rpcs3 = await touch(join(dir, 'RPCS3', 'rpcs3.exe'))
    const d = deps(fakeResolver({ RPCS3: rpcs3 }))
    d.log = { ...log, info: (...a) => infos.push(a.join(' ')) }
    d.readShortcut = readShortcut
    return resolveLaunchCommand(game(ps3Merged, romPath), ps3Merged, undefined, d)
  }
  beforeEach(() => {
    infos.length = 0
  })

  it('passes a disc game folder, a PSN game folder and any other folder as the folder', async () => {
    const disc = join(romsRoot, 'ps3', "Demon's Souls.ps3")
    await touch(join(disc, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'))
    const psn = join(romsRoot, 'ps3', 'flOw.ps3dir')
    await touch(join(psn, 'USRDIR', 'EBOOT.BIN'))
    const other = join(romsRoot, 'ps3', 'Odd.ps3')
    await fs.mkdir(other, { recursive: true })
    for (const [folder, reason] of [
      [disc, 'disc game folder'],
      [psn, 'PSN game folder'],
      [other, 'game folder']
    ]) {
      expect(await run(folder)).toMatchObject({ ok: true, file: rpcs3, args: ['--no-gui', folder] })
      expect(infos.some((i) => i.includes(reason) && i.includes(folder))).toBe(true)
    }
    expect(warnings).toEqual([])
  })

  it('passes an .iso, an EBOOT.BIN and a large .ps3 file as the file', async () => {
    const iso = await touch(join(romsRoot, 'ps3', 'Game (USA).iso'))
    const eboot = await touch(join(romsRoot, 'ps3', 'Game', 'USRDIR', 'EBOOT.BIN'))
    const big = await touch(join(romsRoot, 'ps3', 'Big.ps3'), 'x'.repeat(5000))
    for (const file of [iso, eboot, big])
      expect(await run(file)).toMatchObject({ ok: true, args: ['--no-gui', file] })
    expect(infos.some((i) => i.includes('disc image'))).toBe(true)
  })

  it('boots a serial file (also Game.ps3 inside Game.ps3) by its serial, without a warning', async () => {
    const serial = await touch(join(romsRoot, 'ps3', 'Journey.ps3'), '\uFEFFnpua80069\r\n')
    expect(await run(serial)).toMatchObject({
      ok: true,
      args: ['--no-gui', '%RPCS3_GAMEID%:NPUA80069']
    })
    const folder = join(romsRoot, 'ps3', 'Flower.ps3')
    await touch(join(folder, 'Flower.ps3'), 'NPUA80083')
    expect(await run(folder)).toMatchObject({
      ok: true,
      args: ['--no-gui', '%RPCS3_GAMEID%:NPUA80083']
    })
    expect(infos.some((i) => i.includes('serial file'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('fails clearly when a small .ps3 file holds no serial', async () => {
    for (const content of ['', 'hello world', 'BLUS3044']) {
      const bad = await touch(join(romsRoot, 'ps3', 'Bad.ps3'), content)
      const result = await run(bad)
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: 'failed',
          message: expect.stringContaining('Bad.ps3 does not hold a PS3 serial')
        }
      })
    }
  })
  it('boots an RPCS3 "Create Shortcut" .lnk by the serial in its arguments', async () => {
    const lnk = await touch(join(romsRoot, 'ps3', 'Journey.lnk'))
    const read = vi.fn(async () => ({
      target: rpcs3,
      args: '--no-gui "%rpcs3_gameid%:npua80069"',
      cwd: dirname(rpcs3)
    }))
    expect(await run(lnk, read)).toMatchObject({
      ok: true,
      file: rpcs3,
      args: ['--no-gui', '%RPCS3_GAMEID%:NPUA80069']
    })
    expect(read).toHaveBeenCalledWith(lnk)
    expect(infos.some((i) => i.includes('shortcut with a serial'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('boots the game folder or file a .lnk points at, also as a path in rpcs3.exe arguments', async () => {
    rpcs3 = await touch(join(dir, 'RPCS3', 'rpcs3.exe'))
    const lnk = await touch(join(romsRoot, 'ps3', 'Game.lnk'))
    const disc = join(dir, 'Games', "Demon's Souls")
    await touch(join(disc, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'))
    const eboot = join(disc, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN')
    const iso = await touch(join(dir, 'Games', 'Game (USA).iso'))
    const cases: Array<[ShortcutLink, string, string]> = [
      [{ target: disc }, disc, 'shortcut to a disc game folder'],
      [{ target: iso, args: '' }, iso, 'shortcut to a disc image'],
      [{ target: rpcs3, args: `--no-gui "${eboot}"` }, eboot, 'shortcut to a game file'],
      [{ target: rpcs3, args: '--no-gui "Game (USA).iso"', cwd: dirname(iso) }, iso, 'disc image']
    ]
    for (const [link, expected, reason] of cases) {
      infos.length = 0
      expect(await run(lnk, async () => link)).toMatchObject({
        ok: true,
        args: ['--no-gui', expected]
      })
      expect(infos.some((i) => i.includes(reason) && i.includes(expected))).toBe(true)
    }
  })

  it('fails clearly for a .lnk that is unreadable or points at no PS3 game', async () => {
    rpcs3 = await touch(join(dir, 'RPCS3', 'rpcs3.exe'))
    const lnk = await touch(join(romsRoot, 'ps3', 'Notepad.lnk'))
    const notepad = await touch(join(dir, 'Windows', 'notepad.exe'))
    const readers: Array<NonNullable<LaunchCommandDeps['readShortcut']>> = [
      async () => {
        throw new Error('not a shortcut')
      },
      async () => ({ target: notepad, args: 'readme.txt' }),
      async () => ({ target: rpcs3, args: '--no-gui' }),
      async () => ({ target: join(dir, 'Gone', 'EBOOT.BIN') })
    ]
    for (const read of readers) {
      expect(await run(lnk, read)).toMatchObject({
        ok: false,
        error: {
          kind: 'failed',
          message: expect.stringContaining('Notepad.lnk is not an RPCS3 game shortcut')
        }
      })
    }
  })
})
