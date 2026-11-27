import { z } from 'zod'
import { defaultSettings, SETTINGS_VERSION } from '../../shared/defaults'
import { nearestCoverScale } from '../../shared/cover-scale'
import { DYNAMIC_FPS, PAD_BUTTONS, POWER_CHOICES } from '../../shared/overlay'
import { HOME_ROW_MODES } from '../../shared/types'
import type {
  CredentialService,
  ScraperId,
  Settings,
  SettingsPatch,
  SourceId,
  StoreSourceId
} from '../../shared/types'

export const SOURCE_IDS = [
  'steam',
  'epic',
  'gog',
  'ea',
  'battlenet',
  'ubisoft',
  'xbox',
  'manual',
  'rom'
] as const satisfies readonly SourceId[]

/** The store sources, for the zod enums of the account and install IPC payloads (`z.enum(STORE_SOURCE_IDS)`). */
export const STORE_SOURCE_IDS = [
  'steam',
  'epic',
  'gog',
  'ea',
  'battlenet',
  'ubisoft',
  'xbox'
] as const satisfies readonly StoreSourceId[]

export const SCRAPER_IDS = [
  'steamgriddb',
  'igdb',
  'screenscraper',
  'thegamesdb',
  'steam',
  'hltb',
  'gog'
] as const satisfies readonly ScraperId[]

const path = z.string().max(4096)
const secret = z.string().max(500)
const shortId = z.string().min(1).max(100)

// One schema per Settings field. The strict patch schema (updateSettings) and the lenient loader (settings.json)
// are both derived from these so the two can never disagree about what a valid value is.
const library = {
  romsRoot: path.nullable(),
  showUninstalled: z.boolean(),
  showHidden: z.boolean(),
  showDuplicates: z.boolean(),
  sources: z.record(z.enum(SOURCE_IDS), z.object({ enabled: z.boolean() }).strict()),
  esdeHome: path.nullable(),
  emulationDir: path.nullable(),
  coopKeyboardMouse: z.boolean(),
  coopTwoPlayerLayout: z.enum(['stacked', 'sideBySide']),
  trimGames: z.boolean(),
  copyPcSaves: z.boolean()
}
const emulators = {
  overrides: z.record(shortId, path),
  coresDir: path.nullable(),
  preferred: z.record(shortId, shortId),
  ps3AutoUpdate: z.boolean()
}
const scrapers = {
  steamgriddb: z.object({ apiKey: secret }).strict(),
  igdb: z.object({ clientId: secret, clientSecret: secret }).strict(),
  screenscraper: z
    .object({ devId: secret, devPassword: secret, user: secret, password: secret })
    .strict(),
  thegamesdb: z.object({ apiKey: secret }).strict(),
  steam: z.object({ apiKey: secret, steamId64: z.string().max(32) }).strict(),
  retroachievements: z.object({ username: z.string().max(100), apiKey: secret }).strict(),
  hltb: z.object({ enabled: z.boolean() }).strict(),
  steamTags: z.object({ enabled: z.boolean() }).strict(),
  gameDatabase: z.object({ enabled: z.boolean(), contribute: z.boolean() }).strict(),
  autoScrape: z.boolean(),
  region: z.enum(['us', 'eu', 'jp', 'wor']),
  language: z.literal('en'),
  artPriority: z.array(z.enum(SCRAPER_IDS)).max(SCRAPER_IDS.length),
  localArt: z.boolean()
}
export const CREDENTIAL_SERVICES = [
  'steamgriddb',
  'igdb',
  'screenscraper',
  'thegamesdb',
  'steam',
  'retroachievements'
] as const satisfies readonly CredentialService[]

/** The credential objects Settings › Metadata (and › Emulators, for RetroAchievements) can test before (or while) they are saved (testCredentials). */
export const CREDENTIAL_SCHEMAS = {
  steamgriddb: scrapers.steamgriddb,
  igdb: scrapers.igdb,
  screenscraper: scrapers.screenscraper,
  thegamesdb: scrapers.thegamesdb,
  steam: scrapers.steam,
  retroachievements: scrapers.retroachievements
} as const satisfies Record<CredentialService, z.ZodType>
/** Most Library tabs kept (the strip scrolls); and choices per filter list. */
export const MAX_LIBRARY_TABS = 40
const choice = z.string().min(1).max(200)
const choices = z.array(choice).max(100)
// Filters > Platform: up to every system (a migrated Other tab holds every system folded into it).
const platformChoices = z.array(choice).max(400)
export const LIBRARY_SORT_IDS = [
  'title-asc',
  'recent',
  'most-played',
  'players',
  'reviews',
  'added',
  'release',
  'size',
  'difficulty',
  'hltb'
] as const
/**
 * A tab saved from 0.1.130 to 0.9.41 had one `developer` / `publisher` name (a game page's button); it is the first
 * name of the `developers` / `publishers` list now, so a tab filtered by a developer keeps its filter. An empty or
 * non-string old value is dropped.
 */
