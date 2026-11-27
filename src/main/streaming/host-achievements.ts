import { z } from 'zod'
import type { AchievementsInfo } from '../../shared/types'

/**
 * Achievements of a paired host's games. A game both PCs have needs nothing here: the host shares its Steam and
 * RetroAchievements logins (host-logins.ts), so this PC reads the same accounts. A host-only game is not in this PC's
 * library, so its achievements come from the host: a summary (unlocked / total) in the host's offer
 * (remote-library.ts hostOffer, `achievements`), and the full list over `GET /v1/achievements/:gameId`, which the host
 * answers from its achievements service. Both arrive over the network, so they are checked here before use.
 */

/** The host's answer to `GET /v1/achievements/:gameId` is read up to this size. */
export const MAX_ACHIEVEMENTS_BODY_BYTES = 4 * 1024 * 1024
/** Achievements of one game taken at most (the largest Steam games have a few thousand). */
export const MAX_ACHIEVEMENTS = 10_000
/** A count no game reaches: a larger one is a broken answer. */
const MAX_COUNT = 100_000

/** Text of the host's list: cut to this length (a name, a description). */
const text = (max: number): z.ZodType<string> => z.string().transform((s) => s.slice(0, max))
/** Only web addresses, as this PC's own lists have (Steam's and RetroAchievements' images and pages). */
const webUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/i)
const count = z.number().int().min(0).max(MAX_COUNT)

/** Optional fields of an entry: a broken one is left out, the entry is kept. */
const optional = <T>(schema: z.ZodType<T>): z.ZodType<T | undefined> =>
  schema.optional().catch(undefined)

const entrySchema = z.object({
  id: z.string().min(1).max(256),
  name: text(300),
  description: optional(text(1000)),
  unlocked: z.boolean(),
  unlockedAt: optional(
    z
      .string()
      .max(40)
      .refine((s) => Number.isFinite(Date.parse(s)))
  ),
  icon: optional(webUrl),
  hidden: optional(z.boolean()),
  points: optional(count),
  hardcore: optional(z.boolean())
})

const infoSchema = z.object({
  provider: optional(z.enum(['steam', 'retroachievements'])),
  total: count,
  unlocked: count,
  points: optional(z.object({ earned: count, total: count })),
  url: optional(webUrl),
  list: z.array(z.unknown()).max(MAX_ACHIEVEMENTS)
})

/** Drop the keys a broken optional field left as undefined, so the result reads as this PC's own lists do. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/**
 * A host's achievements list as received, checked: null when it is not a list (the host has none, or a broken answer).
 * Broken entries are left out; counts are kept within the list's size.
 */
export function sanitizeAchievementsInfo(raw: unknown): AchievementsInfo | null {
  const parsed = infoSchema.safeParse(raw)
  if (!parsed.success) return null
  const seen = new Set<string>()
  const list: AchievementsInfo['list'] = []
  for (const item of parsed.data.list) {
    const entry = entrySchema.safeParse(item)
    if (!entry.success || seen.has(entry.data.id)) continue
    seen.add(entry.data.id)
    list.push(compact(entry.data) as AchievementsInfo['list'][number])
  }
  const { provider, points, url } = parsed.data
  const total = list.length ? Math.max(parsed.data.total, list.length) : parsed.data.total
  const info: AchievementsInfo = {
    total,
    unlocked: Math.min(parsed.data.unlocked, total),
    list
  }
  if (provider) info.provider = provider
  if (points && points.earned <= points.total) info.points = points
  if (url) info.url = url
  return info
}

/** A game's summary in the host's offer: unlocked of total, or undefined when unusable (or no achievements). */
export function sanitizeAchievementsSummary(
  raw: unknown
): { unlocked: number; total: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { unlocked, total } = raw as Record<string, unknown>
  const ok = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT
  if (!ok(unlocked) || !ok(total) || total === 0 || unlocked > total) return undefined
  return { unlocked, total }
}
