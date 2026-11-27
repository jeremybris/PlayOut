import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readIniSection } from '../ini'
import { applyPresets, MGBA_PAD_LINES, MGBA_PAD_SECTIONS } from './mgba'
import { presetFixture, type PresetFixture } from './test-helpers'

let fx: PresetFixture
let ini: string
beforeEach(async () => {
  fx = await presetFixture('mgba')
  ini = join(fx.ctx(true).emuDir, 'config.ini')
})
afterEach(() => fx.cleanup())

describe('mGBA presets', () => {
  it('turns on fullscreen and writes the pad sections into a fresh config', async () => {
    await applyPresets(fx.ctx(true))
    expect(await readIniSection(ini, 'ports.qt')).toEqual(['fullscreen=1'])
    for (const s of MGBA_PAD_SECTIONS) expect(await readIniSection(ini, s)).toEqual(MGBA_PAD_LINES)
    expect(await readIniSection(ini, 'gba.input-profile.XInput Controller #4')).not.toBeNull()
  })

  it('merges into an existing config and keeps a mapping the user made', async () => {
    await mkdir(join(fx.dir, 'emu'), { recursive: true })
    const original = [
      '[ports.qt]',
      'savegamePath=D:\\saves',
      'fullscreen=0',
      '',
      '[gba.input.SDLB]',
      'keyA=3',
      '',
      '[gba.input.QT_K]',
      'keyA=88',
      ''
    ].join('\r\n')
    await writeFile(ini, original)
    await applyPresets(fx.ctx(true))
    expect(await readIniSection(ini, 'ports.qt')).toEqual([
      'savegamePath=D:\\saves',
      'fullscreen=1'
    ])
    expect(await readIniSection(ini, 'gba.input.SDLB')).toEqual(['keyA=3'])
    expect(await readIniSection(ini, 'gba.input.QT_K')).toEqual(['keyA=88'])
    expect(await readIniSection(ini, 'gba.input-profile.XInput Controller #1')).toEqual(
      MGBA_PAD_LINES
    )
    expect(await readFile(ini, 'utf8')).not.toMatch(/[^\r]\n/)
  })

  it('leaves fullscreen alone after the first time and is idempotent', async () => {
    await applyPresets(fx.ctx(true))
    await writeFile(ini, (await readFile(ini, 'utf8')).replace('fullscreen=1', 'fullscreen=0'))
    const before = await readFile(ini, 'utf8')
    await applyPresets(fx.ctx(false))
    await applyPresets(fx.ctx(false))
    expect(await readFile(ini, 'utf8')).toBe(before)
  })
})
