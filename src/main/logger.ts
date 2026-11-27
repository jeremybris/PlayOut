import { app } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import { createLogFileSink, type LogFileSink } from './log-file-sink'

let initialized = false
let sink: LogFileSink | null = null

const MAX_BYTES = 5 * 1024 * 1024
/** Lines kept for the mirror until index.ts connects it to the diagnostic log (the first lines come before that). */
const MIRROR_BUFFER = 200
let mirror: ((text: string) => void) | null = null
const pending: string[] = []

function toMirror(text: string): void {
  if (mirror) {
    try {
      mirror(text)
    } catch {
      /* never break logging */
    }
  } else if (pending.length < MIRROR_BUFFER) pending.push(text)
}

/**
 * Send warnings, errors and regular-log write trouble to `fn` (the diagnostic log, written with plain appendFileSync):
 * a second copy of what matters most, in case the regular log cannot be written. Lines logged before this call are
 * delivered now.
 */
export function mirrorLogTo(fn: (text: string) => void): void {
  mirror = fn
  for (const text of pending.splice(0)) toMirror(text)
}

function userDataLogPath(): string | null {
  // Resolved on the first write, not at import: mock runs move userData before main() starts.
  if (!app || typeof app.getPath !== 'function') return null
  return join(app.getPath('userData'), 'logs', 'main.log')
}

/** Initialise electron-log once (file + console transports). Safe to call repeatedly and outside Electron. */
export function initLogger(): void {
  if (initialized) return
  initialized = true
  try {
    log.initialize()
    log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'info'
    log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}'

    // electron-log's file transport keeps a dead file for the whole run once its first open fails, and says so only
    // on the console (log-file-sink.ts). Keep its formatting, write through our own sink.
    const builtin = log.transports.file
    builtin.level = false
    sink = createLogFileSink({
      resolvePath: userDataLogPath,
      maxBytes: MAX_BYTES,
      onTrouble: (text) => toMirror(text)
    })
    const fileSink = sink
    const disk = Object.assign(
      (message: Parameters<typeof builtin>[0]): void => {
        const data = disk.transforms.reduce<unknown[]>(
          (out, fn) => fn({ data: out, logger: log, message, transport: disk }),
          message.data
        )
        const text = String(data)
        fileSink.write(text)
        if (message.level === 'warn' || message.level === 'error') toMirror(text)
      },
      {
        level: 'info' as const,
        format: builtin.format,
        inspectOptions: builtin.inspectOptions,
        transforms: [...builtin.transforms]
      }
    )
    ;(log.transports as Record<string, unknown>).disk = disk
  } catch {
    /* running outside Electron (tests) */
  }
}

/** Where the regular log is written (for the diagnostic log's first line); null outside Electron. */
export function logFilePath(): string | null {
  return sink?.path() ?? null
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export function createLogger(scope: string): Logger {
  initLogger()
  try {
    return log.scope(scope)
  } catch {
    const prefix = `[${scope}]`
    return {
      debug: (...a) => console.debug(prefix, ...a),
      info: (...a) => console.info(prefix, ...a),
      warn: (...a) => console.warn(prefix, ...a),
      error: (...a) => console.error(prefix, ...a)
    }
  }
}

export { log }
