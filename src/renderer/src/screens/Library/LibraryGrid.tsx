import type { Game, LibraryScrollPosition, Platform } from '@shared/types'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import { maxColumnsFor } from '@shared/cover-scale'
import { GameCard } from '../../components/GameCard'
import { useActionHandlers } from '../../hooks/useActionHandlers'
import {
  FocusContext,
  doesFocusableExist,
  isFocusWithin,
  setFocus,
  updateAllLayouts,
  useFocusable
} from '../../input/focus'
import { useT } from '../../i18n'
import { cx } from '../../lib/cx'
import { cardFocusKey } from '../../lib/focusKeys'
import { railEntries, sectionIndexAt, type LibrarySection } from '../../lib/librarySections'
import {
  focusTargetAfterScroll,
  scrollAnchor,
  scrollTopFor,
  visibleRows
} from '../../lib/libraryScroll'
import { gridColumns, type LibrarySort } from '../../lib/libraryView'
import {
  cardWindow,
  gridRowLayout,
  mergeSegments,
  sameSegments,
  type Segment
} from '../../lib/windowing'
import { registerCardFocuser } from '../../lib/popupOpeners'
import { copiesFor } from '../../state/favorite'
import { CoverSizeSlider } from './CoverSizeSlider'
import { coverSizeKeyAt } from './coverSizeTarget'
import { GRID_KEY, INITIAL_ROWS, LIBRARY_ROW, MAX_COLUMNS, ROW_OVERSCAN } from './keys'

export interface LibraryGridProps {
  games: Game[]
  platformsById: Map<string, Platform>
  /** The game to focus (and keep mounted) first: the tab's remembered card; the first card when absent. */
  initialGameId: string | null
  /** Move focus onto the initial card on mount (false keeps focus on the tab or header control that changed the tab). */
  autoFocus: boolean
  /** Slide direction of the entrance (a tab switch): 1 = from the right, -1 = from the left, 0 = fade only. */
  direction: 1 | -1 | 0
  onOpen: (game: Game) => void
  onCardFocus: (game: Game) => void
  /** Mounted with no cards (nothing matched): the view focuses its search field instead. */
  onEmpty: () => void
  /** Copies across stores per shown game id (lib/copies.ts), for the count above the store badge. */
  copies: ReadonlyMap<string, number>
  /** The sort's sections over `games` (lib/librarySections.ts): D-pad up / down and the rail jump between them. */
  sections: readonly LibrarySection[]
  sort: LibrarySort
  /** The sort is turned around (Library > Sort picked twice). */
  sortReversed: boolean
  /** The view takes input (no modal, not leaving): the section jumps are registered only then. */
  active: boolean
  /** Where the tab was scrolled when it was last shown (this or an earlier session); null = the top. */
  initialScroll?: LibraryScrollPosition | null
  /** The grid was scrolled (by the user, a wheel, or a focus move): where to now; null = the top. */
  onScrollChange?: (position: LibraryScrollPosition | null) => void
  /** Cover size, every tab alike (settings.ui.libraryCoverScale): 1 = the original 240x360u. */
  coverScale?: number
  /** The cover-size slider picked a size; without it the slider is not shown. */
  onCoverScale?: (scale: number) => void
}

interface Metrics {
  /** Card height plus the row gap, in px. */
  rowStride: number
  cardWidth: number
  gap: number
  /** The viewport's top padding before the first row, in px. */
  paddingTop: number
}

/**
 * The cover grid: a CSS grid of GameCards, six columns (fewer when the width does not fit six), inside a
 * vertical scroll viewport. Windowed: only the rows near the viewport (plus ROW_OVERSCAN on each side and
 * the focused card's row) are mounted; omitted runs are spacers spanning exactly that many grid rows, so
 * scrollIntoView and the scrollbar position stay right with thousands of games. A Norigin container that
 * remembers its last focused card. Re-keyed per tab by the parent, so a tab switch starts from the top
 * with the tab's remembered card focused.
 */
