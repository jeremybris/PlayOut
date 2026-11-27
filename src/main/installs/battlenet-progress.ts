// Battle.net install progress (grade: measured, docs/research/store-accounts.md §5.4): the Agent's product.db
// (protobuf, schema in providers/battlenet.ts) lists the product with `cached_product_state.update_progress` while it
// downloads and `base_product_state.playable` once it is done; a handshake in `active_installs` means queued.
import { promises as fs } from 'fs'
import { productDbType } from '../providers/battlenet'
import type { InstallProbe, ProbeResult } from './tracker'

/** The decoded fields this reader looks at (protobufjs `toObject` with `longs: Number`). */
export interface ProductDbView {
  product_installs?: {
    uid?: string
    product_code?: string
    cached_product_state?: {
      base_product_state?: { installed?: boolean; playable?: boolean; update_complete?: boolean }
      update_progress?: {
        progress?: number
        total_to_download?: number
        download_remaining?: number
      }
    }
    product_operations?: { active_operation?: number | string }
  }[]
  active_installs?: { product?: string; uid?: string }[]
}

const OPERATION_UPDATE = 0

function matchesUid(candidate: string | undefined, uid: string): boolean {
  if (!candidate) return false
  const a = candidate.toLowerCase()
  const b = uid.toLowerCase()
  return a === b || a.startsWith(`${b}_`)
}

/** Map the decoded database to the state of one product (by Agent uid, exact or `<uid>_<region>`). */
export function progressFromProductDb(
  db: ProductDbView,
  uid: string,
  seenBefore: boolean
): ProbeResult | null {
  const installs = db.product_installs ?? []
  const install =
    installs.find((p) => (p.uid ?? '').toLowerCase() === uid.toLowerCase()) ??
    installs.find((p) => matchesUid(p.uid, uid))
  if (!install) {
    const handshake = (db.active_installs ?? []).some(
      (h) => matchesUid(h.uid, uid) || matchesUid(h.product, uid)
    )
    if (handshake) return { state: 'queued', fingerprint: 'handshake' }
    return seenBefore ? { cancelled: true, fingerprint: 'gone' } : null
  }
  const base = install.cached_product_state?.base_product_state ?? {}
  const progress = install.cached_product_state?.update_progress ?? {}
  const operation = install.product_operations?.active_operation
  const updating = operation === OPERATION_UPDATE || operation === 'UPDATE'
  const total = Number(progress.total_to_download ?? 0)
  const remaining = Number(progress.download_remaining ?? 0)
  const fraction = typeof progress.progress === 'number' ? progress.progress : undefined
  const fingerprint = [
    base.installed ? 1 : 0,
    base.playable ? 1 : 0,
    operation,
    fraction,
    total,
    remaining
  ].join(':')
  if (base.playable) return { state: 'installing', percent: 100, complete: true, fingerprint }
  let percent: number | undefined
  if (fraction !== undefined && fraction > 0) percent = Math.min(99, fraction * 100)
  else if (total > 0) percent = Math.min(99, ((total - remaining) / total) * 100)
  if (!updating && percent === undefined) return { state: 'queued', fingerprint }
  const result: ProbeResult = {
    state: percent === undefined || percent === 0 ? 'queued' : 'downloading',
    percent,
    fingerprint
  }
  if (total > 0) {
    result.bytesTotal = total
    result.bytesDone = Math.max(0, total - remaining)
  }
  return result
}

export interface BattlenetProbeDeps {
  uid: string
  dbPath: string
}

export function createBattlenetProbe(deps: BattlenetProbeDeps): InstallProbe {
  let seen = false
  return async () => {
    let buffer: Buffer
    try {
      buffer = await fs.readFile(deps.dbPath)
    } catch {
      return null
    }
    let view: ProductDbView
    try {
      const type = productDbType()
      view = type.toObject(type.decode(buffer), {
        defaults: false,
        longs: Number,
        enums: Number
      }) as ProductDbView
    } catch {
      // The Agent rewrites the file in place; a torn read is retried on the next probe.
      return null
    }
    const result = progressFromProductDb(view, deps.uid, seen)
    if (result && !result.cancelled) seen = true
    return result
  }
}
