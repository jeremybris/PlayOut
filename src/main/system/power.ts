import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import type { PowerAction, PowerMode, SystemStatus } from '../../shared/types'
import type { Logger } from '../logger'
import { powerShellArgs } from './powershell'
import type { PsRunner } from './ps-worker'
import { tMain } from '../i18n'

export type BatteryStatus = NonNullable<SystemStatus['battery']>

/** A machine without a battery (desktop): the renderer hides the battery indicator. */
export const NO_BATTERY: BatteryStatus = { present: false, percent: 0, charging: false }

// ---------------------------------------------------------------------------
// Battery (docs/research/electron-stack.md section 6.1)
// ---------------------------------------------------------------------------

/**
 * Win32_Battery gives the percentage; root/wmi BatteryStatus.PowerOnline is the reliable "plugged in" flag.
 * Win32_Battery.BatteryStatus alone reports 2 ("on AC") even while the battery is full and idle, so it is only
 * the fallback when the root/wmi class is missing.
 */
const BATTERY_SCRIPT = `
$b = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object BatteryStatus, EstimatedChargeRemaining)
$s = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object PowerOnline, Charging)
@{ battery = $b; status = $s }
`

interface RawBattery {
  BatteryStatus?: unknown
  EstimatedChargeRemaining?: unknown
}

interface RawBatteryStatus {
  PowerOnline?: unknown
  Charging?: unknown
}

/** Win32_Battery.BatteryStatus values that mean external power is connected. */
const PLUGGED_IN_STATUSES = new Set([2, 3, 6, 7, 8, 9])

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** null means "probe failed" (unknown); `present: false` means the machine has no battery. */
export function parseBattery(raw: unknown): BatteryStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as {
    battery?: RawBattery | RawBattery[] | null
    status?: RawBatteryStatus | RawBatteryStatus[] | null
  }
  const batteries = toArray(data.battery).filter((b) => b && typeof b === 'object')
  if (batteries.length === 0) return NO_BATTERY
  const percents = batteries
    .map((b) => b.EstimatedChargeRemaining)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  // Several packs (docks, dual-battery laptops) report individually; the average is what Windows shows.
  const percent = percents.length
    ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length)
    : 0
  const statuses = toArray(data.status).filter((s) => s && typeof s === 'object')
  let charging: boolean
  if (statuses.some((s) => typeof s.PowerOnline === 'boolean')) {
    charging = statuses.some((s) => s.PowerOnline === true || s.Charging === true)
  } else {
    charging = batteries.some(
      (b) => typeof b.BatteryStatus === 'number' && PLUGGED_IN_STATUSES.has(b.BatteryStatus)
    )
  }
  return { present: true, percent: Math.min(100, Math.max(0, percent)), charging }
}

export async function readBattery(ps: PsRunner, timeoutMs = 5_000): Promise<BatteryStatus | null> {
  return parseBattery(await ps.run(BATTERY_SCRIPT, { timeoutMs }))
}

// ---------------------------------------------------------------------------
// Power mode: Windows 11 overlay schemes (docs/research/electron-stack.md section 6.7)
// ---------------------------------------------------------------------------

const OVERLAY_GUIDS: Record<PowerMode, string> = {
  efficiency: '961cc777-2547-4f9d-8174-7d86181b8a7a', // Better Battery-life Overlay (OVERLAY_SCHEME_MIN)
  balanced: '00000000-0000-0000-0000-000000000000', // no overlay (OVERLAY_SCHEME_NONE)
  performance: 'ded574b5-45a0-4f42-8737-46345c09c238' // Max Performance Overlay (OVERLAY_SCHEME_MAX)
}

/** "High Performance Overlay" (Better performance) is hidden in the Windows 11 UI but still a performance mode. */
const HIGH_PERFORMANCE_OVERLAY = '3af9b8d9-7c97-431d-ad78-34a8bfea439f'

const POWER_SCHEMES_KEY = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes'