export const LibraryGrid = memo(function LibraryGrid({
  games,
  platformsById,
  initialGameId,
  autoFocus,
  direction,
  onOpen,
  onCardFocus,
  onEmpty,
  copies,
  sections,
  sort,
  sortReversed,
  active,
  initialScroll = null,
  onScrollChange,
  coverScale = 1,
  onCoverScale
}: LibraryGridProps): ReactElement {
  const t = useT()
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: GRID_KEY,
    trackChildren: true,
    saveLastFocusedChild: true
  })
  const viewportRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)

  const indexById = useMemo(() => new Map(games.map((g, i) => [g.id, i])), [games])
  const count = games.length

  // ---- the focused card pins its row (and its neighbours) in the window ------------------------------
  // Kept as the game's id and resolved to an index every render, so the pin follows the card when the list
  // is re-sorted or grows (a scan inserting games before it) instead of protecting a stale row.
  const [pinned, setPinned] = useState<{ id: string | null; index: number }>(() => ({
    id: initialGameId,
    index: initialGameId ? (indexById.get(initialGameId) ?? 0) : 0
  }))
  const known = pinned.id !== null ? indexById.get(pinned.id) : undefined
  // A pinned game that left the list (hidden, removed): stay around where it was.
  const pinnedIndex = known ?? Math.max(0, Math.min(count - 1, pinned.index))
  // A section jump or rail click to a card that may not be mounted yet: pinned (so its row mounts), scrolled to
  // the top of the viewport, then focused once it is registered.
  const pendingJump = useRef<string | null>(null)
  const handleCardFocus = useCallback(
    (game: Game) => {
      setPinned({ id: game.id, index: indexById.get(game.id) ?? 0 })
      // A jump whose card never arrived (filtered away meanwhile) must not snatch focus later.
      if (pendingJump.current !== game.id) pendingJump.current = null
      onCardFocus(game)
    },
    [indexById, onCardFocus]
  )
  // The rail marks the section at the top of the viewport (it follows a wheel scroll, not only the focus).
  const [topIndex, setTopIndex] = useState(0)

  // ---- measurements: columns from the viewport width, row stride from a probe sized like a card -------
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const maxColumns = maxColumnsFor(coverScale, MAX_COLUMNS)
  const [columns, setColumns] = useState(maxColumns)
  const measureMetrics = useCallback(() => {
    const probe = probeRef.current
    const viewport = viewportRef.current
    if (!probe || !viewport) return
    const gap = parseFloat(getComputedStyle(probe).marginLeft) || 0
    const cardWidth = probe.offsetWidth
    const cardHeight = probe.offsetHeight
    if (!(cardWidth > 0) || !(cardHeight > 0)) return
    const style = getComputedStyle(viewport)
    const paddingTop = parseFloat(style.paddingTop) || 0
    setMetrics((previous) =>
      previous &&
      previous.cardWidth === cardWidth &&
      previous.gap === gap &&
      previous.rowStride === cardHeight + gap &&
      previous.paddingTop === paddingTop
        ? previous
        : { cardWidth, gap, rowStride: cardHeight + gap, paddingTop }
    )
    const inset = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    setColumns(gridColumns(viewport.clientWidth - inset, cardWidth, gap, maxColumns))
  }, [maxColumns])

  useLayoutEffect(() => {
    measureMetrics()
  }, [measureMetrics])
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measureMetrics)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [measureMetrics])

  // ---- cover size: measured again (the probe follows --library-cover-scale), the remembered card kept in view ----
  const shownScale = useRef(coverScale)
  const rescaled = useRef(false)
  useLayoutEffect(() => {
    if (shownScale.current === coverScale) return
    shownScale.current = coverScale
    rescaled.current = true
    measureMetrics()
  }, [coverScale, measureMetrics])

  // ---- the window of mounted rows ----------------------------------------------------------------------
  const rowCount = Math.ceil(count / columns)
  const pinnedRow = Math.floor(pinnedIndex / columns)
  // The first render already mounts the pinned (remembered) row: the initial-focus effect below runs
  // before the first measurement's re-render, so its card must exist by then.
  const [segments, setSegments] = useState<Segment[]>(() =>
    mergeSegments([
      { start: 0, end: Math.min(rowCount, INITIAL_ROWS) },
      ...cardWindow({
        count: rowCount,
        pinned: [pinnedRow],
        scrollLeft: 0,
        clientWidth: 0,
        paddingLeft: 0,
        stride: 0,
        overscan: ROW_OVERSCAN
      })
    ])
  )
  const latest = useRef({ rowCount, pinnedRow, metrics, columns, games, onScrollChange })
  useLayoutEffect(() => {
    latest.current = { rowCount, pinnedRow, metrics, columns, games, onScrollChange }
  })

  // ---- the tab's scroll: reported as the user scrolls, put back when the tab is shown again ------------
  // Reported only once the saved scroll was put back, so the mount at the top does not overwrite it.
  const scrollRestored = useRef(false)
  const reportScroll = useCallback(() => {
    const viewport = viewportRef.current
    const { metrics: m, columns: cols, games: list, onScrollChange: report } = latest.current
    if (!viewport || !m || !report || !scrollRestored.current) return
    report(scrollAnchor(list, cols, m, viewport.scrollTop))
  }, [])
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    viewport.addEventListener('scroll', reportScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', reportScroll)
  }, [reportScroll])

  const measureWindow = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const { rowCount: rows, pinnedRow: pinned, metrics: m } = latest.current
    const next = cardWindow({
      count: rows,
      pinned: [pinned],
      scrollLeft: viewport.scrollTop,
      clientWidth: viewport.clientHeight,
      paddingLeft: m?.paddingTop ?? 0,
      stride: m?.rowStride ?? 0,
      overscan: ROW_OVERSCAN
    })
    setSegments((previous) => (sameSegments(previous, next) ? previous : next))
    const stride = m?.rowStride ?? 0
    const firstRow =
      stride > 0
        ? Math.max(0, Math.floor((viewport.scrollTop - (m?.paddingTop ?? 0)) / stride + 0.5))
        : 0
    setTopIndex(firstRow * latest.current.columns)
  }, [])

  useLayoutEffect(() => {
    measureWindow()
  }, [measureWindow, rowCount, pinnedRow, metrics])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    viewport.addEventListener('scroll', measureWindow, { passive: true })
    return () => viewport.removeEventListener('scroll', measureWindow)
  }, [measureWindow])

  // After a size change the remembered card's row (it moved: new card height, new column count) is centred in the
  // viewport, so the focus stays on the same game in view.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!rescaled.current || !metrics || !viewport) return
    rescaled.current = false
    const row = Math.floor(pinnedIndex / columns)
    const top = metrics.paddingTop + row * metrics.rowStride
    const room = viewport.clientHeight - (metrics.rowStride - metrics.gap)
    viewport.scrollTop = Math.max(0, top - Math.max(0, room) / 2)
    measureWindow()
    reportScroll()
    // only after a size change's measurement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics, columns])

  // The set of mounted focusables changed: refresh Norigin's spatial layout.
  useEffect(() => {
    updateAllLayouts()
  }, [segments, columns])

  // ---- sections: D-pad up / down (Ctrl+Up / Down) and the rail jump to a section's first game -----------
  const jumpTo = useCallback(
    (index: number) => {
      const game = games[index]
      const viewport = viewportRef.current
      if (!game || !viewport) return
      setPinned({ id: game.id, index })
      const row = Math.floor(index / columns)
      const top = (metrics?.paddingTop ?? 0) + row * (metrics?.rowStride ?? 0)
      // The section's first row at the top (minus the viewport's scroll padding, so the focus ring shows).
      const pad = parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0
      viewport.scrollTo({ top: Math.max(0, top - pad), behavior: 'auto' })
      pendingJump.current = game.id
    },
    [games, columns, metrics]
  )
  // The cover menu (Preferred Copy, a game that re-sorted far away) and the Library's focus recovery focus a game's
  // card through the grid, which scrolls to it first when it is not mounted. A copy the grid does not show
  // resolves to the copy that now stands for its game; false when the grid has none of them.
  const focusGameRef = useRef<(gameId: string) => boolean>(() => false)
  useLayoutEffect(() => {
    focusGameRef.current = (gameId) => {
      const candidates = [gameId, ...copiesFor(gameId).map((c) => c.id)]
      const id = candidates.find((c) => indexById.has(c))
      if (id === undefined) return false
      const key = cardFocusKey(LIBRARY_ROW, id)
      if (doesFocusableExist(key)) void setFocus(key)
      else jumpTo(indexById.get(id)!)
      return true
    }
  })
  useEffect(() => registerCardFocuser(LIBRARY_ROW, (gameId) => focusGameRef.current(gameId)), [])

  // Every jump sets a new pin, so this runs after its commit; a row mounted by the scroll arrives with segments.
  useEffect(() => {
    const id = pendingJump.current
    if (!id) return
    const key = cardFocusKey(LIBRARY_ROW, id)
    if (!doesFocusableExist(key)) return
    pendingJump.current = null
    updateAllLayouts()
    void setFocus(key)
  }, [pinned, segments])

  const stepSection = useCallback(
    (delta: 1 | -1): boolean => {
      if (!isFocusWithin(GRID_KEY) || sections.length < 2) return false
      const current = sectionIndexAt(sections, pinnedIndex)
      const target = sections[current + delta]
      // No section that way: the press moves focus as usual (up to the header, down to Import).
      if (!target) return false
      jumpTo(target.start)
      return true
    },
    [sections, pinnedIndex, jumpTo]
  )
  useActionHandlers(
    {
      'section-prev': () => stepSection(-1),
      'section-next': () => stepSection(1)
    },
    active
  )

  // ---- initial scroll and focus ------------------------------------------------------------------------
  // A tab left scrolled opens scrolled the same (once the first measurement tells where its rows are), and then
  // focuses its remembered card if that is on screen, else the top row's first card: focusing an off-screen card
  // would scroll the view back to it. A tab left at the top (or whose saved game is gone) focuses its remembered card
  // on mount, as before.
  const restoreScroll = initialScroll !== null && indexById.has(initialScroll.gameId)
  useEffect(() => {
    if (!restoreScroll) scrollRestored.current = true
    if (!autoFocus) return
    if (count === 0) {
      onEmpty()
      return
    }
    if (restoreScroll) return
    const target = initialGameId && indexById.has(initialGameId) ? initialGameId : games[0]!.id
    void setFocus(cardFocusKey(LIBRARY_ROW, target))
    // on mount only: the parent re-keys the grid per tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLayoutEffect(() => {
    if (scrollRestored.current || !metrics) return
    scrollRestored.current = true
    const viewport = viewportRef.current
    const top = initialScroll && scrollTopFor(initialScroll, indexById, columns, metrics)
    if (!viewport || top === null || top === undefined) return
    viewport.scrollTop = top
    measureWindow()
    if (!autoFocus || count === 0) return
    // Only rows clear of the viewport's scroll padding: focusing a card inside that band scrolls it out of it
    // (a card's scrollIntoView with gamepad or keyboard input), which would move the view off the saved position.
    const style = getComputedStyle(viewport)
    const padTop = parseFloat(style.scrollPaddingTop) || 0
    const padBottom = parseFloat(style.scrollPaddingBottom) || 0
    const rows = visibleRows(
      viewport.scrollTop + padTop,
      Math.max(0, viewport.clientHeight - padTop - padBottom),
      metrics,
      rowCount
    )
    const target = focusTargetAfterScroll(games, columns, initialGameId, indexById, rows)
    if (!target) return
    // Pinned so its row is mounted; focused by the pending-jump effect once its card is registered.
    setPinned({ id: target, index: indexById.get(target) ?? 0 })
    pendingJump.current = target
    // once, when the first measurement arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics])

  // D-pad left from the first column: to the cover-size slider's part level with the card (not Norigin's nearest
  // corner, which picks − for most rows).
  const leftToSlider = useCallback(
    (direction: string, game: Game): boolean => {
      if (direction !== 'left' || !onCoverScale) return true
      if ((indexById.get(game.id) ?? 1) % columns !== 0) return true
      const card = viewportRef.current?.querySelector('.library__card[data-focused="true"]')
      const rect = card?.getBoundingClientRect()
      const key = rect ? coverSizeKeyAt(sliderRef.current, rect.top + rect.height / 2) : null
      if (!key) return true
      void setFocus(key)
      return false
    },
    [onCoverScale, indexById, columns]
  )

  const renderCard = useCallback(
    (game: Game): ReactNode => (
      <GameCard
        key={game.id}
        game={game}
        rowId={LIBRARY_ROW}
        platform={platformsById.get(game.platformId)}
        onSelect={onOpen}
        onFocus={handleCardFocus}
        copies={copies.get(game.id)}
        onArrowPress={leftToSlider}
        className="library__card"
      />
    ),
    [platformsById, onOpen, handleCardFocus, copies, leftToSlider]
  )

  const children: ReactNode[] = []
  for (const entry of gridRowLayout(segments, rowCount)) {
    if (entry.kind === 'spacer') {
      children.push(<Spacer key={`spacer:${entry.row}`} rows={entry.rows} />)
      continue
    }
    const first = entry.row * columns
    const last = Math.min(count, first + columns)
    for (let i = first; i < last; i++) children.push(renderCard(games[i]!))
  }

  // D-pad right from the cover-size slider: back to the remembered card (the row the slider was entered from).
  const focusGridFromSlider = useCallback((): boolean => {
    const game = games[pinnedIndex]
    if (!game) return true
    const key = cardFocusKey(LIBRARY_ROW, game.id)
    if (doesFocusableExist(key)) void setFocus(key)
    else jumpTo(pinnedIndex)
    return false
  }, [games, pinnedIndex, jumpTo])

  return (
    <>
      <FocusContext.Provider value={focusKey}>
        <div
          ref={viewportRef}
          className={cx(
            'library__viewport',
            direction === 1 && 'library__viewport--from-right',
            direction === -1 && 'library__viewport--from-left'
          )}
          style={{ '--library-cover-scale': coverScale } as CSSProperties}
        >
          <div ref={probeRef} className="library__probe" aria-hidden="true" />
          <div
            ref={ref}
            className="library__grid"
            role="list"
            aria-label={t('library.grid.label')}
            style={{ '--cols': columns } as CSSProperties}
          >
            {children}
          </div>
        </div>
        <SectionRail
          sections={sections}
          sort={sort}
          reversed={sortReversed}
          current={sectionIndexAt(sections, Math.min(topIndex, Math.max(0, count - 1)))}
          onJump={jumpTo}
          onWheel={(deltaY) => viewportRef.current?.scrollBy({ top: deltaY })}
        />
      </FocusContext.Provider>
      {/* Beside the grid's container, not in it: D-pad up / down there are the slider's, never a section jump. */}
      {onCoverScale ? (
        <CoverSizeSlider
          value={coverScale}
          onChange={onCoverScale}
          onRight={focusGridFromSlider}
          containerRef={sliderRef}
        />
      ) : null}
    </>
  )
})

