import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PowerProfileConfig } from '../../shared/overlay'
import type { CommandRunner } from '../system/power'
import type { NativeRead, PerfNative } from './native'
import {
  createProfileApplier,
  parseBefore,
  pendingOverlayMessage,
  unreadMessage,
  type ProfileApplier
} from './profiles'

const quiet = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
}

/** Windows' overlay GUIDs. */
const NONE = '00000000-0000-0000-0000-000000000000' // Balanced
const MIN = '961cc777-2547-4f9d-8174-7d86181b8a7a' // Best power efficiency
const MAX = 'ded574b5-45a0-4f42-8737-46345c09c238' // Best performance
const HIGH = '3af9b8d9-7c97-431d-ad78-34a8bfea439f' // Better performance (hidden in the Windows 11 UI)

const PLAN_A = '381b4222-f694-41f0-9685-ff5bb260df2e'
const PLAN_B = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

const silent: PowerProfileConfig = {
  powerMode: 'efficiency',
  cpuMaxPercent: 60,
  cpuBoost: false,
  watts: null,
  boostWatts: null
}
const perf: PowerProfileConfig = {
  ...silent,
  powerMode: 'performance',
  cpuMaxPercent: 100,
  cpuBoost: true
}

type Cpu = { maxAc: number; maxDc: number; boostAc: number; boostDc: number }

interface World {
  active: string
  plans: Record<string, Cpu>
  overlay: { ac: string; dc: string }
  /** PowerSetUserConfiguredAC/DCPowerMode exist. */
  api: boolean
  onBattery: boolean
  asusMode: number | null
  powercfg: string[][]
  atk: [number, number][]
  failPowercfg: boolean
  /** The next N native reads time out. */
  failReads: number
}

