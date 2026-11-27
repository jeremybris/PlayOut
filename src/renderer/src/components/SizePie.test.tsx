// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { sizeColor } from '../lib/bandIcon'
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

describe('Filters > Size colours', () => {
  const hue = (hsl: string): number => Number(/^hsl\((\d+) /.exec(hsl)![1])

  it('goes from blue (0-1 GB) through yellow to red (100+ GB)', () => {
    const hues = [1, 2, 3, 4, 5, 6, 7].map((step) => hue(sizeColor(step, 7)))
    expect(hues[0]).toBe(215) // blue
    expect(hues[3]).toBe(50) // yellow in the middle
    expect(hues[6]).toBe(0) // red
    for (let i = 1; i < hues.length; i++) expect(hues[i]!).toBeLessThan(hues[i - 1]!)
  })

  it('colours a pie only when asked (the Sort menu keeps the text colour)', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() =>
      root.render(
        <>
          <SizePie step={7} steps={7} colored />
          <SizePie step={7} steps={7} />
        </>
      )
    )
    const [colored, plain] = [...host.querySelectorAll('svg')]
    expect(colored!.style.color).not.toBe('')
    expect(plain!.style.color).toBe('')
    act(() => root.unmount())
  })
})
