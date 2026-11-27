// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Library's cover-size slider (left of the grid) and the grid following it: drag / tap snap to the steps, the
 * wheel and − / + change one step (dimmed at the ends), the D-pad changes it on the focused track without moving
 * focus, and the grid's columns follow the size, the same in every tab.
 */

const updateSettings = vi.fn()
vi.mock('../../api/client', () => ({
  api: { on: () => () => undefined, updateSettings: (patch: unknown) => updateSettings(patch) },
  isMock: false
}))

const { initFocus, setFocus, pressArrow, pressEnter, focusedKey } =
  await import('../../input/focus')
const { CoverSizeSlider } = await import('./CoverSizeSlider')
const { LibraryGrid } = await import('./LibraryGrid')
const { COVER_LARGER_KEY, COVER_SIZE_KEY, COVER_SMALLER_KEY } = await import('./keys')
const { useSettingsStore } = await import('../../state/settings')
const { defaultSettings } = await import('@shared/defaults')
const { COVER_SCALE_STEPS } = await import('@shared/cover-scale')

import type { Game, Settings } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

beforeEach(() => {
  vi.useFakeTimers()
  updateSettings.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
      for (let j = 0; j < 10; j++) await Promise.resolve()
    })
}

const onChange = vi.fn()

/** The slider with its value kept in state, as the settings store keeps it. */
function Harness({ start }: { start: number }): ReactElement {
  const [value, setValue] = useState(start)
  return (
    <CoverSizeSlider
      value={value}
      onChange={(next) => {
        onChange(next)
        setValue(next)
      }}
      onRight={() => true}
    />
  )
}

const slider = (): HTMLElement => host.querySelector<HTMLElement>('[role="slider"]')!
const rail = (): HTMLElement => host.querySelector<HTMLElement>('.library__cover-size-rail')!
const smaller = (): HTMLElement => host.querySelector<HTMLElement>('[aria-label="Smaller covers"]')!
const larger = (): HTMLElement => host.querySelector<HTMLElement>('[aria-label="Larger covers"]')!
const now = (): string | null => slider().getAttribute('aria-valuenow')

function mount(start: number): void {
  onChange.mockReset()
  act(() => root.render(<Harness key={start} start={start} />))
  // A 400px rail from y=100: step i sits at 100 + i * 50.
  rail().getBoundingClientRect = () =>
    ({ top: 100, bottom: 500, height: 400, left: 0, right: 20, width: 20 }) as DOMRect
}

