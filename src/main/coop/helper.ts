import type { CoopDevice, CoopLayout, CoopScreen } from '@shared/types'
import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import type { Logger } from '../logger'
import { tMain } from '../i18n'

/**
 * The Co-Op helper (PlayOutCoop.exe): a separate GPL-3 program built from Nucleus Co-op's engine (its own public
 * repository), which runs a handler and its game instances. PlayOut talks to it only through its command line, a job
 * file and JSON lines (the helper's CONTRACT.md): `devices`, `play`, and `stop` on stdin.
 */

export const HELPER_EXE = 'PlayOutCoop.exe'
const DEVICES_TIMEOUT_MS = 20_000
/** The helper's own budget for ending a session (`session.Stop(60000)` in the helper's Play.cs). */
export const HELPER_STOP_BUDGET_MS = 60_000
/**
 * How long the helper gets to end a session (restore files, close instances) before it is killed: longer than its own
 * budget, so the restores it runs after a stop that timed out (DPI values, game file attributes) are not cut short.
 */
export const STOP_TIMEOUT_MS = HELPER_STOP_BUDGET_MS + 15_000
/** A session's job file in the engine root. */
const JOB_FILE = /^job-\d+\.json$/

/** The keyboard and mouse together, as one player (raw handle 0: whichever keyboard and mouse). */
export const KEYBOARD_DEVICE: CoopDevice = {
  id: 'kb',
  kind: 'keyboard',
  name: tMain('mainCoop.keyboardMouse')
}

export interface HelperJob {
  handler: string
  exePath: string
  screens: { index: number; layout: CoopLayout }[]
  players: {
    nickname: string
    screen: number
    slot: number
    device:
      | { kind: 'xinput'; index: number }
      | { kind: 'dinput'; guid: string }
      | { kind: 'keyboard'; keyboardHandle: string; mouseHandle: string }
      | { kind: 'none' }
  }[]
  options: Record<string, string>
  /**
   * Where the instance folders are made: a folder on the game's drive, so hard links (no admin rights needed) work
   * when PlayOut's data is on another drive. Absent: the engine root.
   */
  contentRoot?: string
}

export type HelperEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; step?: string; player?: number; total?: number }
  | { type: 'started'; pids?: number[] }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'ended'; reason?: string }
  | { type: string; [key: string]: unknown }

/** The job's device for a Co-Op device. */
export function jobDevice(device: CoopDevice | undefined): HelperJob['players'][number]['device'] {
  if (!device) return { kind: 'none' }
  if (device.kind === 'xinput') return { kind: 'xinput', index: device.index ?? 0 }
  if (device.kind === 'dinput') return { kind: 'dinput', guid: device.guid ?? '' }
  return { kind: 'keyboard', keyboardHandle: '0x0', mouseHandle: '0x0' }
}

interface RawDevices {
  gamepads?: {
    id?: string
    kind?: string
    index?: number
    name?: string
    guid?: string
    connected?: boolean
  }[]
  keyboards?: unknown[]
  mice?: unknown[]
  screens?: { index?: number; primary?: boolean; bounds?: CoopScreen['bounds']; name?: string }[]
}

/** The helper's `devices` answer as Co-Op devices and screens (the keyboard and mouse as one device). */
export function parseDevices(raw: RawDevices): { devices: CoopDevice[]; screens: CoopScreen[] } {
  const devices: CoopDevice[] = []
  for (const g of raw.gamepads ?? []) {
    if (g.connected === false) continue
    if (g.kind === 'xinput' && typeof g.index === 'number')
      devices.push({
        id: `xinput:${g.index}`,
        kind: 'xinput',
        index: g.index,
        name: g.name || `Controller ${g.index + 1}`,
        guid: g.guid
      })
    else if (g.kind === 'dinput' && g.guid)
      devices.push({
        id: `dinput:${g.guid}`,
        kind: 'dinput',
        guid: g.guid,
        name: g.name || 'Controller'
      })
  }
  if ((raw.keyboards?.length ?? 0) > 0 || (raw.mice?.length ?? 0) > 0) devices.push(KEYBOARD_DEVICE)
  const screens: CoopScreen[] = (raw.screens ?? [])
    .filter((s) => s.bounds && typeof s.index === 'number')
    .map((s) => ({ index: s.index!, primary: !!s.primary, bounds: s.bounds!, name: s.name }))
  return { devices, screens }
}

export interface HelperSession {
  child: ChildProcess
  /** Resolves with the reason when the helper has ended the session and exited. */
  done: Promise<string>
  /** Ask the helper to end the session (it restores everything, then exits). */
  stop(): void
}

export interface CoopHelperDeps {
  /** The engine root (the helper's copy lives there, beside the Nucleus tools). */
  root: string
  log: Logger
}

