import { describe, expect, it } from 'vitest'
import { orderChoices, orderEmulators, orderSystems } from './emulatorOrder'

describe('emulator order', () => {
  it('puts the emulators this PC has first, each group alphabetical', () => {
    const list = [
      { name: 'xemu', path: null },
      { name: 'RPCS3', path: 'C:/rpcs3.exe' },
      { name: 'Dolphin', path: null },
      { name: 'PCSX2', path: 'C:/pcsx2.exe' },
      { name: 'cemu', path: null },
      { name: 'DuckStation', path: 'C:/duck.exe' }
    ]
    expect(orderEmulators(list).map((e) => e.name)).toEqual([
      'DuckStation',
      'PCSX2',
      'RPCS3',
      'cemu',
      'Dolphin',
      'xemu'
    ])
  })

  it('sorts the systems alphabetically, ignoring case', () => {
    const list = [{ name: 'Sony PlayStation 2' }, { name: 'atari 2600' }, { name: 'Nintendo 64' }]
    expect(orderSystems(list).map((s) => s.name)).toEqual([
      'atari 2600',
      'Nintendo 64',
      'Sony PlayStation 2'
    ])
  })

  it('lists a system\u2019s available choices first', () => {
    const list = [
      { id: 'mame', label: 'MAME' },
      { id: 'ra', label: 'RetroArch' },
      { id: 'fb', label: 'FinalBurn Neo' }
    ]
    expect(orderChoices(list, new Set(['ra'])).map((c) => c.id)).toEqual(['ra', 'fb', 'mame'])
  })
})
