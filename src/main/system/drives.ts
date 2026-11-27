// The PC's local drives and their space (Settings › Storage): each fixed drive's size and free space, as Windows
// reports them. Nothing is scanned: the Storage tab works out "Other" as size minus free minus the games' sizes.
import type { StorageDrive } from '../../shared/types'
import type { PsRunner } from './ps-worker'

/** Fixed local drives (DriveType 3: no USB sticks, optical or network drives), one row each. */
export const FIXED_DRIVES_SCRIPT = String.raw`Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |
  Select-Object DeviceID, VolumeName, Size, FreeSpace`

interface DriveRow {
  DeviceID?: unknown
  VolumeName?: unknown
  Size?: unknown
  FreeSpace?: unknown
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The script's rows (one object or an array) as drives, sorted by letter; rows without a size are left out. */
export function parseDrives(value: unknown): StorageDrive[] {
  const rows: DriveRow[] = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [value]
      : []
  const drives: StorageDrive[] = []
  for (const row of rows) {
    const id = typeof row.DeviceID === 'string' ? row.DeviceID.trim().toUpperCase() : ''
    const total = num(row.Size)
    const free = num(row.FreeSpace)
    if (!/^[A-Z]:$/.test(id) || total === null || total <= 0 || free === null) continue
    const label =
      typeof row.VolumeName === 'string' && row.VolumeName.trim() ? row.VolumeName.trim() : null
    drives.push({ root: `${id}\\`, label, totalBytes: total, freeBytes: Math.min(free, total) })
  }
  return drives.sort((a, b) => a.root.localeCompare(b.root))
}

/** The PC's fixed drives with their size and free space; empty when Windows cannot be asked. */
export async function listFixedDrives(ps: PsRunner): Promise<StorageDrive[]> {
  return parseDrives(await ps.run(FIXED_DRIVES_SCRIPT, { timeoutMs: 15_000 }))
}
