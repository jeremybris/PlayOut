// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { SizePie } from './SizePie'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(step: number): SVGElement {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<SizePie step={step} steps={7} />))
  return host.querySelector('svg.size-pie') as SVGElement
}

describe('SizePie', () => {
  it('fills one eighth per band, the largest almost full', () => {
    expect(render(1).dataset.fill).toBe('0.125')
    expect(render(4).dataset.fill).toBe('0.500')
    expect(render(7).dataset.fill).toBe('0.875')
  })

  it('starts every slice at the top', () => {
    for (let s = 1; s <= 7; s++) {
      expect(render(s).querySelector('path')?.getAttribute('d')).toMatch(/^M12 12 L12 2 A/)
    }
  })

  it('grows the whole pie with the band', () => {
    expect(render(1).style.width).toBe('calc(19.00 * var(--u))')
    expect(render(7).style.width).toBe('calc(38.00 * var(--u))')
  })
})
