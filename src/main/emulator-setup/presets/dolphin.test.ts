import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readIniSection } from '../ini'
import type { Runner } from '../types'
import { iniValue } from './keys'
import { applyPresets, GC_PAD_LINES, isDefaultPadSection } from './dolphin'
import type { PresetContext } from './types'

let dir: string
let E: string
let cfg: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const run: Runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))
const startHidden = vi.fn(() => {
  throw new Error('not used')
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-dolphin-'))
  E = join(dir, 'Dolphin')
  cfg = join(E, 'User', 'Config')
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
const text = (p: string): Promise<string> => readFile(p, 'utf8')

describe('Dolphin presets', () => {
  it('writes fullscreen, analytics, four XInput GC pads, ports 2-4 and four Wii Remotes on a fresh install', async () => {
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'Dolphin.ini'), '[General]\r\nISOPaths = 2\r\n')
    await applyPresets(ctx(true))

    const dolphin = join(cfg, 'Dolphin.ini')
    expect(iniValue(await readIniSection(dolphin, 'General'), 'ISOPaths')).toBe('2')
    expect(iniValue(await readIniSection(dolphin, 'Display'), 'Fullscreen')).toBe('True')
    expect(iniValue(await readIniSection(dolphin, 'Analytics'), 'PermissionAsked')).toBe('True')
    expect(iniValue(await readIniSection(dolphin, 'Analytics'), 'Enabled')).toBeUndefined()
    const core = await readIniSection(dolphin, 'Core')
    expect(iniValue(core, 'SIDevice0')).toBeUndefined()
    for (const n of [1, 2, 3]) expect(iniValue(core, `SIDevice${n}`)).toBe('6')

    const gc = join(cfg, 'GCPadNew.ini')
    for (const n of [0, 1, 2, 3]) {
      const s = await readIniSection(gc, `GCPad${n + 1}`)
      expect(s).toEqual([`Device = XInput/${n}/Gamepad`, ...GC_PAD_LINES])
    }
    expect(await text(gc)).toContain('Buttons/B = `Button X`\r\n')
    const wii = join(cfg, 'WiimoteNew.ini')
    for (const n of [0, 1, 2, 3]) {
      const s = await readIniSection(wii, `Wiimote${n + 1}`)
      expect(iniValue(s, 'Device')).toBe(`XInput/${n}/Gamepad`)
      expect(iniValue(s, 'Extension')).toBe('Nunchuk')
      expect(iniValue(s, 'Source')).toBeUndefined()
      expect(iniValue(s, 'Classic/Buttons/A')).toBe('`Button B`')
    }
  })

  it('is idempotent', async () => {
    await applyPresets(ctx(true))
    const before = await Promise.all(
      ['Dolphin.ini', 'GCPadNew.ini', 'WiimoteNew.ini'].map((f) => text(join(cfg, f)))
    )
    await applyPresets(ctx(true))
    await applyPresets(ctx(false))
    const after = await Promise.all(
      ['Dolphin.ini', 'GCPadNew.ini', 'WiimoteNew.ini'].map((f) => text(join(cfg, f)))
    )
    expect(after).toEqual(before)
  })

  it('sets fullscreen only the first time and never over an existing value', async () => {
    await applyPresets(ctx(false))
    const dolphin = join(cfg, 'Dolphin.ini')
    expect(iniValue(await readIniSection(dolphin, 'Display'), 'Fullscreen')).toBeUndefined()
    expect(iniValue(await readIniSection(dolphin, 'Analytics'), 'PermissionAsked')).toBe('True')

    await writeFile(dolphin, '[Display]\r\nFullscreen = False\r\n')
    await applyPresets(ctx(true))
    expect(iniValue(await readIniSection(dolphin, 'Display'), 'Fullscreen')).toBe('False')
  })

  it("replaces Dolphin's keyboard default sections but keeps the user's own mapping", async () => {
    await mkdir(cfg, { recursive: true })
    const gc = join(cfg, 'GCPadNew.ini')
    await writeFile(
      gc,
      [
        '[GCPad1]',
        'Device = DInput/0/Keyboard Mouse',
        'Buttons/A = `X`',
        'Buttons/B = `Z`',
        'Buttons/X = `C`',
        'Buttons/Y = `S`',
        'Buttons/Z = `D`',
        'Buttons/Start = `RETURN`',
        'Main Stick/Up = `UP`',
        'Main Stick/Down = `DOWN`',
        'Main Stick/Left = `LEFT`',
        'Main Stick/Right = `RIGHT`',
        'C-Stick/Up = `I`',
        'C-Stick/Down = `K`',
        'C-Stick/Left = `J`',
        'C-Stick/Right = `L`',
        'Triggers/L = `Q`',
        'Triggers/R = `W`',
        'D-Pad/Up = `T`',
        'D-Pad/Down = `G`',
        'D-Pad/Left = `F`',
        'D-Pad/Right = `H`',
        '[GCPad2]',
        'Device = SDL/0/DualSense Wireless Controller',
        'Buttons/A = `Button S`',
        '[GCPad3]',
        'Device = DInput/0/Keyboard Mouse',
        'Buttons/A = `P`',
        '[GCPad4]',
        'Device = DInput/0/Keyboard Mouse',
        ''
      ].join('\r\n')
    )
    await mkdir(cfg, { recursive: true })
    const wii = join(cfg, 'WiimoteNew.ini')
    await writeFile(
      wii,
      '[Wiimote1]\r\nDevice = DInput/0/Keyboard Mouse\r\nSource = 2\r\nExtension = Classic\r\n'
    )
    await applyPresets(ctx(true))

    expect(iniValue(await readIniSection(gc, 'GCPad1'), 'Device')).toBe('XInput/0/Gamepad')
    expect(await readIniSection(gc, 'GCPad2')).toEqual([
      'Device = SDL/0/DualSense Wireless Controller',
      'Buttons/A = `Button S`'
    ])
    expect(iniValue(await readIniSection(gc, 'GCPad3'), 'Buttons/A')).toBe('`P`')
    expect(iniValue(await readIniSection(gc, 'GCPad4'), 'Device')).toBe('XInput/3/Gamepad')
    const core = await readIniSection(join(cfg, 'Dolphin.ini'), 'Core')
    expect(iniValue(core, 'SIDevice1')).toBeUndefined()
    expect(iniValue(core, 'SIDevice2')).toBeUndefined()
    expect(iniValue(core, 'SIDevice3')).toBe('6')

    const w1 = await readIniSection(wii, 'Wiimote1')
    expect(iniValue(w1, 'Device')).toBe('XInput/0/Gamepad')
    expect(iniValue(w1, 'Source')).toBe('2')
    expect(iniValue(w1, 'Extension')).toBe('Classic')
  })

  it('does not switch on a GC port the user already set', async () => {
    await mkdir(cfg, { recursive: true })
    await writeFile(join(cfg, 'Dolphin.ini'), '[Core]\r\nSIDevice2 = 12\r\n')
    await applyPresets(ctx(true))
    const core = await readIniSection(join(cfg, 'Dolphin.ini'), 'Core')
    expect(iniValue(core, 'SIDevice2')).toBe('12')
    expect(iniValue(core, 'SIDevice1')).toBe('6')
  })

  it('recognises default pad sections', () => {
    const d = { 'Buttons/A': 'X', 'Buttons/B': 'Z' }
    expect(isDefaultPadSection(null, d)).toBe(true)
    expect(isDefaultPadSection([], d)).toBe(true)
    expect(isDefaultPadSection(['Buttons/A = `X`', 'Buttons/B = `Z`'], d)).toBe(true)
    expect(isDefaultPadSection(['Buttons/A = `X`'], d)).toBe(false)
    expect(isDefaultPadSection(['Device = XInput/0/Gamepad'], d)).toBe(false)
  })
})
