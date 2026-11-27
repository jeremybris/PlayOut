import { describe, expect, it } from 'vitest'
import { effectiveEmulatorCommand, findEmulatorCommand } from './emulators'
import type { Game, SystemDefinition } from './types'

const ps4: Pick<SystemDefinition, 'id' | 'emulators'> = {
  id: 'ps4',
  emulators: [
    { id: 'shadps4-shortcut', label: 'shadPS4 (Shortcut)', command: '%EMULATOR_SHADPS4% %ROM%' },
    {
      id: 'shadps4-eboot',
      label: 'shadPS4 (eboot.bin)',
      command: '%EMULATOR_SHADPS4% %ROM%',
      aliases: ['old-eboot']
    },
    { id: 'shadps4-serial', label: 'shadPS4 (Serial)', command: '%EMULATOR_SHADPS4% %ROM%' }
  ]
}

const game = (user: Game['user'] = {}, scan?: string): Pick<Game, 'user' | 'launch'> => ({
  user,
  launch: { kind: 'emulator', systemId: 'ps4', romPath: 'C:\\x', emulatorId: scan }
})

describe('findEmulatorCommand', () => {
  it('matches ids, labels and aliases exactly', () => {
    expect(findEmulatorCommand(ps4, 'shadPS4 (Serial)')?.id).toBe('shadps4-serial')
    expect(findEmulatorCommand(ps4, 'old-eboot')?.id).toBe('shadps4-eboot')
    expect(findEmulatorCommand(ps4, 'nope')).toBeUndefined()
    expect(findEmulatorCommand(ps4, undefined)).toBeUndefined()
  })
})

describe('effectiveEmulatorCommand', () => {
  it('resolves request, game, scan, preferred, then the first command', () => {
    const preferred = { ps4: 'shadps4-serial' }
    expect(effectiveEmulatorCommand(ps4, game(), undefined)?.id).toBe('shadps4-shortcut')
    expect(effectiveEmulatorCommand(ps4, game(), preferred)?.id).toBe('shadps4-serial')
    expect(effectiveEmulatorCommand(ps4, game({}, 'old-eboot'), preferred)?.id).toBe(
      'shadps4-eboot'
    )
    expect(
      effectiveEmulatorCommand(
        ps4,
        game({ emulatorId: 'shadps4-shortcut' }, 'old-eboot'),
        preferred
      )?.id
    ).toBe('shadps4-shortcut')
    expect(
      effectiveEmulatorCommand(ps4, game({ emulatorId: 'shadps4-shortcut' }), preferred, {
        requested: 'shadPS4 (Serial)'
      })?.id
    ).toBe('shadps4-serial')
  })

  it('skips names that resolve to nothing and reports them', () => {
    const unknown: string[] = []
    const command = effectiveEmulatorCommand(
      ps4,
      game({ emulatorId: 'gone' }, 'also-gone'),
      { ps4: 'old-eboot' },
      { requested: 'missing', onUnknown: (name, origin) => unknown.push(`${origin}:${name}`) }
    )
    expect(command?.id).toBe('shadps4-eboot')
    expect(unknown).toEqual(['request:missing', 'game:gone', 'scan:also-gone'])
  })

  it('ignores the scan choice of a non-emulator launch', () => {
    const exec = { user: {}, launch: { kind: 'exec', exePath: 'C:\\g.exe' } } as unknown as Pick<
      Game,
      'user' | 'launch'
    >
    expect(effectiveEmulatorCommand(ps4, exec, undefined)?.id).toBe('shadps4-shortcut')
  })
})

describe('effectiveEmulatorCommand with archived ROMs', () => {
  const psx: Pick<SystemDefinition, 'id' | 'emulators'> = {
    id: 'psx',
    emulators: [
      {
        id: 'duckstation-standalone',
        label: 'DuckStation (Standalone)',
        command: '%EMULATOR_DUCKSTATION% -batch %ROM%',
        noArchives: true
      },
      {
        id: 'beetle-psx',
        label: 'Beetle PSX',
        command: '%EMULATOR_RETROARCH% -L %CORE_RETROARCH%\\mednafen_psx_libretro.dll %ROM%'
      },
      { id: 'swanstation', label: 'SwanStation', command: '%EMULATOR_RETROARCH% -L x %ROM%' }
    ]
  }
  const rom = (romPath: string, user: Game['user'] = {}): Pick<Game, 'user' | 'launch'> => ({
    user,
    launch: { kind: 'emulator', systemId: 'psx', romPath }
  })

  it('runs a .zip or .7z through the first RetroArch command when the default cannot open it', () => {
    expect(effectiveEmulatorCommand(psx, rom('D:\\psx\\Game.ZIP'), undefined)?.id).toBe(
      'beetle-psx'
    )
    expect(effectiveEmulatorCommand(psx, rom('D:\\psx\\Game.7z'), {})?.id).toBe('beetle-psx')
    expect(effectiveEmulatorCommand(psx, rom('D:\\psx\\Game.chd'), undefined)?.id).toBe(
      'duckstation-standalone'
    )
  })

  it('treats the system choice in Settings like the default for an archive', () => {
    const zip = 'D:\\psx\\Game.zip'
    expect(effectiveEmulatorCommand(psx, rom(zip), { psx: 'duckstation-standalone' })?.id).toBe(
      'beetle-psx'
    )
    expect(effectiveEmulatorCommand(psx, rom(zip), { psx: 'swanstation' })?.id).toBe('swanstation')
    expect(
      effectiveEmulatorCommand(psx, rom('D:\\psx\\Game.cue'), { psx: 'duckstation-standalone' })?.id
    ).toBe('duckstation-standalone')
  })

  it('keeps a choice made for the game or the launch for an archive', () => {
    const zip = 'D:\\psx\\Game.zip'
    expect(
      effectiveEmulatorCommand(psx, rom(zip, { emulatorId: 'duckstation-standalone' }), undefined)
        ?.id
    ).toBe('duckstation-standalone')
    expect(
      effectiveEmulatorCommand(psx, rom(zip), undefined, { requested: 'swanstation' })?.id
    ).toBe('swanstation')
  })

  it('falls back to the default when the system has no RetroArch command', () => {
    const only = { id: 'psx', emulators: [psx.emulators[0]] }
    expect(effectiveEmulatorCommand(only, rom('D:\\psx\\Game.zip'), undefined)?.id).toBe(
      'duckstation-standalone'
    )
  })
})
