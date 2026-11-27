import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { XboxCommand } from '../../shared/convert'
import { tMain } from '../i18n'

/**
 * PlayOut's Xbox / Xbox 360 image helper (resources\xbox\PlayOutXbox.exe, built from xbox-helper/ on the MIT
 * XISOSharp and CHDSharp libraries, the engine of XISO Studio). It prints one JSON object per line on stdout:
 * progress, then `done` or `error`; it exits 0 only once its output is verified (or nothing needed doing). Outputs are
 * written under a `.playout-partial` name and renamed last, so a killed run leaves only names with that marker.
 */

/** The marker in the names of the helper's unfinished outputs (`Game.playout-partial.iso`, `Game.playout-partial`). */
export const PARTIAL_MARKER = '.playout-partial'

export type HelperLine =
  | {
      type: 'progress'
      phase: string
      percent: number
      /** This phase's place among the command's phases (helper 1.2.0+). */
      stage?: number
      stages?: number
      /** 0-100 across every phase of the command, never going back (helper 1.2.0+). */
      overall?: number
    }
  | ({ type: 'done' } & Record<string, unknown>)
  | {
      type: 'error'
      message: string
      /** The input itself was refused (not an Xbox image, damaged): asking again gives the same answer (1.2.1+). */
      refused?: boolean
    }

/** One stdout line of the helper, or null for anything else (stderr's free-form diagnostics). */
export function parseHelperLine(line: string): HelperLine | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  try {
    const value = JSON.parse(text) as { type?: unknown }
    if (value.type === 'progress' || value.type === 'done' || value.type === 'error')
      return value as HelperLine
  } catch {
    /* not one of the helper's lines */
  }
  return null
}

/** What `info` tells about an image. */
export interface XboxImageInfo {
  format: 'redump' | 'xiso' | 'cso' | 'cci' | 'chd' | 'zar' | string
  /** The image is already an optimized XISO (trimming it would change nothing). */
  optimized: boolean
  platform: 'xbox' | 'xbox360' | null
  /** 1, 2 or 3 for a full disc dump; null for a bare XISO. */
  xgd: number | null
}

/** The helper ran and refused the image (not an Xbox image, damaged): why. */
export interface XboxImageRejected {
  rejected: string
}

/** The helper's file name inside its folder. */
export const HELPER_EXE = 'PlayOutXbox.exe'

/** `Game.xiso.iso` → `Game`: a file's name without its extension and a trailing `.xiso` (a folder's: itself). */
function stemOf(path: string, folder: boolean): string {
  const name = basename(path)
  if (folder) return name
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  return stem.replace(/\.xiso$/i, '') || stem
}

/** Where a command's result goes: next to its input (a file, or a folder), named after it. */
export function helperOutput(command: XboxCommand, input: string, folder = false): string {
  const dir = dirname(input)
  const stem = stemOf(input, folder || command === 'pack')
  switch (command) {
    case 'trim': {
      const out = join(dir, `${stem}.xiso.iso`)
      // An unoptimized image already named .xiso.iso cannot be rewritten onto itself.
      return out.toLowerCase() === input.toLowerCase()
        ? join(dir, `${stem} (trimmed).xiso.iso`)
        : out
    }
    case 'extract':
      return join(dir, stem)
    case 'pack':
      return join(dir, `${stem}.iso`)
    case 'zar':
      return join(dir, `${stem}.zar`)
    case 'chd':
      return join(dir, `${stem}.chd`)
    case 'toiso':
      return join(dir, `${stem}.iso`)
  }
}

/** Run the helper; each line it prints is told (stdout and stderr). Resolves to its exit code. */
export type HelperRun = (
  exe: string,
  args: string[],
  onLine: (line: string) => void,
  signal: AbortSignal
) => Promise<number>

/** `info` reads an image's headers and file tree, seconds at most; a helper still running after this is stuck. */
const XBOX_INFO_TIMEOUT_MS = 60_000

/** What `onFailed` is told when the helper's `info` was killed for taking too long. */
export const xboxInfoTimedOut = (): string => tMain('mainConvert.xboxTimeout')

/**
 * The helper's `info` on an image. `{ rejected }` only when the helper ran and refused the image itself (exit 1 with
 * an error line marked `refused`: not an Xbox image, damaged); null when the helper is missing, could not start,
 * failed for another reason (an I/O error, the file locked: it may pass), answered nothing usable or did not finish
 * in `timeoutMs` (it is killed). Such a failure with an error line, and a helper killed for taking too long, are
 * also told to `onFailed`.
 */
