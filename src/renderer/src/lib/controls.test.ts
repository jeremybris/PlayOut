import { applyEditToMetadata, controlsFromPicks, type ControlsPick } from '@shared/metadata-edit'
import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  CONTROLS_FILTERS,
  controlsFilterIds,
  controlsFilterLabel,
  gameControls,
  libraryControlsFilters
} from './controls'

const pc = (controls?: {
  controller: 'full' | 'partial' | null
  vr: 'only' | 'supported' | null
  touch?: 'supported'
  keyboard?: 'full'
  lightgun?: 'supported'
}): Game =>
  ({
    source: 'steam',
    launch: { kind: 'uri', uri: '' },
    metadata: controls ? { steamTags: { tags: [], controls } } : {}
  }) as unknown as Game

/** A PC game whose Edit sheet rows picked these controls. */
const picked = (...picks: ControlsPick[]): Game =>
  ({
    source: 'steam',
    launch: { kind: 'uri', uri: '' },
    metadata: applyEditToMetadata({}, { controls: controlsFromPicks(picks) })
  }) as unknown as Game

describe('gameControls', () => {
  it("follows Steam's controller and VR support, else keyboard and mouse", () => {
    expect(gameControls(pc({ controller: 'full', vr: null })).kind).toBe('controller')
    expect(gameControls(pc({ controller: 'partial', vr: null })).kind).toBe('partial')
    expect(gameControls(pc({ controller: null, vr: 'only' })).kind).toBe('vr-only')
    expect(gameControls(pc({ controller: null, vr: 'supported' })).kind).toBe('vr')
    expect(gameControls(pc({ controller: 'full', vr: 'supported' })).text).toMatch(
      /Full controller.*VR supported/
    )
    expect(gameControls(pc({ controller: null, vr: null })).kind).toBe('keyboard')
    // Nothing known from Steam: keyboard and mouse.
    expect(gameControls(pc()).kind).toBe('keyboard')
  })

  it('takes a console game (a ROM) as played with a controller', () => {
    const rom = {
      source: 'rom',
      launch: { kind: 'emulator', systemId: 'ps2', romPath: 'x' },
      metadata: {}
    } as unknown as Game
    expect(gameControls(rom).kind).toBe('controller')
  })
})

describe('Controls filter', () => {
  it('lists VR, Controller, Mouse and Keyboard, Touch and Lightgun, in that order', () => {
    expect(CONTROLS_FILTERS.map((c) => c.label)).toEqual([
      'VR',
      'Controller',
      'Mouse and Keyboard',
      'Touch',
      'Lightgun'
    ])
    expect(controlsFilterLabel('lightgun')).toBe('Lightgun')
    expect(controlsFilterLabel('touch')).toBe('Touch')
    expect(controlsFilterLabel('keyboard')).toBe('Mouse and Keyboard')
  })

  it('puts each game under the ways it is played', () => {
    expect(controlsFilterIds(pc({ controller: null, vr: 'only' }))).toEqual(['vr'])
    expect(controlsFilterIds(pc({ controller: null, vr: 'supported' }))).toEqual(['vr', 'keyboard'])
    expect(controlsFilterIds(pc({ controller: 'full', vr: null }))).toEqual(['controller'])
    expect(controlsFilterIds(pc({ controller: 'partial', vr: null }))).toEqual([
      'controller',
      'keyboard'
    ])
    expect(controlsFilterIds(pc())).toEqual(['keyboard'])
    const rom = { source: 'rom', launch: { kind: 'emulator' }, metadata: {} } as unknown as Game
    expect(controlsFilterIds(rom)).toEqual(['controller'])
  })
})

describe('Controls filter: touch', () => {
  it('adds Touch to the ways a game with touch support is played', () => {
    expect(controlsFilterIds(pc({ controller: 'full', vr: null, touch: 'supported' }))).toEqual([
      'controller',
      'touch'
    ])
    // Touch only: under Touch alone.
    expect(controlsFilterIds(pc({ controller: null, vr: null, touch: 'supported' }))).toEqual([
      'touch'
    ])
    expect(
      controlsFilterIds(pc({ controller: null, vr: 'supported', touch: 'supported' }))
    ).toEqual(['vr', 'keyboard', 'touch'])
    expect(controlsFilterIds(pc({ controller: 'full', vr: null }))).not.toContain('touch')
  })
})

