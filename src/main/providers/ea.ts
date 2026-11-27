import { XMLParser } from 'fast-xml-parser'
import { basename, dirname, extname, join } from 'path'
import { STORE_PLATFORMS } from '../../shared/platforms'
import type { ClientInfo, LaunchSpec, ScannedGame } from '../../shared/types'
import { createLogger, type Logger } from '../logger'
import { registryValue, type RegistryHive } from '../system/registry'
import { isDirectory, isFile, listDir, readTextIfExists, walk } from '../util/fs'
import { hashShort } from '../util/ids'
import { knownFolders, normalizePath } from '../util/paths'
import { readUninstallEntries, type UninstallEntry } from '../system/uninstall'
import { displayIconPath, removeTrademarks } from '../util/text'
import type { GameProvider, ScanContext } from './types'

const log = createLogger('providers:ea')

// ---------------------------------------------------------------------------
// Client (Playnite Origin.cs / Jeshibu EaApp.cs: HKLM\SOFTWARE\WOW6432Node\Origin OriginPath|ClientPath,
// then the EA Desktop keys)
// ---------------------------------------------------------------------------

async function findClientExe(): Promise<string | null> {
  const lookups: [string, string][] = [
    ['SOFTWARE\\Origin', 'OriginPath'],
    ['SOFTWARE\\Origin', 'ClientPath'],
    ['SOFTWARE\\Electronic Arts\\EA Desktop', 'DesktopAppPath'],
    ['SOFTWARE\\Electronic Arts\\EA Desktop', 'ClientPath']
  ]
  for (const [path, name] of lookups) {
    const value = await registryValue('HKLM', path, name, { view: 'x86' })
    if (value && (await isFile(value))) return value
  }
  return null
}

// ---------------------------------------------------------------------------
// Origin LocalContent *.mfst (URL-query text next to the game's download state)
// ---------------------------------------------------------------------------

export interface MfstInfo {
  offerId: string | null
  installPath: string | null
  /** Origin's download state, e.g. kReadyToStart (installed) or kTransferring. */
  state: string | null
}

/**
 * Parse an Origin manifest: `?currentstate=kReadyToStart&dipinstallpath=C%3A%5C...&id=OFB-EAST%3A109552409&...`.
 * The file name is the offer id without its colon (OFB-EAST109552409.mfst, Origin.OFR.50.0001234.mfst).
 */
export function parseMfst(text: string, fileName?: string): MfstInfo {
  const query = new URLSearchParams(text.trim().replace(/^\?/, ''))
  let offerId = query.get('id')?.trim() || null
  if (!offerId && fileName) {
    const stem = basename(fileName).replace(/\.mfst$/i, '')
    offerId = stem.startsWith('Origin') ? stem : stem.replace(/^(.*?)(\d+)$/, '$1:$2')
  }
  const rawPath = query.get('dipinstallpath')?.trim()
  return {
    offerId,
    installPath: rawPath ? rawPath.replace(/\//g, '\\').replace(/[\\]+$/, '') : null,
    state: query.get('currentstate')
  }
}

/**
 * Origin writes `<offer>.mfst` the moment a download starts (currentstate kTransferring / kPaused / kEnqueued /
 * kInstalling / kPostTransfer / kPendingEula ...) and only reaches kReadyToStart once the files are complete. Only
 * the completed states count as an install; a manifest without a currentstate is accepted so that manifests from
 * other client versions are not dropped on that field alone.
 */
const MFST_INSTALLED_STATES = new Set(['kReadyToStart', 'kCompleted', 'kInstalled'])

export function isMfstInstalled(state: string | null | undefined): boolean {
  return state == null || state === '' || MFST_INSTALLED_STATES.has(state)
}

// ---------------------------------------------------------------------------
// __Installer\installerdata.xml (DiPManifest)
// ---------------------------------------------------------------------------

export interface InstallerLauncher {
  /** `[HKEY_LOCAL_MACHINE\...\Install Dir]Game\Bin\game.exe`, a relative path, an absolute path or a URL. */
  filePath: string
  parameters: string
  trial: boolean
  requires64BitOS: boolean
  executeElevated: boolean
  name?: string
}

export interface InstallerData {
  contentIds: string[]
  /** Locale ('en_US') -> title. */
  titles: Record<string, string>
  launchers: InstallerLauncher[]
}

const ARRAY_TAGS = new Set(['contentID', 'gameTitle', 'launcher', 'name'])

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName)
})

