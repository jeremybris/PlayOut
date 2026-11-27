import type { ChildProcess, SpawnOptions } from 'child_process'
import { spawn as nodeSpawn } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { createInterface } from 'readline'
import type { StreamResolution, StreamingToolStatus } from '../../shared/types'
import type { Logger } from '../logger'
import {
  ensureGithubTool,
  findToolFile,
  MOONLIGHT_TOOL,
  readInstalledTool,
  type GithubToolSpec,
  type InstalledTool
} from './tools'
import { tMain } from '../i18n'

/**
 * Moonlight-qt (the stream client) driven through its command line: `pair`, `list`, `stream` and `quit`. The portable
 * build keeps its settings and pairing certificates in an INI next to the exe, but only when `portable.dat` is in the
 * *working folder*, so every run starts in Moonlight's own folder (otherwise pairing would land in the registry and be
 * lost to the next run's portable settings).
 */

export const MOONLIGHT_EXE = 'Moonlight.exe'
const LIST_TIMEOUT_MS = 30_000
const QUIT_TIMEOUT_MS = 30_000
/** How long a window gets to close itself before it is killed (Qt saves its settings on the way out). */
const CLOSE_TIMEOUT_MS = 8_000

/** Windows' own tools by full path: a bare name is looked up in the current folder before PATH. */
function systemTool(...parts: string[]): string {
  const root = process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows'
  return join(root, 'System32', ...parts)
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface MoonlightDeps {
  /** userData/streaming/moonlight (the release goes in `app/`). */
  root: string
  log: Logger
  spawn?: SpawnFn
  fetch?: typeof fetch
  /** The release to use (tests). */
  tool?: GithubToolSpec
  onStatus?: (status: StreamingToolStatus) => void
}

export interface MoonlightStreamOptions {
  resolution: StreamResolution
  /** This PC's screen, used for 'auto'. Without it Moonlight keeps its own setting. */
  screen?: { width: number; height: number }
  fps: number
  /** 0 = Moonlight's default for the resolution and frame rate. */
  bitrateKbps: number
  displayMode: 'fullscreen' | 'windowed' | 'borderless'
}

export interface Moonlight {
  status(): StreamingToolStatus
  ensureInstalled(onProgress?: (done: number, total: number) => void): Promise<InstalledTool>
  /**
   * Start pairing with the host using our PIN (the host approves it on its side). The pair window waits for a click
   * when it is done, so the caller kills it once the host reports the result; `done` resolves when it has closed.
   */
  pair(host: string, pin: string): Promise<{ child: ChildProcess; done: Promise<void> }>
  /**
   * Close a Moonlight window the way its close button does (WM_CLOSE through taskkill without /F), so Qt writes its
   * settings: a pairing only reaches Moonlight's settings file on a clean exit, and a killed pair window forgets it
   * (seen with Moonlight 6.2 and Sunshine 2026.914). Falls back to killing it after `timeoutMs`.
   */
  closeWindow(child: ChildProcess, timeoutMs?: number): Promise<void>
  /** `list <host>` succeeds only when this Moonlight is paired with the host (and can reach it). */
  isPaired(host: string): Promise<boolean>
  /** Start the stream window; it exits when the session ends. */
  stream(host: string, app: string, opts: MoonlightStreamOptions): Promise<ChildProcess>
  /** Ask the host to close the running app (ends the stream). */
  quit(host: string): Promise<void>
}

/** The `stream` arguments for the settings: resolution, frame rate, bitrate and window mode. */
export function streamArgs(host: string, app: string, opts: MoonlightStreamOptions): string[] {
  const args = ['stream', host, app]
  if (opts.resolution === 'auto') {
    if (opts.screen && opts.screen.width > 0 && opts.screen.height > 0)
      args.push(
        '--resolution',
        `${Math.round(opts.screen.width)}x${Math.round(opts.screen.height)}`
      )
  } else args.push(`--${opts.resolution}`)
  if (opts.fps > 0) args.push('--fps', String(Math.round(opts.fps)))
  if (opts.bitrateKbps > 0) args.push('--bitrate', String(Math.round(opts.bitrateKbps)))
  // --quit-after: the stream ends when the game does, and leaving the stream closes the game on the host.
  args.push('--display-mode', opts.displayMode, '--quit-after')
  return args
}

/** `ip` or `ip:port`; refuses anything that could be read as an option. */
function checkHost(host: string): string {
  const h = host.trim()
  if (!h || h.startsWith('-') || /\s/.test(h)) throw new Error(`not a host address: ${host}`)
  return h
}

export function createMoonlight(deps: MoonlightDeps): Moonlight {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnFn)
  const log = deps.log
  const toolRoot = join(deps.root, 'app')
  let current: StreamingToolStatus = { state: 'missing' }
  let exe: string | null = null

  function setStatus(next: StreamingToolStatus): void {
    current = next
    deps.onStatus?.({ ...next })
  }

  async function preparePortable(path: string): Promise<void> {
    const marker = join(dirname(path), 'portable.dat')
    await fs.writeFile(marker, '', { flag: 'a' })
  }

  async function requireExe(): Promise<string> {
    if (exe) return exe
    const installed = await readInstalledTool(toolRoot)
    const found = installed ? await findToolFile(installed.dir, MOONLIGHT_EXE) : null
    if (!installed || !found) throw new Error(tMain('mainStreaming.moonlight.notInstalled'))
    await preparePortable(found)
    exe = found
    if (current.state === 'missing') setStatus({ state: 'installed', version: installed.tag })
    return found
  }

  function run(path: string, args: string[]): ChildProcess {
    const child = spawn(path, args, {
      cwd: dirname(path),
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // Moonlight writes its log to stderr when it is redirected: keep the lines that say what went wrong.
    const onLine = (line: string): void => {
      const text = line.trim()
      if (/\b(error|fail|warn)/i.test(text)) log.info(`Moonlight: ${text.slice(0, 500)}`)
    }
    if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine)
    if (child.stderr) createInterface({ input: child.stderr }).on('line', onLine)
    child.on('error', (err) => log.warn(`Moonlight ${args[0]}: ${err.message}`))
    return child
  }

  function waitClose(child: ChildProcess, timeoutMs?: number): Promise<number | null> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode)
        return
      }
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              child.kill()
              resolve(null)
            }, timeoutMs)
      child.once('error', () => {
        if (timer) clearTimeout(timer)
        resolve(null)
      })
      child.once('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve(code)
      })
    })
  }

  function spawned(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
  }

  return {
    status: () => ({ ...current }),

    async ensureInstalled(onProgress): Promise<InstalledTool> {
      const before = current
      try {
        const installed = await ensureGithubTool({
          ...(deps.tool ?? MOONLIGHT_TOOL),
          root: toolRoot,
          fetch: deps.fetch,
          log,
          requiredFile: MOONLIGHT_EXE,
          onProgress: (done, total) => {
            setStatus({
              state: 'downloading',
              percent: total ? Math.min(100, Math.round((done / total) * 100)) : undefined
            })
            onProgress?.(done, total)
          }
        })
        const found = await findToolFile(installed.dir, MOONLIGHT_EXE)
        if (!found) throw new Error(`the Moonlight release has no ${MOONLIGHT_EXE}`)
        await preparePortable(found)
        exe = found
        setStatus({ state: 'installed', version: installed.tag })
        return installed
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus({ state: 'error', version: before.version, error: message })
        throw err
      }
    },

    async pair(host, pin): Promise<{ child: ChildProcess; done: Promise<void> }> {
      if (!/^\d{4}$/.test(pin)) throw new Error('the pairing PIN must be 4 digits')
      const child = run(await requireExe(), ['pair', checkHost(host), '--pin', pin])
      await spawned(child)
      return { child, done: waitClose(child).then(() => undefined) }
    },

    async closeWindow(child, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
      if (child.exitCode !== null || child.pid === undefined) return
      const closer = spawn(systemTool('taskkill.exe'), ['/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true
      })
      closer.on('error', () => undefined)
      // waitClose kills the window itself when the timeout passes.
      await waitClose(child, timeoutMs)
    },

    async isPaired(host): Promise<boolean> {
      const child = run(await requireExe(), ['list', checkHost(host)])
      return (await waitClose(child, LIST_TIMEOUT_MS)) === 0
    },

    async stream(host, app, opts): Promise<ChildProcess> {
      const child = run(await requireExe(), streamArgs(checkHost(host), app, opts))
      await spawned(child)
      return child
    },

    async quit(host): Promise<void> {
      const child = run(await requireExe(), ['quit', checkHost(host)])
      await waitClose(child, QUIT_TIMEOUT_MS)
    }
  }
}