describe('libraryControlsFilters', () => {
  const rom = { source: 'rom', launch: { kind: 'emulator' }, metadata: {} } as unknown as Game

  it('offers only the choices some game falls under, in the menu order', () => {
    expect(libraryControlsFilters([])).toEqual([])
    expect(libraryControlsFilters([rom])).toEqual(['controller'])
    expect(libraryControlsFilters([pc(), rom])).toEqual(['controller', 'keyboard'])
    expect(libraryControlsFilters([pc({ controller: null, vr: 'supported' }), rom])).toEqual([
      'vr',
      'controller',
      'keyboard'
    ])
  })

  it("has no Touch with today's data, and Touch once a game has touch support", () => {
    const today = [
      pc({ controller: 'full', vr: 'supported' }),
      pc({ controller: 'partial', vr: 'only' }),
      pc(),
      rom
    ]
    expect(libraryControlsFilters(today)).not.toContain('touch')
    expect(
      libraryControlsFilters([...today, pc({ controller: null, vr: null, touch: 'supported' })])
    ).toEqual(['vr', 'controller', 'keyboard', 'touch'])
  })
})

describe('the Edit sheet Controls rows', () => {
  // The game as the picks saved in the Edit sheet leave it (the edit laid over its metadata).
  const chosen = (...picks: ControlsPick[]): Game =>
    ({
      source: 'steam',
      launch: { kind: 'uri', uri: '' },
      metadata: applyEditToMetadata({}, { controls: controlsFromPicks(picks) })
    }) as unknown as Game

  // The old 7 choices' picks, and the new single picks.
  const SETS: ControlsPick[][] = [
    ['vr'],
    ['touch'],
    ['full'],
    ['partial'],
    ['keyboard'],
    ['full', 'keyboard'],
    ['full', 'keyboard', 'vr'],
    ['lightgun']
  ]

  it('gives each set its badge', () => {
    expect(SETS.map((p) => gameControls(chosen(...p)).kind)).toEqual([
      'vr-only',
      'touch',
      'controller',
      'partial',
      'keyboard',
      'both',
      'all',
      'lightgun'
    ])
    expect(SETS.map((p) => gameControls(chosen(...p)).label)).toEqual([
      'VR',
      'Touch',
      'Pad',
      'Partial',
      'KB+M',
      'Pad+KB+M',
      'All',
      'Gun'
    ])
    expect(gameControls(chosen('full', 'keyboard')).text).toBe(
      'Full controller support and full mouse and keyboard support'
    )
    expect(gameControls(chosen('touch')).text).toBe('Touch screen')
    expect(gameControls(chosen('lightgun')).text).toBe('Played with a light gun')
    // With other controls a light gun only adds to Filters > Controls, like touch.
    expect(gameControls(chosen('full', 'lightgun')).kind).toBe('controller')
    expect(gameControls(chosen('keyboard', 'lightgun')).kind).toBe('keyboard')
    expect(gameControls(chosen('keyboard', 'touch')).kind).toBe('keyboard')
    expect(gameControls(chosen('touch', 'lightgun')).kind).toBe('touch')
  })

  it('puts each set under its Filters > Controls choices', () => {
    expect(SETS.map((p) => controlsFilterIds(chosen(...p)))).toEqual([
      ['vr'],
      ['touch'],
      ['controller'],
      ['controller', 'keyboard'],
      ['keyboard'],
      ['controller', 'keyboard'],
      ['vr', 'controller', 'keyboard'],
      ['lightgun']
    ])
    expect(controlsFilterIds(chosen('full', 'lightgun'))).toEqual(['controller', 'lightgun'])
    expect(controlsFilterIds(chosen('keyboard', 'lightgun'))).toEqual(['keyboard', 'lightgun'])
    expect(controlsFilterIds(chosen('vr', 'touch', 'lightgun'))).toEqual([
      'vr',
      'touch',
      'lightgun'
    ])
    expect(libraryControlsFilters([chosen('touch')])).toEqual(['touch'])
    expect(
      libraryControlsFilters([
        chosen('full', 'keyboard', 'vr'),
        chosen('touch'),
        chosen('lightgun')
      ])
    ).toEqual(['vr', 'controller', 'keyboard', 'touch', 'lightgun'])
  })

  it('lets VR only win over full controller and keyboard support', () => {
    const game = pc({ controller: 'full', vr: 'only', keyboard: 'full' })
    expect(gameControls(game).kind).toBe('vr-only')
    expect(controlsFilterIds(game)).toEqual(['vr'])
  })

  it('keeps a console game on Pad whatever its metadata says', () => {
    const rom = {
      ...chosen('lightgun'),
      source: 'rom',
      launch: { kind: 'emulator', systemId: 'ps2', romPath: 'x' }
    } as unknown as Game
    expect(gameControls(rom).kind).toBe('controller')
  })
})

