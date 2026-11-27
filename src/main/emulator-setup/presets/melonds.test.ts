import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runner } from '../types'
import { applyPresets, joystickUnmapped, MELONDS_JOYSTICK } from './melonds'
import type { PresetContext } from './types'

let dir: string
let E: string
let toml: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const run: Runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))
const startHidden = vi.fn(() => {
  throw new Error('not used')
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-melonds-'))
  E = join(dir, 'melonDS')
  toml = join(E, 'melonDS.toml')
  vi.clearAllMocks()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ctx = (firstTime = true): PresetContext => ({
  emuDir: E,
  dataDir: join(dir, 'Data'),
  run,
  log,
  firstTime,
  previousVersion: firstTime ? undefined : 3,
  startHidden
})
const text = (): Promise<string> => readFile(toml, 'utf8')

describe('melonDS presets', () => {
  it('computes the combined hat + stick values', () => {
    expect(MELONDS_JOYSTICK.Up).toBe(17891585)
    expect(MELONDS_JOYSTICK.Down).toBe(16843012)
    expect(MELONDS_JOYSTICK.Left).toBe(1114376)
    expect(MELONDS_JOYSTICK.Right).toBe(65794)
  })

  it('merges JoystickID and the joystick table as integers into the paths PlayOut wrote', async () => {
    await mkdir(E, { recursive: true })
    await writeFile(
      toml,
      '[Instance0]\nSaveFilePath = "D:/saves"\n\n[DS]\nBIOS9Path = "D:/bios/bios9.bin"\n'
    )
    await applyPresets(ctx())
    expect(await text()).toBe(
      [
        '[Instance0]',
        'SaveFilePath = "D:/saves"',
        'JoystickID = 0',
        '',
        '[DS]',
        'BIOS9Path = "D:/bios/bios9.bin"',
        '',
        '[Instance0.Joystick]',
        'A = 1',
        'B = 0',
        'X = 3',
        'Y = 2',
        'L = 4',
        'R = 5',
        'Select = 6',
        'Start = 7',
        'Up = 17891585',
        'Down = 16843012',
        'Left = 1114376',
        'Right = 65794',
        ''
      ].join('\n')
    )
  })

  it('is idempotent and creates the file when missing', async () => {
    await applyPresets(ctx())
    const before = await text()
    expect(before).toContain('[Instance0.Joystick]')
    await applyPresets(ctx(false))
    expect(await text()).toBe(before)
  })

  it("replaces melonDS's all -1 table but keeps hotkeys and an existing JoystickID", async () => {
    await mkdir(E, { recursive: true })
    const keys = Object.keys(MELONDS_JOYSTICK)
    await writeFile(
      toml,
      [
        '[Instance0]',
        'JoystickID = 2',
        '',
        '[Instance0.Joystick]',
        ...keys.map((k) => `${k} = -1`),
        'HK_Lid = -1',
        ''
      ].join('\r\n')
    )
    await applyPresets(ctx())
    const t = await text()
    expect(t).toContain('JoystickID = 2\r\n')
    expect(t).not.toContain('JoystickID = 0')
    expect(t).toContain('A = 1\r\n')
    expect(t).toContain('Up = 17891585\r\n')
    expect(t).toContain('HK_Lid = -1\r\n')
    expect(t.match(/^A = /gm)).toHaveLength(1)
  })

  it('keeps a joystick mapping the user made', async () => {
    await mkdir(E, { recursive: true })
    const mine = '[Instance0.Joystick]\nA = 0\nB = -1\n'
    await writeFile(toml, mine)
    await applyPresets(ctx())
    expect(await text()).toBe(mine)
    expect(joystickUnmapped(mine.split('\n'))).toBe(false)
  })
})
