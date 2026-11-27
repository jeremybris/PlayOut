// Steam DLC picker and Manage DLC (Play menu): which DLC of a Steam game is on, and turning them on or off.
//
// Steam keeps the choice in the game's appmanifest_<appid>.acf (acf.ts). Steam reads that file when it starts and
// writes it over while it runs, so a change closes Steam cleanly (`steam.exe -shutdown`, never a kill, never while a
// game runs or Steam downloads), backs the file up, edits only `UserConfig.DisabledDLC` and starts Steam again with
// `-silent`; Steam then removes or downloads the DLC content on its own (live-tested 2026-11-15).
//
// Steam's install dialog offers no DLC choice and the acf only exists once Steam starts installing, so a choice made
// before the install is kept as a plan (steam-dlc-plans.json) and applied once the game is installed: Steam installs
// every owned DLC and the plan turns the unwanted ones off afterwards.
import { win32 } from 'path'
import type { Game, SteamDlcInfo, SteamDlcItem, SteamDlcResult } from '../../shared/types'
import type { EventBus } from '../events'
import {
  createRealIo,
  regQuery,
  runningProcesses,
  writeFileAtomic,
  type HomeButtonIo
} from '../home-button/io'
import { decodeVdf, encodeVdf } from '../home-button/steam-vdf'
import type { Logger } from '../logger'
import { detectSteam, parseLibraryFolders } from '../providers/steam'
import { steamAppIdOf } from '../scrapers/steam-store'
import { JsonStore } from '../store/json-store'
import { listDir, readTextIfExists } from '../util/fs'
import { acfShowsDownload, readAcfDlc, writeUserDisabledDlc, type AcfDlcState } from './acf'
import { fetchItemNames, fetchSteamcmdDlc, type SteamcmdDlc } from './steamcmd'
import { tMain } from '../i18n'

const { join, dirname, basename } = win32

const STEAM_KEY = 'HKCU\\Software\\Valve\\Steam'
/** Steam's DLC list of a game is read again after this long. */
const LIST_CACHE_MS = 6 * 60 * 60_000
/** A list whose names could not be read is read again sooner. */
const LIST_RETRY_MS = 10 * 60_000
const OWNED_CACHE_MS = 10 * 60_000
/** A plan of an installed game that could not be applied for this long (a game always running...) is given up. */
const PLAN_APPLY_MAX_MS = 7 * 24 * 60 * 60_000
/** A plan of a game that never got installed is dropped after this long. */
const PLAN_INSTALL_MAX_MS = 30 * 24 * 60 * 60_000
const SLOW_EXIT_WATCH_MS = 5 * 60_000
const SLOW_EXIT_POLL_MS = 2_000
/** A waiting plan stops closing Steam by itself after Steam failed to close in time this many times. */
const MAX_PLAN_SHUTDOWN_TIMEOUTS = 2
/** A plan of a game no longer installing (nor installed) is kept this long after it was made (the install starts). */
const PLAN_INSTALL_GRACE_MS = 2 * 60_000
/** While a plan's game is not installed yet, plans are looked at this often (a cancelled install drops its plan). */
const PLAN_WAIT_CHECK_MS = 5 * 60_000
export const dlcListFailedMessage = (): string => tMain('mainSteamDlc.listFailed')
export const runningCheckFailedMessage = (): string => tMain('mainSteamDlc.runningCheckFailed')

export const gameRunningMessage = (): string => tMain('mainSteamDlc.gameRunning')
export const steamDownloadingMessage = (): string => tMain('mainSteamDlc.steamDownloading')

export interface SteamDlcIo extends HomeButtonIo {
  /** File names in a folder; empty when it cannot be read. */
  listDir(path: string): Promise<string[]>
}

export interface SteamPaths {
  /** Steam's folder (steam.exe), null when Steam is not installed. */
  root: string | null
  /** Every Steam library folder (each has a steamapps folder). */
  libraries: string[]
}

interface Plan {
  appId: number
  disabled: number[]
  createdAt: string
  /** When the game was first seen installed with this plan waiting (the 7 days of retries count from here). */
  installedAt?: string
}

/** An apply's result; `timedOut`: Steam did not close in time (a waiting plan counts these). */
type ApplyResult = SteamDlcResult & { timedOut?: boolean }

interface PlansFile {
  version: 1
  plans: Record<string, Plan>
}

