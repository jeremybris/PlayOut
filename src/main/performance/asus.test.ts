import { describe, expect, it } from 'vitest'
import { asusCaps, asusModeValue, asusWattsWrites, ATK_DEVID, dstsPresent } from './asus'
import { clampWatts, resolveLimits } from './limits'

describe('dstsPresent', () => {
  it('needs the presence bit of a successful call', () => {
    expect(dstsPresent(0x22030000)).toBe(true) // the Zenbook Duo's thermal policy
    expect(dstsPresent(0x00010000)).toBe(true)
    expect(dstsPresent(0x00020000)).toBe(false)
    expect(dstsPresent(-1)).toBe(false)
    expect(dstsPresent(null)).toBe(false)
  })
})

describe('asusCaps', () => {
  it('reads the Zenbook Duo: Vivo thermal policy in Standard, no PPT device ids', () => {
    expect(asusCaps({ vivo: 0x22030000, rog: -1, pl1: -1, pl2: -1 })).toEqual({
      modeDevice: 'vivo',
      modeValue: 0,
      watts: false
    })
  })

  it('prefers the ROG policy (as G-Helper does) and needs both PPT ids for watts', () => {
    expect(asusCaps({ vivo: 0x10000, rog: 0x10002, pl1: 0x10000, pl2: 0x10000 })).toEqual({
      modeDevice: 'rog',
      modeValue: 2,
      watts: true
    })
    expect(asusCaps({ vivo: -1, rog: -1, pl1: 0x10000, pl2: -1 }).watts).toBe(false)
  })

  it('gives no value when the low bits are not a mode', () => {
    expect(asusCaps({ vivo: 0x1ffff, rog: -1, pl1: -1, pl2: -1 }).modeValue).toBeNull()
  })

  it('is empty on a PC without ATKACPI', () => {
    expect(asusCaps(null)).toEqual({ modeDevice: null, modeValue: null, watts: false })
  })
})

describe('asusModeValue', () => {
  it('maps Windows modes to Whisper / Standard / Performance and Silent / Balanced / Turbo', () => {
    expect(
      ['efficiency', 'balanced', 'performance'].map((m) => asusModeValue('vivo', m as 'balanced'))
    ).toEqual([1, 0, 2])
    expect(
      ['efficiency', 'balanced', 'performance'].map((m) => asusModeValue('rog', m as 'balanced'))
    ).toEqual([2, 0, 1])
  })
})

describe('asusWattsWrites', () => {
  it('writes PL1 first, then PL2 (PL1 + 1 when the profile has no boost)', () => {
    expect(asusWattsWrites(15, 25)).toEqual([
      { devid: ATK_DEVID.PL1, value: 15 },
      { devid: ATK_DEVID.PL2, value: 25 }
    ])
    expect(asusWattsWrites(15, null)).toEqual([
      { devid: ATK_DEVID.PL1, value: 15 },
      { devid: ATK_DEVID.PL2, value: 16 }
    ])
    expect(asusWattsWrites(null, 30)).toEqual([{ devid: ATK_DEVID.PL2, value: 30 }])
    expect(asusWattsWrites(null, null)).toEqual([])
  })
})

describe('resolveLimits', () => {
  const range = { min: 5, max: 30 }

  it('clamps and rounds', () => {
    expect(clampWatts(2, range)).toBe(5)
    expect(clampWatts(99, range)).toBe(30)
    expect(resolveLimits(12.4, 20.6, range)).toEqual({ watts: 12, boostWatts: 21 })
  })

  it('keeps boost at least 1 W above sustained', () => {
    expect(resolveLimits(20, 15, range)).toEqual({ watts: 20, boostWatts: 21 })
    expect(resolveLimits(40, 40, range)).toEqual({ watts: 29, boostWatts: 30 })
  })

  it('leaves null limits null and ignores non-finite values', () => {
    expect(resolveLimits(null, 25, range)).toEqual({ watts: null, boostWatts: 25 })
    expect(resolveLimits(Number.NaN, null, range)).toEqual({ watts: null, boostWatts: null })
    expect(resolveLimits(10, 12, { min: 10, max: 5 })).toEqual({ watts: null, boostWatts: null })
  })
})
