import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LightgunIcon } from './ControlsIcon'

/** The light gun picture: thin strokes in the filter menu (like the touch hand), lucide's 2px on the page's badge. */
describe('LightgunIcon', () => {
  const widths = (html: string): string[] =>
    [...html.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => m[1]!)

  it("draws the badge with the lucide icons' 2px body stroke", () => {
    const html = renderToStaticMarkup(<LightgunIcon className="gdetail__players-icon" bold />)
    expect(html).toContain('gdetail__players-icon')
    expect(widths(html)).toEqual(['2', '1.8', '1.8'])
  })

  it('keeps the thinner strokes in the filter menu', () => {
    expect(widths(renderToStaticMarkup(<LightgunIcon />))).toEqual(['1.5', '1.3', '1.3'])
  })
})
