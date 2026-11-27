import { EventEmitter } from 'events'
import type { ChildProcess, SpawnOptions } from 'child_process'
import { PassThrough } from 'stream'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  NO_BATTERY,
  overlayArgs,
  overlayToMode,
  parseBattery,
  parsePowerMode,
  powerAction,
  readBattery,
  readPowerMode,
  setPowerMode,
  SHUTDOWN_ARGS,
  startSleep,
  type CommandResult
} from './power'
import { createPsWorker, type PsWorker } from './ps-worker'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

describe('battery parsing', () => {
  it('uses PowerOnline from root/wmi when present', () => {
    expect(
      parseBattery({
        battery: { BatteryStatus: 2, EstimatedChargeRemaining: 79 },
        status: { PowerOnline: true, Charging: false }
      })
    ).toEqual({ present: true, percent: 79, charging: true })
    expect(
      parseBattery({
        battery: [{ BatteryStatus: 1, EstimatedChargeRemaining: 40 }],
        status: [{ PowerOnline: false, Charging: false }]
      })
    ).toEqual({ present: true, percent: 40, charging: false })
  })

  it('falls back to Win32_Battery.BatteryStatus and averages several packs', () => {
    expect(
      parseBattery({ battery: { BatteryStatus: 1, EstimatedChargeRemaining: 55 }, status: [] })
    ).toEqual({
      present: true,
      percent: 55,
      charging: false
    })
    expect(
      parseBattery({
        battery: [
          { BatteryStatus: 6, EstimatedChargeRemaining: 50 },
          { BatteryStatus: 6, EstimatedChargeRemaining: 70 }
        ],
        status: null
      })
    ).toEqual({ present: true, percent: 60, charging: true })
  })

  it('reports no battery on desktops and null when the probe produced nothing', () => {
    expect(parseBattery({ battery: [], status: [] })).toEqual(NO_BATTERY)
    expect(parseBattery(null)).toBeNull()
  })
})

describe('power mode', () => {
  it('maps overlay GUIDs to modes', () => {
    expect(overlayToMode('961cc777-2547-4f9d-8174-7d86181b8a7a')).toBe('efficiency')
    expect(overlayToMode('00000000-0000-0000-0000-000000000000')).toBe('balanced')
    expect(overlayToMode('DED574B5-45A0-4F42-8737-46345C09C238')).toBe('performance')
    expect(overlayToMode('3af9b8d9-7c97-431d-ad78-34a8bfea439f')).toBe('performance')
    expect(overlayToMode('381b4222-f694-41f0-9685-ff5bb260df2e')).toBeNull()
    expect(overlayToMode('')).toBeNull()
  })

  it('follows the AC overlay on mains and the DC overlay on battery', () => {
    const ac = '00000000-0000-0000-0000-000000000000'
    const dc = '961cc777-2547-4f9d-8174-7d86181b8a7a'
    expect(parsePowerMode({ ac, dc, onBattery: false })).toBe('balanced')
    expect(parsePowerMode({ ac, dc, onBattery: true })).toBe('efficiency')
    expect(parsePowerMode({ ac: '', dc: '', onBattery: false })).toBeNull()
    expect(parsePowerMode(undefined)).toBeNull()
  })

  it('builds the powercfg command and surfaces failures', async () => {
    expect(overlayArgs('efficiency')).toEqual([
      '/overlaysetactive',
      '961cc777-2547-4f9d-8174-7d86181b8a7a'
    ])
    expect(overlayArgs('balanced')).toEqual([
      '/overlaysetactive',
      '00000000-0000-0000-0000-000000000000'
    ])
    expect(overlayArgs('performance')).toEqual([
      '/overlaysetactive',
      'ded574b5-45a0-4f42-8737-46345c09c238'
    ])

    const calls: string[][] = []
    const ok = async (file: string, args: string[]): Promise<CommandResult> => {
      calls.push([file, ...args])
      return { code: 0, stdout: '', stderr: '' }
    }
    await setPowerMode('performance', ok)
    expect(calls).toEqual([
      ['powercfg.exe', '/overlaysetactive', 'ded574b5-45a0-4f42-8737-46345c09c238']
    ])

    const denied = async (): Promise<CommandResult> => ({
      code: 1,
      stdout: 'Invalid Parameters\r\n',
      stderr: ''
    })
    await expect(setPowerMode('balanced', denied)).rejects.toThrow(
      /powercfg exit 1.*Invalid Parameters/
    )
  })
})

