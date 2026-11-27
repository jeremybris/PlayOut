/**
 * The PlayOut database's rate-limit counters (/contribute), in one Durable Object (binding DB_LIMITS).
 *
 * The suggestions count in Workers KV, which is eventually consistent and has no atomic increment: requests sent at
 * the same moment all read the same count and all pass. That is fine where a pull request review follows, but a
 * contribution is committed straight to the database branch. A Durable Object runs one request at a time and
 * holds its input gate while it waits on its own storage, so reading a counter and writing it back happen together:
 * a limit of N lets exactly N contributions through, however many arrive at once. It also keeps these counters out of
 * the KV namespace, whose writes (free plan: 1,000 a day) the suggestions need.
 *
 * The counting itself is ratelimit.ts's (peekRateLimit, takeRateLimit, countTurnedAway), run inside the object over
 * its storage. Every counter belongs to the current clock hour, so the storage is emptied when the hour moves on.
 */

import {
  countTurnedAway,
  DB_RATE_LIMIT_PREFIX,
  hourOf,
  peekRateLimit,
  takeRateLimit,
  type CounterStore,
  type RateLimitConfig,
  type RateLimitResult
} from './ratelimit'

/**
 * What a request asks: 'peek' reads only, 'take' checks and counts one contribution, 'turned-away' counts one refusal,
 * 'turned-away-address' counts one against the sender's address only (an honest answer, not a probe).
 */
export type DbLimitOp = 'peek' | 'take' | 'turned-away' | 'turned-away-address'

const OPS: readonly DbLimitOp[] = ['peek', 'take', 'turned-away', 'turned-away-address']

interface DbLimitRequest {
  op: DbLimitOp
  ip: string
  clientId: string
  limits: RateLimitConfig
  now: number
}

/** The name of the one object every relay instance counts in (all contributions share the global limit). */
export const DB_LIMITER_NAME = 'playout-database'
/** The object the recompilation suggestions (/suggest-recomp) count in: the same class, counters of their own. */
export const RECOMP_LIMITER_NAME = 'playout-recomps'

/** The storage key of the clock hour the stored counters belong to. */
const HOUR_KEY = 'hour'

function isRequest(x: unknown): x is DbLimitRequest {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  const limits = r.limits as Record<string, unknown> | null
  return (
    OPS.includes(r.op as DbLimitOp) &&
    typeof r.ip === 'string' &&
    typeof r.clientId === 'string' &&
    typeof r.now === 'number' &&
    Number.isFinite(r.now) &&
    typeof limits === 'object' &&
    limits !== null &&
    ['ipPerHour', 'ip48PerHour', 'clientPerHour', 'globalPerHour'].every(
      (k) => typeof limits[k] === 'number'
    ) &&
    (limits.turnedAwayGlobalPerHour === undefined ||
      typeof limits.turnedAwayGlobalPerHour === 'number')
  )
}

/** The Durable Object class (wrangler.toml: durable_objects binding DB_LIMITS, migration new_sqlite_classes). */
export class DbRateLimiter implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env?: unknown
  ) {}

  /** The counters of the request's hour; older hours' counters are deleted first. */
  private async storeFor(now: number): Promise<CounterStore> {
    const storage = this.state.storage
    const hour = hourOf(now)
    const stored = await storage.get<number>(HOUR_KEY)
    if (stored === undefined || stored < hour) {
      await storage.deleteAll()
      await storage.put(HOUR_KEY, hour)
    }
    return {
      get: async (key) => (await storage.get<string>(key)) ?? null,
      // The TTL is KV's; here the hour's change empties the storage instead.
      put: (key, value) => storage.put(key, value)
    }
  }

  async fetch(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      body = null
    }
    if (!isRequest(body)) return new Response('bad request', { status: 400 })
    const { op, ip, clientId, limits, now } = body
    const store = await this.storeFor(now)
    let result: RateLimitResult = { ok: true }
    if (op === 'peek') {
      result = await peekRateLimit(store, ip, clientId, limits, now, DB_RATE_LIMIT_PREFIX)
    } else if (op === 'take') {
      result = await takeRateLimit(store, ip, clientId, limits, now, DB_RATE_LIMIT_PREFIX)
    } else {
      await countTurnedAway(
        store,
        ip,
        limits,
        now,
        DB_RATE_LIMIT_PREFIX,
        op === 'turned-away-address'
      )
    }
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }
}

/** One /contribute request's view of the counters: its address, PlayOut install, limits and clock. */
export interface DbLimits {
  peek(): Promise<RateLimitResult>
  take(): Promise<RateLimitResult>
  turnedAway(): Promise<void>
  /** A refusal counted against the sender's address only. */
  turnedAwayAddress(): Promise<void>
}

/**
 * Asks the DB_LIMITS Durable Object (`name`: which one; the database's by default); throws when it cannot answer (the
 * caller treats that as a failure).
 */
export function dbLimitsOf(
  ns: DurableObjectNamespace,
  ip: string,
  clientId: string,
  limits: RateLimitConfig,
  now: number,
  name: string = DB_LIMITER_NAME
): DbLimits {
  const stub = ns.get(ns.idFromName(name))
  const ask = async (op: DbLimitOp): Promise<RateLimitResult> => {
    const res = await stub.fetch('https://db-limits.internal/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ip, clientId, limits, now } satisfies DbLimitRequest)
    })
    if (!res.ok) throw new Error(`rate-limit counters answered ${res.status}`)
    const r = (await res.json()) as RateLimitResult
    if (r.ok) return { ok: true }
    return {
      ok: false,
      retryAfter: Math.max(1, Number(r.retryAfter) || 3600),
      scope: String(r.scope)
    }
  }
  return {
    peek: () => ask('peek'),
    take: () => ask('take'),
    turnedAway: async () => {
      await ask('turned-away')
    },
    turnedAwayAddress: async () => {
      await ask('turned-away-address')
    }
  }
}
