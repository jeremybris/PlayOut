import type { Logger } from '../logger'
import { createPsWorker, type PsRunner, type PsWorker } from '../system/ps-worker'
import type { IntelFeatureStatus, IntelGraphicsStatus } from '../../shared/overlay-extras'
import { INTEL_INIT } from './intel-cs'
import { tMain } from '../i18n'

/**
 * Intel graphics driver settings through the Intel Graphics Control Library (IGCL): Endurance Gaming, the driver's
 * battery saver for games (it caps and paces the frame rate while the PC runs on battery). Global setting only.
 *
 * Probed on an Arc B390 (driver 32.0.101.9150, ControlLib.dll 1.3.306): control Off/Auto listed (On not), modes
 * Better performance / Balanced / Maximum battery, GET and a same-value SET both succeed. The XeSS Frame Generation
 * override (3D feature 17) is listed by that driver with an empty value mask, so it is not offered.
 */

export type { IntelFeatureStatus, IntelGraphicsStatus }

export type IntelFeature = 'enduranceGaming' | 'frameGenOverride'

export interface IntelGraphics {
  status(): Promise<IntelGraphicsStatus>
  /** Applies one of the feature's option keys, then answers with the status read back from the driver. */
  set(feature: IntelFeature, value: string): Promise<IntelGraphicsStatus>
  dispose(): void
}

/** ctl_3d_endurance_gaming_control_t */
export const EG_CONTROL = { off: 0, on: 1, auto: 2 } as const
/** ctl_3d_endurance_gaming_mode_t */
export const EG_MODE = { performance: 0, balanced: 1, battery: 2 } as const

export type EgControl = keyof typeof EG_CONTROL
export type EgMode = keyof typeof EG_MODE

const CONTROL_NAMES: EgControl[] = ['off', 'on', 'auto']
const MODE_NAMES: EgMode[] = ['performance', 'balanced', 'battery']

/** An On / Auto choice in words, read in PlayOut's language when the options are listed. */
function enduranceLabel(control: 'on' | 'auto', mode: EgMode): string {
  switch (`${control}:${mode}`) {
    case 'on:performance':
      return tMain('mainOverlay.intel.onPerformance')
    case 'on:balanced':
      return tMain('mainOverlay.intel.onBalanced')
    case 'on:battery':
      return tMain('mainOverlay.intel.onBattery')
    case 'auto:performance':
      return tMain('mainOverlay.intel.autoPerformance')
    case 'auto:balanced':
      return tMain('mainOverlay.intel.autoBalanced')
    default:
      return tMain('mainOverlay.intel.autoBattery')
  }
}

/** The JSON answered by PlayOut.Igcl (intel-cs.ts). */
export interface IgclReport {
  ok: boolean
  stage?: string
  code?: number
  message?: string
  device?: string
  eg?: {
    listed: boolean
    capsCode?: number
    layout?: boolean
    controlMask?: number
    controlDefault?: number
    modeMask?: number
    modeDefault?: number
    getCode?: number
    setCode?: number
    control?: number
    mode?: number
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** Parses the worker's answer (a JSON string, or the object itself); null when it is not a report. */
export function parseIgclReport(raw: unknown): IgclReport | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.ok !== 'boolean') return null
  const report: IgclReport = { ok: o.ok }
  if (typeof o.stage === 'string') report.stage = o.stage
  if (num(o.code) !== undefined) report.code = num(o.code)
  if (typeof o.message === 'string') report.message = o.message
  if (typeof o.device === 'string') report.device = o.device
  if (o.eg && typeof o.eg === 'object') {
    const e = o.eg as Record<string, unknown>
    report.eg = { listed: e.listed === true }
    if (e.layout === false) report.eg.layout = false
    for (const key of [
      'capsCode',
      'controlMask',
      'controlDefault',
      'modeMask',
      'modeDefault',
      'getCode',
      'setCode',
      'control',
      'mode'
    ] as const) {
      const n = num(e[key])
      if (n !== undefined) report.eg[key] = n
    }
  }
  return report
}

