// Credential tests for Settings > Metadata (testCredentials): one cheap request per service with the values the
// user just typed, classified as valid / invalid / unchecked. Only an answer that is unambiguously about the
// credentials is `invalid`; offline, timeouts, rate limits, server errors and proxy or Cloudflare pages are
// `unchecked`, so a bad network never tells the user their key is wrong.
//
// The tests bypass the scrapers' shared rate limiters and gates on purpose: those queue requests in order, so a
// test behind a running library scan would wait for minutes, and `timeoutMs` only covers the request itself. One
// user-triggered request per edit does not threaten any service's limit. No retries, for the same reason.
import type { CredentialCheck, CredentialService, ServiceCredentials } from '../../shared/types'
import { buildUrl, httpJson, httpText, HttpError, serviceError, type HttpOptions } from './http'
import { raProfile, RaAuthError } from '../achievements/retroachievements'
import { TWITCH_TOKEN_URL } from './igdb'
import { SCREENSCRAPER_BASE_URL, SCREENSCRAPER_SOFTNAME } from './screenscraper'
import { SGDB_BASE_URL } from './steamgriddb'
import { TGDB_BASE_URL } from './thegamesdb'
import { tMain } from '../i18n'

const STEAM_WEB_API = 'https://api.steampowered.com'
const TWITCH_REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke'
/** Portal 2: present on SteamGridDB, so a working key gets a 200. */
const SGDB_PROBE_APP_ID = 620
/** A long-standing public Steam account, used to check a Web API key before the user's SteamID64 is entered. */
const STEAM_PROBE_ID64 = '76561197960287930'
const STEAM_ID64 = /^\d{17}$/

const REQUEST: HttpOptions = { retries: 0, timeoutMs: 10_000 }

const NAMES: Record<CredentialService, string> = {
  steamgriddb: 'SteamGridDB',
  igdb: 'IGDB',
  screenscraper: 'ScreenScraper',
  thegamesdb: 'TheGamesDB',
  steam: 'Steam',
  retroachievements: 'RetroAchievements'
}

/** Test one service's credentials. Never throws: every failure becomes an `unchecked` result. */
export async function testCredentials<S extends CredentialService>(
  service: S,
  credentials: ServiceCredentials<S>
): Promise<CredentialCheck> {
  const result = await check(service, credentials)
  // Error texts from fetch or a service can echo what was sent; the message is shown on screen, so mask every
  // key, secret and password that appears in it, whatever path produced it. (User names and SteamID64s are not
  // secret, and masking a short value could garble the sentence's own words; keys and secrets are long.)
  let message = result.message
  for (const [field, value] of Object.entries(credentials as Record<string, string>)) {
    if (field === 'user' || field === 'steamId64' || field === 'username') continue
    const secret = value.trim()
    if (secret.length >= 8) message = message.split(secret).join('***')
  }
  return { ...result, message }
}

async function check<S extends CredentialService>(
  service: S,
  credentials: ServiceCredentials<S>
): Promise<CredentialCheck> {
  try {
    switch (service) {
      case 'steamgriddb':
        return await checkSteamGridDb(credentials as ServiceCredentials<'steamgriddb'>)
      case 'igdb':
        return await checkIgdb(credentials as ServiceCredentials<'igdb'>)
      case 'screenscraper':
        return await checkScreenScraper(credentials as ServiceCredentials<'screenscraper'>)
      case 'thegamesdb':
        return await checkTheGamesDb(credentials as ServiceCredentials<'thegamesdb'>)
      case 'steam':
        return await checkSteam(credentials as ServiceCredentials<'steam'>)
      case 'retroachievements':
        return await checkRetroAchievements(credentials as ServiceCredentials<'retroachievements'>)
    }
  } catch (err) {
    return cannotCheck(service, err)
  }
  return cannotCheck(service, new CheckError('unknown service'))
}

function valid(message: string): CredentialCheck {
  return { status: 'valid', message }
}

function invalid(message: string): CredentialCheck {
  return { status: 'invalid', message }
}

function unchecked(message: string): CredentialCheck {
  return { status: 'unchecked', message }
}

/** A reason this module words itself; safe to show. */
class CheckError extends Error {}

