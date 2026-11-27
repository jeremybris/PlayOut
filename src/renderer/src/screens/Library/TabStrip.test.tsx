// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Library's tab strip when its tabs do not fit: the scroll bar shows only then, its pill follows the scroll and is
 * sized by the visible share, the strip drags with the mouse or a finger (a click still selects a tab), the wheel and
 * the right stick scroll it, and LB / RB's new tab scrolls into view.
 */

vi.mock('../../api/client', () => ({
  api: { on: () => () => undefined, updateSettings: () => undefined },
  isMock: false
}))

const { initFocus } = await import('../../input/focus')
const { dispatchStickX } = await import('../../input/stickScrollX')
const { TabStrip } = await import('./TabStrip')

import type { LibraryTab } from '../../lib/libraryView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The fake layout: the strip's box, its content and the bar's track, in pixels. */
const layout = { viewport: 500, content: 2000, track: 400, trackHeight: 8 }
const FADE = 24
const TAB_W = 200
const TAB_PITCH = 300
const scrollLefts = new WeakMap<Element, number>()

const has = (el: Element, name: string): boolean => el.classList.contains(name)

const descriptors: Array<[keyof HTMLElement, PropertyDescriptor | undefined]> = []
function fake(name: keyof HTMLElement, descriptor: PropertyDescriptor): void {
  descriptors.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor })
}

let scrollIntoView: ReturnType<typeof vi.fn>

beforeAll(() => {
  initFocus()
  fake('clientWidth', {
    get(this: HTMLElement) {
      if (has(this, 'library__tabs')) return layout.viewport
      if (has(this, 'library__tabs-scrollbar')) return layout.track
      return 0
    }
  })
  fake('clientHeight', {
    get(this: HTMLElement) {
      return has(this, 'library__tabs-scrollbar') ? layout.trackHeight : 0
    }
  })
  fake('scrollWidth', {
    get(this: HTMLElement) {
      return has(this, 'library__tabs') ? Math.max(layout.content, layout.viewport) : 0
    }
  })
  fake('offsetWidth', {
    get(this: HTMLElement) {
      if (has(this, 'library__tabs-strip')) return layout.content
      return this.dataset.tabId ? TAB_W : 0
    }
  })
  // Tab n starts at the strip's 24px side padding (the fade) plus n tab pitches.
  fake('offsetLeft', {
    get(this: HTMLElement) {
      const id = this.dataset.tabId
      return id ? FADE + Number(id.slice(1)) * TAB_PITCH : 0
    }
  })
  const style = document.createElement('style')
  style.textContent = `.library__tabs-strip { padding-left: ${FADE}px; }`
  document.head.appendChild(style)
  fake('scrollLeft', {
    get(this: HTMLElement) {
      return scrollLefts.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, layout.content - layout.viewport)
      // Snapped to whole pixels, as Chromium does.
      scrollLefts.set(this, Math.round(Math.min(max, Math.max(0, value))))
      this.dispatchEvent(new Event('scroll'))
    }
  })
  ;(HTMLElement.prototype as { scrollTo?: unknown }).scrollTo = function (
    this: HTMLElement,
    options: ScrollToOptions
  ) {
    this.scrollLeft = options.left ?? 0
  }
})

afterAll(() => {
  for (const [name, descriptor] of descriptors.reverse()) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
})

let host: HTMLDivElement
let root: Root
const onSelect = vi.fn()

