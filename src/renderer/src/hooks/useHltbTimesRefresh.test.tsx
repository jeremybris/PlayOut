// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  refreshHltbTimes: vi.fn(async () => {}),
  stopHltbTimes: vi.fn(async () => {})
}))
vi.mock('../api/client', () => ({ api }))

import { HLTB_TIMES_REFRESH_MS, useHltbTimesRefresh } from './useHltbTimesRefresh'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ shown }: { shown: boolean }): ReactElement | null {
  useHltbTimesRefresh(shown)
  return null
}

describe('useHltbTimesRefresh', () => {
  let root: Root
  beforeEach(() => {
    vi.useFakeTimers()
    api.refreshHltbTimes.mockClear()
    api.stopHltbTimes.mockClear()
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it('asks main when the sort is shown, then every 30 minutes while it stays', () => {
    act(() => root.render(<Probe shown />))
    expect(api.refreshHltbTimes).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(HLTB_TIMES_REFRESH_MS - 1))
    expect(api.refreshHltbTimes).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(1))
    expect(api.refreshHltbTimes).toHaveBeenCalledTimes(2)
  })

  it('never asks while the sort is not shown, and stops when it is left', () => {
    act(() => root.render(<Probe shown={false} />))
    act(() => void vi.advanceTimersByTime(HLTB_TIMES_REFRESH_MS * 3))
    expect(api.refreshHltbTimes).not.toHaveBeenCalled()
    act(() => root.render(<Probe shown />))
    expect(api.refreshHltbTimes).toHaveBeenCalledTimes(1)
    act(() => root.render(<Probe shown={false} />))
    act(() => void vi.advanceTimersByTime(HLTB_TIMES_REFRESH_MS * 3))
    expect(api.refreshHltbTimes).toHaveBeenCalledTimes(1)
  })

  it('asks again when the sort is picked again', () => {
    act(() => root.render(<Probe shown />))
    act(() => root.render(<Probe shown={false} />))
    act(() => root.render(<Probe shown />))
    expect(api.refreshHltbTimes).toHaveBeenCalledTimes(2)
  })
})

describe('useHltbTimesRefresh stop', () => {
  let root: Root
  beforeEach(() => {
    api.refreshHltbTimes.mockClear()
    api.stopHltbTimes.mockClear()
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => act(() => root.unmount()))

  it('tells main to stop when the sort is left or the Library closes, never while it was not shown', () => {
    act(() => root.render(<Probe shown={false} />))
    expect(api.stopHltbTimes).not.toHaveBeenCalled()
    act(() => root.render(<Probe shown />))
    expect(api.stopHltbTimes).not.toHaveBeenCalled()
    act(() => root.render(<Probe shown={false} />))
    expect(api.stopHltbTimes).toHaveBeenCalledTimes(1)
    act(() => root.render(<Probe shown />))
    act(() => root.unmount())
    expect(api.stopHltbTimes).toHaveBeenCalledTimes(2)
    root = createRoot(document.createElement('div'))
  })
})
