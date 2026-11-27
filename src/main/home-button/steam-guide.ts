import { win32 } from 'path'
import type { OverrideStatus } from '../../shared/overlay'
import type { Logger } from '../logger'
import { parseVdf, vdfGet, type VdfObject } from '../util/vdf'
import { regQuery, runningProcesses, writeFileAtomic, type HomeButtonIo } from './io'
import type { OverridesStore, SteamOverrideRecord } from './overrides-store'
import {
  decodeVdf,
  encodeVdf,
  findVdfKey,
  findVdfKeyAt,
  removeVdfKey,
  removeVdfKeyAt,
  setVdfKey,
  setVdfKeyAt
} from './steam-vdf'
import { tMain } from '../i18n'

/**
 * Steam's "Guide button focuses Steam" and "Enable the Steam Overlay while in-game" (docs/home-overlay.md, "Steam and
 * Game Bar overrides"): both off, so the Home button opens only PlayOut's overlay and Steam's never shows over a game.
 *
 * The overlay setting is `"EnableGameOverlay" "1"/"0"` in the account's localconfig.vdf, UserLocalConfigStore > system
 * (Steam's own settings table in steamui.dll maps "enable_overlay" to "system\\EnableGameOverlay"); absent means on.
 *
 * The setting is `"Controller_CheckGuideButton" "1"/"0"`; absent means on. Valve documents neither the key nor its
 * file, and sources disagree: older clients keep it in `<Steam>\config\config.vdf` (InstallConfigStore > Software >
 * Valve > Steam), newer ones per account in `userdata\<accountId>\config\localconfig.vdf` (UserLocalConfigStore). So
 * both files are edited: wherever the key is, its value changes; where it is absent, it is added in that file's
 * block.
 *
 * Steam reads these files when it starts and writes them over when it exits, so an edit while it runs is lost. When
 * Steam runs it is asked to close (`steam.exe -shutdown`, Steam's own save), the files are read again after it has
 * exited (its exit wrote them), edited, and Steam is started again with `-silent`. It is never killed: a forced kill
 * skips Steam's save of everything else.
 */
export const STEAM_GUIDE_KEY = 'Controller_CheckGuideButton'
/** Steam's "Enable the Steam Overlay while in-game" (UserLocalConfigStore > system in localconfig.vdf). */
export const STEAM_OVERLAY_KEY = 'EnableGameOverlay'
const STEAM_ID64_BASE = 76561197960265728n
const CONFIG_BLOCK = ['InstallConfigStore', 'Software', 'Valve', 'Steam']
const LOCAL_BLOCK = ['UserLocalConfigStore']
const LOCAL_SYSTEM_BLOCK = [...LOCAL_BLOCK, 'system']

/**
 * One key PlayOut sets to "0". `exact`: only where it sits directly in `block` (EnableGameOverlay); otherwise
 * wherever it is, added in `block` when absent (the Guide button key, whose block differs between Steam versions).
 */
interface SteamSetting {
  key: string
  block: string[]
  exact?: boolean
}

const CONFIG_SETTINGS: SteamSetting[] = [{ key: STEAM_GUIDE_KEY, block: CONFIG_BLOCK }]
const LOCAL_SETTINGS: SteamSetting[] = [
  { key: STEAM_GUIDE_KEY, block: LOCAL_BLOCK },
  { key: STEAM_OVERLAY_KEY, block: LOCAL_SYSTEM_BLOCK, exact: true }
]

const settingsOfPath = (path: string): SteamSetting[] =>
  /localconfig\.vdf$/i.test(path) ? LOCAL_SETTINGS : CONFIG_SETTINGS

function valuesOf(text: string, s: SteamSetting): string[] {
  return (s.exact ? findVdfKeyAt(text, s.block, s.key) : findVdfKey(text, s.key)).map(
    (e) => e.value
  )
}

function setSetting(
  text: string,
  s: SteamSetting,
  value: string
): { text: string; changed: boolean; previous: string | null } {
  return s.exact ? setVdfKeyAt(text, s.block, s.key, value) : setVdfKey(text, s.key, value, s.block)
}

