import { promises as fs } from 'fs'
import { join } from 'path'
import { setRetroArchCfg } from '../ini'
import { BIG_PICTURE_VERSION, newSince } from './big-picture'
import { readLines } from './keys'
import type { ApplyPresets } from './types'

/**
 * RetroArch 1.22 (portable `retroarch.cfg` next to retroarch.exe; a partial file is safe, RetroArch writes the full
 * file on exit).
 *
 * Fullscreen: `video_fullscreen = "true"` (the plain Windows build defaults to windowed; video_windowed_fullscreen
 * stays at its default, borderless). Saved on exit, so it is set only the first time.
 *
 * Controller: the Windows build already maps Xbox pads on ports 1-4 by itself: the joypad driver defaults to xinput
 * and autoconfig (on by default) applies the shipped autoconfig\xinput profiles, or the built-in "XInput Controller"
 * one. Those defaults are only written out when the keys are absent, so a driver the user picked is kept. No
 * input_playerN_* binds are written: they would override autoconfig.
 *
 * Menu (big-picture.ts): Start + Select opens the Quick Menu, Guide no longer does (it is PlayOut's home button), and
 * Close Content quits back to PlayOut. Each only while still RetroArch's default, and only once.
 */
/**
 * Pads 2-8 cannot override the menu button in retroarch.cfg: RetroArch reads it from the pad's autoconfig profile on
 * every port (input_driver.c, "Read autoconf menu toggle regardless of 'enable_hotkey'"), and the shipped XInput
 * profiles put it on Guide ("10"). Those lines become "nul"; every other line stays. Returns how many files changed.
 * A pad that matches no profile file uses RetroArch's built-in "XInput Controller" profile, which keeps Guide.
 */
export async function freeGuideInProfiles(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  let changed = 0
  for (const name of names) {
    if (!/\.cfg$/i.test(name)) continue
    const file = join(dir, name)
    const text = await fs.readFile(file, 'utf8')
    const next = text.replace(/^([ \t]*input_menu_toggle_btn[ \t]*=[ \t]*)"10"/gm, '$1"nul"')
    if (next === text) continue
    await fs.writeFile(file, next, 'utf8')
    changed++
  }
  return changed
}

export const applyPresets: ApplyPresets = async (ctx) => {
  const cfg = join(ctx.emuDir, 'retroarch.cfg')
  const current = new Map<string, string>()
  for (const l of (await readLines(cfg)) ?? []) {
    const m = /^\s*([^\s=#]+)\s*=\s*"?(.*?)"?\s*$/.exec(l)
    if (m && !current.has(m[1])) current.set(m[1], m[2])
  }
  const values: Record<string, string> = {}
  if (ctx.firstTime) values.video_fullscreen = 'true'
  if (!current.has('input_joypad_driver')) values.input_joypad_driver = 'xinput'
  if (!current.has('input_autodetect_enable')) values.input_autodetect_enable = 'true'
  // The Quick Menu on Start + Select, once, for each key still absent or at RetroArch's default.
  if (newSince(ctx, BIG_PICTURE_VERSION)) {
    const atDefault = (key: string, def: string): boolean => (current.get(key) ?? def) === def
    // 4 = Start + Select (input_defines.h).
    if (atDefault('input_menu_toggle_gamepad_combo', '0')) {
      values.input_menu_toggle_gamepad_combo = '4'
    }
    // Guide stays PlayOut's home button. "nul" falls back to the autoconfig's Guide; an index no pad has never fires.
    if (atDefault('input_menu_toggle_btn', 'nul')) values.input_menu_toggle_btn = '99'
    // Close Content in the Quick Menu quits RetroArch when PlayOut started the game (2: command-line content only).
    if (atDefault('quit_on_close_content', '0')) values.quit_on_close_content = '2'
    const freed = await freeGuideInProfiles(join(ctx.emuDir, 'autoconfig', 'xinput'))
    if (freed > 0)
      ctx.log.info(`RetroArch: Guide no longer opens the menu in ${freed} pad profiles`)
  }
  if (Object.keys(values).length > 0) await setRetroArchCfg(cfg, values)
}
