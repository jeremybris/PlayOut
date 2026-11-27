import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPresets } from './retroarch'
import { presetFixture, type PresetFixture } from './test-helpers'

let fx: PresetFixture
let cfg: string
beforeEach(async () => {
  fx = await presetFixture('retroarch')
  cfg = join(fx.ctx(true).emuDir, 'retroarch.cfg')
  await mkdir(join(fx.dir, 'emu'), { recursive: true })
})
afterEach(() => fx.cleanup())

describe('RetroArch presets', () => {
  it('turns on fullscreen and writes the pad defaults into a partial cfg', async () => {
    await writeFile(cfg, 'system_directory = "D:\\bios"\r\n')
    await applyPresets(fx.ctx(true))
    expect(await readFile(cfg, 'utf8')).toBe(
      [
        'system_directory = "D:\\bios"',
        'video_fullscreen = "true"',
        'input_joypad_driver = "xinput"',
        'input_autodetect_enable = "true"',
        'input_menu_toggle_gamepad_combo = "4"',
        'input_menu_toggle_btn = "99"',
        'quit_on_close_content = "2"',
        ''
      ].join('\r\n')
    )
  })

  it('keeps a driver the user picked and a later fullscreen choice', async () => {
    const saved = [
      'video_fullscreen = "false"',
      'input_joypad_driver = "dinput"',
      'input_autodetect_enable = "false"',
      'input_menu_toggle_gamepad_combo = "2"',
      'input_menu_toggle_btn = "10"',
      'quit_on_close_content = "1"',
      ''
    ].join('\r\n')
    await writeFile(cfg, saved)
    await applyPresets(fx.ctx(false))
    expect(await readFile(cfg, 'utf8')).toBe(saved)
    // A menu combo, menu button and close behaviour the user picked stay even on the Big Picture run.
    await applyPresets(fx.ctx(true))
    expect(await readFile(cfg, 'utf8')).toBe(saved.replace('"false"', '"true"'))
  })

  it('moves the Quick Menu to Start + Select on an install from presets version 1, once', async () => {
    // What RetroArch writes out itself: every key present, at its default.
    const saved = [
      'video_fullscreen = "true"',
      'input_joypad_driver = "xinput"',
      'input_autodetect_enable = "true"',
      'input_menu_toggle_btn = "nul"',
      'input_menu_toggle_gamepad_combo = "0"',
      'input_quit_gamepad_combo = "0"',
      'quit_on_close_content = "0"',
      ''
    ].join('\r\n')
    await writeFile(cfg, saved)
    await applyPresets(fx.ctx(false, 1))
    const text = await readFile(cfg, 'utf8')
    expect(text).toContain('input_menu_toggle_gamepad_combo = "4"')
    expect(text).toContain('input_menu_toggle_btn = "99"')
    expect(text).toContain('quit_on_close_content = "2"')
    // The quit combo stays off: Start + Select is the menu, never a quit.
    expect(text).toContain('input_quit_gamepad_combo = "0"')
    // Version 2 already applied: a user who set the combo back to none keeps it.
    await writeFile(cfg, saved)
    await applyPresets(fx.ctx(false, 2))
    expect(await readFile(cfg, 'utf8')).toBe(saved)
  })

  it('takes Guide off the menu in the shipped XInput pad profiles, once, keeping every other line', async () => {
    const dir = join(fx.dir, 'emu', 'autoconfig', 'xinput')
    await mkdir(dir, { recursive: true })
    const profile = [
      'input_driver = "xinput"',
      'input_device = "Xbox 360 Wireless Controller"',
      'input_start_btn = "4"',
      'input_menu_toggle_btn = "10"',
      'input_menu_toggle_btn_label = "Guide"',
      ''
    ].join('\r\n')
    const other = 'input_device = "Pad"\r\ninput_menu_toggle_btn = "8"\r\n'
    await writeFile(join(dir, 'Xbox 360 Wireless Controller.cfg'), profile)
    await writeFile(join(dir, 'Pad.cfg'), other)
    await applyPresets(fx.ctx(false, 1))
    expect(await readFile(join(dir, 'Xbox 360 Wireless Controller.cfg'), 'utf8')).toBe(
      profile.replace('input_menu_toggle_btn = "10"', 'input_menu_toggle_btn = "nul"')
    )
    // A menu button that is not Guide stays.
    expect(await readFile(join(dir, 'Pad.cfg'), 'utf8')).toBe(other)
    // Not again after version 2 (RetroArch's "Update Controller Profiles" may bring Guide back; the user's call).
    await writeFile(join(dir, 'Xbox 360 Wireless Controller.cfg'), profile)
    await applyPresets(fx.ctx(false, 2))
    expect(await readFile(join(dir, 'Xbox 360 Wireless Controller.cfg'), 'utf8')).toBe(profile)
  })

  it('is idempotent', async () => {
    await applyPresets(fx.ctx(true))
    const once = await readFile(cfg, 'utf8')
    await applyPresets(fx.ctx(true))
    expect(await readFile(cfg, 'utf8')).toBe(once)
  })
})
