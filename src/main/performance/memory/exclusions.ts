import { isProtectedProcess } from '../../launcher/launcher'
import type { ProcessInfo } from '../../launcher/process-monitor'
import { isShellProgram } from '../../overlay/overlay-logic'
import { isInside } from '../../util/paths'
import {
  isAntiCheatName,
  isCriticalName,
  isEmulatorName,
  isLauncherName,
  isSecurityName,
  isStreamingName,
  normalizeImage
} from './names'
import { TRIM_CS_MAX_PIDS } from './trim-cs'

/**
 * Which processes a memory cleanup pass may trim. One function decides (trimExclusion); trimTargets applies it to a
 * process list. The list is a moment old when the trim happens, so the C# of the tier that does it (trim-cs.ts)
 * checks each opened process again: one created after the list was read is left alone (its process id was reused, or
 * it is new: either way nothing here decided about it), and Windows' folder, security software, anti-cheat and
 * streaming are refused by image path there too.
 */

/** At most this many pids per pass (both tiers refuse more). */
export const MAX_TRIM_PIDS = TRIM_CS_MAX_PIDS

/** Why a process is left alone. */
export type TrimReason =
  | 'system'
  | 'playout'
  | 'game'
  | 'launcher'
  | 'emulator'
  | 'foreground'
  | 'windows'
  | 'security'
  | 'anti-cheat'
  | 'streaming'

export interface TrimContext {
  /** PlayOut's main process and the process that started it. */
  ownPid: number
  ownParentPid: number
  /** PlayOut's own image names (any spelling: 'PlayOut.exe', 'electron'). */
  ownNames: readonly string[]
  /** A game session is running (launcher.running()). */
  gameRunning: boolean
  /** The running game's processes (launcher.gameProcesses()); their children count as the game too. */
  gamePids: readonly number[]
  /** The running game's install folder, when it has one: everything under it is the game. */
  gameDir: string | null
  /**
   * The process of the window in front. null when unknown: the memory service runs no pass then (it cannot tell
   * which program is in use); here it only means explorer is never trimmed.
   */
  foregroundPid: number | null
  /** Windows' folder (C:\Windows): its programs are never trimmed. */
  windowsDir: string
}

/** A context with the process list's trees worked out once (trimScope). */
export interface TrimScope {
  ctx: TrimContext
  ownTree: ReadonlySet<number>
  ownNames: ReadonlySet<string>
  gameTree: ReadonlySet<number>
  foregroundTree: ReadonlySet<number>
  /** The foreground program's image name: its other processes (a browser's tabs) are the foreground too. */
  foregroundName: string | null
  /**
   * The window in front is a Store (packaged) app's frame: its window belongs to ApplicationFrameHost.exe, not to
   * the app, so the app's own process cannot be told from the pid. Every packaged app is left alone then.
   */
  foregroundPackaged: boolean
  /** The window in front belongs to the running game: the only time explorer.exe may be trimmed. */
  gameInForeground: boolean
}

