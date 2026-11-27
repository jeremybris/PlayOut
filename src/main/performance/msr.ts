/**
 * Intel RAPL package power limit (MSR_PKG_POWER_LIMIT 0x610), as the power helper reads and writes it through
 * PawnIO's IntelMSR module. The helper's C# does the same arithmetic (helper/csharp.ts); this TypeScript copy is the
 * reference its tests compare against, and lets the main process show what a raw value means.
 *
 * Layout (Intel SDM vol. 4, MSR_PKG_POWER_LIMIT): PL1 bits 14:0, enable 15, clamp 16, time window 23:17; PL2 bits
 * 46:32, enable 47, clamp 48, time window 55:49; lock 63. Values are in the power unit of MSR_RAPL_POWER_UNIT (0x606)
 * bits 3:0: 1 / 2^n watts (n = 3 on most parts: 1/8 W).
 */

export const MSR_RAPL_POWER_UNIT = 0x606
export const MSR_PKG_POWER_LIMIT = 0x610
export const MSR_PKG_ENERGY_STATUS = 0x611
export const MSR_PKG_POWER_INFO = 0x614

const FIELD = 0x7fffn
const PL1_ENABLE = 1n << 15n
const PL2_ENABLE = 1n << 47n
const LOCK = 1n << 63n

/** Watts per power unit, from MSR 0x606. */
export function powerUnitWatts(units: bigint): number {
  return 1 / 2 ** Number(units & 0xfn)
}

/** Joules per energy-status count, from MSR 0x606 bits 12:8. */
export function energyUnitJoules(units: bigint): number {
  return 1 / 2 ** Number((units >> 8n) & 0x1fn)
}

export interface PkgPowerLimit {
  pl1: number
  pl1Enabled: boolean
  pl2: number
  pl2Enabled: boolean
  /** Bit 63: the firmware locked the register until reset; writes are ignored. */
  locked: boolean
}

export function decodePowerLimit(value: bigint, unitWatts: number): PkgPowerLimit {
  return {
    pl1: Number(value & FIELD) * unitWatts,
    pl1Enabled: (value & PL1_ENABLE) !== 0n,
    pl2: Number((value >> 32n) & FIELD) * unitWatts,
    pl2Enabled: (value & PL2_ENABLE) !== 0n,
    locked: (value & LOCK) !== 0n
  }
}

function toUnits(watts: number, unitWatts: number): bigint {
  const n = Math.round(watts / unitWatts)
  return BigInt(Math.min(Number(FIELD), Math.max(1, n)))
}

/**
 * The new MSR 0x610 value: PL1 and/or PL2 replaced (null keeps that half untouched) and its enable bit set; the
 * clamp bits, time windows and every other bit are kept as the firmware set them.
 */
export function encodePowerLimit(
  current: bigint,
  unitWatts: number,
  pl1: number | null,
  pl2: number | null
): bigint {
  let v = current & 0xffffffffffffffffn
  if (pl1 !== null) v = (v & ~FIELD) | toUnits(pl1, unitWatts) | PL1_ENABLE
  if (pl2 !== null) v = (v & ~(FIELD << 32n)) | (toUnits(pl2, unitWatts) << 32n) | PL2_ENABLE
  return v
}

export interface PkgPowerInfo {
  /** Thermal spec power (the TDP), watts; 0 when the CPU does not report it. */
  tdp: number
  min: number
  max: number
}

/** MSR_PKG_POWER_INFO (0x614): TDP bits 14:0, minimum 30:16, maximum 46:32. */
export function decodePowerInfo(value: bigint, unitWatts: number): PkgPowerInfo {
  return {
    tdp: Number(value & FIELD) * unitWatts,
    min: Number((value >> 16n) & FIELD) * unitWatts,
    max: Number((value >> 32n) & FIELD) * unitWatts
  }
}

/**
 * The watts range offered for an Intel CPU: at least 5 W (or its reported minimum), at most its reported maximum,
 * else 2.5 x TDP, else 115 W (Intel's mobile parts report 0 in some fields).
 */
export function intelWattsRange(info: PkgPowerInfo): { min: number; max: number } {
  const min = Math.max(5, Math.ceil(info.min))
  const max =
    info.max >= min + 1
      ? Math.floor(info.max)
      : info.tdp > 0
        ? Math.max(min + 1, Math.floor(info.tdp * 2.5))
        : 115
  return { min, max }
}
