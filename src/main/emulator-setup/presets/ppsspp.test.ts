import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readIniSection } from '../ini'
import { applyPresets, menuPause, PAUSE_CHORD } from './ppsspp'
import { presetFixture, type PresetFixture } from './test-helpers'
import { PresetDeferredError } from './types'

let fx: PresetFixture
let ini: string
let controls: string
beforeEach(async () => {
  fx = await presetFixture('ppsspp')
  ini = join(fx.ctx(true).emuDir, 'memstick', 'PSP', 'SYSTEM', 'ppsspp.ini')
  controls = join(dirname(ini), 'controls.ini')
  await mkdir(dirname(ini), { recursive: true })
})
afterEach(() => fx.cleanup())

/** The [ControlMapping] lines of a controls.ini PPSSPP 1.20.4 wrote (from the installed one). */
const CONTROLS = [
  '[ControlMapping]',
  'Start = 1-62,20-108,10-197',
  'Select = 1-50,20-109,10-196',
  'Pause = 1-111,20-4034,20-3,20-4046,10-109,10-104,10-4034',
  'Pause (no menu) = 1-138',
  ''
].join('\r\n')

describe('PPSSPP presets', () => {
  it('sets FullScreen the first time, merging into the existing ini, then waits for controls.ini', async () => {
    await writeFile(
      ini,
      '[General]\r\nCurrentDirectory = D:/psp\r\n[Graphics]\r\nFullScreen = False\r\nVSync = True\r\n'
    )
    // PPSSPP writes controls.ini when it first closes: until then the menu step is retried at the next launch.
    await expect(applyPresets(fx.ctx(true))).rejects.toBeInstanceOf(PresetDeferredError)
    expect(await readIniSection(ini, 'General')).toEqual(['CurrentDirectory = D:/psp'])
    expect(await readIniSection(ini, 'Graphics')).toEqual(['FullScreen = True', 'VSync = True'])
    await expect(readFile(controls)).rejects.toThrow()
  })

  it('never creates controls.ini and leaves fullscreen alone later', async () => {
    await writeFile(ini, '[Graphics]\r\nFullScreen = False\r\n')
    await applyPresets(fx.ctx(false))
    expect(await readFile(ini, 'utf8')).toBe('[Graphics]\r\nFullScreen = False\r\n')
    await expect(readFile(controls)).rejects.toThrow()
  })

  it('opens the pause screen on Start + Select instead of Guide, in the file PPSSPP wrote, once', async () => {
    await writeFile(controls, CONTROLS)
    // An install from presets version 1: the deferred-free rerun with firstTime false.
    await applyPresets(fx.ctx(false, 1))
    const text = await readFile(controls, 'utf8')
    expect(text).toBe(
      CONTROLS.replace(
        'Pause = 1-111,20-4034,20-3,20-4046,10-109,10-104,10-4034',
        `Pause = 1-111,20-4034,20-4046,10-109,10-104,10-4034,${PAUSE_CHORD}`
      )
    )
    // Every other mapping, and "Pause (no menu)", stay.
    expect(text).toContain('Start = 1-62,20-108,10-197')
    expect(text).toContain('Pause (no menu) = 1-138')
    await applyPresets(fx.ctx(false, 1))
    expect(await readFile(controls, 'utf8')).toBe(text)
  })

  it('leaves a Pause mapping the user changed', async () => {
    const own = CONTROLS.replace('20-4034,20-3,', '20-4034,')
    await writeFile(controls, own)
    await applyPresets(fx.ctx(false, 1))
    expect(await readFile(controls, 'utf8')).toBe(own)
    expect(menuPause('1-111')).toBeNull()
  })
})
