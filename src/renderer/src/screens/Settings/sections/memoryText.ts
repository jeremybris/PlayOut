import type { MemoryPassResult, MemoryStatus, MemorySystemTier } from '@shared/memory'
import { t } from '../../../i18n'
import { formatMegabytes } from '../../../lib/format'

/**
 * Settings › System › Memory: the lines under "Free up memory while PlayOut is running". They call t() when asked,
 * so they follow the language picked in Settings › System › Language (never kept in a constant).
 */

export function memoryDescription(): string {
  return t('settingsSystem.memory.description')
}

/** 'just now', '1 minute ago', '2 minutes ago', '3 hours ago', '2 days ago'. */
export function agoText(at: string, now: number): string {
  const then = Date.parse(at)
  if (!Number.isFinite(then)) return ''
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return t('settingsSystem.memory.ago.justNow')
  if (minutes < 60) return t('settingsSystem.memory.ago.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('settingsSystem.memory.ago.hours', { count: hours })
  const days = Math.floor(hours / 24)
  return t('settingsSystem.memory.ago.days', { count: days })
}

/**
 * What a pass did: "Freed 1.8 GB in 5 s" (the time only when the cleanup took a second or more and it is known), or
 * that it freed nothing, or why it did not run.
 */
export function passText(last: MemoryPassResult): string {
  if (last.error) return last.error
  if (last.freedMb < 1) return t('settingsSystem.memory.pass.nothing')
  const ms = last.durationMs
  // Under a second says nothing (999 ms must not read "in 1 s"); from there on, the nearest second.
  const seconds =
    typeof ms === 'number' && Number.isFinite(ms) && ms >= 1000 ? Math.round(ms / 1000) : 0
  const size = formatMegabytes(last.freedMb)
  return seconds >= 1
    ? t('settingsSystem.memory.pass.freedIn', { size, seconds })
    : t('settingsSystem.memory.pass.freed', { size })
}

/** "Freed 1.8 GB in 5 s · 2 minutes ago" (the last pass of this run), or what the button does before the first. */
export function memoryResultLine(status: MemoryStatus | null, now: number): string {
  if (!status) return t('settingsSystem.memory.result.checking')
  if (status.running) return t('settingsSystem.memory.result.running')
  if (!status.last) return t('settingsSystem.memory.result.idle')
  const ago = agoText(status.last.at, now)
  const result = passText(status.last)
  return ago ? t('settingsSystem.memory.result.withAgo', { result, ago }) : result
}

/** Why the system-wide part is not there; null when it is (nothing to say). */
export function memoryTierHint(tier: MemorySystemTier | undefined): string | null {
  switch (tier) {
    case 'missing':
      return t('settingsSystem.memory.tier.missing')
    case 'outdated':
      // The row's button reads Update with "Set watts" on and Install with it off.
      return t('settingsSystem.memory.tier.outdated')
    case 'not-answering':
      return t('settingsSystem.memory.tier.notAnswering')
    case 'unavailable':
      return t('settingsSystem.memory.tier.unavailable')
    default:
      return null
  }
}
