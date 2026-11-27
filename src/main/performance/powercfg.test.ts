import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../system/power'
import {
  cpuPowerCommands,
  cpuValuesForProfile,
  normalizeGuid,
  PERFBOOSTMODE,
  PROCTHROTTLEMAX,
  SUB_PROCESSOR,
  validCpuValues,
  writeCpuPower
} from './powercfg'

const profile = {
  powerMode: 'efficiency' as const,
  cpuMaxPercent: 60,
  cpuBoost: false,
  watts: null,
  boostWatts: null
}

describe('cpuValuesForProfile', () => {
  it('sets the maximum state on AC and DC, boost aggressive or disabled', () => {
    expect(cpuValuesForProfile(profile)).toEqual({ maxAc: 60, maxDc: 60, boostAc: 0, boostDc: 0 })
    expect(cpuValuesForProfile({ ...profile, cpuMaxPercent: 100, cpuBoost: true })).toEqual({
      maxAc: 100,
      maxDc: 100,
      boostAc: 2,
      boostDc: 2
    })
  })

  it('keeps the state within 5-100 %', () => {
    expect(cpuValuesForProfile({ ...profile, cpuMaxPercent: 1 }).maxAc).toBe(5)
    expect(cpuValuesForProfile({ ...profile, cpuMaxPercent: 150 }).maxAc).toBe(100)
    expect(cpuValuesForProfile({ ...profile, cpuMaxPercent: 72.6 }).maxAc).toBe(73)
  })
})

describe('validCpuValues', () => {
  it('accepts what Windows can hold, nothing else', () => {
    expect(validCpuValues({ maxAc: 100, maxDc: 0, boostAc: 4, boostDc: 6 })).toBe(true)
    expect(validCpuValues({ maxAc: 101, maxDc: 0, boostAc: 4, boostDc: 6 })).toBe(false)
    expect(validCpuValues({ maxAc: 100, maxDc: 0, boostAc: 7, boostDc: 0 })).toBe(false)
    expect(validCpuValues({ maxAc: 1.5, maxDc: 0, boostAc: 0, boostDc: 0 })).toBe(false)
    expect(validCpuValues(null)).toBe(false)
  })
})

const PLAN = '381b4222-f694-41f0-9685-ff5bb260df2e'

describe('normalizeGuid', () => {
  it('takes GUIDs with or without braces, any case, and nothing else', () => {
    expect(normalizeGuid('{381B4222-F694-41F0-9685-FF5BB260DF2E}')).toBe(PLAN)
    expect(normalizeGuid(` ${PLAN} `)).toBe(PLAN)
    expect(normalizeGuid('scheme_current')).toBeNull()
    expect(normalizeGuid('')).toBeNull()
    expect(normalizeGuid(null)).toBeNull()
  })
})

describe('cpuPowerCommands', () => {
  it('edits the captured plan by GUID (never scheme_current) and re-activates it only while it is active', () => {
    const cmds = cpuPowerCommands({ maxAc: 80, maxDc: 60, boostAc: 2, boostDc: 0 }, PLAN, true)
    expect(cmds).toEqual([
      ['/setacvalueindex', PLAN, SUB_PROCESSOR, PROCTHROTTLEMAX, '80'],
      ['/setdcvalueindex', PLAN, SUB_PROCESSOR, PROCTHROTTLEMAX, '60'],
      ['/setacvalueindex', PLAN, SUB_PROCESSOR, PERFBOOSTMODE, '2'],
      ['/setdcvalueindex', PLAN, SUB_PROCESSOR, PERFBOOSTMODE, '0'],
      ['/setactive', PLAN]
    ])
    const inactive = cpuPowerCommands({ maxAc: 80, maxDc: 60, boostAc: 2, boostDc: 0 }, PLAN, false)
    expect(inactive).toHaveLength(4)
    expect(inactive.flat()).not.toContain('/setactive')
    expect(inactive.flat()).not.toContain('scheme_current')
  })
})

describe('writeCpuPower', () => {
  it('runs powercfg for each step and stops at the first failure', async () => {
    const calls: string[][] = []
    const run: CommandRunner = async (file, args) => {
      calls.push([file, ...args])
      return calls.length === 3
        ? { code: 1, stdout: 'Access denied.\r\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    }
    await expect(
      writeCpuPower({ maxAc: 80, maxDc: 80, boostAc: 2, boostDc: 2 }, PLAN, true, run)
    ).rejects.toThrow(/setacvalueindex exit 1\): Access denied\./)
    expect(calls).toHaveLength(3)
    expect(calls[0][0]).toBe('powercfg.exe')
  })

  it('refuses invalid values or a plan that is not a GUID without running anything', async () => {
    let ran = false
    const run: CommandRunner = async () => {
      ran = true
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(
      writeCpuPower({ maxAc: 300, maxDc: 0, boostAc: 0, boostDc: 0 }, PLAN, true, run)
    ).rejects.toThrow()
    await expect(
      writeCpuPower({ maxAc: 50, maxDc: 0, boostAc: 0, boostDc: 0 }, 'scheme_current', true, run)
    ).rejects.toThrow(/plan/)
    expect(ran).toBe(false)
  })
})
