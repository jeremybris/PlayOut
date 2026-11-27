import type { RtssStatus } from '../../shared/overlay-extras'
import { FRAME_LIMIT_MAX } from '../../shared/overlay-extras'
import type { Logger } from '../logger'
import type { NativeOps } from '../native-host/native-ops'
import { readRegistryKey } from '../system/registry'
import { appFps, exeBaseName, isProfileExe, pickGameEntry, type RtssSnapshot } from './memory'
import { tMain } from '../i18n'

/**
 * RivaTuner Statistics Server for the overlay's extras (docs/home-overlay.md): its state, the game's live frame rate
 * from its shared memory, the per-game frame rate limit (written by the power helper, which runs as SYSTEM, because
 * RTSS's Profiles folder is admin-only) and PlayOut's performance overlay slot. The global profile is never written.
 *
 * The profile reload after a limit is written happens here, in PlayOut's own session (the SYSTEM helper cannot see
 * the session's shared memory): native.rtssRequestProfileUpdate does what RTSSHooks64.dll's UpdateProfiles does.
 */

/** PlayOut's OSD slot owner (szOSDOwner). */
export const RTSS_OSD_OWNER = 'PlayOut'

export const noRtssMessage = (): string => tMain('mainOverlay.rtss.missing')
export const noHelperMessage = (): string => tMain('mainOverlay.rtss.noHelper')

export interface RtssHelper {
  rtssLimit(exe: string, fps: number): Promise<{ exe: string; fps: number; created: boolean }>
  rtssSelf(exe: string): Promise<{ changed: boolean }>
  rtssRestore(): Promise<{ restored: number }>
}

export interface RtssServiceDeps {
  native: Pick<NativeOps, 'rtssSnapshot' | 'rtssOsd' | 'rtssRequestProfileUpdate'>
  /** The helper when ready at protocol >= HELPER_RTSS_VERSION, else null (B: performance.rtssHelper()). */
  helper(): Promise<RtssHelper | null>
  log: Logger
  /** Tests: the registry read of HKLM\SOFTWARE\WOW6432Node\Unwinder\RTSS (InstallDir, ProductVersion). */
  readInstall?(): Promise<{ installDir: string; version?: string } | null>
  /** Tests: the clock (ms). */
  now?(): number
  /** Tests: the wait between release tries. */
  sleep?(ms: number): Promise<void>
}

export interface GameFps {
  fps: number
  frameTimeMs?: number
  pid: number
  exe: string
}

export interface RtssService {
  /** missing / stopped / running (+ version). Cached 10 s; `fresh` re-reads. */
  status(fresh?: boolean): Promise<RtssStatus>
  /** The game's live frame rate from the shared memory (pickGameEntry); null when none. */
  gameFps(pids: readonly number[]): Promise<GameFps | null>
  /** The exe RTSS has hooked for these pids (its profile name), or null (not hooked yet). */
  hookedExe(pids: readonly number[]): Promise<string | null>
  /**
   * Write <exe>.cfg [Framerate] Limit=fps through the helper (0 puts back what was there), then ask RTSS to reload
   * profiles. Throws a user-readable Error: no RTSS, no helper (noHelperMessage),
   * helper error.
   */
  setFrameLimit(exe: string, fps: number): Promise<void>
  /** PlayOut's own exe excluded from hooking (helper rtssSelf), at most once per run unless it failed. */
  excludeSelf(exe: string): Promise<void>
  /**
   * Before the power helper is removed: every limit and hooking exclusion PlayOut wrote is put back (helper
   * rtssRestore), then RTSS reloads. Throws the helper's error, or noHelperMessage() without a helper.
   */
  restoreAll(): Promise<number>
  /** Write the OSD text into PlayOut's slot (claims one when needed); false when RTSS is absent/busy/full. */
  osdWrite(text: string): Promise<boolean>
  /**
   * Clear and release PlayOut's slot (no-op when none was claimed); a busy lock is tried again a few times. True when
   * no slot of PlayOut's is left (released, none held, or RTSS gone); false when it is still held.
   */
  osdRelease(): Promise<boolean>
  /** Releases the OSD slot. */
  dispose(): Promise<void>
}

