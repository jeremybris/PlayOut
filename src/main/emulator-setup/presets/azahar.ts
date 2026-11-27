import { join } from 'path'
import { readIniSection, setIniValues } from '../ini'
import { iniValue } from './keys'
import type { ApplyPresets } from './types'

/**
 * Azahar 2126.2 (portable: `<E>\user\config\qt-config.ini`, a QSettings INI; `config` is a real folder, the other
 * `user` subfolders are junctions).
 *
 * QSettings stores each setting as `name\default=<bool>` plus `name=<value>`, and Azahar returns the DEFAULT whenever
 * `\default` is true, so both lines are written (EmuDeck-WE's `fullscreen\default=true` never takes effect). Values
 * with commas are double-quoted, or QSettings would read a string list. Keys keep literal backslashes.
 *
 * Fullscreen: `[UI] fullscreen=true` (BootGame calls ShowFullscreen()), the first time only, when the key is absent or
 * still flagged default. An explicit `fullscreen\default=false` + `fullscreen=false` is the user's choice.
 *
 * Controller: profile 1 of `[Controls]` gets the SDL GameController-API bindings Azahar's own Auto-Map produces (its
 * xinput_to_3ds_mapping table: positional Xbox layout, 3DS A = SDL B), with map type "All controllers" so no device
 * GUID is needed (any connected pad drives the single 3DS player). Written only while profile 1 is still unmapped
 * (every binding absent, empty or flagged default) and the selected profile is the first one, so a keyboard layout the
 * user customised, or profile 1 while another profile is in use, is never replaced. The user's other profiles, the
 * selected profile and debug/gpio14/power/motion/touch stay.
 */

/** Bindings of the SDL GameController API for every connected pad (`maptype:all`, guid and port ignored). */
const button = (n: number): string =>
  `"api:controller,button:${n},engine:sdl,guid:0,maptype:all,port:0"`
const trigger = (axis: number): string =>
  `"api:controller,axis:${axis},direction:+,engine:sdl,guid:0,maptype:all,port:0,threshold:0.500000"`
const stick = (x: number, y: number): string =>
  `"api:controller,axis_x:${x},axis_y:${y},deadzone:0.100000,engine:sdl,guid:0,maptype:all,port:0"`

/** Profile 1's bindings (SDL_GameControllerButton / SDL_GameControllerAxis numbers). */
export const AZAHAR_BINDINGS: Record<string, string> = {
  button_a: button(1),
  button_b: button(0),
  button_x: button(3),
  button_y: button(2),
  button_up: button(11),
  button_down: button(12),
  button_left: button(13),
  button_right: button(14),
  button_l: button(9),
  button_r: button(10),
  button_start: button(6),
  button_select: button(4),
  button_zl: trigger(4),
  button_zr: trigger(5),
  button_home: button(5),
  circle_pad: stick(0, 1),
  c_stick: stick(2, 3)
}

const P1 = 'profiles\\1\\'

/** Whether QSettings marks `name` as default (its value is then ignored). */
const flaggedDefault = (lines: string[] | null, name: string): boolean =>
  iniValue(lines, `${name}\\default`)?.toLowerCase() === 'true'

/**
 * Whether profile 1 of `[Controls]` already holds a mapping the user made: any binding with a non-empty value that is
 * not flagged default, whatever its engine (a customised keyboard layout counts too). Profile 1 is unmapped only when
 * every binding is absent, empty or flagged default.
 */
export function hasControllerMapping(controls: string[] | null): boolean {
  const size = Number(iniValue(controls, 'profiles\\size') ?? '0')
  // Without the profiles array Azahar creates a fresh keyboard profile and ignores every other key.
  if (!(size >= 1)) return false
  return Object.keys(AZAHAR_BINDINGS).some((key) => {
    const name = `${P1}${key}`
    const value = iniValue(controls, name)
    return value !== undefined && value !== '' && !flaggedDefault(controls, name)
  })
}

/** Whether a profile other than profile 1 (index 0) is selected; profile 1 is then left alone. */
export function otherProfileSelected(controls: string[] | null): boolean {
  const profile = iniValue(controls, 'profile')
  if (profile === undefined || profile === '' || flaggedDefault(controls, 'profile')) return false
  return Number(profile) !== 0
}

export const applyPresets: ApplyPresets = async (ctx) => {
  const ini = join(ctx.emuDir, 'user', 'config', 'qt-config.ini')
  const tight = { style: 'tight' } as const

  if (ctx.firstTime) {
    const ui = await readIniSection(ini, 'UI')
    if (iniValue(ui, 'fullscreen') === undefined || flaggedDefault(ui, 'fullscreen')) {
      await setIniValues(ini, 'UI', { 'fullscreen\\default': 'false', fullscreen: 'true' }, tight)
    }
  }

  // Needed for fullscreen: with a newer release out, a modal "Update Available" box opens over the game at start.
  // PlayOut installs the emulator versions itself. Only set when the user never chose (key absent).
  const misc = await readIniSection(ini, 'Miscellaneous')
  if (iniValue(misc, 'check_for_update_on_start') === undefined) {
    await setIniValues(
      ini,
      'Miscellaneous',
      { 'check_for_update_on_start\\default': 'false', check_for_update_on_start: 'false' },
      tight
    )
  }

  const controls = await readIniSection(ini, 'Controls')
  if (hasControllerMapping(controls) || otherProfileSelected(controls)) return
  const values: Record<string, string> = {}
  // Keep the selected profile and any further profiles; never shrink the array.
  if (iniValue(controls, 'profile') === undefined) {
    values['profile\\default'] = 'true'
    values.profile = '0'
  }
  const size = Number(iniValue(controls, 'profiles\\size') ?? '0')
  if (!(size >= 1)) values['profiles\\size'] = '1'
  if (iniValue(controls, `${P1}name`) === undefined) {
    values[`${P1}name\\default`] = 'false'
    values[`${P1}name`] = 'Default'
  }
  // 0 = All controllers (InputMappingType), so the UI shows the same choice the bindings use.
  values[`${P1}input_maptype\\default`] = 'false'
  values[`${P1}input_maptype`] = '0'
  for (const [key, value] of Object.entries(AZAHAR_BINDINGS)) {
    values[`${P1}${key}\\default`] = 'false'
    values[`${P1}${key}`] = value
  }
  await setIniValues(ini, 'Controls', values, tight)
}
