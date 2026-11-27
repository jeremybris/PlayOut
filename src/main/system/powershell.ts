import { execFile } from 'child_process'
import { createLogger } from '../logger'

const log = createLogger('powershell')

export interface PowerShellOptions {
  timeoutMs?: number
}

export interface PowerShellResult {
  stdout: string
  stderr: string
  code: number
}

const PREAMBLE = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  ''
].join('\n')

const MAX_CONCURRENT = 3
let active = 0
const waiting: (() => void)[] = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolveSlot) =>
    waiting.push(() => {
      active++
      resolveSlot()
    })
  )
}

function release(): void {
  active--
  const next = waiting.shift()
  if (next) next()
}

/** The powershell.exe argument list that runs `script` (with the UTF-8 preamble) as one -EncodedCommand. */
export function powerShellArgs(script: string): string[] {
  const encoded = Buffer.from(PREAMBLE + script, 'utf16le').toString('base64')
  return [
    '-NoProfile',
    '-NonInteractive',
    '-NoLogo',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
  ]
}

/**
 * Run a PowerShell script (Windows PowerShell 5.1) with UTF-8 output. The script is passed as -EncodedCommand so
 * quoting is never an issue. At most three scripts run at once; others queue.
 */
export async function runPowerShell(
  script: string,
  options: PowerShellOptions = {}
): Promise<PowerShellResult> {
  await acquire()
  try {
    return await new Promise<PowerShellResult>((resolveResult) => {
      execFile(
        'powershell.exe',
        powerShellArgs(script),
        {
          windowsHide: true,
          timeout: options.timeoutMs ?? 20_000,
          maxBuffer: 32 * 1024 * 1024,
          encoding: 'utf8'
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0
          if (error && !stdout)
            log.debug(`powershell failed (${code}): ${(error as Error).message.split('\n')[0]}`)
          resolveResult({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
        }
      )
    })
  } finally {
    release()
  }
}

/**
 * Run a script whose last expression is piped to ConvertTo-Json and parse the result.
 * Returns null on failure or empty output. Single-element arrays are unrolled by PowerShell 5.1: use `asArray`.
 */
export async function runPowerShellJson<T = unknown>(
  script: string,
  options: PowerShellOptions & { depth?: number } = {}
): Promise<T | null> {
  const depth = options.depth ?? 6
  const wrapped = `$__r = (& {\n${script}\n})\nif ($null -ne $__r) { $__r | ConvertTo-Json -Depth ${depth} -Compress }`
  const result = await runPowerShell(wrapped, options)
  const text = result.stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch (err) {
    log.warn(`powershell JSON parse failed: ${(err as Error).message}: ${text.slice(0, 200)}`)
    return null
  }
}

export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Quote a string for use inside a single-quoted PowerShell literal. PowerShell also ends the literal on the curly
 * quotes (U+2018 to U+201B), as in a folder named `Assassin’s Creed`, so those are doubled too.
 */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`
}
