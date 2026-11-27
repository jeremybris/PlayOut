/**
 * Keeps the renderer's language on settings.system.language, in PlayOut's window and the overlay's alike (both get
 * 'settings:changed'). Kept apart from ./index so the settings store may use t() itself without an import cycle.
 */
import { useSettingsStore } from '../state/settings'
import { setLanguage } from '.'

setLanguage(useSettingsStore.getState().settings?.system.language ?? '')
useSettingsStore.subscribe((state, previous) => {
  const next = state.settings?.system.language
  if (next !== previous.settings?.system.language) setLanguage(next ?? '')
})