function setup(dir: string, world: World): ProfileApplier {
  const run: CommandRunner = async (_file, args) => {
    world.powercfg.push(args)
    if (world.failPowercfg) return { code: 1, stdout: 'nope', stderr: '' }
    if (args[0] === '/setactive') world.active = args[1]
    else if (args[0] === '/overlaysetactive') {
      if (world.onBattery) world.overlay.dc = args[1]
      else world.overlay.ac = args[1]
    } else {
      const plan = world.plans[args[1]]
      const value = Number(args[4])
      if (args[0] === '/setacvalueindex' && args[3].startsWith('bc50')) plan.maxAc = value
      if (args[0] === '/setdcvalueindex' && args[3].startsWith('bc50')) plan.maxDc = value
      if (args[0] === '/setacvalueindex' && args[3].startsWith('be33')) plan.boostAc = value
      if (args[0] === '/setdcvalueindex' && args[3].startsWith('be33')) plan.boostDc = value
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const native: PerfNative = {
    async read(): Promise<NativeRead> {
      if (world.failReads > 0) {
        world.failReads--
        throw new Error('PowerShell timed out')
      }
      return {
        asus:
          world.asusMode === null
            ? null
            : { vivo: 0x22030000 | world.asusMode, rog: -1, pl1: -1, pl2: -1 },
        scheme: world.active,
        cpu: { ...world.plans[world.active] },
        overlay: { ...world.overlay }
      }
    },
    async cpu() {
      return null
    },
    async atkSet(devid, value) {
      world.atk.push([devid, value])
      world.asusMode = value
      return 1
    },
    async activeScheme() {
      return world.active
    },
    async overlayApi() {
      return { api: world.api, onBattery: world.onBattery }
    },
    async setOverlay(source, guid) {
      if (!world.api) throw new Error('no API')
      world.overlay[source] = guid
    }
  }
  return createProfileApplier({
    native,
    run,
    stateFile: join(dir, 'performance', 'before.json'),
    log: quiet
  })
}

let dir = ''
let world: World
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playout-perf-'))
  world = {
    active: PLAN_A,
    plans: {
      [PLAN_A]: { maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 },
      [PLAN_B]: { maxAc: 100, maxDc: 100, boostAc: 2, boostDc: 2 }
    },
    overlay: { ac: NONE, dc: NONE },
    api: true,
    onBattery: false,
    asusMode: 0,
    powercfg: [],
    atk: [],
    failPowercfg: false,
    failReads: 0
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const savedState = (): ReturnType<typeof parseBefore> =>
  parseBefore(JSON.parse(readFileSync(join(dir, 'performance', 'before.json'), 'utf8')))

describe('profile applier', () => {
  it('applies the CPU state and boost to the active plan, the power mode on AC and DC, and the ASUS mode', async () => {
    const p = setup(dir, world)
    expect(await p.apply(silent)).toEqual([])
    expect(world.overlay).toEqual({ ac: MIN, dc: MIN })
    expect(world.plans[PLAN_A]).toEqual({ maxAc: 60, maxDc: 60, boostAc: 0, boostDc: 0 })
    expect(world.atk).toEqual([[0x00110019, 1]]) // Whisper
    expect(world.powercfg.at(-1)).toEqual(['/setactive', PLAN_A])
    expect(world.powercfg.flat()).not.toContain('scheme_current')
  })

  it('keeps what Windows had before the first apply only, and puts exactly that back', async () => {
    world.overlay = { ac: HIGH, dc: MIN }
    const p = setup(dir, world)
    await p.apply(silent)
    await p.apply(perf)
    expect(world.asusMode).toBe(2)
    expect(world.overlay).toEqual({ ac: MAX, dc: MAX })
    expect(savedState()).toMatchObject({
      processor: [{ scheme: PLAN_A, values: { maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 } }],
      overlay: { ac: HIGH, dc: MIN },
      asus: { device: 'vivo', value: 0 }
    })
    expect(await p.hasBefore()).toBe(true)
    expect(await p.restore()).toEqual([])
    // 'Better performance' comes back as itself, not as Best performance.
    expect(world.overlay).toEqual({ ac: HIGH, dc: MIN })
    expect(world.plans[PLAN_A]).toEqual({ maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 })
    expect(world.asusMode).toBe(0)
    expect(existsSync(join(dir, 'performance', 'before.json'))).toBe(false)
    expect(await p.hasBefore()).toBe(false)
  })

  it('restores both power sources when the PC is unplugged during the game', async () => {
    world.overlay = { ac: NONE, dc: MIN }
    const p = setup(dir, world)
    await p.apply(perf)
    expect(world.overlay).toEqual({ ac: MAX, dc: MAX })
    world.onBattery = true
    expect(await p.restore()).toEqual([])
    expect(world.overlay).toEqual({ ac: NONE, dc: MIN })
  })

  it('without PowerSetUserConfigured*PowerMode, sets and restores the current source with powercfg', async () => {
    world.api = false
    world.overlay = { ac: HIGH, dc: MIN }
    const p = setup(dir, world)
    expect(await p.apply(silent)).toEqual([])
    expect(world.powercfg).toContainEqual(['/overlaysetactive', MIN])
    expect(world.overlay).toEqual({ ac: MIN, dc: MIN })
    expect(await p.restore()).toEqual([])
    expect(world.powercfg.at(-1)).toEqual(['/overlaysetactive', HIGH])
    expect(world.overlay).toEqual({ ac: HIGH, dc: MIN })
  })

  it('without the API, keeps a source changed plugged in until a restore runs plugged in again', async () => {
    world.api = false
    world.overlay = { ac: NONE, dc: MIN }
    const p = setup(dir, world)
    expect(await p.apply(perf)).toEqual([])
    expect(world.overlay).toEqual({ ac: MAX, dc: MIN })
    expect(savedState()?.overlayTouched).toEqual({ ac: true, dc: false })
    // Unplugged during the game: the battery overlay was never changed, so it is not overwritten.
    world.onBattery = true
    world.powercfg = []
    const problems = await p.restore()
    expect(problems).toEqual([pendingOverlayMessage('ac')])
    expect(world.powercfg.filter((a) => a[0] === '/overlaysetactive')).toEqual([])
    expect(world.overlay).toEqual({ ac: MAX, dc: MIN })
    expect(world.plans[PLAN_A]).toEqual({ maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 })
    // Only the unreached source stays saved (after a restart too).
    expect(savedState()).toMatchObject({
      processor: [],
      overlay: { ac: NONE, dc: MIN },
      overlayTouched: { ac: true, dc: false }
    })
    world.onBattery = false
    const again = setup(dir, world)
    expect(await again.hasBefore()).toBe(true)
    expect(await again.restore()).toEqual([])
    expect(world.overlay).toEqual({ ac: NONE, dc: MIN })
    expect(existsSync(join(dir, 'performance', 'before.json'))).toBe(false)
  })

  it('without the API, an apply on battery after one plugged in records both sources', async () => {
    world.api = false
    world.overlay = { ac: NONE, dc: MIN }
    const p = setup(dir, world)
    await p.apply(perf)
    world.onBattery = true
    await p.apply(silent)
    expect(world.overlay).toEqual({ ac: MAX, dc: MIN })
    await p.apply(perf)
    expect(world.overlay).toEqual({ ac: MAX, dc: MAX })
    expect(savedState()?.overlayTouched).toEqual({ ac: true, dc: true })
    expect(await p.restore()).toEqual([pendingOverlayMessage('ac')])
    expect(world.overlay).toEqual({ ac: MAX, dc: MIN })
  })

  it('saves and changes a plan the user switched to while a profile was on, and restores both', async () => {
    const p = setup(dir, world)
    await p.apply(silent)
    world.active = PLAN_B
    expect(await p.apply(silent)).toEqual([])
    expect(world.plans[PLAN_B]).toEqual({ maxAc: 60, maxDc: 60, boostAc: 0, boostDc: 0 })
    expect(savedState()?.processor).toEqual([
      { scheme: PLAN_A, values: { maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 } },
      { scheme: PLAN_B, values: { maxAc: 100, maxDc: 100, boostAc: 2, boostDc: 2 } }
    ])
    world.powercfg = []
    expect(await p.restore()).toEqual([])
    expect(world.plans[PLAN_A]).toEqual({ maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 })
    expect(world.plans[PLAN_B]).toEqual({ maxAc: 100, maxDc: 100, boostAc: 2, boostDc: 2 })
    expect(world.powercfg.filter((a) => a[0] === '/setactive')).toEqual([['/setactive', PLAN_B]])
  })

  it('leaves a source alone when Windows has no overlay value for it', async () => {
    world.overlay = { ac: NONE, dc: '' }
    const p = setup(dir, world)
    expect(await p.apply(perf)).toEqual([])
    expect(world.overlay).toEqual({ ac: MAX, dc: '' })
    await p.restore()
    expect(world.overlay).toEqual({ ac: NONE, dc: '' })
  })

  it('restores the processor values into the plan they came from, and only re-activates it while active', async () => {
    const p = setup(dir, world)
    await p.apply(silent)
    // The user (or an OEM tool) picks another plan before the profile is undone.
    world.active = PLAN_B
    world.powercfg = []
    expect(await p.restore()).toEqual([])
    expect(world.plans[PLAN_A]).toEqual({ maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 })
    expect(world.plans[PLAN_B]).toEqual({ maxAc: 100, maxDc: 100, boostAc: 2, boostDc: 2 })
    expect(world.active).toBe(PLAN_B)
    expect(world.powercfg.filter((a) => a[0] === '/setactive')).toEqual([])
    expect(world.powercfg.filter((a) => a[0] !== '/setactive').every((a) => a[1] === PLAN_A)).toBe(
      true
    )
  })

  it('changes nothing whose original could not be read, says so, and reads it again next time', async () => {
    world.failReads = 1
    const p = setup(dir, world)
    expect(await p.apply(silent)).toEqual([unreadMessage()])
    expect(world.powercfg).toEqual([])
    expect(world.overlay).toEqual({ ac: NONE, dc: NONE })
    expect(world.plans[PLAN_A]).toEqual({ maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 })
    expect(world.atk).toEqual([])
    // A restore now has nothing to put back.
    expect(await p.restore()).toEqual([])
    expect(world.powercfg).toEqual([])
    // The next apply reads the originals (still untouched) and applies.
    expect(await p.apply(silent)).toEqual([])
    expect(savedState()).toMatchObject({
      processor: [{ scheme: PLAN_A, values: { maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 } }],
      overlay: { ac: NONE, dc: NONE }
    })
    expect(world.plans[PLAN_A].maxAc).toBe(60)
    expect(await p.restore()).toEqual([])
    expect(world.plans[PLAN_A]).toEqual({ maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 })
    expect(world.overlay).toEqual({ ac: NONE, dc: NONE })
  })

  it('fills in a piece that was missing from the saved state without re-reading the others', async () => {
    const p = setup(dir, world)
    await p.apply(silent)
    // A crash left a state whose overlay was never read; Windows' overlay is still the user's own.
    const state = savedState()!
    writeFileSync(
      join(dir, 'performance', 'before.json'),
      JSON.stringify({ ...state, overlay: null }),
      'utf8'
    )
    world.overlay = { ac: HIGH, dc: HIGH }
    const again = setup(dir, world)
    expect(await again.apply(perf)).toEqual([])
    expect(savedState()).toMatchObject({
      processor: [{ scheme: PLAN_A, values: { maxAc: 100, maxDc: 99, boostAc: 3, boostDc: 4 } }],
      overlay: { ac: HIGH, dc: HIGH }
    })
  })

  it('survives a restart: a new applier restores from the saved file', async () => {
    await setup(dir, world).apply(perf)
    const again = setup(dir, world)
    expect(await again.hasBefore()).toBe(true)
    await again.restore()
    expect(world.overlay).toEqual({ ac: NONE, dc: NONE })
  })

  it('does nothing on restore when PlayOut changed nothing', async () => {
    const p = setup(dir, world)
    expect(await p.restore()).toEqual([])
    expect(world.powercfg).toEqual([])
  })

  it('reports each failed step and keeps the saved state for another try', async () => {
    const p = setup(dir, world)
    await p.apply(silent)
    world.failPowercfg = true
    const problems = await p.restore()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/processor settings/)
    expect(await p.hasBefore()).toBe(true)
    expect(world.overlay).toEqual({ ac: NONE, dc: NONE }) // the other steps still ran
  })

  it('leaves the ASUS firmware alone on other PCs', async () => {
    world.asusMode = null
    const p = setup(dir, world)
    await p.apply(perf)
    await p.restore()
    expect(world.atk).toEqual([])
  })
})

describe('parseBefore', () => {
  it('drops anything invalid', () => {
    expect(parseBefore({ version: 1, powerMode: 'balanced' })).toBeNull()
    expect(
      parseBefore({
        version: 2,
        processor: {
          scheme: 'scheme_current',
          values: { maxAc: 50, maxDc: 50, boostAc: 0, boostDc: 0 }
        },
        overlay: { ac: 'turbo', dc: MIN.toUpperCase() },
        asus: { device: 'x' }
      })
    ).toEqual({
      version: 2,
      capturedAt: '',
      processor: [],
      overlay: { ac: null, dc: MIN },
      overlayTouched: { ac: false, dc: true },
      asusRead: false,
      asus: null
    })
    // A single plan object (the first format) reads as a list; touched sources never exceed those with a value.
    expect(
      parseBefore({
        version: 2,
        processor: { scheme: PLAN_A, values: { maxAc: 50, maxDc: 50, boostAc: 0, boostDc: 0 } },
        overlay: { ac: NONE, dc: null },
        overlayTouched: { ac: true, dc: true }
      })
    ).toMatchObject({
      processor: [{ scheme: PLAN_A, values: { maxAc: 50, maxDc: 50, boostAc: 0, boostDc: 0 } }],
      overlayTouched: { ac: true, dc: false }
    })
    expect(parseBefore({ version: 2, asus: { device: 'rog', value: 9 } })?.asus).toEqual({
      device: 'rog',
      value: null
    })
  })
})
