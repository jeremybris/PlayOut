import type { Settings, SettingsPatch } from '@shared/types'
import { useCallback, useEffect, useRef } from 'react'
import { createLog } from '../../lib/log'
import { useSettingsStore } from '../../state/settings'
import { SETTINGS_SECTIONS, type SettingsSection } from '../../state/ui'

export const log = createLog('settings')

/** Focus key of a control inside a section: 'settings:<section>:<name>'. */
export function fk(section: SettingsSection, name: string): string {
  return `settings:${section}:${name}`
}

/** Focus key of a section's entry in the left navigation list. */
export function navFocusKey(section: SettingsSection): string {
  return `settings:nav:${section}`
}

/** The section a navigation entry's focus key names ('settings:nav:<section>'), if it is one. */
export function sectionOfNavKey(key: string | undefined): SettingsSection | undefined {
  const id = key?.startsWith('settings:nav:') ? key.slice('settings:nav:'.length) : undefined
  return isSection(id) ? id : undefined
}

export function isSection(value: string | undefined): value is SettingsSection {
  return value !== undefined && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

/** Props every section component receives. */
export interface SectionProps {
  settings: Settings
  /** Persist a patch (optimistic; errors are logged and toasted by the store). */
  patch: (patch: SettingsPatch) => void
}

/** `patch` bound to the settings store; errors never reach the caller. */
export function useSettingsPatch(): SectionProps['patch'] {
  const update = useSettingsStore((s) => s.update)
  return useCallback(
    (patch: SettingsPatch) => {
      update(patch).catch((err) => log.error('updateSettings failed', err))
    },
    [update]
  )
}

/**
 * Debounced patch for text fields: every keystroke updates the UI through the draft the caller keeps, the
 * API sees one updateSettings per pause. Pending patches are flushed when the component unmounts.
 */
export function useDebouncedPatch(delayMs = 600): (patch: SettingsPatch) => void {
  const patch = useSettingsPatch()
  const pending = useRef<{ patch: SettingsPatch; timer: ReturnType<typeof setTimeout> } | null>(
    null
  )
  const flush = useCallback(() => {
    const current = pending.current
    if (!current) return
    clearTimeout(current.timer)
    pending.current = null
    patch(current.patch)
  }, [patch])
  useEffect(() => flush, [flush])
  return useCallback(
    (next: SettingsPatch) => {
      const merged = pending.current ? mergePatch(pending.current.patch, next) : next
      if (pending.current) clearTimeout(pending.current.timer)
      pending.current = { patch: merged, timer: setTimeout(flush, delayMs) }
    },
    [flush, delayMs]
  )
}

/** Merge two one-level-deep patches so a burst of keystrokes in different fields ends in one call. */
function mergePatch(base: SettingsPatch, next: SettingsPatch): SettingsPatch {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(next)) {
    const current = out[key]
    out[key] =
      value && typeof value === 'object' && current && typeof current === 'object'
        ? { ...(current as object), ...(value as object) }
        : value
  }
  return out as SettingsPatch
}

/** Trim a Windows path for display: keeps the drive and the last two segments. */
export function shortPath(path: string, maxLength = 60): string {
  if (path.length <= maxLength) return path
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return path
  const tail = parts.slice(-2).join('\\')
  return `${parts[0]}\\…\\${tail}`
}
