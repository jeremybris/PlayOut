import { promises as fsp } from 'fs'
import { dirname } from 'path'
import type { PowerProfileConfig } from '../../shared/overlay'
import type { Logger } from '../logger'
import { overlayArgs, type CommandRunner } from '../system/power'
import { asusCaps, asusModeDevid, asusModeValue, type AsusModeDevice } from './asus'
import type { OverlayApi, OverlayValues, PerfNative } from './native'
import {
  cpuValuesForProfile,
  normalizeGuid,
  validCpuValues,
  writeCpuPower,
  type CpuPowerValues
} from './powercfg'
import { tMain } from '../i18n'

/**
 * The no-driver half of a power profile: the Windows power mode (the overlay, for AC and for battery), the CPU
 * maximum state and CPU boost (on AC and on battery) of the power plan, and on ASUS PCs the firmware's thermal policy.
 * None of it needs admin.
 *
 * The first time PlayOut changes anything, what Windows had before is saved to `before.json` (in PlayOut's data
 * folder, so a crash does not lose it); 'none' puts exactly that back and forgets it. A piece whose original could
 * not be read (a timed-out read, a cold PowerShell worker) is never changed: it is left as it is, the status says so,
 * and the next apply tries to read it again (PlayOut has not touched it, so what it reads then is still the original).
 *
 * The power mode is kept as the raw overlay GUIDs of both sources, so 'Better performance' (3af9b8d9) comes back as
 * itself and unplugging during a game does not mix up the two. Which sources PlayOut actually changed is kept too:
 * without PowerSetUserConfiguredAC/DCPowerMode (before Windows 11 22H2) only the current source can be set, so a
 * source changed while plugged in cannot be put back on battery. That source then stays saved (and the status says
 * so) until a later restore runs on it.
 *
 * The processor values are kept per plan, with the GUID of the plan they were read from, and written to that plan
 * only (see powercfg.ts). When the user (or an OEM tool) switches plans while a profile is on, the next apply saves the
 * new plan's own values before changing it, and 'none' puts every plan PlayOut changed back.
 */

export const unreadMessage = (): string => tMain('mainPerformance.profiles.unread')

type PowerSource = 'ac' | 'dc'

/** A source changed by `powercfg /overlaysetactive` (current source only) that this restore could not reach. */
export const pendingOverlayMessage = (s: PowerSource): string =>
  s === 'dc'
    ? tMain('mainPerformance.profiles.pendingBattery')
    : tMain('mainPerformance.profiles.pendingPluggedIn')

export interface PlanValues {
  scheme: string
  values: CpuPowerValues
}

export interface BeforeState {
  version: 2
  capturedAt: string
  /** Each plan PlayOut changed (or is about to), with its processor values from before; empty until read. */
  processor: PlanValues[]
  /** The power mode overlays of AC and DC; null until they could be read. A null side is one Windows has none for. */
  overlay: OverlayValues | null
  /** The overlay sources PlayOut changed (so the ones to put back). */
  overlayTouched: { ac: boolean; dc: boolean }
  /** The ASUS firmware was probed (asus below is then final: null on other PCs). */
  asusRead: boolean
  /** The ASUS thermal policy, when the PC has one; `value` null when it could not be read (restored to 0). */
  asus: { device: AsusModeDevice; value: number | null } | null
}

function parsePlan(p: unknown): PlanValues | null {
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  const scheme = normalizeGuid(o.scheme)
  return scheme && validCpuValues(o.values) ? { scheme, values: o.values } : null
}

export function parseBefore(raw: unknown): BeforeState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 2) return null
  const processor: PlanValues[] = []
  for (const p of Array.isArray(o.processor) ? o.processor : [o.processor]) {
    const plan = parsePlan(p)
    if (plan && !processor.some((x) => x.scheme === plan.scheme)) processor.push(plan)
  }
  let overlay: OverlayValues | null = null
  const ov = o.overlay as Record<string, unknown> | null | undefined
  if (ov && typeof ov === 'object') overlay = { ac: normalizeGuid(ov.ac), dc: normalizeGuid(ov.dc) }
  // Without the record (a state written before it existed), every source with a value counts as changed.
  const t = o.overlayTouched as Record<string, unknown> | null | undefined
  const touched =
    t && typeof t === 'object'
      ? { ac: t.ac === true, dc: t.dc === true }
      : { ac: !!overlay?.ac, dc: !!overlay?.dc }
  let asus: BeforeState['asus'] = null
  const a = o.asus as Record<string, unknown> | null | undefined
  if (a && (a.device === 'vivo' || a.device === 'rog')) {
    const value =
      typeof a.value === 'number' && Number.isInteger(a.value) && a.value >= 0 && a.value <= 3
        ? a.value
        : null
    asus = { device: a.device, value }
  }
  return {
    version: 2,
    capturedAt: typeof o.capturedAt === 'string' ? o.capturedAt : '',
    processor,
    overlay,
    overlayTouched: { ac: touched.ac && !!overlay?.ac, dc: touched.dc && !!overlay?.dc },
    asusRead: o.asusRead === true || asus !== null,
    asus
  }
}

