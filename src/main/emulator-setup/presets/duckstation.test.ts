import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPresets, KEYBOARD_PAD1, seedSettings } from './duckstation'
import { presetFixture, type PresetFixture } from './test-helpers'

let fx: PresetFixture
let file: string

beforeEach(async () => {
  fx = await presetFixture('duckstation')
  await mkdir(join(fx.dir, 'emu'), { recursive: true })
  await writeFile(join(fx.dir, 'emu', 'portable.txt'), '')
  file = join(fx.dir, 'emu', 'settings.ini')
})
afterEach(() => fx.cleanup())

const read = (): Promise<string> => readFile(file, 'utf8')

/** A settings.ini as DuckStation writes it after its own first run (keys sorted, CRLF, defaults). */
function duckstationDefault(pad1Extra: string[] = [], pad2 = ['Type = None']): string {
  const pad1 = ['Type = AnalogController', ...KEYBOARD_PAD1.map(([k, v]) => `${k} = ${v}`)]
  pad1.sort()
  return [
    '[Main]',
    'SettingsVersion = 3',
    'SetupWizardIncomplete = false',
    'StartFullscreen = false',
    'ConfirmPowerOff = true',
    '',
    '[InputSources]',
    'SDL = true',
    'XInput = false',
    '',
    '[Pad1]',
    ...pad1,
    ...pad1Extra,
    '',
    '[Pad2]',
    ...pad2,
    '',
    '[Hotkeys]',
    'TogglePause = Keyboard/Space',
    ''
  ].join('\r\n')
}

