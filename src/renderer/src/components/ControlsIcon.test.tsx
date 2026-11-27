// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { CONTROLS_FILTERS } from '../lib/controls'
import { ControlsIcon } from './ControlsIcon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(id: string): HTMLElement {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<ControlsIcon controlsId={id} />))
  return host
}

describe('ControlsIcon', () => {
  it('has a picture for every Controls choice', () => {
    for (const c of CONTROLS_FILTERS) {
      expect(
        render(c.id).querySelector(`svg.controls-icon[data-controls="${c.id}"]`),
        c.id
      ).not.toBeNull()
    }
  })

  it('shows nothing for an unknown id', () => {
    expect(render('nope').innerHTML).toBe('')
  })
})
