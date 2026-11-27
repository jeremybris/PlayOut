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
}): Game =>
  ({
    source: 'steam',
    launch: { kind: 'uri', uri: '' },
    metadata: controls ? { steamTags: { tags: [], controls } } : {}
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
  it('lists VR, Controller, Mouse and Keyboard and Touch, in that order', () => {
    expect(CONTROLS_FILTERS.map((c) => c.label)).toEqual([
      'VR',
      'Controller',
      'Mouse and Keyboard',
      'Touch'
    ])
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
    expect(controlsFilterIds(pc({ controller: null, vr: null, touch: 'supported' }))).toEqual([
      'keyboard',
      'touch'
    ])
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
