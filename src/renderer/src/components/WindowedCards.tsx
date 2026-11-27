import {
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
import { updateAllLayouts } from '../input/focus'
import { cardWindow, sameSegments, type Segment } from '../lib/windowing'
import { useRowTrack } from './rowTrack'

/** Cards rendered beyond each edge of the visible track (design 6.9). */
const OVERSCAN = 6
/** Cards mounted before the track could be measured (first paint). */
const INITIAL_COUNT = 16

export interface WindowedCardsProps<T> {
  items: T[]
  itemKey: (item: T) => string
  /** Must return a keyed element (a GameCard). */
  render: (item: T, index: number) => ReactNode
  /**
   * Keys of items that stay mounted whatever is visible: the row's focused / last focused card, which
   * Norigin's saveLastFocusedChild, Home's focus restore and the LB/RB row steps rely on.
   */
  pinnedKeys?: readonly (string | null | undefined)[]
}

/**
 * Renders only the cards near the visible part of the enclosing Row's track (plus OVERSCAN on each side and
 * around every pinned card); the omitted runs are replaced by spacers of the exact width, so scrollWidth,
 * scrollIntoView, the track's ::after inset and wheel panning behave as if every card were mounted.
 * Must be rendered directly inside a Row (it reads the track through RowTrackContext).
 */
export function WindowedCards<T>({
  items,
  itemKey,
  render,
  pinnedKeys
}: WindowedCardsProps<T>): ReactElement {
  const trackRef = useRowTrack()
  const count = items.length
  const [segments, setSegments] = useState<Segment[]>(() => [
    { start: 0, end: Math.min(count, INITIAL_COUNT) }
  ])

  const pinnedIndices = useMemo(() => {
    if (!pinnedKeys || pinnedKeys.length === 0) return []
    const wanted = new Set(pinnedKeys.filter((key): key is string => typeof key === 'string'))
    const out: number[] = []
    if (wanted.size === 0) return out
    for (let i = 0; i < items.length && out.length < wanted.size; i++) {
      if (wanted.has(itemKey(items[i]!))) out.push(i)
    }
    return out
  }, [items, itemKey, pinnedKeys])

  const latest = useRef({ count, pinnedIndices })
  useLayoutEffect(() => {
    latest.current = { count, pinnedIndices }
  })

  const measure = useCallback(() => {
    const track = trackRef?.current
    if (!track) return
    const style = getComputedStyle(track)
    const card = track.querySelector<HTMLElement>('.card')
    const gap = parseFloat(style.columnGap) || 0
    const stride = card ? card.offsetWidth + gap : 0
    const next = cardWindow({
      count: latest.current.count,
      pinned: latest.current.pinnedIndices,
      scrollLeft: track.scrollLeft,
      clientWidth: track.clientWidth,
      paddingLeft: parseFloat(style.paddingLeft) || 0,
      stride,
      overscan: OVERSCAN
    })
    setSegments((previous) => (sameSegments(previous, next) ? previous : next))
  }, [trackRef])

  // Re-measure when the list or the pinned cards change (after `latest` was updated above).
  useLayoutEffect(() => {
    measure()
  }, [measure, count, pinnedIndices])

  useEffect(() => {
    const track = trackRef?.current
    if (!track) return undefined
    track.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(track)
    return () => {
      track.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [trackRef, measure])

  // The set of mounted focusables changed: refresh Norigin's spatial layout.
  useEffect(() => {
    updateAllLayouts()
  }, [segments])

  const children: ReactNode[] = []
  let cursor = 0
  for (const segment of segments) {
    const start = Math.min(segment.start, count)
    const end = Math.min(segment.end, count)
    if (start > cursor) children.push(<Spacer key={`spacer:${cursor}`} count={start - cursor} />)
    for (let i = Math.max(start, cursor); i < end; i++) children.push(render(items[i]!, i))
    cursor = Math.max(cursor, end)
  }
  if (cursor < count) children.push(<Spacer key={`spacer:${cursor}`} count={count - cursor} />)
  return <>{children}</>
}

/** The width of `count` omitted cards and their gaps (the flex gap after the spacer stands in for the last one). */
function Spacer({ count }: { count: number }): ReactElement {
  return (
    <div
      className="row__spacer"
      style={{ '--n': count } as CSSProperties}
      data-omitted={count}
      aria-hidden="true"
    />
  )
}
