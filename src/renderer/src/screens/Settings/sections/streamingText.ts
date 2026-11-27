import type {
  EmulationSyncStatus,
  PairedHost,
  StreamingHostStatus,
  StreamingToolStatus
} from '@shared/types'
import { t } from '../../../i18n'
import { daysSince, formatDate } from '../../../lib/format'

/**
 * Settings > Streaming's status lines, kept apart from the component so they can be tested. Each line is one whole
 * sentence in settingsStreaming.status.* (word order differs between languages); ' · ' only joins separate facts.
 */

/** A helper program's line: Sunshine on the host, Moonlight on the client. */
export function toolLine(
  tool: StreamingToolStatus | undefined,
  name: string,
  whenMissing: string
): string {
  if (!tool) return t('settingsStreaming.status.checking')
  // The program's name with its version ("Sunshine 2026.914"): neither is translated.
  const named = tool.version ? `${name} ${tool.version.replace(/^v/, '')}` : name
  switch (tool.state) {
    case 'missing':
      return whenMissing
    case 'downloading':
      return tool.percent !== undefined
        ? t('settingsStreaming.status.tool.downloadingPercent', {
            name,
            percent: Math.round(tool.percent)
          })
        : t('settingsStreaming.status.tool.downloading', { name })
    case 'installed':
      return t('settingsStreaming.status.tool.ready', { name: named })
    case 'running':
      return t('settingsStreaming.status.tool.running', { name: named })
    case 'error':
      return tool.error || t('settingsStreaming.status.tool.failed', { name })
  }
}

/** The port forwarding line; the design's wording, so users know whether other networks can reach this PC. */
export function portForwardingLine(
  pf: StreamingHostStatus['portForwarding'] | undefined,
  port?: number
): string {
  switch (pf?.state) {
    case undefined:
    case 'checking':
      return t('settingsStreaming.status.checking')
    case 'off':
      return t('settingsStreaming.status.forwarding.off')
    case 'mapped': {
      // `error` here: the stream ports could not be forwarded (a sentence of its own, translated in main).
      if (pf.externalIp)
        return pf.error
          ? t('settingsStreaming.status.forwarding.mappedAtWithError', {
              ip: pf.externalIp,
              error: pf.error
            })
          : t('settingsStreaming.status.forwarding.mappedAt', { ip: pf.externalIp })
      return pf.error
        ? t('settingsStreaming.status.forwarding.mappedWithError', { error: pf.error })
        : t('settingsStreaming.status.forwarding.mapped')
    }
    case 'unavailable': {
      // The internet address is known (looked up), so forwarding the ports by hand lets other networks in.
      if (pf.externalIp && port)
        return t('settingsStreaming.status.forwarding.byHand', {
          reason: pf.error ?? t('settingsStreaming.status.forwarding.noAutomatic'),
          port,
          ip: pf.externalIp
        })
      return pf.error
        ? t('settingsStreaming.status.forwarding.unavailableWhy', { error: pf.error })
        : t('settingsStreaming.status.forwarding.unavailable')
    }
  }
}

/** 'm:ss' left until `expiresAt` (never below 0:00). */
export function countdown(expiresAt: string, nowMs: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** "Too many wrong PINs" until the lock ends; null once it is over. */
export function lockedLine(lockedUntil: string | undefined, nowMs: number): string | null {
  if (!lockedUntil) return null
  const until = Date.parse(lockedUntil)
  if (!Number.isFinite(until) || until <= nowMs) return null
  const minutes = Math.max(1, Math.ceil((until - nowMs) / 60_000))
  return t('settingsStreaming.status.locked', { count: minutes })
}

/**
 * When something last happened, as a phrase that follows "last seen" or "synced": "just now", "5 min ago",
 * "2 h ago" (the times only when `withTime`), "today", "yesterday", "3 days ago", "on Nov 2". These are their own
 * lower-case keys: lowering the case of a translated word is wrong in languages that capitalise nouns.
 */
function whenText(iso: string, now: Date, withTime: boolean): string {
  const ms = now.getTime() - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  if (withTime) {
    if (ms < 60_000) return t('settingsStreaming.status.when.justNow')
    if (ms < 3_600_000)
      return t('settingsStreaming.status.when.minutes', { count: Math.floor(ms / 60_000) })
    if (ms < 12 * 3_600_000)
      return t('settingsStreaming.status.when.hours', { count: Math.floor(ms / 3_600_000) })
  }
  const days = daysSince(iso, now)
  if (days === null) return ''
  if (days <= 0) return t('settingsStreaming.status.when.today')
  if (days === 1) return t('settingsStreaming.status.when.yesterday')
  if (days < 7) return t('settingsStreaming.status.when.days', { count: days })
  return t('settingsStreaming.status.when.onDate', { date: formatDate(iso, 'short') })
}

/** "12 games · 192.168.1.20" for a paired host, or why it cannot be reached. */
export function hostLine(host: PairedHost, now = new Date()): string {
  const address = host.lanAddress ?? host.address ?? host.wanAddress
  if (!host.online) {
    const when = host.lastSeen ? whenText(host.lastSeen, now, false) : ''
    const seen = when ? t('settingsStreaming.status.host.lastSeen', { when }) : ''
    return [host.error || t('settingsStreaming.status.host.offline'), seen]
      .filter(Boolean)
      .join(' · ')
  }
  // Online, `error` is what is still wrong with streaming from it (Moonlight not paired yet).
  return [
    host.games !== undefined ? t('settingsStreaming.status.host.games', { count: host.games }) : '',
    address,
    host.error ?? ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The Emulation folder sync with a host, in one line, or null before its first pass. */
export function emulationSyncLine(
  sync: EmulationSyncStatus | undefined,
  now = new Date()
): string | null {
  if (!sync) return null
  switch (sync.state) {
    case 'syncing':
      return sync.total
        ? t('settingsStreaming.status.emulationSync.syncing', {
            done: sync.done ?? 0,
            count: sync.total
          })
        : t('settingsStreaming.status.emulationSync.comparing')
    case 'waiting':
      return sync.message
        ? t('settingsStreaming.status.emulationSync.waitingWhy', { reason: sync.message })
        : t('settingsStreaming.status.emulationSync.waiting')
    case 'error':
      return t('settingsStreaming.status.emulationSync.error', {
        error: sync.message ?? t('settingsStreaming.status.emulationSync.unknownError')
      })
    case 'synced': {
      const when = sync.lastSync ? whenText(sync.lastSync, now, true) : ''
      const parts = [
        when
          ? t('settingsStreaming.status.emulationSync.syncedWhen', { when })
          : t('settingsStreaming.status.emulationSync.synced')
      ]
      const last = sync.last
      if (last?.conflicts)
        parts.push(t('settingsStreaming.status.emulationSync.conflicts', { count: last.conflicts }))
      if (last?.failed)
        parts.push(t('settingsStreaming.status.emulationSync.failed', { count: last.failed }))
      return parts.join(' · ')
    }
  }
}

/** Windows asks once whether PlayOut and Sunshine may accept connections; without Allow nothing gets through. */
export function firewallHint(): string {
  return t('settingsStreaming.status.firewallHint')
}

/** Only digits, at most 4: what the PIN field keeps of what was typed. */
export function pinInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4)
}
