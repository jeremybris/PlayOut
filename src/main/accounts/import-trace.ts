// logs/store-import.log: one line per HTTP attempt of a store's owned-library import and one outcome line per
// import, so an import that failed ("HTTP 502 Bad Gateway") shows which endpoint answered what, how fast, and
// whether the retries were spent. Never holds a credential: the query string is dropped and the body excerpt of a
// failed answer is redacted.
import type { HttpAttempt } from '../scrapers/http'
import { describeError, redactSecrets } from './types'

const BODY_CHARS = 200

/** Host + path of a URL, without its query string (where API keys and tokens travel). */
export function endpointOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return url.split(/[?#]/)[0]
  }
}

/** Drop the query string (and fragment) of every URL inside a text: account ids such as `steamid=` travel there. */
export function stripUrlQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#)"']+)[?#][^\s)"']*/g, '$1')
}

/** An error for an outcome line of the trace: credentials masked and every URL reduced to host + path. */
export function describeForTrace(err: unknown): string {
  return stripUrlQueries(describeError(err))
}

/**
 * "steam GET api.steampowered.com/IPlayerService/GetOwnedGames/v1/ attempt 1/4: HTTP 502 Bad Gateway, 312 ms,
 * 157 bytes, retry in 2000 ms, body: "<html>..."".
 */
export function formatAttempt(source: string, a: HttpAttempt): string {
  const parts: string[] = []
  parts.push(
    a.status
      ? `HTTP ${a.status}${a.statusText ? ` ${a.statusText}` : ''}`
      : stripUrlQueries(redactSecrets(a.error ?? 'no answer'))
  )
  parts.push(`${a.durationMs} ms`)
  if (a.bytes !== undefined) parts.push(`${a.bytes} bytes`)
  if (a.retryAfter) parts.push(`retry-after ${redactSecrets(a.retryAfter).slice(0, 40)}`)
  if (a.retryInMs !== undefined) parts.push(`retry in ${a.retryInMs} ms`)
  if (a.body) {
    const excerpt = redactSecrets(a.body).replace(/\s+/g, ' ').trim().slice(0, BODY_CHARS)
    if (excerpt) parts.push(`body: ${JSON.stringify(excerpt)}`)
  }
  return `${source} ${a.method} ${endpointOf(a.url)} attempt ${a.attempt}/${a.attempts}: ${parts.join(', ')}`
}
