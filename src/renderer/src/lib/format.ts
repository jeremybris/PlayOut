import type { GameMetadata } from '@shared/types'
import { t } from '../i18n'

/**
 * Human formatting helpers shared by every screen. All functions are pure and locale-aware through Intl;
 * pass an explicit `locale` in tests for deterministic output.
 */

/** Trim a one-decimal number: 2.0 -> '2', 19.6 -> '19.6'. */
function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** Play time in minutes -> '45 min' under an hour, otherwise '19.6 hours' ('1 hour' for exactly one). */
export function formatPlaytime(minutes: number | null | undefined): string {
  const m = Math.max(0, Math.round(minutes ?? 0))
  if (m < 60) return t('lib.format.minutes', { count: m })
  return t('lib.format.hours', { count: Number(oneDecimal(m / 60)) })
}

const compactCount = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1
})

/** A count shortened as Steam charts show it: 6731 -> '6.7K', 952523 -> '952.5K', 1234567 -> '1.2M', 42 -> '42'. */
export function formatCompactCount(count: number): string {
  if (!Number.isFinite(count)) return '—'
  return compactCount.format(Math.max(0, Math.round(count)))
}

/**
 * Play time against a How Long To Beat time, in one unit so they compare at a glance: '12.5 / 59 Hrs'; under an
 * hour played, '45 Min / 59 Hrs'. Without an HLTB time just the play time ('12.5 Hours'). `short` (a compact stats
 * row): whole hours from ten up ('179 / 53 Hrs').
 */
export function formatPlayVsBeat(
  minutes: number | null | undefined,
  beatHours: number | null | undefined,
  short = false
): string {
  const m = Math.max(0, Math.round(minutes ?? 0))
  if (
    beatHours === null ||
    beatHours === undefined ||
    !Number.isFinite(beatHours) ||
    beatHours <= 0
  ) {
    // formatPlaytime's words with a capital, as the stat shows them ('45 Min', '12.5 Hours').
    if (m < 60) return t('lib.format.minutesTitle', { count: m })
    return t('lib.format.hoursTitle', { count: Number(oneDecimal(m / 60)) })
  }
  const hours = (h: number): string => (short && h >= 10 ? String(Math.round(h)) : oneDecimal(h))
  // The beat time is the plural's count ('1 Hr', '59 Hrs').
  const count = Number(hours(beatHours))
  if (m < 60) return t('lib.format.minutesVsBeat', { minutes: m, count })
  return t('lib.format.hoursVsBeat', { played: hours(m / 60), count })
}

/** Hours (e.g. HowLongToBeat) -> '7.6 hrs' ('1 hr' for exactly one). */
export function formatHoursShort(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—'
  return t('lib.format.hoursShort', { count: Number(oneDecimal(Math.max(0, hours))) })
}

/**
 * A game's review score for its page: Steam's as '93%' (positive reviews, as the store shows it), IGDB's as '84'
 * (out of 100); '—' when there is none.
 */
export function formatReviewScore(
  score: number | null | undefined,
  source: 'steam' | 'igdb' | undefined
): string {
  if (score === null || score === undefined || !Number.isFinite(score) || score <= 0) return '—'
  const n = Math.round(Math.min(100, score))
  return source === 'steam' ? `${n}%` : String(n)
}

/** Stars filled for a review score out of 100 (84 = 4.2 of 5 stars), to a tenth of a star. */
export function starsFor(score: number): number {
  return Math.round((Math.max(0, Math.min(100, score)) / 20) * 10) / 10
}

/** The review score's label (Steam's user reviews and IGDB's user rating alike). */
export function reviewScoreLabel(): string {
  return t('lib.format.reviews')
}

export type DateStyle = 'short' | 'medium' | 'long' | 'year'

interface ParsedDate {
  date: Date
  /** How much of the date is known: 'YYYY', 'YYYY-MM' or a full day (ISO timestamps count as full). */
  precision: 'year' | 'month' | 'day'
}

/** Parse 'YYYY', 'YYYY-MM', 'YYYY-MM-DD' or a full ISO timestamp. Date-only values are read as local dates. */
export function parseDate(value: string | null | undefined): ParsedDate | null {
  if (!value) return null
  const text = value.trim()
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text)
  if (m) {
    const year = Number(m[1])
    const month = m[2] ? Number(m[2]) : undefined
    const day = m[3] ? Number(m[3]) : undefined
    if (month !== undefined && (month < 1 || month > 12)) return null
    if (day !== undefined && (day < 1 || day > 31)) return null
    const date = new Date(year, (month ?? 1) - 1, day ?? 1)
    if (Number.isNaN(date.getTime())) return null
    return { date, precision: day !== undefined ? 'day' : month !== undefined ? 'month' : 'year' }
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return null
  return { date, precision: 'day' }
}

/**
 * Format a release date or ISO timestamp. Partial dates keep their precision ('2020', 'Jul 2020');
 * full dates follow Intl dateStyle: short '7/28/2020', medium 'Jul 28, 2020', long 'July 28, 2020'.
 */
export function formatDate(
  value: string | null | undefined,
  style: DateStyle = 'short',
  locale?: string
): string {
  const parsed = parseDate(value)
  if (!parsed) return ''
  const { date, precision } = parsed
  if (style === 'year' || precision === 'year') return String(date.getFullYear())
  if (precision === 'month') {
    return new Intl.DateTimeFormat(locale, {
      month: style === 'short' ? 'numeric' : 'short',
      year: 'numeric'
    }).format(date)
  }
  if (style === 'short') {
    // dateStyle 'short' gives a two-digit year ('7/28/20'); the design shows the full year ('7/28/2020').
    return new Intl.DateTimeFormat(locale, {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric'
    }).format(date)
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(date)
}

/** Wall clock text for the system bar: '7:31 AM' or '07:31' when clock24h. */
export function formatClock(date: Date, clock24h: boolean, locale?: string): string {
  if (clock24h) {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(date)
  }
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date)
}

/** Release year from metadata.releaseDate, or undefined when unknown. */
export function releaseYear(metadata: GameMetadata | null | undefined): number | undefined {
  const parsed = parseDate(metadata?.releaseDate)
  return parsed ? parsed.date.getFullYear() : undefined
}

/**
 * '1 game' / '12 games'. The words are the caller's: code that shows translated text uses a plural key instead
 * (t('ns.games', { count })), since other languages do not make plurals by adding an s.
 */
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** Relative day text for "last played": 'Today', 'Yesterday', '3 days ago', else a short date. */
export function formatRelativeDay(
  value: string | null | undefined,
  now: Date = new Date(),
  locale?: string
): string {
  const days = daysSince(value, now)
  if (days === null) return ''
  if (days <= 0) return t('lib.format.today')
  if (days === 1) return t('lib.format.yesterday')
  if (days < 7) return t('lib.format.daysAgo', { count: days })
  return formatDate(value, 'short', locale)
}

/** Calendar days from `value`'s day to `now`'s (0 = today, negative = a later day); null for no date. */
export function daysSince(value: string | null | undefined, now: Date = new Date()): number | null {
  const parsed = parseDate(value)
  if (!parsed) return null
  const startOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOf(now) - startOf(parsed.date)) / 86_400_000)
}

/** 0-100 -> '85%'. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

/** Megabytes -> '6.1 GB' / '512 MB'. */
export function formatMegabytes(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '—'
  if (mb >= 1024) return `${oneDecimal(mb / 1024)} GB`
  return `${Math.round(mb)} MB`
}

/** '12.4 GB' / '850 MB' for a byte count. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}
