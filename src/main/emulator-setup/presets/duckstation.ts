import { promises as fs } from 'fs'
import { join } from 'path'
import { readIniSection, replaceIniSection, setIniValues } from '../ini'
import {
  addBindings,
  type Binding,
  bindingLines,
  entryValue,
  forDevice,
  isFalse,
  isUnusedPad,
  isUntouchedPad,
  type PadDefaults,
  setType
} from './pad-bindings'
import { addPadHotkey, BIG_PICTURE_VERSION, newSince, SDL_MENU_CHORD } from './big-picture'
import type { ApplyPresets, PresetContext } from './types'

/**
 * DuckStation presets (docs/emulator-setup.md): games start fullscreen and an SDL game controller (an Xbox pad is SDL
 * gamepad 0) is bound to ports 1 and 2, next to the keyboard defaults. Everything else stays at DuckStation's
 * defaults. Settings live in <E>\settings.ini (portable mode: portable.txt is written by the configurator; a
 * settings.ini next to it does not change that).
 *
 * The bindings are exactly what DuckStation's own "Automatic Mapping" writes for an SDL gamepad
 * (SDLInputSource::GetGenericBindingMapping with the AnalogController binding table). DuckStation reads a repeated key
 * as a list of bindings, so `Up = Keyboard/UpArrow` and `Up = SDL-0/DPadUp` both work.
 */

/** The keyboard bindings DuckStation writes into [Pad1] by default (GetKeyboardGenericBindingMapping). */
export const KEYBOARD_PAD1: readonly Binding[] = [
  ['Up', 'Keyboard/UpArrow'],
  ['Right', 'Keyboard/RightArrow'],
  ['Down', 'Keyboard/DownArrow'],
  ['Left', 'Keyboard/LeftArrow'],
  ['Triangle', 'Keyboard/I'],
  ['Circle', 'Keyboard/L'],
  ['Cross', 'Keyboard/K'],
  ['Square', 'Keyboard/J'],
  ['Select', 'Keyboard/Backspace'],
  ['Start', 'Keyboard/Enter'],
  ['L1', 'Keyboard/Q'],
  ['R1', 'Keyboard/E'],
  ['L2', 'Keyboard/1'],
  ['R2', 'Keyboard/3'],
  ['L3', 'Keyboard/2'],
  ['R3', 'Keyboard/4'],
  ['LLeft', 'Keyboard/A'],
  ['LRight', 'Keyboard/D'],
  ['LDown', 'Keyboard/S'],
  ['LUp', 'Keyboard/W'],
  ['RLeft', 'Keyboard/F'],
  ['RRight', 'Keyboard/H'],
  ['RDown', 'Keyboard/G'],
  ['RUp', 'Keyboard/T']
]

/**
 * DuckStation's automatic mapping of SDL gamepad 0 onto an AnalogController (AnalogLED is left out: Xbox pads have no
 * LED). Analog = Guide is DuckStation's own choice (the Xbox button may also open the Game Bar).
 */
export const SDL_PAD: readonly Binding[] = [
  ['Up', 'SDL-0/DPadUp'],
  ['Right', 'SDL-0/DPadRight'],
  ['Down', 'SDL-0/DPadDown'],
  ['Left', 'SDL-0/DPadLeft'],
  ['Triangle', 'SDL-0/Y'],
  ['Circle', 'SDL-0/B'],
  ['Cross', 'SDL-0/A'],
  ['Square', 'SDL-0/X'],
  ['Select', 'SDL-0/Back'],
  ['Start', 'SDL-0/Start'],
  ['Analog', 'SDL-0/Guide'],
  ['L1', 'SDL-0/LeftShoulder'],
  ['R1', 'SDL-0/RightShoulder'],
  ['L2', 'SDL-0/+LeftTrigger'],
  ['R2', 'SDL-0/+RightTrigger'],
  ['L3', 'SDL-0/LeftStick'],
  ['R3', 'SDL-0/RightStick'],
  ['LLeft', 'SDL-0/-LeftX'],
  ['LRight', 'SDL-0/+LeftX'],
  ['LDown', 'SDL-0/+LeftY'],
  ['LUp', 'SDL-0/-LeftY'],
  ['RLeft', 'SDL-0/-RightX'],
  ['RRight', 'SDL-0/+RightX'],
  ['RDown', 'SDL-0/+RightY'],
  ['RUp', 'SDL-0/-RightY'],
  ['LargeMotor', 'SDL-0/LargeMotor'],
  ['SmallMotor', 'SDL-0/SmallMotor']
]

const TYPE = 'AnalogController'

/** Every binding key of an AnalogController (the other keys of a [PadN] section are settings). */
const BINDING_KEYS = [...SDL_PAD.map(([k]) => k), 'AnalogLED']

const PAD1: PadDefaults = { type: TYPE, bindingKeys: BINDING_KEYS, defaults: KEYBOARD_PAD1 }

/** [Pad1]: the keyboard defaults with the SDL-0 binding added after each one. */
const pad1Lines = (): string[] =>
  addBindings([`Type = ${TYPE}`, ...bindingLines(KEYBOARD_PAD1)], SDL_PAD)

/** [Pad2]: player 2 on SDL gamepad 1 (port 2 has no keyboard bindings by default). */
const pad2Lines = (): string[] => [`Type = ${TYPE}`, ...bindingLines(forDevice(SDL_PAD, 1))]