type XmlNode = Record<string, unknown>

function textOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return textOf((value as XmlNode)['#text'])
  return String(value).trim()
}

function flag(value: unknown): boolean {
  const text = textOf(value).toLowerCase()
  return text === '1' || text === 'true'
}

function localized(nodes: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const node of Array.isArray(nodes) ? nodes : nodes ? [nodes] : []) {
    const text = textOf(node)
    if (!text) continue
    const locale = typeof node === 'object' && node ? textOf((node as XmlNode)['@_locale']) : ''
    out[locale || 'default'] = text
  }
  return out
}

/** Parse installerdata.xml. Returns null when the document is not a DiPManifest. */
export function parseInstallerData(xml: string): InstallerData | null {
  let doc: XmlNode
  try {
    doc = xmlParser.parse(xml) as XmlNode
  } catch {
    return null
  }
  const manifest = (doc.DiPManifest ?? doc.dipManifest) as XmlNode | undefined
  if (!manifest || typeof manifest !== 'object') return null
  const contentIds: string[] = []
  const ids = (manifest.contentIDs as XmlNode | undefined)?.contentID
  for (const id of Array.isArray(ids) ? ids : []) {
    const text = textOf(id)
    if (text && !contentIds.includes(text)) contentIds.push(text)
  }
  const titles = localized((manifest.gameTitles as XmlNode | undefined)?.gameTitle)
  const launchers: InstallerLauncher[] = []
  const rawLaunchers = (manifest.runtime as XmlNode | undefined)?.launcher
  for (const raw of Array.isArray(rawLaunchers) ? rawLaunchers : []) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as XmlNode
    const filePath = textOf(node.filePath)
    if (!filePath) continue
    const names = localized(node.name)
    launchers.push({
      filePath,
      parameters: textOf(node.parameters),
      trial: flag(node.trial),
      requires64BitOS: flag(node.requires64BitOS),
      executeElevated: flag(node.executeElevated),
      name: names.en_US ?? Object.values(names)[0]
    })
  }
  return { contentIds, titles, launchers }
}

/** Playnite: the first non-trial launcher, preferring one that requires a 64-bit OS. */
export function pickLauncher(launchers: InstallerLauncher[]): InstallerLauncher | undefined {
  const real = launchers.filter((l) => !l.trial)
  return real.find((l) => l.requires64BitOS) ?? real[0] ?? launchers[0]
}

export function pickTitle(titles: Record<string, string>): string | undefined {
  return titles.en_US ?? titles.en_GB ?? titles.default ?? Object.values(titles)[0]
}

const REGISTRY_PATH_REGEX = /^\[([^\\\]]+)\\(.+)\\([^\\\]]*)\](.*)$/
const HIVES: Record<string, RegistryHive> = {
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKLM: 'HKLM',
  HKEY_CURRENT_USER: 'HKCU',
  HKCU: 'HKCU'
}

export interface RegistryLookup {
  (hive: RegistryHive, path: string, valueName: string): Promise<string | null>
}

async function defaultRegistryLookup(
  hive: RegistryHive,
  path: string,
  valueName: string
): Promise<string | null> {
  // Playnite tries the 64-bit view first, then the 32-bit one.
  return (
    (await registryValue(hive, path, valueName, { view: 'x64' })) ??
    (await registryValue(hive, path, valueName, { view: 'x86' }))
  )
}

/**
 * Resolve a launcher filePath to an absolute executable: `[HKEY...\Value]relative` through the registry (the value
 * holds the game's install dir), else relative to the install directory. Returns null for URLs and missing files.
 */
