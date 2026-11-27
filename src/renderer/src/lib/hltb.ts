import { hltbTimeHours } from '@shared/hltb-time'
import type { Game } from '@shared/types'
import { t } from '../i18n'

/**
 * The HowLongToBeat time the H.L.T.B. filter, sort and the game page go by, in hours: "Main Story", else "Solo" for a
 * game without a Main Story time. HLTB's pages lead with Main Story for compilations too ("Single-Player: 113 - 303
 * Hours" for Kingdom Hearts HD 1.5 + 2.5 ReMIX, whose Solo is 158 hours), so a combined game is no exception.
 * undefined when HLTB has neither. The rule is shared/hltb-time.ts's, which main's H.L.T.B. sort lookups use too.
 */
export function hltbHours(game: Pick<Game, 'metadata'>): number | undefined {
  return hltbTimeHours(game.metadata.hltb)
}

/** Whether `hltbHours` is HLTB's Solo time (no Main Story time; the game page labels it "Solo"). */
export function hltbUsesSolo(game: Pick<Game, 'metadata'>): boolean {
  const hltb = game.metadata.hltb
  return !!hltb?.solo && hltb.main === undefined
}

/** The Filters > H.L.T.B. sub-menu's "All Times" value; every other value is an HLTB_BUCKETS id. */
export const ALL_HLTB = 'all'

interface HltbBucket {
  id: string
  /** Read in the language shown ("0-3 Hours"). */
  label: string
  min: number
  max: number
}

const band = (id: string, range: string, min: number, max: number): HltbBucket => ({
  id,
  get label() {
    return t('lib.hltb.hours', { range })
  },
  min,
  max
})

/** Time bands of Filters > H.L.T.B., shortest first; `max` is exclusive. */
export const HLTB_BUCKETS: readonly HltbBucket[] = [
  band('h-0-3', '0-3', 0, 3),
  band('h-3-10', '3-10', 3, 10),
  band('h-10-20', '10-20', 10, 20),
  band('h-20-50', '20-50', 20, 50),
  band('h-50-100', '50-100', 50, 100),
  band('h-100', '100+', 100, Number.POSITIVE_INFINITY)
]

/** The HLTB_BUCKETS id of a time in hours; undefined for an unknown time. */
export function hltbBucketOf(hours: number | undefined): string | undefined {
  if (hours === undefined || !(hours > 0)) return undefined
  return HLTB_BUCKETS.find((b) => hours >= b.min && hours < b.max)?.id
}
