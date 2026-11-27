// The logins a host gives its paired computers (GET /v1/logins): the metadata services' (Settings › Metadata) and the
// RetroAchievements account's, from the host's settings, while Settings › Streaming › "Share my logins" is on. A
// client takes a service's login only when it has none of its own for that service (never overwrites one), so the
// same person's second PC works without typing them again. They travel only to paired computers, over the host's
// pinned TLS connection with the client's own token, and are never logged.

import type { Settings } from '../../shared/types'
import { CREDENTIAL_SCHEMAS } from '../store/settings-schema'

type Scrapers = Settings['scrapers']

/** The services whose logins are shared, each with its fields (strings). */
export const SHARED_LOGINS = {
  steamgriddb: ['apiKey'],
  igdb: ['clientId', 'clientSecret'],
  screenscraper: ['devId', 'devPassword', 'user', 'password'],
  thegamesdb: ['apiKey'],
  steam: ['apiKey', 'steamId64'],
  retroachievements: ['username', 'apiKey']
} as const satisfies Partial<Record<keyof Scrapers, readonly string[]>>

export type SharedService = keyof typeof SHARED_LOGINS

/** What a host sends: per service, its fields (only services with something set). */
export type HostLogins = Partial<Record<SharedService, Record<string, string>>>

/** Display names, for the client's log and toast. */
export const SERVICE_NAMES: Record<SharedService, string> = {
  steamgriddb: 'SteamGridDB',
  igdb: 'IGDB',
  screenscraper: 'ScreenScraper',
  thegamesdb: 'TheGamesDB',
  steam: 'Steam',
  retroachievements: 'RetroAchievements'
}

const MAX_LENGTH = 500

const fieldsOf = (scrapers: Scrapers, service: SharedService): Record<string, string> => {
  const raw = (scrapers as unknown as Record<string, Record<string, unknown>>)[service] ?? {}
  const out: Record<string, string> = {}
  for (const field of SHARED_LOGINS[service]) {
    const v = raw[field]
    out[field] = typeof v === 'string' ? v.trim() : ''
  }
  return out
}

const isSet = (fields: Record<string, string>): boolean =>
  Object.values(fields).some((v) => v !== '')

/** The host's logins to send: every shared service with at least one field set. */
export function loginsToShare(scrapers: Scrapers): HostLogins {
  const out: HostLogins = {}
  for (const service of Object.keys(SHARED_LOGINS) as SharedService[]) {
    const fields = fieldsOf(scrapers, service)
    if (isSet(fields)) out[service] = fields
  }
  return out
}

/**
 * What a client takes from a host's answer: for each shared service it has no login for (every field empty), the
 * host's, when the answer is well formed (only the known fields, strings of at most 500 characters). Returns the
 * settings patch and the services filled (empty when nothing changes).
 */
export function loginsToFill(
  mine: Scrapers,
  theirs: unknown
): { patch: Partial<Scrapers>; filled: SharedService[] } {
  const patch: Record<string, Record<string, string>> = {}
  const filled: SharedService[] = []
  if (!theirs || typeof theirs !== 'object' || Array.isArray(theirs)) return { patch: {}, filled }
  for (const service of Object.keys(SHARED_LOGINS) as SharedService[]) {
    if (isSet(fieldsOf(mine, service))) continue
    const raw = (theirs as Record<string, unknown>)[service]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const fields: Record<string, string> = {}
    let ok = true
    for (const field of SHARED_LOGINS[service]) {
      const v = (raw as Record<string, unknown>)[field] ?? ''
      if (typeof v !== 'string' || v.length > MAX_LENGTH) {
        ok = false
        break
      }
      fields[field] = v.trim()
    }
    // The same rules a login typed in Settings meets (steamId64 at most 32 characters, …): a value the settings file
    // would reject on the next load (or that would block the next Settings save) is never stored.
    if (!ok || !isSet(fields) || !CREDENTIAL_SCHEMAS[service].safeParse(fields).success) continue
    patch[service] = fields
    filled.push(service)
  }
  return { patch: patch as Partial<Scrapers>, filled }
}