export async function resolveLauncherPath(
  filePath: string,
  installDir: string,
  lookup: RegistryLookup = defaultRegistryLookup,
  exists: (path: string) => Promise<boolean> = isFile
): Promise<string | null> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) return null
  const candidates: string[] = []
  const match = filePath.match(REGISTRY_PATH_REGEX)
  if (match) {
    const [, hiveName, keyPath, valueName, relative] = match
    const hive = HIVES[hiveName.toUpperCase()]
    if (hive) {
      const base = await lookup(
        hive,
        keyPath.replace(/^SOFTWARE\\WOW6432Node\\/i, 'SOFTWARE\\'),
        valueName
      )
      if (base) candidates.push(join(base, relative))
    }
    candidates.push(join(installDir, relative))
  } else if (/^[a-z]:\\/i.test(filePath) || filePath.startsWith('\\\\')) {
    candidates.push(filePath)
  } else {
    candidates.push(join(installDir, filePath))
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return null
}

export function splitParameters(parameters: string): string[] {
  const args: string[] = []
  const regex = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(parameters))) args.push(m[1] ?? m[2])
  return args
}

// ---------------------------------------------------------------------------
// Candidate install directories
// ---------------------------------------------------------------------------

export interface EaCandidate {
  dir: string
  /** Title from the Uninstall entry (trademarks removed). */
  uninstallTitle?: string
  displayIcon?: string
  offerId?: string
  mfstState?: string
  sources: Set<'uninstall' | 'mfst' | 'root'>
}

const EA_PUBLISHER = /electronic arts/i

