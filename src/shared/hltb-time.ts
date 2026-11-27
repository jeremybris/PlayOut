import type { Game, GameMetadata } from './types'

/**
 * The HowLongToBeat time PlayOut goes by, in hours: "Main Story", else "Solo" for a game without a Main Story time.
 * undefined when HLTB has neither (a record with only Extra or Completionist times has no time either). One rule for
 * the renderer (the H.L.T.B. filter, sort and game page) and main (the H.L.T.B. sort's lookups of games without one).
 */
export function hltbTimeHours(hltb: GameMetadata['hltb'] | undefined): number | undefined {
  if (!hltb) return undefined
  const hours = hltb.main ?? hltb.solo
  return hours !== undefined && hours > 0 ? hours : undefined
}

/**
 * Whether a game has the time the H.L.T.B. sort goes by (hltbTimeHours). A record with only Extra or Completionist
 * times has none: the sort shows it under "No time yet".
 */
export function hasHltbTimes(game: Pick<Game, 'metadata'>): boolean {
  return hltbTimeHours(game.metadata.hltb) !== undefined
}

const olderThan = (iso: string, now: number, ms: number): boolean => {
  const at = Date.parse(iso)
  return Number.isNaN(at) || now - at >= ms
}

/**
 * Whether the H.L.T.B. sort looks a game up: no time (hasHltbTimes), and never looked up (no record) or HLTB's last
 * answer is older than `missRetryMs`: its "no match" (`missedAt`), or a match without a Main Story or Solo time
 * (`updatedAt`; an unreadable or missing date counts as old). Never a host's game or one still waiting for its import.
 * Main's scrapers/hltb-times.ts and the browser mock both go by it.
 */
export function hltbTimesDue(game: Game, now: number, missRetryMs: number): boolean {
  if (game.remote || game.id.startsWith('remote:')) return false
  if (hasHltbTimes(game)) return false
  const hltb = game.metadata.hltb
  if (!hltb) return game.metadataStatus !== 'pending'
  if (hltb.missedAt) return olderThan(hltb.missedAt, now, missRetryMs)
  const answered = [hltb.main, hltb.solo, hltb.extra, hltb.completionist].some(
    (h) => typeof h === 'number'
  )
  // HLTB matched it but has no Main Story or Solo time (only Extra or Completionist): asked again like a miss.
  if (answered) return olderThan(hltb.updatedAt ?? '', now, missRetryMs)
  // A record with neither times nor a miss: never really answered.
  return true
}
