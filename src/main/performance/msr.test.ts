import { describe, expect, it } from 'vitest'
import {
  decodePowerInfo,
  decodePowerLimit,
  encodePowerLimit,
  energyUnitJoules,
  intelWattsRange,
  powerUnitWatts
} from './msr'

// A typical laptop value: PL1 28 W (224 units) enabled + clamp, window 0x6E; PL2 64 W (512 units) enabled.
const SAMPLE = 0x0042_8200_00dd_80e0n
const U = 1 / 8

describe('RAPL units', () => {
  it('reads the power and energy units of MSR 0x606', () => {
    expect(powerUnitWatts(0xa0e03n)).toBe(0.125)
    expect(energyUnitJoules(0xa0e03n)).toBe(1 / 16384)
  })
})

describe('MSR 0x610', () => {
  it('decodes PL1, PL2, their enable bits and the lock', () => {
    expect(decodePowerLimit(SAMPLE, U)).toEqual({
      pl1: 28,
      pl1Enabled: true,
      pl2: 64,
      pl2Enabled: true,
      locked: false
    })
    expect(decodePowerLimit(SAMPLE | (1n << 63n), U).locked).toBe(true)
  })

  it('replaces both limits and keeps the time windows, clamp bits and lock bit', () => {
    const next = encodePowerLimit(SAMPLE, U, 15, 25)
    expect(decodePowerLimit(next, U)).toMatchObject({ pl1: 15, pl2: 25, pl1Enabled: true })
    const fieldMask = 0x7fffn | (0x7fffn << 32n)
    expect(next & ~fieldMask).toBe(SAMPLE & ~fieldMask)
    const locked = encodePowerLimit(SAMPLE | (1n << 63n), U, 15, null)
    expect(locked >> 63n).toBe(1n)
  })

  it('leaves a half alone when its limit is null', () => {
    const next = encodePowerLimit(SAMPLE, U, null, 40)
    expect(next & 0xffffn).toBe(SAMPLE & 0xffffn)
    expect(decodePowerLimit(next, U).pl2).toBe(40)
  })

  it('sets the enable bit of a limit the firmware left disabled', () => {
    const next = encodePowerLimit(0n, U, 10, 12)
    expect(decodePowerLimit(next, U)).toMatchObject({ pl1Enabled: true, pl2Enabled: true })
  })

  it('rounds to the nearest unit and clamps to the 15-bit field (at least 1 unit)', () => {
    expect(decodePowerLimit(encodePowerLimit(0n, U, 15.07, null), U).pl1).toBe(15.125)
    expect(decodePowerLimit(encodePowerLimit(0n, U, 99999, null), U).pl1).toBe(0x7fff / 8)
    expect(decodePowerLimit(encodePowerLimit(0n, U, 0, null), U).pl1).toBe(0.125)
  })
})

describe('MSR 0x614 and the range offered', () => {
  it('uses the reported min and max when the CPU has them', () => {
    const info = decodePowerInfo((360n << 32n) | (40n << 16n) | 224n, U)
    expect(info).toEqual({ tdp: 28, min: 5, max: 45 })
    expect(intelWattsRange(info)).toEqual({ min: 5, max: 45 })
  })

  it('falls back to 2.5 x TDP, then 115 W', () => {
    expect(intelWattsRange({ tdp: 28, min: 0, max: 0 })).toEqual({ min: 5, max: 70 })
    expect(intelWattsRange({ tdp: 0, min: 0, max: 0 })).toEqual({ min: 5, max: 115 })
    expect(intelWattsRange({ tdp: 2, min: 0, max: 0 })).toEqual({ min: 5, max: 6 })
  })
})
