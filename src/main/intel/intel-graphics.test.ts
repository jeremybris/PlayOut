import { describe, expect, it, vi } from 'vitest'
import type { PsRunner } from '../system/ps-worker'
import {
  createIntelGraphics,
  enduranceKey,
  enduranceOptions,
  enduranceStatus,
  parseEnduranceKey,
  parseIgclReport,
  resultText
} from './intel-graphics'
import { INTEL_INIT } from './intel-cs'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// The answer of PlayOut.Igcl.Status() on the Arc B390 this was probed on.
const ARC = {
  ok: true,
  device: 'Intel(R) Arc(TM) B390 GPU',
  eg: {
    listed: true,
    capsCode: 0,
    controlMask: 5,
    controlDefault: 0,
    modeMask: 7,
    modeDefault: 1,
    getCode: 0,
    control: 0,
    mode: 1
  }
}

function fakeRunner(answer: (script: string) => unknown): PsRunner & { scripts: string[] } {
  const scripts: string[] = []
  return {
    scripts,
    async run<T>(script: string) {
      scripts.push(script)
      const value = answer(script)
      if (value instanceof Error) throw value
      return value as T
    }
  }
}

describe('parseIgclReport', () => {
  it('parses the JSON string the worker returns', () => {
    const report = parseIgclReport(JSON.stringify(ARC))
    expect(report?.ok).toBe(true)
    expect(report?.device).toBe('Intel(R) Arc(TM) B390 GPU')
    expect(report?.eg).toMatchObject({
      listed: true,
      controlMask: 5,
      modeMask: 7,
      control: 0,
      mode: 1
    })
  })

  it('rejects garbage', () => {
    expect(parseIgclReport('not json')).toBeNull()
    expect(parseIgclReport(null)).toBeNull()
    expect(parseIgclReport({ device: 'x' })).toBeNull()
    expect(parseIgclReport(42)).toBeNull()
  })

  it('drops non-numeric fields', () => {
    const report = parseIgclReport({ ok: true, eg: { listed: true, control: 'x', mode: 2 } })
    expect(report?.eg).toEqual({ listed: true, mode: 2 })
  })
})

describe('Endurance Gaming value mapping', () => {
  it('lists Off then each listed control with each listed mode', () => {
    expect(enduranceOptions(5, 7)).toEqual([
      { key: 'off', label: 'Off' },
      { key: 'auto:performance', label: 'Auto, better performance' },
      { key: 'auto:balanced', label: 'Auto, balanced' },
      { key: 'auto:battery', label: 'Auto, maximum battery' }
    ])
    expect(enduranceOptions(7, 2).map((o) => o.key)).toEqual([
      'off',
      'on:balanced',
      'auto:balanced'
    ])
    expect(enduranceOptions(0, 7)).toEqual([])
  })

  it('maps control/mode pairs to keys and back', () => {
    expect(enduranceKey(0, 1)).toBe('off')
    expect(enduranceKey(2, 0)).toBe('auto:performance')
    expect(enduranceKey(1, 2)).toBe('on:battery')
    expect(enduranceKey(3, 0)).toBeNull()
    expect(enduranceKey(2, 9)).toBeNull()
    expect(parseEnduranceKey('off')).toEqual({ control: 0, mode: -1 })
    expect(parseEnduranceKey('auto:battery')).toEqual({ control: 2, mode: 2 })
    expect(parseEnduranceKey('on:performance')).toEqual({ control: 1, mode: 0 })
    expect(parseEnduranceKey('off:balanced')).toBeNull()
    expect(parseEnduranceKey('auto')).toBeNull()
    expect(parseEnduranceKey('auto:balanced:x')).toBeNull()
    expect(parseEnduranceKey('toString:balanced')).toBeNull()
  })

  it('names result codes', () => {
    expect(resultText(0x4000000a)).toBe('unsupported feature (0x4000000A)')
    expect(resultText(0x40000099)).toBe('0x40000099')
  })
})

