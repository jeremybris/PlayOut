// The regular log's file writer. electron-log's own file transport opens the file once, and if that first open fails
// (a lock, an antivirus scan, a folder that is not there yet) it caches a NullFile for the life of the process: every
// later line is dropped and the only complaint goes to the console, which a packaged app does not have. Its getFile()
// still reports the right path, so nothing looks wrong. This sink appends each line on its own (appendFileSync), so a
// failed write costs that one line only, and it reports the first failure of a streak and the recovery after it.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface LogFileSink {
  /** Append one line (a newline is added). Never throws. */
  write(text: string): void
  /** The file this sink writes, or null when it cannot be resolved yet. */
  path(): string | null
  /** Lines lost since the sink started. */
  readonly failedWrites: number
}

export interface LogFileSinkOptions {
  /** Resolved on every write until it returns a path: userData may not be final when the first line is logged. */
  resolvePath: () => string | null
  maxBytes: number
  /** Told when writing starts failing (with the error) and when it works again. */
  onTrouble: (text: string) => void
}

export function createLogFileSink(options: LogFileSinkOptions): LogFileSink {
  let file: string | null = null
  let size = -1
  let failing = false
  let failedWrites = 0
  let streak = 0

  function resolve(): string | null {
    if (file) return file
    try {
      file = options.resolvePath()
    } catch {
      file = null
    }
    return file
  }

  return {
    get failedWrites() {
      return failedWrites
    },
    path: resolve,
    write(text) {
      const target = resolve()
      if (!target) return
      const line = `${text}\n`
      try {
        if (size < 0) {
          mkdirSync(dirname(target), { recursive: true })
          try {
            size = statSync(target).size
          } catch {
            size = 0
          }
        }
        if (size > options.maxBytes) {
          try {
            renameSync(target, target.replace(/\.log$/, '') + '.old.log')
          } catch {
            /* held by another process: keep appending */
          }
          size = 0
        }
        appendFileSync(target, line, 'utf8')
        size += Buffer.byteLength(line)
        if (failing) {
          failing = false
          report(`regular log ${target} is writable again (${streak} line(s) lost)`)
          streak = 0
        }
      } catch (err) {
        failedWrites++
        streak++
        // Re-check the folder and size on the next write: the folder may have been removed.
        size = -1
        if (!failing) {
          failing = true
          const reason = err instanceof Error ? err.message : String(err)
          report(`regular log ${target} cannot be written: ${reason}`)
        }
      }
    }
  }

  function report(text: string): void {
    try {
      options.onTrouble(text)
    } catch {
      /* a reporter must never break logging */
    }
  }
}
