import { join } from 'path'
import { readIniSection, setIniValues } from '../ini'
import { iniValue } from './keys'
import type { ApplyPresets } from './types'

/**
 * ScummVM (portable `scummvm.ini` next to scummvm.exe; a partial file is safe, every other key has a registered
 * default).
 *
 * Fullscreen: `[scummvm] fullscreen=true` (default windowed). ScummVM writes the file back on exit, so it is set only
 * the first time. Per-game sections are not touched.
 *
 * First-run dialog: with no `updates_check` key the Windows build shows a modal "check for updates?" dialog at every
 * start, before the game, which interrupts the fullscreen launch. It is suppressed with `updates_check=0` (never),
 * written only while the key is absent, so a user's answer is kept.
 *
 * Controller: ScummVM already opens SDL joystick 0 as a GameController by default (`joystick_num` defaults to 0) and
 * its keymapper binds the pad's buttons natively; it supports one controller only. The default is only written out
 * when the key is absent, so a user's -1 (disabled) is kept.
 */
export const applyPresets: ApplyPresets = async (ctx) => {
  const ini = join(ctx.emuDir, 'scummvm.ini')
  const section = await readIniSection(ini, 'scummvm')
  const values: Record<string, string> = {}
  if (ctx.firstTime) values.fullscreen = 'true'
  if (iniValue(section, 'updates_check') === undefined) values.updates_check = '0'
  if (iniValue(section, 'joystick_num') === undefined) values.joystick_num = '0'
  if (Object.keys(values).length > 0) {
    await setIniValues(ini, 'scummvm', values, { style: 'tight' })
  }
}
