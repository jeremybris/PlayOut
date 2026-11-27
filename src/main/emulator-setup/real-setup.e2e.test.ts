import { existsSync, promises as fs, readdirSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Settings } from '../../shared/types'
import { EMULATOR_CATALOG } from './catalog'
import { createEmulatorSetupService } from './service'

/**
 * The real thing: downloads the 14 emulators and 7-Zip from their official hosts (RPCS3 from the user's Google Drive), unpacks and configures them in
 * PLAYOUT_E2E_DIR (a scratch folder), runs MAME once (-createconfig), then checks every emulator's portable mode and
 * folder links. Skipped unless PLAYOUT_E2E_DIR is set; the Visual C++ / DirectX installers are never run here.
 */
const ROOT = process.env.PLAYOUT_E2E_DIR

const log = {
  debug: () => undefined,
  info: (...a: unknown[]) => console.log('[info]', ...a),
  warn: (...a: unknown[]) => console.log('[warn]', ...a),
  error: (...a: unknown[]) => console.log('[error]', ...a)
}

function same(a: string, b: string): boolean {
  return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()
}

describe.skipIf(!ROOT)('emulator setup against the real downloads', () => {
  it('installs and configures every emulator', { timeout: 60 * 60 * 1000 }, async () => {
    const exeDir = join(ROOT!, 'app')
    const userData = join(ROOT!, 'userData')
    const D = join(userData, 'Emulation')
    await fs.mkdir(exeDir, { recursive: true })
    await fs.mkdir(join(D, 'bios'), { recursive: true })
    let settings: Settings = defaultSettings()
    const service = createEmulatorSetupService({
      settings: {
        get: () => settings,
        update: (patch) => {
          settings = { ...settings, ...(patch as Partial<Settings>) } as Settings
        }
      },
      userData,
      exeDir,
      emit: (p) => {
        if (p.total)
          console.log(`progress ${p.stage} ${p.done}/${p.total} ${p.current?.join(', ') ?? ''}`)
      },
      log,
      modules: {
        runtimesMissing: async () => [],
        ensureRuntimes: async () => []
      }
    })
    const status = await service.setup()
    console.log(JSON.stringify(status, null, 1))
    const E = (folder: string): string => join(exeDir, 'Emulators', folder)
    for (const spec of EMULATOR_CATALOG)
      expect(existsSync(join(E(spec.folder), spec.exe)), `${spec.name} exe`).toBe(true)

    expect(existsSync(join(E('DuckStation'), 'portable.txt'))).toBe(true)
    expect(same(join(E('DuckStation'), 'bios'), join(D, 'bios'))).toBe(true)
    expect(existsSync(join(E('PCSX2'), 'portable.txt'))).toBe(true)
    expect(same(join(E('PCSX2'), 'bios'), join(D, 'bios'))).toBe(true)
    expect(readFileSync(join(E('RPCS3'), 'config', 'vfs.yml'), 'utf8')).toContain('/dev_hdd0/:')
    expect(existsSync(join(E('Dolphin'), 'portable.txt'))).toBe(true)
    expect(readFileSync(join(E('Dolphin'), 'User', 'Config', 'Dolphin.ini'), 'utf8')).toContain(
      'ISOPath0'
    )
    expect(existsSync(join(E('PPSSPP'), 'installed.txt'))).toBe(false)
    expect(existsSync(join(E('PPSSPP'), 'memstick', 'PSP', 'SYSTEM', 'ppsspp.ini'))).toBe(true)
    expect(readFileSync(join(E('Flycast'), 'emu.cfg'), 'utf8')).toContain('Dreamcast.BiosPath')
    expect(same(join(E('Azahar'), 'user', 'sysdata'), join(D, 'bios', 'azahar', 'keys'))).toBe(true)
    expect(readFileSync(join(E('melonDS'), 'melonDS.toml'), 'utf8')).toContain('[Instance0]')
    expect(existsSync(join(E('melonDS'), 'portable'))).toBe(false)
    expect(existsSync(join(E('mGBA'), 'portable.ini'))).toBe(true)
    expect(readFileSync(join(E('mGBA'), 'config.ini'), 'utf8')).toContain('savegamePath')
    expect(existsSync(join(E('Model2'), 'EMULATOR.INI'))).toBe(true)
    expect(existsSync(join(E('Ryujinx'), 'portable'))).toBe(true)
    expect(readFileSync(join(E('ScummVM'), 'scummvm.ini'), 'utf8')).toContain('savepath=')
    const mameIni = readFileSync(join(E('MAME'), 'mame.ini'), 'utf8')
    console.log(`mame.ini lines: ${mameIni.split('\n').length}`)
    expect(mameIni).toMatch(/^rompath\s+/m)
    expect(existsSync(join(E('MAME'), 'mame.sym'))).toBe(false)
    expect(readFileSync(join(E('RetroArch'), 'retroarch.cfg'), 'utf8')).toContain(
      'system_directory'
    )
    const cores = readdirSync(join(E('RetroArch'), 'cores')).filter((f) =>
      f.endsWith('_libretro.dll')
    )
    console.log(`RetroArch cores: ${cores.length}`)
    expect(cores.length).toBeGreaterThan(50)
    expect(status.items.every((i) => i.state === 'installed')).toBe(true)

    // Fullscreen and controllers (presets): each emulator's own file, as written after setup.
    const text = (...p: string[]): string => {
      const file = join(...p)
      return existsSync(file) ? readFileSync(file, 'latin1') : ''
    }
    const duck = text(E('DuckStation'), 'settings.ini')
    expect(duck).toMatch(/StartFullscreen = true/)
    expect(duck).toMatch(/SDL-0\/DPadUp/)
    expect(duck).toMatch(/Keyboard\/UpArrow/)
    const pcsx2 = text(E('PCSX2'), 'inis', 'PCSX2.ini')
    console.log(`PCSX2.ini lines: ${pcsx2.split('\n').length}`)
    expect(pcsx2).toMatch(/SettingsVersion = 1/)
    expect(pcsx2).toMatch(/StartFullscreen = true/)
    expect(pcsx2).toMatch(/SDL-0\//)
    // RPCS3 comes from the user's preconfigured Google Drive folder: its own settings, no presets.
    expect(existsSync(join(E('RPCS3'), '.playout-drive.json'))).toBe(true)
    expect(existsSync(join(E('RPCS3'), 'dev_flash', 'vsh', 'module', 'vsh.self'))).toBe(true)
    const ryujinx = JSON.parse(text(E('Ryujinx'), 'portable', 'Config.json')) as {
      version: number
      start_fullscreen: boolean
      input_config: { backend: string }[]
    }
    console.log(
      `Ryujinx config v${ryujinx.version}, inputs: ${ryujinx.input_config.map((i) => i.backend).join(', ')}`
    )
    expect(ryujinx.start_fullscreen).toBe(true)
    expect(existsSync(join(E('Ryujinx'), 'Config.json'))).toBe(false)
    expect(text(E('Dolphin'), 'User', 'Config', 'GCPadNew.ini')).toContain('XInput/0/Gamepad')
    expect(text(E('Dolphin'), 'User', 'Config', 'Dolphin.ini')).toMatch(/Fullscreen = True/)
    expect(text(E('PPSSPP'), 'memstick', 'PSP', 'SYSTEM', 'ppsspp.ini')).toMatch(
      /FullScreen = True/
    )
    expect(text(E('RetroArch'), 'retroarch.cfg')).toMatch(/video_fullscreen = "true"/)
    expect(text(E('ScummVM'), 'scummvm.ini')).toMatch(/fullscreen=true/)
    expect(text(E('mGBA'), 'config.ini')).toMatch(/fullscreen=1/)
    for (const [name, file] of [
      ['Azahar', join(E('Azahar'), 'user', 'config', 'qt-config.ini')],
      ['melonDS', join(E('melonDS'), 'melonDS.toml')],
      ['Flycast', join(E('Flycast'), 'emu.cfg')],
      ['Model 2', join(E('Model2'), 'EMULATOR.INI')],
      ['MAME', join(E('MAME'), 'mame.ini')]
    ] as const)
      console.log(
        `${name}: ${text(file)
          .split(/\r?\n/)
          .filter((l) =>
            /fullscreen|full_screen|autofull|xinput|joystick|window\s|button_a|^Joy/i.test(l)
          )
          .join(' | ')}`
      )
    const manifest = JSON.parse(text(exeDir, 'Emulators', '.playout', 'emulators.json')) as {
      presets: Record<string, number>
    }
    console.log(`presets applied: ${Object.keys(manifest.presets).sort().join(', ')}`)
    console.log(`notices: ${JSON.stringify((await service.status()).notices)}`)
    service.dispose()
  })
})
