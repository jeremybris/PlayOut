import { describe, expect, it } from 'vitest'
import {
  formatClock,
  formatCompactCount,
  formatPlayVsBeat,
  formatCount,
  formatDate,
  formatHoursShort,
  formatReviewScore,
  reviewScoreLabel,
  starsFor,
  formatMegabytes,
  formatPercent,
  formatPlaytime,
  formatRelativeDay,
  parseDate,
  releaseYear
} from './format'

describe('formatPlaytime', () => {
  it('uses minutes under an hour and one-decimal hours above', () => {
    expect(formatPlaytime(0)).toBe('0 min')
    expect(formatPlaytime(45)).toBe('45 min')
    expect(formatPlaytime(60)).toBe('1 hour')
    expect(formatPlaytime(1176)).toBe('19.6 hours')
    expect(formatPlaytime(564)).toBe('9.4 hours')
    expect(formatPlaytime(120)).toBe('2 hours')
  })
  it('tolerates missing and negative values', () => {
    expect(formatPlaytime(undefined)).toBe('0 min')
    expect(formatPlaytime(null)).toBe('0 min')
    expect(formatPlaytime(-5)).toBe('0 min')
  })
})

describe('formatReviewScore', () => {
  it("shows Steam's score as a percentage, IGDB's out of 100, and a dash when there is none", () => {
    expect(formatReviewScore(93, 'steam')).toBe('93%')
    expect(formatReviewScore(84.4, 'igdb')).toBe('84')
    expect(formatReviewScore(undefined, undefined)).toBe('—')
    expect(formatReviewScore(0, 'steam')).toBe('—')
    expect(reviewScoreLabel()).toBe('Reviews')
    expect(starsFor(84)).toBe(4.2)
    expect(starsFor(100)).toBe(5)
    expect(starsFor(93)).toBe(4.7)
    expect(starsFor(150)).toBe(5)
    expect(starsFor(-3)).toBe(0)
  })
})

describe('formatHoursShort', () => {
  it('formats hours with the hrs suffix', () => {
    expect(formatHoursShort(7.6)).toBe('7.6 hrs')
    expect(formatHoursShort(10.4)).toBe('10.4 hrs')
    expect(formatHoursShort(1)).toBe('1 hr')
    expect(formatHoursShort(14)).toBe('14 hrs')
    expect(formatHoursShort(undefined)).toBe('—')
    expect(formatHoursShort(Number.NaN)).toBe('—')
  })
})

describe('parseDate / formatDate', () => {
  it('parses the three release-date precisions and ISO timestamps', () => {
    expect(parseDate('2020')?.precision).toBe('year')
    expect(parseDate('2020-07')?.precision).toBe('month')
    expect(parseDate('2020-07-28')?.precision).toBe('day')
    expect(parseDate('2026-10-28T19:30:00.000Z')?.precision).toBe('day')
    expect(parseDate('')).toBeNull()
    expect(parseDate('not a date')).toBeNull()
    expect(parseDate('2020-13')).toBeNull()
  })
  it('formats by style and keeps partial precision', () => {
    expect(formatDate('2020-07-28', 'short', 'en-US')).toBe('7/28/2020')
    expect(formatDate('2020-07-28', 'medium', 'en-US')).toBe('Jul 28, 2020')
    expect(formatDate('2020-07-28', 'long', 'en-US')).toBe('July 28, 2020')
    expect(formatDate('2020-07-28', 'year', 'en-US')).toBe('2020')
    expect(formatDate('2020-07', 'medium', 'en-US')).toBe('Jul 2020')
    expect(formatDate('2020', 'long', 'en-US')).toBe('2020')
    expect(formatDate(undefined)).toBe('')
  })
})

describe('formatClock', () => {
  const date = new Date(2026, 9, 29, 7, 31)
  it('formats 12-hour and 24-hour clocks', () => {
    expect(formatClock(date, false, 'en-US')).toBe('7:31 AM')
    expect(formatClock(date, true, 'en-US')).toBe('07:31')
    expect(formatClock(new Date(2026, 9, 29, 15, 5), true, 'en-US')).toBe('15:05')
  })
})

describe('releaseYear', () => {
  it('reads the year from any precision', () => {
    expect(releaseYear({ releaseDate: '2020-07-28' })).toBe(2020)
    expect(releaseYear({ releaseDate: '1996' })).toBe(1996)
    expect(releaseYear({})).toBeUndefined()
    expect(releaseYear(null)).toBeUndefined()
  })
})

describe('small formatters', () => {
  it('counts, percentages, megabytes and relative days', () => {
    expect(formatCount(1, 'game')).toBe('1 game')
    expect(formatCount(12, 'game')).toBe('12 games')
    expect(formatPercent(84.6)).toBe('85%')
    expect(formatPercent(null)).toBe('—')
    expect(formatMegabytes(512)).toBe('512 MB')
    expect(formatMegabytes(6246)).toBe('6.1 GB')
    const now = new Date(2026, 9, 29, 12)
    expect(formatRelativeDay('2026-10-29', now)).toBe('Today')
    expect(formatRelativeDay('2026-10-28', now)).toBe('Yesterday')
    expect(formatRelativeDay('2026-10-26', now)).toBe('3 days ago')
    expect(formatRelativeDay('2026-10-01', now, 'en-US')).toBe('10/1/2026')
  })
})

describe('formatCompactCount', () => {
  it('shortens counts as Steam charts do', () => {
    expect(formatCompactCount(6731)).toBe('6.7K')
    expect(formatCompactCount(952523)).toBe('952.5K')
    expect(formatCompactCount(1234567)).toBe('1.2M')
    expect(formatCompactCount(40)).toBe('40')
    expect(formatCompactCount(1000)).toBe('1K')
    expect(formatCompactCount(-3)).toBe('0')
    expect(formatCompactCount(Number.NaN)).toBe('—')
  })
})

describe('formatPlayVsBeat', () => {
  it('puts play time over the How Long To Beat time, in hours', () => {
    expect(formatPlayVsBeat(750, 59)).toBe('12.5 / 59 Hrs')
    expect(formatPlayVsBeat(10050, 59.5)).toBe('167.5 / 59.5 Hrs')
    expect(formatPlayVsBeat(120, 1)).toBe('2 / 1 Hr')
  })

  it('short (a compact stats row): whole hours from ten up', () => {
    expect(formatPlayVsBeat(10738, 53.3, true)).toBe('179 / 53 Hrs')
    expect(formatPlayVsBeat(750, 9.5, true)).toBe('13 / 9.5 Hrs')
    expect(formatPlayVsBeat(300, 8.5, true)).toBe('5 / 8.5 Hrs')
    expect(formatPlayVsBeat(45, 26, true)).toBe('45 Min / 26 Hrs')
  })

  it('uses minutes under an hour played', () => {
    expect(formatPlayVsBeat(45, 26)).toBe('45 Min / 26 Hrs')
    expect(formatPlayVsBeat(0, 26)).toBe('0 Min / 26 Hrs')
  })

  it('is the play time alone without an HLTB time', () => {
    expect(formatPlayVsBeat(750, undefined)).toBe('12.5 Hours')
    expect(formatPlayVsBeat(30, 0)).toBe('30 Min')
    expect(formatPlayVsBeat(60, null)).toBe('1 Hour')
  })
})
