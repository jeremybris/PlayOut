import { join } from 'path'
import { readIniSection, replaceIniSection, setIniValues } from '../ini'
import { iniValue } from './keys'
import type { ApplyPresets } from './types'

/**
 * Dolphin 2609b (portable: `<E>\User\Config\*.ini`).
 *
 * Fullscreen: `Dolphin.ini [Display] Fullscreen = True` (MAIN_FULLSCREEN; a booted game switches its render window to
 * fullscreen, also with PlayOut's `-b -e`). Dolphin saves only keys that differ from the default, so the key is
 * written only the first time and only when absent: an existing `Fullscreen = False` is the user's choice.
 *
 * Controllers: Dolphin has no desktop gamepad defaults (GCPad/Wiimote LoadDefaults map only the keyboard and mouse),
 * so the XInput mapping is written. XInput device names are fixed (`XInput/<n>/Gamepad`), SDL ones carry the product
 * name, so XInput is used, as EmuDeck-WE does. GameCube pads 1-4 use XInput 0-3 with the positional layout (GC B, left
 * of A, is Xbox X). Wii Remotes 1-4 get the same pads with a Nunchuk (the default extension) and a Classic Controller mapping.
 * A `[GCPadN]` / `[WiimoteN]` section is replaced only when it is missing or still Dolphin's untouched default
 * (keyboard device with the keyboard default mapping, or nothing mapped); a section the user changed stays.
 * Players 2-4: GC ports 2-4 are off by default (SIDevice1-3 = 0), so a port is switched to a GC controller (6) when
 * its pad section is written and the key is absent. Wiimote Source keys stay as they are (Wiimote 1 emulated, 2-4
 * none by default).
 */

const DEVICE = (n: number): string => `XInput/${n}/Gamepad`

/** The XInput GameCube pad mapping (research: Dolphin.json, File 1), without the Device line. */
export const GC_PAD_LINES: readonly string[] = [
  'Buttons/A = `Button A`',
  'Buttons/B = `Button X`',
  'Buttons/X = `Button B`',
  'Buttons/Y = `Button Y`',
  'Buttons/Z = `Shoulder R`',
  'Buttons/Start = Start',
  'Main Stick/Up = `Left Y+`',
  'Main Stick/Down = `Left Y-`',
  'Main Stick/Left = `Left X-`',
  'Main Stick/Right = `Left X+`',
  'Main Stick/Modifier = `Thumb L`',
  'C-Stick/Up = `Right Y+`',
  'C-Stick/Down = `Right Y-`',
  'C-Stick/Left = `Right X-`',
  'C-Stick/Right = `Right X+`',
  'C-Stick/Modifier = `Thumb R`',
  'Triggers/L = `Trigger L`',
  'Triggers/R = `Trigger R`',
  'Triggers/L-Analog = `Trigger L`',
  'Triggers/R-Analog = `Trigger R`',
  'D-Pad/Up = `Pad N`',
  'D-Pad/Down = `Pad S`',
  'D-Pad/Left = `Pad W`',
  'D-Pad/Right = `Pad E`',
  // EmuDeck's `Rumble/Motor = Strong` is not an XInput output; the outputs are Motor L and Motor R.
  'Rumble/Motor = `Motor L` | `Motor R`'
]

