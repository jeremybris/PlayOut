import { execFile } from 'child_process'
import type { Logger } from '../logger'
import { asArray } from '../system/powershell'
import { createPsWorker, type PsWorker } from '../system/ps-worker'
import { isInside, normalizePath } from '../util/paths'

export interface ProcessInfo {
  pid: number
  /** null when the source does not report it (tasklist). */
  parentPid: number | null
  /** Image name with extension as Windows reports it, e.g. 'Notepad.exe'. */
  name: string
  /** Full executable path; null for protected processes or when the source does not report it. */
  path: string | null
  /** Windows session id. Session 0 holds services, which never count as a running game. */
  sessionId: number
  /**
   * Process creation time as epoch ms; null/undefined when the source does not report it (tasklist, a protected
   * process). Windows reuses pids as soon as a process is gone, so pid + creation time is the process identity.
   */
  createdAt?: number | null
}

/** How old a process list launcher.processes() hands out may be (index.ts). */
export const PROCESS_LIST_REUSE_MS = 2_000

export interface ProcessListOptions {
  /** Reuse a list that completed less than this many ms ago instead of polling again (default 0). */
  maxAgeMs?: number
}

export interface ProcessMonitor {
  /**
   * Every process with pid, parent pid, name and executable path (CIM through the warm PowerShell worker:
   * ~1 s for the first call, then well under a second per poll).
   */
  list(options?: ProcessListOptions): Promise<ProcessInfo[]>
  /**
   * Processes for name matching. Uses the same CIM poll while PowerShell works (the warm worker beats
   * tasklist's ~450 ms spawn) and falls back to tasklist, which reports no paths, when it does not.
   */
  listNames(options?: ProcessListOptions): Promise<ProcessInfo[]>
  /** Liveness check for a pid without spawning anything (process.kill(pid, 0)). */
  isPidAlive(pid: number): boolean
  /** Stop the PowerShell worker and its idle timer; a later list() starts a fresh one. */
  dispose(): void
}

/** Raw row of the CIM query as PowerShell serialises it. */
export interface RawCimProcess {
  ProcessId: number
  ParentProcessId: number | null
  Name: string | null
  ExecutablePath: string | null
  SessionId: number | null
  /** CreationDate converted to epoch ms by the script; absent in older rows and tests. */
  Created?: number | null
}

/** The two external commands, injectable for tests. */
export interface ProcessMonitorIo {
  /** Run the CIM query; resolves with raw rows, or null when PowerShell produced nothing. */
  queryProcesses(): Promise<RawCimProcess[] | null>
  /** Run `tasklist /FO CSV /NH` and resolve with its stdout. */
  runTasklist(): Promise<string>
  /** Release anything held between polls (the PowerShell worker). */
  dispose?(): void
}

/**
 * CreationDate is converted to epoch milliseconds in PowerShell (ConvertTo-Json would otherwise emit its own
 * `/Date(...)/` form) so a reused pid can be told from the process that originally had it.
 */
const CIM_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,SessionId,CreationDate | ' +
  'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,SessionId,' +
  "@{n='Created';e={ if ($_.CreationDate) { [int64](([datetimeoffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()) } else { $null } }}"

const POLL_TIMEOUT_MS = 15_000
const SLOW_POLL_MS = 5_000
/** A worker nobody polled for this long is closed; sessions poll every 3 s so it stays warm while a game runs. */
export const WORKER_IDLE_MS = 60_000

export function runTasklist(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH'],
      {
        windowsHide: true,
        timeout: POLL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout ?? ''))
      }
    )
  })
}

/**
 * Default IO: the CIM query runs in one long-lived PowerShell worker (a fresh powershell.exe costs about a
 * second per call, the warm worker answers in a fraction of that) that is started on first use and closed
 * after `idleMs` without a poll, so no PowerShell process lingers while nothing is being tracked.
 */
