import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Logger } from '../../logger'

/**
 * PlayOutIngame64.exe (ingame-helper/PROTOCOL.md, section 1): probes a game process, injects PlayOutOverlay64.dll
 * into it and waits for it to end. It ships unpacked beside the app (resources\ingame). Every command prints one JSON
 * line. A missing helper only means the in-game overlay is unavailable: the window overlay is used, with no error.
 */

export const HELPER_EXE = 'PlayOutIngame64.exe'
export const OVERLAY_DLL = 'PlayOutOverlay64.dll'

/** probe and inject are quick; one that hangs is given up on after this long. */
export const PROBE_TIMEOUT_MS = 5_000
/** inject waits up to 5 s for the remote thread and 10 s for the DLL to read its mapping. */
export const INJECT_TIMEOUT_MS = 20_000
/** peerparty-invite waits 1.5 s for a game's answer. */
export const PEERPARTY_INVITE_TIMEOUT_MS = 5_000

export type ProbeResult =
  | {
      ok: true
      pid: number
      arch: string
      elevated: boolean
      protected: boolean
      appContainer: boolean
      antiCheat: string[]
      graphics: string[]
      injected: boolean
      exe: string
      /**
       * How many kernel drivers, processes and target modules the helper looked at for anti-cheat; null when it did
       * not say. A source it could not read (0) leaves anti-cheat unknown.
       */
      checked: { drivers: number; processes: number; modules: number } | null
    }
  | { ok: false; pid: number; error: string; step: string }

export type InjectResult =
  | { ok: true; pid: number; step: 'done' | 'already' }
  | { ok: false; pid: number; error: string; step: string }

/**
 * `peerparty-invite` (PROTOCOL.md, section 1): whether a PeerParty game took the invite (`taken`), or why the helper
 * could not ask.
 */
export type PeerPartyInviteAnswer = { ok: true; taken: boolean } | { ok: false; error: string }

export interface InjectOptions {
  pid: number
  /** Absolute path of PlayOutOverlay64.dll. */
  dll: string
  pipe: string
  token: string
  playoutPid: number
}

/** A running helper command (a fake in tests). */
export interface HelperRun {
  /** Exit code (null: it could not start, timed out or was killed) and what it printed. */
  done: Promise<{ code: number | null; stdout: string; error?: string }>
  kill(): void
}

export type HelperRunner = (file: string, args: string[], timeoutMs: number) => HelperRun

export interface IngameHelperDeps {
  log: Logger
  /** The folder holding PlayOutIngame64.exe and PlayOutOverlay64.dll (resources\ingame, unpacked). */
  dir: string
  /** Tests. */
  run?: HelperRunner
  exists?: (path: string) => Promise<boolean>
}

export interface IngameHelper {
  /** Both files are there (checked once, then remembered while true). */
  available(): Promise<boolean>
  /** The DLL's absolute path. */
  dll: string
  /** Null when the helper is missing or gave no answer. */
  probe(pid: number): Promise<ProbeResult | null>
  inject(options: InjectOptions): Promise<InjectResult | null>
  /** Resolves with the process's exit code once it ends (null: unknown, or the helper is missing / was stopped). */
  watch(pid: number): Promise<number | null>
  /**
   * Ask the PeerParty game last in front to invite everyone on the LAN (PeerParty's named events); null when the
   * helper is missing or gave no answer.
   */
  peerPartyInvite(): Promise<PeerPartyInviteAnswer | null>
  /** Stop every watch still running (quitting PlayOut). */
  dispose(): void
}

const defaultRun: HelperRunner = (file, args, timeoutMs) => {
  let kill = (): void => {}
  const done = new Promise<{ code: number | null; stdout: string; error?: string }>((resolve) => {
    try {
      const child = execFile(
        file,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          const code =
            err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((err as unknown as { code: number }).code as number)
              : err
                ? null
                : 0
          resolve({ code, stdout: String(stdout ?? ''), error: err?.message })
        }
      )
      kill = () => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    } catch (err) {
      resolve({ code: null, stdout: '', error: (err as Error).message })
    }
  })
  return { done, kill: () => kill() }
}

const defaultExists = (path: string): Promise<boolean> =>
  fs.access(path).then(
    () => true,
    () => false
  )

/** The helper's answer: the last line of stdout that is a JSON object, or null. */
export function parseHelperLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value: unknown = JSON.parse(lines[i]!)
      if (value && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>
    } catch {
      /* the next line up */
    }
  }
  return null
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

/** The probe's `checked` counts, or null when any is missing. */
function checkedOf(value: unknown): { drivers: number; processes: number; modules: number } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
  return n(v.drivers) && n(v.processes) && n(v.modules)
    ? { drivers: v.drivers, processes: v.processes, modules: v.modules }
    : null
}