export async function xboxImageInfo(
  exe: string,
  image: string,
  run: HelperRun = spawnHelper,
  onFailed?: (message: string) => void,
  timeoutMs = XBOX_INFO_TIMEOUT_MS
): Promise<XboxImageInfo | XboxImageRejected | null> {
  let done: Record<string, unknown> | null = null
  let refusal: string | null = null
  let failure: string | null = null
  // A helper stuck on a damaged or locked file is killed, so whoever asked (Trim Games' plan) is not held forever.
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const code = await run(
      exe,
      ['info', image],
      (line) => {
        const parsed = parseHelperLine(line)
        if (parsed?.type === 'done') done = parsed
        else if (parsed?.type === 'error') {
          refusal = parsed.refused === true ? parsed.message : null
          failure = parsed.message
        }
      },
      signal
    )
    const info = done as Record<string, unknown> | null
    // Killed for taking too long: what it printed while dying says nothing about the image. A failure that may
    // pass, so the image is looked at again later instead of being handed to a conversion that would hang as well.
    if (signal.aborted && code !== 0) {
      onFailed?.(xboxInfoTimedOut())
      return null
    }
    if (code === 1 && refusal) return { rejected: refusal }
    if (code === 1 && failure) onFailed?.(failure)
    if (code !== 0 || !info) return null
    return {
      format: String(info['format'] ?? ''),
      optimized: info['optimized'] === true,
      platform:
        info['platform'] === 'xbox' || info['platform'] === 'xbox360' ? info['platform'] : null,
      xgd: typeof info['xgd'] === 'number' ? info['xgd'] : null
    }
  } catch {
    return null
  }
}

/** One `read` of a CHD slice takes well under a second; a helper still running after this is stuck. */
const CHD_READ_TIMEOUT_MS = 15_000

/**
 * A slice of any CHD's decompressed image through the helper's `read` command (1.3.0+): a CD's frames of 2448 bytes
 * (sector and subcode), a DVD's 2048-byte sectors. At most 1 MiB per call; fewer bytes at the end of the image. Null
 * when the helper is missing or older, the file is not a readable CHD, or the helper did not finish in `timeoutMs`
 * (it is killed).
 */
export async function chdRead(
  exe: string,
  chd: string,
  offset: number,
  length: number,
  run: HelperRun = spawnHelper,
  timeoutMs = CHD_READ_TIMEOUT_MS
): Promise<{ classification: string; imageBytes: number; data: Buffer } | null> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1)
    return null
  let done: Record<string, unknown> | null = null
  try {
    const code = await run(
      exe,
      ['read', chd, String(offset), String(Math.min(length, 1 << 20))],
      (line) => {
        const parsed = parseHelperLine(line)
        if (parsed?.type === 'done') done = parsed
      },
      // A helper stuck on a damaged or locked file is killed, so the game falls back to its name.
      AbortSignal.timeout(timeoutMs)
    )
    const result = done as Record<string, unknown> | null
    if (code !== 0 || !result || typeof result['data'] !== 'string') return null
    return {
      classification: String(result['classification'] ?? 'unknown'),
      imageBytes: Number(result['imageBytes'] ?? 0),
      data: Buffer.from(result['data'], 'base64')
    }
  } catch {
    return null
  }
}

/**
 * Removes the helper's unfinished outputs (names holding `.playout-partial`, nothing else) below these folders: what
 * a run killed with PlayOut left. Symbolic links are not followed; a few levels deep at most. Resolves to the paths
 * removed.
 */
export async function sweepPartials(roots: string[], depth = 4): Promise<string[]> {
  const removed: string[] = []
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.name.toLowerCase().includes(PARTIAL_MARKER)) {
        try {
          await fs.rm(path, { recursive: true, force: true })
          removed.push(path)
        } catch {
          /* in use: the next start tries again */
        }
      } else if (e.isDirectory() && left > 0) await walk(path, left - 1)
    }
  }
  for (const root of roots) await walk(root, depth)
  return removed
}

/** The helper is where it should be. */
export async function helperPresent(exe: string): Promise<boolean> {
  return fs.stat(exe).then(
    (s) => s.isFile(),
    () => false
  )
}

/** Spawn the helper (no window); a stop kills it (its partial output is the caller's to remove). */
export function spawnHelper(
  exe: string,
  args: string[],
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<number> {
  if (signal.aborted) return Promise.resolve(3)
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, cwd: dirname(exe) })
    const rest = { out: '', err: '' }
    const reader =
      (key: keyof typeof rest) =>
      (chunk: Buffer): void => {
        rest[key] += chunk.toString('utf8')
        const lines = rest[key].split(/\r?\n/)
        rest[key] = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLine(line)
      }
    child.stdout.on('data', reader('out'))
    child.stderr.on('data', reader('err'))
    const abort = (): void => {
      child.kill()
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', (err) => {
      signal.removeEventListener('abort', abort)
      reject(err)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      for (const line of [rest.out, rest.err]) if (line.trim()) onLine(line)
      resolve(code ?? 1)
    })
  })
}
