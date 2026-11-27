import type { PlayOutEvents } from '@shared/types'
import { describe, expect, it, vi } from 'vitest'

// The module subscribes at import time: capture its listeners so the tests can play main's events.
const { listeners, api } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }),
    getConvertStatus: vi.fn()
  }
  return { listeners, api }
})
vi.mock('../api/client', () => ({ api }))

const { trimStartedText, trimSkippedText } = await import('./convert')
const { useUiStore } = await import('./ui')

function emit<E extends keyof PlayOutEvents>(event: E, payload: PlayOutEvents[E]): void {
  listeners.get(event)!(payload)
}

const toasts = (): string[] => useUiStore.getState().toasts.map((t) => `${t.kind}:${t.text}`)

describe('Trim Games toasts', () => {
  it('names one game, counts several, and toasts a skip as an error', () => {
    expect(trimStartedText(1, ['Halo'])).toBe('Trimming Halo… (Settings › Convert shows progress)')
    emit('trim:started', { count: 3, titles: ['A', 'B', 'C'] })
    emit('trim:skipped', { title: 'Zelda', reason: 'no Wii key' })
    expect(toasts()).toEqual([
      'info:Trimming 3 new games… (Settings › Convert shows progress)',
      'error:Trim Games left Zelda as it is: no Wii key'
    ])
  })

  it('says "games" (not new) for the switch-on look, and counts a summarised skip', () => {
    expect(trimStartedText(4, ['A', 'B', 'C', 'D'], true)).toBe(
      'Trimming 4 games… (Settings › Convert shows progress)'
    )
    expect(trimStartedText(1, ['Halo'], true)).toBe(
      'Trimming Halo… (Settings › Convert shows progress)'
    )
    expect(trimSkippedText('A, B, C', 'no Wii key', 3)).toBe(
      'Trim Games left 3 games as they are: no Wii key'
    )
    expect(trimSkippedText('A', 'no Wii key')).toBe('Trim Games left A as it is: no Wii key')
  })
})