describe('Controls filter: lightgun', () => {
  const rom = { source: 'rom', launch: { kind: 'emulator' }, metadata: {} } as unknown as Game

  it('has no Lightgun while no game is played with one, and Lightgun once one is', () => {
    const today = [
      pc({ controller: 'full', vr: 'supported' }),
      pc({ controller: null, vr: null, touch: 'supported' }),
      pc(),
      rom
    ]
    expect(libraryControlsFilters(today)).not.toContain('lightgun')
    expect(
      libraryControlsFilters([...today, pc({ controller: null, vr: null, lightgun: 'supported' })])
    ).toEqual(['vr', 'controller', 'keyboard', 'touch', 'lightgun'])
  })
})

describe('Controls filter: VR next to a controller', () => {
  it('lists Full + VR and Partial + VR (and with Touch / Lightgun) under VR too', () => {
    expect(controlsFilterIds(picked('full', 'vr')).sort()).toEqual(['controller', 'vr'])
    expect(controlsFilterIds(picked('partial', 'vr')).sort()).toEqual([
      'controller',
      'keyboard',
      'vr'
    ])
    expect(controlsFilterIds(picked('full', 'vr', 'lightgun')).sort()).toEqual([
      'controller',
      'lightgun',
      'vr'
    ])
    expect(controlsFilterIds(picked('full', 'vr', 'touch')).sort()).toEqual([
      'controller',
      'touch',
      'vr'
    ])
    // Scraped Steam data reads the same way.
    expect(controlsFilterIds(pc({ controller: 'full', vr: 'supported' })).sort()).toEqual([
      'controller',
      'vr'
    ])
    // The badge is unchanged.
    expect(gameControls(picked('full', 'vr')).kind).toBe('controller')
  })

  it('offers VR in Filters > Controls once a Full + VR game is in the list', () => {
    expect(libraryControlsFilters([picked('full', 'vr')])).toEqual(['vr', 'controller'])
  })
})

describe('Controls on a console game', () => {
  const romWith = (...picks: ControlsPick[]): Game =>
    ({
      ...picked(...picks),
      source: 'rom',
      launch: { kind: 'emulator', systemId: 'nes', romPath: 'x' }
    }) as unknown as Game

  it('files a ROM picked Lightgun under Controller and Lightgun, its badge still Pad', () => {
    expect(controlsFilterIds(romWith('full', 'lightgun')).sort()).toEqual([
      'controller',
      'lightgun'
    ])
    expect(controlsFilterIds(romWith('lightgun')).sort()).toEqual(['controller', 'lightgun'])
    expect(gameControls(romWith('lightgun')).kind).toBe('controller')
    expect(libraryControlsFilters([romWith('lightgun')])).toEqual(['controller', 'lightgun'])
  })

  it('adds Touch and VR picks for a ROM the same way', () => {
    expect(controlsFilterIds(romWith('full', 'touch', 'vr')).sort()).toEqual([
      'controller',
      'touch',
      'vr'
    ])
  })

  it('keeps a ROM with no controls under Controller alone', () => {
    const rom = { source: 'rom', launch: { kind: 'emulator' }, metadata: {} } as unknown as Game
    expect(controlsFilterIds(rom)).toEqual(['controller'])
  })
})

describe('Touch + Lightgun badge', () => {
  it('shows Touch for Touch + Lightgun alone, under both filters', () => {
    const game = picked('touch', 'lightgun')
    expect(gameControls(game).kind).toBe('touch')
    expect(controlsFilterIds(game).sort()).toEqual(['lightgun', 'touch'])
  })
})
