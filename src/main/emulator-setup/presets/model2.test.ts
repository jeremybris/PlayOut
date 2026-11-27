import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readIniSection, setIniValues } from '../ini'
import { applyPresets } from './model2'
import { PresetDeferredError } from './types'
import { presetFixture, type PresetFixture } from './test-helpers'

let fx: PresetFixture
let ini: string
const systemRoot = process.env.SystemRoot
/** An excerpt of the shipped 1.1a EMULATOR.INI. */
const SHIPPED = [
  '[RomDirs]',
  'Dir1=roms',
  '',
  '[Renderer]',
  'FullScreenWidth=640',
  'FullScreenHeight=480',
  ";These options are configured from menus so don't touch",
  'FullMode=0\t',
  'AutoFull=0',
  '',
  '[Input]',
  'XInput=0\t\t\t;Enable support for Xbox360 compatible devices',
  'UseRawInput=0',
  ''
].join('\r\n')

beforeEach(async () => {
  fx = await presetFixture('model2')
  ini = join(fx.ctx(true).emuDir, 'EMULATOR.INI')
  await mkdir(join(fx.dir, 'emu'), { recursive: true })
  await writeFile(ini, SHIPPED)
  process.env.SystemRoot = join(fx.dir, 'Windows')
})
afterEach(async () => {
  process.env.SystemRoot = systemRoot
  await fx.cleanup()
})

async function installDirectX(): Promise<void> {
  await mkdir(join(fx.dir, 'Windows', 'SysWOW64'), { recursive: true })
  await writeFile(join(fx.dir, 'Windows', 'SysWOW64', 'xinput1_3.dll'), '')
}

describe('Model 2 presets', () => {
  it('turns on AutoFull and XInput when the DirectX runtime is there', async () => {
    await installDirectX()
    await applyPresets(fx.ctx(true))
    expect(await readIniSection(ini, 'Renderer')).toEqual([
      'FullScreenWidth=640',
      'FullScreenHeight=480',
      ";These options are configured from menus so don't touch",
      'FullMode=0\t',
      'AutoFull=1'
    ])
    expect(await readIniSection(ini, 'Input')).toEqual(['XInput=1', 'UseRawInput=0'])
    expect(await readIniSection(ini, 'RomDirs')).toEqual(['Dir1=roms'])
  })

  it('leaves XInput off without xinput1_3.dll and defers, then turns it on at a later run', async () => {
    const ctx = fx.ctx(true)
    await expect(applyPresets(ctx)).rejects.toBeInstanceOf(PresetDeferredError)
    expect(await readIniSection(ini, 'Renderer')).toContain('AutoFull=1')
    expect(await readIniSection(ini, 'Input')).toEqual([
      'XInput=0\t\t\t;Enable support for Xbox360 compatible devices',
      'UseRawInput=0'
    ])
    expect(ctx.log.warn).toHaveBeenCalled()

    // Still missing at the next launch: deferred again, nothing changes.
    await expect(applyPresets(fx.ctx(false))).rejects.toBeInstanceOf(PresetDeferredError)

    // The DirectX runtime is installed later; the user turned fullscreen off meanwhile.
    await installDirectX()
    await setIniValues(ini, 'Renderer', { AutoFull: '0' }, { style: 'tight' })
    await applyPresets(fx.ctx(false))
    expect(await readIniSection(ini, 'Input')).toEqual(['XInput=1', 'UseRawInput=0'])
    expect(await readIniSection(ini, 'Renderer')).toContain('AutoFull=0')
  })

  it('after the first time, leaves fullscreen and a non-shipped XInput alone, and never creates the ini', async () => {
    await installDirectX()
    const custom = SHIPPED.replace('XInput=0\t\t\t;', 'XInput=2\t\t\t;')
    await writeFile(ini, custom)
    await applyPresets(fx.ctx(false))
    expect(await readFile(ini, 'utf8')).toBe(custom)

    // A file without the key gets none after the first time.
    const noKey = SHIPPED.replace(
      'XInput=0\t\t\t;Enable support for Xbox360 compatible devices\r\n',
      ''
    )
    await writeFile(ini, noKey)
    await applyPresets(fx.ctx(false))
    expect(await readFile(ini, 'utf8')).toBe(noKey)

    const other = await presetFixture('model2-empty')
    try {
      const later = other.ctx(false)
      await applyPresets(later)
      expect(later.log.warn).not.toHaveBeenCalled()
      await applyPresets(other.ctx(true))
      await expect(readFile(join(other.dir, 'emu', 'EMULATOR.INI'))).rejects.toThrow()
    } finally {
      await other.cleanup()
    }
  })

  it('keeps the ANSI bytes of EMULATOR.INI', async () => {
    await installDirectX()
    // Windows-1252 'é' (0xE9) in a comment, as a localized EMULATOR.INI could have it.
    const ansi = Buffer.from(
      SHIPPED.replace('[RomDirs]', '[RomDirs]\r\n;Dir2=C:/Jeux/\u00e9t\u00e9'),
      'latin1'
    )
    await writeFile(ini, ansi)
    await applyPresets(fx.ctx(true))
    const bytes = await readFile(ini)
    expect(bytes.includes(Buffer.from([0x2f, 0xe9, 0x74, 0xe9]))).toBe(true)
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
    expect(bytes.toString('latin1')).toContain('AutoFull=1')
    expect(bytes.toString('latin1')).toContain('XInput=1')
  })
})
