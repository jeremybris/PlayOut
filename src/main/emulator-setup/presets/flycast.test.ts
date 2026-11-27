import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readIniSection } from '../ini'
import { applyPresets } from './flycast'
import { presetFixture, type PresetFixture } from './test-helpers'

let fx: PresetFixture
let cfg: string
beforeEach(async () => {
  fx = await presetFixture('flycast')
  cfg = join(fx.ctx(true).emuDir, 'emu.cfg')
  await mkdir(join(fx.dir, 'emu'), { recursive: true })
})
afterEach(() => fx.cleanup())

describe('Flycast presets', () => {
  it('turns on fullscreen and plugs controllers into ports B-D', async () => {
    await writeFile(cfg, '[config]\r\nDreamcast.SavePath = D:\\saves\r\n')
    await applyPresets(fx.ctx(true))
    expect(await readIniSection(cfg, 'config')).toEqual(['Dreamcast.SavePath = D:\\saves'])
    expect(await readIniSection(cfg, 'window')).toEqual(['fullscreen = yes'])
    expect(await readIniSection(cfg, 'input')).toEqual([
      'device2 = 0',
      'device3 = 0',
      'device4 = 0'
    ])
  })

  it('replaces the saved default None the first time and keeps user choices later', async () => {
    const saved = [
      '[input]',
      'device1 = 0',
      'device2 = 10',
      'device2.1 = 10',
      'device3 = 1',
      'device4 = 10',
      '',
      '[window]',
      'fullscreen = no',
      ''
    ].join('\r\n')
    await writeFile(cfg, saved)
    await applyPresets(fx.ctx(false))
    expect(await readFile(cfg, 'utf8')).toBe(saved)
    await applyPresets(fx.ctx(true))
    expect(await readIniSection(cfg, 'input')).toEqual([
      'device1 = 0',
      'device2 = 0',
      'device2.1 = 10',
      'device3 = 1',
      'device4 = 0'
    ])
    expect(await readIniSection(cfg, 'window')).toEqual(['fullscreen = yes'])
  })

  it('is idempotent', async () => {
    await applyPresets(fx.ctx(true))
    const once = await readFile(cfg, 'utf8')
    await applyPresets(fx.ctx(true))
    await applyPresets(fx.ctx(false))
    expect(await readFile(cfg, 'utf8')).toBe(once)
  })
})
