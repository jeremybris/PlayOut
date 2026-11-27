import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runner } from '../types'
import { applyPresets, KEYBOARD_PAD1 } from './pcsx2'
import { presetFixture, type PresetFixture } from './test-helpers'
import type { PresetContext } from './types'

let fx: PresetFixture
let emu: string
let ini: string

beforeEach(async () => {
  fx = await presetFixture('pcsx2')
  emu = join(fx.dir, 'emu')
  await mkdir(emu, { recursive: true })
  ini = join(emu, 'inis', 'PCSX2.ini')
})
afterEach(() => fx.cleanup())

const read = (): Promise<string> => readFile(ini, 'utf8')

/** A PCSX2.ini as `pcsx2-qt -testconfig` writes it (abridged; PCSX2 writes LF-terminated `Key = Value`). */
function pcsx2Default(ui = ['SettingsVersion = 1', 'SetupWizardIncomplete = true']): string {
  return [
    '[UI]',
    ...ui,
    'StartFullscreen = false',
    'StartBigPictureMode = false',
    '',
    '[EmuCore/Speedhacks]',
    'vuThread = true',
    '',
    '[InputSources]',
    'Keyboard = true',
    'SDL = true',
    'XInput = false',
    '',
    '[Pad1]',
    'Type = DualShock2',
    'Deadzone = 0',
    'AxisScale = 1.33',
    ...KEYBOARD_PAD1.map(([k, v]) => `${k} = ${v}`),
    '',
    '[Pad2]',
    'Type = None',
    '',
    '[Hotkeys]',
    'ToggleFullscreen = Keyboard/Alt & Keyboard/Return',
    ''
  ].join('\n')
}

function withRunner(firstTime: boolean, run: Runner): PresetContext {
  return { ...fx.ctx(firstTime), run: vi.fn(run) }
}

/** A runner that behaves like -testconfig: writes the default PCSX2.ini and exits 0. */
const testconfig: Runner = async () => {
  await mkdir(join(emu, 'inis'), { recursive: true })
  await writeFile(ini, pcsx2Default())
  return { code: 0, stdout: '', stderr: '' }
}

