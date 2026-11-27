import { promises as fs } from 'fs'
import { join } from 'path'
import { setIniValues } from '../ini'
import { BIG_PICTURE_VERSION, newSince } from './big-picture'
import { PresetDeferredError, type ApplyPresets } from './types'

/**
 * PPSSPP 1.20 (`memstick/PSP/SYSTEM/ppsspp.ini`; a partial file is safe, PPSSPP rewrites it in full on exit).
 *
 * Fullscreen: `[Graphics] FullScreen = True`. PPSSPP saves it on exit (Alt+Enter/F11 toggle it), so it is set only
 * the first time.
 *
 * Controller: nothing is written. Without a controls.ini PPSSPP's Windows defaults already map the XInput pad in slot
 * 1 (A=Cross, B=Circle, X=Square, Y=Triangle, LB/RB=L/R, Start, Back=Select, D-pad, left stick) next to the keyboard,
 * and the PSP is single-player. A partial controls.ini would be destructive: once `[ControlMapping]` exists, every
 * button missing from it is unmapped.
 *
 * Menu (big-picture.ts): PPSSPP's whole interface is controller-driven; its in-game menu is the pause screen. Start +
 * Select is added to `Pause` and Guide (PlayOut's home button) taken off it, only in a controls.ini PPSSPP wrote itself
 * (a complete one) and only while `Pause` is still PPSSPP's default. PPSSPP writes that file on its first exit, so
 * before then this step waits for the next launch. The command PlayOut launches games with passes --pause-menu-exit,
 * so the pause screen's last button quits back to PlayOut.
 */

/** PPSSPP's own Windows `Pause` mapping (device-keycode, ',' between alternatives): Escape, LT, Guide, and others. */
const DEFAULT_PAUSE = '1-111,20-4034,20-3,20-4046,10-109,10-104,10-4034'
/** Guide on an XInput pad (device 20, keycode 3). */
const GUIDE = '20-3'
/** Start + Select on an XInput pad (Android keycodes 108 and 109; a chord joins its keys with ':'). */
export const PAUSE_CHORD = '20-108:20-109'

/** The `Pause` value with Start + Select in and Guide out; null when the value is not PPSSPP's default. */
export function menuPause(value: string): string | null {
  if (value.trim() !== DEFAULT_PAUSE) return null
  return [...DEFAULT_PAUSE.split(',').filter((k) => k !== GUIDE), PAUSE_CHORD].join(',')
}

export const applyPresets: ApplyPresets = async (ctx) => {
  const system = join(ctx.emuDir, 'memstick', 'PSP', 'SYSTEM')
  if (ctx.firstTime) {
    await setIniValues(
      join(system, 'ppsspp.ini'),
      'Graphics',
      { FullScreen: 'True' },
      { style: 'spaced' }
    )
  }
  if (!newSince(ctx, BIG_PICTURE_VERSION)) return

  const file = join(system, 'controls.ini')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // Fullscreen above is already written: a deferred first run is recorded, and the retry skips it.
    throw new PresetDeferredError(
      'controls.ini does not exist yet (PPSSPP writes it when it first closes)'
    )
  }
  const re = /^([ \t]*Pause[ \t]*=[ \t]*)(.*?)([ \t]*)(\r?)$/m
  const m = re.exec(text)
  const next = m ? menuPause(m[2]) : null
  if (!m || next === null) {
    ctx.log.info('PPSSPP: the Pause mapping was changed; left as it is')
    return
  }
  await fs.writeFile(file, text.replace(re, `$1${next}$3$4`), 'utf8')
  ctx.log.info('PPSSPP: Start + Select opens the pause screen')
}
