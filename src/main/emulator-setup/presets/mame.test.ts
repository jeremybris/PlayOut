import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPresets } from './mame'
import { presetFixture, type PresetFixture } from './test-helpers'

let fx: PresetFixture
let ini: string
beforeEach(async () => {
  fx = await presetFixture('mame')
  ini = join(fx.ctx(true).emuDir, 'mame.ini')
  await mkdir(join(fx.dir, 'emu'), { recursive: true })
})
afterEach(() => fx.cleanup())

/** A mame.ini option line as MAME writes it (name padded to 26 columns). */
const opt = (name: string, value: string): string => `${name.padEnd(26)}${value}`

describe('MAME presets', () => {
  it('writes window 0 and the joystick defaults into a partial mame.ini', async () => {
    await writeFile(ini, `# CORE SEARCH PATH OPTIONS\r\n${opt('rompath', 'roms')}\r\n`)
    await applyPresets(fx.ctx(true))
    expect(await readFile(ini, 'utf8')).toBe(
      [
        '# CORE SEARCH PATH OPTIONS',
        opt('rompath', 'roms'),
        opt('window', '0'),
        opt('joystick', '1'),
        opt('joystickprovider', 'auto'),
        ''
      ].join('\r\n')
    )
  })

  it('keeps existing joystick options and a later window choice', async () => {
    const created = [
      opt('window', '1'),
      opt('joystick', '0'),
      opt('joystickprovider', 'dinput'),
      ''
    ].join('\r\n')
    await writeFile(ini, created)
    await applyPresets(fx.ctx(false))
    expect(await readFile(ini, 'utf8')).toBe(created)
    await applyPresets(fx.ctx(true))
    expect(await readFile(ini, 'utf8')).toBe(
      created.replace(opt('window', '1'), opt('window', '0'))
    )
  })
})
