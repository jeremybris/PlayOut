/**
 * Rate limiting with a Workers KV namespace (binding RATE_LIMIT), counted per clock hour: per IP (IPv6 per /64, see
 * ipBucket), per IPv6 /48 (ipBlock48: one subscriber or cloud host that rotates /64s inside its delegation), per
 * PlayOut clientId and in total (a cap on everyone, against spam from many addresses).
 *
 * KV rather than the Rate Limiting binding: KV works on the free plan with no beta flags and its limits can be per
 * hour (the Rate Limiting binding only counts over 10 or 60 seconds). KV is eventually consistent, so a burst
 * from several Cloudflare locations at once can pass a few requests over the limit; that is fine here, every
 * suggestion still needs the owner's approval. Each accepted request costs 3 KV writes (4 from IPv6; free plan:
 * 1,000 a day).
 *
 * A request is counted once, by what became of it. One that opens a pull request counts as a suggestion
 * (takeRateLimit). One the relay turns away after asking GitHub about it (too many suggestions wait for review, the
 * suggestion matches the cloud record already, GitHub failed) counts in counters of its own (countTurnedAway: 2 KV
 * writes, 3 from IPv6), so it takes nothing from the sender's suggestions and still cannot be repeated without end:
 * each one costs the relay up to three GitHub calls. peekRateLimit reads both sets before GitHub is asked anything.
 */

/**
 * The rate-limit bucket of a client address. IPv4 counts per address. IPv6 counts per /64: one home or cloud
 * machine usually holds a whole /64 and could use a fresh address for every request, so the first four hextets of the
 * expanded address are the key. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) counts as that IPv4 address. Anything
 * unparsable shares one 'unknown' bucket.
 */
export function ipBucket(ip: string | null | undefined): string {
  const raw = (ip ?? '').trim()
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split('.').map(Number)
    return parts.every((p) => p <= 255) ? `v4:${parts.join('.')}` : 'unknown'
  }
  const hextets = expandIpv6(raw)
  if (!hextets) return 'unknown'
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return `v4:${hextets[6] >> 8}.${hextets[6] & 255}.${hextets[7] >> 8}.${hextets[7] & 255}`
  }
  return `v6:${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(':')}::/64`
}

/**
 * The /48 an IPv6 client address lies in (the first three hextets), or null for IPv4 (also IPv4-mapped) and
 * unparsable addresses. ISPs delegate a /56 or /60 to a home and cloud providers often a /48, so a per-/64 limit
 * alone lets one subscriber rotate through hundreds of /64s.
 */
export function ipBlock48(ip: string | null | undefined): string | null {
  const bucket = ipBucket(ip)
  if (!bucket.startsWith('v6:')) return null
  return `${bucket
    .slice(0, bucket.length - '::/64'.length)
    .split(':')
    .slice(0, 4)
    .join(':')}::/48`
}

