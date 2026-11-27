import type { CredentialService, ServiceCredentials } from '@shared/types'
import { t } from '../i18n'

export const CREDENTIAL_SERVICE_NAMES: Record<CredentialService, string> = {
  steamgriddb: 'SteamGridDB',
  igdb: 'IGDB',
  screenscraper: 'ScreenScraper',
  thegamesdb: 'TheGamesDB',
  steam: 'Steam',
  retroachievements: 'RetroAchievements'
}

/**
 * Whether a service's fields are filled in enough to ask the service about them. Half-entered pairs (a client ID
 * without its secret, a user name without its password, a SteamID64 still being typed) wait, so a pause while
 * typing does not report an error the user is about to fix.
 */
export function credentialsReady<S extends CredentialService>(
  service: S,
  credentials: ServiceCredentials<S>
): boolean {
  switch (service) {
    case 'steamgriddb':
    case 'thegamesdb':
      return filled((credentials as ServiceCredentials<'steamgriddb'>).apiKey)
    case 'igdb': {
      const { clientId, clientSecret } = credentials as ServiceCredentials<'igdb'>
      return filled(clientId) && filled(clientSecret)
    }
    case 'screenscraper': {
      const c = credentials as ServiceCredentials<'screenscraper'>
      const dev = filled(c.devId) && filled(c.devPassword)
      const devStarted = filled(c.devId) || filled(c.devPassword)
      const userPair = filled(c.user) && c.password !== ''
      const userStarted = filled(c.user) || c.password !== ''
      // A complete user login without developer credentials is tested too: the answer says what is missing.
      if (dev) return userPair || !userStarted
      return userPair && !devStarted
    }
    case 'steam': {
      const { apiKey, steamId64 } = credentials as ServiceCredentials<'steam'>
      const id = steamId64.trim()
      // Digits only and fewer than 17: still being typed. Anything else is either complete or clearly wrong.
      return filled(apiKey) && !/^\d{1,16}$/.test(id)
    }
    case 'retroachievements': {
      const { username, apiKey } = credentials as ServiceCredentials<'retroachievements'>
      return filled(username) && filled(apiKey)
    }
  }
  return false
}

/** Identity of a tested value set, so the same values are not sent to a service twice in a row. */
export function credentialsSignature<S extends CredentialService>(
  credentials: ServiceCredentials<S>
): string {
  const values = credentials as Record<string, string>
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map((key) => [key, key === 'password' ? values[key] : values[key]?.trim()])
  )
}

function filled(value: string): boolean {
  return value.trim() !== ''
}

/**
 * What IGDB still needs when only one of its two fields is filled in: the client ID alone is not enough (Twitch
 * issues a token only for the pair), and a half-entered pair is never checked, so it would otherwise fail silently.
 */
export function igdbMissingHalf(credentials: ServiceCredentials<'igdb'>): string | null {
  const id = filled(credentials.clientId ?? '')
  const secret = filled(credentials.clientSecret ?? '')
  if (id && !secret) return t('lib.credentials.igdbNeedsSecret')
  if (secret && !id) return t('lib.credentials.igdbNeedsId')
  return null
}

/**
 * ScreenScraper with the user name and password filled in but not the developer ID and password: the user account
 * alone does not let PlayOut ask ScreenScraper (no covers), so Settings › Metadata says so under its fields.
 */
export function screenScraperNeedsDev(
  credentials: ServiceCredentials<'screenscraper'>
): string | null {
  const user = filled(credentials.user ?? '') && filled(credentials.password ?? '')
  const dev = filled(credentials.devId ?? '') && filled(credentials.devPassword ?? '')
  return user && !dev ? t('lib.credentials.screenscraperNeedsDev') : null
}
