import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import { parse as parseProto, type Root, type Type as ProtoType } from 'protobufjs'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { ClientInfo, LaunchSpec, ScannedGame, TrackingSpec } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { readUninstallEntries, type UninstallEntry } from '../system/uninstall'
import { isDirectory, isFile, readJson } from '../util/fs'
import { knownFolders, normalizePath } from '../util/paths'
import { removeTrademarks } from '../util/text'
import type { GameProvider, ScanContext } from './types'
import { tMain } from '../i18n'

const log = createLogger('providers:battlenet')

// Shared helpers live in core: src/main/system/uninstall.ts (Add/Remove Programs) and src/main/util/text.ts
// (removeTrademarks, displayIconPath). Re-exported so the sibling providers' existing imports keep working.
export {
  readUninstallEntries,
  uninstallEntriesFromKey,
  type UninstallEntry
} from '../system/uninstall'
export { displayIconPath, removeTrademarks } from '../util/text'

// ---------------------------------------------------------------------------
// Product table (resources/systems/battlenet-products.json)
// ---------------------------------------------------------------------------

export interface BattlenetProduct {
  /** Product code: launch argument and externalId (WoW, Pro, D2R...). */
  code: string
  /** uid prefix in the Uninstall string / product.db; the Uninstall DisplayName for classic products. */
  uid: string
  name: string
  type: 'default' | 'classic'
  classicExecutable?: string
  installFolder?: string
  executables?: string[]
  processNames?: string[]
}

interface ProductTableFile {
  products?: unknown
}

function isProduct(value: unknown): value is BattlenetProduct {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    typeof p.code === 'string' &&
    typeof p.uid === 'string' &&
    typeof p.name === 'string' &&
    (p.type === 'default' || p.type === 'classic')
  )
}

export async function loadProductTable(
  resourcesDir: string,
  logger: Logger = log
): Promise<BattlenetProduct[]> {
  const file = join(resourcesDir, 'battlenet-products.json')
  const data = await readJson<ProductTableFile>(file)
  if (!data || !Array.isArray(data.products)) {
    logger.error(`battlenet: product table missing or invalid at ${file}`)
    return []
  }
  const products = data.products.filter(isProduct)
  if (products.length !== data.products.length) {
    logger.warn(
      `battlenet: ${data.products.length - products.length} malformed entries ignored in ${file}`
    )
  }
  return products
}

// ---------------------------------------------------------------------------
// product.db (protobuf) — schema from docs/research/battlenet-products.json (FriendsOfGalaxy product_db.proto);
// PlayOut reads product_installs[].{uid, product_code, settings.install_path} only, like Playnite.
// ---------------------------------------------------------------------------

export const PRODUCT_DB_PROTO = `syntax = "proto3";
message ProductDb { repeated ProductInstall product_installs = 1; repeated InstallHandshake active_installs = 2; repeated ActiveProcess active_processes = 3; repeated ProductConfig product_configs = 4; DownloadSettings download_settings = 5; }
message ProductInstall { string uid = 1; string product_code = 2; UserSettings settings = 3; CachedProductState cached_product_state = 4; ProductOperations product_operations = 5; }
message UserSettings { string install_path = 1; string play_region = 2; ShortcutOption desktop_shortcut = 3; ShortcutOption startmenu_shortcut = 4; LanguageSettingType language_settings = 5; string selected_text_language = 6; string selected_speech_language = 7; repeated LanguageSetting languages = 8; string gfx_override_tags = 9; string versionbranch = 10; }
message CachedProductState { BaseProductState base_product_state = 1; BackfillProgress backfill_progress = 2; RepairProgress repair_progress = 3; UpdateProgress update_progress = 4; }
message BaseProductState { bool installed = 1; bool playable = 2; bool update_complete = 3; bool background_download_available = 4; bool background_download_complete = 5; string current_version = 6; string current_version_str = 7; repeated BuildConfig installed_build_config = 8; repeated BuildConfig background_download_build_config = 9; string decryption_key = 10; repeated string completed_install_actions = 11; }
message BuildConfig { string region = 1; string build_config = 2; }
message BackfillProgress { double progress = 1; bool backgrounddownload = 2; bool paused = 3; uint64 download_limit = 4; }
message RepairProgress { double progress = 1; }
message UpdateProgress { string last_disc_set_used = 1; double progress = 2; bool disc_ignored = 3; uint64 total_to_download = 4; uint64 download_remaining = 5; }
message ProductOperations { Operation active_operation = 1; uint64 priority = 2; }
message InstallHandshake { string product = 1; string uid = 2; UserSettings settings = 3; }
message ProductConfig { string product_code = 1; string metadata_hash = 2; string timestamp = 3; }
message ActiveProcess { string process_name = 1; int32 pid = 2; repeated string uri = 3; }
message DownloadSettings { int32 download_limit = 1; int32 backfill_limit = 2; }
message LanguageSetting { string language = 1; LanguageOption option = 2; }
enum LanguageOption { NONE = 0; TEXT = 1; SPEECH = 2; TEXT_AND_SPEECH = 3; }
enum LanguageSettingType { NONE = 0; SINGLE = 1; SIMPLE = 2; ADVANCED = 3; }
enum ShortcutOption { NONE = 0; USER = 1; ALL_USERS = 2; }
enum Operation { UPDATE = 0; BACKFILL = 1; REPAIR = 2; NONE = -1; }
`

