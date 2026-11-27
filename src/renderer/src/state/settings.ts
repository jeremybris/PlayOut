import { defaultSettings } from '@shared/defaults'
import type { Settings, SettingsPatch } from '@shared/types'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { createLog } from '../lib/log'
import { useUiStore } from './ui'

const log = createLog('settings')

/**
 * Settings store. `settings` is null until load() resolves; use currentSettings() outside React when a
 * value is needed immediately (it falls back to the defaults).
 */
export interface SettingsState {
  settings: Settings | null
  loaded: boolean
  /** load() failed: settings are the defaults, not what is saved (until a later load works). */
  loadFailed: boolean
  error?: string
  load(): Promise<void>
  /**
   * Apply a patch optimistically, persist it through the API and keep the server's result. Never throws: a failed save
   * is rolled back with a 'Could not save settings' toast, and the promise answers false (true once saved), so a
   * caller can hold back what should only follow a save that worked.
   */
  update(patch: SettingsPatch): Promise<boolean>
}

/** Shallow-merge each patched section into the base settings (the SettingsPatch shape is one level deep). */
export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = (base as unknown as Record<string, unknown>)[key]
    next[key] =
      value !== null && typeof value === 'object' && current !== null && typeof current === 'object'
        ? { ...(current as object), ...(value as object) }
        : value
  }
  return next as unknown as Settings
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: null,
  loaded: false,
  loadFailed: false,
  async load() {
    try {
      const settings = await api.getSettings()
      lastSaved = settings
      set({
        settings: keepUnchanged(get().settings, withPending(settings)),
        loaded: true,
        loadFailed: false,
        error: undefined
      })
    } catch (err) {
      log.error('load failed', err)
      set({
        settings: get().settings ?? defaultSettings(),
        loaded: true,
        loadFailed: true,
        error: String(err)
      })
    }
  },
  async update(patch) {
    const previous = get().settings ?? defaultSettings()
    set({ settings: mergeSettings(previous, patch), error: undefined })
    pending.push(patch)
    try {
      const settings = await api.updateSettings(patch)
      settle(patch)
      lastSaved = settings
      set({ settings: keepUnchanged(get().settings, withPending(settings)) })
      return true
    } catch (err) {
      settle(patch)
      log.error('update failed', err)
      // Back to what is saved (which may have moved on through 'settings:changed' since) with the other patches
      // still waiting on top: restoring `previous` would undo changes that arrived meanwhile.
      set({ settings: withPending(lastSaved ?? previous), error: String(err) })
      useUiStore.getState().toast(t('state.settings.saveFailed'), 'error')
      return false
    }
  }
}))

/** The last settings main answered or announced (null until then). */
let lastSaved: Settings | null = null

/**
 * `next` with every top-level section that did not change keeping its previous object: each 'settings:changed' is a
 * fresh copy, and a new object for an unchanged section would reset drafts keyed on it (the Custom profile editor's
 * sliders mid-drag) and re-render everything that selects it.
 */
export function keepUnchanged(previous: Settings | null, next: Settings): Settings {
  if (!previous) return next
  const before = previous as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...next }
  let same = Object.keys(before).length === Object.keys(out).length
  for (const [key, value] of Object.entries(out)) {
    if (key in before && sameJson(before[key], value)) out[key] = before[key]
    else same = false
  }
  return same ? previous : (out as unknown as Settings)
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** Patches sent by update() and not answered yet: a newer saved state from elsewhere keeps them on top. */
const pending: SettingsPatch[] = []

function settle(patch: SettingsPatch): void {
  const index = pending.indexOf(patch)
  if (index >= 0) pending.splice(index, 1)
}

function withPending(settings: Settings): Settings {
  return pending.reduce(mergeSettings, settings)
}

/**
 * 'settings:changed': the saved settings after any change, from either window (PlayOut's main window or the
 * overlay's). Both windows' stores follow it, so the overlay's music player sees a folder or volume changed in
 * PlayOut's Settings at once (and the reverse). This window's own unanswered patches stay applied over it.
 */
export function receiveSettings(settings: Settings): void {
  lastSaved = settings
  useSettingsStore.setState({
    settings: keepUnchanged(useSettingsStore.getState().settings, withPending(settings)),
    loaded: true,
    loadFailed: false,
    error: undefined
  })
}

api.on('settings:changed', receiveSettings)

/** Current settings for non-React code (input polling, formatting); defaults until loaded. */
export function currentSettings(): Settings {
  return useSettingsStore.getState().settings ?? defaultSettings()
}

// Mirror the animations switch on <html> so CSS can zero the motion tokens (tokens.css).
function applyAnimationsAttribute(settings: Settings | null): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.animations = settings?.ui.animations === false ? 'off' : 'on'
}

applyAnimationsAttribute(useSettingsStore.getState().settings)
useSettingsStore.subscribe((state, previous) => {
  if (state.settings?.ui.animations !== previous.settings?.ui.animations)
    applyAnimationsAttribute(state.settings)
})