function migrateCreatorFilters(raw: unknown): unknown {
  if (!isObject(raw)) return raw
  // An empty list is left out, as the renderer saves it: a tab without a developer / publisher (or Difficulty /
  // Reviews) filter
  // stays what an older PlayOut (a paired PC syncing tabs, whose schema is strict) accepts.
  const emptyList = (v: unknown): boolean => Array.isArray(v) && v.length === 0
  if (
    !('developer' in raw) &&
    !('publisher' in raw) &&
    !emptyList(raw.developers) &&
    !emptyList(raw.publishers) &&
    !emptyList(raw.difficulty) &&
    !emptyList(raw.reviews)
  )
    return raw
  const { developer, publisher, ...rest } = raw
  if (emptyList(rest.developers)) delete rest.developers
  if (emptyList(rest.publishers)) delete rest.publishers
  if (emptyList(rest.difficulty)) delete rest.difficulty
  if (emptyList(rest.reviews)) delete rest.reviews
  const merged = (one: unknown, list: unknown): unknown => {
    const name = typeof one === 'string' ? one.trim() : ''
    if (!name) return list
    if (list === undefined) return [name]
    if (!Array.isArray(list)) return list
    return list.some((n) => typeof n === 'string' && n.trim().toLowerCase() === name.toLowerCase())
      ? list
      : [name, ...list]
  }
  const developers = merged(developer, rest.developers)
  const publishers = merged(publisher, rest.publishers)
  return {
    ...rest,
    ...(developers !== undefined ? { developers } : {}),
    ...(publishers !== undefined ? { publishers } : {})
  }
}
const libraryTabFilters = z.preprocess(
  migrateCreatorFilters,
  z
    .object({
      platforms: platformChoices,
      stores: choices,
      genres: choices,
      eras: choices,
      tags: choices,
      sizes: choices,
      hltb: choices,
      // Filters > Difficulty (shared/difficulty.ts ids). Tabs saved before it have none; absent = none (an empty
      // list is left out above, like the developers below, so it never reaches an older PlayOut).
      difficulty: choices.optional(),
      // Filters > Reviews (renderer lib/reviews.ts band ids). Optional and left out while empty, like Difficulty.
      reviews: choices.optional(),
      // Added in 0.1.135: tabs saved before it have none.
      controls: choices.default([]),
      // Added in 0.1.136: tabs saved before it have none.
      players: choices.default([]),
      // Added in 0.1.137: tabs saved before it have none.
      online: choices.default([]),
      hidden: z.boolean(),
      favorites: z.boolean(),
      // Added in 0.1.42: tabs saved before it read as off.
      coop: z.boolean().default(false),
      // Added in 0.1.122: tabs saved before it read as off.
      recomp: z.boolean().default(false),
      // Added in 0.9.42: a game page's developer / publisher buttons add to these lists (before: one name each,
      // `developer` / `publisher`, migrated above). Tabs saved before either have none; absent = none (an empty list
      // is left out above, so it never reaches an older PlayOut).
      developers: choices.optional(),
      publishers: choices.optional()
    })
    .strict()
)
/**
 * A tab saved on the removed Playable First sort ('playable': installed games first, then by last played) becomes
 * Recently played with the playable-first button on, which is the same order. A reversed one (not-installed games
 * first) has no match (the button always puts the playable games first), so it loads unreversed: the default order.
 */
function migratePlayableSort(raw: unknown): unknown {
  if (!isObject(raw) || raw.sort !== 'playable') return raw
  return { ...raw, sort: 'recent', sortReversed: false, playableFirst: true }
}
export const libraryTabDefSchema = z.preprocess(
  migratePlayableSort,
  z
    .object({
      id: shortId,
      filters: libraryTabFilters,
      sort: z.enum(LIBRARY_SORT_IDS),
      sortReversed: z.boolean(),
      // Added after 0.1.151 (the playable-first button): tabs saved before it have it on.
      playableFirst: z.boolean().default(true),
      query: z.string().max(200).optional()
    })
    .strict()
)
/** A tab's scroll (types.ts LibraryScrollPosition): a game of the tab, and px past its row's top. */
const libraryScrollPosition = z
  .object({ gameId: z.string().min(1).max(300), offset: z.number().min(0).max(10_000) })
  .strict()
