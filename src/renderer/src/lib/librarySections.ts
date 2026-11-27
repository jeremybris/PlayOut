import { isToolsDifficulty, type DifficultyId, type EffectiveDifficulty } from '@shared/difficulty'
import type { Game } from '@shared/types'
import { t, useLanguageStore } from '../i18n'
import { HLTB_BUCKETS, hltbBucketOf, hltbHours } from './hltb'
import { installSizeBytes, SIZE_BUCKETS, sizeBucketOf } from './installSize'
import { sortKey } from './library'
import {
  activePlayersOf,
  type DifficultyOf,
  gameDifficultyOf,
  type HltbOf,
  isPlayable,
  type LibrarySort,
  type PlayersOf,
  gameReviewOf,
  type ReleaseOf,
  type ReviewsOf,
  type SizeOf
} from './libraryView'
import { releaseTime } from './releaseEras'
import { REVIEW_BANDS, reviewBandOf } from './reviews'

/**
 * Pure section headers of the Library grid and the entries of its right-side scroll rail. The games are
 * already sorted (sortLibrary); sections are contiguous runs of the same bucket (a letter, a day, a playtime
 * band) and never reorder anything.
 *
 * With the playable-first button on, the list is two parts (the playable games, then the rest) and each part gets
 * the sort's own sections: the playable part's letters (days, bands...) first, then the not-installed part's, each
 * section tagged with its part (`group`). The rail then marks where the not-installed part starts (railEntries).
 */

/** Which part of a playable-first list a section is in. */
export type SectionGroup = 'playable' | 'not-installed'

export interface LibrarySection {
  /**
   * Unique within one result: the bucket id, suffixed `~2`, `~3`... when an unsorted input repeats a bucket; the
   * not-installed part's prefixed `uninstalled/`.
   */
  key: string
  label: string
  /** A compact label for the narrow rail. */
  short: string
  /** Index of the section's first game. */
  start: number
  size: number
  /** Set when the playable-first button splits the list: the part the section is in. */
  group?: SectionGroup
}

/**
 * The rail entry that jumps to the not-installed part of a playable-first list (and back to the playable part). In the
 * language shown: reassigned when it changes, and an ES module's importers read the new value.
 */
export let NOT_INSTALLED_RAIL = t('lib.sections.rail.notInstalled')
export let PLAYABLE_RAIL = t('lib.sections.rail.playable')
useLanguageStore.subscribe(() => {
  NOT_INSTALLED_RAIL = t('lib.sections.rail.notInstalled')
  PLAYABLE_RAIL = t('lib.sections.rail.playable')
})

interface Bucket {
  id: string
  label: string
  short: string
}

/** A month's short name (0 = "Jan"), in the language shown. */
function monthName(month: number): string {
  switch (month) {
    case 0:
      return t('lib.sections.months.jan')
    case 1:
      return t('lib.sections.months.feb')
    case 2:
      return t('lib.sections.months.mar')
    case 3:
      return t('lib.sections.months.apr')
    case 4:
      return t('lib.sections.months.may')
    case 5:
      return t('lib.sections.months.jun')
    case 6:
      return t('lib.sections.months.jul')
    case 7:
      return t('lib.sections.months.aug')
    case 8:
      return t('lib.sections.months.sep')
    case 9:
      return t('lib.sections.months.oct')
    case 10:
      return t('lib.sections.months.nov')
    default:
      return t('lib.sections.months.dec')
  }
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** Titles that sort after Z (other scripts, and letters a locale places after Z such as Danish Ø): one bucket. */
export const OTHER_SCRIPTS = '…'

/**
 * The collator compareByTitle's `localeCompare` uses (the default locale), compared at base strength so case and
 * accents do not split a letter. Bucketing with it keeps every letter section contiguous whatever the locale.
 */
const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
const LOWER = LETTERS.map((l) => l.toLowerCase())
const bucketCache = new Map<string, string>()

/**
 * The letter bucket of a title sort: the last of A..Z that the title's first character sorts at or after under
 * the same collation as the sort. Anything before A (digits, symbols) is '#'; anything after Z that is not a Z is
 * '…'. Æ lands with A and Ø with O where the locale sorts them there, after Z where it does not.
 */
function letterOf(game: Game): string {
  const first = Array.from(sortKey(game))[0] ?? ''
  const cached = bucketCache.get(first)
  if (cached) return cached
  let bucket: string
  if (!first || collator.compare(first, 'a') < 0) bucket = '#'
  else if (collator.compare(first, 'z') > 0) bucket = OTHER_SCRIPTS
  else {
    let lo = 0
    let hi = LOWER.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (collator.compare(first, LOWER[mid]!) >= 0) lo = mid
      else hi = mid - 1
    }
    bucket = LETTERS[lo]!
  }
  bucketCache.set(first, bucket)
  return bucket
}

