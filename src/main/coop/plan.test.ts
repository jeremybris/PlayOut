import type { CoopDevice, CoopScreen } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { autoLayout, layoutGrid, planSession, usableDevices } from './plan'

const pad = (i: number): CoopDevice => ({
  id: `xinput:${i}`,
  kind: 'xinput',
  index: i,
  name: 'Pad'
})
const dpad: CoopDevice = { id: 'dinput:{a}', kind: 'dinput', guid: '{a}', name: 'DS4' }
const kb: CoopDevice = { id: 'kb', kind: 'keyboard', name: 'Keyboard and mouse' }
const screen = (index: number, height = 1440, primary = index === 0): CoopScreen => ({
  index,
  primary,
  bounds: { x: index * 2560, y: 0, width: 2560, height }
})
const handler = {
  maxPlayers: 4,
  maxPlayersOneMonitor: 4,
  supportsKeyboard: true,
  supportsMultipleKeyboardsAndMice: false
}

describe('autoLayout', () => {
  it('stacks two players when the monitor is tall enough, else side by side', () => {
    expect(autoLayout(2, screen(0, 1440))).toBe('DualHorizontal')
    expect(autoLayout(2, screen(0, 1080))).toBe('DualHorizontal')
    expect(autoLayout(2, screen(0, 900))).toBe('DualVertical')
    expect(autoLayout(3, screen(0))).toBe('FourPlayers')
    expect(autoLayout(7, screen(0))).toBe('EightPlayers')
    expect(layoutGrid('DualHorizontal')).toEqual({ rows: 2, cols: 1 })
  })
})

describe('usableDevices', () => {
  it('orders XInput slots first and leaves the keyboard out unless allowed', () => {
    expect(usableDevices([kb, dpad, pad(1), pad(0)], false).map((d) => d.id)).toEqual([
      'xinput:0',
      'xinput:1',
      'dinput:{a}'
    ])
    expect(usableDevices([kb, pad(0)], true).map((d) => d.id)).toEqual(['xinput:0', 'kb'])
  })
})