/** The XInput Wii Remote mapping (research: Dolphin.json, File 2), without the Device, Source and Extension lines. */
export const WIIMOTE_LINES: readonly string[] = [
  'Buttons/A = `Button A`',
  'Buttons/B = `Trigger R`',
  'Buttons/1 = `Button X`',
  'Buttons/2 = `Button Y`',
  'Buttons/- = Back',
  'Buttons/+ = Start',
  'Buttons/Home = Guide',
  'D-Pad/Up = `Pad N`',
  'D-Pad/Down = `Pad S`',
  'D-Pad/Left = `Pad W`',
  'D-Pad/Right = `Pad E`',
  'IR/Up = `Right Y+`',
  'IR/Down = `Right Y-`',
  'IR/Left = `Right X-`',
  'IR/Right = `Right X+`',
  'Shake/X = `Shoulder R`',
  'Shake/Y = `Shoulder R`',
  'Shake/Z = `Shoulder R`',
  'Rumble/Motor = `Motor L` | `Motor R`',
  'Nunchuk/Buttons/C = `Shoulder L`',
  'Nunchuk/Buttons/Z = `Trigger L`',
  'Nunchuk/Stick/Up = `Left Y+`',
  'Nunchuk/Stick/Down = `Left Y-`',
  'Nunchuk/Stick/Left = `Left X-`',
  'Nunchuk/Stick/Right = `Left X+`',
  'Nunchuk/Shake/X = `Thumb L`',
  'Nunchuk/Shake/Y = `Thumb L`',
  'Nunchuk/Shake/Z = `Thumb L`',
  'Classic/Buttons/A = `Button B`',
  'Classic/Buttons/B = `Button A`',
  'Classic/Buttons/X = `Button Y`',
  'Classic/Buttons/Y = `Button X`',
  'Classic/Buttons/ZL = `Shoulder L`',
  'Classic/Buttons/ZR = `Shoulder R`',
  'Classic/Buttons/- = Back',
  'Classic/Buttons/+ = Start',
  'Classic/Buttons/Home = Guide',
  'Classic/Left Stick/Up = `Left Y+`',
  'Classic/Left Stick/Down = `Left Y-`',
  'Classic/Left Stick/Left = `Left X-`',
  'Classic/Left Stick/Right = `Left X+`',
  'Classic/Right Stick/Up = `Right Y+`',
  'Classic/Right Stick/Down = `Right Y-`',
  'Classic/Right Stick/Left = `Right X-`',
  'Classic/Right Stick/Right = `Right X+`',
  'Classic/Triggers/L = `Trigger L`',
  'Classic/Triggers/R = `Trigger R`',
  'Classic/Triggers/L-Analog = `Trigger L`',
  'Classic/Triggers/R-Analog = `Trigger R`',
  'Classic/D-Pad/Up = `Pad N`',
  'Classic/D-Pad/Down = `Pad S`',
  'Classic/D-Pad/Left = `Pad W`',
  'Classic/D-Pad/Right = `Pad E`'
]

/** Dolphin's Windows keyboard defaults for a GameCube pad (GCPad::LoadDefaults). */
const GC_KEYBOARD_DEFAULTS: Record<string, string> = {
  'Buttons/A': 'X',
  'Buttons/B': 'Z',
  'Buttons/X': 'C',
  'Buttons/Y': 'S',
  'Buttons/Z': 'D',
  'Buttons/Start': 'RETURN',
  'D-Pad/Up': 'T',
  'D-Pad/Down': 'G',
  'D-Pad/Left': 'F',
  'D-Pad/Right': 'H',
  'C-Stick/Up': 'I',
  'C-Stick/Down': 'K',
  'C-Stick/Left': 'J',
  'C-Stick/Right': 'L',
  'Main Stick/Up': 'UP',
  'Main Stick/Down': 'DOWN',
  'Main Stick/Left': 'LEFT',
  'Main Stick/Right': 'RIGHT',
  'Triggers/L': 'Q',
  'Triggers/R': 'W'
}

/** Dolphin's Windows keyboard and mouse defaults for a Wii Remote's buttons (Wiimote::LoadDefaults). */
const WIIMOTE_KEYBOARD_DEFAULTS: Record<string, string> = {
  'Buttons/A': 'Click 0',
  'Buttons/B': 'Click 1',
  'Buttons/1': '1',
  'Buttons/2': '2',
  'Buttons/-': 'Q',
  'Buttons/+': 'E',
  'Buttons/Home': 'RETURN'
}

/** Dolphin's default device: the keyboard and mouse. */
const KEYBOARD_DEVICE = 'DInput/0/Keyboard Mouse'