function removeSetting(text: string, s: SteamSetting): string {
  return (s.exact ? removeVdfKeyAt(text, s.block, s.key) : removeVdfKey(text, s.key)).text
}

/** What a file entry of the record says PlayOut found before its edits, per key (older records: the Guide key only). */
function originalsOf(file: SteamOverrideRecord['files'][number]): Record<string, string | null> {
  return file.originals ?? { [STEAM_GUIDE_KEY]: file.original }
}
const STEAM_KEY = 'HKCU\\Software\\Valve\\Steam'

export interface SteamGuideDeps {
  io: HomeButtonIo
  store: OverridesStore
  /** Backups of the files go in `<dataDir>\steam-backup`. */
  dataDir: string
  log: Logger
  /** How long Steam gets to close (default 30 s). */
  shutdownTimeoutMs?: number
  /** A PlayOut game is running: Steam is not closed then (it could take the game with it). */
  gameRunning?: () => boolean
  pollMs?: number
  /** After a timed-out close: how often to look whether Steam has exited (default 2 s)... */
  slowExitPollMs?: number
  /** ...and for how long (default 5 minutes), to start it again once it has. */
  slowExitWatchMs?: number
  now?: () => number
}

export interface SteamGuideOverride {
  /** Turn the setting off. `onPending` is called when Steam has to close first (that can take a while). */
  apply(onPending?: () => void): Promise<OverrideStatus>
  /** Put back what PlayOut changed, where the value is still PlayOut's. 'off' when done. */
  restore(onPending?: () => void): Promise<OverrideStatus>
  /**
   * At start, before apply/restore: when PlayOut quit or crashed after asking Steam to close and before starting it
   * again (the store still holds the steamClosed marker), start Steam if it is not running. Never throws.
   */
  recover(): Promise<void>
}

/** The account id (userdata folder name) of a SteamID64; null when it is not one. */
export function accountIdOf(steamId64: string): string | null {
  if (!/^\d{17}$/.test(steamId64)) return null
  const id = BigInt(steamId64) - STEAM_ID64_BASE
  return id > 0n && id < 2n ** 32n ? id.toString() : null
}

/**
 * The signed-in account from loginusers.vdf: the user marked MostRecent, else the one Steam signs in automatically
 * (AutoLoginUser = its AccountName), else the most recent timestamp. Keys compare without case (some Steam versions
 * write "mostrecent").
 */
export function pickLoginUser(loginUsers: VdfObject, autoLoginUser: string | null): string | null {
  const users = vdfGet(loginUsers, 'users')
  if (!users || typeof users !== 'object') return null
  const entries = Object.entries(users).filter(
    (e): e is [string, VdfObject] => typeof e[1] === 'object' && accountIdOf(e[0]) !== null
  )
  const pick =
    entries.find(([, u]) => String(vdfGet(u, 'MostRecent') ?? '') === '1') ??
    (autoLoginUser
      ? entries.find(
          ([, u]) =>
            String(vdfGet(u, 'AccountName') ?? '').toLowerCase() === autoLoginUser.toLowerCase()
        )
      : undefined) ??
    [...entries].sort(
      (a, b) => Number(vdfGet(b[1], 'timestamp') ?? 0) - Number(vdfGet(a[1], 'timestamp') ?? 0)
    )[0]
  return pick ? accountIdOf(pick[0]) : null
}

interface SteamInstall {
  steamPath: string
  exe: string
  accountId: string | null
}

interface Target {
  path: string
  settings: SteamSetting[]
  /** Name of its backup copy. */
  backupName: string
}

interface TargetRead {
  target: Target
  text: string
  bom: boolean
  /** Per key of target.settings: its values in the file. */
  values: Record<string, string[]>
}

const isPlayOutValue = (values: string[] | undefined): boolean =>
  !!values && values.length > 0 && values.every((v) => v === '0')