/** IGCL result codes worth naming; others are shown in hex. */
const RESULT_NAMES: Record<number, string> = {
  0x40000006: 'insufficient permissions',
  0x40000009: 'unsupported version',
  0x4000000a: 'unsupported feature',
  0x4000000b: 'invalid argument',
  0x40000003: 'device lost',
  0x40000017: 'driver call failed'
}

export function resultText(code: number): string {
  const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
  const name = RESULT_NAMES[code >>> 0]
  return name ? `${name} (${hex})` : hex
}

const bit = (mask: number, index: number): boolean => Math.floor(mask / 2 ** index) % 2 === 1

/** Option key of a control/mode pair: 'off', or '<control>:<mode>' such as 'auto:balanced'. */
export function enduranceKey(control: number, mode: number): string | null {
  const c = CONTROL_NAMES[control]
  if (!c) return null
  if (c === 'off') return 'off'
  const m = MODE_NAMES[mode]
  return m ? `${c}:${m}` : null
}

/** The control/mode pair of an option key; mode -1 (keep the stored mode) for 'off'. */
export function parseEnduranceKey(key: string): { control: number; mode: number } | null {
  if (key === 'off') return { control: EG_CONTROL.off, mode: -1 }
  const [c, m, extra] = key.split(':')
  if (extra !== undefined || c === 'off') return null
  if (!Object.hasOwn(EG_CONTROL, c) || !Object.hasOwn(EG_MODE, m)) return null
  return { control: EG_CONTROL[c as EgControl], mode: EG_MODE[m as EgMode] }
}

/** Off first, then every listed control (On, Auto) with every listed mode, from the driver's capability masks. */
export function enduranceOptions(
  controlMask: number,
  modeMask: number
): { key: string; label: string }[] {
  const options: { key: string; label: string }[] = []
  if (bit(controlMask, EG_CONTROL.off))
    options.push({ key: 'off', label: tMain('mainOverlay.intel.off') })
  for (const c of ['on', 'auto'] as const) {
    if (!bit(controlMask, EG_CONTROL[c])) continue
    for (const m of MODE_NAMES) {
      if (!bit(modeMask, EG_MODE[m])) continue
      options.push({ key: `${c}:${m}`, label: enduranceLabel(c, m) })
    }
  }
  return options
}

function unsupported(reason: string, absent = false): IntelFeatureStatus {
  return { supported: false, value: null, options: [], reason, ...(absent ? { absent } : {}) }
}

/** The Endurance Gaming status of one report. */
export function enduranceStatus(report: IgclReport | null): IntelFeatureStatus {
  if (!report) return unsupported(tMain('mainOverlay.intel.noAnswer'))
  if (!report.ok) {
    switch (report.stage) {
      case 'dll':
        return unsupported(tMain('mainOverlay.intel.noDriver'), true)
      case 'device':
        return unsupported(tMain('mainOverlay.intel.noAdapter'), true)
      case 'bitness':
        return unsupported(tMain('mainOverlay.intel.needs64'), true)
      case 'init':
        return unsupported(
          tMain('mainOverlay.intel.initFailed', { result: resultText(report.code ?? 0) })
        )
      case 'enumerate':
        return unsupported(
          tMain('mainOverlay.intel.enumerateFailed', { result: resultText(report.code ?? 0) })
        )
      default:
        return unsupported(
          report.message
            ? tMain('mainOverlay.intel.driverErrorWhy', { error: report.message })
            : tMain('mainOverlay.intel.driverError')
        )
    }
  }
  const eg = report.eg
  if (!eg || !eg.listed) {
    return unsupported(
      eg?.capsCode
        ? tMain('mainOverlay.intel.no3dFeatures', { result: resultText(eg.capsCode) })
        : tMain('mainOverlay.intel.noEndurance')
    )
  }
  if (eg.layout === false) return unsupported(tMain('mainOverlay.intel.unknownFormat'))
  if (eg.capsCode)
    return unsupported(tMain('mainOverlay.intel.capabilities', { result: resultText(eg.capsCode) }))
  const options = enduranceOptions(eg.controlMask ?? 0, eg.modeMask ?? 0)
  if (options.length < 2) return unsupported(tMain('mainOverlay.intel.noChoices'))
  if (eg.getCode) {
    return {
      supported: false,
      value: null,
      options: [],
      reason: tMain('mainOverlay.intel.unreadable', { result: resultText(eg.getCode) })
    }
  }
  const key =
    eg.control !== undefined && eg.mode !== undefined ? enduranceKey(eg.control, eg.mode) : null
  const value = key && options.some((o) => o.key === key) ? key : null
  const status: IntelFeatureStatus = { supported: true, value, options }
  if (eg.setCode)
    status.reason = tMain('mainOverlay.intel.refused', { result: resultText(eg.setCode) })
  return status
}

