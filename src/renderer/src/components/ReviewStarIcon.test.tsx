// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { STAR_INNER, starVisibleFillBelow } from '../lib/bandIcon'
import { ReviewStarIcon } from './ReviewStarIcon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderAll(steps: number[]): SVGElement[] {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() =>
    root.render(
      <>
        {steps.map((s, i) => (
          <ReviewStarIcon key={i} step={s} steps={9} />
        ))}
      </>
    )
  )
  return [...host.querySelectorAll<SVGElement>('svg.review-star')]
}

describe('ReviewStarIcon', () => {
  it('fills one ninth per band from the bottom, the best band full and the lowest a sliver', () => {
    const stars = renderAll([9, 5, 1])
    expect(stars.map((s) => s.dataset.fill)).toEqual([
      '1.000',
      (5 / 9).toFixed(3),
      (1 / 9).toFixed(3)
    ])
    const rect = (s: SVGElement): { y: number; h: number } => {
      const r = s.querySelector('clipPath > rect')!
      return { y: Number(r.getAttribute('y')), h: Number(r.getAttribute('height')) }
    }
    // The best band's clip covers the whole box.
    expect(rect(stars[0]!).y).toBe(0)
    expect(rect(stars[0]!).h).toBe(24)
    // Every clip runs to the box's bottom: the fill rises from the feet.
    for (const s of stars) expect(rect(s).y + rect(s).h).toBeCloseTo(24, 1)
    // The lower bands' clips fall inside the star's visible inside (inside the outline), not its outer tips, and fill
    // that inside by their share: 5/9 and a visible 1/9 sliver.
    const ys = STAR_INNER.map((p) => p[1])
    const innerTop = Math.min(...ys)
    const innerBottom = Math.max(...ys)
    for (const s of stars.slice(1)) {
      expect(rect(s).y).toBeGreaterThan(innerTop)
      expect(rect(s).y).toBeLessThan(innerBottom)
    }
    expect(starVisibleFillBelow(rect(stars[1]!).y)).toBeCloseTo(5 / 9, 2)
    expect(starVisibleFillBelow(rect(stars[2]!).y)).toBeCloseTo(1 / 9, 2)
  })

  it('always draws the outline, at one size for every band, hidden from screen readers', () => {
    const stars = renderAll([9, 1])
    for (const s of stars) {
      const outline = s.querySelector('path[stroke="currentColor"][fill="none"]')
      expect(outline).not.toBeNull()
      expect(outline!.getAttribute('stroke-opacity')).toBe('0.45')
      expect(s.closest('span.console-icon')!.getAttribute('aria-hidden')).toBe('true')
      expect(s.getAttribute('style')).toBeNull()
    }
  })

  it('gives every star a clip of its own', () => {
    const stars = renderAll([3, 3, 3, 7])
    const ids = stars.map((s) => s.querySelector('clipPath')!.id)
    expect(new Set(ids).size).toBe(4)
    for (const [i, s] of stars.entries())
      expect(s.querySelector('path[clip-path]')!.getAttribute('clip-path')).toBe(`url(#${ids[i]})`)
  })
})