const ui = {
  startFullscreen: z.boolean(),
  clock24h: z.boolean(),
  recentCount: z.number().int().min(4).max(40),
  homeRow: z.enum(HOME_ROW_MODES),
  animations: z.boolean(),
  minimizeWhilePlaying: z.boolean(),
  libraryTabs: z.array(libraryTabDefSchema).max(MAX_LIBRARY_TABS).nullable(),
  libraryTab: z.string().max(100),
  libraryPositions: z.record(shortId, z.string().min(1).max(300)),
  libraryScroll: z.record(shortId, libraryScrollPosition),
  // Snapped to the nearest step (out of range = the nearest end); not a number = the default on load.
  libraryCoverScale: z.number().transform((scale) => nearestCoverScale(scale))
}
const input = {
  deadzone: z.number().min(0).max(0.9),
  vibration: z.boolean(),
  swapAB: z.boolean(),
  repeatDelayMs: z.number().int().min(0).max(5000),
  repeatRateMs: z.number().int().min(0).max(5000),
  homeButtonEnabled: z.boolean(),
  homeCombo: z
    .array(z.enum(PAD_BUTTONS))
    .min(1)
    .max(4)
    .refine((b) => new Set(b).size === b.length, 'repeated button'),
  homeHoldMs: z.number().int().min(0).max(3000),
  keyboardCombo: z
    .array(z.enum(PAD_BUTTONS))
    .max(4)
    .refine((b) => new Set(b).size === b.length, 'repeated button'),
  homeOverrideSteam: z.boolean(),
  homeOverrideGameBar: z.boolean(),
  homePauseGame: z.boolean(),
  touchSwipeOverlay: z.boolean(),
  ingameOverlay: z.boolean(),
  ingameNever: z.array(shortId).max(5000)
}
const watts = z.number().int().min(3).max(200).nullable()
const powerProfileConfig = z
  .object({
    powerMode: z.enum(['efficiency', 'balanced', 'performance']),
    cpuMaxPercent: z.number().int().min(5).max(100),
    cpuBoost: z.boolean(),
    watts,
    boostWatts: watts
  })
  .strict()
const performance = {
  defaultProfile: z.enum(['none', 'auto', ...POWER_CHOICES] as [string, ...string[]]),
  profiles: z
    .object({
      silent: powerProfileConfig,
      balanced: powerProfileConfig,
      performance: powerProfileConfig,
      custom: powerProfileConfig
    })
    .strict(),
  perGame: z.boolean(),
  useWatts: z.boolean(),
  dynamic: z
    .object({
      targetFps: z.number().int().min(DYNAMIC_FPS.min).max(DYNAMIC_FPS.max),
      minWatts: watts,
      maxWatts: watts
    })
    .strict(),
  perfOverlay: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  syncFpsToRefresh: z.boolean(),
  boostOverrides: z
    .object({
      silent: z.boolean().optional(),
      balanced: z.boolean().optional(),
      performance: z.boolean().optional()
    })
    .strict(),
  memory: z.object({ enabled: z.boolean() }).strict()
}
const music = {
  folder: path.nullable(),
  gameStart: z.enum(['keep', 'play', 'load']),
  volume: z.number().min(0).max(1),
  muted: z.boolean()
}
const system = {
  // A language code ("es", "pt-BR") or '' for not chosen yet; one PlayOut lacks shows as English (shared/i18n).
  language: z.string().regex(/^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?$/),
  launchAtLogin: z.boolean(),
  confirmPowerActions: z.boolean(),
  minimizeToTray: z.boolean(),
  enhancedSleepWake: z.boolean(),
  controllerWake: z.boolean()
}

const streaming = {
  hostEnabled: z.boolean(),
  hostPort: z.number().int().min(1024).max(65534),
  showHostGames: z.boolean(),
  resolution: z.enum(['auto', '720', '1080', '1440', '4K']),
  fps: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  bitrateKbps: z.number().int().min(0).max(500_000),
  syncEmulation: z.boolean(),
  shareLogins: z.boolean(),
  syncLibraryTabs: z.boolean(),
  syncFavorites: z.boolean(),
  syncPlaytime: z.boolean()
}

const sections = {
  library,
  emulators,
  scrapers,
  ui,
  input,
  system,
  streaming,
  performance,
  music
} as const
type SectionName = keyof typeof sections

/**
 * What `updateSettings` accepts: any subset of sections, each any subset of its fields, every value fully typed and
 * in range. Unknown keys (including `version`) are rejected, as are `null`/wrong-typed values that would otherwise
 * be deep-merged into settings.json verbatim. `sources` may be partial (per-source toggles merge).
 */
export const settingsPatchSchema = z
  .object({
    library: z
      .object({
        ...library,
        sources: z.partialRecord(z.enum(SOURCE_IDS), z.object({ enabled: z.boolean() }).strict())
      })
      .strict()
      .partial(),
    emulators: z.object(emulators).strict().partial(),
    scrapers: z.object(scrapers).strict().partial(),
    ui: z.object(ui).strict().partial(),
    input: z.object(input).strict().partial(),
    system: z.object(system).strict().partial(),
    streaming: z.object(streaming).strict().partial(),
    performance: z.object(performance).strict().partial(),
    music: z.object(music).strict().partial()
  })
  .strict()
  .partial()

