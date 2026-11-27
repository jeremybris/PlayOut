import { type RefObject, useLayoutEffect, useState } from 'react'
import { fitPlan, type FitItem, type FitMeasure, type FitPlan } from '../lib/statFit'

/** A child that may be left out when its row is too narrow: `fit-drop-1` goes first, then 2 and so on. */
const DROP_RE = /\bfit-drop-(\d+)\b/
/** On the row while it is measured: every child shown at its natural width (styles.css). */
const MEASURING = 'fit-measuring'
/** On the row when it is compact: tighter gaps, and each child's `fit-short` form instead of its `fit-full` one. */
export const COMPACT = 'fit-compact'

/**
 * For a flex row whose children marked `fit-drop-<rank>` may be left out (lowest rank first) when the row is too
 * narrow: how it fits (statFit.ts fitPlan): the rank at or below which they must be left out (0: none), and whether
 * the row is compact (`fit-compact`: its children's shorter forms, measured too). Measured from the real widths
 * whenever the row is resized, the fonts load or `contentKey` (what the children show) changes. The caller hides the
 * dropped children with the `fit-dropped` class and puts `fit-compact` on the row when `compact`.
 */
export function useDropToFit(ref: RefObject<HTMLElement | null>, contentKey: string): FitPlan {
  const [plan, setPlan] = useState<FitPlan>({ upTo: 0, compact: false })
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return
    const collect = (): FitMeasure => {
      // Layout units: the game page opens with a scale(0.97) animation, and an element's rect is scaled with it while
      // clientWidth is not.
      const scale = row.offsetWidth > 0 ? row.getBoundingClientRect().width / row.offsetWidth : 1
      const items: FitItem[] = []
      for (const child of Array.from(row.children)) {
        const style = getComputedStyle(child)
        const width =
          child.getBoundingClientRect().width / (scale || 1) +
          (Number.parseFloat(style.marginLeft) || 0) +
          (Number.parseFloat(style.marginRight) || 0)
        const rank = DROP_RE.exec(child.className)
        items.push(rank ? { width, drop: Number(rank[1]) } : { width })
      }
      return { items, gap: Number.parseFloat(getComputedStyle(row).columnGap) || 0 }
    }
    const measure = (): void => {
      // Within one task, so the forced layouts are never painted; the row's own compact class is put back after.
      const wasCompact = row.classList.contains(COMPACT)
      row.classList.add(MEASURING)
      row.classList.remove(COMPACT)
      const normal = collect()
      row.classList.add(COMPACT)
      const compact = collect()
      if (!wasCompact) row.classList.remove(COMPACT)
      const rowStyle = getComputedStyle(row)
      const available =
        row.clientWidth -
        (Number.parseFloat(rowStyle.paddingLeft) || 0) -
        (Number.parseFloat(rowStyle.paddingRight) || 0)
      row.classList.remove(MEASURING)
      const next = fitPlan(normal, compact, available)
      setPlan((p) => (p.upTo === next.upTo && p.compact === next.compact ? p : next))
    }
    measure()
    let live = true
    void document.fonts?.ready.then(() => {
      if (live) measure()
    })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(row)
    return () => {
      live = false
      observer?.disconnect()
    }
  }, [ref, contentKey])
  return plan
}

/** The classes of a child of a `useDropToFit` row: its rank, and `fit-dropped` while it is left out. */
export function dropClass(rank: number, upTo: number): string {
  return rank <= upTo ? `fit-drop-${rank} fit-dropped` : `fit-drop-${rank}`
}
