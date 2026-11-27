// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { StoreIcon } from './StoreIcon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function render(storeId: string): HTMLElement {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<StoreIcon storeId={storeId} />))
  return host
}

describe('StoreIcon', () => {
  it("shows the store's badge", () => {
    expect(render('steam').querySelector('.badge')?.getAttribute('aria-label')).toBe('Steam')
    expect(render('xbox').querySelector('.badge')?.getAttribute('aria-label')).toBe('Xbox')
  })

  it('shows the PC badge for Other', () => {
    expect(render('*other').querySelector('.badge')?.getAttribute('aria-label')).toBe('PC')
  })
})
