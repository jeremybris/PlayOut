import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SystemStatus } from '../../shared/types'
import type { PsRunner } from './ps-worker'
import { createSystemService } from './status'
import type { SystemService } from './types'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

/** A PowerShell stand-in that answers each probe script by a keyword it contains. */
function fakeRunner(
  overrides: { fail?: RegExp; delayMs?: number; onRun?: (script: string) => void } = {}
): PsRunner {
  return {
    async run<T>(script: string): Promise<T | null> {
      overrides.onRun?.(script)
      if (overrides.delayMs) await new Promise((r) => setTimeout(r, overrides.delayMs))
      if (overrides.fail?.test(script))
        throw new Error(`fake failure for ${script.slice(0, 30).trim()}`)
      let value: unknown = null
      if (script.includes('Win32_Battery')) {
        value = {
          battery: { BatteryStatus: 2, EstimatedChargeRemaining: 79 },
          status: { PowerOnline: true, Charging: false }
        }
      } else if (script.includes('Get-NetConnectionProfile')) {
        value = {
          profiles: {
            Name: 'Home',
            InterfaceAlias: 'Wi-Fi',
            IPv4Connectivity: 4,
            IPv6Connectivity: 4
          },
          wlan: '    Name : Wi-Fi\n    State : connected\n    SSID : Home\n    Signal : 80%\n'
        }
      } else if (script.includes('PlayOut.Audio]::GetVolume')) {
        value = { level: 36, muted: false }
      } else if (script.includes('GetRadiosAsync')) {
        value = { source: 'radios', radios: [{ Name: 'Bluetooth', Kind: 3, State: 1 }] }
      } else if (script.includes('WmiMonitorBrightness')) {
        value = { brightness: 25 }
      } else if (script.includes('ActiveOverlayAcPowerScheme')) {
        value = {
          ac: '00000000-0000-0000-0000-000000000000',
          dc: '961cc777-2547-4f9d-8174-7d86181b8a7a',
          onBattery: false
        }
      } else if (script.includes('GPUEngine')) {
        value = { gpu: 7 }
      }
      return value as T
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await sleep(10)
  }
}

const services: SystemService[] = []
function service(options: Partial<Parameters<typeof createSystemService>[0]> = {}): SystemService {
  const s = createSystemService({ log, ps: fakeRunner(), cacheMs: 50, ...options })
  services.push(s)
  return s
}

afterEach(() => {
  for (const s of services.splice(0)) s.stop()
})

describe('system service with a fake PowerShell', () => {
  it('merges every probe into one status and caches it', async () => {
    const scripts: string[] = []
    const s = service({ ps: fakeRunner({ onRun: (script) => scripts.push(script) }) })
    const status = await s.status()
    expect(status).toMatchObject({
      battery: { present: true, percent: 79, charging: true },
      network: { connected: true, kind: 'wifi', ssid: 'Home', signal: 80 },
      bluetooth: { available: true, on: true },
      volume: { level: 36, muted: false },
      brightness: 25,
      powerMode: 'balanced'
    })
    expect(Date.parse(status.updatedAt)).toBeGreaterThan(Date.now() - 5_000)
    const runs = scripts.length
    expect(runs).toBe(6)
    expect(await s.status()).toBe(status)
    expect(scripts.length).toBe(runs)
    await sleep(60)
    await s.status()
    expect(scripts.length).toBe(runs + 6)
  })

  it('keeps the other fields when one probe fails and never rejects', async () => {
    const s = service({ ps: fakeRunner({ fail: /GetRadiosAsync|Win32_Battery/ }) })
    const status = await s.status()
    expect(status.battery).toBeNull()
    expect(status.bluetooth).toEqual({ available: false, on: false })
    expect(status.volume).toEqual({ level: 36, muted: false })
    expect(status.network.kind).toBe('wifi')
  })

  it('publishes partial results when probes exceed the deadline', async () => {
    const s = service({ ps: fakeRunner({ delayMs: 300 }), deadlineMs: 100 })
    const t0 = Date.now()
    const status = await s.status()
    expect(Date.now() - t0).toBeLessThan(250)
    expect(status.volume).toBeNull()
    // The late answers still land afterwards.
    await sleep(400)
    expect((await s.status()).volume).toEqual({ level: 36, muted: false })
  })

  it('polls the fast probes every interval and the slow ones every slow interval', async () => {
    const scripts: string[] = []
    const published: SystemStatus[] = []
    const s = service({
      ps: fakeRunner({ onRun: (script) => scripts.push(script) }),
      cacheMs: 0,
      // Longer than one poll, shorter than two: the slow probes run on the first and third tick only.
      slowIntervalMs: 1_500
    })
    s.start((status) => published.push(status), 1_000)
    await waitUntil(() => published.length >= 2)
    const slow = (): number => scripts.filter((x) => x.includes('GetRadiosAsync')).length
    const fast = (): number => scripts.filter((x) => x.includes('Win32_Battery')).length
    expect(slow()).toBe(1)
    expect(fast()).toBe(1)
    await waitUntil(() => fast() >= 2, 2_500)
    expect(slow()).toBe(1)
    await waitUntil(() => fast() >= 3, 2_500)
    expect(slow()).toBe(2)
    s.stop()
    const after = scripts.length
    await sleep(1_100)
    expect(scripts.length).toBe(after)
    expect(published.at(-1)).toMatchObject({
      volume: { level: 36, muted: false },
      bluetooth: { available: true, on: true }
    })
  }, 15_000)

  it('refreshes the changed field and publishes after a setter', async () => {
    const scripts: string[] = []
    const published: SystemStatus[] = []
    const s = service({ ps: fakeRunner({ onRun: (script) => scripts.push(script) }) })
    s.start((status) => published.push(status), 60_000)
    await waitUntil(() => published.length >= 2)
    const before = published.length
    await s.setVolume(50)
    expect(scripts.some((x) => x.includes('SetVolume([float]0.5000)'))).toBe(true)
    await s.setMuted(true)
    expect(scripts.some((x) => x.includes('SetMute($true)'))).toBe(true)
    await s.setBrightness(70)
    expect(scripts.some((x) => x.includes('Brightness = [byte]70'))).toBe(true)
    expect(published.length).toBe(before + 3)
  })

  it('runs power mode, power actions and settings links through the injected commands', async () => {
    const commands: string[][] = []
    const opened: string[] = []
    let sleeps = 0
    const s = service({
      powerIo: {
        run: async (file, args) => {
          commands.push([file, ...args])
          return { code: 0, stdout: '', stderr: '' }
        },
        sleep: async () => {
          sleeps++
          return { code: 0, stdout: '', stderr: '' }
        }
      },
      openExternal: async (uri) => {
        opened.push(uri)
      }
    })
    await s.setPowerMode('efficiency')
    await s.powerAction('restart')
    await s.powerAction('sleep')
    await s.openWindowsSettings('power')
    expect(commands).toEqual([
      ['powercfg.exe', '/overlaysetactive', '961cc777-2547-4f9d-8174-7d86181b8a7a'],
      ['shutdown.exe', '/r', '/t', '0']
    ])
    expect(sleeps).toBe(1)
    expect(opened).toEqual(['ms-settings:powersleep'])
    const perf = await s.perf()
    expect(perf.memoryTotalMb).toBeGreaterThan(0)
  })
})

describe.skipIf(!onWindows)('system service on this machine', () => {
  it('reads the full status through the real worker within its deadline', async () => {
    // No cache so the second call measures a real warm refresh through the worker. The service publishes partial
    // results after its 9 s deadline; the cold bound leaves room for PowerShell start-up under full-suite load.
    // A refresh cut short by the deadline is a designed outcome: it publishes what has landed and keeps the
    // previous (here: initial) value of the rest, so only two complete refreshes are compared field by field.
    const warnings: string[] = []
    const ownLog = { ...log, warn: (msg: string) => warnings.push(msg) }
    const partialSince = (from: number): boolean =>
      warnings.slice(from).some((w) => w.includes('publishing partial results'))
    const s = createSystemService({ log: ownLog, cacheMs: 0 })
    services.push(s)
    const t0 = performance.now()
    const status = await s.status()
    const coldMs = Math.round(performance.now() - t0)
    const coldPartial = partialSince(0)
    expect(coldMs).toBeLessThan(20_000)

    expect(status.battery === null || typeof status.battery.present === 'boolean').toBe(true)
    expect(['wifi', 'ethernet', 'none']).toContain(status.network.kind)
    expect(typeof status.bluetooth.available).toBe('boolean')
    expect(status.volume === null || (status.volume.level >= 0 && status.volume.level <= 100)).toBe(
      true
    )
    expect(status.brightness === null || (status.brightness >= 0 && status.brightness <= 100)).toBe(
      true
    )
    expect([null, 'efficiency', 'balanced', 'performance']).toContain(status.powerMode)
    expect(Number.isNaN(Date.parse(status.updatedAt))).toBe(false)

    await sleep(60)
    const warmFrom = warnings.length
    const t1 = performance.now()
    const warm = await s.status()
    const warmMs = Math.round(performance.now() - t1)
    const warmPartial = partialSince(warmFrom)
    expect(warmMs).toBeLessThan(10_000)
    expect(['wifi', 'ethernet', 'none']).toContain(warm.network.kind)
    if (!coldPartial && !warmPartial) expect(warm.network.kind).toBe(status.network.kind)
    console.info(
      `[system] cold ${coldMs} ms${coldPartial ? ' (partial)' : ''}, warm ${warmMs} ms` +
        `${warmPartial ? ' (partial)' : ''}: ${JSON.stringify(warm)}`
    )
  }, 45_000)
})
