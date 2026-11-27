import { join } from 'path'
import { setMameIni } from '../ini'
import { readLines } from './keys'
import type { ApplyPresets } from './types'

/**
 * MAME 0.289 (portable `mame.ini` next to mame.exe, made by `mame -createconfig` in configure.ts).
 *
 * Fullscreen: MAME is already fullscreen by default (`window 0`). It is written out the first time, so a missing or
 * partial mame.ini still gets it; a later `window 1` of the user's is kept.
 *
 * Controller: MAME already maps XInput pads by itself: `joystick 1` is the default, and `joystickprovider auto` is
 * winhybrid on Windows (XInput pads through XInput, others through DirectInput), with each pad's buttons, Start,
 * Back (coin), stick and D-pad going to player N. Those two defaults are only written out when absent. No
 * cfg/default.cfg is written: MAME's built-in per-device assignments are what MAME itself uses.
 */
export const applyPresets: ApplyPresets = async (ctx) => {
  const ini = join(ctx.emuDir, 'mame.ini')
  const present = new Set(
    ((await readLines(ini)) ?? [])
      .map((l) => l.trim())
      .filter((t) => t !== '' && !t.startsWith('#'))
      .map((t) => t.split(/\s/, 1)[0])
  )
  const values: Record<string, string> = {}
  if (ctx.firstTime) values.window = '0'
  if (!present.has('joystick')) values.joystick = '1'
  if (!present.has('joystickprovider')) values.joystickprovider = 'auto'
  if (Object.keys(values).length > 0) await setMameIni(ini, values)
}