describe('DuckStation presets', () => {
  it('writes the complete seed when settings.ini is missing, and is idempotent', async () => {
    await applyPresets(fx.ctx(true))
    const text = await read()
    expect(text).toBe(seedSettings(true))
    expect(text).toContain('[Main]\nSetupWizardIncomplete = false\nStartFullscreen = true\n')
    expect(text).toContain('Up = Keyboard/UpArrow\nUp = SDL-0/DPadUp\n')
    expect(text).toContain('Cross = Keyboard/K\nCross = SDL-0/A\n')
    expect(text).toContain('Analog = SDL-0/Guide\n')
    expect(text).toContain('[Pad2]\nType = AnalogController\nUp = SDL-1/DPadUp\n')
    expect(text).toContain('SmallMotor = SDL-1/SmallMotor\n')
    expect(text).toContain('[Pad3]\nType = None\n')
    expect(text).toContain('[Hotkeys]\nFastForward = Keyboard/Tab\n')
    expect(text).not.toContain('Up = Keyboard/UpArrow\nUp = SDL-0/DPadUp\nUp')
    expect(fx.ctx(true).run).not.toHaveBeenCalled()

    await applyPresets(fx.ctx(false))
    expect(await read()).toBe(text)
  })

  it('leaves StartFullscreen out of the seed when it is not the first-time setup', async () => {
    await applyPresets(fx.ctx(false))
    const text = await read()
    expect(text).not.toContain('StartFullscreen =')
    expect(text).toContain('SetupWizardIncomplete = false')
    // Big Picture and its Start + Select menu are part of every seed.
    expect(text).toContain('StartFullscreenUI = true')
    expect(text).toContain(
      'OpenPauseMenu = Keyboard/Escape\nOpenPauseMenu = SDL-0/Back & SDL-0/Start\n'
    )
  })

  it('merges into a default settings.ini DuckStation already wrote', async () => {
    await writeFile(file, duckstationDefault())
    await applyPresets(fx.ctx(true))
    const text = await read()
    expect(text).toContain('StartFullscreen = true\r\n')
    expect(text).toContain('ConfirmPowerOff = true\r\n')
    expect(text).toContain('Up = Keyboard/UpArrow\r\nUp = SDL-0/DPadUp\r\n')
    expect(text).toContain('LargeMotor = SDL-0/LargeMotor\r\n')
    expect(text).toContain('[Pad2]\r\nType = AnalogController\r\nUp = SDL-1/DPadUp\r\n')
    expect(text).toContain('[Hotkeys]\r\nTogglePause = Keyboard/Space\r\n')
    expect(text).not.toMatch(/(^|[^\r])\n/)
    // The keyboard bindings are all kept.
    for (const [k, v] of KEYBOARD_PAD1) expect(text).toContain(`${k} = ${v}\r\n`)

    await applyPresets(fx.ctx(false))
    expect(await read()).toBe(text)

    // The user turns fullscreen off: a later (not first-time) run keeps it off.
    await writeFile(file, text.replace('StartFullscreen = true', 'StartFullscreen = false'))
    await applyPresets(fx.ctx(false))
    expect(await read()).toContain('StartFullscreen = false')
  })

  it('does not touch controllers the user changed, but still sets fullscreen', async () => {
    const original = duckstationDefault().replace('Cross = Keyboard/K', 'Cross = Keyboard/Z')
    await writeFile(file, original)
    await applyPresets(fx.ctx(true))
    const text = await read()
    // The pads stay as the user set them; fullscreen, Big Picture and the menu hotkey are still set.
    expect(text).toContain('Cross = Keyboard/Z\r\n')
    expect(text).not.toContain('SDL-0/A')
    expect(text).toContain('StartFullscreen = true\r\n')
    expect(text).toContain('StartFullscreenUI = true\r\n')
    expect(text).toContain('OpenPauseMenu = SDL-0/Back & SDL-0/Start\r\n')
  })

  it('turns on Big Picture and the Start + Select menu on an install from presets version 1, once', async () => {
    await writeFile(file, duckstationDefault())
    await applyPresets(fx.ctx(false, 1))
    const text = await read()
    expect(text).toContain('StartFullscreenUI = true\r\n')
    // No OpenPauseMenu line yet in this [Hotkeys]: the pad binding is added at the end of the section.
    expect(text).toContain(
      '[Hotkeys]\r\nTogglePause = Keyboard/Space\r\nOpenPauseMenu = SDL-0/Back & SDL-0/Start\r\n'
    )
    expect(text).not.toContain('StartFullscreen = true')
    await applyPresets(fx.ctx(false, 1))
    expect(await read()).toBe(text)
    // A pad binding the user gave the menu stays, and so does Big Picture turned off after version 2.
    const own = text
      .replace('OpenPauseMenu = SDL-0/Back & SDL-0/Start', 'OpenPauseMenu = SDL-0/Guide')
      .replace('StartFullscreenUI = true', 'StartFullscreenUI = false')
    await writeFile(file, own)
    await applyPresets(fx.ctx(false, 1))
    expect(await read()).toBe(own.replace('StartFullscreenUI = false', 'StartFullscreenUI = true'))
    await writeFile(file, own)
    await applyPresets(fx.ctx(false, 2))
    expect(await read()).toBe(own)
  })

  it('does not touch a pad already bound to a controller', async () => {
    const original = duckstationDefault(['Cross = SDL-030000005e040000/A'])
    await writeFile(file, original)
    await applyPresets(fx.ctx(false))
    expect(await read()).toBe(original)
  })

  it('does not bind pads when the SDL source is off', async () => {
    const original = duckstationDefault().replace('SDL = true', 'SDL = false')
    await writeFile(file, original)
    await applyPresets(fx.ctx(false))
    expect(await read()).toBe(original)
  })

  it('binds port 1 only when port 2 is in use', async () => {
    await writeFile(
      file,
      duckstationDefault([], ['Type = DigitalController', 'Cross = Keyboard/Numpad2'])
    )
    await applyPresets(fx.ctx(false))
    const text = await read()
    expect(text).toContain('Cross = Keyboard/K\r\nCross = SDL-0/A\r\n')
    expect(text).toContain('[Pad2]\r\nType = DigitalController\r\nCross = Keyboard/Numpad2\r\n')
    expect(text).not.toContain('SDL-1')
  })

  it('clears the setup wizard only when it would block the launch', async () => {
    // A very old file with neither key: DuckStation would run the wizard.
    await writeFile(file, '[Main]\r\nConfirmPowerOff = true\r\n')
    await applyPresets(fx.ctx(false))
    expect(await read()).toContain('SetupWizardIncomplete = false')

    // An unfinished wizard is cleared on the first-time setup only.
    const unfinished = duckstationDefault().replace(
      'SetupWizardIncomplete = false',
      'SetupWizardIncomplete = true'
    )
    await writeFile(file, unfinished)
    await applyPresets(fx.ctx(false))
    expect(await read()).toContain('SetupWizardIncomplete = true')
    await applyPresets(fx.ctx(true))
    expect(await read()).toContain('SetupWizardIncomplete = false')
  })
})