/**
 * The active overlay is kept separately for AC and DC; the one in force follows the current power source.
 * Reading the registry needs no admin, unlike `powercfg /getactiveoverlayscheme` (which this powercfg lacks).
 */
const POWER_MODE_SCRIPT = `
$p = Get-ItemProperty -Path '${POWER_SCHEMES_KEY}' -ErrorAction SilentlyContinue
$s = @(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object PowerOnline)
$onBattery = ($s.Count -gt 0) -and -not ($s | Where-Object { $_.PowerOnline -eq $true })
@{
  ac = [string]$p.ActiveOverlayAcPowerScheme
  dc = [string]$p.ActiveOverlayDcPowerScheme
  onBattery = [bool]$onBattery
}
`

export function overlayToMode(guid: string | null | undefined): PowerMode | null {
  if (!guid) return null
  const g = guid.trim().toLowerCase()
  if (g === OVERLAY_GUIDS.efficiency) return 'efficiency'
  if (g === OVERLAY_GUIDS.balanced) return 'balanced'
  if (g === OVERLAY_GUIDS.performance || g === HIGH_PERFORMANCE_OVERLAY) return 'performance'
  return null
}

export function parsePowerMode(raw: unknown): PowerMode | null {
  if (!raw || typeof raw !== 'object') return null
  const { ac, dc, onBattery } = raw as { ac?: unknown; dc?: unknown; onBattery?: unknown }
  const acMode = typeof ac === 'string' ? ac : ''
  const dcMode = typeof dc === 'string' ? dc : ''
  // Both values empty means this Windows has no overlay support (e.g. Windows 10 with classic plans only).
  if (!acMode && !dcMode) return null
  return overlayToMode(onBattery === true && dcMode ? dcMode : acMode || dcMode)
}

export async function readPowerMode(ps: PsRunner, timeoutMs = 5_000): Promise<PowerMode | null> {
  return parsePowerMode(await ps.run(POWER_MODE_SCRIPT, { timeoutMs }))
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs an executable with arguments; injectable so tests never run shutdown.exe or powercfg.exe. */
export type CommandRunner = (
  file: string,
  args: string[],
  timeoutMs: number
) => Promise<CommandResult>

export const execCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })

export function overlayArgs(mode: PowerMode): string[] {
  return ['/overlaysetactive', OVERLAY_GUIDS[mode]]
}

/**
 * `powercfg /overlaysetactive <guid>` was accepted (exit 0, silent) as a standard user on this machine for the
 * already-active overlay. powercfg prints its complaint on stdout, so both streams go into the error.
 */
export async function setPowerMode(
  mode: PowerMode,
  run: CommandRunner = execCommand
): Promise<void> {
  const result = await run('powercfg.exe', overlayArgs(mode), 10_000)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0]
    throw new Error(
      detail
        ? tMain('mainApp.power.modeFailedDetail', { mode, code: result.code, detail })
        : tMain('mainApp.power.modeFailed', { mode, code: result.code })
    )
  }
}

// ---------------------------------------------------------------------------
// Power actions (docs/research/electron-stack.md section 6.6)
// ---------------------------------------------------------------------------

export type MachinePowerAction = Exclude<PowerAction, 'exit' | 'minimize'>

export const SHUTDOWN_ARGS: Record<Exclude<MachinePowerAction, 'sleep'>, string[]> = {
  shutdown: ['/s', '/t', '0'],
  restart: ['/r', '/t', '0'],
  hibernate: ['/h']
}

/**
 * SetSuspendState(Suspend) is the one sleep call that never hibernates by mistake; `rundll32 powrprof.dll,
 * SetSuspendState 0,1,0` does when hibernation is enabled. The call blocks until the machine resumes, so it runs
 * in its own one-shot PowerShell that is fired and forgotten (`startSleep`): the helper is not awaited past the
 * suspend, because waiting on it with a timeout reported an error after every sleep longer than the timeout once
 * the expired timer fired on resume.
 */