describe('PCSX2 presets', () => {
  it('lets PCSX2 generate its defaults, patches them, and is idempotent', async () => {
    const ctx = withRunner(true, testconfig)
    await applyPresets(ctx)
    expect(ctx.run).toHaveBeenCalledWith(join(emu, 'pcsx2-qt.exe'), ['-testconfig'], {
      cwd: emu,
      timeoutMs: 60_000
    })
    await stat(join(emu, 'portable.txt'))
    const text = await read()
    expect(text).toContain(
      '[UI]\nSettingsVersion = 1\nSetupWizardIncomplete = false\nStartFullscreen = true\n'
    )
    expect(text).toContain('[EmuCore/Speedhacks]\nvuThread = true\n')
    expect(text).toContain('Deadzone = 0\nAxisScale = 1.33\nUp = Keyboard/Up\nUp = SDL-0/DPadUp\n')
    expect(text).toContain('Cross = Keyboard/K\nCross = SDL-0/FaceSouth\n')
    expect(text).toContain('Analog = SDL-0/Guide\n')
    expect(text).toContain('[Pad2]\nType = DualShock2\nUp = SDL-1/DPadUp\n')
    expect(text).toContain('SmallMotor = SDL-1/SmallMotor\n\n[Hotkeys]\n')
    expect(text).not.toContain('\r')

    const again = withRunner(false, testconfig)
    await applyPresets(again)
    expect(again.run).not.toHaveBeenCalled()
    expect(await read()).toBe(text)
  })

  it('throws and writes nothing when -testconfig fails', async () => {
    const ctx = withRunner(true, async () => ({ code: 1, stdout: '', stderr: 'Qt failed' }))
    await expect(applyPresets(ctx)).rejects.toThrow(/exited with 1.*Qt failed/)
    await expect(stat(ini)).rejects.toThrow()
  })

  it('throws when -testconfig exits 0 without a valid PCSX2.ini', async () => {
    const ctx = withRunner(true, async () => ({ code: 0, stdout: '', stderr: '' }))
    await expect(applyPresets(ctx)).rejects.toThrow(/SettingsVersion/)
    await expect(stat(ini)).rejects.toThrow()
  })

  it('merges into an existing file without forcing fullscreen after the first-time setup', async () => {
    await mkdir(join(emu, 'inis'), { recursive: true })
    await writeFile(ini, pcsx2Default(['SettingsVersion = 1', 'SetupWizardIncomplete = false']))
    await applyPresets(fx.ctx(false))
    const text = await read()
    expect(text).toContain('StartFullscreen = false')
    expect(text).toContain('Cross = Keyboard/K\nCross = SDL-0/FaceSouth\n')
    expect(text).toContain('[Pad2]\nType = DualShock2\n')
  })

  it('clears an unfinished setup wizard on the first-time setup only', async () => {
    await mkdir(join(emu, 'inis'), { recursive: true })
    await writeFile(ini, pcsx2Default())
    await applyPresets(fx.ctx(false))
    expect(await read()).toContain('SetupWizardIncomplete = true')
    await applyPresets(fx.ctx(true))
    const text = await read()
    expect(text).toContain('SetupWizardIncomplete = false')
    expect(text).toContain('StartFullscreen = true')
  })

  it('leaves pads the user changed alone', async () => {
    await mkdir(join(emu, 'inis'), { recursive: true })
    const original = pcsx2Default().replace('Cross = Keyboard/K', 'Cross = SDL-0/A')
    await writeFile(ini, original)
    await applyPresets(fx.ctx(false))
    expect(await read()).toBe(original)
  })

  it('starts in Big Picture with the pause menu on Start + Select, once, on an install from presets version 1', async () => {
    await mkdir(join(emu, 'inis'), { recursive: true })
    const original = pcsx2Default(['SettingsVersion = 1', 'SetupWizardIncomplete = false']).replace(
      '[Hotkeys]\n',
      '[Hotkeys]\nOpenPauseMenu = Keyboard/Escape\n'
    )
    await writeFile(ini, original)
    await applyPresets(fx.ctx(false, 1))
    const text = await read()
    expect(text).toContain('StartBigPictureMode = true\n')
    // Next to Escape, never instead of it; the keyboard and pad bindings are both read (repeated keys are a list).
    expect(text).toContain(
      'OpenPauseMenu = Keyboard/Escape\nOpenPauseMenu = SDL-0/Back & SDL-0/Start\n'
    )
    expect(text).toContain('StartFullscreen = false\n')
    await applyPresets(fx.ctx(false, 1))
    expect(await read()).toBe(text)

    // After version 2, Big Picture turned off stays off; a pad menu binding the user chose is never doubled.
    const own = text
      .replace('StartBigPictureMode = true', 'StartBigPictureMode = false')
      .replace('OpenPauseMenu = SDL-0/Back & SDL-0/Start', 'OpenPauseMenu = SDL-0/LeftStick')
    await writeFile(ini, own)
    await applyPresets(fx.ctx(false, 2))
    expect(await read()).toBe(own)
    await applyPresets(fx.ctx(false, 1))
    expect(await read()).toBe(
      own.replace('StartBigPictureMode = false', 'StartBigPictureMode = true')
    )
  })

  it("applies the user's PCSX2 settings once, over PCSX2's defaults only", async () => {
    await mkdir(join(emu, 'inis'), { recursive: true })
    const original = pcsx2Default(['SettingsVersion = 1', 'SetupWizardIncomplete = false'])
      .replace('[EmuCore/Speedhacks]\n', '[EmuCore/Speedhacks]\nEECycleRate = 0\n')
      // Chosen by the user before: kept.
      .replace(
        '[InputSources]',
        '[EmuCore/GS]\nAspectRatio = 4:3\nupscale_multiplier = 1.000000\n\n[InputSources]'
      )
    await writeFile(ini, original)
    await applyPresets(fx.ctx(false, 2))
    const text = await read()
    expect(text).toContain('[UI]\nSettingsVersion = 1\nSetupWizardIncomplete = false\n')
    expect(text).toContain('ConfirmShutdown = false\n')
    expect(text).toContain('EECycleRate = 2\n')
    expect(text).toContain('AspectRatio = 4:3\n')
    // "1.000000" is PCSX2's default too.
    expect(text).toContain('upscale_multiplier = 3\n')
    for (const line of [
      'EnableCheats = true',
      'EnableWideScreenPatches = true',
      'EnableNoInterlacingPatches = true',
      'VsyncEnable = true',
      'FMVAspectRatioSwitch = Auto 4:3/3:2',
      'LoadTextureReplacements = true',
      'fxaa = true',
      'ShadeBoost = true',
      'pcrtc_antiblur = true',
      '[SPU2/Output]\nBufferMS = 30',
      '[Achievements]\nEnabled = true'
    ])
      expect(text).toContain(`${line}\n`)
    expect(text).not.toContain('AspectRatio = 16:9')

    // Applied: a later run changes nothing, and a value turned back afterwards stays.
    await applyPresets(fx.ctx(false, 3))
    expect(await read()).toBe(text)
    await writeFile(ini, text.replace('VsyncEnable = true', 'VsyncEnable = false'))
    await applyPresets(fx.ctx(false, 3))
    expect(await read()).toContain('VsyncEnable = false\n')
  })

  it('leaves a file without SettingsVersion = 1 for PCSX2 to reset', async () => {
    await mkdir(join(emu, 'inis'), { recursive: true })
    const original = pcsx2Default(['SetupWizardIncomplete = true'])
    await writeFile(ini, original)
    const ctx = fx.ctx(true)
    await applyPresets(ctx)
    expect(await read()).toBe(original)
    expect(ctx.log.warn).toHaveBeenCalled()
    expect(ctx.run).not.toHaveBeenCalled()
  })
})