export function parseSettingsPatch(patch: unknown): SettingsPatch {
  return settingsPatchSchema.parse(patch) as SettingsPatch
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep the entries of a raw record whose key and value both pass; drop the rest. */
function repairRecord<V>(
  raw: unknown,
  key: z.ZodType<string>,
  value: z.ZodType<V>
): Record<string, V> {
  const out: Record<string, V> = {}
  if (!isObject(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (key.safeParse(k).success) {
      const parsed = value.safeParse(v)
      if (parsed.success) out[k] = parsed.data
    }
  }
  return out
}

/**
 * Turn whatever settings.json contained into a valid `Settings`: every field is validated against its schema and
 * replaced by its default when it is missing or malformed, so a hand-edited or legacy file can never reintroduce a
 * shape the rest of the app does not expect (ARCHITECTURE.md 4.2: zod-validated on load). Records are repaired
 * entry by entry so one bad emulator override does not discard the others. Returns null when `raw` is not an object
 * at all (the store then keeps a .bak and starts from defaults).
 */
export function normalizeSettings(raw: unknown): Settings | null {
  if (!isObject(raw)) return null
  const defaults = defaultSettings()
  const out = defaultSettings()
  for (const name of Object.keys(sections) as SectionName[]) {
    const fields = sections[name] as Record<string, z.ZodType>
    const rawSection = isObject(raw[name]) ? raw[name] : {}
    const target = out[name] as unknown as Record<string, unknown>
    const fallback = defaults[name] as unknown as Record<string, unknown>
    for (const field of Object.keys(fields)) {
      const result = fields[field]!.safeParse(rawSection[field])
      target[field] = result.success ? result.data : fallback[field]
    }
  }
  const lib = isObject(raw.library) ? raw.library : {}
  const sourceEntry = z.object({ enabled: z.boolean() }).strict()
  const sources = repairRecord(lib.sources, z.enum(SOURCE_IDS), sourceEntry)
  out.library.sources = {
    ...defaults.library.sources,
    ...sources
  } as Settings['library']['sources']
  // Library tabs and positions are repaired entry by entry: one malformed tab must not cost the others (a null
  // list would make the renderer build them afresh from the platforms).
  const rawUi = isObject(raw.ui) ? raw.ui : {}
  if (Array.isArray(rawUi.libraryTabs)) {
    const seen = new Set<string>()
    out.ui.libraryTabs = rawUi.libraryTabs
      .map((tab) => libraryTabDefSchema.safeParse(tab))
      .filter((r) => r.success)
      .map((r) => r.data)
      .filter((tab) => !seen.has(tab.id) && seen.add(tab.id))
      .slice(0, MAX_LIBRARY_TABS)
  }
  out.ui.libraryPositions = repairRecord(
    rawUi.libraryPositions,
    shortId,
    z.string().min(1).max(300)
  )
  out.ui.libraryScroll = repairRecord(rawUi.libraryScroll, shortId, libraryScrollPosition)
  const emu = isObject(raw.emulators) ? raw.emulators : {}
  out.emulators.overrides = repairRecord(emu.overrides, shortId, path)
  out.emulators.preferred = repairRecord(emu.preferred, shortId, shortId)
  // Migration 1 -> 2: `library.showUninstalled` defaulted to false before store accounts existed and every build
  // wrote the whole settings object, so a version-1 file pins false without the user having chosen it; the owned
  // games would then never appear. Version 2 files keep whatever the user set.
  const version = typeof raw.version === 'number' ? raw.version : 1
  if (version < 2 && lib.showUninstalled === false) out.library.showUninstalled = true
  // Migration -> 3: every build wrote the whole settings object, so an older 'none' is the old default, not a choice:
  // it becomes 'auto' (Dynamic TDP once the power helper is ready, else still Windows as it is).
  if (version < 3 && out.performance.defaultProfile === 'none')
    out.performance.defaultProfile = 'auto'
  // Migration -> 4 (0.1.189): "Home button opens the overlay" is on for everyone once (the user's request); turning it
  // off after that is kept.
  if (version < 4) out.input.homeButtonEnabled = true
  // Hosting (streaming.hostEnabled) is on by default only for a new install (no settings.json: the store's defaults).
  // An existing file that never chose it (written before Streaming existed, or a malformed value) keeps it off.
  const rawStreaming = isObject(raw.streaming) ? raw.streaming : {}
  if (typeof rawStreaming.hostEnabled !== 'boolean') out.streaming.hostEnabled = false
  out.version = SETTINGS_VERSION
  return out
}
