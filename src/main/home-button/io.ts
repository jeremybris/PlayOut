import { execFile, spawn } from 'child_process'
import { promises as fsp } from 'fs'

/**
 * Everything the home button's overrides touch outside the process, behind one interface so tests use fakes. The
 * real version runs plain Windows tools (reg.exe, tasklist.exe): every value it needs lives in HKCU, so nothing
 * needs admin rights, and a short-lived tool is cheaper than another PowerShell.
 */
export interface CommandResult {
  /** Exit code; null when the command could not start or timed out. */
  code: number | null
  stdout: string
  stderr: string
}

export type RunCommand = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<CommandResult>

export interface HomeButtonIo {
  run: RunCommand
  /** The file's bytes, or null when it does not exist. */
  readFile(path: string): Promise<Buffer | null>
  writeFile(path: string, data: Buffer | string): Promise<void>
  rename(from: string, to: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Start a program that outlives PlayOut (Steam). */
  spawnDetached(file: string, args: string[]): void
  sleep(ms: number): Promise<void>
  env: Record<string, string | undefined>
}

const runCommand: RunCommand = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: options.timeoutMs ?? 15_000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // A non-zero exit puts the exit code in error.code; a failed start puts a string there ('ENOENT').
        const errCode: unknown = error ? (error as { code?: unknown }).code : 0
        const code = typeof errCode === 'number' ? errCode : null
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })

export function createRealIo(): HomeButtonIo {
  return {
    run: runCommand,
    async readFile(path) {
      try {
        return await fsp.readFile(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    writeFile: (path, data) => fsp.writeFile(path, data),
    rename: (from, to) => fsp.rename(from, to),
    copyFile: (from, to) => fsp.copyFile(from, to),
    mkdir: async (path) => {
      await fsp.mkdir(path, { recursive: true })
    },
    async exists(path) {
      try {
        await fsp.access(path)
        return true
      } catch {
        return false
      }
    },
    spawnDetached(file, args) {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => {})
      child.unref()
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: process.env
  }
}

/** Write a file through a temp file and a rename, so a crash never leaves it half written. */
export async function writeFileAtomic(
  io: HomeButtonIo,
  path: string,
  data: Buffer | string
): Promise<void> {
  const temp = `${path}.playout-tmp`
  await io.writeFile(temp, data)
  await io.rename(temp, path)
}

// --- reg.exe -----------------------------------------------------------------------------------------------------

export interface RegValue {
  type: string
  /** REG_DWORD as a number; REG_SZ / REG_EXPAND_SZ as text; other types as reg.exe prints them. */
  data: string | number
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parse `reg query <key> /v <name>` output: `    <name>    REG_DWORD    0x1`. */
export function parseRegQuery(stdout: string, valueName: string): RegValue | null {
  const re = new RegExp(`^\\s+${escapeRegExp(valueName)}\\s+(REG_[A-Z_]+)(?:[ \\t]+(.*))?$`, 'im')
  const m = re.exec(stdout.replace(/\r/g, ''))
  if (!m) return null
  const type = m[1].toUpperCase()
  const raw = (m[2] ?? '').trim()
  if (type === 'REG_DWORD' || type === 'REG_QWORD') {
    const n = Number.parseInt(raw.replace(/^0x/i, ''), 16)
    return { type, data: Number.isFinite(n) ? n : raw }
  }
  return { type, data: raw }
}

/** One registry value through reg.exe; null when the key or the value does not exist. */
export async function regQuery(
  run: RunCommand,
  key: string,
  valueName: string
): Promise<RegValue | null> {
  const r = await run('reg.exe', ['query', key, '/v', valueName])
  // reg.exe exits 1 both for a missing key and a missing value.
  if (r.code === 1) return null
  if (r.code !== 0) throw new Error(`reg query failed: ${(r.stderr || r.stdout).trim()}`)
  return parseRegQuery(r.stdout, valueName)
}

export async function regSetDword(
  run: RunCommand,
  key: string,
  valueName: string,
  value: number
): Promise<void> {
  const r = await run('reg.exe', [
    'add',
    key,
    '/v',
    valueName,
    '/t',
    'REG_DWORD',
    '/d',
    String(value >>> 0),
    '/f'
  ])
  if (r.code !== 0) throw new Error(`reg add failed: ${(r.stderr || r.stdout).trim()}`)
}

export async function regDeleteValue(
  run: RunCommand,
  key: string,
  valueName: string
): Promise<void> {
  const r = await run('reg.exe', ['delete', key, '/v', valueName, '/f'])
  // Already gone is fine.
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(`reg delete failed: ${(r.stderr || r.stdout).trim()}`)
  }
}

// --- tasklist.exe ------------------------------------------------------------------------------------------------

/** Image names (lower case) from `tasklist /FO CSV /NH`. */
export function parseTasklist(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim())
    if (m) names.add(m[1].toLowerCase())
  }
  return names
}

/** The running programs among `names` (compared without case), as given. */
export async function runningProcesses(
  run: RunCommand,
  names: readonly string[]
): Promise<string[]> {
  const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH'])
  if (r.code !== 0) throw new Error(`tasklist failed: ${(r.stderr || r.stdout).trim()}`)
  const all = parseTasklist(r.stdout)
  return names.filter((n) => all.has(n.toLowerCase()))
}