/** The eight 16-bit groups of an IPv6 address (with '::' and an embedded IPv4 tail); null when it is not one. */
function expandIpv6(input: string): number[] | null {
  let s = input
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null
  const v4 = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4) {
    const p = v4[2].split('.').map(Number)
    if (p.some((x) => x > 255)) return null
    s = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`
  }
  if (s.includes('.')) return null
  const halves = s.split('::')
  if (halves.length > 2) return null
  const group = (part: string): string[] => (part === '' ? [] : part.split(':'))
  const head = group(halves[0])
  const tail = halves.length === 2 ? group(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null
  return all.map((h) => parseInt(h, 16))
}

export interface RateLimitConfig {
  ipPerHour: number
  /** Per IPv6 /48 (IPv4 has no such bucket). */
  ip48PerHour: number
  clientPerHour: number
  globalPerHour: number
  /**
   * The global counter of requests turned away, when it differs from `globalPerHour` (/suggest-recomp: a refusal
   * costs a few GitHub reads, so a handful of addresses must not block every honest request for the hour).
   */
  turnedAwayGlobalPerHour?: number
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number; scope: string }

interface Bucket {
  scope: string
  key: string
  limit: number
}

/** The clock hour `now` (ms) lies in: every counter counts within one. */
export const hourOf = (now: number): number => Math.floor(now / 3_600_000)

/**
 * Where the counters live: the RATE_LIMIT KV namespace for suggestions, the database's Durable Object (db-limiter.ts)
 * for contributions. Only these two calls are used, and KVNamespace has both.
 */
export interface CounterStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>
}

/** The counters of accepted suggestions. */
function suggestionBuckets(
  ip: string,
  clientId: string,
  config: RateLimitConfig,
  hour: number,
  prefix: string
): Bucket[] {
  const block = ipBlock48(ip)
  return [
    { scope: 'ip', key: `${prefix}rl:ip:${ipBucket(ip)}:${hour}`, limit: config.ipPerHour },
    ...(block
      ? [{ scope: 'ip48', key: `${prefix}rl:ip48:${block}:${hour}`, limit: config.ip48PerHour }]
      : []),
    { scope: 'client', key: `${prefix}rl:client:${clientId}:${hour}`, limit: config.clientPerHour },
    { scope: 'global', key: `${prefix}rl:global:${hour}`, limit: config.globalPerHour }
  ]
}

/**
 * The counters of requests turned away after GitHub was asked: per address and in total, with the limits of the
 * suggestions. None per clientId: that is the sender's own word, and a fresh one per request would make it no limit.
 */
function turnedAwayBuckets(
  ip: string,
  config: RateLimitConfig,
  hour: number,
  prefix: string
): Bucket[] {
  const block = ipBlock48(ip)
  return [
    { scope: 'ip', key: `${prefix}rl:no:ip:${ipBucket(ip)}:${hour}`, limit: config.ipPerHour },
    ...(block
      ? [{ scope: 'ip48', key: `${prefix}rl:no:ip48:${block}:${hour}`, limit: config.ip48PerHour }]
      : []),
    {
      scope: 'global',
      key: `${prefix}rl:no:global:${hour}`,
      limit: config.turnedAwayGlobalPerHour ?? config.globalPerHour
    }
  ]
}

function readCounts(kv: CounterStore, buckets: Bucket[]): Promise<number[]> {
  return Promise.all(buckets.map(async (b) => Number((await kv.get(b.key)) ?? '0') || 0))
}

/** The first bucket that is full, as the refusal to answer with. */
function firstFull(buckets: Bucket[], counts: number[], now: number): RateLimitResult {
  const retryAfter = Math.max(1, Math.ceil(((hourOf(now) + 1) * 3_600_000 - now) / 1000))
  for (let i = 0; i < buckets.length; i++) {
    if (counts[i] >= buckets[i].limit) return { ok: false, retryAfter, scope: buckets[i].scope }
  }
  return { ok: true }
}

async function addOne(kv: CounterStore, buckets: Bucket[], counts: number[]): Promise<void> {
  // Kept a little past the hour (KV's minimum TTL is 60 s).
  await Promise.all(
    buckets.map((b, i) => kv.put(b.key, String(counts[i] + 1), { expirationTtl: 3_700 }))
  )
}

/**
 * Whether a request may go on to GitHub: no counter of suggestions and none of turned-away requests is full. Reads
 * only, counts nothing; the request is counted by takeRateLimit or countTurnedAway once its outcome is known.
 */
export async function peekRateLimit(
  kv: CounterStore,
  ip: string,
  clientId: string,
  config: RateLimitConfig,
  now: number = Date.now(),
  /** Before every counter's key: 'db:' keeps the PlayOut database's counters apart from the suggestions'. */
  prefix = ''
): Promise<RateLimitResult> {
  const hour = hourOf(now)
  const buckets = [
    ...suggestionBuckets(ip, clientId, config, hour, prefix),
    ...turnedAwayBuckets(ip, config, hour, prefix)
  ]
  return firstFull(buckets, await readCounts(kv, buckets), now)
}

/** Checks and, when allowed, counts one suggestion. `now` in ms (tests pass a fixed clock). */
export async function takeRateLimit(
  kv: CounterStore,
  /** The client address (CF-Connecting-IP); counted per ipBucket(). */
  ip: string,
  clientId: string,
  config: RateLimitConfig,
  now: number = Date.now(),
  prefix = ''
): Promise<RateLimitResult> {
  const buckets = suggestionBuckets(ip, clientId, config, hourOf(now), prefix)
  const counts = await readCounts(kv, buckets)
  const full = firstFull(buckets, counts, now)
  if (!full.ok) return full
  await addOne(kv, buckets, counts)
  return { ok: true }
}

/** Counts one request the relay turned away after asking GitHub about it (peekRateLimit reads these counters). */
export async function countTurnedAway(
  kv: CounterStore,
  ip: string,
  config: RateLimitConfig,
  now: number = Date.now(),
  prefix = '',
  /** Count it against the sender's address only (an honest answer, such as "listed already", not a probe). */
  addressOnly = false
): Promise<void> {
  const all = turnedAwayBuckets(ip, config, hourOf(now), prefix)
  const buckets = addressOnly ? all.filter((b) => b.scope !== 'global') : all
  await addOne(kv, buckets, await readCounts(kv, buckets))
}

/**
 * The limits a deployment without the RATE_*_PER_HOUR variables runs with: the values wrangler.toml deploys, kept
 * equal to them by hand. `clientPerHour` is also what PlayOut paces its waiting edits by and tells the user
 * (src/shared/metadata-cloud.ts RELAY_SUGGESTIONS_PER_HOUR): change the three together.
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  ipPerHour: 40,
  ip48PerHour: 60,
  clientPerHour: 30,
  globalPerHour: 120
}

export function rateLimitConfig(
  env: {
    RATE_IP_PER_HOUR?: string
    RATE_IP48_PER_HOUR?: string
    RATE_CLIENT_PER_HOUR?: string
    RATE_GLOBAL_PER_HOUR?: string
  },
  defaults: RateLimitConfig = DEFAULT_RATE_LIMITS
): RateLimitConfig {
  const n = (v: string | undefined, d: number): number => {
    const x = Number(v)
    return Number.isInteger(x) && x > 0 ? x : d
  }
  return {
    ipPerHour: n(env.RATE_IP_PER_HOUR, defaults.ipPerHour),
    ip48PerHour: n(env.RATE_IP48_PER_HOUR, defaults.ip48PerHour),
    clientPerHour: n(env.RATE_CLIENT_PER_HOUR, defaults.clientPerHour),
    globalPerHour: n(env.RATE_GLOBAL_PER_HOUR, defaults.globalPerHour)
  }
}

/** The key prefix of the PlayOut database's counters (/contribute), kept in its Durable Object (db-limiter.ts). */
export const DB_RATE_LIMIT_PREFIX = 'db:'

/**
 * The limits of /contribute (one request adds up to 25 games) without the RATE_DB_*_PER_HOUR variables: the values
 * wrangler.toml deploys, kept equal to them by hand. Lower than the suggestions': nobody reviews these writes. They
 * are counted in a Durable Object, not in KV, so they hold exactly under concurrent requests and take nothing from
 * the KV namespace's writes (free plan: 1,000 a day) that the suggestions need.
 */
export const DEFAULT_DB_RATE_LIMITS: RateLimitConfig = {
  ipPerHour: 20,
  ip48PerHour: 40,
  clientPerHour: 12,
  globalPerHour: 30
}

export function dbRateLimitConfig(env: {
  RATE_DB_IP_PER_HOUR?: string
  RATE_DB_IP48_PER_HOUR?: string
  RATE_DB_CLIENT_PER_HOUR?: string
  RATE_DB_GLOBAL_PER_HOUR?: string
}): RateLimitConfig {
  return rateLimitConfig(
    {
      RATE_IP_PER_HOUR: env.RATE_DB_IP_PER_HOUR,
      RATE_IP48_PER_HOUR: env.RATE_DB_IP48_PER_HOUR,
      RATE_CLIENT_PER_HOUR: env.RATE_DB_CLIENT_PER_HOUR,
      RATE_GLOBAL_PER_HOUR: env.RATE_DB_GLOBAL_PER_HOUR
    },
    DEFAULT_DB_RATE_LIMITS
  )
}

/**
 * The limits of /suggest-recomp (a recompilation added in PlayOut's browser, opened as a pull request) without the
 * RATE_RECOMP_*_PER_HOUR variables: the values wrangler.toml deploys, kept equal to them by hand. Counted in a
 * DB_LIMITS Durable Object of their own (RECOMP_LIMITER_NAME), apart from the suggestions' KV counters and the
 * database's: each costs the relay up to eight GitHub calls, and a person adds a few recompilations, not dozens.
 */
export const DEFAULT_RECOMP_RATE_LIMITS: RateLimitConfig = {
  ipPerHour: 10,
  ip48PerHour: 15,
  clientPerHour: 5,
  globalPerHour: 30,
  // Refusals in total: far above the accepted ones, so a few addresses sending links that fail the checks cannot
  // block every honest suggestion for the rest of the hour (each refusal costs at most four GitHub reads).
  turnedAwayGlobalPerHour: 400
}

export function recompRateLimitConfig(env: {
  RATE_RECOMP_IP_PER_HOUR?: string
  RATE_RECOMP_IP48_PER_HOUR?: string
  RATE_RECOMP_CLIENT_PER_HOUR?: string
  RATE_RECOMP_GLOBAL_PER_HOUR?: string
  RATE_RECOMP_TURNED_AWAY_GLOBAL_PER_HOUR?: string
}): RateLimitConfig {
  const turnedAway = Number(env.RATE_RECOMP_TURNED_AWAY_GLOBAL_PER_HOUR)
  return {
    ...rateLimitConfig(
      {
        RATE_IP_PER_HOUR: env.RATE_RECOMP_IP_PER_HOUR,
        RATE_IP48_PER_HOUR: env.RATE_RECOMP_IP48_PER_HOUR,
        RATE_CLIENT_PER_HOUR: env.RATE_RECOMP_CLIENT_PER_HOUR,
        RATE_GLOBAL_PER_HOUR: env.RATE_RECOMP_GLOBAL_PER_HOUR
      },
      DEFAULT_RECOMP_RATE_LIMITS
    ),
    turnedAwayGlobalPerHour:
      Number.isInteger(turnedAway) && turnedAway > 0
        ? turnedAway
        : DEFAULT_RECOMP_RATE_LIMITS.turnedAwayGlobalPerHour
  }
}
