import { afterAll, describe, expect, it } from 'vitest'
import { createPsWorker, type PsWorker } from '../system/ps-worker'
import { createPerfNative, parseCpu, parseNativeRead, PERF_NATIVE_INIT } from './native'

const quiet = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
}

describe('parseNativeRead', () => {
  it('reads the ATK answers, the active plan with its processor settings, and both overlays', () => {
    expect(
      parseNativeRead({
        atk: [0x22030000, -1, -1, -1],
        scheme: '381B4222-F694-41F0-9685-FF5BB260DF2E',
        max: [100, 100],
        boost: [2, 2],
        overlay: ['3af9b8d9-7c97-431d-ad78-34a8bfea439f', '00000000-0000-0000-0000-000000000000']
      })
    ).toEqual({
      asus: { vivo: 0x22030000, rog: -1, pl1: -1, pl2: -1 },
      scheme: '381b4222-f694-41f0-9685-ff5bb260df2e',
      cpu: { maxAc: 100, maxDc: 100, boostAc: 2, boostDc: 2 },
      overlay: {
        ac: '3af9b8d9-7c97-431d-ad78-34a8bfea439f',
        dc: '00000000-0000-0000-0000-000000000000'
      }
    })
  })

  it('has no ASUS probe without the ATKACPI device (-2) and no cpu values when a read failed', () => {
    expect(parseNativeRead({ atk: [-2, -2, -2, -2], max: null, boost: [2, 2] })).toEqual({
      asus: null,
      scheme: null,
      cpu: null,
      overlay: null
    })
    expect(parseNativeRead(null)).toEqual({ asus: null, scheme: null, cpu: null, overlay: null })
  })

  it('has no processor values without the plan they belong to, and keeps a missing overlay side as null', () => {
    const read = parseNativeRead({ max: [100, 100], boost: [2, 2], overlay: ['', 'junk'] })
    expect(read.cpu).toBeNull()
    expect(read.overlay).toEqual({ ac: null, dc: null })
  })
})

describe('parseCpu', () => {
  it('reads the name and the CPUID family/model', () => {
    expect(
      parseCpu({
        Name: 'Intel(R) Core(TM) Ultra X9 388H  ',
        Caption: 'Intel64 Family 6 Model 204 Stepping 2',
        Manufacturer: 'GenuineIntel'
      })
    ).toEqual({
      name: 'Intel(R) Core(TM) Ultra X9 388H',
      id: { vendor: 'intel', family: 6, model: 204 }
    })
    expect(parseCpu(null)).toBeNull()
  })
})

describe('createPerfNative', () => {
  it('validates DEVS values before running anything', async () => {
    let ran = false
    const native = createPerfNative({
      run: async () => {
        ran = true
        return 1 as never
      }
    })
    await expect(native.atkSet(0x00110019, -1)).rejects.toThrow(/Invalid/)
    await expect(native.atkSet(0x00110019, 1.5)).rejects.toThrow(/Invalid/)
    expect(ran).toBe(false)
  })

  it('reports a refused DEVS call', async () => {
    const native = createPerfNative({ run: async () => -1 as never })
    await expect(native.atkSet(0x001200a3, 15)).rejects.toThrow(/refused device 0x001200A3/)
  })
})

/** Read-only on the real PC: compiles the C# in a PowerShell worker, DSTS and PowerRead*ValueIndex only. */
describe.skipIf(process.platform !== 'win32')('on this PC (read-only)', () => {
  let worker: PsWorker | null = null
  afterAll(() => worker?.dispose())

  it('reads the processor settings, the ASUS firmware and the CPU', async () => {
    worker = createPsWorker({ log: quiet, init: PERF_NATIVE_INIT })
    const native = createPerfNative(worker)
    const read = await native.read()
    expect(read.cpu).not.toBeNull()
    expect(read.cpu!.maxAc).toBeGreaterThanOrEqual(0)
    expect(read.cpu!.maxAc).toBeLessThanOrEqual(100)
    // asus is null on a PC without \\.\ATKACPI; on an ASUS PC the four answers are numbers.
    if (read.asus) expect(Object.values(read.asus).every((v) => typeof v === 'number')).toBe(true)
    const cpu = await native.cpu()
    expect(cpu?.name).toBeTruthy()
    expect(cpu?.id?.family).toBeGreaterThan(0)
  }, 60_000)

  it('reads the active plan and both power mode overlays, and probes the overlay API (nothing is set)', async () => {
    worker ??= createPsWorker({ log: quiet, init: PERF_NATIVE_INIT })
    const native = createPerfNative(worker)
    const read = await native.read()
    expect(read.scheme).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(await native.activeScheme()).toBe(read.scheme)
    // Windows 11 keeps an overlay per source in HKLM (readable without admin).
    expect(read.overlay).not.toBeNull()
    expect(read.overlay!.ac ?? read.overlay!.dc).toMatch(/^[0-9a-f-]{36}$/)
    // GetProcAddress only: PowerSetUserConfiguredAC/DCPowerMode exist on Windows 11 22H2 and later.
    const api = await native.overlayApi()
    expect(typeof api.api).toBe('boolean')
    expect(typeof api.onBattery).toBe('boolean')
    const build = Number((await import('os')).release().split('.')[2])
    if (build >= 22621) expect(api.api).toBe(true)
  }, 60_000)
})