function cleanDir(path: string): string {
  return path.replace(/\//g, '\\').replace(/[\\]+$/, '')
}

/** Uninstall entries published by Electronic Arts, one candidate per install directory (DLC rows share the game's). */
export function candidatesFromUninstallEntries(entries: UninstallEntry[]): EaCandidate[] {
  const byDir = new Map<string, EaCandidate>()
  for (const entry of entries) {
    if (!EA_PUBLISHER.test(entry.publisher) || !entry.installLocation.trim()) continue
    const dir = cleanDir(entry.installLocation.trim())
    if (!/^[a-z]:\\/i.test(dir)) continue
    const key = normalizePath(dir)
    const title = removeTrademarks(entry.displayName)
    const icon = displayIconPath(entry.displayIcon)
    const existing = byDir.get(key)
    if (!existing) {
      byDir.set(key, {
        dir,
        uninstallTitle: title || undefined,
        displayIcon: icon || undefined,
        sources: new Set(['uninstall'])
      })
      continue
    }
    // Expansion rows carry longer names ("The Sims 3 Pets"); the base game has the shortest one.
    if (title && (!existing.uninstallTitle || title.length < existing.uninstallTitle.length)) {
      existing.uninstallTitle = title
      existing.displayIcon = icon || existing.displayIcon
    }
  }
  return [...byDir.values()]
}

export function mergeCandidates(lists: EaCandidate[][]): EaCandidate[] {
  const byDir = new Map<string, EaCandidate>()
  for (const list of lists) {
    for (const c of list) {
      const key = normalizePath(c.dir)
      const existing = byDir.get(key)
      if (!existing) {
        byDir.set(key, { ...c, sources: new Set(c.sources) })
        continue
      }
      existing.uninstallTitle ??= c.uninstallTitle
      existing.displayIcon ??= c.displayIcon
      existing.offerId ??= c.offerId
      existing.mfstState ??= c.mfstState
      for (const s of c.sources) existing.sources.add(s)
    }
  }
  return [...byDir.values()]
}

/** File-system access used by the mfst walk; injectable for tests. */
export interface MfstScanDeps {
  /** `%ProgramData%\Origin\LocalContent` by default. */
  root: string
  isDirectory: (path: string) => Promise<boolean>
  walk: typeof walk
  readText: (path: string) => Promise<string | null>
}

export async function candidatesFromMfst(
  logger: Logger,
  deps: Partial<MfstScanDeps> = {}
): Promise<EaCandidate[]> {
  const root = deps.root ?? join(knownFolders().programData, 'Origin', 'LocalContent')
  const dirExists = deps.isDirectory ?? isDirectory
  const walkDir = deps.walk ?? walk
  const readText = deps.readText ?? readTextIfExists
  if (!(await dirExists(root))) return []
  const out: EaCandidate[] = []
  for await (const entry of walkDir(root, { maxDepth: 2 })) {
    if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.mfst')) continue
    const text = await readText(entry.path)
    if (text === null) {
      logger.warn(`ea: cannot read ${entry.path}`)
      continue
    }
    const info = parseMfst(text, entry.name)
    if (!info.installPath) {
      logger.debug(`ea: ${entry.path} has no dipinstallpath (state ${info.state ?? 'unknown'})`)
      continue
    }
    // A paused or in-flight download already has its folder and manifest; it is not an installed game.
    if (!isMfstInstalled(info.state)) {
      logger.debug(`ea: ${entry.path} skipped, download state ${info.state}`)
      continue
    }
    out.push({
      dir: info.installPath,
      offerId: info.offerId ?? undefined,
      mfstState: info.state ?? undefined,
      sources: new Set(['mfst'])
    })
  }
  return out
}

async function candidatesFromRoots(): Promise<EaCandidate[]> {
  const folders = knownFolders()
  const roots = [
    join(folders.programFiles, 'EA Games'),
    join(folders.programFilesX86, 'Origin Games'),
    join(folders.programFiles, 'Origin Games'),
    join(folders.programFilesX86, 'EA Games')
  ]
  const out: EaCandidate[] = []
  for (const root of roots) {
    for (const entry of await listDir(root)) {
      if (entry.isDirectory()) out.push({ dir: join(root, entry.name), sources: new Set(['root']) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// ScannedGame construction
// ---------------------------------------------------------------------------

export interface EaGameInput {
  candidate: EaCandidate
  installerData: InstallerData | null
  exePath: string | null
  launcherParameters: string
  /** Uninstall DisplayIcon (.ico/.png) whose existence scan() has verified. */
  iconPath?: string | null
}

export function buildScannedGame(input: EaGameInput): ScannedGame {
  const { candidate, installerData, exePath } = input
  const contentId = installerData?.contentIds[0] ?? candidate.offerId
  const title = removeTrademarks(
    pickTitle(installerData?.titles ?? {}) ?? candidate.uninstallTitle ?? basename(candidate.dir)
  )
  let launch: LaunchSpec
  if (contentId) {
    // Verified in Link2EA.exe (parseProtocolOrigin2 handles game/launch with offerIds); used by the Jeshibu addon.
    launch = { kind: 'uri', uri: `origin2://game/launch?offerIds=${contentId}` }
  } else if (exePath) {
    launch = {
      kind: 'exec',
      file: exePath,
      args: splitParameters(input.launcherParameters),
      cwd: dirname(exePath)
    }
  } else {
    launch = { kind: 'uri', uri: 'origin2://library/open' }
  }
  const extra: Record<string, string | boolean> = { hasInstallerManifest: installerData !== null }
  if (contentId) extra.contentId = contentId
  // Every content id of the install (base game + editions), so the account import can recognise this record
  // under any of them (LibraryService.mergeOwned) instead of adding a second, greyed card.
  if (installerData?.contentIds.length) extra.contentIds = installerData.contentIds.join(';')
  if (candidate.offerId) extra.eaOfferId = candidate.offerId
  const game: ScannedGame = {
    source: 'ea',
    externalId: contentId ?? `path:${hashShort(normalizePath(candidate.dir))}`,
    platformId: 'ea',
    title,
    installDir: candidate.dir,
    exePath: exePath ?? undefined,
    launch,
    tracking: { mode: 'installDir', installDir: candidate.dir },
    extra
  }
  if (input.iconPath) game.localMedia = { icon: input.iconPath }
  return game
}

/** File-system and registry access used when a candidate folder is examined; injectable for tests. */
export interface CandidateDeps {
  isDirectory: (path: string) => Promise<boolean>
  isFile: (path: string) => Promise<boolean>
  readText: (path: string) => Promise<string | null>
  resolveLauncher: (filePath: string, installDir: string) => Promise<string | null>
}

const defaultCandidateDeps: CandidateDeps = {
  isDirectory,
  isFile,
  readText: readTextIfExists,
  resolveLauncher: (filePath, installDir) => resolveLauncherPath(filePath, installDir)
}

const ICON_EXTENSIONS = new Set(['.ico', '.png'])

/**
 * Examine one candidate folder and build its ScannedGame, or return null when the folder is not an installed EA
 * game: missing directory, no EA record at all, or (without an Uninstall row) no resolvable launcher executable.
 */
export async function evaluateCandidate(
  candidate: EaCandidate,
  logger: Logger,
  deps: CandidateDeps = defaultCandidateDeps
): Promise<ScannedGame | null> {
  if (!(await deps.isDirectory(candidate.dir))) {
    logger.debug(`ea: ${candidate.dir} does not exist (${[...candidate.sources].join(',')})`)
    return null
  }
  const manifestPath = join(candidate.dir, '__Installer', 'installerdata.xml')
  const xml = await deps.readText(manifestPath)
  const installerData = xml === null ? null : parseInstallerData(xml)
  if (xml !== null && !installerData) logger.warn(`ea: ${manifestPath} is not a DiPManifest`)
  // A folder under EA Games without a manifest and without any EA record is not a known game.
  if (!installerData && !candidate.sources.has('uninstall') && !candidate.sources.has('mfst'))
    return null

  const launcher = installerData ? pickLauncher(installerData.launchers) : undefined
  let exePath: string | null = null
  if (launcher) exePath = await deps.resolveLauncher(launcher.filePath, candidate.dir)
  const iconExt = candidate.displayIcon ? extname(candidate.displayIcon).toLowerCase() : ''
  if (
    !exePath &&
    candidate.displayIcon &&
    iconExt === '.exe' &&
    (await deps.isFile(candidate.displayIcon))
  ) {
    exePath = candidate.displayIcon
  }
  // An mfst alone is written as soon as a download starts and a leftover folder keeps its manifest after an
  // uninstall; without an Uninstall row apply the research rule "installed iff the resolved exe exists"
  // (docs/research/playnite-stores.md, EA app).
  if (!candidate.sources.has('uninstall') && !exePath) {
    logger.debug(
      `ea: ${candidate.dir} has no resolvable launcher exe and no Uninstall row (mfst state ${candidate.mfstState ?? 'unknown'}), skipped`
    )
    return null
  }
  // The Uninstall icon survives the removal of the expansion that registered it; only an existing file is usable.
  let iconPath: string | null = null
  if (
    candidate.displayIcon &&
    ICON_EXTENSIONS.has(iconExt) &&
    (await deps.isFile(candidate.displayIcon))
  ) {
    iconPath = candidate.displayIcon
  }
  return buildScannedGame({
    candidate,
    installerData,
    exePath,
    launcherParameters: launcher?.parameters ?? '',
    iconPath
  })
}

async function scan(ctx: ScanContext): Promise<ScannedGame[]> {
  const entries = await readUninstallEntries()
  const [fromMfst, fromRoots] = await Promise.all([
    candidatesFromMfst(ctx.log),
    candidatesFromRoots()
  ])
  const candidates = mergeCandidates([candidatesFromUninstallEntries(entries), fromMfst, fromRoots])
  ctx.log.debug(`ea: ${candidates.length} candidate folder(s)`)

  const games: ScannedGame[] = []
  const seenIds = new Set<string>()
  for (const candidate of candidates) {
    try {
      const game = await evaluateCandidate(candidate, ctx.log)
      if (!game) continue
      if (seenIds.has(game.externalId)) continue
      seenIds.add(game.externalId)
      games.push(game)
      ctx.progress(games.length, game.title)
    } catch (err) {
      ctx.log.warn(`ea: skipping ${candidate.dir}: ${(err as Error).message}`)
    }
  }
  ctx.log.info(`ea: ${games.length} game(s) from ${candidates.length} candidate folder(s)`)
  return games
}

export const eaProvider: GameProvider = {
  id: 'ea',
  name: 'EA App',
  platforms: () => [STORE_PLATFORMS.ea],
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
      ctx.log.error('ea: scan failed', err)
      return []
    }
  }
}