/** A probe answer with its fields checked; an answer missing any of them counts as a failure. */
export function parseProbe(json: Record<string, unknown> | null, pid: number): ProbeResult | null {
  if (!json) return null
  if (json.ok !== true) {
    return {
      ok: false,
      pid,
      error: typeof json.error === 'string' ? json.error : 'unknown error',
      step: typeof json.step === 'string' ? json.step : 'unknown'
    }
  }
  const bool = (k: string): boolean | null =>
    typeof json[k] === 'boolean' ? (json[k] as boolean) : null
  const elevated = bool('elevated')
  const prot = bool('protected')
  const appContainer = bool('appContainer')
  if (
    typeof json.arch !== 'string' ||
    elevated === null ||
    prot === null ||
    appContainer === null ||
    !Array.isArray(json.antiCheat) ||
    !Array.isArray(json.graphics)
  ) {
    return { ok: false, pid, error: 'incomplete probe answer', step: 'parse' }
  }
  return {
    ok: true,
    pid,
    arch: json.arch,
    elevated,
    protected: prot,
    appContainer,
    antiCheat: strings(json.antiCheat),
    graphics: strings(json.graphics),
    injected: json.injected === true,
    exe: typeof json.exe === 'string' ? json.exe : '',
    checked: checkedOf(json.checked)
  }
}

export function parseInject(
  json: Record<string, unknown> | null,
  pid: number
): InjectResult | null {
  if (!json) return null
  if (json.ok === true && (json.step === 'done' || json.step === 'already'))
    return { ok: true, pid, step: json.step }
  return {
    ok: false,
    pid,
    error: typeof json.error === 'string' ? json.error : 'unknown error',
    step: typeof json.step === 'string' ? json.step : 'unknown'
  }
}

/** A peerparty-invite answer with its fields checked; anything else counts as no answer. */
export function parsePeerPartyInvite(
  json: Record<string, unknown> | null
): PeerPartyInviteAnswer | null {
  if (!json) return null
  if (json.ok === true)
    return typeof json.taken === 'boolean' ? { ok: true, taken: json.taken } : null
  return { ok: false, error: typeof json.error === 'string' ? json.error : 'unknown error' }
}

export function createIngameHelper(deps: IngameHelperDeps): IngameHelper {
  const { log } = deps
  const run = deps.run ?? defaultRun
  const exists = deps.exists ?? defaultExists
  const exe = join(deps.dir, HELPER_EXE)
  const dll = join(deps.dir, OVERLAY_DLL)
  let present = false
  let missingLogged = false
  const watches = new Set<HelperRun>()

  async function available(): Promise<boolean> {
    if (present) return true
    const [a, b] = await Promise.all([exists(exe), exists(dll)])
    present = a && b
    if (!present && !missingLogged) {
      missingLogged = true
      log.info(
        `in-game overlay unavailable: ${a ? OVERLAY_DLL : HELPER_EXE} not found in ${deps.dir}`
      )
    }
    return present
  }

  async function command(
    args: string[],
    timeoutMs: number
  ): Promise<Record<string, unknown> | null> {
    if (!(await available())) return null
    const r = await run(exe, args, timeoutMs).done
    const json = parseHelperLine(r.stdout)
    if (!json)
      log.warn(`ingame helper ${args[0]} gave no answer (code ${r.code}): ${r.error ?? ''}`)
    return json
  }

  return {
    available,
    dll,
    async probe(pid) {
      return parseProbe(await command(['probe', '--pid', String(pid)], PROBE_TIMEOUT_MS), pid)
    },
    async inject(o) {
      const args = [
        'inject',
        '--pid',
        String(o.pid),
        '--dll',
        o.dll,
        '--pipe',
        o.pipe,
        '--token',
        o.token,
        '--playout-pid',
        String(o.playoutPid)
      ]
      return parseInject(await command(args, INJECT_TIMEOUT_MS), o.pid)
    },
    async watch(pid) {
      if (!(await available())) return null
      const r = run(exe, ['watch', '--pid', String(pid)], 0)
      watches.add(r)
      try {
        const { stdout } = await r.done
        const json = parseHelperLine(stdout)
        const code = json?.exitCode
        return typeof code === 'number' && Number.isFinite(code) ? code >>> 0 : null
      } finally {
        watches.delete(r)
      }
    },
    async peerPartyInvite() {
      return parsePeerPartyInvite(await command(['peerparty-invite'], PEERPARTY_INVITE_TIMEOUT_MS))
    },
    dispose() {
      for (const w of watches) w.kill()
      watches.clear()
    }
  }
}