const SLEEP_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$ok = [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)
if (-not $ok) { throw 'SetSuspendState returned false' }
`

/** How long an immediate failure (Add-Type error, SetSuspendState returning false) gets to surface. */
export const SLEEP_GRACE_MS = 10_000

export interface SleepIo {
  spawn: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  /**
   * Resolve as soon as the system reports it is suspending (electron powerMonitor 'suspend'); returns an
   * unsubscribe. Optional: without it the grace timer alone decides.
   */
  onSuspend?: (callback: () => void) => () => void
  graceMs?: number
}

/**
 * Start the sleep script without waiting for it to return. The result settles on the first of: the helper exiting
 * (an immediate non-zero exit is the real error path, "SetSuspendState returned false"); the system announcing
 * its suspend; or the grace window elapsing with the helper still running, which means the blocking call was
 * accepted and the machine is going down. The helper is never killed and a late exit is ignored: it returns on
 * its own after resume.
 */
export function startSleep(io: SleepIo): Promise<CommandResult> {
  const graceMs = io.graceMs ?? SLEEP_GRACE_MS
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timer: NodeJS.Timeout | null = null
    const settle = (result: CommandResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = io.spawn('powershell.exe', powerShellArgs(SLEEP_SCRIPT), {
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (err) {
      settle({ code: 1, stdout: '', stderr: (err as Error).message })
      return
    }
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk
    })
    child.on('error', (err) => settle({ code: 1, stdout: '', stderr: err.message }))
    child.on('exit', (code) => settle({ code: code ?? 1, stdout: '', stderr }))
    child.unref()
    unsubscribe = io.onSuspend?.(() => settle({ code: 0, stdout: '', stderr: '' })) ?? null
    timer = setTimeout(() => settle({ code: 0, stdout: '', stderr: '' }), graceMs)
    timer.unref()
  })
}

/** electron's powerMonitor 'suspend' when running inside Electron; plain Node (tests) gets no signal. */
function onElectronSuspend(callback: () => void): () => void {
  let off: (() => void) | null = null
  let cancelled = false
  import('electron')
    .then(({ powerMonitor }) => {
      if (cancelled) return
      powerMonitor.once('suspend', callback)
      off = () => powerMonitor.removeListener('suspend', callback)
    })
    .catch(() => {})
  return () => {
    cancelled = true
    off?.()
  }
}

export interface PowerActionIo {
  run: CommandRunner
  sleep: () => Promise<CommandResult>
}

export const defaultPowerActionIo: PowerActionIo = {
  run: execCommand,
  sleep: () => startSleep({ spawn, onSuspend: onElectronSuspend })
}

/**
 * shutdown.exe enables SeShutdownPrivilege itself, so no elevation is needed. Hibernate fails with a message
 * from shutdown.exe when hibernation is disabled (`powercfg /a` on this machine: "Hibernation has not been
 * enabled"); the message is surfaced to the renderer as the error.
 */
export async function powerAction(
  action: MachinePowerAction,
  log: Logger,
  io: PowerActionIo = defaultPowerActionIo
): Promise<void> {
  log.info(`power action requested: ${action}`)
  if (action === 'sleep') {
    const result = await io.sleep()
    if (result.code !== 0) {
      const detail = result.stderr.trim().split(/\r?\n/)[0]
      throw new Error(
        detail
          ? tMain('mainApp.power.sleepFailedDetail', { detail })
          : tMain('mainApp.power.sleepFailed')
      )
    }
    return
  }
  const result = await io.run('shutdown.exe', SHUTDOWN_ARGS[action], 15_000)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0]
    // One sentence per action (shutdown, restart, hibernate), with or without Windows' own words.
    const vars = { code: result.code, detail }
    const key =
      action === 'shutdown'
        ? detail
          ? 'mainApp.power.shutdownFailedDetail'
          : 'mainApp.power.shutdownFailed'
        : action === 'restart'
          ? detail
            ? 'mainApp.power.restartFailedDetail'
            : 'mainApp.power.restartFailed'
          : detail
            ? 'mainApp.power.hibernateFailedDetail'
            : 'mainApp.power.hibernateFailed'
    throw new Error(tMain(key, vars))
  }
}
