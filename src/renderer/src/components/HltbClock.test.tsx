// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { HltbClock } from './HltbClock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(step: number): SVGElement {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<HltbClock step={step} steps={6} />))
  return host.querySelector('svg.hltb-clock') as SVGElement
}

describe('HltbClock', () => {
  it('fills one seventh per band, the longest almost full', () => {
    expect(render(1).dataset.fill).toBe('0.143')
    expect(render(6).dataset.fill).toBe('0.857')
  })

  it('starts every slice at the top of the dial', () => {
    for (let s = 1; s <= 6; s++) {
      expect(render(s).querySelector('path')?.getAttribute('d')).toMatch(/^M12 13\.6 L12 6\.6 A/)
    }
  })

  it('has the twelve marks and grows with the band', () => {
    expect(render(1).querySelectorAll('circle').length).toBe(2 + 12 + 1)
    expect(render(1).style.width).toBe('calc(19.00 * var(--u))')
    expect(render(6).style.width).toBe('calc(38.00 * var(--u))')
  })
})
