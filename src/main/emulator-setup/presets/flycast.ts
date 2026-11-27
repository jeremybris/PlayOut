import { join } from 'path'
import { readIniSection, setIniValues } from '../ini'
import { iniValue } from './keys'
import type { ApplyPresets } from './types'

/**
 * Flycast 2.7 (`emu.cfg` next to flycast.exe; a partial file is safe, every missing key takes its code default).
 *
 * Fullscreen: `[window] fullscreen = yes` (SDL_WINDOW_FULLSCREEN_DESKTOP). Flycast saves the window state on exit, so
 * it is set only the first time.
 *
 * Controller: Flycast already maps any SDL GameController (XInput pads included) by itself (DefaultInputMapping) and
 * puts SDL joystick 0-3 on maple ports A-D, so no mapping file is written. What is missing for players 2-4 is a
 * Dreamcast controller in ports B-D: device2-4 default to None (10). They are set to Sega Controller (0), as
 * Settings > Controls would; the VMU sub-slots (deviceN.1/.2) stay None. A key the user set is kept: an absent key is
 * always filled, the default None only the first time (Flycast writes every key on exit). NAOMI/Atomiswave read all
 * four ports through JVS and ignore these keys.
 */

/** Flycast's MDT_SegaController / MDT_None maple device types. */
const SEGA_CONTROLLER = '0'
const NONE = '10'

export const applyPresets: ApplyPresets = async (ctx) => {
  const cfg = join(ctx.emuDir, 'emu.cfg')
  if (ctx.firstTime) {
    await setIniValues(cfg, 'window', { fullscreen: 'yes' }, { style: 'spaced' })
  }
  const input = await readIniSection(cfg, 'input')
  const ports: Record<string, string> = {}
  for (const key of ['device2', 'device3', 'device4']) {
    const value = iniValue(input, key)
    if (value === undefined || (ctx.firstTime && value === NONE)) ports[key] = SEGA_CONTROLLER
  }
  if (Object.keys(ports).length > 0) {
    await setIniValues(cfg, 'input', ports, { style: 'spaced' })
  }
}