/** `roots` and every process below them (by parent pid). */
export function processTree(list: readonly ProcessInfo[], roots: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>()
  for (const p of list) {
    if (p.parentPid === null || p.parentPid === p.pid) continue
    const of = children.get(p.parentPid)
    if (of) of.push(p.pid)
    else children.set(p.parentPid, [p.pid])
  }
  const tree = new Set<number>()
  const queue = [...roots].filter((pid) => Number.isInteger(pid) && pid > 4)
  while (queue.length) {
    const pid = queue.pop()!
    if (tree.has(pid)) continue
    tree.add(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return tree
}

export function trimScope(list: readonly ProcessInfo[], ctx: TrimContext): TrimScope {
  const gameTree = processTree(list, ctx.gamePids)
  const fg = ctx.foregroundPid !== null && ctx.foregroundPid > 4 ? ctx.foregroundPid : null
  const foregroundTree = fg === null ? new Set<number>() : processTree(list, [fg])
  const fgProcess = fg === null ? undefined : list.find((p) => p.pid === fg)
  const inGameDir =
    !!fgProcess?.path && !!ctx.gameDir && safeInside(ctx.gameDir, fgProcess.path) === true
  const foregroundName = fgProcess ? normalizeImage(fgProcess.name) || null : null
  return {
    ctx,
    ownTree: processTree(list, [ctx.ownPid]),
    ownNames: new Set(ctx.ownNames.map(normalizeImage).filter(Boolean)),
    gameTree,
    foregroundTree,
    foregroundName,
    foregroundPackaged: foregroundName === FRAME_HOST,
    gameInForeground: ctx.gameRunning && fg !== null && (gameTree.has(fg) || inGameDir)
  }
}

/** The process that owns the window of every Store (UWP) app. */
const FRAME_HOST = 'applicationframehost'

/** A packaged (Store) app's program: they are all installed under a WindowsApps folder. */
export function isPackagedAppPath(path: string | null | undefined): boolean {
  return !!path && /[\\/]windowsapps[\\/]/i.test(path)
}

function safeInside(dir: string, path: string): boolean {
  try {
    return isInside(dir, path)
  } catch {
    return false
  }
}

/**
 * Why `p` must not be trimmed, or null when it may be. Never trimmed: pids up to 4; PlayOut (its process tree, its
 * parent and anything with its image name); the running game (its process tree and everything under its install
 * folder) and, while a game runs, the store clients and overlay tools; emulators; the program in front (all of its
 * processes; every Store app while a Store app's window is in front); Windows' critical processes and everything in
 * Windows' folder; security software; anti-cheat services; Sunshine and Moonlight; and a process without a known
 * image path while the game's folder or a Store app in front would need it to decide. explorer.exe is let through
 * only while the running game's window is in front.
 */
export function trimExclusion(p: ProcessInfo, scope: TrimScope): TrimReason | null {
  const { ctx } = scope
  if (!Number.isInteger(p.pid) || p.pid <= 4) return 'system'
  const name = normalizeImage(p.name || p.path || '')
  if (!name) return 'system'
  if (
    p.pid === ctx.ownPid ||
    p.pid === ctx.ownParentPid ||
    scope.ownTree.has(p.pid) ||
    scope.ownNames.has(name)
  )
    return 'playout'
  if (scope.gameTree.has(p.pid)) return 'game'
  if (ctx.gameDir && p.path && safeInside(ctx.gameDir, p.path)) return 'game'
  if (isEmulatorName(name)) return 'emulator'
  if (scope.foregroundTree.has(p.pid) || name === scope.foregroundName) return 'foreground'
  if (scope.foregroundPackaged && isPackagedAppPath(p.path)) return 'foreground'
  if (isCriticalName(name)) return 'system'
  if (isSecurityName(name)) return 'security'
  if (isAntiCheatName(name)) return 'anti-cheat'
  if (isStreamingName(name)) return 'streaming'
  if (ctx.gameRunning && isLauncherName(name)) return 'launcher'
  if (name === 'explorer') return scope.gameInForeground ? null : 'windows'
  if (isShellProgram(`${name}.exe`)) return 'windows'
  if (p.path && safeInside(ctx.windowsDir, p.path)) return 'windows'
  // The launcher's own list of processes a session never closes (Windows' shell hosts, Sunshine, PlayOut).
  if (isProtectedProcess(p)) return 'windows'
  // A process whose image path could not be read (an elevated or protected one) cannot be told from the game's
  // folder, nor from a Store app while one is in front: it is left alone. (PlayOut's own trim could not open it
  // anyway; the helper could.)
  if (!p.path) {
    if (ctx.gameDir) return 'game'
    if (scope.foregroundPackaged) return 'foreground'
  }
  return null
}

export interface TrimTargets {
  /** The pids to trim, at most MAX_TRIM_PIDS. */
  pids: number[]
  /** Processes left alone, by reason. */
  excluded: Partial<Record<TrimReason, number>>
  /** How many were left alone (the excluded ones, and any beyond MAX_TRIM_PIDS). */
  skipped: number
  /** explorer.exe may be trimmed (the game is in front): passed on to the C#, which refuses it otherwise. */
  shell: boolean
}

export function trimTargets(list: readonly ProcessInfo[], ctx: TrimContext): TrimTargets {
  const scope = trimScope(list, ctx)
  const pids: number[] = []
  const excluded: Partial<Record<TrimReason, number>> = {}
  let skipped = 0
  const seen = new Set<number>()
  for (const p of list) {
    if (seen.has(p.pid)) continue
    seen.add(p.pid)
    const why = trimExclusion(p, scope)
    if (why) {
      excluded[why] = (excluded[why] ?? 0) + 1
      skipped++
    } else if (pids.length >= MAX_TRIM_PIDS) skipped++
    else pids.push(p.pid)
  }
  return { pids, excluded, skipped, shell: scope.gameInForeground }
}
