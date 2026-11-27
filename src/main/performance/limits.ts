/** Watts as a backend may set them: integers inside its range, boost at least 1 W above sustained. */
export interface WattsRange {
  min: number
  max: number
}

/**
 * The most watts a profile can hold: src/main/store/settings-schema.ts accepts `watts` and `boostWatts` up to 200
 * (z.number().int().min(3).max(200)). A backend's range can go further (an Intel desktop part without PMAX reports
 * TDP x 2.5, e.g. 312 W for a 125 W TDP), so every maxWatts a backend reports is capped here; otherwise the Custom
 * profile editor would offer, and try to save, values the settings store rejects.
 */
export const SETTINGS_MAX_WATTS = 200

/** A backend's minWatts / maxWatts as reported to the renderer: max capped at SETTINGS_MAX_WATTS, min kept below it. */
export function capRange<T extends { minWatts?: number; maxWatts?: number }>(status: T): T {
  if (status.maxWatts === undefined) return status
  const maxWatts = Math.min(SETTINGS_MAX_WATTS, status.maxWatts)
  const minWatts = status.minWatts === undefined ? undefined : Math.min(status.minWatts, maxWatts)
  return { ...status, maxWatts, ...(minWatts === undefined ? {} : { minWatts }) }
}

export function clampWatts(value: number, range: WattsRange): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/**
 * Clamp a profile's watts to the backend's range. null stays null (that limit is left alone). When both are set,
 * boost is kept at least 1 W above sustained (Intel's guidance for PL2 vs PL1; harmless on AMD), lowering sustained
 * when both sit at the top of the range.
 */
export function resolveLimits(
  watts: number | null,
  boostWatts: number | null,
  range: WattsRange
): { watts: number | null; boostWatts: number | null } {
  if (range.max < range.min) return { watts: null, boostWatts: null }
  let pl1 = watts === null || !Number.isFinite(watts) ? null : clampWatts(watts, range)
  let pl2 =
    boostWatts === null || !Number.isFinite(boostWatts) ? null : clampWatts(boostWatts, range)
  if (pl1 !== null && pl2 !== null && pl2 < pl1 + 1) {
    if (pl1 + 1 <= range.max) pl2 = pl1 + 1
    else {
      pl2 = range.max
      pl1 = Math.max(range.min, range.max - 1)
    }
  }
  return { watts: pl1, boostWatts: pl2 }
}