export interface SteamDlcDeps {
  library: { getGame(id: string): Game | undefined }
  events: Pick<EventBus, 'emit' | 'on'>
  log: Logger
  /** steam-dlc-plans.json under userData. */
  plansFile: string
  /** A game PlayOut started is running. */
  gameRunning: () => boolean
  /** Opens a steam:// URI (the same path installs use). */
  openExternal: (uri: string) => Promise<void>
  /** The signed-in Steam account's owned app ids; null when unknown. */
  ownedApps?: () => Promise<Set<number> | null>
  /**
   * Game ids PlayOut is installing or has waiting in its install queue (installs trackedGameIds): a plan whose
   * install left both without the game being installed (cancelled, removed from the queue) is dropped.
   */
  installActive?: () => string[]
  // Injectable for tests
  io?: SteamDlcIo
  steamPaths?: () => Promise<SteamPaths>
  appDlc?: (appId: number) => Promise<SteamcmdDlc[]>
  names?: (appIds: number[]) => Promise<Map<number, string>>
  now?: () => number
  /** How long Steam gets to close (default 60 s), polled every `pollMs` (default 1 s). */
  shutdownTimeoutMs?: number
  pollMs?: number
  /** How often a waiting plan of an installed game is tried again (default 60 s). */
  retryMs?: number
  /** Delay before plans are looked at after a library change (default 5 s) and at start (default 15 s). */
  changeDelayMs?: number
  startDelayMs?: number
}

export interface SteamDlcService {
  steamDlc(gameId: string): Promise<SteamDlcInfo>
  setSteamDlc(gameId: string, disabled: number[]): Promise<SteamDlcResult>
  openSteamDlcPage(gameId: string): Promise<void>
  /** Look at the waiting plans now and after every library change. */
  start(): void
  /** Apply every plan whose game is installed (exposed for tests; `start` schedules it). */
  processPlans(): Promise<void>
  dispose(): Promise<void>
}

interface DlcEntry extends SteamcmdDlc {
  name: string
}

function defaultIo(): SteamDlcIo {
  return {
    ...createRealIo(),
    async listDir(path) {
      return (await listDir(path)).filter((d) => d.isFile()).map((d) => d.name)
    }
  }
}

async function defaultSteamPaths(): Promise<SteamPaths> {
  const detection = await detectSteam()
  if (!detection.root) return { root: null, libraries: [] }
  const text = await readTextIfExists(join(detection.root, 'steamapps', 'libraryfolders.vdf'))
  let libraries = [detection.root]
  if (text) {
    try {
      libraries = parseLibraryFolders(text, detection.root)
    } catch {
      /* the Steam folder alone */
    }
  }
  return { root: detection.root, libraries }
}

function normalizePlans(raw: unknown): PlansFile | null {
  if (!raw || typeof raw !== 'object') return null
  const plans: Record<string, Plan> = {}
  const rawPlans = (raw as { plans?: unknown }).plans
  if (rawPlans && typeof rawPlans === 'object') {
    for (const [id, p] of Object.entries(rawPlans as Record<string, unknown>)) {
      if (!p || typeof p !== 'object') continue
      const plan = p as Partial<Plan>
      if (typeof plan.appId !== 'number' || !Array.isArray(plan.disabled)) continue
      plans[id] = {
        appId: plan.appId,
        disabled: plan.disabled.filter((n): n is number => Number.isInteger(n) && n > 0),
        createdAt: typeof plan.createdAt === 'string' ? plan.createdAt : new Date().toISOString(),
        ...(typeof plan.installedAt === 'string' ? { installedAt: plan.installedAt } : {})
      }
    }
  }
  return { version: 1, plans }
}