describe('planSession', () => {
  it('gives one player per controller, stacked', () => {
    const p = planSession({
      handler,
      devices: [pad(0), pad(1), kb],
      screens: [screen(0)],
      keyboardAllowed: false
    })
    expect(p.problem).toBeNull()
    expect(p.players.map((x) => [x.device.id, x.screen, x.slot])).toEqual([
      ['xinput:0', 0, 0],
      ['xinput:1', 0, 1]
    ])
    expect(p.layout).toBe('DualHorizontal')
  })

  it('counts the keyboard only when allowed and supported', () => {
    expect(
      planSession({ handler, devices: [pad(0), kb], screens: [screen(0)], keyboardAllowed: true })
        .players
    ).toHaveLength(2)
    const noKb = { ...handler, supportsKeyboard: false }
    const p = planSession({
      handler: noKb,
      devices: [pad(0), kb],
      screens: [screen(0)],
      keyboardAllowed: true
    })
    expect(p.players).toHaveLength(1)
    expect(p.problem).toMatch(/two players/)
  })

  it('suggests allowing the keyboard when one controller is not enough', () => {
    const p = planSession({
      handler,
      devices: [pad(0), kb],
      screens: [screen(0)],
      keyboardAllowed: false
    })
    expect(p.problem).toMatch(/keyboard and mouse/)
  })

  it('caps at the handler maximum and follows the user setup', () => {
    const p = planSession({
      handler: { ...handler, maxPlayers: 2 },
      devices: [pad(0), pad(1), pad(2)],
      screens: [screen(0)],
      keyboardAllowed: false
    })
    expect(p.players).toHaveLength(2)
    const custom = planSession({
      handler,
      devices: [pad(0), pad(1), pad(2)],
      screens: [screen(0)],
      keyboardAllowed: false,
      setup: { players: 2, layout: 'DualVertical', devices: ['xinput:2'] }
    })
    expect(custom.layout).toBe('DualVertical')
    expect(custom.players.map((x) => x.device.id)).toEqual(['xinput:2', 'xinput:0'])
  })

  it('spreads players over monitors when one monitor takes fewer', () => {
    const p = planSession({
      handler: { ...handler, maxPlayersOneMonitor: 1 },
      devices: [pad(0), pad(1)],
      screens: [screen(1, 1440, false), screen(0)],
      keyboardAllowed: false
    })
    expect(p.players.map((x) => x.screen)).toEqual([0, 1])
    expect(p.screens).toEqual([
      { index: 0, layout: 'FullScreen' },
      { index: 1, layout: 'FullScreen' }
    ])
  })

  it('uses every monitor by default, the main one first, each split like one monitor', () => {
    const two = [screen(1, 1440, false), screen(0)]
    const plan = (n: number, extra = {}): ReturnType<typeof planSession> =>
      planSession({
        handler: { ...handler, maxPlayers: 8, maxPlayersOneMonitor: 8 },
        devices: Array.from({ length: n }, (_, i) => pad(i)),
        screens: two,
        keyboardAllowed: false,
        ...extra
      })
    // Two players: each gets a whole monitor.
    expect(plan(2).screens).toEqual([
      { index: 0, layout: 'FullScreen' },
      { index: 1, layout: 'FullScreen' }
    ])
    expect(plan(2).players.map((x) => [x.device.id, x.screen, x.slot])).toEqual([
      ['xinput:0', 0, 0],
      ['xinput:1', 1, 0]
    ])
    // Three: two on the main monitor (split by the two-player preference), one on the other.
    expect(plan(3).screens).toEqual([
      { index: 0, layout: 'DualHorizontal' },
      { index: 1, layout: 'FullScreen' }
    ])
    expect(plan(3, { twoPlayerLayout: 'sideBySide' }).screens[0]!.layout).toBe('DualVertical')
    // Four: two and two; five: three (2×2) and two.
    expect(plan(4).screens.map((s) => s.layout)).toEqual(['DualHorizontal', 'DualHorizontal'])
    expect(plan(5).screens.map((s) => s.layout)).toEqual(['FourPlayers', 'DualHorizontal'])
    expect(plan(5).players.filter((x) => x.screen === 0)).toHaveLength(3)
    // A layout picked in Co-Op setup keeps everyone on the main monitor while it holds them.
    expect(plan(2, { setup: { layout: 'DualVertical' } }).screens).toEqual([
      { index: 0, layout: 'DualVertical' }
    ])
  })

  it('drops a picked layout that no longer holds every player, and never splits a lone player', () => {
    const two = [screen(0), screen(1, 1440, false)]
    // DualVertical picked for two, then a third controller: on two monitors side by side on the main one and the
    // third player full screen on the other; on one monitor the pick no longer fits, so automatic (all three play).
    const third = {
      handler: { ...handler, maxPlayers: 8, maxPlayersOneMonitor: 8 },
      devices: [pad(0), pad(1), pad(2)],
      keyboardAllowed: false,
      setup: { layout: 'DualVertical' as const }
    }
    expect(planSession({ ...third, screens: two }).screens).toEqual([
      { index: 0, layout: 'DualVertical' },
      { index: 1, layout: 'FullScreen' }
    ])
    const one = planSession({ ...third, screens: [screen(0)] })
    expect(one.players).toHaveLength(3)
    expect(one.screens).toEqual([{ index: 0, layout: 'FourPlayers' }])
    // One player per monitor (handler limit) with a picked layout: each still gets the whole monitor.
    const single = planSession({
      handler: { ...handler, maxPlayersOneMonitor: 1 },
      devices: [pad(0), pad(1)],
      screens: two,
      keyboardAllowed: false,
      setup: { layout: 'DualVertical' }
    })
    expect(single.screens.map((s) => s.layout)).toEqual(['FullScreen', 'FullScreen'])
    // The handler's per-monitor limit caps the players first: a two-player pick still fits two of three pads.
    const capped = planSession({
      handler: { ...handler, maxPlayersOneMonitor: 2 },
      devices: [pad(0), pad(1), pad(2)],
      screens: [screen(0)],
      keyboardAllowed: false,
      setup: { layout: 'DualVertical' }
    })
    expect(capped.players).toHaveLength(2)
    expect(capped.layout).toBe('DualVertical')
  })

  it('says when no controller is connected', () => {
    expect(
      planSession({ handler, devices: [], screens: [screen(0)], keyboardAllowed: false }).problem
    ).toMatch(/No controllers/)
  })
})

describe('contentRootFor', () => {
  it('keeps instance folders on the game drive', async () => {
    const { contentRootFor } = await import('./coop-service')
    expect(contentRootFor('D:\\Games\\X\\x.exe', 'C:\\Users\\a\\AppData\\coop\\engine')).toBe(
      'D:\\PlayOut Co-Op'
    )
    expect(contentRootFor('C:\\Games\\x.exe', 'C:\\Users\\a\\coop\\engine')).toBeUndefined()
  })
})

describe('two-player preference', () => {
  const two = [pad(0), pad(1)]
  it('puts two players side by side when preferred, stacked by default', () => {
    expect(autoLayout(2, screen(0, 1440), 'sideBySide')).toBe('DualVertical')
    expect(
      planSession({ handler, devices: two, screens: [screen(0)], keyboardAllowed: false }).layout
    ).toBe('DualHorizontal')
    expect(
      planSession({
        handler,
        devices: two,
        screens: [screen(0)],
        keyboardAllowed: false,
        twoPlayerLayout: 'sideBySide'
      }).layout
    ).toBe('DualVertical')
  })

  it("leaves three or more players and a game's own layout alone", () => {
    expect(autoLayout(3, screen(0), 'sideBySide')).toBe('FourPlayers')
    expect(
      planSession({
        handler,
        devices: two,
        screens: [screen(0)],
        keyboardAllowed: false,
        twoPlayerLayout: 'sideBySide',
        setup: { layout: 'DualHorizontal' }
      }).layout
    ).toBe('DualHorizontal')
  })
})
