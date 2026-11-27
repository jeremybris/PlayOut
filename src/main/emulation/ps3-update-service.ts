// PS3 game updates, kept current: for each PS3 game of the library, Sony's update list (ps3-updates.ts) is compared
// with the version the game is at (its installed update's PARAM.SFO), and the missing packages are downloaded,
// checked against Sony's SHA-1 and installed through RPCS3 (`--headless --installpkg`), which unpacks them into the
// dev_hdd0 it uses (Emulation\Updates and DLC\PS3\dev_hdd0). Automatic at start and when PS3 games are added (Settings ›
// Emulators › "Update PS3 games automatically"), and on demand from a game's menu ("Update PS3 game"). Never while
// RPCS3 is running: an install then waits (automatic) or says so (the menu).

import { promises as fs } from 'fs'
import { join } from 'path'
import type { Game, Ps3UpdateProgress, Ps3UpdateResult } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { romGamePath } from '../streaming/rom-transfer'
import type { Runner } from '../emulator-setup/types'
import { activePs3HddDir, ps3TitleIds } from './ps3-hdd'
import {
  compareVersions,
  downloadPackage,
  fetchUpdateList,
  installedVersion,
  pendingPackages,
  rpcs3Dev0,
  type FileFetch,
  type Ps3UpdatePackage,
  type TextGet
} from './ps3-updates'
import { tMain } from '../i18n'

export interface Ps3UpdateServiceDeps {
  library: { games(): Game[]; getGame(id: string): Game | undefined }
  romsRoot(): string | null | undefined
  emulationDir(): string
  /** rpcs3.exe in use (PlayOut's own, or the one Settings › Emulators names); null when there is none. */
  rpcs3Exe(): Promise<string | null>
  /** Whether an rpcs3.exe process is running (tasklist; true when that cannot be told). */
  rpcs3Running(): Promise<boolean>
  /** Settings › Emulators › "Update PS3 games automatically". */
  autoUpdate(): boolean
  /** A game PlayOut started is running: the automatic pass waits (no downloads or installs under a game). */
  gameRunning?(): boolean
  /** Whether the PC is online (Electron's net.isOnline); default true. */
  isOnline?: () => boolean
  /** Where packages are downloaded to (each is deleted once installed). */
  cacheDir: string
  events: Pick<EventBus, 'emit'>
  log: Logger
  run: Runner
  // --- seams (tests) ---
  get?: TextGet
  fetch?: FileFetch
  now?: () => number
  /** The automatic pass after start (default 90 s); then again every `everyMs` (default 12 h). */
  startDelayMs?: number
  everyMs?: number
  /** Library changes are looked at this long after the last one (default 10 s). */
  kickDebounceMs?: number
}

export interface Ps3UpdateService {
  /** The game menu's "Update PS3 game": check now and install what is missing. */
  updatePs3Game(gameId: string): Promise<Ps3UpdateResult>
  start(): void
  /** The library changed: newly added PS3 games are checked soon (when automatic updates are on). */
  kick(): void
  dispose(): void
}

