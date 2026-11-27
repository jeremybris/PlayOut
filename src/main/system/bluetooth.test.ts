import { afterAll, describe, expect, it, vi } from 'vitest'
import { NO_BLUETOOTH, parseBluetooth, RADIO_INIT, readBluetooth } from './bluetooth'
import { createPsWorker, type PsWorker } from './ps-worker'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

describe('bluetooth parsing', () => {
  it('reads the radio state from WinRT radios', () => {
    expect(
      parseBluetooth({
        source: 'radios',
        radios: [
          { Name: 'Wi-Fi', Kind: 1, State: 1 },
          { Name: 'Bluetooth', Kind: 3, State: 1 }
        ]
      })
    ).toEqual({ available: true, on: true })
    expect(
      parseBluetooth({ source: 'radios', radios: { Name: 'Bluetooth', Kind: 3, State: 2 } })
    ).toEqual({ available: true, on: false })
    expect(
      parseBluetooth({ source: 'radios', radios: [{ Name: 'Wi-Fi', Kind: 1, State: 1 }] })
    ).toEqual(NO_BLUETOOTH)
    expect(parseBluetooth({ source: 'radios', radios: [] })).toEqual(NO_BLUETOOTH)
  })

  it('falls back to Plug and Play presence', () => {
    expect(
      parseBluetooth({
        source: 'pnp',
        devices: [{ FriendlyName: 'Intel(R) Wireless Bluetooth(R)', Status: 'OK' }]
      })
    ).toEqual({
      available: true,
      on: true
    })
    expect(
      parseBluetooth({
        source: 'pnp',
        devices: { FriendlyName: 'Intel(R) Wireless Bluetooth(R)', Status: 'Error' }
      })
    ).toEqual({
      available: true,
      on: false
    })
    expect(parseBluetooth({ source: 'pnp', devices: [] })).toEqual(NO_BLUETOOTH)
    expect(parseBluetooth(null)).toEqual(NO_BLUETOOTH)
  })
})

describe.skipIf(!onWindows)('bluetooth probe on this machine', () => {
  let worker: PsWorker | null = null
  afterAll(() => worker?.dispose())

  it('returns a well-formed status quickly once the WinRT helper is initialised', async () => {
    worker = createPsWorker({ log, init: RADIO_INIT })
    const first = await readBluetooth(worker)
    expect(typeof first.available).toBe('boolean')
    expect(typeof first.on).toBe('boolean')
    if (!first.available) expect(first.on).toBe(false)
    const t0 = performance.now()
    const second = await readBluetooth(worker)
    const ms = Math.round(performance.now() - t0)
    expect(second).toEqual(first)
    const source = await worker.run<string>(
      "if ($null -ne $global:PlayOutRadioAsTask) { 'radios' } else { 'pnp' }"
    )
    console.info(`[bluetooth] ${JSON.stringify(second)} via ${source} in ${ms} ms (warm)`)
  }, 40_000)
})
