// Sizes of games that are not installed, from public APIs that need no key (ARCHITECTURE.md §4.11).
// - Steam: api.steamcmd.net mirrors Steam's own app info (what the Steam client reads before an install): every depot
//   with its installed size. The Windows depots the client would install for an English user add up to the install.
// - GOG: the product API lists each installer with its total size (the download; the install is about the same).
// Epic's sizes need the Epic sign-in (epic-sizes.ts); EA, Ubisoft, Battle.net and Xbox publish nothing comparable.
import { buildUrl, httpJson, RateLimiter } from './http'

export const STEAMCMD_INFO = 'https://api.steamcmd.net/v1/info'
const GOG_PRODUCT = 'https://api.gog.com/products'

// A free community service and a public API: one request at a time, well apart.
export const steamcmdLimiter = new RateLimiter(4, 4)
const gogLimiter = new RateLimiter(4, 4)

interface SteamDepot {
  config?: {
    oslist?: string
    language?: string
    osarch?: string
    lowviolence?: string
    steamdeck?: string
  }
  manifests?: { public?: { size?: string | number } | string }
  dlcappid?: string
  optional?: string
  sharedinstall?: string
  depotfromapp?: string
}

interface SteamcmdInfo {
  status?: string
  data?: Record<string, { depots?: Record<string, SteamDepot | unknown> }>
}

/**
 * The bytes the Steam client installs for `appId` on Windows in English: the base game's depots (no DLC, optional,
 * shared redistributable or other-language depots), the 64-bit ones when the game ships both. undefined when Steam
 * lists no such depot (a game Steam can't install, an app with private depots).
 */
export function steamInstallBytes(
  depots: Record<string, SteamDepot | unknown> | undefined
): number | undefined {
  if (!depots) return undefined
  /** `windows`: the depot says it is for Windows (an OS list naming it); the others say nothing about their OS. */
  const usable: { arch?: string; size: number; windows: boolean }[] = []
  // A depot borrowed from another app (an edition reusing the original's content) lists no size here: the sum would
  // be a small fraction of the install, so there is no exact answer.
  let borrowed = false
  for (const [key, raw] of Object.entries(depots)) {
    if (!/^\d+$/.test(key) || !raw || typeof raw !== 'object') continue
    const depot = raw as SteamDepot
    // Shared redistributables (DirectX, VC++) are installed once for every game; not this game's size.
    if (depot.dlcappid || depot.optional === '1' || depot.sharedinstall === '1') continue
    const config = depot.config ?? {}
    const os = config.oslist?.trim()
    if (os && !os.split(',').includes('windows')) continue
    const language = config.language?.trim()
    if (language && language !== 'english') continue
    if (config.lowviolence === '1') continue
    // The Steam Deck's own build of the game (METAL GEAR SOLID 2 Master Collection ships one beside the Windows
    // depots): a Windows PC never downloads it.
    if (config.steamdeck === '1') continue
    if (depot.depotfromapp) {
      borrowed = true
      continue
    }
    const manifest = depot.manifests?.public
    const size = Number(typeof manifest === 'object' ? manifest?.size : undefined)
    if (!Number.isFinite(size) || size <= 0) continue
    usable.push({ arch: config.osarch?.trim(), size, windows: !!os })
  }
  const has64 = usable.some((d) => d.arch === '64')
  const kept = withoutAlternativeCopies(usable.filter((d) => !(has64 && d.arch === '32')))
  const total = kept.reduce((sum, d) => sum + d.size, 0)
  return total > 0 && !borrowed ? total : undefined
}

/** How close in size to the Windows depot an unmarked depot must be to look like another copy of the whole game. */
const COPY_MIN_SHARE = 0.5
const COPY_MAX_SHARE = 2

/**
 * Drops the depots that are other versions of the game rather than parts of it. Some games (Black Desert: one depot
 * marked Windows, 94.6 GB, and eight unmarked ones of 62-97 GB, its regional clients) list every version's files as
 * depots with nothing to tell them apart; Steam installs only the ones in the package the account owns, which the
 * app info does not say. When a depot is marked for Windows and two or more unmarked depots are each about its size
 * (half to double), the unmarked ones are taken for such copies and only the Windows depots are counted.
 *
 * A game split into parts keeps all of them: its Windows depot is usually the small program and the unmarked ones the
 * much larger content (Call of Duty: Modern Warfare Remastered: 0.03 GB against 4.6-35 GB; Wolfenstein II, Dota 2),
 * or there is a single unmarked content depot. Checked against 400 Steam games of a real library.
 */