const STATUS_TTL_MS = 10_000
/** The install itself changes rarely: read the registry at most once a minute. */
const INSTALL_TTL_MS = 60_000
/** Snapshots reused by calls in the same moment (the overlay's chips and the OSD tick both ask each second). */
const SNAPSHOT_TTL_MS = 250
/** A release that found RTSS's lock busy is tried this many times in all, this far apart (ms). */
export const OSD_RELEASE_TRIES = 3
export const OSD_RELEASE_RETRY_MS = 50

const RTSS_KEY = 'SOFTWARE\\Unwinder\\RTSS'

/** The real registry read: RTSS is a 32-bit program, so its key is under WOW6432Node (the 32-bit view). */
async function defaultReadInstall(): Promise<{ installDir: string; version?: string } | null> {
  const key = await readRegistryKey('HKLM', RTSS_KEY, { view: 'x86', depth: 0 })
  const dir = key?.values.InstallDir
  if (typeof dir !== 'string' || !dir.trim()) return null
  const version = key?.values.ProductVersion
  return {
    installDir: dir.trim(),
    ...(typeof version === 'string' && version.trim() ? { version: version.trim() } : {})
  }
}

export function createRtssService(deps: RtssServiceDeps): RtssService {
  const { native, log } = deps
  const now = deps.now ?? Date.now
  const readInstall = deps.readInstall ?? defaultReadInstall
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let install: { value: { installDir: string; version?: string } | null; at: number } | null = null
  let cached: { value: RtssStatus; at: number } | null = null
  let snap: { value: Promise<RtssSnapshot | null>; at: number } | null = null
  let selfDone = false
  let selfRun: Promise<void> | null = null
  // Unknown at start: a PlayOut that crashed may have left its slot (and text) behind, so the first release asks RTSS.
  let claimed = true
  let disposed = false
  // OSD writes and the release run one after another, so a late write never re-claims a released slot.
  let osdChain: Promise<unknown> = Promise.resolve()

  async function installInfo(
    fresh: boolean
  ): Promise<{ installDir: string; version?: string } | null> {
    if (!fresh && install && now() - install.at < INSTALL_TTL_MS) return install.value
    let value: { installDir: string; version?: string } | null = null
    try {
      value = await readInstall()
    } catch (err) {
      log.debug(`RTSS install could not be read: ${(err as Error).message}`)
    }
    install = { value, at: now() }
    return value
  }

  function snapshot(): Promise<RtssSnapshot | null> {
    if (snap && now() - snap.at < SNAPSHOT_TTL_MS) return snap.value
    const value = native.rtssSnapshot().catch(() => null)
    snap = { value, at: now() }
    return value
  }

  async function status(fresh = false): Promise<RtssStatus> {
    if (!fresh && cached && now() - cached.at < STATUS_TTL_MS) return cached.value
    const [inst, s] = await Promise.all([installInfo(fresh), snapshot()])
    // Running wins: a portable RTSS (no registry key) still draws and limits once its memory answers.
    const value: RtssStatus = s
      ? { state: 'running', ...(inst?.version ? { version: inst.version } : {}) }
      : inst
        ? { state: 'stopped', ...(inst.version ? { version: inst.version } : {}) }
        : { state: 'missing' }
    cached = { value, at: now() }
    return value
  }

  function entriesFor(s: RtssSnapshot, pids: readonly number[]): RtssSnapshot['apps'] {
    return s.apps.filter((a) => pids.includes(a.pid))
  }

  async function helperOrThrow(): Promise<RtssHelper> {
    const h = await deps.helper()
    if (!h) throw new Error(noHelperMessage())
    return h
  }

  async function reload(): Promise<void> {
    const n = await native.rtssRequestProfileUpdate()
    log.debug(`RTSS: asked ${n} hooked app(s) to reload their profile`)
  }

  function osdRelease(): Promise<boolean> {
    const run = osdChain.then(async () => {
      for (let i = 0; claimed && i < OSD_RELEASE_TRIES; i++) {
        if (i > 0) await sleep(OSD_RELEASE_RETRY_MS)
        const r = await native.rtssOsd(RTSS_OSD_OWNER, null)
        // RTSS gone: its memory, and our slot with it, is gone too.
        if (r.ok || r.error === 'missing') claimed = false
        else {
          log.debug(`RTSS OSD slot not released: ${r.error ?? 'unknown'}`)
          if (r.error !== 'busy') break
        }
      }
      return !claimed
    })
    osdChain = run.catch(() => undefined)
    return run.catch(() => !claimed)
  }

  return {
    status,

    async gameFps(pids) {
      const s = await snapshot()
      if (!s) return null
      const e = pickGameEntry(s, pids)
      const fps = e ? appFps(e, s.tick) : null
      if (!e || fps === null) return null
      return {
        fps,
        ...(e.frameTimeUs > 0 && e.frameTimeUs < 10_000_000
          ? { frameTimeMs: Math.round(e.frameTimeUs / 100) / 10 }
          : {}),
        pid: e.pid,
        exe: exeBaseName(e.name)
      }
    },

    async hookedExe(pids) {
      if (!pids.length) return null
      const s = await snapshot()
      if (!s) return null
      const ours = entriesFor(s, pids).filter((a) => isProfileExe(exeBaseName(a.name)))
      if (!ours.length) return null
      // An entry that is drawing frames first (the foreground one among them): a launcher RTSS hooked before the
      // game, or one left idle behind it, must not win over the game itself. Then the foreground entry, then any.
      const pick =
        pickGameEntry({ ...s, apps: ours }, pids) ??
        (s.foregroundPid ? ours.find((a) => a.pid === s.foregroundPid) : undefined) ??
        ours[0]!
      return exeBaseName(pick.name)
    },

    async setFrameLimit(exe, fps) {
      if (!isProfileExe(exe)) throw new Error(`Not a program name: ${exe}`)
      if (!Number.isInteger(fps) || fps < 0 || fps > FRAME_LIMIT_MAX)
        throw new Error(`Not a frame rate limit: ${fps}`)
      const st = await status(true)
      if (st.state === 'missing') throw new Error(noRtssMessage())
      const helper = await helperOrThrow()
      await helper.rtssLimit(exe, fps)
      log.info(`RTSS: ${exe} frame rate limit ${fps ? `${fps} FPS` : 'put back'}`)
      // Stopped: RTSS reads the profile when it starts, nothing to reload.
      if (st.state === 'running') await reload()
    },

    excludeSelf(exe) {
      if (selfDone) return Promise.resolve()
      if (selfRun) return selfRun
      selfRun = (async () => {
        try {
          if (!isProfileExe(exe)) {
            log.warn(`RTSS: ${exe} is not a program name; PlayOut is not excluded from hooking`)
            return
          }
          const st = await status()
          if (st.state === 'missing') return
          const helper = await deps.helper()
          if (!helper) return
          const { changed } = await helper.rtssSelf(exe)
          selfDone = true
          if (changed) {
            log.info(`RTSS: ${exe} excluded from hooking`)
            if (st.state === 'running') await reload()
          }
        } catch (err) {
          log.warn(`RTSS: could not exclude ${exe} from hooking: ${(err as Error).message}`)
        } finally {
          selfRun = null
        }
      })()
      return selfRun
    },

    async restoreAll() {
      const helper = await helperOrThrow()
      const { restored } = await helper.rtssRestore()
      // PlayOut.exe is hooked again: a helper installed later must exclude it again.
      selfDone = false
      log.info(`RTSS: ${restored} profile(s) put back`)
      const st = await status(true)
      if (st.state === 'running' && restored > 0) await reload()
      return restored
    },

    osdWrite(text) {
      const run = osdChain.then(async () => {
        if (disposed) return false
        const r = await native.rtssOsd(RTSS_OSD_OWNER, text)
        // 'busy' may come after the slot was claimed (the owner is written before the lock): release it later too.
        if (r.ok || r.error === 'busy') claimed = true
        if (!r.ok && r.error !== 'busy') log.debug(`RTSS OSD not written: ${r.error ?? 'unknown'}`)
        return r.ok
      })
      osdChain = run.catch(() => undefined)
      return run.catch(() => false)
    },

    osdRelease,

    async dispose() {
      await osdRelease()
      disposed = true
    }
  }
}
