// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureGridProps } from './FeatureGrid'

/**
 * The four-square grid right of Play: Recompilation, Upgrade, Co-Op and PeerParty in that order, an empty square for a
 * feature the game does not have, no grid at all for a game with none, and the Upgrade menu anchored to the grid.
 */

vi.mock('../../api/client', () => ({
  api: { on: () => () => undefined },
  isMock: false
}))

const { getCurrentFocusKey, initFocus, setFocus } = await import('../../input/focus')
const { FeatureGrid } = await import('./FeatureGrid')
const { FEATURE_FOCUS, presentFeatures } = await import('./features')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(props: Partial<FeatureGridProps>): HTMLElement | null {
  act(() => root.render(<FeatureGrid playDisabled={false} {...props} />))
  return host.querySelector<HTMLElement>('.gdetail__features')
}

/** The four cells in grid order, by what each is: its square's class, or 'empty'. */
function cells(grid: HTMLElement): string[] {
  return [...grid.children].map((el) =>
    el.classList.contains('gdetail__features-empty')
      ? 'empty'
      : (['gdetail__recomp', 'gdetail__upgrade', 'gdetail__coop-square', 'gdetail__peerparty'].find(
          (c) => el.classList.contains(c)
        ) ?? el.className)
  )
}

const recomp = { state: 'available' as const, onPress: vi.fn(), label: 'Recompilations' }
const upgrade = { onPress: vi.fn(), open: false }
const coop = { onPress: vi.fn(), busy: false }
const peerParty = { onPress: vi.fn(), busy: false, running: false }

describe('FeatureGrid', () => {
  it('shows nothing when the game has none of the four features', () => {
    expect(render({})).toBeNull()
    expect(host.innerHTML).toBe('')
    expect(presentFeatures({})).toBe('')
  })

  it('keeps Co-Op and PeerParty waiting while the game runs or a stream starts or runs', async () => {
    const { featuresWaitForPlay } = await import('./features')
    const idle = {
      running: false,
      justInstalled: false,
      streamConnecting: false,
      streamLive: false
    }
    expect(featuresWaitForPlay(idle)).toBe(false)
    expect(featuresWaitForPlay({ ...idle, running: true })).toBe(true)
    expect(featuresWaitForPlay({ ...idle, justInstalled: true })).toBe(true)
    expect(featuresWaitForPlay({ ...idle, streamConnecting: true })).toBe(true)
    expect(featuresWaitForPlay({ ...idle, streamLive: true })).toBe(true)
  })

  it('puts the squares in order: Recompilation, Upgrade, Co-Op, PeerParty', () => {
    const grid = render({ recomp, upgrade, coop, peerParty })!
    expect(cells(grid)).toEqual([
      'gdetail__recomp',
      'gdetail__upgrade',
      'gdetail__coop-square',
      'gdetail__peerparty'
    ])
    expect(presentFeatures({ recomp, upgrade, coop, peerParty })).toBe(
      'recomp|upgrade|coop|peerParty'
    )
  })

  it('leaves an empty, unfocusable square for a missing feature', () => {
    const grid = render({ upgrade, peerParty })!
    expect(cells(grid)).toEqual(['empty', 'gdetail__upgrade', 'empty', 'gdetail__peerparty'])
    const empty = grid.querySelectorAll('.gdetail__features-empty')
    expect(empty).toHaveLength(2)
    for (const el of empty) {
      expect(el.getAttribute('aria-hidden')).toBe('true')
      expect(el.tagName).toBe('SPAN')
    }
  })

  it('enters the grid on the first square there', async () => {
    render({ coop, peerParty })
    await act(async () => {
      setFocus(FEATURE_FOCUS.features)
      await Promise.resolve()
    })
    expect(getCurrentFocusKey()).toBe(FEATURE_FOCUS.coop)
  })

  it('marks an installed recompilation with the accent fill and a busy one as pulsing', () => {
    let grid = render({ recomp: { ...recomp, state: 'installed' } })!
    let square = grid.querySelector('.gdetail__recomp')!
    expect(square.classList.contains('gdetail__feature--accent')).toBe(true)
    expect(square.classList.contains('gdetail__feature--busy')).toBe(false)
    grid = render({ recomp: { ...recomp, state: 'busy', label: 'Installing…' } })!
    square = grid.querySelector('.gdetail__recomp')!
    expect(square.classList.contains('gdetail__feature--busy')).toBe(true)
    expect(square.getAttribute('aria-busy')).toBe('true')
    expect(square.getAttribute('title')).toBe('Installing…')
  })

  it('opens the Upgrade menu anchored to the whole grid', () => {
    const onPress = vi.fn()
    const grid = render({ recomp, upgrade: { onPress, open: false } })!
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__upgrade')!.click())
    expect(onPress).toHaveBeenCalledWith(grid)
  })

  it('starts Co-Op and PeerParty from their squares, and not while Play is disabled', () => {
    const startCoop = vi.fn()
    const startPeerParty = vi.fn()
    let grid = render({
      coop: { onPress: startCoop, busy: false },
      peerParty: { onPress: startPeerParty, busy: false, running: false }
    })!
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__coop-square')!.click())
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__peerparty')!.click())
    expect(startCoop).toHaveBeenCalledTimes(1)
    expect(startPeerParty).toHaveBeenCalledTimes(1)
    grid = render({
      coop: { onPress: startCoop, busy: false },
      peerParty: { onPress: startPeerParty, busy: false, running: true },
      playDisabled: true
    })!
    const pp = grid.querySelector<HTMLButtonElement>('.gdetail__peerparty')!
    expect(pp.disabled).toBe(true)
    expect(pp.classList.contains('gdetail__feature--accent')).toBe(true)
    expect(grid.querySelector<HTMLButtonElement>('.gdetail__coop-square')!.disabled).toBe(true)
  })

  it('ignores a press while PeerParty is busy and says how far it got', () => {
    const start = vi.fn()
    const grid = render({
      peerParty: { onPress: start, busy: true, running: false, label: 'Downloading PeerParty… 42%' }
    })!
    const square = grid.querySelector<HTMLButtonElement>('.gdetail__peerparty')!
    act(() => square.click())
    expect(start).not.toHaveBeenCalled()
    expect(square.getAttribute('title')).toBe('Downloading PeerParty… 42%')
    expect(square.getAttribute('aria-busy')).toBe('true')
    expect(square.classList.contains('gdetail__feature--busy')).toBe(true)
  })
})
