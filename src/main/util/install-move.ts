import { execFile } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

/** PlayOut's own registry value naming the folder it runs from (build/installer.nsh reads the same one). */
export const INSTALL_DIR_KEY = 'HKCU\\Software\\PlayOut'
export const INSTALL_DIR_VALUE = 'InstallDir'

/** The reg.exe arguments that record `exeDir` (a value ending in a backslash would escape reg.exe's closing quote). */
export function installDirRegArgs(exeDir: string): string[] {
  return [
    'add',
    INSTALL_DIR_KEY,
    '/v',
    INSTALL_DIR_VALUE,
    '/t',
    'REG_SZ',
    '/d',
    exeDir.replace(/[\\/]+$/, ''),
    '/f'
  ]
}

/** An install for all users (under Program Files): the per-user installer must never be pointed there. */
export function underProgramFiles(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = resolve(dir).toLowerCase()
  return [env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432']].some((root) => {
    if (!root) return false
    const base = resolve(root).toLowerCase()
    return target === base || target.startsWith(base + '\\') || target.startsWith(base + '/')
  })
}

/**
 * Record the folder an installed PlayOut runs from, for its installer: an update, or setup run by hand, goes into this
 * folder even after the user moved it (the installer's own registration still names the folder it was installed to).
 */
export function rememberInstallDir(
  exeDir: string,
  warn: (msg: string) => void,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (underProgramFiles(exeDir, env)) return
  try {
    execFile('reg.exe', installDirRegArgs(exeDir), { windowsHide: true }, (err) => {
      if (err) warn(`could not record the install folder: ${err.message}`)
    })
  } catch (err) {
    warn(`could not record the install folder: ${(err as Error).message}`)
  }
}

/**
 * Where PlayOut's installer put it before 0.9.21 (the per-user default). A first install now goes to
 * <profile>\Games\PlayOut; an existing install stays where it is unless the user moves the folder.
 */
export function oldDefaultInstallDir(localAppData: string): string {
  return join(localAppData, 'Programs', 'PlayOut')
}

const same = (a: string, b: string): boolean =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase()

interface MoveRecord {
  exeDir?: string
}

export interface InstallMove {
  /** It runs from another folder than at its last start (or this is the first start that records it). */
  moved: boolean
  /** Folders PlayOut ran from before: paths saved inside them (emulators, their settings) are moved over. */
  rebaseFrom: string[]
}

/**
 * Where an installed PlayOut ran from before: the user moved the PlayOut folder (it is portable), or reinstalled it
 * elsewhere. The data folders beside PlayOut.exe moved with it; the absolute paths PlayOut saved inside the old folder
 * are rebased by the callers. Dev and portable runs share the same userData and are never installs: callers skip this
 * for them. The record (userData\install-dir.json) is written by recordInstallMove.
 */
export function readInstallMove(
  exeDir: string,
  userData: string,
  localAppData: string
): InstallMove {
  let record: MoveRecord = {}
  try {
    const parsed = JSON.parse(
      readFileSync(join(userData, 'install-dir.json'), 'utf8')
    ) as MoveRecord
    if (parsed && typeof parsed === 'object') record = parsed
  } catch {
    // never recorded: the first start of a version that records it
  }
  const last = typeof record.exeDir === 'string' && record.exeDir ? record.exeDir : null
  const candidates: string[] = []
  for (const dir of [last, oldDefaultInstallDir(localAppData)])
    if (dir && !same(dir, exeDir) && !candidates.some((c) => same(c, dir))) candidates.push(dir)
  return { moved: !last || !same(last, exeDir), rebaseFrom: candidates }
}

/** Record the folder PlayOut runs from (compared at the next start). */
export function recordInstallMove(exeDir: string, userData: string): void {
  try {
    mkdirSync(userData, { recursive: true })
    const record: MoveRecord = { exeDir }
    writeFileSync(join(userData, 'install-dir.json'), JSON.stringify(record, null, 2), 'utf8')
  } catch {
    // read-only profile: looked for again next start
  }
}