beforeEach(() => {
  layout.viewport = 500
  layout.content = 2000
  onSelect.mockReset()
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const TABS: LibraryTab[] = ['All Games', 'Steam', 'Epic', 'G.O.G', 'EA App', 'Battle.Net'].map(
  (label, i) => ({ id: `t${i}`, label })
)

function Strip({
  active = 't0',
  shown = true
}: {
  active?: string
  shown?: boolean
}): ReactElement {
  return (
    <TabStrip
      tabs={TABS}
      active={active}
      onSelect={onSelect}
      onUp={() => true}
      onAdd={() => undefined}
      shown={shown}
    />
  )
}

function mount(props: { active?: string; shown?: boolean } = {}): void {
  act(() => root.render(<Strip {...props} />))
}

const viewport = (): HTMLElement => host.querySelector<HTMLElement>('.library__tabs')!
const bar = (): HTMLElement | null => host.querySelector<HTMLElement>('.library__tabs-scrollbar')
const thumb = (): HTMLElement => host.querySelector<HTMLElement>('.library__tabs-scrollbar-thumb')!
const tab = (label: string): HTMLElement =>
  [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent === label)!

function resize(): void {
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

/** A mouse pointer event; the left button is held during a down / move unless `buttons` says otherwise. */
function pointer(
  type: string,
  target: EventTarget,
  clientX: number,
  clientY = 10,
  buttons = type === 'pointerup' || type === 'pointercancel' ? 0 : 1
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons,
    clientX,
    clientY
  })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  act(() => {
    target.dispatchEvent(event)
  })
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('TabStrip scroll bar', () => {
  it('shows the bar only while the tabs do not fit, following resizes', () => {
    layout.content = 480
    mount()
    expect(bar()).toBeNull()
    expect(host.querySelector('.library__tabs-group--scrolls')).toBeNull()

    layout.content = 2000
    resize()
    expect(bar()).not.toBeNull()
    expect(bar()!.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('.library__tabs-group--scrolls')).not.toBeNull()

    // Wider window: everything fits again, the bar goes.
    layout.viewport = 2100
    resize()
    expect(bar()).toBeNull()
  })

  it('sizes the pill by the visible share and moves it with the scroll', () => {
    mount()
    // 500 of 2000 visible on a 400px track: a 100px pill.
    expect(thumb().style.width).toBe('100px')
    expect(thumb().style.transform).toBe('translateX(0px)')
    act(() => {
      viewport().scrollLeft = 750
    })
    expect(thumb().style.transform).toBe('translateX(150px)')
    // More tabs (a longer strip): a shorter pill.
    layout.content = 4000
    resize()
    expect(thumb().style.width).toBe('50px')
  })

  it('drags the strip past a small threshold, and the release selects no tab', () => {
    mount()
    const steam = tab('Steam')
    pointer('pointerdown', steam, 300)
    pointer('pointermove', steam, 296)
    expect(viewport().scrollLeft).toBe(0)
    pointer('pointermove', steam, 240)
    expect(viewport().scrollLeft).toBe(60)
    expect(viewport().classList.contains('library__tabs--dragging')).toBe(true)
    pointer('pointerup', steam, 240)
    click(steam)
    expect(onSelect).not.toHaveBeenCalled()
    expect(viewport().classList.contains('library__tabs--dragging')).toBe(false)
  })

  it('still selects a tab on a plain click or a tiny wobble', () => {
    mount()
    const epic = tab('Epic')
    pointer('pointerdown', epic, 300)
    pointer('pointermove', epic, 303)
    pointer('pointerup', epic, 303)
    click(epic)
    expect(onSelect).toHaveBeenCalledWith('t2')
    expect(viewport().scrollLeft).toBe(0)
  })

  it('scrolls sideways with the wheel (a vertical wheel too), keeping it from the Library behind', () => {
    mount()
    const behind = vi.fn()
    host.addEventListener('wheel', behind)
    const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    act(() => {
      viewport().dispatchEvent(event)
    })
    expect(viewport().scrollLeft).toBe(120)
    expect(event.defaultPrevented).toBe(true)
    expect(behind).not.toHaveBeenCalled()
    host.removeEventListener('wheel', behind)
  })

  it('leaves the wheel alone when the tabs fit', () => {
    layout.content = 400
    mount()
    const behind = vi.fn()
    host.addEventListener('wheel', behind)
    const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })
    act(() => {
      viewport().dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    expect(behind).toHaveBeenCalledTimes(1)
    host.removeEventListener('wheel', behind)
  })

  it('scrolls with the right stick while the Library is shown and the tabs do not fit', () => {
    mount()
    let handled = false
    act(() => {
      handled = dispatchStickX(1, 16)
    })
    expect(handled).toBe(true)
    expect(viewport().scrollLeft).toBeGreaterThan(0)
    const after = viewport().scrollLeft
    act(() => {
      handled = dispatchStickX(-1, 16)
    })
    expect(viewport().scrollLeft).toBeLessThan(after)

    // Not shown (a modal over it, leaving): the stick is not the strip's.
    mount({ shown: false })
    expect(dispatchStickX(1, 16)).toBe(false)

    // Everything fits: nothing to scroll.
    layout.content = 400
    mount({ shown: true })
    resize()
    expect(dispatchStickX(1, 16)).toBe(false)
  })

  it('drags the pill and pages from the track', () => {
    mount()
    // The pill (100px on a 400px track) dragged 150px: 150 / 300 of the 1500px scroll range.
    pointer('pointerdown', thumb(), 50)
    pointer('pointermove', thumb(), 200)
    expect(viewport().scrollLeft).toBe(750)
    pointer('pointerup', thumb(), 200)

    // A press on the track left of the pill pages back by 0.8 of the visible width.
    bar()!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 8, right: 400, bottom: 8 }) as DOMRect
    pointer('pointerdown', bar()!, 10)
    expect(viewport().scrollLeft).toBe(750 - 400)
  })

  it('scrolls the tab LB / RB moves to fully into view, clear of the faded ends', () => {
    mount({ active: 't0' })
    expect(viewport().scrollLeft).toBe(0)
    mount({ active: 't5' })
    // Battle.Net: 1524..1724; the visible area less the 24px fades must hold it whole.
    const left = viewport().scrollLeft
    expect(left).toBe(1724 + FADE - 500)
    expect(1524).toBeGreaterThanOrEqual(left + FADE)
    expect(1724).toBeLessThanOrEqual(left + 500 - FADE)
    // Back to the first tab: it lands past the left fade (scrollLeft 0, the strip's own padding).
    mount({ active: 't0' })
    expect(viewport().scrollLeft).toBe(0)
  })

  it('scrolls with the wheel over the scroll bar too, keeping it from the Library behind', () => {
    mount()
    const behind = vi.fn()
    host.addEventListener('wheel', behind)
    for (const target of [bar()!, thumb()]) {
      const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
      act(() => {
        target.dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(true)
    }
    expect(viewport().scrollLeft).toBe(200)
    // A wheel up over the bar scrolls back, and never reaches the Library's wheel-up-returns-Home.
    const up = new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true })
    act(() => {
      bar()!.dispatchEvent(up)
    })
    expect(viewport().scrollLeft).toBe(0)
    expect(behind).not.toHaveBeenCalled()
    host.removeEventListener('wheel', behind)
  })

  it('forgets a press released off the strip: a later hover with no button neither drags nor blocks clicks', () => {
    mount()
    const steam = tab('Steam')
    pointer('pointerdown', steam, 300)
    pointer('pointermove', steam, 303, 60)
    // Released over the grid / outside the window: the strip never sees this pointerup.
    pointer('pointerup', window, 303, 400)
    pointer('pointermove', steam, 200, 10, 0)
    expect(viewport().scrollLeft).toBe(0)
    expect(viewport().classList.contains('library__tabs--dragging')).toBe(false)
    click(steam)
    expect(onSelect).toHaveBeenCalledWith('t1')
  })

  it('ends a pending press when a mouse moves with no button held, even without a pointerup', () => {
    mount()
    const epic = tab('Epic')
    pointer('pointerdown', epic, 300)
    pointer('pointermove', epic, 150, 10, 0)
    pointer('pointermove', epic, 100, 10, 1)
    expect(viewport().scrollLeft).toBe(0)
    expect(viewport().classList.contains('library__tabs--dragging')).toBe(false)
  })

  it('clears the drag on pointercancel (the browser took the touch over), and the next tap selects', () => {
    mount()
    const steam = tab('Steam')
    pointer('pointerdown', steam, 300)
    pointer('pointermove', steam, 250)
    expect(viewport().classList.contains('library__tabs--dragging')).toBe(true)
    pointer('pointercancel', steam, 250)
    expect(viewport().classList.contains('library__tabs--dragging')).toBe(false)
    pointer('pointerdown', steam, 250)
    pointer('pointerup', steam, 250)
    click(steam)
    expect(onSelect).toHaveBeenCalledWith('t1')
  })

  it('a drag that starts on + scrolls and does not add a tab', () => {
    const onAdd = vi.fn()
    act(() =>
      root.render(
        <TabStrip tabs={TABS} active="t0" onSelect={onSelect} onUp={() => true} onAdd={onAdd} />
      )
    )
    const add = host.querySelector<HTMLElement>('.library__tab--add')!
    pointer('pointerdown', add, 300)
    pointer('pointermove', add, 200)
    pointer('pointerup', add, 200)
    click(add)
    expect(viewport().scrollLeft).toBe(100)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('adds up a light right-stick push instead of losing it to pixel snapping', () => {
    mount()
    // 0.1 deflection over 16ms is about 0.22px a frame: whole pixels must still come through, both ways.
    for (let i = 0; i < 20; i++) dispatchStickX(0.1, 16)
    const right = viewport().scrollLeft
    expect(right).toBeGreaterThanOrEqual(4)
    for (let i = 0; i < 20; i++) dispatchStickX(-0.1, 16)
    expect(viewport().scrollLeft).toBeLessThanOrEqual(right - 3)
  })
})
