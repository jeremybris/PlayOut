import type { ApplyPresets } from './types'
import { applyPresets as azahar } from './azahar'
import { applyPresets as dolphin } from './dolphin'
import { applyPresets as duckstation } from './duckstation'
import { applyPresets as flycast } from './flycast'
import { applyPresets as mame } from './mame'
import { applyPresets as melonds } from './melonds'
import { applyPresets as mgba } from './mgba'
import { applyPresets as model2 } from './model2'
import { applyPresets as pcsx2 } from './pcsx2'
import { applyPresets as ppsspp } from './ppsspp'
import { applyPresets as retroarch } from './retroarch'
import { applyPresets as rpcs3 } from './rpcs3'
import { applyPresets as ryujinx } from './ryujinx'
import { applyPresets as scummvm } from './scummvm'

/**
 * The fullscreen and controller presets per find-rules id (docs/emulator-setup.md, "Fullscreen and controllers").
 * The service runs them once per emulator and records PRESETS_VERSION in the manifest.
 */
export const PRESETS: Record<string, ApplyPresets> = {
  DUCKSTATION: duckstation,
  PCSX2: pcsx2,
  RPCS3: rpcs3,
  DOLPHIN: dolphin,
  PPSSPP: ppsspp,
  FLYCAST: flycast,
  AZAHAR: azahar,
  MELONDS: melonds,
  MGBA: mgba,
  RYUJINX: ryujinx,
  M2EMULATOR: model2,
  SCUMMVM: scummvm,
  MAME: mame,
  RETROARCH: retroarch
}

/**
 * 1: fullscreen and controllers (0.1.84). 2: Big Picture and the Start + Select menu (big-picture.ts). 3: the
 * user's PCSX2 settings (pcsx2.ts PCSX2_SETTINGS).
 *
 * Bump when a preset changes in a way existing installs should get: the service runs the presets again (with
 * firstTime false) for every emulator whose recorded version is older.
 */
export const PRESETS_VERSION = 3

export type { ApplyPresets, PresetContext } from './types'
export { PresetDeferredError } from './types'
