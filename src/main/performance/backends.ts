import type { WattsBackendStatus } from '../../shared/overlay'
import { asusCaps, asusModeDevid, asusWattsWrites, ASUS_WATTS_RANGE, type AsusCaps } from './asus'
import type { HelperClient } from './helper-client'
import type { HelperInstallState, HelperModule } from './install'
import { capRange } from './limits'
import type { CpuInfo, PerfNative } from './native'
import { smuFamilyFor } from './smu'

import { createTranslator, languageCodes } from '@shared/i18n'
import { tMain } from '../i18n'

/**
 * Where watts come from on this PC, in order of preference:
 * - 'asus-wmi': the ASUS firmware's PL1/PL2 device ids (no driver, no admin), when DSTS reports both;
 * - 'intel-msr': MSR 0x610 through PawnIO's IntelMSR module, in the elevated helper;
 * - 'ryzen-smu': the SMU's MP1 mailbox through PawnIO's RyzenSMU module, in the elevated helper (listed families).
 */

export type WattsMethod = 'asus-wmi' | 'intel-msr' | 'ryzen-smu'

export interface WattsPlan {
  method: WattsMethod
  module?: HelperModule
}

export function chooseWattsMethod(caps: AsusCaps, cpu: CpuInfo | null): WattsPlan | null {
  if (caps.watts) return { method: 'asus-wmi' }
  if (cpu?.id?.vendor === 'intel') return { method: 'intel-msr', module: 'IntelMSR.bin' }
  if (smuFamilyFor(cpu?.id ?? null)) return { method: 'ryzen-smu', module: 'RyzenSMU.bin' }
  return null
}

export const helperOutdatedMessage = (): string => tMain('mainPerformance.helper.outdated')

/**
 * Whether a watts status message is the "needs an update" one, in any language: a status read before the language
 * changed still counts.
 */
export function isHelperOutdatedMessage(message: string | undefined): boolean {
  return (
    !!message &&
    languageCodes().some(
      (code) => createTranslator(code)('mainPerformance.helper.outdated') === message
    )
  )
}

export const unsupportedMessage = (): string => tMain('mainPerformance.watts.unsupported')

export interface WattsBackend {
  readonly method: WattsMethod
  /** The PawnIO module the helper loads (helper methods only). */
  readonly module?: HelperModule
  /**
   * Re-reads the backend. `probe` false: the helper is not started; an installed helper is reported 'ready' from its
   * files alone (used while watts are off in Settings).
   */
  status(probe?: boolean): Promise<WattsBackendStatus>
  /** Values already clamped to the status's range; null leaves that limit. */
  set(watts: number | null, boostWatts: number | null): Promise<void>
  /** Back to the firmware's limits (what was in force before PlayOut's first set). */
  restore(): Promise<void>
}

export function asusWattsBackend(native: PerfNative, cpu: CpuInfo | null): WattsBackend {
  return {
    method: 'asus-wmi',
    async status() {
      return capRange<WattsBackendStatus>({
        state: 'ready',
        method: 'asus-wmi',
        cpu: cpu?.name,
        minWatts: ASUS_WATTS_RANGE.min,
        maxWatts: ASUS_WATTS_RANGE.max
      })
    },
    async set(watts, boostWatts) {
      for (const w of asusWattsWrites(watts, boostWatts)) {
        const r = await native.atkSet(w.devid, w.value)
        if (r !== 1)
          throw new Error(tMain('mainPerformance.asus.wattsRefused', { watts: w.value, answer: r }))
      }
    },
    async restore() {
      // The firmware has no "default PPT" call; writing the thermal policy again reloads its own limits (G-Helper).
      const caps = asusCaps((await native.read()).asus)
      if (caps.modeDevice) await native.atkSet(asusModeDevid(caps.modeDevice), caps.modeValue ?? 0)
    }
  }
}

export interface HelperBackendDeps {
  plan: WattsPlan & { method: 'intel-msr' | 'ryzen-smu'; module: HelperModule }
  cpu: CpuInfo | null
  installState(): Promise<HelperInstallState>
  client(): HelperClient
}

export function helperWattsBackend(deps: HelperBackendDeps): WattsBackend {
  const { plan, cpu } = deps
  const base = { method: plan.method, cpu: cpu?.name }
  return {
    method: plan.method,
    module: plan.module,
    async status(probe = true) {
      const state = await deps.installState()
      if (state !== 'installed')
        return {
          ...base,
          state: 'not-installed',
          message:
            state === 'outdated' ? helperOutdatedMessage() : tMain('mainPerformance.helper.install')
        }
      if (!probe) return { ...base, state: 'ready' }
      try {
        const info = await deps.client().info()
        if (info.locked || !info.method)
          return {
            ...base,
            state: 'unsupported',
            cpu: info.cpu || base.cpu,
            message: info.message ?? unsupportedMessage()
          }
        return capRange<WattsBackendStatus>({
          state: 'ready',
          method: info.method,
          cpu: info.cpu || base.cpu,
          minWatts: info.minWatts,
          maxWatts: info.maxWatts,
          currentWatts: info.currentWatts,
          helperVersion: info.version,
          message: info.message
        })
      } catch (err) {
        return {
          ...base,
          state: 'error',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    },
    async set(watts, boostWatts) {
      await deps.client().set(watts, boostWatts)
    },
    async restore() {
      await deps.client().restore()
    }
  }
}
