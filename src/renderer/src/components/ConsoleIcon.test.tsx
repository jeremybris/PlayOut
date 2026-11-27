// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ConsoleIcon } from './ConsoleIcon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(systemId: string): HTMLElement {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<ConsoleIcon systemId={systemId} />))
  return host
}

describe('ConsoleIcon', () => {
  it("shows the system's console picture", () => {
    const host = render('snes')
    expect(host.querySelector('img.console-icon__img')).not.toBeNull()
    expect(host.querySelector('svg')).toBeNull()
  })

  it('shows a generic controller for a system without a picture', () => {
    const host = render('pc98')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('svg.console-icon__generic')).not.toBeNull()
  })
})