describe('enduranceStatus', () => {
  it('reads the probed driver as supported and Off', () => {
    const status = enduranceStatus(parseIgclReport(ARC))
    expect(status.supported).toBe(true)
    expect(status.value).toBe('off')
    expect(status.options).toHaveLength(4)
    expect(status.reason).toBeUndefined()
  })

  it('shows the current Auto mode', () => {
    const status = enduranceStatus(
      parseIgclReport({ ...ARC, eg: { ...ARC.eg, control: 2, mode: 2 } })
    )
    expect(status.value).toBe('auto:battery')
  })

  it('gives null for a value the driver does not list', () => {
    const status = enduranceStatus(
      parseIgclReport({ ...ARC, eg: { ...ARC.eg, control: 1, mode: 1 } })
    )
    expect(status.supported).toBe(true)
    expect(status.value).toBeNull()
  })

  it('marks a PC without an Intel driver or adapter as absent (the tile hides), not a failing driver', () => {
    expect(enduranceStatus(parseIgclReport({ ok: false, stage: 'dll', code: 0 })).absent).toBe(true)
    expect(enduranceStatus(parseIgclReport({ ok: false, stage: 'device', code: 0 })).absent).toBe(
      true
    )
    expect(
      enduranceStatus(parseIgclReport({ ok: false, stage: 'init', code: 0x40000009 })).absent
    ).toBeUndefined()
  })

  it('explains each failing step', () => {
    expect(enduranceStatus(parseIgclReport({ ok: false, stage: 'dll', code: 0 })).reason).toBe(
      'No Intel graphics driver'
    )
    expect(enduranceStatus(parseIgclReport({ ok: false, stage: 'device', code: 0 })).reason).toBe(
      'No Intel graphics adapter'
    )
    expect(
      enduranceStatus(parseIgclReport({ ok: false, stage: 'init', code: 0x40000009 })).reason
    ).toContain('unsupported version')
    expect(
      enduranceStatus(parseIgclReport({ ok: true, eg: { listed: false, capsCode: 0 } })).reason
    ).toBe('This driver has no Endurance Gaming')
    expect(
      enduranceStatus(parseIgclReport({ ok: true, eg: { listed: true, layout: false } })).reason
    ).toContain('unknown format')
    expect(
      enduranceStatus(
        parseIgclReport({ ...ARC, eg: { ...ARC.eg, getCode: 0x40000017, control: undefined } })
      ).supported
    ).toBe(false)
    expect(
      enduranceStatus(parseIgclReport({ ...ARC, eg: { ...ARC.eg, controlMask: 1 } })).reason
    ).toBe('The driver lists no Endurance Gaming choices')
    expect(enduranceStatus(null).supported).toBe(false)
  })
})

