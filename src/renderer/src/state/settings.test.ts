import { defaultSettings } from '@shared/defaults'
import type { Settings, SettingsPatch } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store subscribes at import time: capture its listeners so the tests can play main's events.
const { listeners, api } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }),
    getSettings: vi.fn(),
    updateSettings: vi.fn()
  }
  return { listeners, api }
})
vi.mock('../api/client', () => ({ api }))

const { keepUnchanged, mergeSettings, receiveSettings, useSettingsStore } =
  await import('./settings')

function saved(patch: SettingsPatch): Settings {
  return mergeSettings(defaultSettings(), patch)
}

describe("settings store: 'settings:changed' from the other window", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: defaultSettings(), loaded: true, loadFailed: false })
    vi.clearAllMocks()
  })

  it('listens to settings:changed', () => {
    expect(listeners.has('settings:changed')).toBe(true)
  })

  it('takes the music folder, game-start choice and volume changed in PlayOut without a reload', () => {
    const next = saved({ music: { folder: 'D:\\Music', gameStart: 'play', volume: 0.3 } })
    listeners.get('settings:changed')!(next)
    const { music } = useSettingsStore.getState().settings!
    expect(music).toMatchObject({ folder: 'D:\\Music', gameStart: 'play', volume: 0.3 })
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it('fills a store that had not loaded yet', () => {
    useSettingsStore.setState({ settings: null, loaded: false })
    receiveSettings(saved({ music: { volume: 0.9 } }))
    expect(useSettingsStore.getState()).toMatchObject({ loaded: true, loadFailed: false })
    expect(useSettingsStore.getState().settings!.music.volume).toBe(0.9)
  })

  it("keeps this window's unanswered change on top of an older saved state", async () => {
    let answer: (s: Settings) => void = () => undefined
    api.updateSettings.mockImplementation(
      () => new Promise<Settings>((resolve) => (answer = resolve))
    )
    const update = useSettingsStore.getState().update({ music: { volume: 0.2 } })
    // The other window saved something else meanwhile.
    receiveSettings(saved({ music: { folder: 'E:\\Songs' } }))
    expect(useSettingsStore.getState().settings!.music).toMatchObject({
      volume: 0.2,
      folder: 'E:\\Songs'
    })
    answer(saved({ music: { folder: 'E:\\Songs', volume: 0.2 } }))
    expect(await update).toBe(true)
    // Answered: the next event is taken as it is.
    receiveSettings(saved({ music: { volume: 0.5 } }))
    expect(useSettingsStore.getState().settings!.music.volume).toBe(0.5)
  })

  it('keeps the objects of sections that did not change (drafts keyed on them are not reset)', () => {
    const before = useSettingsStore.getState().settings!
    receiveSettings(saved({ music: { volume: 0.4 } }))
    const after = useSettingsStore.getState().settings!
    expect(after.music.volume).toBe(0.4)
    expect(after.music).not.toBe(before.music)
    expect(after.performance).toBe(before.performance)
    expect(after.input).toBe(before.input)
    // Nothing changed at all: the same object, so nothing re-renders.
    receiveSettings(saved({ music: { volume: 0.4 } }))
    expect(useSettingsStore.getState().settings).toBe(after)
    expect(keepUnchanged(null, after)).toBe(after)
  })

  it('a failed save falls back to the saved state, keeping a change that arrived meanwhile', async () => {
    let fail: (err: Error) => void = () => undefined
    api.updateSettings.mockImplementation(
      () => new Promise<Settings>((_, reject) => (fail = reject))
    )
    const update = useSettingsStore.getState().update({ music: { volume: 0.7 } })
    receiveSettings(saved({ music: { folder: 'F:\\Tunes' } }))
    fail(new Error('rejected'))
    // It answers false (never throws), so a caller holds back its success toast and rescan.
    expect(await update).toBe(false)
    const { music } = useSettingsStore.getState().settings!
    expect(music.folder).toBe('F:\\Tunes')
    expect(music.volume).toBe(defaultSettings().music.volume)
  })
})