export interface ProfileDeps {
  native: PerfNative
  run: CommandRunner
  /** Where the "before" state is kept. */
  stateFile: string
  log: Logger
  now?: () => Date
}

export interface ProfileApplier {
  /** Apply the no-driver settings of a profile; resolves with the problems (empty when every step worked). */
  apply(config: PowerProfileConfig): Promise<string[]>
  /** Put back what Windows had before PlayOut's first change; nothing to do when PlayOut changed nothing. */
  restore(): Promise<string[]>
  /** True while PlayOut has changed something it can put back. */
  hasBefore(): Promise<boolean>
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The overlay GUID of a power mode (the one powercfg /overlaysetactive takes). */
export const overlayGuidOf = (mode: PowerProfileConfig['powerMode']): string => overlayArgs(mode)[1]

/** The sources a write reaches: both with the API, else only the current one. */
function reachable(how: OverlayApi): { ac: boolean; dc: boolean } {
  return how.api ? { ac: true, dc: true } : { ac: !how.onBattery, dc: how.onBattery }
}

export function createProfileApplier(deps: ProfileDeps): ProfileApplier {
  const now = deps.now ?? (() => new Date())
  let cached: BeforeState | null | undefined

  async function loadBefore(): Promise<BeforeState | null> {
    if (cached !== undefined) return cached
    try {
      cached = parseBefore(JSON.parse(await fsp.readFile(deps.stateFile, 'utf8')))
    } catch {
      cached = null
    }
    return cached
  }

  async function saveBefore(state: BeforeState | null): Promise<void> {
    cached = state
    if (!state) {
      await fsp.rm(deps.stateFile, { force: true })
      return
    }
    await fsp.mkdir(dirname(deps.stateFile), { recursive: true })
    const tmp = `${deps.stateFile}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await fsp.rename(tmp, deps.stateFile)
  }

  async function trySave(state: BeforeState, loaded: BeforeState | null): Promise<void> {
    if (JSON.stringify(state) === JSON.stringify(loaded)) return
    try {
      await saveBefore(state)
    } catch (err) {
      cached = state
      deps.log.warn(`performance: could not save the current settings: ${errorText(err)}`)
    }
  }

  const fresh = (): BeforeState => ({
    version: 2,
    capturedAt: now().toISOString(),
    processor: [],
    overlay: null,
    overlayTouched: { ac: false, dc: false },
    asusRead: false,
    asus: null
  })

  /**
   * Read what Windows has now for every piece not captured yet, including the active plan when PlayOut has not
   * changed it before. Pieces already captured keep their first value; a failed read leaves the missing pieces out
   * (they are then not changed by this apply). Also resolves with the active plan (null when it could not be read).
   */
  async function fill(
    before: BeforeState | null
  ): Promise<{ state: BeforeState; plan: string | null }> {
    const b = before ?? fresh()
    const active = await deps.native.activeScheme().catch(() => null)
    const known = active !== null && b.processor.some((p) => p.scheme === active)
    if (known && b.overlay && b.asusRead) return { state: b, plan: active }
    const read = await deps.native.read().catch((err) => {
      deps.log.warn(`performance: could not read the current settings: ${errorText(err)}`)
      return null
    })
    if (!read) return { state: b, plan: active }
    const next: BeforeState = { ...b, processor: [...b.processor] }
    const scheme = read.scheme
    if (scheme && read.cpu && !next.processor.some((p) => p.scheme === scheme))
      next.processor.push({ scheme, values: read.cpu })
    if (!next.overlay && read.overlay) next.overlay = read.overlay
    if (!next.asusRead) {
      const caps = asusCaps(read.asus)
      next.asus = caps.modeDevice ? { device: caps.modeDevice, value: caps.modeValue } : null
      next.asusRead = true
    }
    return { state: next, plan: scheme ?? active }
  }

  async function setAsusMode(device: AsusModeDevice, value: number): Promise<void> {
    const r = await deps.native.atkSet(asusModeDevid(device), value)
    if (r !== 1)
      throw new Error(tMain('mainPerformance.asus.modeRefused', { mode: value, answer: r }))
  }

  /** The processor values into the given plan; /setactive only while that plan is still the active one. */
  async function writeProcessor(scheme: string, values: CpuPowerValues): Promise<void> {
    const active = await deps.native.activeScheme().catch(() => null)
    if (active === null)
      deps.log.warn('performance: could not read the active power plan; not re-activating it')
    await writeCpuPower(values, scheme, active === scheme, deps.run)
  }

  /**
   * Each source's overlay with PowerSetUserConfiguredAC/DCPowerMode; without them (before Windows 11 22H2),
   * `powercfg /overlaysetactive`, which only changes the current source's overlay. A null side is left alone, and so
   * is a side `how` cannot reach (the caller keeps track of it).
   */
  async function writeOverlays(want: OverlayValues, how: OverlayApi): Promise<void> {
    if (how.api) {
      if (want.ac) await deps.native.setOverlay('ac', want.ac)
      if (want.dc) await deps.native.setOverlay('dc', want.dc)
      return
    }
    const guid = how.onBattery ? want.dc : want.ac
    if (!guid) return
    const result = await deps.run('powercfg.exe', ['/overlaysetactive', guid], 10_000)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0]
      throw new Error(
        detail
          ? tMain('mainPerformance.profiles.modeFailedDetail', { code: result.code, detail })
          : tMain('mainPerformance.profiles.modeFailed', { code: result.code })
      )
    }
  }

  return {
    async apply(config) {
      const problems: string[] = []
      const loaded = await loadBefore()
      const { state, plan } = await fill(loaded)
      let before = state
      let unread = false

      // Which overlay sources this apply changes: recorded (and saved) before anything is written.
      let how: OverlayApi | null = null
      let overlayWant: OverlayValues | null = null
      if (before.overlay) {
        try {
          how = await deps.native.overlayApi()
          const reach = reachable(how)
          const guid = overlayGuidOf(config.powerMode)
          overlayWant = {
            ac: before.overlay.ac && reach.ac ? guid : null,
            dc: before.overlay.dc && reach.dc ? guid : null
          }
          before = {
            ...before,
            overlayTouched: {
              ac: before.overlayTouched.ac || !!overlayWant.ac,
              dc: before.overlayTouched.dc || !!overlayWant.dc
            }
          }
        } catch (err) {
          problems.push(errorText(err))
        }
      } else unread = true
      await trySave(before, loaded)

      // The plan's values first: /setactive goes before the power mode overlay is put on top.
      if (plan !== null && before.processor.some((p) => p.scheme === plan)) {
        try {
          await writeProcessor(plan, cpuValuesForProfile(config))
        } catch (err) {
          problems.push(errorText(err))
        }
      } else unread = true
      if (how && overlayWant) {
        try {
          await writeOverlays(overlayWant, how)
        } catch (err) {
          problems.push(errorText(err))
        }
      }
      if (before.asus) {
        try {
          await setAsusMode(before.asus.device, asusModeValue(before.asus.device, config.powerMode))
        } catch (err) {
          problems.push(errorText(err))
        }
      }
      if (unread) problems.push(unreadMessage())
      return problems
    },

    async restore() {
      const before = await loadBefore()
      if (!before) return []
      const problems: string[] = []
      for (const p of before.processor) {
        try {
          await writeProcessor(p.scheme, p.values)
        } catch (err) {
          problems.push(errorText(err))
        }
      }
      // Sources changed but out of reach now (powercfg, other source): kept for a later restore.
      let pending = { ac: false, dc: false }
      const touched = before.overlayTouched
      if (before.overlay && (touched.ac || touched.dc)) {
        try {
          const how = await deps.native.overlayApi()
          const reach = reachable(how)
          const want = {
            ac: touched.ac && reach.ac ? before.overlay.ac : null,
            dc: touched.dc && reach.dc ? before.overlay.dc : null
          }
          await writeOverlays(want, how)
          pending = { ac: touched.ac && !reach.ac, dc: touched.dc && !reach.dc }
        } catch (err) {
          problems.push(errorText(err))
        }
      }
      if (before.asus) {
        try {
          await setAsusMode(before.asus.device, before.asus.value ?? 0)
        } catch (err) {
          problems.push(errorText(err))
        }
      }
      // Keep the saved state when something failed, so the next 'none' (or start) tries again.
      if (problems.length) return problems
      try {
        if (pending.ac || pending.dc) {
          // Everything else is back: only the unreached source stays saved. The rest is read afresh next time.
          await saveBefore({ ...fresh(), overlay: before.overlay, overlayTouched: pending })
          for (const s of ['ac', 'dc'] as const)
            if (pending[s]) problems.push(pendingOverlayMessage(s))
        } else await saveBefore(null)
      } catch (err) {
        deps.log.warn(`performance: could not update ${deps.stateFile}: ${errorText(err)}`)
      }
      return problems
    },

    async hasBefore() {
      return (await loadBefore()) !== null
    }
  }
}
