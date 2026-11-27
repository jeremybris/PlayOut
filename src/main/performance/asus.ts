import type { WindowsPowerMode } from '../../shared/overlay'

/**
 * ASUS firmware controls through \\.\ATKACPI (the ASUS System Control Interface driver Windows installs), the way
 * G-Helper drives them: DSTS reads a device id, DEVS writes it. Opening the device needs no admin (measured on a
 * Zenbook Duo UX8407AA). Pure helpers here; the DeviceIoControl calls are in native.ts.
 */

export const ATK_DEVID = {
  /** Vivobook / Zenbook thermal policy: 0 Standard, 1 Whisper, 2 Performance, 3 Full speed. */
  VIVO_MODE: 0x00110019,
  /** ROG / TUF thermal policy: 0 Balanced, 1 Turbo, 2 Silent. */
  ROG_MODE: 0x00120075,
  /** PL1 (Intel) / SPL (AMD), integer watts. */
  PL1: 0x001200a3,
  /** PL2 (Intel) / sPPT (AMD), integer watts. */
  PL2: 0x001200a0
} as const

/** ACPI method tags (ASCII, little-endian). */
export const ATK_METHOD = { DSTS: 0x53545344, DEVS: 0x53564544 } as const
export const ATK_IOCTL = 0x0022240c

/** asus-wmi's DSTS presence bit. */
const PRESENCE_BIT = 0x10000

/** A raw DSTS answer: -1 when the call failed (the firmware has no such device id). */
export function dstsPresent(raw: number | null | undefined): boolean {
  return typeof raw === 'number' && raw >= 0 && (raw & PRESENCE_BIT) !== 0
}

export type AsusModeDevice = 'vivo' | 'rog'

const MODE_VALUES: Record<AsusModeDevice, Record<WindowsPowerMode, number>> = {
  // Whisper / Standard / Performance (Full speed is left alone: it is a fan setting more than a power one).
  vivo: { efficiency: 1, balanced: 0, performance: 2 },
  // Silent / Balanced / Turbo.
  rog: { efficiency: 2, balanced: 0, performance: 1 }
}

export function asusModeValue(device: AsusModeDevice, mode: WindowsPowerMode): number {
  return MODE_VALUES[device][mode]
}

export function asusModeDevid(device: AsusModeDevice): number {
  return device === 'vivo' ? ATK_DEVID.VIVO_MODE : ATK_DEVID.ROG_MODE
}

/** The raw DSTS answers of the device ids PlayOut uses (-1 = not answered, null = no ATKACPI device). */
export interface AsusProbe {
  vivo: number
  rog: number
  pl1: number
  pl2: number
}

export interface AsusCaps {
  /** Which thermal policy device the firmware has (ROG first, as G-Helper picks). */
  modeDevice: AsusModeDevice | null
  /**
   * The thermal policy now, when DSTS reports it in its low 16 bits (0..3; the Zenbook answers 0x22030000 in
   * Standard). Null when it cannot be read: restoring then puts the firmware default (0) back.
   */
  modeValue: number | null
  /** PL1 and PL2 both answer: watts can be set without the helper. */
  watts: boolean
}

export function asusCaps(probe: AsusProbe | null): AsusCaps {
  if (!probe) return { modeDevice: null, modeValue: null, watts: false }
  const modeDevice: AsusModeDevice | null = dstsPresent(probe.rog)
    ? 'rog'
    : dstsPresent(probe.vivo)
      ? 'vivo'
      : null
  const raw = modeDevice === 'rog' ? probe.rog : modeDevice === 'vivo' ? probe.vivo : -1
  const low = raw & 0xffff
  const max = modeDevice === 'vivo' ? 3 : 2
  return {
    modeDevice,
    modeValue: modeDevice && low <= max ? low : null,
    watts: dstsPresent(probe.pl1) && dstsPresent(probe.pl2)
  }
}

/** G-Helper's default range for the PPT device ids (no per-model data for Zenbooks). */
export const ASUS_WATTS_RANGE = { min: 5, max: 150 }

/**
 * The PL1 / PL2 writes for the ASUS firmware: PL1 first, then PL2. The firmware has no readback of PL2, so a
 * profile without boost watts gets PL2 = PL1 + 1 (G-Helper uses PL1; Intel wants PL2 at least 1 W above it).
 */
export function asusWattsWrites(
  pl1: number | null,
  pl2: number | null
): { devid: number; value: number }[] {
  const out: { devid: number; value: number }[] = []
  if (pl1 !== null) out.push({ devid: ATK_DEVID.PL1, value: pl1 })
  const two = pl2 ?? (pl1 !== null ? pl1 + 1 : null)
  if (two !== null) out.push({ devid: ATK_DEVID.PL2, value: two })
  return out
}
