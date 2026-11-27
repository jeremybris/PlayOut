// A Steam game's DLC from public, keyless sources:
// - api.steamcmd.net mirrors Steam's own app info: `extended.listofdlc` lists the DLC, each depot with `dlcappid`
//   is that DLC's content (Windows / English or language-neutral depots, public branch, as store-sizes.ts counts a
//   game), `config.optionaldlc` marks opt-in content and `depots.appmanagesdlc` a game that manages its DLC itself.
// - Steam's IStoreBrowseService/GetItems names them, 100 a request.
import {
  STEAM_ITEMS_URL,
  STEAM_REVIEWS_BATCH,
  steamReviewsLimiter
} from '../scrapers/review-scores'
import { httpJson } from '../scrapers/http'
import { STEAMCMD_INFO, steamcmdLimiter } from '../scrapers/store-sizes'
import { parseIdList } from './acf'

export interface SteamcmdDlc {
  appId: number
  /** Bytes of its Windows content; null when it has no depot of its own (it only unlocks). */
  sizeBytes: number | null
  /** Opt-in content or DLC the game manages itself: only Steam's own page changes it. */
  steamOnly: boolean
}

interface Depot {
  config?: {
    oslist?: string
    language?: string
    osarch?: string
    lowviolence?: string
    optionaldlc?: string
  }
  manifests?: { public?: { size?: string | number } | string }
  dlcappid?: string | number
}

interface AppInfo {
  extended?: { listofdlc?: string }
  depots?: Record<string, unknown>
}

export interface SteamcmdAnswer {
  status?: string
  data?: Record<string, AppInfo>
}

/** The game's DLC from its steamcmd app info, in the order Steam lists them (unlisted DLC with depots last). */
export function parseSteamcmdDlc(answer: SteamcmdAnswer, appId: number): SteamcmdDlc[] {
  const info = answer.data?.[String(appId)]
  const ids = parseIdList(info?.extended?.listofdlc).filter((id) => id !== appId)
  const depots = info?.depots ?? {}
  const appManages = String((depots as Record<string, unknown>).appmanagesdlc ?? '') === '1'
  const sizes = new Map<number, { size: number; arch?: string }[]>()
  const optional = new Set<number>()
  for (const [key, raw] of Object.entries(depots)) {
    if (!/^\d+$/.test(key) || !raw || typeof raw !== 'object') continue
    const depot = raw as Depot
    const opt = Number(depot.config?.optionaldlc)
    if (Number.isInteger(opt) && opt > 0) optional.add(opt)
    const dlc = Number(depot.dlcappid)
    if (!Number.isInteger(dlc) || dlc <= 0 || dlc === appId) continue
    if (!ids.includes(dlc)) ids.push(dlc)
    const config = depot.config ?? {}
    const os = config.oslist?.trim()
    if (os && !os.split(',').includes('windows')) continue
    const language = config.language?.trim()
    if (language && language !== 'english') continue
    if (config.lowviolence === '1') continue
    const manifest = depot.manifests?.public
    const size = Number(typeof manifest === 'object' ? manifest?.size : undefined)
    if (!Number.isFinite(size) || size <= 0) continue
    const list = sizes.get(dlc) ?? []
    list.push({ size, arch: config.osarch?.trim() })
    sizes.set(dlc, list)
  }
  return ids.map((id) => {
    const list = sizes.get(id) ?? []
    // A DLC that ships 32- and 64-bit depots installs the 64-bit ones on a 64-bit Windows.
    const has64 = list.some((d) => d.arch === '64')
    const total = list.filter((d) => !(has64 && d.arch === '32')).reduce((s, d) => s + d.size, 0)
    return {
      appId: id,
      sizeBytes: total > 0 ? total : null,
      steamOnly: appManages || optional.has(id)
    }
  })
}

/** The DLC of a Steam app from api.steamcmd.net. Throws on network errors and on steamcmd.net's own failures. */
export async function fetchSteamcmdDlc(appId: number): Promise<SteamcmdDlc[]> {
  const answer = await httpJson<SteamcmdAnswer>(
    `${STEAMCMD_INFO}/${appId}`,
    {},
    { timeoutMs: 20_000, retries: 1, limiter: steamcmdLimiter }
  )
  if (answer?.status !== 'success')
    throw new Error(`api.steamcmd.net: ${answer?.status ?? 'no answer'}`)
  return parseSteamcmdDlc(answer, appId)
}

interface ItemsAnswer {
  response?: { store_items?: { appid?: number; id?: number; name?: string; success?: number }[] }
}

/** App id -> store name from a GetItems answer (items Steam does not know are left out). */
export function parseItemNames(answer: ItemsAnswer): Map<number, string> {
  const names = new Map<number, string>()
  for (const item of answer.response?.store_items ?? []) {
    const id = item.appid ?? item.id
    const name = item.name?.trim()
    if (typeof id === 'number' && name && (item.success === undefined || item.success === 1))
      names.set(id, name)
  }
  return names
}

export function itemNamesUrl(appIds: readonly number[]): string {
  const input = {
    ids: appIds.map((appid) => ({ appid })),
    context: { language: 'english', country_code: 'US' },
    data_request: {}
  }
  return `${STEAM_ITEMS_URL}?input_json=${encodeURIComponent(JSON.stringify(input))}`
}

/** Store names of Steam apps, 100 a request. Throws on network errors. */
export async function fetchItemNames(appIds: readonly number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  for (let i = 0; i < appIds.length; i += STEAM_REVIEWS_BATCH) {
    const batch = appIds.slice(i, i + STEAM_REVIEWS_BATCH)
    const answer = await httpJson<ItemsAnswer>(
      itemNamesUrl(batch),
      {},
      { timeoutMs: 20_000, retries: 1, limiter: steamReviewsLimiter }
    )
    for (const [id, name] of parseItemNames(answer)) names.set(id, name)
  }
  return names
}
