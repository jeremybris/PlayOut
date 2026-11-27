import type { PowerProfileConfig } from '../../shared/overlay'
import type { CommandRunner } from '../system/power'
import { tMain } from '../i18n'

/**
 * The processor settings a profile changes in a power plan, through powercfg as the signed-in user (no admin):
 * `/setacvalueindex` and `/setdcvalueindex` on the plan's own GUID (the plan that was active when PlayOut first read
 * it, never scheme_current: the active plan may have changed since), then `/setactive <that GUID>` only while that
 * plan is still the active one, so the values take effect without ever switching plans. GUIDs rather than aliases:
 * PERFBOOSTMODE is a hidden setting (`powercfg /q` does not list it), and GUIDs work whatever the setting's
 * visibility. Reading is done with PowerReadACValueIndex (native.ts), which is locale-independent and sees hidden
 * settings.
 */

export const SUB_PROCESSOR = '54533251-82be-4824-96c1-47b60b740d00'
/** Maximum processor state, % (0-100). */
export const PROCTHROTTLEMAX = 'bc5038f7-23e0-4960-96da-33abaf5935ec'
/** Processor performance boost mode: 0 disabled, 1 enabled, 2 aggressive, 3 efficient enabled, 4 efficient aggressive… */
export const PERFBOOSTMODE = 'be337238-0d82-4146-a960-4f3749d470c7'

export const BOOST_DISABLED = 0
export const BOOST_AGGRESSIVE = 2

/** The four values, on AC and on battery (DC). */
export interface CpuPowerValues {
  maxAc: number
  maxDc: number
  boostAc: number
  boostDc: number
}

export function cpuValuesForProfile(config: PowerProfileConfig): CpuPowerValues {
  const max = Math.min(100, Math.max(5, Math.round(config.cpuMaxPercent)))
  const boost = config.cpuBoost ? BOOST_AGGRESSIVE : BOOST_DISABLED
  return { maxAc: max, maxDc: max, boostAc: boost, boostDc: boost }
}

/** Valid values only: integers 0..100 for the state, 0..6 for boost (Windows defines 0-6). */
export function validCpuValues(v: unknown): v is CpuPowerValues {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const int = (x: unknown, max: number): boolean =>
    typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max
  return int(o.maxAc, 100) && int(o.maxDc, 100) && int(o.boostAc, 6) && int(o.boostDc, 6)
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A GUID as Windows writes it (lower case, dashes, no braces), or null when `v` is not one. */
export function normalizeGuid(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const g = v
    .trim()
    .replace(/^\{|\}$/g, '')
    .toLowerCase()
  return GUID.test(g) ? g : null
}

/**
 * The powercfg calls, in order, on plan `scheme`. With `activate` (that plan is still the active one) the last call
 * re-activates it so the new values take effect; otherwise they wait in that plan for its next activation.
 */
export function cpuPowerCommands(v: CpuPowerValues, scheme: string, activate: boolean): string[][] {
  const set = (flag: string, setting: string, value: number): string[] => [
    flag,
    scheme,
    SUB_PROCESSOR,
    setting,
    String(value)
  ]
  return [
    set('/setacvalueindex', PROCTHROTTLEMAX, v.maxAc),
    set('/setdcvalueindex', PROCTHROTTLEMAX, v.maxDc),
    set('/setacvalueindex', PERFBOOSTMODE, v.boostAc),
    set('/setdcvalueindex', PERFBOOSTMODE, v.boostDc),
    ...(activate ? [['/setactive', scheme]] : [])
  ]
}

export async function writeCpuPower(
  v: CpuPowerValues,
  scheme: string,
  activate: boolean,
  run: CommandRunner
): Promise<void> {
  if (!validCpuValues(v)) throw new Error('Invalid processor power values')
  const guid = normalizeGuid(scheme)
  if (!guid) throw new Error('Invalid power plan')
  for (const args of cpuPowerCommands(v, guid, activate)) {
    const result = await run('powercfg.exe', args, 10_000)
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0]
      const vars = { command: args[0]!, code: result.code }
      throw new Error(
        detail
          ? tMain('mainPerformance.cpu.failedDetail', { ...vars, detail })
          : tMain('mainPerformance.cpu.failed', vars)
      )
    }
  }
}