/** An expression without backticks and spaces, so `` `X` `` and `X` compare equal. */
const bare = (v: string | undefined): string | undefined => v?.replace(/[`\s]/g, '')

/**
 * Whether a pad section is still Dolphin's own default: missing, or on the keyboard device (or none) with every
 * indicator binding either equal to the keyboard default (pad 1 after saving the dialog) or all of them unbound (pads
 * 2-4, which Dolphin leaves empty).
 */
export function isDefaultPadSection(
  lines: string[] | null,
  defaults: Record<string, string>
): boolean {
  if (lines === null) return true
  const device = iniValue(lines, 'Device')
  if (device !== undefined && device !== '' && device !== KEYBOARD_DEVICE) return false
  const values = Object.keys(defaults).map((k) => bare(iniValue(lines, k)))
  const allUnbound = values.every((v) => v === undefined || v === '')
  const allDefault = Object.values(defaults).every((d, i) => values[i] === bare(d))
  return allUnbound || allDefault
}

/** Keeps an existing section's `key = ...` line (Wiimote Source/Extension) or uses the fallback. */
function keepLine(lines: string[] | null, key: string, fallback: string | null): string[] {
  const v = iniValue(lines, key)
  if (v !== undefined) return [`${key} = ${v}`]
  return fallback === null ? [] : [`${key} = ${fallback}`]
}

export const applyPresets: ApplyPresets = async (ctx) => {
  const config = join(ctx.emuDir, 'User', 'Config')
  const dolphinIni = join(config, 'Dolphin.ini')
  const gcIni = join(config, 'GCPadNew.ini')
  const wiiIni = join(config, 'WiimoteNew.ini')

  const absent = async (section: string, key: string): Promise<boolean> =>
    iniValue(await readIniSection(dolphinIni, section), key) === undefined

  if (ctx.firstTime && (await absent('Display', 'Fullscreen'))) {
    await setIniValues(dolphinIni, 'Display', { Fullscreen: 'True' }, { style: 'spaced' })
  }
  // Needed for fullscreen: the analytics opt-in prompt opens on the first start even in batch mode (-b -e) and sits
  // over the game. Marking it as asked leaves analytics off (Enabled defaults to False).
  if (await absent('Analytics', 'PermissionAsked')) {
    await setIniValues(dolphinIni, 'Analytics', { PermissionAsked: 'True' }, { style: 'spaced' })
  }

  const siDevices: Record<string, string> = {}
  for (let n = 0; n < 4; n++) {
    const section = `GCPad${n + 1}`
    const existing = await readIniSection(gcIni, section)
    if (!isDefaultPadSection(existing, GC_KEYBOARD_DEFAULTS)) continue
    await replaceIniSection(gcIni, section, [`Device = ${DEVICE(n)}`, ...GC_PAD_LINES])
    // Port 1 is a GC controller by default; ports 2-4 are off until switched on.
    if (n > 0 && (await absent('Core', `SIDevice${n}`))) siDevices[`SIDevice${n}`] = '6'
  }
  if (Object.keys(siDevices).length > 0) {
    await setIniValues(dolphinIni, 'Core', siDevices, { style: 'spaced' })
  }

  for (let n = 0; n < 4; n++) {
    const section = `Wiimote${n + 1}`
    const existing = await readIniSection(wiiIni, section)
    if (!isDefaultPadSection(existing, WIIMOTE_KEYBOARD_DEFAULTS)) continue
    await replaceIniSection(wiiIni, section, [
      `Device = ${DEVICE(n)}`,
      // Source (emulated / real / none) is the user's choice; Dolphin's defaults apply when it is absent.
      ...keepLine(existing, 'Source', null),
      // A written section loads every missing key as empty, so the default Nunchuk must be written explicitly.
      ...keepLine(existing, 'Extension', 'Nunchuk'),
      ...WIIMOTE_LINES
    ])
  }
}