function parse(iso: string | undefined): Date | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) || t === 0 ? null : new Date(t)
}

function dayId(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** A local calendar day: "Today", "Yesterday", "3 Nov" this year, "3 Nov 2024" otherwise. */
function dayBucket(date: Date, now: Date): Bucket {
  const id = `day:${dayId(date)}`
  if (dayId(date) === dayId(now)) {
    const today = t('lib.sections.today')
    return { id, label: today, short: today }
  }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (dayId(date) === dayId(yesterday))
    return { id, label: t('lib.sections.yesterday'), short: t('lib.sections.yesterdayShort') }
  const month = monthName(date.getMonth())
  const day = date.getDate()
  const dayMonth = t('lib.sections.dayMonth', { day, month })
  if (date.getFullYear() === now.getFullYear()) return { id, label: dayMonth, short: dayMonth }
  return {
    id,
    label: t('lib.sections.dayMonthYear', { day, month, year: date.getFullYear() }),
    short: t('lib.sections.monthYearShort', {
      month,
      year: String(date.getFullYear() % 100).padStart(2, '0')
    })
  }
}

/** Days a game's "added" day keeps its own section; older ones share a month, those of earlier years a year. */
const ADDED_DAY_SECTIONS = 30

/**
 * Sort > Recently added: a store's own dates (Steam's "Date Added to Library") reach back years, so only the recent
 * ones are sectioned by day: then one section a month this year ("October"), one a year before that ("2024").
 */
function addedBucket(date: Date, now: Date): Bucket {
  const days = (now.getTime() - date.getTime()) / 86_400_000
  if (days < ADDED_DAY_SECTIONS) return dayBucket(date, now)
  const year = date.getFullYear()
  if (year !== now.getFullYear()) {
    const label = String(year)
    return { id: `added-year:${label}`, label, short: label }
  }
  const month = monthName(date.getMonth())
  return { id: `added-month:${year}-${date.getMonth() + 1}`, label: month, short: month }
}

const PLAYTIME_BANDS: readonly { min: number; label: string; short: string }[] = [
  { min: 100 * 60, label: '100+ h', short: '100h+' },
  { min: 50 * 60, label: '50–100 h', short: '50h' },
  { min: 20 * 60, label: '20–50 h', short: '20h' },
  { min: 10 * 60, label: '10–20 h', short: '10h' },
  { min: 5 * 60, label: '5–10 h', short: '5h' },
  { min: 60, label: '1–5 h', short: '1h' }
]

/** Same as libraryView's comparator input: PlayOut's minutes plus the store's. */
function totalPlaytime(game: Game): number {
  return game.playtimeMinutes + (game.storePlaytimeMinutes ?? 0)
}

function playtimeBucket(game: Game): Bucket {
  const minutes = totalPlaytime(game)
  for (const band of PLAYTIME_BANDS) {
    if (minutes >= band.min) return { id: `h:${band.min}`, label: band.label, short: band.short }
  }
  if (minutes > 0) return { id: 'h:under1', label: t('lib.sections.underOneHour'), short: '<1h' }
  return { id: 'h:0', label: t('lib.sections.notPlayed'), short: '0h' }
}

/**
 * The Active Players sort's sections, most players first: 100K+, 10K–100K, 1K–10K, 100–1K, under 100, no one playing
 * (a count of 0) and unknown (no count, last). Labels in the language shown.
 */
function playersBucket(count: number | undefined): Bucket {
  if (count === undefined)
    return { id: 'players:unknown', label: t('lib.sections.activePlayers.unknown'), short: '?' }
  if (count >= 100_000)
    return { id: 'players:100k', label: t('lib.sections.activePlayers.k100'), short: '100K+' }
  if (count >= 10_000)
    return { id: 'players:10k', label: t('lib.sections.activePlayers.k10'), short: '10K' }
  if (count >= 1_000)
    return { id: 'players:1k', label: t('lib.sections.activePlayers.k1'), short: '1K' }
  if (count >= 100)
    return { id: 'players:100', label: t('lib.sections.activePlayers.h100'), short: '100' }
  if (count > 0)
    return {
      id: 'players:under100',
      label: t('lib.sections.activePlayers.under100'),
      short: '<100'
    }
  return { id: 'players:none', label: t('lib.sections.activePlayers.none'), short: '0' }
}

/**
 * The Reviews sort's sections, best first: one per Filters > Reviews band ("95-100" ... "0-40", the band's lower bound
 * on the rail), then games without a score (last).
 */
function reviewsBucket(score: number | undefined): Bucket {
  const band = REVIEW_BANDS.find((b) => b.id === reviewBandOf(score))
  return band
    ? { id: `reviews:${band.id}`, label: band.label, short: String(band.min) }
    : { id: 'reviews:none', label: t('lib.sections.noScore'), short: '?' }
}

/** A level's name in the language shown ("Hard"). */
function difficultyName(level: DifficultyId): string {
  switch (level) {
    case 'story':
      return t('lib.sections.difficulty.story')
    case 'easy':
      return t('lib.sections.difficulty.easy')
    case 'medium':
      return t('lib.sections.difficulty.medium')
    case 'hard':
      return t('lib.sections.difficulty.hard')
    case 'impossible':
      return t('lib.sections.difficulty.impossible')
  }
}

/**
 * The Difficulty sort's sections: one per level (hardest first), the rail showing the name's first letter, then the
 * N/A (Tools) games (last, "N/A" on the rail).
 */
function difficultyBucket(level: EffectiveDifficulty): Bucket {
  if (isToolsDifficulty(level))
    return {
      id: `difficulty:${level}`,
      label: t('lib.sections.difficulty.tools'),
      short: t('lib.sections.difficulty.toolsShort')
    }
  const label = difficultyName(level)
  return {
    id: `difficulty:${level}`,
    label,
    short: (Array.from(label)[0] ?? '?').toLocaleUpperCase()
  }
}

/**
 * The H.L.T.B. sort's sections, shortest first: one per Filters > H.L.T.B. band ("0-3 Hours" ... "100+ Hours", its
 * range on the rail), then the games without a time yet (last; times are looked up while the sort is shown).
 */
function hltbBucket(hours: number | undefined): Bucket {
  const band = HLTB_BUCKETS.find((b) => b.id === hltbBucketOf(hours))
  if (!band) return { id: 'hltb:none', label: t('lib.sections.noTime'), short: '?' }
  const short = Number.isFinite(band.max) ? `${band.min}-${band.max}h` : `${band.min}h+`
  return { id: `hltb:${band.id}`, label: band.label, short }
}

function bucketFor(
  game: Game,
  sort: LibrarySort,
  now: Date,
  sizeOf: SizeOf,
  releaseOf: ReleaseOf,
  playersOf: PlayersOf,
  reviewsOf: ReviewsOf,
  difficultyOf: DifficultyOf,
  hltbOf: HltbOf
): Bucket {
  switch (sort) {
    case 'title-asc': {
      const letter = letterOf(game)
      return { id: `letter:${letter}`, label: letter, short: letter }
    }
    case 'recent': {
      const played = parse(game.lastPlayed)
      return played
        ? dayBucket(played, now)
        : { id: 'never', label: t('lib.sections.neverPlayed'), short: t('lib.sections.never') }
    }
    case 'added': {
      const added = parse(game.addedAt)
      return added
        ? addedBucket(added, now)
        : { id: 'unknown', label: t('lib.sections.unknown'), short: '?' }
    }
    case 'most-played':
      return playtimeBucket(game)
    case 'players':
      return playersBucket(playersOf(game))
    case 'reviews':
      return reviewsBucket(reviewsOf(game)?.score)
    case 'difficulty':
      return difficultyBucket(difficultyOf(game))
    case 'hltb':
      return hltbBucket(hltbOf(game))
    case 'release': {
      // One section per year ("2024"); games without a release date at the end.
      const time = releaseOf(game)
      if (time === undefined)
        return { id: 'release:unknown', label: t('lib.sections.unknownDate'), short: '?' }
      const year = String(new Date(time).getUTCFullYear())
      return { id: `release:${year}`, label: year, short: year }
    }
    case 'size': {
      const id = sizeBucketOf(sizeOf(game))
      const band = SIZE_BUCKETS.find((b) => b.id === id)
      return band
        ? { id: `size:${band.id}`, label: band.label, short: band.short }
        : { id: 'size:unknown', label: t('lib.sections.unknownSize'), short: '?' }
    }
  }
}

/**
 * The sections of `games` (already sorted by `sort`): contiguous runs covering every index once, in order.
 * An input that is not actually sorted still yields contiguous runs; a bucket seen again later becomes a
 * section of its own with the same label. `now` decides Today / Yesterday. `playableFirst`: the games are in
 * playable-first order (sortLibrary): the playable part and the not-installed part each get the sort's sections,
 * tagged with their `group` (the part ends at the first game that is not playable).
 */
export function librarySections(
  games: readonly Game[],
  sort: LibrarySort,
  now: Date = new Date(),
  sizeOf: SizeOf = installSizeBytes,
  releaseOf: ReleaseOf = releaseTime,
  playableFirst = false,
  playersOf: PlayersOf = activePlayersOf,
  reviewsOf: ReviewsOf = gameReviewOf,
  difficultyOf: DifficultyOf = gameDifficultyOf,
  hltbOf: HltbOf = hltbHours
): LibrarySection[] {
  const of = { sizeOf, releaseOf, playersOf, reviewsOf, difficultyOf, hltbOf }
  if (!playableFirst) return sectionsOf(games, 0, sort, now, of)
  const split = games.findIndex((game) => !isPlayable(game))
  const cut = split < 0 ? games.length : split
  return [
    ...sectionsOf(games.slice(0, cut), 0, sort, now, of, 'playable'),
    ...sectionsOf(games.slice(cut), cut, sort, now, of, 'not-installed')
  ]
}

function sectionsOf(
  games: readonly Game[],
  offset: number,
  sort: LibrarySort,
  now: Date,
  of: {
    sizeOf: SizeOf
    releaseOf: ReleaseOf
    playersOf: PlayersOf
    reviewsOf: ReviewsOf
    difficultyOf: DifficultyOf
    hltbOf: HltbOf
  },
  group?: SectionGroup
): LibrarySection[] {
  const sections: LibrarySection[] = []
  const seen = new Map<string, number>()
  const prefix = group === 'not-installed' ? 'uninstalled/' : ''
  let current: string | null = null
  games.forEach((game, index) => {
    const bucket = bucketFor(
      game,
      sort,
      now,
      of.sizeOf,
      of.releaseOf,
      of.playersOf,
      of.reviewsOf,
      of.difficultyOf,
      of.hltbOf
    )
    if (bucket.id === current) {
      sections[sections.length - 1]!.size++
      return
    }
    current = bucket.id
    const count = (seen.get(bucket.id) ?? 0) + 1
    seen.set(bucket.id, count)
    const section: LibrarySection = {
      key: prefix + (count === 1 ? bucket.id : `${bucket.id}~${count}`),
      label: bucket.label,
      short: bucket.short,
      start: offset + index,
      size: 1
    }
    if (group) section.group = group
    sections.push(section)
  })
  return sections
}

/**
 * The index of the section containing game `index` (binary search over starts). An index before the first
 * section gives 0, one past the last gives the last section; -1 when there are no sections.
 */
export function sectionIndexAt(sections: readonly LibrarySection[], index: number): number {
  if (sections.length === 0) return -1
  let lo = 0
  let hi = sections.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sections[mid]!.start <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

export interface RailEntry {
  label: string
  /** The game index to scroll to; null when no game falls in that entry (a missing letter). */
  target: number | null
}

/** The index of the first section of the not-installed part when a playable-first list has both parts; else -1. */
function notInstalledStart(sections: readonly LibrarySection[]): number {
  const index = sections.findIndex((section) => section.group === 'not-installed')
  return index > 0 ? index : -1
}

/** The first game of each label in `sections`. */
function labelStarts(sections: readonly LibrarySection[]): Map<string, number> {
  const starts = new Map<string, number>()
  for (const section of sections) {
    if (!starts.has(section.label)) starts.set(section.label, section.start)
  }
  return starts
}

/** `entries` evenly down-sampled to at most `limit`, keeping the first and last. */
function sample(entries: readonly RailEntry[], limit: number): RailEntry[] {
  if (entries.length <= limit) return [...entries]
  if (limit <= 0) return []
  if (limit === 1) return [entries[0]!]
  const out: RailEntry[] = []
  for (let i = 0; i < limit; i++) {
    out.push(entries[Math.round((i * (entries.length - 1)) / (limit - 1))]!)
  }
  return out
}

/**
 * The right-side scroll rail. Title sorts always show all 27 entries in display order ('#' sorts before
 * letters: '#', A..Z ascending, Z..A, '#' reversed), missing letters with a null target. Other sorts show
 * the sections' short labels, evenly down-sampled to at most `max` entries, keeping the first and last.
 *
 * A playable-first list with both parts (sections tagged `group`): title sorts jump to a letter within the part
 * `current` (the section at the top of the view) is in, else to the other part's, and end with one more entry
 * that jumps to the other part ("Not inst" from the playable part, "Play" back). Other sorts label the first
 * not-installed section "Not inst" and keep it, sharing the `max` entries between the two parts.
 */
export function railEntries(
  sections: readonly LibrarySection[],
  sort: LibrarySort,
  max = 27,
  reversed = false,
  current = 0
): RailEntry[] {
  const boundary = notInstalledStart(sections)
  if (sort === 'title-asc') {
    const inRest = boundary >= 0 && current >= boundary
    const here =
      boundary < 0 ? sections : inRest ? sections.slice(boundary) : sections.slice(0, boundary)
    const there =
      boundary < 0 ? [] : inRest ? sections.slice(0, boundary) : sections.slice(boundary)
    const starts = labelStarts(here)
    const others = labelStarts(there)
    // '…' (other scripts, after Z) only when some title has it: most libraries never do.
    const tail = starts.has(OTHER_SCRIPTS) || others.has(OTHER_SCRIPTS) ? [OTHER_SCRIPTS] : []
    const order = !reversed ? ['#', ...LETTERS, ...tail] : [...tail, ...[...LETTERS].reverse(), '#']
    const letters = order.map((label) => ({
      label,
      target: starts.get(label) ?? others.get(label) ?? null
    }))
    if (boundary < 0) return letters
    const jump = inRest
      ? { label: PLAYABLE_RAIL, target: sections[0]!.start }
      : { label: NOT_INSTALLED_RAIL, target: sections[boundary]!.start }
    return [...letters, jump]
  }
  const all = sections.map((section, i) => ({
    label: i === boundary ? NOT_INSTALLED_RAIL : section.short,
    target: section.start
  }))
  const limit = Math.floor(max)
  if (boundary < 0 || all.length <= limit || limit < 2) return sample(all, limit)
  // Each part gets a share of the entries (at least one), so the "Not inst" entry is always kept.
  const head = Math.min(limit - 1, Math.max(1, Math.round((limit * boundary) / all.length)))
  return [...sample(all.slice(0, boundary), head), ...sample(all.slice(boundary), limit - head)]
}