describe('power actions', () => {
  it('runs shutdown.exe with the documented switches and sleeps through SetSuspendState', async () => {
    const calls: string[][] = []
    let sleeps = 0
    const io = {
      run: async (file: string, args: string[]): Promise<CommandResult> => {
        calls.push([file, ...args])
        return { code: 0, stdout: '', stderr: '' }
      },
      sleep: async () => {
        sleeps++
        return { code: 0, stdout: '', stderr: '' }
      }
    }
    await powerAction('shutdown', log, io)
    await powerAction('restart', log, io)
    await powerAction('hibernate', log, io)
    await powerAction('sleep', log, io)
    expect(calls).toEqual([
      ['shutdown.exe', '/s', '/t', '0'],
      ['shutdown.exe', '/r', '/t', '0'],
      ['shutdown.exe', '/h']
    ])
    expect(sleeps).toBe(1)
    expect(SHUTDOWN_ARGS.hibernate).toEqual(['/h'])
  })

  it('reports a failed command with its first output line', async () => {
    const io = {
      run: async (): Promise<CommandResult> => ({
        code: 1,
        stdout: '',
        stderr: 'Hibernation is not enabled.\r\nmore'
      }),
      sleep: async () => ({ code: 1, stdout: '', stderr: 'SetSuspendState returned false' })
    }
    await expect(powerAction('hibernate', log, io)).rejects.toThrow(
      /Could not hibernate.*Hibernation is not enabled/
    )
    await expect(powerAction('sleep', log, io)).rejects.toThrow(
      /Could not put the computer to sleep: SetSuspendState/
    )
  })
})

describe('startSleep', () => {
  interface Fake {
    child: ChildProcess
    stderr: PassThrough
    unref: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    spawned: { file: string; args: string[]; options: SpawnOptions }[]
  }

  function fakeSpawn(): Fake & {
    spawn: (f: string, a: string[], o: SpawnOptions) => ChildProcess
  } {
    const child = new EventEmitter() as ChildProcess
    const stderr = new PassThrough()
    const unref = vi.fn()
    const kill = vi.fn()
    Object.assign(child, { pid: 4321, stderr, unref, kill, exitCode: null })
    const spawned: Fake['spawned'] = []
    return {
      child,
      stderr,
      unref,
      kill,
      spawned,
      spawn(file, args, options) {
        spawned.push({ file, args, options })
        return child
      }
    }
  }

  it('reports an immediate non-zero exit with its stderr so powerAction still fails', async () => {
    const f = fakeSpawn()
    const pending = startSleep({ spawn: f.spawn, graceMs: 5_000 })
    f.stderr.write('SetSuspendState returned false\r\nAt line:3')
    f.child.emit('exit', 1, null)
    const result = await pending
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^SetSuspendState returned false/)
    expect(f.spawned).toHaveLength(1)
    expect(f.spawned[0].file).toBe('powershell.exe')
    expect(f.spawned[0].args).toContain('-EncodedCommand')
    expect(f.spawned[0].options).toMatchObject({ windowsHide: true, detached: true })
    expect(f.unref).toHaveBeenCalledTimes(1)
    await expect(
      powerAction('sleep', log, { run: vi.fn(), sleep: () => Promise.resolve(result) })
    ).rejects.toThrow(/Could not put the computer to sleep: SetSuspendState returned false/)
  })

  it('resolves as success when the helper is still blocked in SetSuspendState after the grace window', async () => {
    const f = fakeSpawn()
    const t0 = Date.now()
    const result = await startSleep({ spawn: f.spawn, graceMs: 40 })
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30)
    expect(f.kill).not.toHaveBeenCalled()
    // A late exit after resume (even a non-zero one from a killed shell) changes nothing.
    f.child.emit('exit', null, 'SIGTERM')
    await expect(
      powerAction('sleep', log, { run: vi.fn(), sleep: () => Promise.resolve(result) })
    ).resolves.toBeUndefined()
  })

  it('resolves at once on the suspend signal and unsubscribes from it when settled', async () => {
    const f = fakeSpawn()
    let suspend: (() => void) | null = null
    const unsubscribe = vi.fn()
    const result = startSleep({
      spawn: f.spawn,
      graceMs: 5_000,
      onSuspend(callback) {
        suspend = callback
        return unsubscribe
      }
    })
    expect(suspend).not.toBeNull()
    suspend!()
    expect(await result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    const g = fakeSpawn()
    const off = vi.fn()
    const early = startSleep({ spawn: g.spawn, graceMs: 5_000, onSuspend: () => off })
    g.child.emit('exit', 1, null)
    expect((await early).code).toBe(1)
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('turns a spawn failure into a failed result instead of throwing', async () => {
    const result = await startSleep({
      spawn: () => {
        throw new Error('spawn ENOENT')
      }
    })
    expect(result).toMatchObject({ code: 1, stderr: 'spawn ENOENT' })
  })
})

describe.skipIf(!onWindows)('battery and power mode on this machine', () => {
  let worker: PsWorker | null = null
  afterAll(() => worker?.dispose())

  it('reads a well-formed battery status and power mode', async () => {
    worker = createPsWorker({ log })
    const t0 = performance.now()
    const battery = await readBattery(worker)
    const batteryMs = Math.round(performance.now() - t0)
    expect(battery).not.toBeNull()
    expect(typeof battery!.present).toBe('boolean')
    expect(battery!.percent).toBeGreaterThanOrEqual(0)
    expect(battery!.percent).toBeLessThanOrEqual(100)
    expect(typeof battery!.charging).toBe('boolean')

    const t1 = performance.now()
    const mode = await readPowerMode(worker)
    const modeMs = Math.round(performance.now() - t1)
    expect([null, 'efficiency', 'balanced', 'performance']).toContain(mode)
    console.info(
      `[power] battery ${JSON.stringify(battery)} in ${batteryMs} ms; mode ${mode} in ${modeMs} ms`
    )
  }, 30_000)
})