function pointer(type: string, target: Element, clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY })
    )
  })
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('CoverSizeSlider', () => {
  it('is a vertical slider labelled with the size, today’s size at 100%', () => {
    mount(1)
    expect(slider().getAttribute('aria-orientation')).toBe('vertical')
    expect(slider().getAttribute('aria-valuemin')).toBe('60')
    expect(slider().getAttribute('aria-valuemax')).toBe('160')
    expect(now()).toBe('100')
    expect(slider().getAttribute('aria-valuetext')).toBe('Cover size 100%')
    // the diamond sits on the default step (index 4 of 9: halfway)
    const thumb = host.querySelector<HTMLElement>('.library__cover-size-thumb')!
    expect(thumb.style.top).toBe('50%')
  })

  it('snaps a drag to the nearest step while dragging and on release', () => {
    mount(1)
    pointer('pointerdown', slider(), 300) // step 4 (no change)
    pointer('pointermove', slider(), 160) // nearest step 1 (150)
    expect(now()).toBe('70')
    pointer('pointermove', slider(), 128) // nearer step 1 than 0
    expect(now()).toBe('70')
    pointer('pointerup', slider(), 95) // above the rail: the top end
    expect(now()).toBe('60')
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([0.7, 0.6])
    // released: moving no longer changes it
    pointer('pointermove', slider(), 480)
    expect(now()).toBe('60')
  })

  it('jumps to the step under a tap on the track', () => {
    mount(1)
    pointer('pointerdown', slider(), 490)
    pointer('pointerup', slider(), 490)
    expect(now()).toBe('160')
  })

  it('changes one step per wheel turn: down bigger, up smaller', () => {
    mount(1)
    const group = host.querySelector('.library__cover-size')!
    act(() => {
      group.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }))
    })
    expect(now()).toBe('115')
    // a burst of trackpad events right after counts once
    act(() => {
      group.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }))
    })
    expect(now()).toBe('115')
    act(() => vi.advanceTimersByTime(200))
    act(() => {
      group.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    })
    expect(now()).toBe('100')
  })

  it('steps with − and +, which are dimmed and do nothing at the ends', () => {
    mount(0.7)
    expect(smaller().getAttribute('aria-disabled')).toBeNull()
    click(smaller())
    expect(now()).toBe('60')
    expect(smaller().getAttribute('aria-disabled')).toBe('true')
    click(smaller())
    expect(now()).toBe('60')
    click(larger())
    expect(now()).toBe('70')

    mount(1.45)
    click(larger())
    expect(now()).toBe('160')
    expect(larger().getAttribute('aria-disabled')).toBe('true')
    click(larger())
    expect(now()).toBe('160')
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([1.6])
  })

  it('changes with D-pad up / down on the focused track without moving focus; A steps on − / +', async () => {
    mount(1)
    await act(async () => {
      setFocus(COVER_SIZE_KEY)
    })
    await settle()
    expect(focusedKey()).toBe(COVER_SIZE_KEY)
    expect(slider().getAttribute('data-focused')).toBe('true')
    act(() => {
      expect(pressArrow('down')).toBe(true)
    })
    expect(now()).toBe('115')
    act(() => {
      pressArrow('up')
      pressArrow('up')
    })
    expect(now()).toBe('90')
    // at the end up is still taken (focus does not leave for −)
    for (let i = 0; i < 6; i++) act(() => void pressArrow('up'))
    expect(now()).toBe('60')
    await settle()
    expect(focusedKey()).toBe(COVER_SIZE_KEY)

    await act(async () => {
      setFocus(COVER_LARGER_KEY)
    })
    await settle()
    act(() => pressEnter())
    expect(now()).toBe('70')
    await act(async () => {
      setFocus(COVER_SMALLER_KEY)
    })
    await settle()
    act(() => pressEnter())
    expect(now()).toBe('60')
  })

  it('D-pad up / down on the focused − or + change the size and keep the focus on the slider', async () => {
    mount(1)
    await act(async () => {
      setFocus(COVER_LARGER_KEY)
    })
    await settle()
    act(() => {
      expect(pressArrow('down')).toBe(true)
    })
    expect(now()).toBe('115')
    await settle()
    expect(focusedKey()).toBe(COVER_SIZE_KEY)
    act(() => void pressArrow('down'))
    expect(now()).toBe('130')
    await settle()
    expect(focusedKey()).toBe(COVER_SIZE_KEY)

    await act(async () => {
      setFocus(COVER_SMALLER_KEY)
    })
    await settle()
    act(() => void pressArrow('up'))
    expect(now()).toBe('115')
    await settle()
    expect(focusedKey()).toBe(COVER_SIZE_KEY)

    // at an end the press is still taken: focus stays on the slider
    mount(0.6)
    await act(async () => {
      setFocus(COVER_SMALLER_KEY)
    })
    await settle()
    act(() => void pressArrow('up'))
    expect(now()).toBe('60')
    await settle()
    expect(focusedKey()).toBe(COVER_SIZE_KEY)
  })
})

// ---- the grid follows the size ---------------------------------------------------------------------------------

function game(i: number): Game {
  return {
    id: `manual:g${i}`,
    source: 'manual',
    externalId: `g${i}`,
    platformId: 'pc',
    title: `Game ${i}`,
    sortTitle: `game ${i}`,
    installed: true,
    launch: { kind: 'exe', path: 'C:/g.exe' },
    tracking: { mode: 'spawned' },
    hidden: false,
    favorite: false,
    addedAt: '2026-11-01T00:00:00.000Z',
    metadataStatus: 'done',
    metadata: {},
    media: {},
    user: {}
  } as unknown as Game
}
const GAMES = Array.from({ length: 40 }, (_, i) => game(i))

