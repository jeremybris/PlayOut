import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPresets, rpcs3InputConfig } from './rpcs3'
import type { PresetContext } from './types'

let dir: string
let E: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-rpcs3-'))
  E = join(dir, 'RPCS3')
  await mkdir(join(E, 'config'), { recursive: true })
  vi.clearAllMocks()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ctx(firstTime = true, previous?: number): PresetContext {
  return {
    emuDir: E,
    dataDir: join(dir, 'Emulation'),
    run: vi.fn(async () => ({ code: 1, stdout: '', stderr: '' })),
    log,
    firstTime,
    previousVersion: previous ?? (firstTime ? undefined : 3),
    startHidden: vi.fn(() => {
      throw new Error('never started')
    })
  }
}

const text = (p: string): Promise<string> => readFile(p, 'utf8')
const defaultYml = (): string => join(E, 'config', 'input_configs', 'global', 'Default.yml')
const settingsIni = (): string => join(E, 'GuiConfigs', 'CurrentSettings.ini')

describe('rpcs3 presets', () => {
  it('writes XInput Pad #1-#4 for players 1-4, with quoted devices and the Home menu on Start + Select', async () => {
    await applyPresets(ctx())
    const yml = await text(defaultYml())
    expect(yml).toBe(rpcs3InputConfig())
    expect(yml).toContain(
      'Player 1 Input:\n  Handler: XInput\n  Device: "XInput Pad #1"\n  Config:\n    PS Button: Start&Back\n'
    )
    expect(yml).toContain(
      'Player 4 Input:\n  Handler: XInput\n  Device: "XInput Pad #4"\n  Config:\n    PS Button: Start&Back\n'
    )
    expect(yml).not.toContain('Player 5')
    expect(yml).not.toContain('\r')
  })

  it('never replaces an existing pad configuration', async () => {
    await mkdir(join(E, 'config', 'input_configs', 'global'), { recursive: true })
    await writeFile(defaultYml(), 'Player 1 Input:\n  Handler: DualSense\n')
    await applyPresets(ctx())
    expect(await text(defaultYml())).toBe('Player 1 Input:\n  Handler: DualSense\n')
  })

  it('moves the Home menu off Guide on an install from presets version 1, once', async () => {
    await mkdir(join(E, 'config', 'input_configs', 'global'), { recursive: true })
    // The file version 1 wrote is upgraded as a whole.
    const legacy = rpcs3InputConfig().replace(/ {2}Config:\n {4}PS Button: Start&Back\n/g, '')
    await writeFile(defaultYml(), legacy)
    await applyPresets(ctx(false, 1))
    expect(await text(defaultYml())).toBe(rpcs3InputConfig())

    // One the Pad Settings dialog wrote: only a PS button still at RPCS3's default changes, in any order.
    const dialog =
      'Player 1 Input:\r\n  Handler: XInput\r\n  Device: XInput Pad #1\r\n  Config:\r\n    Start: Start\r\n    PS Button: Back&Start,Guide\r\n' +
      'Player 2 Input:\r\n  Handler: XInput\r\n  Config:\r\n    PS Button: LS&RS\r\n'
    await writeFile(defaultYml(), dialog)
    await applyPresets(ctx(false, 1))
    expect(await text(defaultYml())).toBe(
      dialog.replace('PS Button: Back&Start,Guide', 'PS Button: Start&Back')
    )
    // Version 2 already applied: a PS button set back to Guide stays.
    await writeFile(defaultYml(), dialog)
    await applyPresets(ctx(false, 2))
    expect(await text(defaultYml())).toBe(dialog)
  })

  it('leaves pads alone when another global profile is active, and writes Default when it is Default', async () => {
    const active = join(E, 'config', 'input_configs', 'active_input_configurations.yml')
    await mkdir(join(E, 'config', 'input_configs'), { recursive: true })
    await writeFile(active, 'Active Configurations:\n  global: "Mine"\n')
    await applyPresets(ctx())
    await expect(stat(defaultYml())).rejects.toThrow()

    await writeFile(active, 'Active Configurations:\n  global: Default\n')
    await applyPresets(ctx())
    expect(await text(defaultYml())).toBe(rpcs3InputConfig())
  })

  it('creates config.yml with Big Picture alone (RPCS3 fills in every other default), and only once', async () => {
    const yml = join(E, 'config', 'config.yml')
    await applyPresets(ctx())
    expect(await text(yml)).toBe('Miscellaneous:\n  Start Big Picture Mode on boot: true\n')
    // Not on a later run: a config.yml the user never opened stays absent.
    await rm(yml)
    await applyPresets(ctx(false))
    await expect(stat(yml)).rejects.toThrow()
  })

  it('turns fullscreen on in an existing config.yml only the first time, keeping every other line', async () => {
    const yml = join(E, 'config', 'config.yml')
    const original =
      'Core:\r\n  PPU Decoder: Recompiler (LLVM)\r\nMiscellaneous:\r\n  Automatically start games after boot: true\r\n  Start games in fullscreen mode: false\r\n  Show trophy popups: true\r\n'
    await writeFile(yml, original)
    await applyPresets(ctx(false))
    expect(await text(yml)).toBe(original)
    const expected = original
      .replace('fullscreen mode: false', 'fullscreen mode: true')
      .replace('Miscellaneous:\r\n', 'Miscellaneous:\r\n  Start Big Picture Mode on boot: true\r\n')
    await applyPresets(ctx(true))
    expect(await text(yml)).toBe(expected)
    await applyPresets(ctx(true))
    expect(await text(yml)).toBe(expected)
  })

  it('switches an existing Big Picture setting on, or adds the Miscellaneous section', async () => {
    const yml = join(E, 'config', 'config.yml')
    await writeFile(
      yml,
      'Miscellaneous:\n    Start Big Picture Mode on boot: false\n    Show trophy popups: true\n'
    )
    await applyPresets(ctx(false, 1))
    expect(await text(yml)).toBe(
      'Miscellaneous:\n    Start Big Picture Mode on boot: true\n    Show trophy popups: true\n'
    )
    await writeFile(yml, 'Core:\n  PPU Decoder: Interpreter (static)\n')
    await applyPresets(ctx(false, 1))
    expect(await text(yml)).toBe(
      'Core:\n  PPU Decoder: Interpreter (static)\nMiscellaneous:\n  Start Big Picture Mode on boot: true\n'
    )
  })

  it('switches the Welcome dialog off, merging into the GUI settings', async () => {
    await applyPresets(ctx())
    expect(await text(settingsIni())).toBe('[main_window]\r\ninfoBoxEnabledWelcome=false\r\n')

    await writeFile(
      settingsIni(),
      '[Meta]\r\ncurrentStylesheet=Darker Style by TheMitoSan\r\n\r\n[main_window]\r\ninfoBoxEnabledWelcome=true\r\ngeometry=@ByteArray(x)\r\n'
    )
    await applyPresets(ctx(false))
    await applyPresets(ctx(false))
    expect(await text(settingsIni())).toBe(
      '[Meta]\r\ncurrentStylesheet=Darker Style by TheMitoSan\r\n\r\n[main_window]\r\ninfoBoxEnabledWelcome=false\r\ngeometry=@ByteArray(x)\r\n'
    )
  })
})
