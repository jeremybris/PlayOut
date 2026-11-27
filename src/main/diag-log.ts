// A plain diagnostic log written synchronously (appendFileSync), for problems the regular log cannot show: a scan
// that stalls, a main process that freezes, a store file that will not save. Each line is on disk the moment it is
// written, so the log survives a frozen app that is killed. One file per topic in userData/logs, rotated at 5 MB.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

export interface DiagLog {
  /** Append one line ("2026-11-03 19:46:22.294 <text>"). Never throws. */
  line(text: string): void
  readonly file: string
}

function stamp(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  )
}

export function createDiagLog(file: string): DiagLog {
  let ready = false
  let written = 0
  return {
    file,
    line(text) {
      try {
        if (!ready) {
          mkdirSync(dirname(file), { recursive: true })
          try {
            written = statSync(file).size
          } catch {
            written = 0
          }
          ready = true
        }
        if (written > MAX_BYTES) {
          // Keep the previous file as .old.log: the run before is often the one that went wrong.
          try {
            renameSync(file, file.replace(/\.log$/, '') + '.old.log')
          } catch {
            /* another process holds it: keep appending */
          }
          written = 0
        }
        const out = `${stamp(new Date())} ${text}\n`
        appendFileSync(file, out, 'utf8')
        written += Buffer.byteLength(out)
      } catch {
        // A diagnostic log must never break the app.
      }
    }
  }
}

/** A log that writes nowhere (tests). */
export const NO_DIAG: DiagLog = { file: '', line: () => undefined }
