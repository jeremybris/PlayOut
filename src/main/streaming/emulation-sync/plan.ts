import type { SyncFile } from './scan'

/**
 * The two-way merge of one client's Emulation folder with its host's: a three-way comparison of each file on this PC
 * (`local`), on the host (`remote`) and as both had it after the last sync with that host (`base`, by hash). A side
 * "changed" a file when its hash differs from the base (absent counts: created or deleted).
 *
 * - Changed on one side only: the change goes to the other (a copy, or a deletion).
 * - Changed on both to the same content: nothing to move.
 * - Changed on both differently: the newer copy wins (modified times, the host's put on this PC's clock) and the
 *   other side's copy is backed up before it is replaced. A deletion never beats a change: the changed copy is kept.
 * - No base (first sync, or a folder that moved): every file counts as changed, so the folders are merged and files
 *   both have with different contents go to the newer.
 * - Files written in the last moments (an emulator still saving) or unreadable right now wait for a later pass.
 */

export interface BaseEntry {
  path: string
  hash: string
}

export type SyncAction =
  | { kind: 'download'; key: string; remote: SyncFile; backupLocal: boolean; local?: SyncFile }
  | { kind: 'upload'; key: string; local: SyncFile; expect: string | null; backupRemote: boolean }
  | { kind: 'deleteLocal'; key: string; local: SyncFile }
  | { kind: 'deleteRemote'; key: string; remote: SyncFile }
  /** Both sides already agree: only the base is brought up to date (`entry` null: gone on both). */
  | { kind: 'record'; key: string; entry: BaseEntry | null }

export interface PlanInput {
  local: Map<string, SyncFile>
  remote: Map<string, SyncFile>
  base: Map<string, BaseEntry>
  /** Keys to leave alone this pass on either side (unreadable, or written moments ago). */
  hold: Set<string>
  /**
   * Folders (keys) to leave alone with everything under them: links on either PC, and folders the host leaves out
   * that this PC does not (its ROM folder): what is not listed there was not deleted.
   */
  holdUnder?: string[]
  /** host clock − this PC's clock, in ms: a host time minus this is the same moment on this PC's clock. */
  skewMs: number
}

export function planSync(input: PlanInput): SyncAction[] {
  const { local, remote, base, hold, skewMs } = input
  const under = input.holdUnder ?? []
  const held = (key: string): boolean =>
    hold.has(key) || under.some((p) => key === p || key.startsWith(`${p}/`))
  const keys = new Set([...local.keys(), ...remote.keys(), ...base.keys()])
  const actions: SyncAction[] = []
  for (const key of [...keys].sort()) {
    if (held(key)) continue
    const l = local.get(key)
    const r = remote.get(key)
    const b = base.get(key)
    const localChanged = (l?.hash ?? null) !== (b?.hash ?? null)
    const remoteChanged = (r?.hash ?? null) !== (b?.hash ?? null)
    if (!localChanged && !remoteChanged) continue
    if (l && r && l.hash === r.hash) {
      actions.push({ kind: 'record', key, entry: { path: l.path, hash: l.hash } })
      continue
    }
    if (!l && !r) {
      actions.push({ kind: 'record', key, entry: null })
      continue
    }
    if (localChanged && !remoteChanged) {
      if (l)
        actions.push({
          kind: 'upload',
          key,
          local: l,
          expect: r?.hash ?? null,
          backupRemote: false
        })
      else actions.push({ kind: 'deleteRemote', key, remote: r! })
      continue
    }
    if (remoteChanged && !localChanged) {
      if (r)
        actions.push({
          kind: 'download',
          key,
          remote: r,
          backupLocal: false,
          ...(l ? { local: l } : {})
        })
      else actions.push({ kind: 'deleteLocal', key, local: l! })
      continue
    }
    // Both changed, differently.
    if (l && !r) {
      actions.push({ kind: 'upload', key, local: l, expect: null, backupRemote: false })
      continue
    }
    if (r && !l) {
      actions.push({ kind: 'download', key, remote: r, backupLocal: false })
      continue
    }
    const localTime = l!.mtimeMs
    const remoteTime = r!.mtimeMs - skewMs
    // A tie goes to the host: every client then settles on the same copy.
    if (localTime > remoteTime)
      actions.push({ kind: 'upload', key, local: l!, expect: r!.hash, backupRemote: true })
    else actions.push({ kind: 'download', key, remote: r!, backupLocal: true, local: l! })
  }
  return actions
}

/**
 * Keys to hold this pass: files either side wrote within `settleMs` of its own clock (still being saved), and the
 * ones either side could not read.
 */
export function heldKeys(options: {
  local: Map<string, SyncFile>
  remote: Map<string, SyncFile>
  localNow: number
  remoteNow: number
  settleMs: number
  unsettled: Iterable<string>
}): Set<string> {
  const hold = new Set(options.unsettled)
  // A time far in the future (another PC's clock, an archive's dates) is not 'being written': only near now holds.
  const recent = (now: number, mtime: number): boolean => Math.abs(now - mtime) < options.settleMs
  for (const [k, f] of options.local) if (recent(options.localNow, f.mtimeMs)) hold.add(k)
  for (const [k, f] of options.remote) if (recent(options.remoteNow, f.mtimeMs)) hold.add(k)
  return hold
}