export interface ProductInstall {
  uid: string
  productCode: string
  /** Install path with Windows separators, or '' when absent. */
  installPath: string
  installed?: boolean
  playable?: boolean
}

interface DecodedProductDb {
  product_installs?: {
    uid?: string
    product_code?: string
    settings?: { install_path?: string }
    cached_product_state?: { base_product_state?: { installed?: boolean; playable?: boolean } }
  }[]
}

let protoRoot: Root | null = null

/** The ProductDb message type, parsed once from the embedded schema. */
export function productDbType(): ProtoType {
  if (!protoRoot) protoRoot = parseProto(PRODUCT_DB_PROTO, { keepCase: true }).root
  return protoRoot.lookupType('ProductDb')
}

/** Decode the raw bytes of product.db into the product installs Playnite reads. Throws on malformed input. */
export function parseProductDb(buffer: Uint8Array): ProductInstall[] {
  const type = productDbType()
  const message = type.decode(buffer)
  const obj = type.toObject(message, { defaults: false }) as DecodedProductDb
  const installs: ProductInstall[] = []
  for (const item of obj.product_installs ?? []) {
    const uid = item.uid ?? ''
    const productCode = item.product_code ?? ''
    if (!uid && !productCode) continue
    const state = item.cached_product_state?.base_product_state
    installs.push({
      uid,
      productCode,
      installPath: (item.settings?.install_path ?? '').replace(/\//g, '\\').replace(/\\+$/, ''),
      installed: state?.installed,
      playable: state?.playable
    })
  }
  return installs
}

export function productDbPath(): string {
  return join(knownFolders().programData, 'Battle.net', 'Agent', 'product.db')
}

// ---------------------------------------------------------------------------
// Detection (pure functions over registry entries / product.db rows)
// ---------------------------------------------------------------------------

export interface DetectedProduct {
  product: BattlenetProduct
  installDir: string
  /** The uid as found (registry --uid=... or product.db uid); classic products have none. */
  uid?: string
  via: 'registry' | 'product.db' | 'classic'
}

const UID_REGEX = /Battle\.net.*--uid=(.*?)\s/i
const TEST_BUILD = /(test|beta)$/i
/** product.db uids such as `pro_beta` or `wow_ptr` that only prefix-match a product are test builds, not the game. */
const TEST_UID = /[_-](beta|test|ptr|alpha)$/i

export function findProductByUid(
  products: BattlenetProduct[],
  uid: string
): BattlenetProduct | undefined {
  const lower = uid.toLowerCase()
  const exact = products.find((p) => p.type === 'default' && p.uid.toLowerCase() === lower)
  if (exact) return exact
  if (TEST_UID.test(uid)) return undefined
  return products.find((p) => p.type === 'default' && lower.startsWith(p.uid.toLowerCase()))
}

/** Playnite's registry pass: Battle.net uninstall strings (`--uid=wow_enus`) and the two classic installers. */
export function detectFromUninstallEntries(
  entries: UninstallEntry[],
  products: BattlenetProduct[],
  exists: (path: string) => boolean
): DetectedProduct[] {
  const found: DetectedProduct[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.uninstallString || !entry.installLocation) continue
    const match = entry.uninstallString.match(UID_REGEX)
    if (match) {
      if (TEST_BUILD.test(entry.displayName.trim())) continue
      const uid = match[1]
      const product = findProductByUid(products, uid)
      if (!product || seen.has(product.code)) continue
      const installDir = entry.installLocation.replace(/\//g, '\\').replace(/[\\]+$/, '')
      if (!exists(installDir)) continue
      seen.add(product.code)
      found.push({ product, installDir, uid, via: 'registry' })
      continue
    }
    if (entry.publisher !== 'Blizzard Entertainment') continue
    for (const product of products) {
      if (product.type !== 'classic' || product.uid !== entry.displayName || seen.has(product.code))
        continue
      const installDir = entry.installLocation.replace(/[\\]+$/, '')
      if (!product.classicExecutable || !exists(join(installDir, product.classicExecutable)))
        continue
      seen.add(product.code)
      found.push({ product, installDir, via: 'classic' })
    }
  }
  return found
}

/** product.db pass: adds products the registry did not list (exact uid match first, then prefix). */
export function detectFromProductDb(
  installs: ProductInstall[],
  products: BattlenetProduct[],
  already: DetectedProduct[],
  exists: (path: string) => boolean
): DetectedProduct[] {
  const seen = new Set(already.map((d) => d.product.code))
  const found: DetectedProduct[] = []
  for (const install of installs) {
    if (!install.uid) continue
    const product = findProductByUid(products, install.uid)
    if (!product || seen.has(product.code)) continue
    if (!install.installPath || !exists(install.installPath)) continue
    seen.add(product.code)
    found.push({ product, installDir: install.installPath, uid: install.uid, via: 'product.db' })
  }
  return found
}

// ---------------------------------------------------------------------------
// ScannedGame construction
// ---------------------------------------------------------------------------

export function buildScannedGame(
  detected: DetectedProduct,
  clientExe: string | null,
  exePath?: string
): ScannedGame {
  const { product, installDir } = detected
  let launch: LaunchSpec
  if (product.type === 'classic' && product.classicExecutable) {
    launch = {
      kind: 'exec',
      file: join(installDir, product.classicExecutable),
      args: [],
      cwd: installDir
    }
  } else if (clientExe) {
    // Playnite: "<client>\Battle.net.exe" --exec="launch <code>"; the client must already be running.
    launch = {
      kind: 'exec',
      file: clientExe,
      args: [`--exec=launch ${product.code}`],
      cwd: dirname(clientExe)
    }
  } else {
    launch = { kind: 'uri', uri: `battlenet://${product.code}` }
  }
  const processNames = product.processNames?.filter((n) => n.trim()) ?? []
  const tracking: TrackingSpec = processNames.length
    ? { mode: 'process', processNames }
    : { mode: 'installDir', installDir }
  const extra: Record<string, string | boolean> = {
    productCode: product.code,
    installedVia: detected.via,
    launchesViaClient: product.type !== 'classic'
  }
  if (detected.uid) extra.uid = detected.uid
  if (clientExe) extra.clientPath = clientExe
  return {
    source: 'battlenet',
    externalId: product.code,
    platformId: 'battlenet',
    title: removeTrademarks(product.name),
    installDir,
    exePath,
    launch,
    tracking,
    extra
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function clientDirFromUninstallEntries(entries: UninstallEntry[]): string | null {
  const entry = entries.find(
    (e) => e.uninstallString.includes('-uid=battle.net') && e.installLocation
  )
  return entry ? entry.installLocation.replace(/[\\]+$/, '') : null
}

async function findClientExe(): Promise<string | null> {
  const entries = await readUninstallEntries()
  const candidates: string[] = []
  const fromRegistry = clientDirFromUninstallEntries(entries)
  if (fromRegistry) candidates.push(join(fromRegistry, 'Battle.net.exe'))
  const folders = knownFolders()
  candidates.push(
    join(folders.programFilesX86, 'Battle.net', 'Battle.net.exe'),
    join(folders.programFiles, 'Battle.net', 'Battle.net.exe')
  )
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  return null
}

async function readProductDb(logger: Logger): Promise<ProductInstall[]> {
  const file = productDbPath()
  let buffer: Buffer
  try {
    buffer = await fs.readFile(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') logger.warn(`battlenet: cannot read ${file}: ${(err as Error).message}`)
    return []
  }
  try {
    return parseProductDb(buffer)
  } catch (err) {
    logger.warn(
      `battlenet: ${file} could not be decoded (${buffer.length} bytes): ${(err as Error).message}`
    )
    return []
  }
}

async function firstExistingExecutable(
  installDir: string,
  product: BattlenetProduct
): Promise<string | undefined> {
  const relatives =
    product.type === 'classic' && product.classicExecutable
      ? [product.classicExecutable]
      : (product.executables ?? [])
  for (const rel of relatives) {
    const candidate = join(installDir, rel)
    if (await isFile(candidate)) return candidate
  }
  return undefined
}

async function scan(ctx: ScanContext): Promise<ScannedGame[]> {
  const products = await loadProductTable(ctx.resourcesDir, ctx.log)
  if (!products.length) return []
  const clientExe = await findClientExe()
  const entries = await readUninstallEntries()

  // Existence checks are synchronous in the pure matchers; resolve them up front for the paths that matter.
  const dirChecks = new Map<string, boolean>()
  const exists = (path: string): boolean => dirChecks.get(normalizePath(path)) ?? false
  const registryPaths = new Set<string>()
  for (const e of entries) {
    if (!e.installLocation) continue
    const dir = e.installLocation.replace(/\//g, '\\').replace(/[\\]+$/, '')
    if (UID_REGEX.test(e.uninstallString)) registryPaths.add(dir)
    if (e.publisher === 'Blizzard Entertainment') {
      for (const p of products)
        if (p.type === 'classic' && p.classicExecutable && p.uid === e.displayName)
          registryPaths.add(join(dir, p.classicExecutable))
    }
  }
  await Promise.all(
    [...registryPaths].map(async (p) =>
      dirChecks.set(
        normalizePath(p),
        basename(p).toLowerCase().endsWith('.exe') ? await isFile(p) : await isDirectory(p)
      )
    )
  )
  const fromRegistry = detectFromUninstallEntries(entries, products, exists)
  ctx.progress(fromRegistry.length, tMain('mainApp.scan.battlenet'))

  const installs = await readProductDb(ctx.log)
  await Promise.all(
    installs
      .filter((i) => i.installPath)
      .map(async (i) =>
        dirChecks.set(normalizePath(i.installPath), await isDirectory(i.installPath))
      )
  )
  const fromDb = detectFromProductDb(installs, products, fromRegistry, exists)
  const detected = [...fromRegistry, ...fromDb]

  const games: ScannedGame[] = []
  for (const d of detected) {
    try {
      const exePath = await firstExistingExecutable(d.installDir, d.product)
      games.push(buildScannedGame(d, clientExe, exePath))
      ctx.progress(games.length, d.product.name)
    } catch (err) {
      ctx.log.warn(
        `battlenet: skipping ${d.product.code} at ${d.installDir}: ${(err as Error).message}`
      )
    }
  }
  ctx.log.info(
    `battlenet: ${games.length} game(s) (${fromRegistry.length} from registry, ${fromDb.length} from product.db, ${installs.length} product.db rows)`
  )
  return games
}

export const battlenetProvider: GameProvider = {
  id: 'battlenet',
  name: 'Battle.net',
  platforms: () => [STORE_PLATFORMS.battlenet],
  async detectClient(): Promise<ClientInfo> {
    try {
      const exe = await findClientExe()
      return exe ? { installed: true, path: exe } : { installed: false }
    } catch (err) {
      log.warn(`detectClient failed: ${(err as Error).message}`)
      return { installed: false }
    }
  },
  async scanInstalled(ctx) {
    try {
      return await scan(ctx)
    } catch (err) {
      ctx.log.error('battlenet: scan failed', err)
      return []
    }
  }
}
