import { describe, expect, it } from 'vitest'
import {
  AUTO_HDR_KEY,
  AUTO_HDR_VALUE,
  createAutoHdr,
  parseAutoHdr,
  parseRegQuery,
  withAutoHdr
} from './auto-hdr'
import type { CommandRunner } from '../system/power'

const LIVE = 'AutoHDREnable=1;SwapEffectUpgradeEnable=1;VRROptimizeEnable=0;'

describe('Auto HDR value', () => {
  it('reads the AutoHDREnable token', () => {
    expect(parseAutoHdr(LIVE)).toBe(true)
    expect(parseAutoHdr('SwapEffectUpgradeEnable=1;AutoHDREnable=0;')).toBe(false)
    expect(parseAutoHdr('AutoHDREnable=2097;')).toBe(true)
    expect(parseAutoHdr('SwapEffectUpgradeEnable=1;')).toBeNull()
    expect(parseAutoHdr('')).toBeNull()
    expect(parseAutoHdr(null)).toBeNull()
    expect(parseAutoHdr('AutoHDREnable=;')).toBeNull()
  })

  it('replaces only that token and keeps the others in order', () => {
    expect(withAutoHdr(LIVE, false)).toBe(
      'AutoHDREnable=0;SwapEffectUpgradeEnable=1;VRROptimizeEnable=0;'
    )
    expect(
      withAutoHdr('SwapEffectUpgradeEnable=1;AutoHDREnable=0;VRROptimizeEnable=0;', true)
    ).toBe('SwapEffectUpgradeEnable=1;AutoHDREnable=1;VRROptimizeEnable=0;')
    expect(withAutoHdr('SwapEffectUpgradeEnable=1;', true)).toBe(
      'SwapEffectUpgradeEnable=1;AutoHDREnable=1;'
    )
    expect(withAutoHdr(null, true)).toBe('AutoHDREnable=1;')
    expect(withAutoHdr('SwapEffectUpgradeEnable=1', false)).toBe(
      'SwapEffectUpgradeEnable=1;AutoHDREnable=0;'
    )
    // A repeated token is collapsed into the first.
    expect(withAutoHdr('AutoHDREnable=1;X=2;AutoHDREnable=1;', false)).toBe('AutoHDREnable=0;X=2;')
  })

  it("parses reg.exe's answer", () => {
    const out = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\DirectX\\UserGpuPreferences\r\n    ${AUTO_HDR_VALUE}    REG_SZ    ${LIVE}\r\n\r\n`
    expect(parseRegQuery({ code: 0, stdout: out, stderr: '' })).toBe(LIVE)
    expect(
      parseRegQuery({
        code: 1,
        stdout: '',
        stderr: 'ERROR: The system was unable to find the specified registry key or value.'
      })
    ).toBeNull()
    // reg.exe exits 1 for every failure: only its "unable to find" answer means absent.
    expect(() =>
      parseRegQuery({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' })
    ).toThrow(/Access is denied/)
    expect(() => parseRegQuery({ code: 1, stdout: '', stderr: '' })).toThrow(/exit 1/)
    expect(() => parseRegQuery({ code: -1, stdout: '', stderr: '' })).toThrow(/exit -1/)
  })
})

describe('createAutoHdr', () => {
  function fake(data: string | null): {
    run: CommandRunner
    calls: string[][]
    data(): string | null
  } {
    let value = data
    const calls: string[][] = []
    const run: CommandRunner = async (file, args) => {
      calls.push([file, ...args])
      if (args[0] === 'query') {
        if (value === null)
          return {
            code: 1,
            stdout: '',
            stderr: 'ERROR: The system was unable to find the specified registry key or value.'
          }
        return {
          code: 0,
          stdout: `\r\n${AUTO_HDR_KEY}\r\n    ${AUTO_HDR_VALUE}    REG_SZ    ${value}\r\n`,
          stderr: ''
        }
      }
      if (args[0] === 'add') {
        value = args[args.indexOf('/d') + 1]!
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    }
    return { run, calls, data: () => value }
  }

  it('reads first, then writes only the global value with the token changed', async () => {
    const f = fake(LIVE)
    const hdr = createAutoHdr({ run: f.run })
    expect(await hdr.read()).toBe(true)
    await hdr.write(false)
    expect(f.data()).toBe('AutoHDREnable=0;SwapEffectUpgradeEnable=1;VRROptimizeEnable=0;')
    const add = f.calls.find((c) => c[1] === 'add')!
    expect(add).toEqual([
      'reg.exe',
      'add',
      AUTO_HDR_KEY,
      '/v',
      AUTO_HDR_VALUE,
      '/t',
      'REG_SZ',
      '/d',
      'AutoHDREnable=0;SwapEffectUpgradeEnable=1;VRROptimizeEnable=0;',
      '/f'
    ])
    // Every reg.exe call names the global value only.
    for (const c of f.calls) expect(c).toContain(AUTO_HDR_VALUE)
    expect(await hdr.read()).toBe(false)
  })

  it('writes nothing when the value already says so', async () => {
    const f = fake(LIVE)
    await createAutoHdr({ run: f.run }).write(true)
    expect(f.calls.filter((c) => c[1] === 'add')).toEqual([])
  })

  it('creates the value when absent and refuses to write over a failed read', async () => {
    const f = fake(null)
    await createAutoHdr({ run: f.run }).write(true)
    expect(f.data()).toBe('AutoHDREnable=1;')
    const denied: CommandRunner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'ERROR: Access is denied.'
    })
    await expect(createAutoHdr({ run: denied }).write(true)).rejects.toThrow(/Access is denied/)
  })

  it('never writes over the other tokens when reg query times out or cannot start', async () => {
    for (const failed of [
      { code: -1, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: '' }
    ]) {
      const calls: string[][] = []
      const run: CommandRunner = async (_f, args) => {
        calls.push(args)
        if (args[0] === 'query' && args.includes('/v')) return failed
        // The key listing fails too (a timeout, or no reg.exe).
        return { code: -1, stdout: '', stderr: '' }
      }
      await expect(createAutoHdr({ run }).write(true)).rejects.toThrow(/reg query failed/)
      await expect(createAutoHdr({ run }).read()).rejects.toThrow(/reg query failed/)
      expect(calls.some((c) => c[0] === 'add')).toBe(false)
    }
  })

  it('tells "not found" in another language from a failure by listing the key', async () => {
    const calls: string[][] = []
    let listing = `
${AUTO_HDR_KEY}
    OtherApp.exe    REG_SZ    AppStatus=1;
`
    const run: CommandRunner = async (_f, args) => {
      calls.push(args)
      if (args[0] === 'query' && args.includes('/v'))
        return { code: 1, stdout: '', stderr: 'FEHLER: Wert nicht gefunden.' }
      if (args[0] === 'query') return { code: 0, stdout: listing, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const hdr = createAutoHdr({ run })
    expect(await hdr.read()).toBeNull()
    await hdr.write(true)
    expect(calls.at(-1)).toContain('AutoHDREnable=1;')
    // The listing shows the value after all: its data is used, nothing else is lost.
    listing = `
${AUTO_HDR_KEY}
    ${AUTO_HDR_VALUE}    REG_SZ    ${LIVE}
`
    await hdr.write(false)
    expect(calls.at(-1)).toContain('AutoHDREnable=0;SwapEffectUpgradeEnable=1;VRROptimizeEnable=0;')
  })

  it('reports a write Windows refused', async () => {
    const run: CommandRunner = async (_f, args) =>
      args[0] === 'query'
        ? {
            code: 1,
            stdout: '',
            stderr: 'ERROR: The system was unable to find the specified registry key or value.'
          }
        : { code: 1, stdout: '', stderr: 'ERROR: denied' }
    await expect(createAutoHdr({ run }).write(true)).rejects.toThrow(/did not accept/)
  })
})