const sortedUnique = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b)
const sameIds = (a: readonly number[], b: readonly number[]): boolean => {
  const x = sortedUnique(a)
  const y = sortedUnique(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createSteamDlcService(deps: SteamDlcDeps): SteamDlcService {
  const { log } = deps
  const io = deps.io ?? defaultIo()
  const steamPaths = deps.steamPaths ?? defaultSteamPaths
  const appDlc = deps.appDlc ?? fetchSteamcmdDlc
  const names = deps.names ?? ((ids: number[]) => fetchItemNames(ids))
  const now = deps.now ?? Date.now
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 60_000
  const pollMs = deps.pollMs ?? 1_000
  const retryMs = deps.retryMs ?? 60_000
  const changeDelayMs = deps.changeDelayMs ?? 5_000
  const startDelayMs = deps.startDelayMs ?? 15_000

  const store = new JsonStore<PlansFile>({
    file: deps.plansFile,
    defaults: () => ({ version: 1, plans: {} }),
    normalize: normalizePlans
  })
  let loading: Promise<unknown> | null = null
  const ensureLoaded = (): Promise<unknown> => (loading ??= store.load())

  const listCache = new Map<number, { until: number; items: DlcEntry[] }>()
  let ownedCache: { until: number; value: Set<number> | null } | null = null
  let applyChain: Promise<unknown> = Promise.resolve()
  let slowExit = false
  /** steam.exe of a Steam this service closed and has not started again yet (PlayOut quitting starts it). */
  let closedSteam: string | null = null
  /** Per plan, how many times Steam did not close in time: after MAX_PLAN_SHUTDOWN_TIMEOUTS the plan gives up. */
  const shutdownTimeouts = new Map<string, number>()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let processing: Promise<void> | null = null
  let processAgain = false
  let unsubscribe: (() => void) | null = null

  function steamGame(gameId: string): { game: Game; appId: number } {
    const game = deps.library.getGame(gameId)
    if (!game) throw new Error(tMain('mainSteamDlc.notInLibrary'))
    const appId = game.source === 'steam' ? steamAppIdOf(game) : null
    if (appId === null) throw new Error(tMain('mainSteamDlc.notSteamGame', { title: game.title }))
    return { game, appId }
  }

  /** The steamapps folders to look in: the game's own library first (its installDir is steamapps\common\<dir>). */
  function steamappsDirs(game: Game, paths: SteamPaths): string[] {
    const dirs: string[] = []
    if (game.installDir) {
      const common = dirname(game.installDir)
      if (basename(common).toLowerCase() === 'common') dirs.push(dirname(common))
    }
    for (const lib of paths.libraries) dirs.push(join(lib, 'steamapps'))
    const seen = new Set<string>()
    return dirs.filter((d) => {
      const key = d.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async function findAcf(game: Game, appId: number, paths?: SteamPaths): Promise<string | null> {
    const p = paths ?? (await steamPaths())
    for (const dir of steamappsDirs(game, p)) {
      const file = join(dir, `appmanifest_${appId}.acf`)
      if (await io.exists(file)) return file
    }
    return null
  }

  async function readAcf(path: string): Promise<AcfDlcState | null> {
    const data = await io.readFile(path)
    if (!data) return null
    try {
      return readAcfDlc(decodeVdf(data).text)
    } catch (err) {
      log.warn(`${path}: not readable: ${message(err)}`)
      return null
    }
  }

  const knownIds = (acf: AcfDlcState | null): number[] =>
    acf ? sortedUnique([...acf.installedDlc, ...acf.userDisabled, ...acf.mountedDisabled]) : []

  /** The game's DLC with names (cached); on a failure the DLC the acf names, and the error. */
  async function dlcList(
    appId: number,
    known: number[]
  ): Promise<{ items: DlcEntry[]; error?: string }> {
    const cached = listCache.get(appId)
    const withKnown = (items: DlcEntry[]): DlcEntry[] => [
      ...items,
      ...known
        .filter((id) => !items.some((d) => d.appId === id))
        .map((id) => ({ appId: id, sizeBytes: null, steamOnly: false, name: `DLC ${id}` }))
    ]
    if (cached && cached.until > now()) return { items: withKnown(cached.items) }
    let list: SteamcmdDlc[]
    try {
      list = await appDlc(appId)
    } catch (err) {
      log.warn(`steam ${appId}: DLC list not read: ${message(err)}`)
      return {
        items: withKnown([]),
        error: tMain('mainSteamDlc.listUnavailable')
      }
    }
    let named = new Map<number, string>()
    let namesOk = true
    if (list.length > 0) {
      try {
        named = await names(list.map((d) => d.appId))
      } catch (err) {
        namesOk = false
        log.warn(`steam ${appId}: DLC names not read: ${message(err)}`)
      }
    }
    const items = list.map((d) => ({ ...d, name: named.get(d.appId) ?? `DLC ${d.appId}` }))
    listCache.set(appId, { until: now() + (namesOk ? LIST_CACHE_MS : LIST_RETRY_MS), items })
    return { items: withKnown(items) }
  }

  async function ownedApps(): Promise<Set<number> | null> {
    if (!deps.ownedApps) return null
    if (ownedCache && ownedCache.until > now()) return ownedCache.value
    const value = await deps.ownedApps().catch(() => null)
    ownedCache = { until: now() + OWNED_CACHE_MS, value }
    return value
  }

  async function steamRunning(): Promise<boolean> {
    return (await runningProcesses(io.run, ['steam.exe'])).length > 0
  }

  async function steamDownloading(paths: SteamPaths): Promise<boolean> {
    for (const lib of paths.libraries) {
      const dir = join(lib, 'steamapps')
      for (const name of await io.listDir(dir)) {
        if (!/^appmanifest_\d+\.acf$/i.test(name)) continue
        const data = await io.readFile(join(dir, name)).catch(() => null)
        if (data && acfShowsDownload(data.toString('utf8'))) return true
      }
    }
    return false
  }

  async function blockedReason(paths: SteamPaths): Promise<string | null> {
    if (deps.gameRunning()) return gameRunningMessage()
    // A Steam game started outside PlayOut: Steam names it in RunningAppID (0 when none).
    // reg.exe failing is not "no game": Steam is left alone until it can be told.
    let running: Awaited<ReturnType<typeof regQuery>>
    try {
      running = await regQuery(io.run, STEAM_KEY, 'RunningAppID')
    } catch {
      return runningCheckFailedMessage()
    }
    if (running && typeof running.data === 'number' && running.data !== 0)
      return gameRunningMessage()
    if (await steamDownloading(paths)) return steamDownloadingMessage()
    return null
  }

  function startSteam(exe: string): void {
    closedSteam = null
    try {
      io.spawnDetached(exe, ['-silent'])
    } catch (err) {
      log.warn(`could not start Steam again: ${message(err)}`)
    }
  }

  async function waitForSteamExit(timeoutMs: number, everyMs: number): Promise<boolean> {
    const polls = Math.max(1, Math.ceil(timeoutMs / everyMs))
    for (let i = 0; i < polls && !disposed; i++) {
      await io.sleep(everyMs)
      const running = await steamRunning().catch(() => true)
      if (!running) return true
    }
    return false
  }

  /** Steam was asked to close and was slow: start it again once it has closed (it may be syncing or updating). */
  function watchSlowExit(exe: string): void {
    slowExit = true
    void (async () => {
      try {
        if (await waitForSteamExit(SLOW_EXIT_WATCH_MS, SLOW_EXIT_POLL_MS)) {
          log.info('Steam closed late; starting it again')
          startSteam(exe)
        } else {
          log.warn('Steam did not close after -shutdown; leaving it running')
        }
      } finally {
        slowExit = false
      }
    })()
  }

  /** Write `disabled` as the game's UserConfig.DisabledDLC, closing and starting Steam around it. One at a time. */
  function apply(game: Game, appId: number, disabled: number[]): Promise<ApplyResult> {
    const run = applyChain.then(() => applyNow(game, appId, disabled))
    applyChain = run.catch(() => undefined)
    return run
  }

  async function applyNow(game: Game, appId: number, disabled: number[]): Promise<ApplyResult> {
    if (slowExit) {
      return {
        ok: false,
        error: tMain('mainSteamDlc.slowRestart')
      }
    }
    const paths = await steamPaths()
    if (!paths.root) return { ok: false, error: tMain('mainSteamDlc.steamMissing') }
    const exe = join(paths.root, 'steam.exe')
    const acfPath = await findAcf(game, appId, paths)
    if (!acfPath)
      return { ok: false, error: tMain('mainSteamDlc.noInstallRecord', { title: game.title }) }
    const before = await io.readFile(acfPath)
    if (!before)
      return { ok: false, error: tMain('mainSteamDlc.noInstallRecord', { title: game.title }) }
    let planned: { text: string; changed: boolean }
    try {
      planned = writeUserDisabledDlc(decodeVdf(before).text, disabled)
    } catch {
      return { ok: false, error: tMain('mainSteamDlc.recordUnreadable', { title: game.title }) }
    }

    let running: boolean
    try {
      running = await steamRunning()
    } catch {
      return {
        ok: false,
        error: tMain('mainSteamDlc.steamRunningUnknown')
      }
    }
    if (!planned.changed) {
      // Already asked for; a Steam that is not running applies it when it starts.
      const state = await readAcf(acfPath)
      if (!running && state && !sameIds(state.userDisabled, state.mountedDisabled)) startSteam(exe)
      return { ok: true, restartedSteam: false }
    }

    const blocked = await blockedReason(paths)
    if (blocked) return { ok: false, error: blocked }

    if (running) {
      log.info(`closing Steam to change the DLC of ${game.title}`)
      io.spawnDetached(exe, ['-shutdown'])
      closedSteam = exe
      if (!(await waitForSteamExit(shutdownTimeoutMs, pollMs))) {
        closedSteam = null
        watchSlowExit(exe)
        return {
          ok: false,
          timedOut: true,
          error: tMain('mainSteamDlc.closeTimeout', {
            seconds: Math.round(shutdownTimeoutMs / 1000)
          })
        }
      }
    }

    // Steam writes the file as it exits: the edit is made on what it wrote.
    try {
      const data = await io.readFile(acfPath)
      if (!data) throw new Error('the install record is gone')
      const { text, bom } = decodeVdf(data)
      const next = writeUserDisabledDlc(text, disabled)
      if (next.changed) {
        await io.copyFile(acfPath, `${acfPath}.playout-bak`)
        await writeFileAtomic(io, acfPath, encodeVdf(next.text, bom))
      }
    } catch (err) {
      log.warn(`${game.title}: DLC choice not written: ${message(err)}`)
      if (running) startSteam(exe)
      return { ok: false, error: tMain('mainSteamDlc.notSaved', { error: message(err) }) }
    }
    log.info(
      `${game.title}: DLC turned off: ${disabled.length ? disabled.join(',') : 'none'}; starting Steam`
    )
    startSteam(exe)
    return { ok: true, restartedSteam: running }
  }

  async function savePlans(mutate: (plans: Record<string, Plan>) => void): Promise<void> {
    store.set((draft) => {
      mutate(draft.plans)
    })
    await store.flush()
  }

  /**
   * The DLC a request may switch: listed, not Steam-only, and not hidden as not owned (what Manage DLC and the picker
   * show). Every other id keeps the state Steam has for it, so a change never touches DLC the user could not see.
   */
  function switchableIds(
    items: readonly DlcEntry[],
    acf: AcfDlcState | null,
    owned: Set<number> | null
  ): Set<number> {
    const out = new Set<number>()
    for (const d of items) {
      if (d.steamOnly) continue
      const installed = acf?.installedDlc.includes(d.appId) ?? false
      if (!installed && owned && !owned.has(d.appId)) continue
      out.add(d.appId)
    }
    return out
  }

  /** `wanted` for the switchable DLC, and the ids the user could not switch as they are now. */
  function finalDisabled(
    wanted: readonly number[],
    switchable: Set<number>,
    acf: AcfDlcState | null
  ): number[] {
    return sortedUnique([
      ...wanted.filter((id) => switchable.has(id)),
      ...(acf?.userDisabled ?? []).filter((id) => !switchable.has(id))
    ])
  }

  async function steamDlc(gameId: string): Promise<SteamDlcInfo> {
    const { game, appId } = steamGame(gameId)
    await ensureLoaded()
    const paths = await steamPaths()
    const acfPath = await findAcf(game, appId, paths)
    const acf = acfPath ? await readAcf(acfPath) : null
    const [{ items, error }, owned] = await Promise.all([
      dlcList(appId, knownIds(acf)),
      ownedApps()
    ])
    const dlc: SteamDlcItem[] = []
    let notOwnedCount = 0
    for (const d of items) {
      const installed = acf?.installedDlc.includes(d.appId) ?? false
      const ownedFlag = installed ? true : owned ? owned.has(d.appId) : null
      if (ownedFlag === false) {
        notOwnedCount++
        continue
      }
      const userOff = acf?.userDisabled.includes(d.appId) ?? false
      const mountedOff = acf?.mountedDisabled.includes(d.appId) ?? false
      dlc.push({
        appId: d.appId,
        name: d.name,
        sizeBytes: d.sizeBytes,
        owned: ownedFlag,
        enabled: !userOff,
        installed,
        pending: acf !== null && userOff !== mountedOff,
        steamOnly: d.steamOnly
      })
    }
    dlc.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
        a.appId - b.appId
    )
    const steamIsRunning = await steamRunning().catch(() => false)
    const blocked = paths.root ? await blockedReason(paths).catch(() => null) : null
    const plan = store.get().plans[gameId]
    return {
      gameId,
      appId,
      installed: acf !== null,
      dlc,
      notOwnedCount,
      steamRunning: steamIsRunning,
      blocked,
      plannedDisabled: plan ? [...plan.disabled] : null,
      ...(error ? { error } : {})
    }
  }

  async function setSteamDlc(gameId: string, disabled: number[]): Promise<SteamDlcResult> {
    const { game, appId } = steamGame(gameId)
    await ensureLoaded()
    const acfPath = game.installed ? await findAcf(game, appId) : null
    const acf = acfPath ? await readAcf(acfPath) : null
    const known = knownIds(acf)
    const { items, error } = await dlcList(appId, known)
    const valid = new Set([...items.map((d) => d.appId), ...known])
    const unknown = disabled.filter((id) => !valid.has(id))
    if (unknown.length > 0)
      return {
        ok: false,
        error: tMain('mainSteamDlc.notDlc', {
          title: game.title,
          ids: sortedUnique(unknown).join(', ')
        })
      }
    // Opt-in content, DLC the game manages and DLC hidden as not owned stay as Steam has them.
    const switchable = switchableIds(items, acf, await ownedApps())
    const wanted = sortedUnique(disabled.filter((id) => switchable.has(id)))

    if (game.installed && (!acfPath || !acf)) {
      return {
        ok: false,
        error: tMain('mainSteamDlc.noInstallRecordHere', { title: game.title })
      }
    }
    if (!acfPath || !acf) {
      if (wanted.length === 0) {
        // Every DLC on: Steam's default, nothing to apply after the install (an older plan goes).
        if (store.get().plans[gameId]) await savePlans((plans) => delete plans[gameId])
        return { ok: true, planned: true }
      }
      await savePlans((plans) => {
        plans[gameId] = {
          appId,
          disabled: sortedUnique(wanted),
          createdAt: new Date(now()).toISOString()
        }
      })
      log.info(`${game.title}: DLC choice saved for when its install finishes`)
      return { ok: true, planned: true }
    }

    // Without Steam's list, which DLC are opt-in or game-managed is unknown: nothing is changed.
    if (error) return { ok: false, error: dlcListFailedMessage() }
    const final = finalDisabled(wanted, switchable, acf)
    const applied = await apply(game, appId, final)
    const result: SteamDlcResult = { ok: applied.ok }
    if (applied.error !== undefined) result.error = applied.error
    if (applied.restartedSteam !== undefined) result.restartedSteam = applied.restartedSteam
    // The user's own change starts a waiting plan's count of slow Steam closes afresh.
    shutdownTimeouts.delete(gameId)
    const plan = store.get().plans[gameId]
    if (plan) {
      // The user's latest choice replaces a plan still waiting: dropped once applied, else applied in its place.
      await savePlans((plans) => {
        if (result.ok) delete plans[gameId]
        else plans[gameId] = { ...plan, disabled: final }
      })
    }
    return result
  }

  /** 'done' (applied or nothing to do), 'retry' (blocked, Steam busy) or an error to report and give up on. */
  async function applyPlan(
    game: Game,
    plan: Plan
  ): Promise<{ state: 'done' } | { state: 'retry' | 'give-up'; error: string }> {
    const acfPath = await findAcf(game, plan.appId)
    const acf = acfPath ? await readAcf(acfPath) : null
    if (!acfPath || !acf) return { state: 'retry', error: tMain('mainSteamDlc.noRecordYet') }
    const known = knownIds(acf)
    const { items, error } = await dlcList(plan.appId, known)
    // A partial list would apply part of the choice and drop the rest: wait for Steam's list.
    if (error) return { state: 'retry', error }
    const final = finalDisabled(plan.disabled, switchableIds(items, acf, await ownedApps()), acf)
    if (sameIds(final, acf.userDisabled)) return { state: 'done' }
    const result = await apply(game, plan.appId, final)
    if (result.ok) {
      shutdownTimeouts.delete(game.id)
      return { state: 'done' }
    }
    if (result.timedOut) {
      const count = (shutdownTimeouts.get(game.id) ?? 0) + 1
      shutdownTimeouts.set(game.id, count)
      if (count >= MAX_PLAN_SHUTDOWN_TIMEOUTS) {
        return {
          state: 'give-up',
          error: tMain('mainSteamDlc.planTimeouts')
        }
      }
    }
    return { state: 'retry', error: result.error ?? tMain('mainSteamDlc.notApplied') }
  }

  async function processPlansOnce(): Promise<void> {
    await ensureLoaded()
    let retry = false
    let waiting = false
    for (const [gameId, plan] of Object.entries(store.get().plans)) {
      if (disposed) return
      const game = deps.library.getGame(gameId)
      const dropIfSame = (mutate?: () => void): Promise<void> =>
        savePlans((plans) => {
          // A newer choice made meanwhile is kept.
          if (plans[gameId] === plan) delete plans[gameId]
          mutate?.()
        })
      if (!game || game.source !== 'steam') {
        log.info(`${gameId}: DLC plan dropped (the game is gone)`)
        await dropIfSame()
        continue
      }
      if (!game.installed) {
        const age = now() - Date.parse(plan.createdAt)
        // The install it was made for was cancelled or left the queue: a later install (from Steam itself, say) must
        // not close Steam to apply a choice made for that one.
        const installing = deps.installActive ? deps.installActive().includes(gameId) : true
        if (age > PLAN_INSTALL_MAX_MS || (!installing && age > PLAN_INSTALL_GRACE_MS)) {
          log.info(
            `${game.title}: DLC plan dropped (${installing ? 'never installed' : 'its install was stopped'})`
          )
          await dropIfSame()
          continue
        }
        waiting = true
        continue
      }
      if (!plan.installedAt) {
        const installedAt = new Date(now()).toISOString()
        await savePlans((plans) => {
          if (plans[gameId] === plan) plan.installedAt = installedAt
        })
      }
      let outcome: Awaited<ReturnType<typeof applyPlan>>
      try {
        outcome = await applyPlan(game, plan)
      } catch (err) {
        outcome = { state: 'retry', error: message(err) }
      }
      if (outcome.state === 'done') {
        if (store.get().plans[gameId] !== plan) continue
        await dropIfSame()
        log.info(`${game.title}: DLC plan applied`)
        deps.events.emit('steam-dlc:applied', { gameId, title: game.title, ok: true })
        continue
      }
      if (
        outcome.state === 'give-up' ||
        now() - Date.parse(plan.installedAt ?? new Date(now()).toISOString()) > PLAN_APPLY_MAX_MS
      ) {
        log.warn(`${game.title}: DLC plan given up: ${outcome.error}`)
        shutdownTimeouts.delete(gameId)
        await dropIfSame()
        deps.events.emit('steam-dlc:applied', {
          gameId,
          title: game.title,
          ok: false,
          error: outcome.error
        })
        continue
      }
      log.info(`${game.title}: DLC plan waits: ${outcome.error}`)
      retry = true
    }
    if (retry) schedule(retryMs)
    else if (waiting) schedule(PLAN_WAIT_CHECK_MS)
  }

  function processPlans(): Promise<void> {
    if (processing) {
      processAgain = true
      return processing
    }
    processing = (async () => {
      try {
        do {
          processAgain = false
          await processPlansOnce()
        } while (processAgain && !disposed)
      } catch (err) {
        log.warn(`DLC plans: ${message(err)}`)
      } finally {
        processing = null
      }
    })()
    return processing
  }

  function schedule(ms: number): void {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void processPlans()
    }, ms)
  }

  return {
    steamDlc,
    setSteamDlc,
    async openSteamDlcPage(gameId) {
      const { appId } = steamGame(gameId)
      await deps.openExternal(`steam://nav/games/details/${appId}`)
    },
    start() {
      void ensureLoaded().then(() => {
        if (Object.keys(store.get().plans).length > 0) schedule(startDelayMs)
      })
      const onChange = (): void => {
        if (Object.keys(store.get().plans).length > 0) schedule(changeDelayMs)
      }
      const offLibrary = deps.events.on('library:changed', onChange)
      // A cancelled or removed install changes the queue, not the library.
      const offQueue = deps.events.on('installs:queue', onChange)
      unsubscribe = () => {
        offLibrary()
        offQueue()
      }
    },
    processPlans,
    async dispose() {
      // An apply under way gets a moment to finish (Steam closed, file written, Steam started again).
      let wait: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        applyChain,
        new Promise((resolve) => (wait = setTimeout(resolve, 10_000)))
      ])
      clearTimeout(wait)
      disposed = true
      // PlayOut quit after closing Steam and before starting it again: Steam must not stay closed.
      if (closedSteam) startSteam(closedSteam)
      if (timer) clearTimeout(timer)
      timer = null
      unsubscribe?.()
      await store.flush().catch(() => undefined)
    }
  }
}
