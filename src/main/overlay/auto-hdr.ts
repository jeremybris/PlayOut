import { execFile } from 'child_process'
import type { CommandRunner } from '../system/power'
import { tMain } from '../i18n'

/**
 * Windows' global Auto HDR switch (the overlay's Auto HDR tile, docs/home-overlay.md). Windows keeps it as one token
 * of a per-user string value: HKCU\Software\Microsoft\DirectX\UserGpuPreferences, DirectXUserGlobalSettings =
 * "AutoHDREnable=1;SwapEffectUpgradeEnable=1;VRROptimizeEnable=0;". Only the AutoHDREnable token is changed; every
 * other token stays as it was, and the key's other values (each program's own preferences, in other encodings) are
 * never touched. HKCU, so no administrator rights. Games started afterwards pick the change up.
 */

export const AUTO_HDR_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
export const AUTO_HDR_VALUE = 'DirectXUserGlobalSettings'
const TOKEN = 'AutoHDREnable'
const REG_TIMEOUT_MS = 10_000
/** reg.exe's English "not found" answer (exit 1). In other languages the key is listed to tell instead. */
const NOT_FOUND = /unable to find the specified registry key or value/i

const isAutoHdrToken = (t: string): boolean =>
  t.slice(0, t.indexOf('=')).trim().toLowerCase() === TOKEN.toLowerCase()

/** 'AutoHDREnable=1;SwapEffectUpgradeEnable=1;' -> true / false / null (absent). Any non-zero = on. */
export function parseAutoHdr(data: string | null): boolean | null {
  if (!data) return null
  const token = data.split(';').find((t) => t.includes('=') && isAutoHdrToken(t))
  if (!token) return null
  const value = Number.parseInt(token.slice(token.indexOf('=') + 1).trim(), 10)
  return Number.isFinite(value) ? value !== 0 : null
}

/** Replace only the AutoHDREnable token (append it when absent), keep every other token and the trailing ';'. */
export function withAutoHdr(data: string | null, on: boolean): string {
  const tokens = (data ?? '').split(';').filter((t) => t.trim() !== '')
  const next = `${TOKEN}=${on ? 1 : 0}`
  let found = false
  const out = tokens.flatMap((t) => {
    if (!t.includes('=') || !isAutoHdrToken(t)) return [t]
    // A repeated token would be ambiguous: the first one takes the new value, the others go.
    if (found) return []
    found = true
    return [next]
  })
  if (!found) out.push(next)
  return `${out.join(';')};`
}

/**
 * reg.exe for the Auto HDR value: like execCommand, but a run that did not exit by itself (timed out, killed, could
 * not start) is code -1, never 1. reg.exe answers 1 for every failure, so 1 alone never means "the value is absent".
 */
export const regCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = !error
          ? 0
          : typeof error.code === 'number' && !error.killed && !error.signal
            ? error.code
            : -1
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })

const notFound = (r: { stdout: string; stderr: string }): boolean =>
  NOT_FOUND.test(`${r.stderr}\n${r.stdout}`)

/**
 * The value's data from `reg query <key> /v <value>` output, or from a listing of the whole key (`reg query <key>`);
 * null when it is confirmed absent: reg's own "unable to find" answer, or a key listing without the value. Anything
 * else throws (a timeout, a start failure, access denied, an exit 1 without that answer), so a failed read is never
 * taken for "not set" and written over.
 */
export function parseRegQuery(r: { code: number; stdout: string; stderr: string }): string | null {
  if (r.code === 1 && notFound(r)) return null
  if (r.code !== 0)
    throw new Error(`reg query failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`)
  for (const line of r.stdout.replace(/\r/g, '').split('\n')) {
    const m = /^\s*(.+?)\s+REG_SZ(?:[ \t]+(.*))?$/.exec(line)
    if (m && m[1]!.trim().toLowerCase() === AUTO_HDR_VALUE.toLowerCase()) return (m[2] ?? '').trim()
  }
  return null
}

export interface AutoHdrDeps {
  /** reg.exe (regCommand; tests: a fake). A timeout or a failed start must be a code other than 0 and 1. */
  run: CommandRunner
  /** Tests: the value's data instead of reg query. */
  read?(): Promise<string | null>
}

export interface AutoHdr {
  /** The global switch: true = on, false = off, null = not set. Throws when the value cannot be read. */
  read(): Promise<boolean | null>
  /** Set it (read first, so only the AutoHDREnable token changes; a failed read writes nothing). */
  write(on: boolean): Promise<void>
}

export function createAutoHdr(deps: AutoHdrDeps): AutoHdr {
  const readData = async (): Promise<string | null> => {
    if (deps.read) return deps.read()
    const r = await deps.run(
      'reg.exe',
      ['query', AUTO_HDR_KEY, '/v', AUTO_HDR_VALUE],
      REG_TIMEOUT_MS
    )
    if (r.code !== 1 || notFound(r)) return parseRegQuery(r)
    // Exit 1 without the English answer: "not found" in another language, or a real failure. A listing of the key
    // that works and lacks the value confirms it is absent; anything else is a failed read (thrown).
    const key = await deps.run('reg.exe', ['query', AUTO_HDR_KEY], REG_TIMEOUT_MS)
    if (key.code !== 0) return parseRegQuery(r)
    return parseRegQuery(key)
  }
  return {
    async read() {
      return parseAutoHdr(await readData())
    },
    async write(on) {
      const before = await readData()
      const data = withAutoHdr(before, on)
      if (data === before) return
      const r = await deps.run(
        'reg.exe',
        ['add', AUTO_HDR_KEY, '/v', AUTO_HDR_VALUE, '/t', 'REG_SZ', '/d', data, '/f'],
        REG_TIMEOUT_MS
      )
      if (r.code !== 0)
        throw new Error(
          tMain('mainOverlay.extras.autoHdrRefused', {
            error: (r.stderr || r.stdout).trim() || `exit ${r.code}`
          })
        )
    }
  }
}