/** Library's wiring: the size comes from settings (one value for every tab), the slider saves it there. */
function GridHarness({ tab }: { tab: string }): ReactElement {
  const coverScale = useSettingsStore((s) => s.settings?.ui.libraryCoverScale ?? 1)
  return (
    <LibraryGrid
      key={tab}
      games={GAMES}
      platformsById={new Map()}
      initialGameId={null}
      autoFocus={false}
      direction={0}
      onOpen={() => undefined}
      onCardFocus={() => undefined}
      onEmpty={() => undefined}
      copies={new Map()}
      sections={[]}
      sort="title-asc"
      sortReversed={false}
      active
      coverScale={coverScale}
      onCoverScale={(scale) =>
        void useSettingsStore.getState().update({ ui: { libraryCoverScale: scale } })
      }
    />
  )
}

describe('LibraryGrid cover size', () => {
  const saved: [object, string, PropertyDescriptor | undefined][] = []
  function stub(proto: object, name: string, get: (this: HTMLElement) => number): void {
    saved.push([proto, name, Object.getOwnPropertyDescriptor(proto, name)])
    Object.defineProperty(proto, name, { configurable: true, get })
  }
  const scaleOf = (el: HTMLElement): number =>
    parseFloat(
      el
        .closest<HTMLElement>('.library__viewport')
        ?.style.getPropertyValue('--library-cover-scale') || '1'
    )

  beforeEach(() => {
    // A 1620px-wide viewport (1920 minus the side insets); the probe is a 240x360 card times the size.
    stub(HTMLElement.prototype, 'offsetWidth', function () {
      return this.classList.contains('library__probe') ? 240 * scaleOf(this) : 0
    })
    stub(HTMLElement.prototype, 'offsetHeight', function () {
      return this.classList.contains('library__probe') ? 360 * scaleOf(this) : 0
    })
    stub(Element.prototype, 'clientWidth', function () {
      return this.classList.contains('library__viewport') ? 1620 : 0
    })
    stub(Element.prototype, 'clientHeight', function () {
      return this.classList.contains('library__viewport') ? 900 : 0
    })
    updateSettings.mockImplementation(async (patch: { ui: Partial<Settings['ui']> }) => {
      const current = useSettingsStore.getState().settings!
      return { ...current, ui: { ...current.ui, ...patch.ui } }
    })
  })
  afterEach(() => {
    for (const [proto, name, descriptor] of saved.splice(0).reverse()) {
      if (descriptor) Object.defineProperty(proto, name, descriptor)
      else delete (proto as Record<string, unknown>)[name]
    }
  })

  const cols = (): string =>
    host.querySelector<HTMLElement>('.library__grid')!.style.getPropertyValue('--cols')
  const viewportScale = (): string =>
    host
      .querySelector<HTMLElement>('.library__viewport')!
      .style.getPropertyValue('--library-cover-scale')

  it('uses today’s size by default and more or fewer columns as the slider changes it, in every tab', async () => {
    useSettingsStore.setState({ settings: defaultSettings() })
    act(() => root.render(<GridHarness tab="a" />))
    await settle()
    expect(viewportScale()).toBe('1')
    expect(cols()).toBe('6')

    // − four times: 60%, ten 144px columns fit (capped at ten)
    const minus = host.querySelector<HTMLElement>('[aria-label="Smaller covers"]')!
    for (let i = 0; i < 4; i++) click(minus)
    await settle()
    expect(useSettingsStore.getState().settings!.ui.libraryCoverScale).toBe(0.6)
    expect(updateSettings).toHaveBeenLastCalledWith({ ui: { libraryCoverScale: 0.6 } })
    expect(viewportScale()).toBe('0.6')
    expect(cols()).toBe('10')

    // another tab shows the same size
    act(() => root.render(<GridHarness tab="b" />))
    await settle()
    expect(viewportScale()).toBe('0.6')
    expect(cols()).toBe('10')

    // the biggest step: four 384px columns
    act(() =>
      useSettingsStore.setState({
        settings: {
          ...useSettingsStore.getState().settings!,
          ui: {
            ...useSettingsStore.getState().settings!.ui,
            libraryCoverScale: COVER_SCALE_STEPS[8]
          }
        }
      })
    )
    await settle()
    expect(viewportScale()).toBe('1.6')
    expect(cols()).toBe('4')
  })
})
