import { join } from 'path'
import { readIniSection, replaceIniSection, setIniValues } from '../ini'
import type { ApplyPresets } from './types'

/**
 * mGBA 0.10.5 (Qt frontend, portable `config.ini` next to mGBA.exe).
 *
 * Fullscreen: `[ports.qt] fullscreen=1` (Window::loadConfig enters fullscreen). mGBA writes the key back on every
 * resize, so it is set only the first time. PlayOut's launch command also passes `-f`.
 *
 * Controller: out of the box mGBA binds only the D-pad and left stick of an SDL pad (mSDLInitBindingsGBA), with no face
 * or shoulder buttons, and its built-in "XInput Controller #N" profile uses the old SDL button order. So the Xbox
 * layout in SDL's XInput order is written: A, B, LB=L, RB=R, Back=Select, Start, D-pad on hat 0, left stick on axes
 * 0/1 (mGBA's own 16384 threshold). Every multiplayer window loads the same `[gba.input.SDLB]` map and takes the next
 * free pad, so one section covers players 1-4. Each section is written only when absent: an existing one is the
 * user's (or mGBA's) mapping. The keyboard map (`gba.input.QT_K`) is separate and stays as it is.
 */

/** The SDL joystick bindings, as mGBA writes them from Settings > Controllers. */
export const MGBA_PAD_LINES: readonly string[] = [
  'keyA=0',
  'keyB=1',
  'keySelect=6',
  'keyStart=7',
  'keyRight=-1',
  'keyLeft=-1',
  'keyUp=-1',
  'keyDown=-1',
  'keyR=5',
  'keyL=4',
  'axisRightAxis=+0',
  'axisRightValue=16384',
  'axisLeftAxis=-0',
  'axisLeftValue=-16384',
  'axisDownAxis=+1',
  'axisDownValue=16384',
  'axisUpAxis=-1',
  'axisUpValue=-16384',
  'hat0Up=6',
  'hat0Right=4',
  'hat0Down=7',
  'hat0Left=5'
]

/**
 * `[gba.input.SDLB]` plus the four `[gba.input-profile.XInput Controller #N]` sections: a config section of that
 * name wins over the stale built-in profile (mInputProfileLoad looks in the config first).
 */
export const MGBA_PAD_SECTIONS: readonly string[] = [
  'gba.input.SDLB',
  ...[1, 2, 3, 4].map((n) => `gba.input-profile.XInput Controller #${n}`)
]

export const applyPresets: ApplyPresets = async (ctx) => {
  const ini = join(ctx.emuDir, 'config.ini')
  if (ctx.firstTime) {
    await setIniValues(ini, 'ports.qt', { fullscreen: '1' }, { style: 'tight' })
  }
  for (const section of MGBA_PAD_SECTIONS) {
    if ((await readIniSection(ini, section)) !== null) continue
    await replaceIniSection(ini, section, [...MGBA_PAD_LINES])
  }
}
