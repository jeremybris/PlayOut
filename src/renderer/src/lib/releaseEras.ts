import type { Game } from '@shared/types'
import { t } from '../i18n'

/**
 * One choice of Filters > Release: the years it covers, `from` included, `to` excluded ("1990-2000" is 1990 to
 * 1999, and 2000 is in "2000-2005"); "2025-Present" has no end and "Before 1990" no start.
 */
export interface ReleaseEra {
  id: string
  label: string
  from: number
  to: number
}

/** Filters > Release's choices, newest first (the sub-menu's order, under "All Dates"). */
export const RELEASE_ERAS: readonly ReleaseEra[] = [
  {
    id: 'y-2025',
    get label() {
      return t('lib.eras.present', { year: 2025 })
    },
    from: 2025,
    to: Number.POSITIVE_INFINITY
  },
  { id: 'y-2020-2025', label: '2020-2025', from: 2020, to: 2025 },
  { id: 'y-2015-2020', label: '2015-2020', from: 2015, to: 2020 },
  { id: 'y-2010-2015', label: '2010-2015', from: 2010, to: 2015 },
  { id: 'y-2005-2010', label: '2005-2010', from: 2005, to: 2010 },
  { id: 'y-2000-2005', label: '2000-2005', from: 2000, to: 2005 },
  { id: 'y-1990-2000', label: '1990-2000', from: 1990, to: 2000 },
  {
    id: 'y-before-1990',
    get label() {
      return t('lib.eras.before', { year: 1990 })
    },
    from: Number.NEGATIVE_INFINITY,
    to: 1990
  }
]

/** Choices saved before 0.1.128 that "Before 1990" took over (a tab picking one now picks it). */
const OLD_ERAS: Readonly<Record<string, string>> = {
  'y-1950-1980': 'y-before-1990',
  'y-1980-1990': 'y-before-1990'
}

/** Saved Filters > Release choices with the old ones replaced (and each choice once). */
export function currentEraIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => OLD_ERAS[id] ?? id))]
}

/** The label of a Filters > Release choice. */
export function releaseEraLabel(id: string): string {
  return RELEASE_ERAS.find((e) => e.id === id)?.label ?? id
}

/** The year a game came out (its metadata's release date, "2020-09-17" or "2020"); undefined when unknown. */
export function releaseYear(game: Pick<Game, 'metadata'>): number | undefined {
  const m = game.metadata.releaseDate?.match(/^(\d{4})/)
  const year = m ? Number.parseInt(m[1]!, 10) : Number.NaN
  return Number.isFinite(year) && year > 0 ? year : undefined
}

/**
 * When a game came out, as a time for sorting: its release date ("2020-09-17", "2020-09" or "2020"; a year alone or a
 * month alone counts as its first day). undefined when unknown.
 */
export function releaseTime(game: Pick<Game, 'metadata'>): number | undefined {
  const m = game.metadata.releaseDate?.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/)
  if (!m) return undefined
  const year = Number.parseInt(m[1]!, 10)
  if (!(year > 0)) return undefined
  const month = m[2] ? Number.parseInt(m[2], 10) : 1
  const day = m[3] ? Number.parseInt(m[3], 10) : 1
  // setUTCFullYear, not Date.UTC: Date.UTC reads years below 100 as 19xx.
  const t = new Date(0).setUTCFullYear(
    year,
    Math.min(12, Math.max(1, month)) - 1,
    Math.min(31, Math.max(1, day))
  )
  return Number.isFinite(t) ? t : undefined
}

/** The RELEASE_ERAS id of a year; undefined for an unknown year or one before the first era. */
export function releaseEraOf(year: number | undefined): string | undefined {
  if (year === undefined) return undefined
  return RELEASE_ERAS.find((e) => year >= e.from && year < e.to)?.id
}

/**
 * The Filters > Release choices that have games in `games` (an era with none is not offered), and always "Before
 * 1990" at the bottom once any game's year is known.
 */
export function libraryReleaseEras(games: readonly Pick<Game, 'metadata'>[]): ReleaseEra[] {
  const present = new Set<string>()
  for (const game of games) {
    const era = releaseEraOf(releaseYear(game))
    if (era) present.add(era)
  }
  if (present.size) present.add('y-before-1990')
  return RELEASE_ERAS.filter((e) => present.has(e.id))
}