export function createWorkerIo(log: Logger, idleMs = WORKER_IDLE_MS): ProcessMonitorIo {
  let worker: PsWorker | null = null
  let idle: NodeJS.Timeout | null = null

  function release(): void {
    if (idle) clearTimeout(idle)
    idle = null
    if (!worker) return
    log.debug('process monitor: closing the idle powershell worker')
    worker.dispose()
    worker = null
  }

  function touch(): void {
    if (idle) clearTimeout(idle)
    idle = setTimeout(release, idleMs)
    idle.unref()
  }

  return {
    async queryProcesses() {
      if (!worker) {
        log.debug('process monitor: starting the powershell worker')
        worker = createPsWorker({ log })
      }
      const current = worker
      try {
        const raw = await current.run<RawCimProcess | RawCimProcess[]>(CIM_SCRIPT, {
          timeoutMs: POLL_TIMEOUT_MS
        })
        return raw === null ? null : asArray(raw)
      } finally {
        if (worker === current) touch()
      }
    },
    runTasklist,
    dispose: release
  }
}

/**
 * Share one in-flight run between concurrent callers and optionally reuse a recent result. A session poll, a
 * second tracker probe and a test can all ask for the process list at once; only one PowerShell runs.
 */
function coalesced<T>(run: () => Promise<T>): (maxAgeMs: number) => Promise<T> {
  let inflight: Promise<T> | null = null
  let last: { at: number; value: T } | null = null
  return (maxAgeMs) => {
    if (last && maxAgeMs > 0 && Date.now() - last.at <= maxAgeMs) return Promise.resolve(last.value)
    if (!inflight) {
      inflight = run()
        .then((value) => {
          last = { at: Date.now(), value }
          return value
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  }
}

export function createProcessMonitor(
  log: Logger,
  io: ProcessMonitorIo = createWorkerIo(log)
): ProcessMonitor {
  const full = coalesced(async () => {
    const t0 = performance.now()
    const rows = await io.queryProcesses()
    const ms = Math.round(performance.now() - t0)
    if (rows === null)
      throw new Error(`process list unavailable (PowerShell returned nothing after ${ms} ms)`)
    const list = parseCimRows(rows)
    if (!list.length)
      throw new Error(`process list empty (PowerShell returned no rows after ${ms} ms)`)
    logPoll(log, 'cim', list.length, ms)
    return list
  })
  const names = coalesced(async () => {
    const t0 = performance.now()
    const text = await io.runTasklist()
    const ms = Math.round(performance.now() - t0)
    const list = parseTasklistCsv(text)
    if (!list.length) throw new Error(`tasklist returned no processes after ${ms} ms`)
    logPoll(log, 'tasklist', list.length, ms)
    return list
  })

  return {
    list: (options) => full(options?.maxAgeMs ?? 0),
    async listNames(options) {
      const maxAgeMs = options?.maxAgeMs ?? 0
      try {
        return await full(maxAgeMs)
      } catch (err) {
        log.warn(`process poll (cim) failed, falling back to tasklist: ${(err as Error).message}`)
        return names(maxAgeMs)
      }
    },
    isPidAlive,
    dispose() {
      io.dispose?.()
    }
  }
}

function logPoll(log: Logger, source: string, count: number, ms: number): void {
  const line = `process poll (${source}): ${count} processes in ${ms} ms`
  if (ms > SLOW_POLL_MS) log.warn(`${line} (slow)`)
  else log.debug(line)
}

/** True while the process exists. EPERM means it exists but belongs to someone else, which still counts. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function parseCimRows(rows: RawCimProcess[]): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.ProcessId !== 'number') continue
    out.push({
      pid: row.ProcessId,
      parentPid: typeof row.ParentProcessId === 'number' ? row.ParentProcessId : null,
      name: typeof row.Name === 'string' ? row.Name : '',
      path:
        typeof row.ExecutablePath === 'string' && row.ExecutablePath ? row.ExecutablePath : null,
      sessionId: typeof row.SessionId === 'number' ? row.SessionId : -1,
      createdAt:
        typeof row.Created === 'number' && Number.isFinite(row.Created) ? row.Created : null
    })
  }
  return out
}

// "Image Name","PID","Session Name","Session#","Mem Usage"; image names never contain quotes on Windows.
const TASKLIST_LINE = /^"([^"]*)","(\d+)","([^"]*)","(\d+)","([^"]*)"\s*$/

export function parseTasklistCsv(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = TASKLIST_LINE.exec(line)
    if (!m) continue
    out.push({
      pid: Number(m[2]),
      parentPid: null,
      name: m[1],
      path: null,
      sessionId: Number(m[4]),
      createdAt: null
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Predicates over a process list
// ---------------------------------------------------------------------------

/** Lower-case base name without the .exe extension: 'C:\\x\\Game.EXE' -> 'game'. */
export function normalizeProcessName(name: string): string {
  const base = name
    .replace(/^.*[\\/]/, '')
    .trim()
    .toLowerCase()
  return base.replace(/\.exe$/, '')
}

function userSession(p: ProcessInfo): boolean {
  return p.sessionId !== 0
}

/** Processes (outside session 0) whose executable lives under `dir`; `C:\\Fallout` does not match `C:\\Fallout 2`. */
export function findUnderDir(list: ProcessInfo[], dir: string): ProcessInfo[] {
  if (!dir) return []
  return list.filter((p) => userSession(p) && p.path !== null && isInside(dir, p.path))
}

export function isProcessUnderDir(list: ProcessInfo[], dir: string): boolean {
  return findUnderDir(list, dir).length > 0
}

/** Processes (outside session 0) whose image name is one of `names` (with or without .exe, case-insensitive). */
export function findByNames(list: ProcessInfo[], names: string[]): ProcessInfo[] {
  const wanted = new Set(names.map(normalizeProcessName).filter(Boolean))
  if (!wanted.size) return []
  return list.filter((p) => userSession(p) && wanted.has(normalizeProcessName(p.name)))
}

export function findByPid(list: ProcessInfo[], pid: number): ProcessInfo | undefined {
  return list.find((p) => p.pid === pid)
}

/** 'Microsoft.WindowsNotepad_8wekyb3d8bbwe' -> 'Microsoft.WindowsNotepad' (the publisher hash is not in the install folder's prefix). */
export function uwpPackageName(packageFamilyName: string): string {
  return packageFamilyName.replace(/_[^_]*$/, '')
}

/**
 * Processes running from the package's WindowsApps folder, i.e. whose path contains
 * `\WindowsApps\<package name>_` (the folder is `<name>_<version>_<arch>__<publisher hash>`).
 */
export function findUwp(list: ProcessInfo[], packageFamilyName: string): ProcessInfo[] {
  const name = uwpPackageName(packageFamilyName).toLowerCase()
  if (!name) return []
  const needle = `\\windowsapps\\${name}_`
  return list.filter(
    (p) => userSession(p) && p.path !== null && normalizePath(p.path).includes(needle)
  )
}

/**
 * Live processes (outside session 0, like every other predicate here: a game never runs as a service) that
 * descend from any of `roots` through ParentProcessId links, roots included when alive. Dead roots still link:
 * Windows keeps the creator's pid on orphaned children. Pids in `exclude` are parent-link anchors only: they are
 * walked through but never returned, which is how a pid already observed dead is kept from coming back to life on
 * an unrelated process that was handed the same pid.
 */
export function findDescendants(
  list: ProcessInfo[],
  roots: Iterable<number>,
  exclude?: ReadonlySet<number>
): ProcessInfo[] {
  const user = list.filter(userSession)
  const byParent = new Map<number, ProcessInfo[]>()
  for (const p of user) {
    if (p.parentPid === null || p.parentPid === p.pid) continue
    const bucket = byParent.get(p.parentPid)
    if (bucket) bucket.push(p)
    else byParent.set(p.parentPid, [p])
  }
  const tracked = new Set<number>(roots)
  let frontier = [...tracked]
  while (frontier.length) {
    const next: number[] = []
    for (const pid of frontier) {
      for (const child of byParent.get(pid) ?? []) {
        if (!tracked.has(child.pid)) {
          tracked.add(child.pid)
          next.push(child.pid)
        }
      }
    }
    frontier = next
  }
  return user.filter((p) => tracked.has(p.pid) && !exclude?.has(p.pid))
}
