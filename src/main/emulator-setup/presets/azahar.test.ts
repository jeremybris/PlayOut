import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readIniSection } from '../ini'
import type { Runner } from '../types'
import { AZAHAR_BINDINGS, applyPresets, hasControllerMapping } from './azahar'
import { iniValue } from './keys'
import type { PresetContext } from './types'

let dir: string
let E: string
let ini: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const run: Runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))
const startHidden = vi.fn(() => {
  throw new Error('not used')
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-azahar-'))
  E = join(dir, 'Azahar')
  ini = join(E, 'user', 'config', 'qt-config.ini')
  vi.clearAllMocks()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ctx = (firstTime: boolean): PresetContext => ({
  emuDir: E,
  dataDir: join(dir, 'Data'),
  run,
  log,
  firstTime,
  previousVersion: firstTime ? undefined : 3,
  startHidden
})

describe('Azahar presets', () => {
  it('writes fullscreen, the update-check switch and an SDL all-controllers profile on a fresh install', async () => {
    await applyPresets(ctx(true))
    const ui = await readIniSection(ini, 'UI')
    expect(iniValue(ui, 'fullscreen\\default')).toBe('false')
    expect(iniValue(ui, 'fullscreen')).toBe('true')
    const misc = await readIniSection(ini, 'Miscellaneous')
    expect(iniValue(misc, 'check_for_update_on_start')).toBe('false')

    const c = await readIniSection(ini, 'Controls')
    expect(iniValue(c, 'profile')).toBe('0')
    expect(iniValue(c, 'profiles\\size')).toBe('1')
    expect(iniValue(c, 'profiles\\1\\name')).toBe('Default')
    expect(iniValue(c, 'profiles\\1\\input_maptype')).toBe('0')
    expect(iniValue(c, 'profiles\\1\\button_a')).toBe(
      '"api:controller,button:1,engine:sdl,guid:0,maptype:all,port:0"'
    )
    expect(iniValue(c, 'profiles\\1\\button_zr\\default')).toBe('false')
    expect(iniValue(c, 'profiles\\1\\button_zr')).toBe(
      '"api:controller,axis:5,direction:+,engine:sdl,guid:0,maptype:all,port:0,threshold:0.500000"'
    )
    expect(iniValue(c, 'profiles\\1\\c_stick')).toBe(
      '"api:controller,axis_x:2,axis_y:3,deadzone:0.100000,engine:sdl,guid:0,maptype:all,port:0"'
    )
    expect(iniValue(c, 'profiles\\1\\button_debug')).toBeUndefined()
    expect(await readFile(ini, 'utf8')).toContain('\r\n')
  })

  it('is idempotent', async () => {
    await applyPresets(ctx(true))
    const before = await readFile(ini, 'utf8')
    await applyPresets(ctx(true))
    await applyPresets(ctx(false))
    expect(await readFile(ini, 'utf8')).toBe(before)
  })

  it('leaves fullscreen alone after the first time and keeps an explicit choice', async () => {
    await applyPresets(ctx(false))
    expect(iniValue(await readIniSection(ini, 'UI'), 'fullscreen')).toBeUndefined()

    await writeFile(ini, '[UI]\r\nfullscreen\\default=false\r\nfullscreen=false\r\n')
    await applyPresets(ctx(true))
    expect(iniValue(await readIniSection(ini, 'UI'), 'fullscreen')).toBe('false')

    await writeFile(ini, '[UI]\r\nfullscreen\\default=true\r\nfullscreen=false\r\n')
    await applyPresets(ctx(true))
    const ui = await readIniSection(ini, 'UI')
    expect(iniValue(ui, 'fullscreen\\default')).toBe('false')
    expect(iniValue(ui, 'fullscreen')).toBe('true')
  })

  it("replaces Azahar's default keyboard profile 1 and keeps the selected profile and other profiles", async () => {
    await mkdir(join(E, 'user', 'config'), { recursive: true })
    await writeFile(
      ini,
      [
        '[Controls]',
        'profile\\default=false',
        'profile=0',
        'profiles\\1\\button_a\\default=true',
        'profiles\\1\\button_a="code:65,engine:keyboard"',
        'profiles\\1\\circle_pad\\default=true',
        'profiles\\1\\circle_pad="down:code$016777237$1engine$0keyboard,engine:analog_from_button"',
        'profiles\\1\\name\\default=false',
        'profiles\\1\\name=Mine',
        'profiles\\2\\name=Other',
        'profiles\\size=2',
        '',
        '[Miscellaneous]',
        'check_for_update_on_start\\default=true',
        'check_for_update_on_start=true',
        ''
      ].join('\r\n')
    )
    await applyPresets(ctx(false))
    const c = await readIniSection(ini, 'Controls')
    expect(iniValue(c, 'profile')).toBe('0')
    expect(iniValue(c, 'profiles\\size')).toBe('2')
    expect(iniValue(c, 'profiles\\1\\name')).toBe('Mine')
    expect(iniValue(c, 'profiles\\2\\name')).toBe('Other')
    expect(iniValue(c, 'profiles\\1\\button_a\\default')).toBe('false')
    expect(iniValue(c, 'profiles\\1\\button_a')).toBe(AZAHAR_BINDINGS.button_a)
    expect(iniValue(await readIniSection(ini, 'Miscellaneous'), 'check_for_update_on_start')).toBe(
      'true'
    )
  })

  it('keeps a controller mapping the user made', async () => {
    await mkdir(join(E, 'user', 'config'), { recursive: true })
    const mine = 'profiles\\1\\button_a="button:1,engine:sdl,guid:abc,port:0"'
    await writeFile(
      ini,
      `[Controls]\r\nprofiles\\1\\button_a\\default=false\r\n${mine}\r\nprofiles\\size=1\r\n`
    )
    await applyPresets(ctx(true))
    const c = await readIniSection(ini, 'Controls')
    expect(c).toContain(mine)
    expect(iniValue(c, 'profiles\\1\\button_b')).toBeUndefined()
  })

  it('keeps a keyboard layout the user customised in profile 1', async () => {
    await mkdir(join(E, 'user', 'config'), { recursive: true })
    const mine = 'profiles\\1\\button_a="code:90,engine:keyboard"'
    await writeFile(
      ini,
      [
        '[Controls]',
        'profiles\\1\\button_a\\default=false',
        mine,
        'profiles\\1\\button_b\\default=true',
        'profiles\\1\\button_b="code:83,engine:keyboard"',
        'profiles\\size=1',
        ''
      ].join('\r\n')
    )
    await applyPresets(ctx(true))
    const c = await readIniSection(ini, 'Controls')
    expect(c).toContain(mine)
    expect(iniValue(c, 'profiles\\1\\button_b')).toBe('"code:83,engine:keyboard"')
    expect(iniValue(c, 'profiles\\1\\input_maptype')).toBeUndefined()
  })

  it('leaves profile 1 alone while another profile is selected', async () => {
    await mkdir(join(E, 'user', 'config'), { recursive: true })
    await writeFile(
      ini,
      [
        '[Controls]',
        'profile\\default=false',
        'profile=1',
        'profiles\\1\\button_a\\default=true',
        'profiles\\1\\button_a="code:65,engine:keyboard"',
        'profiles\\2\\name=Other',
        'profiles\\size=2',
        ''
      ].join('\r\n')
    )
    await applyPresets(ctx(true))
    const c = await readIniSection(ini, 'Controls')
    expect(iniValue(c, 'profile')).toBe('1')
    expect(iniValue(c, 'profiles\\1\\button_a\\default')).toBe('true')
    expect(iniValue(c, 'profiles\\1\\button_a')).toBe('"code:65,engine:keyboard"')
    expect(iniValue(c, 'profiles\\1\\button_b')).toBeUndefined()
  })

  it('treats profile 1 as unmapped only when every binding is absent, empty or flagged default', () => {
    const base = ['profiles\\size=1']
    expect(hasControllerMapping(base)).toBe(false)
    expect(hasControllerMapping([...base, 'profiles\\1\\button_a='])).toBe(false)
    expect(
      hasControllerMapping([
        ...base,
        'profiles\\1\\button_a\\default=true',
        'profiles\\1\\button_a="code:65,engine:keyboard"'
      ])
    ).toBe(false)
    expect(hasControllerMapping([...base, 'profiles\\1\\button_a="code:90,engine:keyboard"'])).toBe(
      true
    )
    expect(
      hasControllerMapping([
        ...base,
        'profiles\\1\\circle_pad\\default=false',
        'profiles\\1\\circle_pad="engine:analog_from_button,up:code$090"'
      ])
    ).toBe(true)
  })

  it('treats a profile array without size as unmapped', () => {
    expect(hasControllerMapping(null)).toBe(false)
    expect(hasControllerMapping(['profiles\\1\\button_a="engine:sdl"'])).toBe(false)
    expect(hasControllerMapping(['profiles\\size=1', 'profiles\\1\\button_a="engine:sdl"'])).toBe(
      true
    )
  })
})
