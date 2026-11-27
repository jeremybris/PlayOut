import { describe, expect, it } from 'vitest'
import { asusWattsBackend, chooseWattsMethod, helperWattsBackend } from './backends'
import type { HelperClient } from './helper-client'
import { capRange, SETTINGS_MAX_WATTS } from './limits'
import type { PerfNative } from './native'

const noAsus = { modeDevice: null, modeValue: null, watts: false }
const intel = { name: 'Intel', id: { vendor: 'intel' as const, family: 6, model: 204 } }
const phoenix = { name: 'Z1', id: { vendor: 'amd' as const, family: 25, model: 116 } }

describe('chooseWattsMethod', () => {
  it('prefers the ASUS firmware, then PawnIO by vendor', () => {
    expect(chooseWattsMethod({ ...noAsus, watts: true }, intel)).toEqual({ method: 'asus-wmi' })
    expect(chooseWattsMethod(noAsus, intel)).toEqual({
      method: 'intel-msr',
      module: 'IntelMSR.bin'
    })
    expect(chooseWattsMethod(noAsus, phoenix)).toEqual({
      method: 'ryzen-smu',
      module: 'RyzenSMU.bin'
    })
    expect(
      chooseWattsMethod(noAsus, { name: 'x', id: { vendor: 'amd', family: 25, model: 33 } })
    ).toBeNull()
    expect(chooseWattsMethod(noAsus, null)).toBeNull()
  })
})

describe('helper backend status', () => {
  const plan = { method: 'intel-msr' as const, module: 'IntelMSR.bin' as const }
  const client =
    (info: () => Promise<unknown>): (() => HelperClient) =>
    () =>
      ({ info }) as unknown as HelperClient

  it('asks for an install, or an update', async () => {
    const missing = helperWattsBackend({
      plan,
      cpu: intel,
      installState: async () => 'missing',
      client: client(async () => ({}))
    })
    expect(await missing.status()).toMatchObject({
      state: 'not-installed',
      method: 'intel-msr',
      cpu: 'Intel'
    })
    const outdated = helperWattsBackend({
      plan,
      cpu: intel,
      installState: async () => 'outdated',
      client: client(async () => ({}))
    })
    expect((await outdated.status()).message).toMatch(/update/)
  })

  it('reports a failing helper as an error with its message', async () => {
    const b = helperWattsBackend({
      plan,
      cpu: intel,
      installState: async () => 'installed',
      client: client(async () => {
        throw new Error('Could not open the PawnIO driver (0x80070005)')
      })
    })
    expect(await b.status()).toMatchObject({ state: 'error', message: /PawnIO driver/ })
    expect(await b.status(false)).toMatchObject({ state: 'ready', method: 'intel-msr' })
  })

  it('caps maxWatts at what the settings accept (200 W) whatever the helper reports', async () => {
    const b = helperWattsBackend({
      plan,
      cpu: intel,
      installState: async () => 'installed',
      // A 125 W TDP desktop part without PMAX: TDP x 2.5.
      client: client(async () => ({
        ok: true,
        method: 'intel-msr',
        cpu: 'i9',
        minWatts: 5,
        maxWatts: 312
      }))
    })
    expect(await b.status()).toMatchObject({
      state: 'ready',
      minWatts: 5,
      maxWatts: SETTINGS_MAX_WATTS
    })
    expect(SETTINGS_MAX_WATTS).toBe(200)
  })
})

describe('capRange', () => {
  it('caps max at 200 W and keeps min at or below it', () => {
    expect(capRange({ minWatts: 5, maxWatts: 312 })).toEqual({ minWatts: 5, maxWatts: 200 })
    expect(capRange({ minWatts: 250, maxWatts: 400 })).toEqual({ minWatts: 200, maxWatts: 200 })
    expect(capRange({ minWatts: 5, maxWatts: 30 })).toEqual({ minWatts: 5, maxWatts: 30 })
    expect(capRange({ minWatts: 5 })).toEqual({ minWatts: 5 })
  })
})

function fakeNative(over: Partial<PerfNative>): PerfNative {
  return {
    read: async () => ({ asus: null, scheme: null, cpu: null, overlay: null }),
    cpu: async () => null,
    atkSet: async () => 1,
    activeScheme: async () => null,
    overlayApi: async () => ({ api: false, onBattery: false }),
    setOverlay: async () => undefined,
    ...over
  }
}

describe('ASUS backend', () => {
  it('writes PL1 then PL2, and restores by re-writing the thermal policy', async () => {
    const calls: [number, number][] = []
    const native = fakeNative({
      read: async () => ({
        asus: { vivo: 0x22030002, rog: -1, pl1: 0x10000, pl2: 0x10000 },
        scheme: null,
        cpu: null,
        overlay: null
      }),
      atkSet: async (d, v) => {
        calls.push([d, v])
        return 1
      }
    })
    const b = asusWattsBackend(native, intel)
    await b.set(18, 30)
    await b.restore()
    expect(calls).toEqual([
      [0x001200a3, 18],
      [0x001200a0, 30],
      [0x00110019, 2]
    ])
    expect((await b.status()).maxWatts).toBeLessThanOrEqual(SETTINGS_MAX_WATTS)
  })

  it('fails when the firmware does not accept a value', async () => {
    const native = fakeNative({ atkSet: async () => 0 })
    await expect(asusWattsBackend(native, null).set(18, null)).rejects.toThrow(
      /did not accept 18 W/
    )
  })
})