export interface CoopHelper {
  /** The connected controllers (and the keyboard and mouse) and the monitors. */
  devices(): Promise<{ devices: CoopDevice[]; screens: CoopScreen[] }>
  /** Start a session; `onEvent` gets the helper's events until it exits. */
  play(job: HelperJob, onEvent: (event: HelperEvent) => void): Promise<HelperSession>
}

/**
 * Delete the job files earlier sessions left in the engine root (PlayOut crashed or was ended before the helper
 * closed), except those in `keep`. Best effort: a file that cannot be deleted is left for the next time.
 */
export async function sweepJobFiles(root: string, keep: ReadonlySet<string>): Promise<number> {
  const names = await fs.readdir(root).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    const path = join(root, name)
    if (!JOB_FILE.test(name) || keep.has(path)) continue
    await fs.rm(path, { force: true }).then(
      () => removed++,
      () => undefined
    )
  }
  return removed
}

export function createCoopHelper({ root, log }: CoopHelperDeps): CoopHelper {
  const exe = join(root, HELPER_EXE)
  /** The job files of the sessions running now. */
  const liveJobs = new Set<string>()

  function run(args: string[]): ChildProcess {
    return spawn(exe, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }

  function lines(child: ChildProcess, onLine: (event: HelperEvent) => void): void {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const text = line.trim()
      if (!text.startsWith('{')) return
      try {
        onLine(JSON.parse(text) as HelperEvent)
      } catch {
        log.warn(`Co-Op helper: unreadable line ${text.slice(0, 200)}`)
      }
    })
    createInterface({ input: child.stderr! }).on('line', (line) => {
      if (line.trim()) log.info(`Co-Op helper: ${line.slice(0, 500)}`)
    })
  }

  return {
    async devices(): Promise<{ devices: CoopDevice[]; screens: CoopScreen[] }> {
      const child = run(['devices', '--root', root])
      child.stdin?.end()
      return new Promise((resolve, reject) => {
        let answer: RawDevices | null = null
        let error: string | null = null
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(tMain('mainCoop.devicesTimeout')))
        }, DEVICES_TIMEOUT_MS)
        lines(child, (event) => {
          if (event.type === 'devices') answer = event as RawDevices
          else if (event.type === 'error')
            error = String((event as { message?: string }).message ?? 'error')
        })
        child.once('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          if (answer) resolve(parseDevices(answer))
          else reject(new Error(error ?? tMain('mainCoop.devicesExit', { code: String(code) })))
        })
      })
    },

    async play(job: HelperJob, onEvent: (event: HelperEvent) => void): Promise<HelperSession> {
      const jobPath = join(root, `job-${Date.now()}.json`)
      liveJobs.add(jobPath)
      const stale = await sweepJobFiles(root, liveJobs)
      if (stale) log.info(`Co-Op helper: ${stale} leftover job file(s) removed`)
      try {
        await fs.writeFile(jobPath, JSON.stringify(job, null, 2))
      } catch (err) {
        liveJobs.delete(jobPath)
        throw err
      }
      // Real dialogs for the prompts that wait for the player ("Press OK when…"), and the session ends if PlayOut goes.
      const child = run([
        'play',
        '--root',
        root,
        '--job',
        jobPath,
        '--prompts',
        'native',
        '--parent',
        String(process.pid)
      ])
      // A helper that already exited closes its stdin: a late write must not become an uncaught error.
      child.stdin?.on('error', (err) => log.warn(`Co-Op helper stdin: ${err.message}`))
      let killTimer: ReturnType<typeof setTimeout> | null = null
      let ended: string | null = null
      lines(child, (event) => {
        if (event.type === 'ended') ended = String(event.reason ?? 'exited')
        onEvent(event)
      })
      const done = new Promise<string>((resolve) => {
        child.once('error', (err) => {
          onEvent({ type: 'error', message: err.message, fatal: true })
          resolve('error')
        })
        child.once('close', (code) => {
          if (killTimer) clearTimeout(killTimer)
          liveJobs.delete(jobPath)
          void fs.rm(jobPath, { force: true }).catch(() => undefined)
          resolve(ended ?? (code === 0 ? 'exited' : `exit ${code}`))
        })
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', reject)
      })
      return {
        child,
        done,
        stop() {
          if (child.exitCode !== null) return
          try {
            child.stdin?.write('stop\n')
          } catch {
            // falls through to the kill below
          }
          // A helper that does not end the session in time is ended with its game instances.
          killTimer ??= setTimeout(() => {
            if (child.exitCode !== null || !child.pid) return
            log.warn('Co-Op helper did not stop in time; ending it and its games')
            spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }).on(
              'error',
              () => child.kill()
            )
          }, STOP_TIMEOUT_MS)
        }
      }
    }
  }
}
