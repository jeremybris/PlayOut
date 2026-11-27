import { readIniSection, replaceIniSection } from '../ini'
import { addBindings } from './pad-bindings'
import type { PresetContext } from './types'

/**
 * Big Picture and the controller menu (docs/emulator-setup.md, "Big Picture and the controller menu"): emulators with
 * a controller-driven fullscreen interface start in it, and Start + Select on the first pad opens their in-game menu.
 * The user chose Start + Select; it leaves Guide to PlayOut's own home button.
 */

/** The PRESETS_VERSION that brought Big Picture and the Start + Select menu. */
export const BIG_PICTURE_VERSION = 2

/**
 * True when the presets of this version were never applied to the emulator: a setting the user may turn off later
 * (Big Picture on start, a menu combo) is switched on only then, never again.
 */
export function newSince(ctx: Pick<PresetContext, 'previousVersion'>, version: number): boolean {
  return ctx.previousVersion === undefined || ctx.previousVersion < version
}

/** Start + Select on SDL pad 0, in the binding syntax PCSX2 and DuckStation share (a chord is joined with " & "). */
export const SDL_MENU_CHORD = 'SDL-0/Back & SDL-0/Start'

/**
 * Adds a pad binding to a hotkey in `[Hotkeys]` of a PCSX2 / DuckStation ini, next to its keyboard binding (a repeated
 * key is a list of bindings there). Left alone when the hotkey already has a pad binding: the user chose one. Returns
 * whether the file changed.
 */
export async function addPadHotkey(
  file: string,
  hotkey: string,
  binding: string
): Promise<boolean> {
  const lines = await readIniSection(file, 'Hotkeys')
  const key = hotkey.toLowerCase()
  const hasPad = (lines ?? []).some((line) => {
    const m = /^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/.exec(line)
    return m !== null && m[1].toLowerCase() === key && /^SDL-\d+\//i.test(m[2])
  })
  if (hasPad) return false
  await replaceIniSection(file, 'Hotkeys', addBindings(lines ?? [], [[hotkey, binding]]))
  return true
}