/** Every key PlayOut sets in this file holds PlayOut's value. */
const isPlayOutFile = (r: TargetRead): boolean =>
  r.target.settings.every((s) => isPlayOutValue(r.values[s.key]))
const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Steam is not closed while a game runs; the change waits (the service tries again later). */
export class SteamBusyError extends Error {
  constructor() {
    super(tMain('mainApp.steamGuide.waiting'))
    this.name = 'SteamBusyError'
  }
}

/** The pending message of an override that waits for the game to end (the service retries it). */
export const STEAM_BUSY_MESSAGE = new SteamBusyError().message

export function createSteamGuideOverride(deps: SteamGuideDeps): SteamGuideOverride {
  const { io, store, log } = deps
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 30_000
  const pollMs = deps.pollMs ?? 500
  const slowExitPollMs = deps.slowExitPollMs ?? 2_000
  const slowExitWatchMs = deps.slowExitWatchMs ?? 5 * 60_000
  const now = deps.now ?? Date.now
  /** Watching a Steam that was slow to close, to start it again once it has (null: not watching). */
  let slowExit: Promise<void> | null = null

  async function locate(): Promise<SteamInstall | null> {
    const pathValue = await regQuery(io.run, STEAM_KEY, 'SteamPath')
    if (!pathValue || typeof pathValue.data !== 'string' || !pathValue.data) return null
    const steamPath = win32.normalize(pathValue.data.replace(/\//g, '\\'))
    const exe = win32.join(steamPath, 'steam.exe')
    if (!(await io.exists(exe))) return null

    // ActiveUser is only set while Steam runs (and may drop to 0 when it exits), so it is read before any shutdown.
    let accountId: string | null = null
    const active = await regQuery(io.run, `${STEAM_KEY}\\ActiveProcess`, 'ActiveUser').catch(
      () => null
    )
    if (active && typeof active.data === 'number' && active.data > 0)
      accountId = String(active.data)
    if (!accountId) {
      const data = await io.readFile(win32.join(steamPath, 'config', 'loginusers.vdf'))
      if (data) {
        try {
          const auto = await regQuery(io.run, STEAM_KEY, 'AutoLoginUser').catch(() => null)
          accountId = pickLoginUser(
            parseVdf(decodeVdf(data).text),
            auto && typeof auto.data === 'string' ? auto.data : null
          )
        } catch (err) {
          log.warn('loginusers.vdf unreadable', err)
        }
      }
    }
    return { steamPath, exe, accountId }
  }

  async function targetsOf(install: SteamInstall): Promise<Target[]> {
    const all: Target[] = [
      {
        path: win32.join(install.steamPath, 'config', 'config.vdf'),
        settings: CONFIG_SETTINGS,
        backupName: 'config.vdf'
      }
    ]
    if (install.accountId) {
      all.push({
        path: win32.join(
          install.steamPath,
          'userdata',
          install.accountId,
          'config',
          'localconfig.vdf'
        ),
        settings: LOCAL_SETTINGS,
        backupName: `localconfig-${install.accountId}.vdf`
      })
    }
    const present: Target[] = []
    for (const t of all) if (await io.exists(t.path)) present.push(t)
    return present
  }

  async function readTarget(target: Target): Promise<TargetRead | null> {
    const data = await io.readFile(target.path)
    if (!data) return null
    const { text, bom } = decodeVdf(data)
    const values: Record<string, string[]> = {}
    for (const s of target.settings) values[s.key] = valuesOf(text, s)
    return { target, text, bom, values }
  }

  async function readAll(targets: Target[]): Promise<TargetRead[]> {
    const reads: TargetRead[] = []
    for (const t of targets) {
      const r = await readTarget(t)
      if (r) reads.push(r)
    }
    return reads
  }

  async function steamRunning(): Promise<boolean> {
    return (await runningProcesses(io.run, ['steam.exe'])).length > 0
  }

  /**
   * Close Steam when it runs; true when it was running (the caller then starts it again with `restartSteam`).
   * Throws when it does not close in time; Steam is then watched in the background and started again once it exits.
   */
  async function closeSteam(exe: string, onPending?: () => void): Promise<boolean> {
    // A Steam that was slow to close is about to be started again: no change until then.
    if (slowExit) {
      throw new Error(tMain('mainApp.steamGuide.slowRestart'))
    }
    if (!(await steamRunning())) return false
    // Never while a game runs: closing Steam would close a Steam game, or pull the overlay and controller support
    // from under any other. Steam names the game it runs in RunningAppID (0 when none).
    const appId = await regQuery(io.run, STEAM_KEY, 'RunningAppID').catch(() => null)
    if (deps.gameRunning?.() || (appId && typeof appId.data === 'number' && appId.data !== 0))
      throw new SteamBusyError()
    onPending?.()
    log.info('closing Steam to change its settings (Guide button, in-game overlay)')
    // Recorded first, so a PlayOut that quits or crashes before Steam is started again does it at its next start.
    await store.set('steamClosed', { steamClosedAt: now(), exe })
    io.spawnDetached(exe, ['-shutdown'])
    const polls = Math.max(1, Math.ceil(shutdownTimeoutMs / pollMs))
    for (let i = 0; i < polls; i++) {
      await io.sleep(pollMs)
      if (!(await steamRunning())) return true
    }
    // Steam was told to close and may still do so (a cloud sync or an update on exit): start it again once it has.
    slowExit = watchSlowExit(exe).finally(() => {
      slowExit = null
    })
    throw new Error(
      tMain('mainApp.steamGuide.slowClose', { seconds: Math.round(shutdownTimeoutMs / 1000) })
    )
  }

  async function watchSlowExit(exe: string): Promise<void> {
    try {
      const polls = Math.max(1, Math.ceil(slowExitWatchMs / slowExitPollMs))
      for (let i = 0; i < polls; i++) {
        await io.sleep(slowExitPollMs)
        if (!(await steamRunning())) {
          log.info('Steam closed late; starting it again')
          await restartSteam(exe)
          return
        }
      }
      // Still running: it never closed, so there is nothing to start.
      log.warn('Steam did not close after -shutdown; leaving it running')
      await store.set('steamClosed', undefined)
    } catch (err) {
      log.warn('watching a slow Steam shutdown failed', err)
    }
  }

  function startSteam(exe: string): void {
    try {
      io.spawnDetached(exe, ['-silent'])
    } catch (err) {
      log.warn('could not start Steam again', err)
    }
  }

  /** Start Steam again after closeSteam closed it, and drop the steamClosed marker. */
  async function restartSteam(exe: string): Promise<void> {
    startSteam(exe)
    await store.set('steamClosed', undefined).catch((err: unknown) => {
      log.warn('could not clear the Steam closed marker', err)
    })
  }

  async function backup(target: Target): Promise<string | undefined> {
    const dir = win32.join(deps.dataDir, 'steam-backup')
    const to = win32.join(dir, target.backupName)
    try {
      await io.mkdir(dir)
      await io.copyFile(target.path, to)
      return to
    } catch (err) {
      log.warn('Steam config backup failed', err)
      return undefined
    }
  }

  const failed = (err: unknown): OverrideStatus =>
    err instanceof SteamBusyError
      ? { state: 'pending', message: err.message }
      : { state: 'error', message: err instanceof Error ? err.message : String(err) }

  return {
    async apply(onPending) {
      try {
        const install = await locate()
        if (!install) return { state: 'missing' }
        const targets = await targetsOf(install)
        if (targets.length === 0) {
          return { state: 'error', message: tMain('mainApp.steamGuide.noFiles') }
        }
        const record = (await store.read()).steam
        const settled = (reads: TargetRead[]): OverrideStatus | null =>
          reads.every(isPlayOutFile)
            ? { state: record && record.files.length > 0 ? 'applied' : 'already' }
            : null

        const before = settled(await readAll(targets))
        if (before) return before

        const wasRunning = await closeSteam(install.exe, onPending)
        try {
          // Read again: Steam wrote its files as it exited.
          const reads = await readAll(targets)
          const after = settled(reads)
          if (after) return after
          const files: SteamOverrideRecord['files'] = record ? [...record.files] : []
          const writes: { path: string; data: Buffer }[] = []
          for (const r of reads) {
            if (isPlayOutFile(r)) continue
            let text = r.text
            const found: Record<string, string | null> = {}
            for (const s of r.target.settings) {
              if (isPlayOutValue(r.values[s.key])) continue
              const edit = setSetting(text, s, '0')
              if (!edit.changed) continue
              found[s.key] = edit.previous
              text = edit.text
            }
            if (Object.keys(found).length === 0) continue
            // An original already recorded (an earlier apply) is kept: the value now may be one Steam wrote since.
            const at = files.findIndex((f) => samePath(f.path, r.target.path))
            if (at < 0) {
              files.push({
                path: r.target.path,
                original: found[STEAM_GUIDE_KEY] ?? null,
                originals: found,
                backup: await backup(r.target)
              })
            } else {
              const was = files[at]!
              files[at] = { ...was, originals: { ...found, ...originalsOf(was) } }
            }
            writes.push({ path: r.target.path, data: encodeVdf(text, r.bom) })
          }
          await store.set('steam', { steamPath: install.steamPath, files })
          for (const w of writes) await writeFileAtomic(io, w.path, w.data)
          log.info(
            `Steam's Guide button and in-game overlay settings turned off in ${writes.length} file(s)`
          )
          return { state: 'applied' }
        } finally {
          if (wasRunning) await restartSteam(install.exe)
        }
      } catch (err) {
        log.warn('Steam Guide override failed', err)
        return failed(err)
      }
    },

    async restore(onPending) {
      try {
        const record = (await store.read()).steam
        if (!record) return { state: 'off' }
        const targets: Target[] = record.files.map((f) => ({
          path: f.path,
          settings: settingsOfPath(f.path),
          backupName: ''
        }))
        const fileOf = (r: TargetRead): SteamOverrideRecord['files'][number] | undefined =>
          record.files.find((f) => samePath(f.path, r.target.path))
        // The keys PlayOut changed that still hold its value: anything else was changed since (in Steam's own settings).
        const owedKeys = (r: TargetRead): SteamSetting[] => {
          const file = fileOf(r)
          const originals = file ? originalsOf(file) : {}
          return r.target.settings.filter(
            (s) => s.key in originals && isPlayOutValue(r.values[s.key])
          )
        }
        const owed = async (): Promise<TargetRead[]> =>
          (await readAll(targets)).filter((r) => owedKeys(r).length > 0)
        if ((await owed()).length === 0) {
          await store.set('steam', undefined)
          return { state: 'off' }
        }

        const exe = win32.join(record.steamPath, 'steam.exe')
        const wasRunning = await closeSteam(exe, onPending)
        try {
          for (const r of await owed()) {
            const file = fileOf(r)
            const originals = file ? originalsOf(file) : {}
            let text = r.text
            for (const s of owedKeys(r)) {
              const original = originals[s.key] ?? null
              text = original === null ? removeSetting(text, s) : setSetting(text, s, original).text
            }
            await writeFileAtomic(io, r.target.path, encodeVdf(text, r.bom))
          }
          await store.set('steam', undefined)
          log.info("Steam's Guide button and in-game overlay settings put back")
          return { state: 'off' }
        } finally {
          if (wasRunning) await restartSteam(exe)
        }
      } catch (err) {
        log.warn('Steam Guide restore failed', err)
        return failed(err)
      }
    },

    async recover() {
      try {
        const marker = (await store.read()).steamClosed
        if (!marker) return
        if (!(await steamRunning())) {
          log.info('PlayOut stopped while Steam was closed for a change; starting Steam again')
          startSteam(marker.exe)
        }
        await store.set('steamClosed', undefined)
      } catch (err) {
        log.warn('Steam restart check failed', err)
      }
    }
  }
}