function withoutAlternativeCopies<T extends { size: number; windows: boolean }>(depots: T[]): T[] {
  const marked = depots.filter((d) => d.windows)
  const unmarked = depots.filter((d) => !d.windows)
  if (!marked.length || unmarked.length < 2) return depots
  const largestMarked = Math.max(...marked.map((d) => d.size))
  const copies = unmarked.every(
    (d) => d.size >= largestMarked * COPY_MIN_SHARE && d.size <= largestMarked * COPY_MAX_SHARE
  )
  return copies ? marked : depots
}

/** Installed size of a Steam app from api.steamcmd.net; undefined when it lists none. Throws on network errors. */
export async function steamcmdInstallSize(appId: number): Promise<number | undefined> {
  await steamcmdLimiter.take()
  const info = await httpJson<SteamcmdInfo>(
    `${STEAMCMD_INFO}/${appId}`,
    {},
    {
      timeoutMs: 20_000,
      retries: 1
    }
  )
  // steamcmd.net reports its own failures (Steam unreachable) as status 'failed': a failure, not "no size".
  if (info?.status !== 'success')
    throw new Error(`api.steamcmd.net: ${info?.status ?? 'no answer'}`)
  return steamInstallBytes(info.data?.[String(appId)]?.depots)
}

interface GogProduct {
  downloads?: {
    installers?: { os?: string; language?: string; total_size?: number }[]
  }
}

/** The size of a GOG game's Windows installer (English when there is a choice); undefined when GOG lists none. */
export function gogInstallerBytes(product: GogProduct | null | undefined): number | undefined {
  const windows = (product?.downloads?.installers ?? []).filter(
    (i) => i.os === 'windows' && typeof i.total_size === 'number' && i.total_size > 0
  )
  const pick = windows.find((i) => i.language === 'en') ?? windows[0]
  return pick?.total_size
}

/** The installer size of a GOG product; undefined when GOG lists none or has no such product. */
export async function gogInstallSize(productId: string): Promise<number | undefined> {
  if (!/^\d+$/.test(productId)) return undefined
  await gogLimiter.take()
  let product: GogProduct | null
  try {
    product = await httpJson<GogProduct>(
      buildUrl(`${GOG_PRODUCT}/${productId}`, { expand: 'downloads' }),
      {},
      { timeoutMs: 20_000, retries: 1 }
    )
  } catch (err) {
    // A product GOG no longer sells answers 404: no size, not a failure to retry.
    if (err && typeof err === 'object' && 'status' in err && err.status === 404) return undefined
    throw err
  }
  return gogInstallerBytes(product)
}

const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/'
// Shares Steam's unofficial store limit (about 200 calls per 5 minutes) with appdetails; stay far below it.
const searchLimiter = new RateLimiter(0.5, 1)

interface StoreSearch {
  items?: { type?: string; name?: string; id?: number }[]
}

/**
 * A title reduced for comparing the same game across stores: no trademark signs, edition-neutral punctuation, case
 * or accents. "DOOM Eternal™" and "Doom Eternal" match; "Hades" and "Hades II" do not.
 */
export function sameGameKey(title: string): string {
  // The signs go first: NFKD would turn ™ into the letters "TM".
  return title
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * The Steam app with exactly this title (Steam's store search, keyless); undefined when Steam sells no game by that
 * name. Only an exact title match counts: a sequel or a bundle with a longer name is not the same game.
 */
export async function steamAppIdByTitle(title: string): Promise<number | undefined> {
  const key = sameGameKey(title)
  if (!key) return undefined
  await searchLimiter.take()
  const result = await httpJson<StoreSearch>(
    buildUrl(STEAM_SEARCH, { term: title, l: 'english', cc: 'US' }),
    {},
    { timeoutMs: 15_000, retries: 1 }
  )
  const matches = (result?.items ?? []).filter(
    (i) => i.type === 'app' && typeof i.id === 'number' && sameGameKey(i.name ?? '') === key
  )
  // Two Steam games with the same name (a remake and its original, "Dead Space" 2008 / 2023): no way to tell which
  // one this is, so no size rather than the wrong one.
  return matches.length === 1 ? matches[0].id : undefined
}