/** A title's update list is asked for at most this often by the automatic pass. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
/** RPCS3's install of one package may take this long at most. */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createPs3UpdateService(deps: Ps3UpdateServiceDeps): Ps3UpdateService {
  const { log } = deps
  const now = (): number => deps.now?.() ?? Date.now()
  const controller = new AbortController()
  let disposed = false
  /** One game at a time: downloads and RPCS3 installs never overlap. */
  let queue: Promise<unknown> = Promise.resolve()
  /** Title id -> when its list was last asked for (the automatic pass skips it for a day). */
  const checkedAt = new Map<string, number>()
  const timers: ReturnType<typeof setTimeout>[] = []
  let kickTimer: ReturnType<typeof setTimeout> | null = null
  /** PS3 games seen by the automatic pass, so a library change only checks the new ones. */
  const seen = new Set<string>()
  /** The automatic pass has gone through the library once (before that, kick() has nothing to compare with). */
  let passed = false
  /** The first scheduled pass has fired (kick() waits for it, whether or not it checked anything). */
  let firstFired = false

  const ps3Games = (): Game[] =>
    deps.library
      .games()
      .filter(
        (g) =>
          g.source === 'rom' &&
          !g.remote &&
          g.installed &&
          g.launch.kind === 'emulator' &&
          g.launch.systemId === 'ps3'
      )

  function report(p: Ps3UpdateProgress): void {
    deps.events.emit('ps3-update:progress', p)
  }

  function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job, job)
    queue = next.catch(() => undefined)
    return next
  }

  /**
   * Check one game and install what it misses. `manual`: from the menu (reports "up to date", fails when RPCS3 is
   * open); else the automatic pass (quiet unless something is installed, skips a title checked in the last day).
   */
  async function updateGame(game: Game, manual: boolean): Promise<Ps3UpdateResult> {
    const title = game.title
    const base = { gameId: game.id, title, manual, bytes: null, total: null, message: null }
    const root = deps.romsRoot()
    if (!root)
      return { outcome: 'failed', version: null, message: tMain('mainEmulation.ps3.noRomFolder') }
    const romPath = romGamePath(game, root)
    const ids = await ps3TitleIds(romPath)
    if (!ids.length)
      return {
        outcome: 'failed',
        version: null,
        message: tMain('mainEmulation.ps3.noSerial', { title })
      }
    // The dev_hdd0 the RPCS3 in use installs into (its vfs.yml): PlayOut's own Updates and DLC\PS3\dev_hdd0 for the
    // RPCS3 PlayOut set up, maybe another for one chosen in Settings. Without RPCS3, PlayOut's own.
    const exe = await deps.rpcs3Exe()
    const dev0 = exe
      ? await rpcs3Dev0(exe)
      : join(await activePs3HddDir(deps.emulationDir()), 'dev_hdd0')
    const gameFolder = (await fs.stat(romPath).catch(() => null))?.isDirectory() ? romPath : null
    let latest: string | null = null
    let installedAny = false
    for (const id of ids) {
      if (!manual && now() - (checkedAt.get(id) ?? 0) < CHECK_EVERY_MS) continue
      if (manual) report({ ...base, phase: 'checking', version: null })
      let packages: Ps3UpdatePackage[]
      try {
        packages = await fetchUpdateList(id, deps.get, controller.signal)
        checkedAt.set(id, now())
      } catch (err) {
        const why = tMain('mainEmulation.ps3.serverUnreachable', { error: message(err) })
        if (manual) report({ ...base, phase: 'failed', version: null, message: why })
        return { outcome: 'failed', version: null, message: why }
      }
      const current = await installedVersion(dev0, id, gameFolder)
      const pending = pendingPackages(packages, current)
      latest = packages.at(-1)?.version ?? latest
      if (!pending.length) {
        if (manual)
          report({
            ...base,
            phase: 'up-to-date',
            version: current ?? latest,
            message: packages.length ? null : tMain('mainEmulation.ps3.noUpdatesForGame')
          })
        continue
      }
      // RPCS3 must be closed to install (it would be writing the same dev_hdd0).
      if (await deps.rpcs3Running()) {
        const why = tMain('mainEmulation.ps3.rpcs3Open')
        report({
          ...base,
          phase: manual ? 'failed' : 'waiting',
          version: pending.at(-1)!.version,
          message: why
        })
        // The automatic pass tries again next time.
        checkedAt.delete(id)
        return { outcome: 'failed', version: current, message: why }
      }
      if (!exe) {
        const why = tMain('mainEmulation.ps3.rpcs3Missing')
        // The automatic pass stays quiet about it (it would say so every day); the menu says it.
        report({ ...base, phase: manual ? 'failed' : 'waiting', version: null, message: why })
        return { outcome: 'failed', version: current, message: why }
      }
      for (const pkg of pending) {
        if (disposed) break
        try {
          let lastReport = 0
          const file = await downloadPackage(pkg, deps.cacheDir, {
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            signal: controller.signal,
            onBytes: (done, total) => {
              if (now() - lastReport < 250 && done < total) return
              lastReport = now()
              report({ ...base, phase: 'downloading', version: pkg.version, bytes: done, total })
            }
          })
          report({ ...base, phase: 'installing', version: pkg.version })
          if (await deps.rpcs3Running()) throw new Error(tMain('mainEmulation.ps3.rpcs3Opened'))
          log.info(`${title}: installing update ${pkg.version} (${id}) through RPCS3`)
          const r = await deps.run(exe, ['--headless', '--installpkg', file], {
            timeoutMs: INSTALL_TIMEOUT_MS
          })
          const after = await installedVersion(dev0, id, gameFolder)
          if (!after || compareVersions(after, pkg.version) < 0)
            throw new Error(
              r.stderr
                ? tMain('mainEmulation.ps3.rpcs3FailedSaid', {
                    code: String(r.code),
                    said: r.stderr.trim().slice(0, 200)
                  })
                : tMain('mainEmulation.ps3.rpcs3Failed', { code: String(r.code) })
            )
          await fs.rm(file, { force: true }).catch(() => undefined)
          installedAny = true
          log.info(`${title}: update ${pkg.version} installed`)
        } catch (err) {
          const why = tMain('mainEmulation.ps3.installFailed', {
            version: pkg.version,
            title,
            error: message(err)
          })
          log.warn(why)
          checkedAt.delete(id)
          report({ ...base, phase: 'failed', version: pkg.version, message: why })
          return {
            outcome: 'failed',
            version: await installedVersion(dev0, id, gameFolder),
            message: why
          }
        }
      }
      const now_ = await installedVersion(dev0, id, gameFolder)
      report({ ...base, phase: 'done', version: now_ })
      latest = now_ ?? latest
    }
    if (installedAny)
      return {
        outcome: 'installed',
        version: latest,
        message: tMain('mainEmulation.ps3.updatedTo', {
          title,
          version: latest ?? tMain('mainEmulation.ps3.latestVersion')
        })
      }
    return latest
      ? {
          outcome: 'up-to-date',
          version: latest,
          message: tMain('mainEmulation.ps3.upToDate', { title, version: latest })
        }
      : {
          outcome: 'no-updates',
          version: null,
          message: tMain('mainEmulation.ps3.noUpdates', { title })
        }
  }

  /** The automatic pass: every PS3 game not checked in the last day (only `only` when given), one after another. */
  async function pass(only?: Set<string>): Promise<void> {
    if (disposed || !deps.autoUpdate() || !(deps.isOnline?.() ?? true)) return
    // Not while a game is being played: the next pass (or a later kick) does it.
    if (deps.gameRunning?.()) return
    const games = ps3Games()
    for (const game of games) {
      if (only && !only.has(game.id)) {
        // Not asked about in this pass, but already known: not "new" for a later kick.
        seen.add(game.id)
        continue
      }
      // Stopped part-way (a game started, automatic updates turned off): the games not reached stay "new", so a
      // later kick still checks them.
      if (disposed || !deps.autoUpdate() || deps.gameRunning?.()) return
      seen.add(game.id)
      await serial(() => updateGame(game, false)).catch((err) =>
        log.warn(`${game.title}: PS3 update check failed: ${message(err)}`)
      )
    }
    if (!only) passed = true
  }

  return {
    async updatePs3Game(gameId) {
      const game = deps.library.getGame(gameId)
      if (!game || game.launch.kind !== 'emulator' || game.launch.systemId !== 'ps3' || game.remote)
        return { outcome: 'failed', version: null, message: tMain('mainEmulation.ps3.notPs3Game') }
      return serial(() => updateGame(game, true))
    },
    start() {
      if (disposed) return
      const first = setTimeout(() => {
        firstFired = true
        void pass()
        const every = setInterval(() => void pass(), deps.everyMs ?? 12 * 60 * 60 * 1000)
        every.unref?.()
        timers.push(every as unknown as ReturnType<typeof setTimeout>)
      }, deps.startDelayMs ?? 90_000)
      first.unref?.()
      timers.push(first)
    },
    kick() {
      // Before the first pass every game would look new: the first pass checks them all anyway.
      if (disposed || !firstFired) return
      if (kickTimer) clearTimeout(kickTimer)
      kickTimer = setTimeout(() => {
        kickTimer = null
        // No pass has gone through the library yet (automatic updates were off, or a game was running): a full one.
        if (!passed) {
          void pass()
          return
        }
        const added = new Set(
          ps3Games()
            .map((g) => g.id)
            .filter((id) => !seen.has(id))
        )
        if (added.size) void pass(added)
      }, deps.kickDebounceMs ?? 10_000)
      kickTimer.unref?.()
    },
    dispose() {
      disposed = true
      controller.abort()
      for (const t of timers) {
        clearTimeout(t)
        clearInterval(t as unknown as ReturnType<typeof setInterval>)
      }
      if (kickTimer) clearTimeout(kickTimer)
    }
  }
}
