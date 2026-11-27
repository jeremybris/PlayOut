import { memo, useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { FocusContext, useFocusable } from '../input/focus'
import { cx } from '../lib/cx'
import { rowFocusKey } from '../lib/focusKeys'
import { useSettingsStore } from '../state/settings'
import { useUiStore } from '../state/ui'
import { RowTrackContext } from './rowTrack'

export interface RowProps {
  /** Row id ('recent', 'platform:steam', ...); also the rowId GameCards in it should use. */
  id: string
  title?: string
  /** Small element left of the title (a PlatformBadge size="sm"). */
  badge?: ReactNode
  /** Count shown after the title ('12 games'). */
  count?: string
  /** Cards (or any focusables). */
  children: ReactNode
  /** Called when focus enters the row (from another row or screen). */
  onFocusEnter?: () => void
  /**
   * When focus enters the row, scroll the page so the row header sits at the scroll container's
   * scroll-padding-top (the 150u anchor on Home). Default false: cards only scroll themselves into view.
   */
  anchor?: boolean
  /** No card track height: for rows of buttons/chips. */
  compact?: boolean
  className?: string
}

/**
 * Horizontal scroll row: header (badge, title, count) and a native overflow-x track (swipe/trackpad scroll
 * works, scrollbar hidden). A Norigin container that remembers its last focused child, so moving back
 * into the row restores the card that was focused before. Horizontal wheel / Shift+wheel pans the row;
 * plain vertical wheel is left to the page. The track is published through RowTrackContext so WindowedCards
 * can observe it. Memoised: with a stable onFocusEnter and memoised parents a focus change never reaches it.
 */
export const Row = memo(function Row({
  id,
  title,
  badge,
  count,
  children,
  onFocusEnter,
  anchor,
  compact,
  className
}: RowProps): ReactElement {
  const { ref, focusKey, hasFocusedChild } = useFocusable<object, HTMLDivElement>({
    focusKey: rowFocusKey(id),
    trackChildren: true,
    saveLastFocusedChild: true
  })
  const trackRef = useRef<HTMLDivElement | null>(null)

  const latestEnter = useRef(onFocusEnter)
  useEffect(() => {
    latestEnter.current = onFocusEnter
  })
  useEffect(() => {
    if (!hasFocusedChild) return
    latestEnter.current?.()
    if (!anchor) return
    const method = useUiStore.getState().inputMethod
    if (method === 'mouse' || method === 'touch') return
    const animations = useSettingsStore.getState().settings?.ui.animations ?? true
    ref.current?.scrollIntoView({
      block: 'start',
      inline: 'nearest',
      behavior: animations ? 'smooth' : 'auto'
    })
  }, [hasFocusedChild, anchor, ref])

  useEffect(() => {
    const track = trackRef.current
    if (!track) return undefined
    // React registers wheel listeners as passive, so a native listener is needed to preventDefault.
    const onWheel = (event: WheelEvent): void => {
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (!horizontal) return
      const delta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
      if (delta === 0) return
      event.preventDefault()
      track.scrollBy({ left: delta * 1.5, behavior: 'auto' })
    }
    track.addEventListener('wheel', onWheel, { passive: false })
    return () => track.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <FocusContext.Provider value={focusKey}>
      <section
        ref={ref}
        className={cx('row', compact && 'row--compact', className)}
        data-row-id={id}
        data-focused={hasFocusedChild ? 'true' : undefined}
        aria-label={title}
      >
        {title !== undefined || badge ? (
          <header className="row__header">
            {badge ? <span className="row__badge">{badge}</span> : null}
            {title !== undefined ? <h2 className="row__title">{title}</h2> : null}
            {count ? <span className="row__count">{count}</span> : null}
          </header>
        ) : null}
        <div ref={trackRef} className="row__track">
          <RowTrackContext.Provider value={trackRef}>{children}</RowTrackContext.Provider>
        </div>
      </section>
    </FocusContext.Provider>
  )
})