/**
 * The service could not answer about the credentials; the reason comes from serviceError's wording. Other errors
 * are not quoted: undici's header errors, for one, repeat the header value, which holds the key.
 */
function cannotCheck(service: CredentialService, err: unknown): CredentialCheck {
  const name = NAMES[service]
  const reason =
    err instanceof HttpError
      ? serviceError(name, err).message.slice(name.length + 2)
      : err instanceof CheckError
        ? err.message
        : tMain('mainScrapers.check.unexpectedError')
  return unchecked(tMain('mainScrapers.check.cannotCheck', { service: name, reason }))
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// --- SteamGridDB: Bearer key on a small game lookup ---------------------------------------------------------------

async function checkSteamGridDb({
  apiKey
}: ServiceCredentials<'steamgriddb'>): Promise<CredentialCheck> {
  const key = apiKey.trim()
  if (!key) return unchecked(tMain('mainScrapers.sgdb.enterKey'))
  // The key goes into a header, which can't carry spaces, line breaks or invisible characters (a zero-width space
  // copied from a web page): fetch would refuse before SteamGridDB sees it, and the scraper would fail the same way.
  if (!/^[\x21-\x7e]+$/.test(key)) {
    return invalid(tMain('mainScrapers.sgdb.badCharacters'))
  }
  try {
    const body = record(
      await httpJson<unknown>(
        `${SGDB_BASE_URL}/games/steam/${SGDB_PROBE_APP_ID}`,
        { headers: { Authorization: `Bearer ${key}` } },
        REQUEST
      )
    )
    if (body?.success === true) return valid(tMain('mainScrapers.sgdb.works'))
    return cannotCheck(
      'steamgriddb',
      new CheckError(tMain('mainScrapers.check.unexpectedResponse'))
    )
  } catch (err) {
    if (err instanceof HttpError) {
      // Only SteamGridDB's own JSON verdict counts: Cloudflare answers 403 with an HTML page for its own reasons.
      const body = record(parseJson(err.body))
      if (body && body.success === false) {
        if (err.status === 401 || err.status === 403) {
          const errors = Array.isArray(body.errors) ? body.errors : []
          const reason =
            typeof errors[0] === 'string' ? errors[0] : tMain('mainScrapers.sgdb.rejected')
          return invalid(tMain('mainScrapers.sgdb.doesNotWork', { reason }))
        }
        // Auth is checked before the lookup, so SteamGridDB's own 404 still means the key was accepted.
        if (err.status === 404) return valid(tMain('mainScrapers.sgdb.works'))
      }
    }
    return cannotCheck('steamgriddb', err)
  }
}

// --- IGDB: Twitch client-credentials token ------------------------------------------------------------------------

async function checkIgdb({
  clientId,
  clientSecret
}: ServiceCredentials<'igdb'>): Promise<CredentialCheck> {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (!id || !secret) return unchecked(tMain('mainScrapers.igdb.enterBoth'))
  let token: string
  try {
    const body = record(
      await httpJson<unknown>(
        TWITCH_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: id,
            client_secret: secret,
            grant_type: 'client_credentials'
          }).toString()
        },
        REQUEST
      )
    )
    if (typeof body?.access_token !== 'string' || !body.access_token) {
      return cannotCheck('igdb', new CheckError(tMain('mainScrapers.igdb.unexpectedTwitch')))
    }
    token = body.access_token
  } catch (err) {
    // Twitch answers 400 "invalid client" for an unknown id and 403 "invalid client secret" for a wrong secret,
    // always as JSON with a message.
    if (
      err instanceof HttpError &&
      [400, 401, 403].includes(err.status) &&
      typeof record(parseJson(err.body))?.message === 'string'
    ) {
      return invalid(tMain('mainScrapers.igdb.rejected'))
    }
    return cannotCheck('igdb', err)
  }
  // The scraper mints its own token; don't leave this one outstanding against the app's token allowance.
  void httpText(
    TWITCH_REVOKE_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, token }).toString()
    },
    REQUEST
  ).catch(() => undefined)
  return valid(tMain('mainScrapers.igdb.works'))
}

