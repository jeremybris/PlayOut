import { promises as fs } from 'fs'
import { join } from 'path'
import { readIniSection, setIniValues } from '../ini'
import { iniValue } from './keys'
import { PresetDeferredError, type ApplyPresets } from './types'

/**
 * Model 2 Emulator 1.1a (closed source; the archive ships a complete `EMULATOR.INI`, which is only merged into). The
 * file is ANSI, so it is read and written as 'latin1' (byte for byte).
 *
 * Fullscreen: `[Renderer] AutoFull=1` (Video > Auto switch to fullscreen: fullscreen as soon as the game has loaded;
 * there is no command-line flag). The emulator saves its menu options on exit, so it is set only the first time.
 * FullScreenWidth/Height stay at the shipped 640x480.
 *
 * Controller: `[Input] XInput=1` (support for Xbox 360 compatible pads, shipped 0), set only while it is still the
 * shipped 0. The emulator crashes at start with XInput on and no xinput1_3.dll (the DirectX 9 runtime the setup
 * installs), so while that DLL is missing it stays off and the presets end with a PresetDeferredError: they run again
 * at the next launch, and turn XInput on then if it is still 0 and the DLL is there. Button maps are per game
 * (`CFG\<romset>.input`, made by Game > Config Controls); none are written.
 */

/** The 32-bit xinput1_3.dll of the DirectX 9 June 2010 runtime (EMULATOR.EXE is 32-bit). */
export function xinputDll(): string {
  const windows = process.env.SystemRoot ?? 'C:\\Windows'
  return join(windows, 'SysWOW64', 'xinput1_3.dll')
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

const ANSI = { encoding: 'latin1' } as const

export const applyPresets: ApplyPresets = async (ctx) => {
  const ini = join(ctx.emuDir, 'EMULATOR.INI')
  if (!(await exists(ini))) {
    if (ctx.firstTime) {
      ctx.log.warn(`Model 2: ${ini} is missing; leaving it alone (the archive ships the full file)`)
    }
    return
  }
  if (ctx.firstTime)
    await setIniValues(ini, 'Renderer', { AutoFull: '1' }, { style: 'tight', ...ANSI })

  // The shipped line is 'XInput=0\t\t\t;Enable support for Xbox360 compatible devices'. A missing key is only
  // added the first time; later runs turn on nothing but the shipped 0.
  const xinput = iniValue(await readIniSection(ini, 'Input', ANSI), 'XInput')
    ?.split(';', 1)[0]
    .trim()
  if (xinput === undefined ? !ctx.firstTime : xinput !== '0') return
  if (!(await exists(xinputDll()))) {
    ctx.log.warn(
      'Model 2: xinput1_3.dll (DirectX 9 runtime) is missing; leaving XInput off until it is installed'
    )
    throw new PresetDeferredError(
      'Model 2: xinput1_3.dll is missing; XInput is turned on at a later launch'
    )
  }
  await setIniValues(ini, 'Input', { XInput: '1' }, { style: 'tight', ...ANSI })
}
