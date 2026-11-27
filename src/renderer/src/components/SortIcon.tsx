import type { LibrarySortId } from '@shared/types'
import {
  Calendar,
  CalendarPlus,
  ChartNoAxesColumnIncreasing,
  History,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { HLTB_BUCKETS } from '../lib/hltb'
import { SIZE_BUCKETS } from '../lib/installSize'
import { REVIEW_BANDS } from '../lib/reviews'
import { difficultyIcon } from '../lib/difficultyIcons'
import { HltbClock } from './HltbClock'
import { ReviewStarIcon } from './ReviewStarIcon'
import { SizePie } from './SizePie'

/**
 * A line icon in the box the filter sub-menus' pictures use, so the Sort menu's names line up with theirs; drawn with a
 * heavier stroke and at full strength (`.sort-icon`), so it weighs as much as the filled star, pie and stopwatch.
 */
function lineIcon(Icon: LucideIcon): ReactElement {
  return (
    <span className="console-icon sort-icon" aria-hidden="true">
      <Icon className="console-icon__generic" strokeWidth={2.75} />
    </span>
  )
}

/**
 * The Difficulty order's icon: the Hard arm's outline in the text colour (the picture used as a mask), so it is
 * black, white or grey like the other orders' icons. The Difficulty filter keeps its coloured pictures.
 */
function difficultyMark(): ReactElement | undefined {
  const url = difficultyIcon('hard')
  if (!url) return undefined
  return (
    <span className="console-icon sort-icon" aria-hidden="true">
      <span className="sort-icon__mask" style={{ maskImage: `url("${url}")` }} />
    </span>
  )
}

/**
 * The Sort menu's icon of an order, left of its name: the filters' own pictures where the order has a matching filter
 * (the Hard arm for Difficulty, the fullest stopwatch, star and pie for H.L.T.B., Reviews and Size), line icons for the
 * rest. A-Z has none (the user's choice: the only order without one).
 */
export function sortIcon(sort: LibrarySortId): ReactNode {
  switch (sort) {
    case 'title-asc':
      return undefined
    case 'difficulty':
      return difficultyMark()
    case 'hltb':
      return <HltbClock step={HLTB_BUCKETS.length} steps={HLTB_BUCKETS.length} />
    case 'most-played':
      return lineIcon(ChartNoAxesColumnIncreasing)
    case 'recent':
      return lineIcon(History)
    case 'players':
      return lineIcon(Users)
    case 'added':
      return lineIcon(CalendarPlus)
    case 'release':
      return lineIcon(Calendar)
    case 'reviews':
      return <ReviewStarIcon step={REVIEW_BANDS.length} steps={REVIEW_BANDS.length} />
    case 'size':
      return <SizePie step={SIZE_BUCKETS.length} steps={SIZE_BUCKETS.length} />
  }
}

/** The Sort menu's options with their icons (librarySortOptions keeps the order and the names). */
export function withSortIcons<T extends { value: LibrarySortId; label: string }>(
  options: readonly T[]
): (T & { icon: ReactNode })[] {
  // A-Z has no icon, but an empty slot of the same width, so its name lines up with the others'.
  return options.map((o) => ({
    ...o,
    icon: sortIcon(o.value) ?? <span className="console-icon" aria-hidden="true" />
  }))
}