// --- ScreenScraper: account info (user + developer) or server info (developer only) -------------------------------

type ScreenScraperLogin = 'developer' | 'user'

/** Which login ScreenScraper's plain-text error names, with or without accents ("développeur" / "developpeur"). */
function screenScraperLoginError(text: string | undefined): ScreenScraperLogin | undefined {
  if (!text) return undefined
  const plain = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  if (!/erreur de login/i.test(plain)) return undefined
  if (/developpeur/i.test(plain)) return 'developer'
  if (/utilisateur|membre/i.test(plain)) return 'user'
  return undefined
}

type ScreenScraperOutcome =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'login'; login: ScreenScraperLogin }
  | { kind: 'error'; err: unknown }

async function screenScraperCall(
  endpoint: string,
  params: Record<string, string>
): Promise<ScreenScraperOutcome> {
  const url = buildUrl(`${SCREENSCRAPER_BASE_URL}/${endpoint}`, {
    softname: SCREENSCRAPER_SOFTNAME,
    output: 'json',
    ...params
  })
  let text: string
  try {
    text = await httpText(url, {}, REQUEST)
  } catch (err) {
    const login = err instanceof HttpError ? screenScraperLoginError(err.body) : undefined
    return login ? { kind: 'login', login } : { kind: 'error', err }
  }
  // Login errors also arrive as a plain-text 200 under an application/json content type.
  const login = screenScraperLoginError(text)
  if (login) return { kind: 'login', login }
  const body = record(record(parseJson(text))?.response)
  return body
    ? { kind: 'ok', body }
    : { kind: 'error', err: new CheckError(tMain('mainScrapers.check.unreadable')) }
}

async function checkScreenScraper(
  credentials: ServiceCredentials<'screenscraper'>
): Promise<CredentialCheck> {
  const devId = credentials.devId.trim()
  const devPassword = credentials.devPassword.trim()
  const user = credentials.user.trim()
  // Same trimming as the scraper: the password is sent as typed.
  const password = credentials.password
  if (!devId || !devPassword) {
    return unchecked(tMain('mainScrapers.ss.needDev'))
  }
  if (Boolean(user) !== Boolean(password)) {
    return unchecked(tMain('mainScrapers.ss.enterBoth'))
  }
  const dev = { devid: devId, devpassword: devPassword }
  const devOnly = (): Promise<ScreenScraperOutcome> => screenScraperCall('ssinfraInfos.php', dev)

  if (!user) {
    const outcome = await devOnly()
    if (outcome.kind === 'ok') return valid(tMain('mainScrapers.ss.devWorks'))
    if (outcome.kind === 'login') {
      return invalid(tMain('mainScrapers.ss.devRejected'))
    }
    return cannotCheck('screenscraper', outcome.err)
  }

  const outcome = await screenScraperCall('ssuserInfos.php', {
    ...dev,
    ssid: user,
    sspassword: password
  })
  if (outcome.kind === 'ok') {
    const ssuser = record(outcome.body.ssuser)
    if (ssuser && String(ssuser.niveau ?? '') !== '0' && ssuser.id !== undefined) {
      return valid(tMain('mainScrapers.ss.bothWork'))
    }
    if (ssuser) return invalid(tMain('mainScrapers.ss.userRejected'))
    return cannotCheck('screenscraper', new CheckError(tMain('mainScrapers.check.unreadable')))
  }
  if (outcome.kind === 'error') return cannotCheck('screenscraper', outcome.err)
  if (outcome.login === 'developer') {
    return invalid(tMain('mainScrapers.ss.devRejected'))
  }
  // ssuserInfos names the user login even when the developer pair is the wrong one: ask about that pair alone.
  const devCheck = await devOnly()
  if (devCheck.kind === 'login') {
    return invalid(tMain('mainScrapers.ss.devRejected'))
  }
  if (devCheck.kind === 'error') return cannotCheck('screenscraper', devCheck.err)
  return invalid(tMain('mainScrapers.ss.userRejected'))
}

// --- TheGamesDB: one platform record (costs one request of the monthly allowance) ---------------------------------

