import { homedir } from 'os'
import { join } from 'path'

export interface KnownFolders {
  userProfile: string
  appData: string
  localAppData: string
  programData: string
  programFiles: string
  programFilesX86: string
  publicDir: string
  systemDrive: string
}

export function knownFolders(): KnownFolders {
  const env = process.env
  const userProfile = env.USERPROFILE || homedir()
  const systemDrive = env.SystemDrive || 'C:'
  return {
    userProfile,
    appData: env.APPDATA || join(userProfile, 'AppData', 'Roaming'),
    localAppData: env.LOCALAPPDATA || join(userProfile, 'AppData', 'Local'),
    programData: env.ProgramData || join(systemDrive, 'ProgramData'),
    programFiles: env.ProgramW6432 || env.ProgramFiles || join(systemDrive, 'Program Files'),
    programFilesX86: env['ProgramFiles(x86)'] || join(systemDrive, 'Program Files (x86)'),
    publicDir: env.PUBLIC || join(systemDrive, 'Users', 'Public'),
    systemDrive
  }
}

/**
 * The executable to register for "launch at login": the portable stub exe when electron-builder's portable target
 * set `PORTABLE_EXECUTABLE_FILE` (the extracted `%TEMP%\nsXXXX.tmp\app\PlayOut.exe` is deleted on exit), otherwise
 * the running executable. `getLoginItemSettings` must be asked with the same path/args that were registered.
 */
export function loginItemPath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
}

/** Expand %VAR% style Windows environment references and a leading ~. */
export function expandWindowsVars(input: string): string {
  let out = input.replace(
    /%([^%]+)%/g,
    (m, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? m
  )
  if (out.startsWith('~')) out = join(homedir(), out.slice(1))
  return out
}

/** Normalise a Windows path for comparisons: lower-case, backslashes, no trailing separator. */
export function normalizePath(p: string): string {
  return p
    .replace(/\//g, '\\')
    .replace(/[\\]+$/, '')
    .toLowerCase()
}

/** True when `child` is inside `parent` (both absolute Windows paths). */
export function isInside(parent: string, child: string): boolean {
  const a = normalizePath(parent) + '\\'
  const b = normalizePath(child) + '\\'
  return b.startsWith(a)
}