/**
 * The complete settings.ini written when DuckStation has none yet. DuckStation only applies its controller and hotkey
 * defaults (and asks for the setup wizard) when the file is missing; every other setting falls back to its code default
 * when read, so pre-creating the file loses nothing as long as the controller, hotkey and input-source sections are
 * all here (Settings::SetDefaultControllerConfig, SetDefaultHotkeyConfig, InputManager::SetDefaultSourceConfig).
 */
export function seedSettings(firstTime: boolean): string {
  const lines = [
    '[Main]',
    // Needed for the fullscreen launch: the setup wizard would otherwise open before the game, even with -batch.
    'SetupWizardIncomplete = false',
    ...(firstTime ? ['StartFullscreen = true'] : []),
    // Big Picture when DuckStation is opened by itself (a game PlayOut starts boots straight over it).
    'StartFullscreenUI = true',
    '',
    '[InputSources]',
    'SDL = true',
    'SDLControllerEnhancedMode = false',
    'SDLPS5PlayerLED = false',
    'XInput = false',
    'RawInput = false',
    '',
    '[ControllerPorts]',
    'MultitapMode = Disabled',
    'PointerXScale = 8',
    'PointerYScale = 8',
    'PointerXInvert = false',
    'PointerYInvert = false',
    '',
    '[Pad1]',
    ...pad1Lines(),
    '',
    '[Pad2]',
    ...pad2Lines(),
    ''
  ]
  for (let i = 3; i <= 8; i++) lines.push(`[Pad${i}]`, 'Type = None', '')
  lines.push(
    '[Hotkeys]',
    'FastForward = Keyboard/Tab',
    'TogglePause = Keyboard/Space',
    'Screenshot = Keyboard/F10',
    'ToggleFullscreen = Keyboard/F11',
    'OpenPauseMenu = Keyboard/Escape',
    // Start + Select opens the Big Picture pause menu in game.
    `OpenPauseMenu = ${SDL_MENU_CHORD}`,
    'LoadSelectedSaveState = Keyboard/F1',
    'SaveSelectedSaveState = Keyboard/F2',
    'SelectPreviousSaveStateSlot = Keyboard/F3',
    'SelectNextSaveStateSlot = Keyboard/F4'
  )
  return lines.join('\n') + '\n'
}

/** Writes the seed; false when the file already exists (never overwritten). */
async function writeSeed(file: string, firstTime: boolean): Promise<boolean> {
  try {
    await fs.writeFile(file, seedSettings(firstTime), { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** Merges the presets into a settings.ini DuckStation (or an earlier PlayOut) already wrote. */
async function mergeExisting(file: string, ctx: PresetContext): Promise<void> {
  const main = await readIniSection(file, 'Main')
  const values: Record<string, string> = {}
  if (ctx.firstTime) values.StartFullscreen = 'true'
  // The setup wizard blocks the fullscreen game launch (DuckStation runs it before booting, even with -batch). It runs
  // when neither key exists (a very old file), or when it was never finished: clear it only on first-time setup.
  const wizard = entryValue(main, 'SetupWizardIncomplete')
  if (wizard === undefined && entryValue(main, 'SettingsVersion') === undefined) {
    values.SetupWizardIncomplete = 'false'
  } else if (ctx.firstTime && wizard !== undefined && /^(true|1)$/i.test(wizard)) {
    values.SetupWizardIncomplete = 'false'
  }
  if (
    newSince(ctx, BIG_PICTURE_VERSION) &&
    !/^(true|1)$/i.test(entryValue(main, 'StartFullscreenUI') ?? '')
  ) {
    values.StartFullscreenUI = 'true'
  }
  if (Object.keys(values).length > 0) await setIniValues(file, 'Main', values)

  const sources = await readIniSection(file, 'InputSources')
  if (isFalse(entryValue(sources, 'SDL'))) {
    ctx.log.info(
      'DuckStation: the SDL input source is turned off; leaving the controllers as they are'
    )
    return
  }
  if (
    newSince(ctx, BIG_PICTURE_VERSION) &&
    (await addPadHotkey(file, 'OpenPauseMenu', SDL_MENU_CHORD))
  ) {
    ctx.log.info('DuckStation: Start + Select opens the pause menu')
  }
  const pad1 = await readIniSection(file, 'Pad1')
  if (!isUntouchedPad(pad1, PAD1)) {
    ctx.log.info('DuckStation: [Pad1] was changed by the user; leaving the controllers as they are')
    return
  }
  await replaceIniSection(file, 'Pad1', pad1 === null ? pad1Lines() : addBindings(pad1, SDL_PAD))
  const pad2 = await readIniSection(file, 'Pad2')
  if (isUnusedPad(pad2, BINDING_KEYS)) {
    await replaceIniSection(
      file,
      'Pad2',
      addBindings(setType(pad2 ?? [], TYPE), forDevice(SDL_PAD, 1))
    )
    ctx.log.info('DuckStation: bound SDL game controllers 0 and 1 to ports 1 and 2')
  } else {
    ctx.log.info('DuckStation: bound SDL game controller 0 to port 1 ([Pad2] is in use)')
  }
}

/**
 * Applies the DuckStation presets: writes the complete seed settings.ini when there is none, otherwise merges
 * StartFullscreen (first-time setup only) and the SDL pad bindings (only while [Pad1] is still DuckStation's default).
 * Idempotent: a second run finds the pad already bound and changes nothing.
 */
export const applyPresets: ApplyPresets = async (ctx) => {
  const file = join(ctx.emuDir, 'settings.ini')
  if (await writeSeed(file, ctx.firstTime)) {
    ctx.log.info('DuckStation: wrote settings.ini with fullscreen and SDL controller presets')
    return
  }
  await mergeExisting(file, ctx)
}