async function checkTheGamesDb({
  apiKey
}: ServiceCredentials<'thegamesdb'>): Promise<CredentialCheck> {
  const key = apiKey.trim()
  // An empty key gets an undocumented 418 instead of an answer about the key.
  if (!key) return unchecked(tMain('mainScrapers.tgdb.enterKey'))
  try {
    const body = record(
      await httpJson<unknown>(
        buildUrl(`${TGDB_BASE_URL}/v1/Platforms/ByPlatformID`, { apikey: key, id: 1 }),
        {},
        REQUEST
      )
    )
    if (typeof body?.remaining_monthly_allowance !== 'number') {
      return cannotCheck(
        'thegamesdb',
        new CheckError(tMain('mainScrapers.check.unexpectedResponse'))
      )
    }
    const left =
      body.remaining_monthly_allowance +
      (typeof body.extra_allowance === 'number' ? body.extra_allowance : 0)
    return left > 0
      ? valid(tMain('mainScrapers.tgdb.worksLeft', { left }))
      : valid(tMain('mainScrapers.tgdb.worksUsedUp'))
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      const status = record(parseJson(err.body))?.status
      if (typeof status === 'string') {
        return /invalid api key/i.test(status)
          ? invalid(tMain('mainScrapers.tgdb.invalid'))
          : unchecked(tMain('mainScrapers.tgdb.refused'))
      }
    }
    return cannotCheck('thegamesdb', err)
  }
}

// --- Steam: player summary for the SteamID64 (or a public account while it is still empty) ------------------------

interface PlayerSummaries {
  response?: { players?: { steamid?: string; personaname?: string }[] }
}

async function checkSteam({
  apiKey,
  steamId64
}: ServiceCredentials<'steam'>): Promise<CredentialCheck> {
  const key = apiKey.trim()
  const id = steamId64.trim()
  if (id && !STEAM_ID64.test(id)) {
    return invalid(tMain('mainScrapers.steam.badId'))
  }
  if (!key) return unchecked(tMain('mainScrapers.steam.enterKey'))
  let players: { steamid?: string; personaname?: string }[]
  try {
    const body = await httpJson<PlayerSummaries>(
      buildUrl(`${STEAM_WEB_API}/ISteamUser/GetPlayerSummaries/v2/`, {
        key,
        steamids: id || STEAM_PROBE_ID64
      }),
      {},
      REQUEST
    )
    if (!Array.isArray(body?.response?.players)) {
      return cannotCheck('steam', new CheckError(tMain('mainScrapers.check.unexpectedResponse')))
    }
    players = body.response.players
  } catch (err) {
    // Steam's own refusal is a short HTML page ("Access is denied. ... verify your key= parameter"): 403 here,
    // 401 on other interfaces.
    if (
      err instanceof HttpError &&
      (err.status === 401 || err.status === 403) &&
      /access is denied|verify your/i.test(err.body ?? '')
    ) {
      return invalid(tMain('mainScrapers.steam.rejected'))
    }
    return cannotCheck('steam', err)
  }
  if (!id) return valid(tMain('mainScrapers.steam.enterId'))
  const player = players.find((p) => p.steamid === id)
  if (!player) return invalid(tMain('mainScrapers.steam.noAccount'))
  const persona = player.personaname?.trim().slice(0, 40)
  return valid(
    persona
      ? tMain('mainScrapers.steam.bothWorkPersona', { persona })
      : tMain('mainScrapers.steam.bothWork')
  )
}

async function checkRetroAchievements({
  username,
  apiKey
}: ServiceCredentials<'retroachievements'>): Promise<CredentialCheck> {
  const user = username.trim()
  const key = apiKey.trim()
  if (!user || !key) return unchecked(tMain('mainScrapers.ra.enterBoth'))
  try {
    const profile = await raProfile(
      { username: user, apiKey: key },
      { direct: true, http: REQUEST }
    )
    if (!profile) return invalid(tMain('mainScrapers.ra.noUser', { user: user.slice(0, 40) }))
    return valid(tMain('mainScrapers.ra.signedIn', { user: profile.user.slice(0, 40) }))
  } catch (err) {
    if (err instanceof RaAuthError) return invalid(tMain('mainScrapers.ra.rejected'))
    return cannotCheck('retroachievements', err)
  }
}