describe('createIntelGraphics', () => {
  it('reads the status through the runner and never offers frame generation', async () => {
    const runner = fakeRunner(() => JSON.stringify(ARC))
    const intel = createIntelGraphics({ log, runner })
    const status = await intel.status()
    expect(status.enduranceGaming?.value).toBe('off')
    expect(status.frameGenOverride).toBeUndefined()
    expect(runner.scripts).toEqual(['[PlayOut.Igcl]::Status()'])
    await expect(intel.set('frameGenOverride', 'x')).rejects.toThrow(/not available/)
  })

  it('sets a listed choice and returns the value read back', async () => {
    let state = { control: 0, mode: 1 }
    const runner = fakeRunner((script) => {
      const m = /SetEndurance\((-?\d+), (-?\d+)\)/.exec(script)
      if (m) {
        state = { control: Number(m[1]), mode: Number(m[2]) < 0 ? state.mode : Number(m[2]) }
        return JSON.stringify({ ...ARC, eg: { ...ARC.eg, setCode: 0, ...state } })
      }
      return JSON.stringify({ ...ARC, eg: { ...ARC.eg, ...state } })
    })
    const intel = createIntelGraphics({ log, runner })
    const on = await intel.set('enduranceGaming', 'auto:battery')
    expect(on.enduranceGaming?.value).toBe('auto:battery')
    expect(runner.scripts).toContain('[PlayOut.Igcl]::SetEndurance(2, 2)')
    const off = await intel.set('enduranceGaming', 'off')
    expect(off.enduranceGaming?.value).toBe('off')
    expect(runner.scripts).toContain('[PlayOut.Igcl]::SetEndurance(0, -1)')
    expect(state).toEqual({ control: 0, mode: 2 })
  })

  it('does not write when the choice is already in effect', async () => {
    const runner = fakeRunner(() => JSON.stringify(ARC))
    const intel = createIntelGraphics({ log, runner })
    await intel.set('enduranceGaming', 'off')
    expect(runner.scripts.some((s) => s.includes('SetEndurance'))).toBe(false)
  })

  it('refuses choices the driver does not list and unknown keys', async () => {
    const runner = fakeRunner(() => JSON.stringify(ARC))
    const intel = createIntelGraphics({ log, runner })
    await expect(intel.set('enduranceGaming', 'on:balanced')).rejects.toThrow(/does not offer/)
    await expect(intel.set('enduranceGaming', 'max')).rejects.toThrow(/Unknown/)
    expect(runner.scripts.some((s) => s.includes('SetEndurance'))).toBe(false)
  })

  it('reports a refused change', async () => {
    const runner = fakeRunner((script) =>
      script.includes('SetEndurance')
        ? JSON.stringify({ ...ARC, eg: { ...ARC.eg, setCode: 0x40000006 } })
        : JSON.stringify(ARC)
    )
    const intel = createIntelGraphics({ log, runner })
    const status = await intel.set('enduranceGaming', 'auto:balanced')
    expect(status.enduranceGaming?.value).toBe('off')
    expect(status.enduranceGaming?.reason).toContain('insufficient permissions')
  })

  it('remembers a missing driver and stops asking', async () => {
    const runner = fakeRunner(() => JSON.stringify({ ok: false, stage: 'dll', code: 0 }))
    const intel = createIntelGraphics({ log, runner })
    expect((await intel.status()).enduranceGaming?.reason).toBe('No Intel graphics driver')
    await intel.status()
    expect(runner.scripts).toHaveLength(1)
    await expect(intel.set('enduranceGaming', 'off')).rejects.toThrow('No Intel graphics driver')
  })

  it('turns a worker failure into an unsupported status', async () => {
    const runner = fakeRunner(() => new Error('PowerShell script timed out'))
    const intel = createIntelGraphics({ log, runner })
    const status = await intel.status()
    expect(status.enduranceGaming?.supported).toBe(false)
    expect(status.enduranceGaming?.reason).toContain('timed out')
  })

  it('rejects calls after dispose', async () => {
    const intel = createIntelGraphics({ log, runner: fakeRunner(() => JSON.stringify(ARC)) })
    intel.dispose()
    await expect(intel.status()).rejects.toThrow(/disposed/)
  })
})

describe('INTEL_INIT', () => {
  it('compiles one guarded class with only global, header-documented IGCL calls', () => {
    expect(INTEL_INIT).toContain("if (-not ('PlayOut.Igcl' -as [type]))")
    for (const fn of [
      'ctlInit',
      'ctlClose',
      'ctlEnumerateDevices',
      'ctlGetDeviceProperties',
      'ctlGetSupported3DCapabilities',
      'ctlGetSet3DFeature'
    ])
      expect(INTEL_INIT).toContain(`static extern uint ${fn}(`)
    // ApplicationName stays null: never a per-application value.
    expect(INTEL_INIT).toContain('Marshal.WriteIntPtr(gs, 16, IntPtr.Zero)')
    expect(INTEL_INIT).not.toMatch(/\$\{/)
  })
})