/** Turns a report into the status the overlay shows. */
export function intelStatus(report: IgclReport | null): IntelGraphicsStatus {
  return { enduranceGaming: enduranceStatus(report) }
}

const STATUS_TIMEOUT_MS = 15_000

export function createIntelGraphics(deps: { log: Logger; runner?: PsRunner }): IntelGraphics {
  const { log } = deps
  let worker: PsWorker | null = null
  let runner: PsRunner | null = deps.runner ?? null
  let disposed = false
  // Set once the driver is known to be absent (no ControlLib.dll or no Intel adapter): later calls answer at once.
  let absent: IntelGraphicsStatus | null = null
  let last: IntelGraphicsStatus | null = null

  function getRunner(): PsRunner {
    if (!runner) {
      worker = createPsWorker({ log, init: INTEL_INIT })
      runner = worker
    }
    return runner
  }

  async function call(script: string): Promise<IgclReport | null> {
    const raw = await getRunner().run<unknown>(script, { timeoutMs: STATUS_TIMEOUT_MS })
    const report = parseIgclReport(raw)
    if (!report) log.warn(`intel: unexpected IGCL answer ${String(raw).slice(0, 200)}`)
    return report
  }

  function remember(report: IgclReport | null): IntelGraphicsStatus {
    const status = intelStatus(report)
    if (
      report &&
      !report.ok &&
      (report.stage === 'dll' || report.stage === 'device' || report.stage === 'bitness')
    ) {
      absent = status
      if (worker) {
        worker.dispose()
        worker = null
        runner = deps.runner ?? null
      }
    }
    last = status
    return status
  }

  function failure(err: unknown): IntelGraphicsStatus {
    const message = (err as Error)?.message ?? String(err)
    log.warn(`intel: IGCL call failed: ${message}`)
    return {
      enduranceGaming: {
        supported: false,
        value: last?.enduranceGaming?.value ?? null,
        options: [],
        reason: tMain('mainOverlay.intel.noReply', { error: message })
      }
    }
  }

  return {
    async status() {
      if (disposed) throw new Error('Intel graphics disposed')
      if (absent) return absent
      try {
        return remember(await call('[PlayOut.Igcl]::Status()'))
      } catch (err) {
        return failure(err)
      }
    },

    async set(feature, value) {
      if (disposed) throw new Error('Intel graphics disposed')
      if (feature !== 'enduranceGaming') {
        throw new Error(tMain('mainOverlay.intel.noFrameGen'))
      }
      const parsed = parseEnduranceKey(value)
      if (!parsed) throw new Error(`Unknown Endurance Gaming choice "${value}"`)
      const current = absent ?? (await this.status())
      const eg = current.enduranceGaming
      if (!eg?.supported) throw new Error(eg?.reason ?? tMain('mainOverlay.intel.notAvailable'))
      if (!eg.options.some((o) => o.key === value)) {
        throw new Error(tMain('mainOverlay.intel.notOffered', { choice: value }))
      }
      if (eg.value === value) return current
      log.info(`intel: Endurance Gaming ${eg.value ?? 'unknown'} -> ${value}`)
      try {
        const status = remember(
          await call(`[PlayOut.Igcl]::SetEndurance(${parsed.control}, ${parsed.mode})`)
        )
        const after = status.enduranceGaming
        if (after?.supported && after.value !== value && !after.reason) {
          after.reason = tMain('mainOverlay.intel.keptPrevious')
        }
        return status
      } catch (err) {
        return failure(err)
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      worker?.dispose()
      worker = null
    }
  }
}