interface SectionRailProps {
  sections: readonly LibrarySection[]
  sort: LibrarySort
  /** The sort is turned around: the A–Z rail reads Z..A, '#'. */
  reversed: boolean
  /** The section shown at the top of the viewport. */
  current: number
  onJump: (index: number) => void
  /** The rail sits beside the scroller, not in it: a wheel over it scrolls the grid. */
  onWheel: (deltaY: number) => void
}

/**
 * The scroll rail at the right edge of the grid: A–Z (and #) for the title sorts, the sections' short labels
 * (days, playtime bands) for the others. A click or tap jumps to that section; letters no game starts with are
 * dimmed. Not a focus stop: a controller jumps with the D-pad instead.
 */
const SectionRail = memo(function SectionRail({
  sections,
  sort,
  reversed,
  current,
  onJump,
  onWheel
}: SectionRailProps): ReactElement | null {
  const t = useT()
  // `current` picks the part of a playable-first list whose letters the title rail jumps to (railEntries).
  const entries = useMemo(
    () => railEntries(sections, sort, 27, reversed, current),
    [sections, sort, reversed, current]
  )
  const currentStart = sections[current]?.start ?? -1
  if (entries.length < 2) return null
  return (
    <nav
      className="library__rail"
      aria-label={t('library.grid.rail')}
      onWheel={(event) => onWheel(event.deltaY)}
    >
      {entries.map((entry, i) => (
        <button
          key={`${entry.label}:${i}`}
          type="button"
          tabIndex={-1}
          className={cx(
            'library__rail-entry',
            entry.target === null && 'library__rail-entry--empty',
            entry.target !== null && entry.target === currentStart && 'library__rail-entry--current'
          )}
          disabled={entry.target === null}
          onClick={() => {
            if (entry.target !== null) onJump(entry.target)
          }}
        >
          {entry.label}
        </button>
      ))}
    </nav>
  )
})

/**
 * Stands in for `rows` omitted grid rows: it spans that many implicit (card-height) tracks, so the tracks
 * and the gaps between them add up to exactly the omitted height (a fixed-height box on one track would not
 * grow the track and would overflow the rows below it).
 */
function Spacer({ rows }: { rows: number }): ReactElement {
  return (
    <div
      className="library__spacer"
      style={{ gridRow: `span ${rows}` }}
      data-omitted-rows={rows}
      aria-hidden="true"
    />
  )
}
