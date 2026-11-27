import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ControllerWakeStatus } from '../../shared/controller-wake'
import { applyScript, parseDeviceList, parseLedger, revertScript, xboxDevices } from './scripts'
import { createControllerWakeService, type WakeProbe } from './service'

const ADAPTER = 'Xbox Wireless Adapter for Windows'

describe('controller wake scripts', () => {
  it('reads powercfg lists and keeps the Xbox devices', () => {
    expect(parseDeviceList('HID Keyboard Device\r\n\r\nNONE\r\nXbox Controller (001)\r\n')).toEqual(
      ['HID Keyboard Device', 'Xbox Controller (001)']
    )
    expect(xboxDevices(['HID mouse', ADAPTER, ADAPTER, 'XBOX Synthetic Gamepad Bus'])).toEqual([
      ADAPTER,
      'XBOX Synthetic Gamepad Bus'
    ])
  })

  it('allows only Xbox devices not allowed yet, and records them; turns off only those it recorded', () => {
    const apply = applyScript('C:\\Users\\me\\ledger.json', ["Earlier 'one'"], [ADAPTER])
    expect(apply).toContain('powercfg -devicequery wake_programmable')
    expect(apply).toContain(`foreach ($name in @('${ADAPTER}'))`)
    expect(apply).toContain("-notmatch 'xbox'")
    expect(apply).toContain('if ($armed -contains $name) { continue }')
    expect(apply).toContain('powercfg -deviceenablewake $name')
    // The prior names are quoted (a quote in a name is doubled).
    expect(apply).toContain("[void]$devices.Add('Earlier ''one''')")
    const revert = revertScript([ADAPTER])
    expect(revert).toContain(`powercfg -devicedisablewake '${ADAPTER}'`)
    expect(revert).not.toContain('deviceenablewake')
  })

  it('reads a ledger, dropping anything odd', () => {
    expect(parseLedger(`{"devices":["${ADAPTER}","",5,"${ADAPTER}"]}`)).toEqual([ADAPTER])
    expect(parseLedger(`{"devices":"${ADAPTER}"}`)).toEqual([ADAPTER])
    expect(parseLedger('not json')).toBeNull()
  })
})

describe('controller wake service', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-wake-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  interface Harness {
    state: { on: boolean; probe: WakeProbe; code: number | null; refuse: string[] }
    scripts: string[]
    emitted: ControllerWakeStatus[]
    service: ReturnType<typeof createControllerWakeService>
    settle: () => Promise<void>
  }

  /** A fake elevated step: allows (or turns off) what its script names, as Windows would, unless refused. */
  function setup(probe: WakeProbe, code: number | null = 0): Harness {
    const state = { on: false, probe, code, refuse: [] as string[] }
    const scripts: string[] = []
    const emitted: ControllerWakeStatus[] = []
    const service = createControllerWakeService({
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      userData: dir,
      enabled: () => state.on,
      probe: async () => ({ ...state.probe }),
      runElevatedScript: vi.fn(async (script: string) => {
        scripts.push(script)
        if (state.code !== 0) return state.code
        const names = xboxDevices(state.probe.programmable).filter((n) => script.includes(`'${n}'`))
        if (script.includes('deviceenablewake')) {
          const allowed = names.filter((n) => !state.refuse.includes(n))
          state.probe.armed = [...new Set([...state.probe.armed, ...allowed])]
          mkdirSync(join(dir, 'controller-wake'), { recursive: true })
          writeFileSync(
            join(dir, 'controller-wake', 'ledger.json'),
            JSON.stringify({ devices: allowed })
          )
        } else {
          state.probe.armed = state.probe.armed.filter((n) => !names.includes(n))
        }
        return 0
      }),
      events: { emit: (_e, st) => void emitted.push(st) }
    })
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    }
    return { state, scripts, emitted, service, settle }
  }

  const probe = (patch: Partial<WakeProbe> = {}): WakeProbe => ({
    capable: [ADAPTER],
    armed: [],
    programmable: [ADAPTER],
    adapter: true,
    ...patch
  })

  it('is off by default: nothing is asked at start', async () => {
    const h = setup(probe())
    h.service.start()
    await h.settle()
    expect(h.scripts).toEqual([])
  })

  it('turned on: allows the Xbox devices once; turned off: turns off only what it allowed', async () => {
    const h = setup(
      probe({
        capable: [ADAPTER, 'HID Keyboard Device'],
        armed: ['HID Keyboard Device'],
        programmable: [ADAPTER, 'HID Keyboard Device']
      })
    )
    h.service.start()
    await h.settle()
    h.state.on = true
    h.service.sync()
    await h.settle()
    expect(h.scripts).toHaveLength(1)
    expect(h.scripts[0]).toContain('deviceenablewake')
    expect(h.emitted.at(-1)).toMatchObject({ step: 'idle', armed: [ADAPTER] })
    // Allowed now: a start asks nothing.
    h.service.start()
    await h.settle()
    expect(h.scripts).toHaveLength(1)
    h.state.on = false
    h.service.sync()
    await h.settle()
    expect(h.scripts).toHaveLength(2)
    expect(h.scripts[1]).toContain(`devicedisablewake '${ADAPTER}'`)
    expect(h.scripts[1]).not.toContain('HID Keyboard Device')
    expect(h.state.probe.armed).toEqual(['HID Keyboard Device'])
  })

  it('a device Windows does not allow is not asked for again at every start, only when turned on again', async () => {
    const h = setup(probe())
    h.state.refuse = [ADAPTER]
    h.state.on = true
    h.service.start()
    await h.settle()
    expect(h.scripts).toHaveLength(1)
    expect(h.emitted.at(-1)?.step).toBe('failed')
    h.service.start()
    await h.settle()
    expect(h.scripts).toHaveLength(1)
    h.state.on = false
    h.service.sync()
    await h.settle()
    h.state.on = true
    h.service.sync()
    await h.settle()
    expect(h.scripts).toHaveLength(2)
  })

  it('asks nothing when no Xbox device can wake the PC', async () => {
    const h = setup(
      probe({
        capable: ['HID Keyboard Device'],
        programmable: ['HID Keyboard Device'],
        adapter: false
      })
    )
    h.service.start()
    h.state.on = true
    h.service.sync()
    await h.settle()
    expect(h.scripts).toEqual([])
    expect(h.emitted.at(-1)).toMatchObject({ enabled: true, capable: [], adapter: false })
  })

  it('a declined prompt is kept across starts, and not asked again until turned on again', async () => {
    const h = setup(probe(), 1223)
    h.service.start()
    h.state.on = true
    h.service.sync()
    await h.settle()
    expect(h.emitted.at(-1)?.step).toBe('declined')
    const again = setup(probe(), 1223)
    again.state.on = true
    again.service.start()
    await again.settle()
    expect(again.scripts).toEqual([])
    expect((await again.service.status()).step).toBe('declined')
  })

  it('turned off while a device is unplugged: asks nothing and keeps it, to turn it off once it is back', async () => {
    const h = setup(probe())
    h.state.on = true
    h.service.start()
    await h.settle()
    h.state.probe = probe({ capable: [], armed: [], programmable: [] })
    h.state.on = false
    h.service.sync()
    await h.settle()
    expect(h.scripts).toHaveLength(1)
    expect(parseLedger(readFileSync(join(dir, 'controller-wake', 'ledger.json'), 'utf8'))).toEqual([
      ADAPTER
    ])
    h.state.probe = probe({ armed: [ADAPTER] })
    h.service.start()
    await h.settle()
    expect(h.scripts.at(-1)).toContain(`devicedisablewake '${ADAPTER}'`)
  })
})
