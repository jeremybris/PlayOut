import { spawn as nodeSpawn } from 'child_process'
import type { Logger } from '../logger'
import type { PadProcess, PadSpawn } from '../native-host/pad-reader'
import { createSwipeRecognizer, parseTouchLine } from './gesture'
import { touchSwipeScript } from './script'

/**
 * The touch watcher (docs/home-overlay.md, "Touch swipe"): one powershell.exe running script.ts while it is wanted
 * (a game runs and Settings › Controls › Swipe from the left opens the overlay is on). It calls onSwipe for each swipe
 * from the left edge. Closing its stdin ends it; a watcher that keeps failing is given up on until the next start.
 */
export interface TouchSwipeWatcher {
  /** Run while `wanted` is true (no-op when already so). */
  set(wanted: boolean): void
  running(): boolean
  dispose(): void
}

export interface TouchSwipeDeps {
  log: Logger
  onSwipe: () => void
  spawn?: PadSpawn
}

/** Given up on after this many failed starts (each one waits a little longer). */
const MAX_RESTARTS = 3
const STOP_GRACE_MS = 2_000

const defaultSpawn: PadSpawn = (command, args, options) => nodeSpawn(command, args, options)

export function createTouchSwipeWatcher(deps: TouchSwipeDeps): TouchSwipeWatcher {
  const { log } = deps
  const spawn = deps.spawn ?? defaultSpawn
  let wanted = false
  let current: { proc: PadProcess; ended: boolean } | null = null
  let restarts = 0
  let restartTimer: NodeJS.Timeout | null = null

  function launch(): void {
    restartTimer = null
    if (!wanted || current) return
    let proc: PadProcess
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
    } catch (err) {
      ended(null, (err as Error).message)
      return
    }
    const session = { proc, ended: false }
    current = session
    const recognizer = createSwipeRecognizer(() => {
      log.info('swipe from the left: opening the overlay')
      deps.onSwipe()
    })
    let buffer = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      if (session.ended) return
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = parseTouchLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        if (line.kind === 'ready') {
          restarts = 0
          log.info(line.touch ? 'touch watcher running' : 'no touchscreen: touch watcher idle')
        } else recognizer.feed(line)
      }
    })
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk
    })
    proc.stdin.on('error', (err) => log.debug(`touch watcher stdin error: ${err.message}`))
    const end = (reason: string): void => {
      if (session.ended) return
      session.ended = true
      if (current === session) current = null
      ended(stderr.trim().split(/\r?\n/)[0] || null, reason)
    }
    proc.on('error', (err) => end(err.message))
    proc.on('exit', (code, signal) => end(`exited (${code ?? signal})`))
    proc.stdin.write(touchSwipeScript().split('\n').join('\r\n') + '\r\n')
  }

  function ended(stderr: string | null, reason: string): void {
    if (!wanted) return
    log.warn(`touch watcher ${reason}${stderr ? `: ${stderr}` : ''}`)
    if (restarts >= MAX_RESTARTS) {
      log.error('touch watcher gave up; swipes will not open the overlay until the next game')
      return
    }
    restarts++
    restartTimer = setTimeout(launch, 1000 * 2 ** restarts)
    restartTimer.unref?.()
  }

  function stop(): void {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    const session = current
    current = null
    if (!session || session.ended) return
    session.ended = true
    try {
      session.proc.stdin.end()
    } catch {
      /* already gone */
    }
    const grace = setTimeout(() => {
      try {
        session.proc.kill()
      } catch {
        /* already gone */
      }
    }, STOP_GRACE_MS)
    grace.unref?.()
  }

  return {
    set(next) {
      if (next === wanted) return
      wanted = next
      if (wanted) {
        restarts = 0
        launch()
      } else stop()
    },
    running: () => current !== null,
    dispose() {
      wanted = false
      stop()
    }
  }
}
