import { spawn } from 'child_process'
import { gzipSync } from 'zlib'
import { psQuote } from '../system/powershell'
import type { Runner } from './types'

/** Each of stdout and stderr keeps at most this much (the start of the output). */
const OUTPUT_CAP = 64 * 1024
/** How long an elevated install may take (the UAC prompt included). */
const ELEVATED_TIMEOUT_MS = 30 * 60 * 1000
/** The Win32 error for a declined UAC prompt (ERROR_CANCELLED). */
export const ERROR_CANCELLED = 1223

function appendCapped(current: string, chunk: Buffer): string {
  if (current.length >= OUTPUT_CAP) return current
  const text = current + chunk.toString('utf8')
  return text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) : text
}

/** Kill a process and its children (taskkill /T /F on Windows: installers and emulators spawn helpers). */
function killTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore'
      })
      killer.on('error', kill)
      return
    } catch {
      /* fall through */
    }
  }
  kill()
}

/**
 * Run a program without a shell and wait for it. stdout and stderr are captured (64 KB each at most). On timeout the
 * process tree is killed and `code` is null; a program that cannot be started resolves with code null and the error
 * message as stderr. Never rejects.
 */
export const runProcess: Runner = (file, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    let fallback: NodeJS.Timeout | undefined
    const finish = (code: number | null, error?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (fallback) clearTimeout(fallback)
      resolve({ code, stdout, stderr: error ?? stderr })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      finish(null, (err as Error).message)
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => (stdout = appendCapped(stdout, chunk)))
    child.stderr?.on('data', (chunk: Buffer) => (stderr = appendCapped(stderr, chunk)))
    child.on('error', (err) => finish(null, err.message))
    child.on('close', (code) => finish(timedOut ? null : code))
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid, () => child.kill('SIGKILL'))
        // 'close' normally follows the kill; never hang when it does not.
        fallback = setTimeout(() => finish(null), 5000)
      }, options.timeoutMs)
    }
  })

/**
 * Quote one argument for a Windows command line (the CommandLineToArgvW rules): arguments with spaces, tabs or quotes
 * are wrapped in double quotes, with embedded quotes and the backslashes before them escaped.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"'
    } else {
      out += '\\'.repeat(slashes) + ch
    }
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}

/**
 * The PowerShell script that runs `file` elevated (UAC), waits and exits with its exit code; 1223 when the user
 * declines the prompt. The arguments are passed as one Windows command line: PowerShell 5.1's Start-Process joins an
 * -ArgumentList array with spaces without quoting, which would split a path with spaces.
 */
export function elevatedScript(
  file: string,
  args: string[],
  options: { hidden?: boolean } = {}
): string {
  const commandLine = args.map(quoteWindowsArg).join(' ')
  const argumentList = commandLine ? ` -ArgumentList ${psQuote(commandLine)}` : ''
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath ${psQuote(file)}${argumentList} -Verb RunAs${options.hidden ? ' -WindowStyle Hidden' : ''} -Wait -PassThru`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    `  while ($e) { if ($e.NativeErrorCode -eq ${ERROR_CANCELLED} -or $e.Message -match 'cancel+ed by the user') { exit ${ERROR_CANCELLED} }; $e = $e.InnerException }`,
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n')
}

/** The powershell.exe arguments that run `script` as an -EncodedCommand (UTF-16LE base64). */
export function encodedPowerShellArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
}

/**
 * Like encodedPowerShellArgs, for a long script: the script travels gzip-compressed inside a short bootstrap, so a
 * script run elevated (encoded twice: here and by runElevated) stays far below Windows' 32767-character command line.
 * The script's `exit N` is the process's exit code; a script that cannot run, or ends without `exit`, exits 1 unless a
 * program it ran last set the exit code.
 */
export function compressedPowerShellArgs(script: string): string[] {
  const packed = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64')
  return encodedPowerShellArgs(
    [
      `$z = New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('${packed}'))), [IO.Compression.CompressionMode]::Decompress)`,
      '$t = (New-Object IO.StreamReader($z, [Text.Encoding]::UTF8)).ReadToEnd()',
      // A script that cannot run (does not parse, or is blocked) is a failure, never exit 0.
      'try { & ([scriptblock]::Create($t)) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
      'exit $(if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 1 })'
    ].join('\n')
  )
}

/** Windows' longest command line (CreateProcess), in characters. */
export const MAX_COMMAND_LINE = 32_767

/**
 * Run a program elevated (one UAC prompt) through PowerShell's Start-Process -Verb RunAs and wait up to 30 minutes.
 * Returns its exit code: 1223 when the user declined the prompt, null when PowerShell could not run or timed out.
 */
export async function runElevated(
  file: string,
  args: string[],
  run: Runner = runProcess,
  options: { hidden?: boolean } = {}
): Promise<number | null> {
  const result = await run(
    'powershell.exe',
    encodedPowerShellArgs(elevatedScript(file, args, options)),
    {
      timeoutMs: ELEVATED_TIMEOUT_MS
    }
  )
  return result.code
}

/** How long stop() waits for a killed program to exit before it gives up. */
const STOP_WAIT_MS = 10_000

/**
 * Start a program without a window, a shell or waiting for it (a preset lets Ryujinx write its default Config.json,
 * then stops it). `exited` resolves with the exit code (null when the program could not start or was ended by a
 * signal); it never rejects. `stop()` kills the process tree (taskkill /T /F) and resolves once the program exited (or after
 * 10 s).
 */
export function startHidden(
  file: string,
  args: string[],
  options: { cwd: string }
): {
  exited: Promise<number | null>
  pid?: number
  stop(): Promise<void>
  close(): Promise<void>
} {
  let child: ReturnType<typeof spawn> | null = null
  let done = false
  let resolveExit!: (code: number | null) => void
  const exited = new Promise<number | null>((resolve) => (resolveExit = resolve))
  const finish = (code: number | null): void => {
    if (done) return
    done = true
    resolveExit(code)
  }
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: 'ignore'
    })
    child.on('error', () => finish(null))
    child.on('exit', (code) => finish(code))
  } catch {
    finish(null)
  }
  const waitExit = async (ms: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined
    const ended = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))
    ])
    if (timer) clearTimeout(timer)
    return ended
  }
  const stop = async (): Promise<void> => {
    if (done || !child) return
    const c = child
    killTree(c.pid, () => c.kill('SIGKILL'))
    await waitExit(STOP_WAIT_MS)
  }
  return {
    exited,
    pid: child?.pid,
    stop,
    async close() {
      if (done || !child) return
      // taskkill without /F asks the program's windows (hidden ones too) to close, so it saves and exits cleanly.
      if (process.platform === 'win32' && child.pid) {
        try {
          const asker = spawn('taskkill', ['/PID', String(child.pid)], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore'
          })
          asker.on('error', () => undefined)
        } catch {
          /* stopped below */
        }
        if (await waitExit(STOP_WAIT_MS)) return
      }
      await stop()
    }
  }
}
