import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readIniSection } from '../ini'
import { applyPresets } from './scummvm'
import { presetFixture, type PresetFixture } from './test-helpers'

let fx: PresetFixture
let ini: string
beforeEach(async () => {
  fx = await presetFixture('scummvm')
  ini = join(fx.ctx(true).emuDir, 'scummvm.ini')
  await mkdir(join(fx.dir, 'emu'), { recursive: true })
})
afterEach(() => fx.cleanup())

describe('ScummVM presets', () => {
  it('turns on fullscreen and suppresses the update dialog', async () => {
    await writeFile(ini, '[scummvm]\r\nsavepath=D:\\saves\r\n\r\n[monkey]\r\nfullscreen=false\r\n')
    await applyPresets(fx.ctx(true))
    expect(await readIniSection(ini, 'scummvm')).toEqual([
      'savepath=D:\\saves',
      'fullscreen=true',
      'updates_check=0',
      'joystick_num=0'
    ])
    expect(await readIniSection(ini, 'monkey')).toEqual(['fullscreen=false'])
  })

  it('keeps the update answer, the joystick choice and a later fullscreen choice', async () => {
    const saved = '[scummvm]\r\nfullscreen=false\r\nupdates_check=604800\r\njoystick_num=-1\r\n'
    await writeFile(ini, saved)
    await applyPresets(fx.ctx(false))
    expect(await readFile(ini, 'utf8')).toBe(saved)
    await applyPresets(fx.ctx(true))
    expect(await readFile(ini, 'utf8')).toBe(saved.replace('fullscreen=false', 'fullscreen=true'))
  })
})
