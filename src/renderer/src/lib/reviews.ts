import type { GameMetadata } from '@shared/types'

/**
 * Filters > Reviews: score bands of the review score a game page shows (Steam's percent positive, else IGDB's user
 * rating out of 100; GameMetadata.reviewScore), best first.
 */

/** The Filters > Reviews sub-menu's "All Reviews" value; every other value is a REVIEW_BANDS id. */
export const ALL_REVIEWS = 'all'

interface ReviewBand {
  id: string
  /** Numbers only ("95-100"), the same in every language. */
  label: string
  /** Inclusive. */
  min: number
  /** Exclusive, except the top band's 100, which is in it. */
  max: number
}

/** The bands of Filters > Reviews, best first; a score's lower bound is in its band. */
export const REVIEW_BANDS: readonly ReviewBand[] = [
  { id: 'r95', label: '95-100', min: 95, max: 100 },
  { id: 'r90', label: '90-95', min: 90, max: 95 },
  { id: 'r85', label: '85-90', min: 85, max: 90 },
  { id: 'r80', label: '80-85', min: 80, max: 85 },
  { id: 'r75', label: '75-80', min: 75, max: 80 },
  { id: 'r70', label: '70-75', min: 70, max: 75 },
  { id: 'r60', label: '60-70', min: 60, max: 70 },
  { id: 'r40', label: '40-60', min: 40, max: 60 },
  { id: 'r0', label: '0-40', min: 0, max: 40 }
]

/** Whether `id` is a REVIEW_BANDS id (a saved tab's choice this version knows). */
export function isReviewBandId(id: unknown): id is string {
  return typeof id === 'string' && REVIEW_BANDS.some((b) => b.id === id)
}

/** A band's label ("95-100"); the id itself for one this version does not know. */
export function reviewBandLabel(id: string): string {
  return REVIEW_BANDS.find((b) => b.id === id)?.label ?? id
}

/**
 * The REVIEW_BANDS id of a score out of 100, nothing rounded; undefined for no score (missing, NaN, below 0 or above
 * 100).
 */
export function reviewBandOf(score: number | undefined): string | undefined {
  if (score === undefined || !Number.isFinite(score) || score < 0 || score > 100) return undefined
  if (score === 100) return REVIEW_BANDS[0]!.id
  return REVIEW_BANDS.find((b) => score >= b.min && score < b.max)?.id
}

/**
 * The review score a game page shows (ActionBar's Reviews stat): `reviewScore.score` (Steam's percent positive, else
 * IGDB's user rating out of 100), never the scrapers' `rating`. undefined when the page shows none ('—': missing,
 * not a number, or 0 and below).
 */
export function reviewScoreOf(meta: Pick<GameMetadata, 'reviewScore'>): number | undefined {
  const score = meta.reviewScore?.score
  return typeof score === 'number' && Number.isFinite(score) && score > 0 ? score : undefined
}

/** A card's review score for Sort > Reviews, with the review count of the same game (0 when it has none). */
export interface ReviewValue {
  score: number
  count: number
}

/**
 * Sort > Reviews: the score a game page shows (reviewScoreOf) and how many reviews it is from (`reviewScore.count`,
 * 0 when missing); undefined when the page shows no score.
 */
export function reviewValueOf(meta: Pick<GameMetadata, 'reviewScore'>): ReviewValue | undefined {
  const score = reviewScoreOf(meta)
  if (score === undefined) return undefined
  const count = meta.reviewScore?.count
  return {
    score,
    count: typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0
  }
}
